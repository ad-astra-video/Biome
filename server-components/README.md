# Remote Server Setup

This directory contains the Python server used by Biome. The CLI entry
point is `main.py`; the FastAPI router lives in `server/routes.py`, the
WebSocket protocol in `server/protocol.py`, and the per-connection runtime
in `server/session/`.

Use these steps when you want to run the server on a different machine than the Biome desktop client.

## Requirements

- A supported GPU with sufficient VRAM — see the [main README](../README.md#installation) for details.
- [uv](https://docs.astral.sh/uv/getting-started/installation/) package manager.

## 1. Run the server

From this directory, bind to all interfaces so other devices can connect:

```bash
uv run main.py
```

That will setup the server with defaults `--host 0.0.0.0 --port 7987`, however if you wish to change any of those go ahead, and update the `--port` value in Biome client settings accordingly.

## 2. Network and port forwarding

For LAN-only use:

- Allow inbound TCP on port `7987` (or your chosen port) in the host machine firewall.
- Connect from client using `http://<server-lan-ip>:7987`.

For internet/WAN access:

- Configure router/NAT port forwarding: external TCP port -> server device LAN IP + server port.
- Allow the same port in the server machine firewall.
- Connect from client using `http://<public-ip-or-domain>:<port>`.

## 3. Configure Biome client

In Biome settings:

- Set engine mode to hosted **Server** mode.
- Set server URL to your remote endpoint (for example `http://192.168.1.50:7987`).

## Operator Docker image (GPU inference node)

The Biome repository includes a GPU-focused image definition at
`server-components/Dockerfile.live-runner` so operators can run model download
and inference on dedicated machines.

Build from the Biome repo root:

```bash
docker build -f server-components/Dockerfile.live-runner -t biome-live-runner .
```

Run with NVIDIA GPU access:

```bash
docker run --rm --gpus all -p 7987:7987 \
	-e BIOME_LIVE_RUNNER_ORCHESTRATOR_URL=http://<orchestrator-host>:<port> \
	-e BIOME_LIVE_RUNNER_ORCH_SECRET=<orch-secret> \
	-e BIOME_RUNNER_PUBLIC_BASE_URL=http://<public-runner-host>:7987 \
	biome-live-runner
```

Then point your control-plane server / client at `http://<runner-host>:7987`.

Notes:

- `BIOME_LIVE_RUNNER_ORCHESTRATOR_URL` is required when live-runner mode is enabled
	(enabled by default in `Dockerfile.live-runner`).
- `BIOME_LIVE_RUNNER_ORCH_SECRET` is also required for dynamic registration
	(`register_runner`) with the orchestrator.
- The runner exposes `/health` and `/ws`; session ticket lifecycle is expected
	to be managed by the intermediary control-plane server.

## Intermediate server Docker image (control plane)

The Biome repository also includes an intermediate/control-plane image at
`server-components/Dockerfile.runner-server`. This image runs the Biome
server in `livepeer` mode and is intended to reserve/proxy/release sessions to
registered runners.

Build from the Biome repo root:

```bash
docker build -f server-components/Dockerfile.runner-server -t biome-runner-server .
```

Run with your orchestrator discovery URL:

```bash
docker run --rm -p 7987:7987 \
	-e BIOME_LIVEPEER_ORCH_DISCOVERY_URL=http://<orchestrator-host>:<port> \
	biome-runner-server
```

Optional signer integration:

```bash
docker run --rm -p 7987:7987 \
	-e BIOME_LIVEPEER_ORCH_DISCOVERY_URL=http://<orchestrator-host>:<port> \
	-e BIOME_LIVEPEER_SIGNER_URL=https://<signer-host>/sign \
	biome-runner-server
```
