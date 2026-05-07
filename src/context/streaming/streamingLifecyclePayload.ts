import type { Settings } from '../../types/settings'
import { getSessionSignature } from '../../utils/settingsClassifier'
import type { ConnectionStatus } from '../../hooks/engine/useWebSocket'
import type { TranslatableError } from '../../i18n'
import type { PortalState } from '../portal/portalStateMachine'
import type { StreamingLifecycleSyncPayload } from './streamingLifecycleMachine'

type BuildStreamingLifecycleSyncPayloadArgs = {
  portalState: PortalState
  connectionStatus: ConnectionStatus
  settings: Settings
  lastAppliedSession: string | null
  engineError: TranslatableError | null
  hasReceivedFrame: boolean
  initCompleted: boolean
  isPointerLocked: boolean
  settingsOpen: boolean
  isPaused: boolean
  sceneEditActive: boolean
}

export const buildStreamingLifecycleSyncPayload = (
  args: BuildStreamingLifecycleSyncPayloadArgs
): StreamingLifecycleSyncPayload => {
  return {
    portalState: args.portalState,
    connectionStatus: args.connectionStatus,
    currentSessionSig: getSessionSignature(args.settings),
    lastAppliedSession: args.lastAppliedSession,
    engineError: args.engineError,
    hasReceivedFrame: args.hasReceivedFrame,
    initCompleted: args.initCompleted,
    isPointerLocked: args.isPointerLocked,
    settingsOpen: args.settingsOpen,
    isPaused: args.isPaused,
    sceneEditActive: args.sceneEditActive
  }
}
