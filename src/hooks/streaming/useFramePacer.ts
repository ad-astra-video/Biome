/*
 * End-to-end frame pacing
 * =======================
 *
 * Inference models with temporal compression generate T sub-frames per GPU
 * pass. The sub-frames are computed together and arrive on the wire as one
 * bundle after JPEG encoding, so each batch interval starts with a cluster
 * of decoded sub-frames followed by silence until the next pass completes.
 * The pacer's job is to spread those T sub-frames across the time until the
 * next batch arrives, with stable enough timing that the display reads as a
 * steady stream — any drift between predicted and actual batch cadence
 * shows up as visible timing variance.
 *
 * Server (`server/session/workers.py`)
 * ------------------------------------
 * The inference loop runs at `inference_fps / temporal_compression` LFPS
 * when the cap is on, or as fast as the GPU allows when off. After each
 * pass the loop JPEG-encodes all T sub-frames and bundles them into a
 * single binary WS message (see `server/protocol.py` for the wire layout).
 * The batch-level `FrameHeader` carries the perceptual id of the *first*
 * sub-frame; subsequent sub-frames are implicitly numbered. One message
 * per inference pass is the crucial invariant — it means the client sees
 * the whole batch atomically with no risk of React losing sub-frames to
 * setState batching across sibling WS events.
 *
 * Wire envelope
 * -------------
 *   [u32 hdr_len][FrameHeader JSON]
 *   [u32 sub_count]
 *   repeat sub_count times: [u32 jpeg_len][jpeg bytes]
 *
 * Client receive (`hooks/engine/useWebSocket.ts`)
 * -----------------------------------------------
 * The binary message handler walks the envelope, builds a Blob per
 * sub-frame and a `FrameBatch = { jpegs, header, receivedAt }` and pushes
 * it through a single `setBatch` call. One React state update per batch
 * means the pacer sees every batch exactly once, regardless of how React
 * batches sibling state updates.
 *
 * Pacer (this file) — arrival handler
 * -----------------------------------
 * For each incoming batch:
 *
 *   1. Observe the inter-batch arrival interval `Δ = receivedAt - lastArrival`.
 *      Update an EMA `arrivalEMA ← arrivalEMA·(1-α) + Δ·α` with α=0.2.
 *      This tracks the actual server cadence including network jitter,
 *      not the server-reported `gen_ms` (which excludes wire time and is
 *      stale by the time the client uses it).
 *
 *   2. Compute the per-sub-frame display interval `step = arrivalEMA / T`.
 *      Assign each sub-frame an absolute deadline `receivedAt + step·i`.
 *      At steady state, sub-frame T-1's slot ends exactly when the next
 *      batch arrives → smooth flow with no holds and no overlaps.
 *
 *   3. Reconcile the outgoing batch (HUD signals):
 *      - If it still had sub-frames queued (`nextIdx < T`), the new batch
 *        arrived early. Drop the remaining sub-frames, record an OVERLAP.
 *      - Otherwise (`nextIdx === T`), the previous batch finished and was
 *        being held on screen. Measure `holdMs = receivedAt - (lastDeadline
 *        + step)` and add to the HOLD history. Recorded once per batch.
 *
 *   4. Kick off T parallel `createImageBitmap` decodes. Each decode either
 *      installs into `newBatch.bitmaps[i]` or, if the batch was replaced
 *      before the decode resolved, closes the bitmap immediately.
 *
 * Pacer — display loop (rAF, independent of network)
 * --------------------------------------------------
 *   - Each rAF tick, walk the current batch from `nextIdx` forward looking
 *     for the *latest* sub-frame whose deadline has passed AND whose
 *     bitmap is decoded. Show that one; close any intermediates skipped
 *     past. Skipping intermediates when rAF lags preserves freshness.
 *   - If no sub-frame is past-due, do nothing — the last drawn frame
 *     stays on screen. That's how the underrun "hold" works with no extra
 *     state machine.
 *   - rAF runs at display refresh (60 or 120 Hz) and quantizes sub-frame
 *     transitions to refresh boundaries. With step ≈ 18ms and 60Hz refresh
 *     (16.7ms), each sub-frame gets roughly one refresh. Higher refresh
 *     rates improve sub-frame timing accuracy but perceptual FPS remains
 *     bounded by the model's `inference_fps`.
 *
 * Why EMA of arrival rather than server-reported gen_ms? `gen_ms` is the
 * previous batch's GPU time (plus cap-induced sleep); it predicts nothing
 * about wire-side jitter. The EMA of arrival times tracks everything that
 * matters in one number: GPU speed, cap setting, JPEG encode, network.
 *
 * Why drop on overlap instead of buffering? Zero buffer was the explicit
 * design choice — minimizes input-to-display latency at the cost of an
 * occasional dropped sub-frame when the EMA mispredicts. α=0.2 means the
 * EMA adapts within ~5 batches of any sustained rate change, so overlaps
 * from sustained mispredictions self-correct quickly. Isolated overlaps
 * from one-off network jitter cost one ~18ms sub-frame — much less
 * perceptible than holding one for 18 extra ms.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { FrameBatch } from '../engine/useWebSocket'

/** Per-batch metrics surfaced to the debug HUD. Updated every batch
 *  arrival; consumers poll via ref to avoid forcing a React render
 *  on every frame. */
