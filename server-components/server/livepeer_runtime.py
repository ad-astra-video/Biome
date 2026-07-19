"""Livepeer-mode session runtime helpers.

This module implements the server-side runtime path for Biome's `engine_mode=livepeer`:

1. Reserve a persistent runner session from the configured runner/discovery endpoint.
2. Connect the desktop websocket to the returned session-scoped runner websocket URL.
3. Bidirectionally proxy text/binary protocol traffic.
4. Release the runner session when the client disconnects.

The desktop-side websocket protocol stays unchanged; this is transport/session orchestration only.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any
from urllib.error import URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

import structlog
from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

logger = structlog.stdlib.get_logger(__name__)


@dataclass(frozen=True)
class LivepeerReservedSession:
    session_id: str
    app_ws_url: str


@dataclass(frozen=True)
class LivepeerNegotiation:
    reserve_payload: dict[str, Any]
    reserve_headers: dict[str, str]


class LivepeerRuntimeError(RuntimeError):
    pass


def _normalize_http_base(url: str) -> str:
    value = url.strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"}:
        msg = f"Invalid discovery URL scheme: {parsed.scheme!r}"
        raise LivepeerRuntimeError(msg)
    if not parsed.netloc:
        raise LivepeerRuntimeError("Discovery URL is missing host")
    return value


def _normalize_http_url(url: str, *, label: str) -> str:
    value = url.strip()
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"}:
        msg = f"Invalid {label} URL scheme: {parsed.scheme!r}"
        raise LivepeerRuntimeError(msg)
    if not parsed.netloc:
        raise LivepeerRuntimeError(f"{label} URL is missing host")
    return value


def _to_ws_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme == "ws" or parsed.scheme == "wss":
        return url
    if parsed.scheme == "http":
        return urlunsplit(("ws", parsed.netloc, parsed.path, parsed.query, parsed.fragment))
    if parsed.scheme == "https":
        return urlunsplit(("wss", parsed.netloc, parsed.path, parsed.query, parsed.fragment))
    raise LivepeerRuntimeError(f"Invalid runner app_url scheme: {parsed.scheme!r}")


def _append_query(url: str, **params: str) -> str:
    split = urlsplit(url)
    query_items = list(parse_qsl(split.query, keep_blank_values=True))
    query_items.extend((k, v) for k, v in params.items())
    return urlunsplit((split.scheme, split.netloc, split.path, urlencode(query_items), split.fragment))


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> dict[str, Any]:
    req_headers = {"content-type": "application/json"}
    if headers:
        req_headers.update(headers)
    request = Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers=req_headers,
        method="POST",
    )
    with urlopen(request, timeout=10.0) as resp:  # noqa: S310  -- URL is user-configured server endpoint
        body = resp.read()
    parsed = json.loads(body.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise LivepeerRuntimeError("Invalid JSON response from runner endpoint")
    return parsed


def _extract_headers(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    headers: dict[str, str] = {}
    for key, header_value in value.items():
        if isinstance(key, str) and isinstance(header_value, str):
            headers[key] = header_value
    return headers


async def negotiate_livepeer_session(
    *,
    signer_url: str | None,
    discovery_url: str,
    protocol_version: int,
) -> LivepeerNegotiation:
    reserve_payload: dict[str, Any] = {
        "mode": "persistent",
        "protocol": "biome-ws",
        "protocol_version": protocol_version,
        "livepeer": {
            "orchestrator_discovery_url": discovery_url,
        },
    }
    reserve_headers: dict[str, str] = {}

    if not signer_url:
        return LivepeerNegotiation(reserve_payload=reserve_payload, reserve_headers=reserve_headers)

    signer_endpoint = _normalize_http_url(signer_url, label="signer")
    signer_payload = {
        "orchestrator_discovery_url": discovery_url,
        "mode": "persistent",
        "protocol": "biome-ws",
        "protocol_version": protocol_version,
    }

    try:
        signed = await asyncio.to_thread(_post_json, signer_endpoint, signer_payload)
    except URLError as exc:
        raise LivepeerRuntimeError(f"Failed to negotiate livepeer session with signer: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise LivepeerRuntimeError(f"Failed to negotiate livepeer session with signer: {exc}") from exc

    signer_headers = _extract_headers(signed.get("headers"))
    if "authorization" in signed and isinstance(signed["authorization"], str):
        signer_headers.setdefault("authorization", signed["authorization"])
    if "Authorization" in signed and isinstance(signed["Authorization"], str):
        signer_headers.setdefault("Authorization", signed["Authorization"])

    reserve_headers.update(signer_headers)
    reserve_payload["livepeer"]["signer_url"] = signer_endpoint
    reserve_payload["livepeer"]["signed"] = signed
    return LivepeerNegotiation(reserve_payload=reserve_payload, reserve_headers=reserve_headers)


async def reserve_runner_session(
    discovery_url: str,
    *,
    signer_url: str | None,
    protocol_version: int,
) -> LivepeerReservedSession:
    base = _normalize_http_base(discovery_url)
    reserve_url = f"{base}/sessions/reserve"

    negotiation = await negotiate_livepeer_session(
        signer_url=signer_url,
        discovery_url=discovery_url,
        protocol_version=protocol_version,
    )

    try:
        data = await asyncio.to_thread(_post_json, reserve_url, negotiation.reserve_payload, negotiation.reserve_headers)
    except URLError as exc:
        raise LivepeerRuntimeError(f"Failed to reserve livepeer runner session: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise LivepeerRuntimeError(f"Failed to reserve livepeer runner session: {exc}") from exc

    session_id = data.get("session_id")
    app_url = data.get("app_url")
    if not isinstance(session_id, str) or not session_id:
        raise LivepeerRuntimeError("Runner reserve response missing session_id")
    if not isinstance(app_url, str) or not app_url:
        raise LivepeerRuntimeError("Runner reserve response missing app_url")

    return LivepeerReservedSession(session_id=session_id, app_ws_url=_to_ws_url(app_url))


async def release_runner_session(discovery_url: str, session_id: str) -> None:
    base = _normalize_http_base(discovery_url)
    release_url = f"{base}/sessions/{session_id}/release"
    try:
        await asyncio.to_thread(_post_json, release_url, {})
    except Exception:  # noqa: BLE001
        logger.warning("Failed to release livepeer runner session", session_id=session_id)


async def _forward_client_to_runner(client_ws: WebSocket, runner_ws) -> None:
    while True:
        msg = await client_ws.receive()
        msg_type = msg.get("type")
        if msg_type == "websocket.disconnect":
            return
        text = msg.get("text")
        if isinstance(text, str):
            await runner_ws.send(text)
            continue
        data = msg.get("bytes")
        if isinstance(data, (bytes, bytearray)):
            await runner_ws.send(bytes(data))


async def _forward_runner_to_client(runner_ws, client_ws: WebSocket) -> None:
    async for msg in runner_ws:
        if isinstance(msg, bytes):
            await client_ws.send_bytes(msg)
        else:
            await client_ws.send_text(msg)


async def proxy_livepeer_session(client_ws: WebSocket, reserved: LivepeerReservedSession, protocol_version: int) -> None:
    runner_ws_url = _append_query(reserved.app_ws_url, protocol_version=str(protocol_version))
    logger.info("Proxying livepeer session", session_id=reserved.session_id, runner_ws_url=runner_ws_url)

    try:
        async with ws_connect(runner_ws_url, ping_interval=300, ping_timeout=300) as runner_ws:
            to_runner = asyncio.create_task(_forward_client_to_runner(client_ws, runner_ws))
            to_client = asyncio.create_task(_forward_runner_to_client(runner_ws, client_ws))
            done, pending = await asyncio.wait([to_runner, to_client], return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                err = task.exception()
                if err is not None:
                    raise err
    except WebSocketDisconnect:
        logger.info("Client disconnected during livepeer proxy", session_id=reserved.session_id)
    except ConnectionClosed:
        logger.info("Runner disconnected during livepeer proxy", session_id=reserved.session_id)
    except Exception as exc:  # noqa: BLE001
        raise LivepeerRuntimeError(f"Livepeer proxy failed: {exc}") from exc
