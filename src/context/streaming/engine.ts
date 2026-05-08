import type { EngineStatus } from '../../types/app'
import type { StageId } from '../../stages'
import { createStreamingContext } from './createStreamingContext'

/** Local engine state + actions. Only meaningful in standalone mode;
 *  in server mode the fields are inert (status null, isReady/isRunning
 *  false, setup is a no-op).
 *
 *  Install / start / restart orchestration belongs to StartupContext —
 *  consumers reach for `useStartup().reinstallEngine` for that. The
 *  `setup` block here is the lower-level shim that warm-connect and the
 *  install-log modal still call into directly. */
export type EngineContextValue = {
  status: EngineStatus | null
  /** UV installed + repo cloned + dependencies synced. */
  isReady: boolean
  /** Standalone Python server process is running. */
  isRunning: boolean
  serverLogPath: string | null
  check: () => Promise<EngineStatus | null>
  setup: {
    /** Run install / sync from current state. Used by warm-connect's
     *  auto-install path; new code should prefer
     *  `useStartup().reinstallEngine` for the full stop → install →
     *  start cycle. */
    run: (onStage?: (stageId: StageId) => void) => Promise<EngineStatus>
    /** Cancel an in-flight install. Targets the Electron-side
     *  AbortController shared with `reinstall-engine` / `nuke-and-
     *  reinstall-engine`, so the abort works regardless of which path
     *  triggered the install. */
    abort: () => Promise<string>
  }
}

export const { Context: EngineContext, use: useEngine } = createStreamingContext<EngineContextValue>('Engine')
