import { SETTING_CLASSES, type SettingClass, type SettingPath, type Settings } from '../types/settings'

/** Recursively derive every valid path into an object — both interior
 *  nodes (`recording`) and leaves (`recording.enabled`). The keyspace
 *  of `SETTING_CLASSES` (in `types/settings.ts`) is `AllPaths<Settings>`
 *  so a typo'd path fails tsc. */
export type AllPaths<T> =
  T extends ReadonlyArray<unknown>
    ? never
    : T extends object
      ? {
          [K in keyof T & string]: T[K] extends ReadonlyArray<unknown>
            ? K
            : T[K] extends object
              ? K | `${K}.${AllPaths<T[K]>}`
              : K
        }[keyof T & string]
      : never

const PATHS_OF_CLASS = (cls: SettingClass): SettingPath[] =>
  (Object.entries(SETTING_CLASSES) as [SettingPath, SettingClass][]).filter(([, c]) => c === cls).map(([p]) => p)

const SESSION_PATHS = PATHS_OF_CLASS('session')
const PROCESS_PATHS = PATHS_OF_CLASS('process')
const LIVE_PATHS = PATHS_OF_CLASS('live')

const getValueAtPath = (settings: Settings, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
      settings
    )

const signatureFor = (settings: Settings, paths: SettingPath[]): string =>
  paths.map((p) => JSON.stringify(getValueAtPath(settings, p) ?? null)).join('|')

export const getSessionSignature = (s: Settings): string => signatureFor(s, SESSION_PATHS)
export const getProcessSignature = (s: Settings): string => signatureFor(s, PROCESS_PATHS)
export const getLiveSignature = (s: Settings): string => signatureFor(s, LIVE_PATHS)

/** Bundle of signatures for the two restart-triggering classes. The
 *  lifecycle reducer compares this against the last-applied snapshot to
 *  decide whether a settings change requires an in-place reconnect or a
 *  full server respawn — see `intentionalRestart` in the reducer. */
export type RestartSignatures = { session: string; process: string }

export const getRestartSignatures = (s: Settings): RestartSignatures => ({
  session: getSessionSignature(s),
  process: getProcessSignature(s)
})

/** The strongest class of change between `prev` and `next`. `process`
 *  beats `session` beats `live` beats `none` — apply the heaviest
 *  applicable handler. */
export const classifySettingsDiff = (prev: Settings, next: Settings): SettingClass => {
  if (getProcessSignature(prev) !== getProcessSignature(next)) return 'process'
  if (getSessionSignature(prev) !== getSessionSignature(next)) return 'session'
  if (getLiveSignature(prev) !== getLiveSignature(next)) return 'live'
  return 'none'
}

/** True when the diff requires a modal confirmation (session or
 *  process class). `live` and `none` apply silently. */
export const diffRequiresRestartConfirmation = (prev: Settings, next: Settings): boolean => {
  const cls = classifySettingsDiff(prev, next)
  return cls === 'session' || cls === 'process'
}

/** Paths in the given class whose values differ between `prev` and `next`.
 *  Lets callers reason about *which* fields tripped a class without
 *  duplicating the SETTING_CLASSES table — e.g. `useEngineRespawn` skips
 *  the respawn when the only process-class delta is `offline_mode` in
 *  server mode (where the env vars don't apply). */
export const pathsThatDiffer = (prev: Settings, next: Settings, cls: SettingClass): SettingPath[] => {
  const paths = cls === 'process' ? PROCESS_PATHS : cls === 'session' ? SESSION_PATHS : cls === 'live' ? LIVE_PATHS : []
  return paths.filter(
    (p) => JSON.stringify(getValueAtPath(prev, p) ?? null) !== JSON.stringify(getValueAtPath(next, p) ?? null)
  )
}
