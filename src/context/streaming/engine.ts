import type { EngineStatus } from '../../types/app'
import type { StageId } from '../../stages'
import { createStreamingContext } from './createStreamingContext'

/** Local engine state + actions. Only meaningful in standalone mode;
 *  in server mode the fields are inert (status null, isReady/isRunning
 *  false, setup is a no-op). */
export type EngineContextValue = {
  status: EngineStatus | null
  /** UV installed + repo cloned + dependencies synced. */
  isReady: boolean
  /** Standalone Python server process is running. */
  isRunning: boolean
  serverLogPath: string | null
  check: () => Promise<EngineStatus | null>
  setup: {
    inProgress: boolean
    progress: string | null
    error: string | null
    /** Run install / sync from current state — fixes a partial setup. */
    run: (onStage?: (stageId: StageId) => void) => Promise<EngineStatus>
    /** Wipe the engine dir and re-run from scratch. */
    nukeAndReinstall: (onStage?: (stageId: StageId) => void) => Promise<EngineStatus>
    abort: () => Promise<string>
  }
}

export const { Context: EngineContext, use: useEngine } = createStreamingContext<EngineContextValue>('Engine')
