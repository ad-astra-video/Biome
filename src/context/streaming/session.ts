import type { SceneEditState, SceneEditEvent } from '../sceneEditMachine'
import { createStreamingContext } from './createStreamingContext'

/** Pause / scene-edit / menu lifecycle state for the active session. */
export type SessionContextValue = {
  isPaused: boolean
  pausedAt: number | null
  pauseElapsedMs: number
  canUnpause: boolean
  unlockDelayMs: number
  settingsOpen: boolean
  sceneEdit: {
    state: SceneEditState
    dispatch: (event: SceneEditEvent) => void
  }
}

export const { Context: SessionContext, use: useSession } = createStreamingContext<SessionContextValue>('Session')
