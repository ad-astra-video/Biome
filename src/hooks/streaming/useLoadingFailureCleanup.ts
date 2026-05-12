import { useEffect, useRef } from 'react'
import type { ConnectionStatus } from '../engine/useWebSocket'
import type { PortalState } from '../../context/portal/portalStateMachine'
import type { TranslatableError } from '../../i18n'
import { createLogger } from '../../utils/logger'

const log = createLogger('Streaming/LoadingFailure')

/** When the loading flow fails (connection errors out or never opens
 *  *and* an engine error has been recorded), stop the standalone Python
 *  server — but only when the lifecycle hasn't yet reached the
 *  ready-to-serve state. Once the lifecycle is `ready`, the server has
 *  bound its port and answered a `/health` probe, so a failure surfaced
 *  here is at the application layer (model load rejected the requested
 *  backend / quant combination, init RPC errored, etc.) and the process
 *  is still healthy. Reaping it would just force a slow re-spawn on the
 *  next attempt and break the retry-after-fixing-settings flow the user
 *  expects. The original kill is preserved for `preparing` / `failed`
 *  cases where the server spawned but never reached ready — leaving
 *  that zombie around would leak the process and let the next loading
 *  attempt race the cleanup.
 *
 *  Idempotent within one failure cycle: a `loadingFailureStopHandledRef`
 *  guard prevents the stop from running on every render while
 *  `engineError` is still set. The guard clears once the loading state
 *  recovers. */
export function useLoadingFailureCleanup(opts: {
  portalState: PortalState
  loadingState: PortalState
  connectionStatus: ConnectionStatus
  engineError: TranslatableError | null
  isStandaloneMode: boolean
  isServerRunning: boolean
  /** True when the engine lifecycle is in `ready` state — the server
   *  has bound its port and answered `/health`. Used to skip the
   *  process kill for application-layer failures on an otherwise
   *  healthy server. */
  engineReady: boolean
  stopServer: () => Promise<string>
}): void {
  const {
    portalState,
    loadingState,
    connectionStatus,
    engineError,
    isStandaloneMode,
    isServerRunning,
    engineReady,
    stopServer
  } = opts
  const stopHandledRef = useRef(false)

  useEffect(() => {
    const loadingFailed =
      portalState === loadingState && (connectionStatus.kind === 'error' || connectionStatus.kind === 'idle')

    if (!loadingFailed || !engineError) {
      stopHandledRef.current = false
      return
    }
    if (!isStandaloneMode || !isServerRunning) return
    if (engineReady) return
    if (stopHandledRef.current) return

    stopHandledRef.current = true
    ;(async () => {
      log.info('Loading failure detected - stopping standalone server')
      try {
        await stopServer()
      } catch (err) {
        log.error('Failed to stop standalone server after loading failure:', err)
      }
    })()
  }, [
    portalState,
    loadingState,
    connectionStatus,
    engineError,
    isStandaloneMode,
    isServerRunning,
    engineReady,
    stopServer
  ])
}
