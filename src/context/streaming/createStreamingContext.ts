import { createContext, useContext, type Context } from 'react'

/** Helper for the streaming sub-contexts. Returns a typed `Context` and a
 *  consumer hook that throws if the consumer is mounted outside the
 *  `StreamingProvider`. */
export function createStreamingContext<T>(name: string): { Context: Context<T | null>; use: () => T } {
  const Ctx = createContext<T | null>(null)
  Ctx.displayName = `Streaming/${name}`
  const use = (): T => {
    const v = useContext(Ctx)
    if (!v) throw new Error(`use${name} must be used within a StreamingProvider`)
    return v
  }
  return { Context: Ctx, use }
}
