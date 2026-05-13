import { createStreamingContext } from './createStreamingContext'
import type { PacerMetrics } from '../../hooks/streaming/useFramePacer'

/** Live frame-stream metrics. Updated at the model's display rate
 *  (60–90 Hz) — consumers that don't care about frames should NOT use
 *  this hook to avoid re-rendering on every frame. Refs are mutable
 *  cells consumed by the canvas-render loop and the timeline overlay. */
export type FramesContextValue = {
  id: number
  latentGenMs: number | null
  temporalCompression: number
  inputLatency: number | null
  timelineRef: { current: { currentIndex: number; slotDisplayAts: (number | null)[] } }
  pacerMetricsRef: { current: PacerMetrics }
}

export const { Context: FramesContext, use: useFrames } = createStreamingContext<FramesContextValue>('Frames')
