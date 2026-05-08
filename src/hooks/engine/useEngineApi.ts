import { useState, useCallback, useRef } from 'react'
import { invoke } from '../../bridge'
import type { EngineStatus } from '../../types/app'
import type { StageId } from '../../stages'

export type UseEngineResult = {
  status: EngineStatus | null
  checkStatus: () => Promise<EngineStatus | null>
  setupEngine: (onStage?: (stageId: StageId) => void) => Promise<EngineStatus>
  abortEngineInstall: () => Promise<string>
  startServer: (port: number) => Promise<string>
  stopServer: () => Promise<string>
  checkServerRunning: () => Promise<boolean>
  checkServerReady: () => Promise<boolean>
  checkPortInUse: (port: number) => Promise<boolean>
  probeServerHealth: (healthUrl: string, timeoutMs?: number) => Promise<boolean>
  getLastServerExitTail: () => Promise<string | null>
  isReady: boolean
  isServerRunning: boolean
  serverPort: number | null
  serverLogPath: string | null
}

export const useEngineApi = (): UseEngineResult => {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  // `checkServerRunning` polls during warm-connection and needs to refresh
  // the full engine status on the running-state transition.  Track the
  // previous `is-server-running` result via a ref rather than via React
  // state, so the comparison is against the real previous-call value
  // rather than whatever stale `status` is captured by the callback's
  // closure — `waitForHealthy` holds the same callback reference across
  // its whole poll loop, so closure-captured state would never update.
  const lastRunningRef = useRef<boolean | null>(null)

  const checkStatus = useCallback(async () => {
    try {
      const engineStatus = await invoke('check-engine-status', 'useEngineApi.checkStatus')
      setStatus(engineStatus)
      return engineStatus
    } catch {
      return null
    }
  }, [])

  const setupEngine = useCallback(async (onStage?: (stageId: StageId) => void) => {
    onStage?.('setup.sync_deps')
    await invoke('reinstall-engine')
    onStage?.('setup.verify')
    const finalStatus = await invoke('check-engine-status', 'useEngineApi.setupEngine.post')
    setStatus(finalStatus)
    return finalStatus
  }, [])

  const abortEngineInstall = useCallback(async () => {
    return await invoke('abort-engine-install')
  }, [])

  const startServer = useCallback(async (port: number) => {
    const result = await invoke('start-engine-server', port)
    const newStatus = await invoke('check-engine-status', 'useEngineApi.startServer.post')
    setStatus(newStatus)
    return result
  }, [])

  const stopServer = useCallback(async () => {
    const result = await invoke('stop-engine-server')
    const newStatus = await invoke('check-engine-status', 'useEngineApi.stopServer.post')
    setStatus(newStatus)
    return result
  }, [])

  const checkServerRunning = useCallback(async () => {
    try {
      const running = await invoke('is-server-running')
      if (lastRunningRef.current !== running) {
        lastRunningRef.current = running
        const newStatus = await invoke('check-engine-status', 'useEngineApi.checkServerRunning.delta')
        setStatus(newStatus)
      }
      return running
    } catch {
      return false
    }
  }, [])

  const checkServerReady = useCallback(async () => {
    try {
      return await invoke('is-server-ready')
    } catch {
      return false
    }
  }, [])

  const checkPortInUse = useCallback(async (port: number) => {
    try {
      return await invoke('is-port-in-use', port)
    } catch {
      return false
    }
  }, [])

  const probeServerHealth = useCallback(async (healthUrl: string, timeoutMs?: number) => {
    try {
      // The IPC returns the full identity object; warm-connect callers and
      // health-poll loops only care about reachability — strip down to
      // the boolean here so the shared shape stays simple.
      const result = await invoke('probe-server-health', healthUrl, timeoutMs)
      return result.reachable
    } catch {
      return false
    }
  }, [])

  const getLastServerExitTail = useCallback(async () => {
    try {
      return await invoke('get-last-server-exit-tail')
    } catch {
      return null
    }
  }, [])

  return {
    status,
    checkStatus,
    setupEngine,
    abortEngineInstall,
    startServer,
    stopServer,
    checkServerRunning,
    checkServerReady,
    checkPortInUse,
    probeServerHealth,
    getLastServerExitTail,
    isReady: !!(status?.uv_installed && status?.repo_cloned && status?.dependencies_synced),
    isServerRunning: status?.server_running ?? false,
    serverPort: status?.server_port ?? null,
    serverLogPath: status?.server_log_path ?? null
  }
}

export default useEngineApi
