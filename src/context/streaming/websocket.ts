import type { LogRecord } from '../../types/ipc'
import type { WsRequest } from '../../lib/wsRpc'
import { createStreamingContext } from './createStreamingContext'

/** WebSocket-side affordances: typed RPC client + log buffers. */
export type WebsocketContextValue = {
  request: WsRequest
  /** Visible-in-UI tail (capped at MAX_VISIBLE_LOG_LINES). */
  logs: LogRecord[]
  /** Full session-scoped log history (uncapped, used by diagnostics export). */
  allLogs: LogRecord[]
  clearLogs: () => void
}

export const { Context: WebsocketContext, use: useWebsocket } =
  createStreamingContext<WebsocketContextValue>('Websocket')
