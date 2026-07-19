# Livepeer Remote Runner Integration Plan

## Goal

Break out the local model runner path so Biome can run inference through Livepeer (live-runner path) while preserving the existing renderer protocol and UX. The desktop app should configure:

- A go-livepeer remote signer URL
- An orchestrator discovery/list endpoint URL

The server-side integration should use the Python gateway client (`livepeer_gateway` import), with a persistent live streaming session.

Scope decision: Live Runner integration in this plan is persistent mode only.

This document is planning-only. No implementation is included.

## Current Runner Architecture (Biome)

### Where model execution is currently bound to local process inference

- Session orchestration and typed message flow:
  - `server-components/server/session/handlers.py`
  - `server-components/server/session/workers.py`
  - `server-components/server/session/connection.py`
- Local model lifecycle and frame generation:
  - `server-components/engine/manager.py`
- Lazy startup wiring:
  - `server-components/server/startup.py`
  - `server-components/main.py`

### How the desktop app currently connects

- Settings shape and mode selection (`standalone` / `server`):
  - `src/types/settings.ts`
  - `electron/ipc/settings.ts`
- Warm-connect and URL derivation:
  - `src/context/streaming/streamingWarmConnection.ts`
  - `src/utils/serverUrl.ts`
- Local server lifecycle (spawn/health/stop):
  - `electron/ipc/server.ts`
  - `src/context/engineLifecycle/EngineLifecycleContext.tsx`

### Existing seam we can leverage

Biome already decouples renderer transport from inference internals:

- Renderer consumes WebSocket frames and typed RPC responses
- Server internally decides how frames are produced

This means we can swap the backend from local `world_engine` frame generation to a Livepeer-backed runner while keeping the renderer protocol stable.

## Livepeer Inputs and Contracts

## Python gateway side

From `livepeer-python-gateway` APIs and examples:

- Job/session creation via `start_lv2v()` / `start_scope()`
- Inputs include:
  - `orch_url` (explicit orchestrator list)
  - `discovery_url`
  - `signer_url`
- Live Runner registration/session APIs are first-class in `ja/live-runner`:
  - `register_runner()` in `src/livepeer_gateway/live_runner.py`
  - `runner_selector()` / `reserve_session()` in `src/livepeer_gateway/selection.py`
  - runner/discovery filtering in `src/livepeer_gateway/discovery.py`
- WebSocket runner support is explicit (not a workaround):
  - `examples/ping-pong/runner.py` exposes `/ws`
  - `examples/ping-pong/client.py` discovers runner and calls `ws_connect(app_url + '/ws')`
  - `examples/ping-pong/README.md` calls this a proxied websocket URL flow
- Persistent stream/job object also provides publish/subscribe/control/events hooks for media pipelines
- Payment and signer flow uses:
  - `/sign-orchestrator-info`
  - `/generate-live-payment`
  - optional signer discovery fallback `/discover-orchestrators`

### Direct implication for Biome protocol (persistent mode)

Biome can keep its existing websocket message semantics and binary frame envelope format if the Live Runner app endpoint implements Biome's websocket contract.

- Persistent mode flow only: reserve session first (`reserve_session()`), then connect to session-scoped `app_url + '/ws'`.
- Session lifecycle must include explicit release (`stop_runner_session(...)`) on disconnect, mode switch, and app shutdown.
- For side-channels (if needed later): Live Runner also exposes session headers and trickle channel helpers (`create_trickle_channels`, `remove_trickle_channels`, `create_proxy`).

So the integration target should be "Biome protocol over Live Runner websocket" rather than converting Biome protocol to LV2V media IO primitives.

## go-livepeer remote signer side

Relevant remote signer endpoints and behavior:

- `POST /sign-orchestrator-info`
- `POST /generate-live-payment`
- optional `GET /discover-orchestrators` (when remote discovery enabled)

This aligns with your requirement for a signer URL and a dedicated orchestrator-list/discovery endpoint URL.

## Proposed Target Architecture

Keep Biome renderer protocol unchanged. Introduce a server-side runner adapter layer:

- `LocalRunnerAdapter` (existing world_engine behavior)
- `LivepeerRunnerAdapter` (new livepeer gateway behavior)

For `LivepeerRunnerAdapter`, prefer a websocket-first implementation:

- Host a Biome-protocol websocket app behind Live Runner registration.
- Route Biome renderer websocket traffic through Live Runner `app_url`.
- Register runner with `mode='persistent'` only.
- Treat Live Runner as transport/session orchestration and payment/discovery, while Biome protocol remains the application protocol.

Both adapters should expose the same minimal session contract used by current handlers/workers:

1. initialize session with model/config/seed
2. apply controls (buttons/mouse deltas/prompt/reset/pause)
3. produce frame batches for outbound websocket envelopes
4. report health/capabilities/errors
5. close/cleanup session

## Breakout Points (Where to Refactor)

### 1) Session execution loop split

Current coupling is strongest in `run_generator()` and `handle_init()`:

- `server-components/server/session/workers.py`
- `server-components/server/session/handlers.py`

Plan:

- Extract a runner-agnostic `SessionRuntime` interface
- Move world-engine-specific operations into a local runtime implementation
- Add a new Livepeer runtime implementation that wraps `livepeer_gateway`

### 2) Engine manager usage isolation

