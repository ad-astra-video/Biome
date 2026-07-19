# Livepeer Live Runner Integration (Current Implementation)

## Status

This document reflects the current implementation in this repository.

- Livepeer mode is implemented as a server-side transport path in Biome server-components.
- Desktop protocol remains the existing Biome websocket protocol.
- Persistent session flow is used.
- GPU runner deployment is supported from the Biome repo via `server-components/Dockerfile.live-runner`.

## Runtime Architecture

There are two distinct roles:

1. Intermediary server (control-plane side)
- Owns reserve/release ticket lifecycle.
- Chooses or discovers runner capacity.
- Returns session-scoped `app_url`.

2. Biome GPU runner (operator side)
- Runs Biome server-components on GPU machines.
- Exposes `/health` and `/ws`.
- Registers itself to orchestrator at startup using dynamic registration.
- Does not manage reserve/release tickets locally.

## Desktop to Runner Flow

1. User selects `engine_mode=livepeer` in settings.
2. Electron starts server-components with `BIOME_ENGINE_MODE=livepeer`.
3. In livepeer mode, startup skips local world-engine manager initialization.
4. On desktop websocket connect to server `/ws`:
   - server calls discovery endpoint `/sessions/reserve`
   - optional signer negotiation is performed first
   - response provides `session_id` + `app_url`
5. Server opens websocket to reserved runner `app_url` and proxies bytes both directions.
6. On disconnect/teardown, server calls `/sessions/{session_id}/release`.

The desktop app remains unaware of runner topology.

## Implemented Components

### 1) Livepeer mode settings and process plumbing

- `src/types/settings.ts`
  - includes `engine_mode: standalone | server | livepeer`.
  - `server_url` is the primary process-level URL setting.

- `electron/ipc/server.ts`
  - passes `BIOME_ENGINE_MODE` to Python server.
  - in livepeer mode, maps `server_url` to `BIOME_LIVEPEER_ORCH_DISCOVERY_URL`.
  - forwards optional signer URL from environment as `BIOME_LIVEPEER_SIGNER_URL`.

### 2) Server startup behavior

- `server-components/main.py`
  - reads `BIOME_ENGINE_MODE`, signer URL, discovery URL into startup config.
  - supports live-runner dynamic registration on startup (see env vars below).

- `server-components/server/startup.py`
  - if runtime backend is livepeer, marks startup ready without loading local engine manager.

### 3) Livepeer transport/proxy path

- `server-components/server/livepeer_runtime.py`
  - validates discovery/signer URLs.
  - performs signer negotiation when signer URL is configured.
  - reserves session at discovery endpoint.
  - proxies websocket traffic between desktop and reserved runner endpoint.
  - releases reserved session on teardown.

- `server-components/server/routes.py`
  - in livepeer mode, websocket path routes through reserve -> proxy -> release.
  - single-session gate is disabled in livepeer mode to allow concurrent sessions.
  - `/health` reports runtime backend and livepeer config status.

### 4) GPU operator runner image

- `server-components/Dockerfile.live-runner`
  - CUDA runtime base image.
  - installs server-components dependencies via `uv`.
  - enables live-runner registration mode by default.

- `server-components/README.md`
  - documents build/run commands and required env vars.

## Runner Registration (Aligned to app-examples Pattern)

The GPU runner uses SDK dynamic registration on startup, matching Livepeer app-examples shape:

- uses `livepeer_gateway.live_runner.register_runner(...)`
- stores returned registration handle
- closes registration handle on shutdown

Required when live-runner mode is enabled:

- `BIOME_LIVE_RUNNER_ENABLED=1`
- `BIOME_LIVE_RUNNER_ORCHESTRATOR_URL=<http(s) orchestrator URL>`
- `BIOME_LIVE_RUNNER_ORCH_SECRET=<orchestrator secret>`

Optional registration tuning:

- `BIOME_LIVE_RUNNER_APP_ID` (default `biome/gpu-runner`)
- `BIOME_LIVE_RUNNER_MODE` (default `persistent`)
- `BIOME_LIVE_RUNNER_CAPACITY`
- `BIOME_LIVE_RUNNER_PRICE_PER_UNIT`
- `BIOME_LIVE_RUNNER_PIXELS_PER_UNIT`
- `BIOME_RUNNER_PUBLIC_BASE_URL` (advertised external runner URL)

## Current API Responsibilities

### Intermediary server (expected)

- `POST /sessions/reserve`
- `POST /sessions/{session_id}/release`
- ticket issuance/validation
- runner selection/capacity policy

### GPU runner (Biome server-components)

- `GET /health`
- `GET /api/system-info`
- `WS /ws`

Runner-side reserve/release ticket APIs are intentionally not the source of truth.

## Known Gaps / Follow-ups

1. Frontend simplification remains partially complete.
- Goal is a single server URL setting for livepeer mode.
- Some UI code still contains legacy Livepeer-specific fields and should be removed for consistency.

2. Control-plane contract documentation can be formalized.
- Reserve/release response schema and ticket semantics should be documented in a dedicated protocol doc.

3. End-to-end operator validation should be automated.
- Add integration test covering registration success and reserve/proxy/release through control plane.

## Practical Deployment Summary

1. Build runner image from Biome repo:
- `docker build -f server-components/Dockerfile.live-runner -t biome-live-runner .`

2. Run on GPU host with required env vars:
- set orchestrator URL + secret
- set public runner URL reachable by orchestrator

3. Configure desktop/server livepeer mode to point at intermediary discovery endpoint.

4. Intermediary reserves sessions and routes each session to registered GPU runners.