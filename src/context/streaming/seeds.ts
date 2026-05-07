import { createStreamingContext } from './createStreamingContext'

/** Seed images on disk (default + uploaded) — the small surface the
 *  streaming session needs to identify the active seed file and switch
 *  to a different one. The full directory listing comes from
 *  `useSeedManager` in the pause UI. */
export type SeedsContextValue = {
  dir: string | null
  openDir: () => Promise<void>
  select: (filename: string) => Promise<void>
}

export const { Context: SeedsContext, use: useSeeds } = createStreamingContext<SeedsContextValue>('Seeds')