Current worker/handler logic directly calls `WorldEngineManager` methods.

Plan:

- Introduce a runtime facade object in connection/session state
- Replace direct manager calls with runtime calls in handshake/init/game-loop paths
- Keep `WorldEngineManager` untouched initially, behind `LocalRunnerAdapter`

### 3) Startup wiring changes

Current `ServerStartup` always prepares local engines.

Plan:

- Add startup mode selection for runtime backend
- In Livepeer mode, skip heavy local model manager initialization
- Keep safety checker strategy explicit:
  - either local safety checker retained
  - or delegated/disabled in first iteration (must be explicit in UX and docs)

### 4) Health and capability reporting

`/health` currently reports local engine flags and backend/quant capabilities.

Plan:

- Extend health payload with runtime backend identity (`local` vs `livepeer`)
- In Livepeer mode, expose gateway connectivity status (signer/discovery/session)
- Keep existing fields backward compatible for renderer

## Settings and UX Changes

## New settings fields (proposed)

Add to settings schema and IPC persistence:

- `livepeer_enabled` (or new `engine_mode` variant, see below)
- `livepeer_signer_url`
- `livepeer_orchestrator_discovery_url`
- optional:
  - `livepeer_orchestrators` (comma-separated or list)
  - `livepeer_token`
  - `livepeer_signer_headers` / `livepeer_discovery_headers`

## Engine mode strategy

Recommended: add explicit third mode (for clarity and safer rollout):

- `standalone` (existing local managed server)
- `server` (existing external Biome-compatible server URL)
- `livepeer` (new gateway-managed remote inference)

This avoids overloading existing `server` semantics and keeps migration risk lower.

## Settings UI

Update `EngineTab` to show Livepeer configuration block:

- remote signer URL input
- orchestrator discovery/list URL input
- validation status using existing probe/error patterns

## Phased Implementation Plan

## Phase 0: Guardrails and feature flag

1. Add compile-time/runtime feature flag for Livepeer runner path.
2. Ensure default behavior remains unchanged.

## Phase 1: Runtime abstraction

1. Introduce runner runtime interface and adapter wiring in session layer.
2. Implement `LocalRunnerAdapter` by delegating existing behavior.
3. Refactor handlers/workers to use interface only.

Deliverable: no behavior change, all existing flows pass.

## Phase 2: Settings + plumbing

1. Add Livepeer settings fields and persistence.
2. Add UI controls and validation states.
3. Thread config into server startup/session context.

Deliverable: config can be entered and serialized; Livepeer mode selectable behind flag.

## Phase 3: Livepeer adapter MVP

1. Add `livepeer-python-gateway` dependency (branch pin to `ja/live-runner` as needed).
2. Implement gateway session bootstrap using signer + discovery/orchestrator inputs.
3. Implement persistent session lifecycle only (reserve, connect, run, stop/release).
4. Map Biome controls and prompt/reset semantics onto gateway control/events APIs.
5. Convert incoming media to Biome frame envelope format.

Deliverable: end-to-end streaming in Livepeer mode.

## Phase 4: Robustness and observability

1. Add reconnect/retry policy for signer/discovery/orchestrator selection failures.
2. Add structured logs for gateway session state transitions.
3. Expose diagnostics in existing error report payloads.

Deliverable: operationally debuggable Livepeer mode.

## Phase 5: Compatibility and hardening

1. Verify mode switch behavior (live session teardown/reconnect).
2. Verify health probes and capability UI behavior under partial outages.
3. Validate auth header handling and secret redaction in logs.

Deliverable: release-ready behavior parity with existing modes.

## Key Risks and Mitigations

1. Protocol mismatch between Biome WS expectations and gateway output cadence.
   - Mitigation: keep Biome WS contract unchanged; perform adaptation server-side only.
2. Different control semantics between local runner and Livepeer runtime.
   - Mitigation: define explicit control mapping table and test each input path.
3. Signer/discovery auth complexity.
   - Mitigation: start with URL-only fields first; add optional headers/token in follow-up.
4. Startup regressions from conditional engine init.
   - Mitigation: isolate startup branching and keep local startup code path untouched.

## Validation Checklist (Post-Implementation)

1. Standalone mode unchanged (install, start, stream).
2. Server mode unchanged (external Biome server URL).
3. Livepeer mode can:
   - validate signer URL
   - validate discovery/list URL
  - reserve persistent session
   - stream frames to renderer
   - process controls
  - release session cleanly on disconnect
   - recover from transient remote failure.
4. Diagnostics report includes Livepeer session context and endpoint provenance.

## Open Decisions for Review

1. Should Livepeer be a distinct `engine_mode` value (`livepeer`) or a sub-mode of `server`?
2. Should we include header/token fields in V1, or URL-only in V1 and expand in V2?
3. Should local NSFW seed safety remain required in Livepeer mode, optional, or delegated?
4. Should orchestrator source be one field (discovery URL only) or both explicit list + discovery URL from day one?

Resolved for this plan:

- Live Runner mode support: persistent only.
- No single-shot mode implementation in V1.

## Suggested First Implementation Slice

After approval, implement only Phase 1 + Phase 2 first (no gateway dependency yet):

- Introduce runtime abstraction
- Add new settings schema/UI/plumbing
- Keep Livepeer runtime as a stub returning explicit "not implemented" errors

That de-risks core refactor before networked runner integration.