export type PacerMetrics = {
  /** Current per-sub-frame display interval (ms). */
  paceMs: number
  /** EMA of observed batch-to-batch arrival intervals (ms). */
  arrivalIntervalMs: number
  /** Overlap events (new batch arrived before previous finished) per second. */
  overlapsPerSec: number
  /** Average ms the last sub-frame was held past its slot, per recent batch. */
  holdMsPerBatch: number
}

type FrameTimeline = { currentIndex: number; slotDisplayAts: (number | null)[] }

type ScheduledBatch = {
  bitmaps: (ImageBitmap | null)[]
  deadlines: number[]
  receivedAt: number
  firstFrameId: number
  subFrameCount: number
  nextIdx: number
  /** Set when `nextIdx === subFrameCount` so we only credit one hold per batch. */
  holdRecorded: boolean
}

/** EMA smoothing factor for the arrival-interval estimator. 0.2 lets
 *  ~5 batches of new data dominate the prediction; low enough that a
 *  single late batch (network blip) doesn't permanently widen pacing,
 *  high enough that a real rate change (cap toggle, GPU warmup) settles
 *  in a couple of batches. */
const ARRIVAL_ALPHA = 0.2

/** Rolling window for the `holdMsPerBatch` average. */
const HOLD_HISTORY = 30

/** Maximum reasonable arrival interval — guards the first-batch fallback
 *  against absurd `gen_ms` values reported during warmup. */
const MAX_ARRIVAL_MS = 1000

/** Owns the canvas-render pipeline. One `FrameBatch` per inference
 *  pass goes in; sub-frames are decoded in parallel and presented on
 *  a deadline schedule sized to the observed inter-batch arrival rate.
 *
 *  Pacing policy (zero buffer, freshness-first):
 *  - On batch arrival, schedule sub-frame `i` at `receivedAt + step*i`
 *    where `step = arrivalEMA / T`. At steady state the last sub-frame's
 *    slot ends exactly when the next batch arrives.
 *  - If a new batch arrives while sub-frames from the previous one are
 *    still queued, drop the remaining sub-frames and switch immediately
 *    (an "overlap" event).
 *  - If the rAF tick finds no pending sub-frame whose deadline has
 *    passed, hold the last presented frame (an "underrun"). Time spent
 *    holding is credited to `holdMsPerBatch` for HUD tuning.
 *
 *  Caps and edge cases:
 *  - `temporal_compression = 1`: step = arrivalEMA, single deadline at
 *    receivedAt; renders immediately. No behavior change from today.
 *  - First batch after connect / reset / unpause: no prior arrival, so
 *    we seed `arrivalEMA` from the header's `gen_ms` (best guess).
 *  - Decode latency: a sub-frame whose bitmap isn't ready yet at its
 *    deadline is simply held — rAF retries next tick. createImageBitmap
 *    is fast (< 1ms typical) so this is rare.
 */
