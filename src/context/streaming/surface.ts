import { createStreamingContext } from './createStreamingContext'

/** Imperative handles that wire the gameplay video surface to the
 *  streaming pipeline. Only the `<VideoContainer>` consumes these — it
 *  registers its container/canvas refs at mount and forwards click
 *  events for pointer-lock acquisition. */
export type SurfaceContextValue = {
  registerContainer: (element: HTMLDivElement | null) => void
  registerCanvas: (element: HTMLCanvasElement | null) => void
  handleContainerClick: () => void
}

export const { Context: SurfaceContext, use: useStreamingSurface } =
  createStreamingContext<SurfaceContextValue>('Surface')
