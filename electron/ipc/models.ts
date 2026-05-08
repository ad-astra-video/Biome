import { ipcMain } from 'electron'
import { getServerState } from '../lib/serverState.js'
import type { ModelInfo } from '../../src/types/ipc.js'

// Returned when no server is reachable to satisfy a metadata request.
// Keeps the picker populated with at least one option so the UI never
// renders an empty dropdown — the corresponding server-side route falls
// back to the same default for the same reason.
const DEFAULT_WORLD_ENGINE_MODEL = 'Overworld/Waypoint-1.5-1B'

const FETCH_TIMEOUT_MS = 10000

/** Resolve the URL of the WorldEngine server to query for metadata.
 *
 *  Renderer mode → URL source:
 *    - server mode    → the user's configured `server_url` (passed in)
 *    - standalone     → the locally-managed Python process (auto-resolved)
 *
 *  Returns null when neither source is available — callers degrade to a
 *  minimum-viable response (default model only, every-id-not-local, etc.)
 *  rather than throwing, so the model picker stays usable while the user
 *  is mid-install or pointing at an unreachable remote. */
function resolveServerUrl(explicit?: string): string | null {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed
  const state = getServerState()
  if (state.process && state.port) return `http://localhost:${state.port}`
  return null
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function dedupeIds(modelIds: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of modelIds) {
    const cleaned = raw.trim()
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned)
      out.push(cleaned)
    }
  }
  return out
}

export function registerModelsIpc(): void {
  ipcMain.handle('list-waypoint-models', async (_event, serverUrl?: string) => {
    const url = resolveServerUrl(serverUrl)
    if (!url) return [DEFAULT_WORLD_ENGINE_MODEL]
    const response = await fetchWithTimeout(`${url}/api/waypoint-models`)
    if (!response?.ok) return [DEFAULT_WORLD_ENGINE_MODEL]
    return (await response.json()) as string[]
  })

  ipcMain.handle('list-cached-models', async (_event, serverUrl?: string) => {
    const url = resolveServerUrl(serverUrl)
    if (!url) return []
    const response = await fetchWithTimeout(`${url}/api/cached-models`)
    if (!response?.ok) return []
    return (await response.json()) as string[]
  })

  ipcMain.handle('get-models-info', async (_event, modelIds: string[], serverUrl?: string) => {
    const deduped = dedupeIds(modelIds)
    if (deduped.length === 0) return []

    const url = resolveServerUrl(serverUrl)
    if (!url) {
      return deduped.map((id) => ({ id, size_bytes: null, exists: true, error: 'Server not available' }))
    }

    const results = await Promise.allSettled(
      deduped.map(async (id): Promise<ModelInfo> => {
        const response = await fetchWithTimeout(`${url}/api/model-info/${id}`)
        if (!response) return { id, size_bytes: null, exists: true, error: 'Could not reach server' }
        if (!response.ok) return { id, size_bytes: null, exists: true, error: `Server returned ${response.status}` }
        return (await response.json()) as ModelInfo
      })
    )

    return results.map((result, i) =>
      result.status === 'fulfilled'
        ? result.value
        : { id: deduped[i], size_bytes: null, exists: true, error: 'Fetch failed' }
    )
  })

  ipcMain.handle('delete-cached-model', async (_event, modelId: string, serverUrl?: string) => {
    const url = resolveServerUrl(serverUrl)
    if (!url) throw new Error('Cannot delete cached model: server is not running')
    const response = await fetchWithTimeout(`${url}/api/cached-model/${modelId}`, { method: 'DELETE' })
    if (!response) throw new Error('Cannot delete cached model: could not reach server')
    if (!response.ok) throw new Error(`Cannot delete cached model: server returned ${response.status}`)
  })
}