export function useFramePacer(opts: { batch: FrameBatch | null }): {
  registerCanvas: (element: HTMLCanvasElement | null) => void
  canvasReady: boolean
  frameTimelineRef: RefObject<FrameTimeline>
  metricsRef: RefObject<PacerMetrics>
} {
  const { batch } = opts

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [canvasReady, setCanvasReady] = useState(false)

  // Pacer state — all refs so the rAF loop and the arrival handler
  // share a single mutable cell without re-rendering the tree.
  const arrivalEmaRef = useRef<number | null>(null)
  const lastArrivalRef = useRef<number | null>(null)
  const currentBatchRef = useRef<ScheduledBatch | null>(null)

  // Metrics
  const metricsRef = useRef<PacerMetrics>({
    paceMs: 0,
    arrivalIntervalMs: 0,
    overlapsPerSec: 0,
    holdMsPerBatch: 0
  })
  const overlapTimestampsRef = useRef<number[]>([])
  const holdHistoryRef = useRef<number[]>([])

  // Frame timeline for the debug overlay
  const frameTimelineRef = useRef<FrameTimeline>({ currentIndex: 0, slotDisplayAts: [] })

  // rAF draw loop — re-installed only when the canvas changes.
  useEffect(() => {
    if (!canvasReady || !canvasRef.current) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let rafId: number | null = null
    const tick = () => {
      const now = performance.now()
      const cur = currentBatchRef.current
      if (cur) {
        // Find the latest sub-frame whose deadline has passed AND
        // whose bitmap is decoded. Walk forward, skipping any whose
        // bitmap arrived late — drawing only the freshest preserves
        // motion fluidity if rAF lags or decodes are slow.
        let toShow = -1
        for (let i = cur.nextIdx; i < cur.subFrameCount; i++) {
          if (cur.deadlines[i] > now) break
          if (cur.bitmaps[i] !== null) toShow = i
        }
        if (toShow >= 0) {
          // Close any skipped intermediates.
          for (let i = cur.nextIdx; i < toShow; i++) {
            const skipped = cur.bitmaps[i]
            if (skipped) {
              skipped.close()
              cur.bitmaps[i] = null
            }
          }
          const bitmap = cur.bitmaps[toShow]
          if (bitmap) {
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
            bitmap.close()
            cur.bitmaps[toShow] = null
          }
          cur.nextIdx = toShow + 1
          frameTimelineRef.current.currentIndex = toShow
        }
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      const cur = currentBatchRef.current
      if (cur) {
        for (const b of cur.bitmaps) b?.close()
      }
      currentBatchRef.current = null
    }
  }, [canvasReady])

  // Handle each incoming batch: update EMA, schedule sub-frames, decode
  // bitmaps in parallel. Runs as an effect on the batch state so React
  // can never lose a batch to setState batching.
  useEffect(() => {
    if (!batch) return
    const { jpegs, header, receivedAt } = batch
    const T = Math.max(1, header.temporal_compression ?? 1)

    // Compute the observed inter-batch interval. For the first batch
    // after connect/reset we have no `lastArrival` to subtract — fall
    // back to the header's gen_ms (server's measurement of how long
    // this batch took, which is a reasonable starting estimate).
    const lastArrival = lastArrivalRef.current
    const arrivalInterval = lastArrival === null ? Math.min(header.gen_ms, MAX_ARRIVAL_MS) : receivedAt - lastArrival

    const prevEma = arrivalEmaRef.current
    const ema = prevEma === null ? arrivalInterval : prevEma * (1 - ARRIVAL_ALPHA) + arrivalInterval * ARRIVAL_ALPHA
    arrivalEmaRef.current = ema
    lastArrivalRef.current = receivedAt

    const step = ema / T

    // Overlap / underrun bookkeeping against the outgoing batch.
    const prev = currentBatchRef.current
    if (prev) {
      if (prev.nextIdx < prev.subFrameCount) {
        // Overlap: previous batch still had sub-frames queued. Drop them
        // and credit one overlap event for the HUD.
        for (let i = prev.nextIdx; i < prev.subFrameCount; i++) {
          prev.bitmaps[i]?.close()
          prev.bitmaps[i] = null
        }
        overlapTimestampsRef.current.push(receivedAt)
      } else if (!prev.holdRecorded) {
        // Underrun: previous batch ran out of sub-frames before this one
        // arrived. Time held = receivedAt minus the moment the last
        // sub-frame's natural slot ended.
        const lastSlotEnd = prev.deadlines[prev.subFrameCount - 1] + step
        const holdMs = Math.max(0, receivedAt - lastSlotEnd)
        holdHistoryRef.current.push(holdMs)
        if (holdHistoryRef.current.length > HOLD_HISTORY) holdHistoryRef.current.shift()
        prev.holdRecorded = true
      }
    }

    // Trim overlap window to last 1s.
    const overlapCutoff = receivedAt - 1000
    while (overlapTimestampsRef.current.length > 0 && overlapTimestampsRef.current[0] < overlapCutoff) {
      overlapTimestampsRef.current.shift()
    }

    // Schedule the new batch. Deadlines are absolute perf.now() values
    // so the rAF loop can compare directly without redoing the math.
    const newBatch: ScheduledBatch = {
      bitmaps: new Array<ImageBitmap | null>(jpegs.length).fill(null),
      deadlines: Array.from({ length: jpegs.length }, (_, i) => receivedAt + step * i),
      receivedAt,
      firstFrameId: header.frame_id,
      subFrameCount: jpegs.length,
      nextIdx: 0,
      holdRecorded: false
    }
    currentBatchRef.current = newBatch
    frameTimelineRef.current.slotDisplayAts = newBatch.deadlines.slice()

    // Decode all sub-frames in parallel. If the batch is replaced before
    // a decode resolves, close the bitmap rather than installing it.
    jpegs.forEach((blob, i) => {
      createImageBitmap(blob)
        .then((bitmap) => {
          if (currentBatchRef.current !== newBatch) {
            bitmap.close()
            return
          }
          newBatch.bitmaps[i] = bitmap
        })
        .catch(() => {
          /* decode error — leave slot null; rAF will skip past it */
        })
    })

    // Publish metrics for the HUD.
    const holdAvg =
      holdHistoryRef.current.length > 0
        ? holdHistoryRef.current.reduce((a, b) => a + b, 0) / holdHistoryRef.current.length
        : 0
    metricsRef.current = {
      paceMs: step,
      arrivalIntervalMs: ema,
      overlapsPerSec: overlapTimestampsRef.current.length,
      holdMsPerBatch: holdAvg
    }
  }, [batch])

  const registerCanvas = useCallback((element: HTMLCanvasElement | null) => {
    canvasRef.current = element
    setCanvasReady(!!element)
  }, [])

  return { registerCanvas, canvasReady, frameTimelineRef, metricsRef }
}
