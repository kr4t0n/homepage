import { Hono } from 'hono'
import { validate } from '../shared/pixels'
import type { PixelPayload } from '../shared/pixels'

/**
 * The `/api/pixels` proxy, which exists so ARGUS_KEY never reaches the browser.
 * `@hono/vite-dev-server` and serve.ts both mount it, so routes belong here.
 */

/**
 * Six weeks, the board's 42 columns. Passed explicitly to both upstream calls,
 * even where it is upstream's default, so the hours and the token counts shown
 * beside them describe the same window.
 */
const WINDOW_DAYS = 42

/** Slot 0 of the grid; must stay in step with the board's 24x42 geometry. */
const QUERY = `tz=Asia/Shanghai&days=${WINDOW_DAYS}&slotMinutes=60&clampMinutes=60&breakdown=1`

/** Names change far more slowly than activity, so they get a much longer TTL. */
const NAMES_TTL_MS = 5 * 60_000

/**
 * The client polls every ~10s; the cache makes that one upstream call per 10s in
 * total rather than per visitor. Just under the poll interval so a caller rarely
 * waits on a refresh.
 */
const TTL_MS = 9_000

interface Cached {
  body: string
  at: number
}
let cache: Cached | null = null
/** Collapses concurrent misses into a single upstream request. */
let inflight: Promise<Cached> | null = null

/** What the proxy is willing to say about a project, beyond its hash. */
interface ProjectMeta {
  name?: string
  tokens: { in: number; out: number; cached: number }
}

let names: { map: Record<string, ProjectMeta>; at: number } | null = null

/**
 * Map each project hash to a name and token counts, and discard the rest. These
 * rows also carry workingDir, machineId, projectId and costUsd, so the output is
 * built field by field and `usage`, which holds costUsd, is never spread. A null
 * `name` falls back to the directory's basename, never the path.
 */
async function fetchNames(base: string, key: string): Promise<Record<string, ProjectMeta>> {
  const res = await fetch(`${base}/me/usage/by-project?days=${WINDOW_DAYS}`, {
    headers: { 'X-API-Key': key },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`argus by-project responded ${res.status}`)
  const json = (await res.json()) as {
    projects?: {
      key?: string
      name?: string | null
      workingDir?: string
      usage?: Record<string, number>
    }[]
  }
  const map: Record<string, ProjectMeta> = {}
  for (const p of json.projects ?? []) {
    if (!p.key) continue
    const fromDir = p.workingDir?.replace(/\/+$/, '').split('/').pop()
    const name = p.name?.trim() || fromDir?.trim()
    const u = p.usage ?? {}
    // `in` includes cache reads, which dominate it; `cached` is kept apart so the
    // UI can show the split rather than one inflated total.
    map[p.key] = {
      ...(name ? { name } : {}),
      tokens: {
        in: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
        out: u.outputTokens ?? 0,
        cached: u.cacheReadTokens ?? 0,
      },
    }
  }
  return map
}

/**
 * Rebuild the sparse breakdown (slot index -> project index -> seconds) from
 * finite numbers only, rather than copying it, so no nested upstream value can
 * ride through. Anything else is dropped.
 */
function republishBreakdown(
  raw: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const [slot, byProject] of Object.entries(raw)) {
    if (!byProject || typeof byProject !== 'object') continue
    const cell: Record<string, number> = {}
    for (const [index, seconds] of Object.entries(byProject)) {
      if (typeof seconds === 'number' && Number.isFinite(seconds)) cell[index] = seconds
    }
    if (Object.keys(cell).length) out[slot] = cell
  }
  return out
}

/**
 * Build the public payload from named fields, so nothing reaches a visitor just
 * because upstream sent it. A new upstream field needs a line here to be published.
 */
export function publish(p: PixelPayload, meta: Record<string, ProjectMeta>): PixelPayload {
  return {
    start: p.start,
    slotMinutes: p.slotMinutes,
    slotCount: p.slotCount,
    tz: p.tz,
    // Arrays of numbers checked by `validate`: nothing nested to hide in.
    winners: p.winners,
    intensity: p.intensity,
    live: p.live,
    ...(p.breakdown ? { breakdown: republishBreakdown(p.breakdown) } : {}),
    projects: p.projects.map((project) => {
      const m = meta[project.key]
      return {
        key: project.key,
        wonSeconds: project.wonSeconds,
        ...(m?.name ? { name: m.name } : {}),
        ...(m?.tokens ? { tokens: m.tokens } : {}),
      }
    }),
  }
}

/**
 * One line for the log. Node's fetch says only "fetch failed" and keeps the
 * reason (ECONNREFUSED, ENOTFOUND, a timeout) on `cause`, so walk that chain.
 */
const describe = (err: unknown): string => {
  const parts: string[] = []
  let e: unknown = err
  while (e instanceof Error && parts.length < 4) {
    parts.push(e.message)
    e = (e as { cause?: unknown }).cause
  }
  return parts.length ? parts.join(': ') : String(err)
}

const env = (k: string): string | undefined =>
  // Server-only. The secret has no VITE_ prefix, which keeps it out of the
  // client bundle.
  typeof process !== 'undefined' ? process.env[k] : undefined

async function fetchUpstream(): Promise<Cached> {
  const base = env('ARGUS')
  const key = env('ARGUS_KEY')
  if (!base || !key) {
    throw new Error('ARGUS and ARGUS_KEY must be set; see .env.example')
  }

  const res = await fetch(`${base}/me/pixels?${QUERY}`, {
    headers: { 'X-API-Key': key },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`argus responded ${res.status}`)
  }

  const json = await res.json()
  // Throws on anything we cannot render truthfully. Deliberately before the
  // cache write, so a bad payload is never served and never stored, and before
  // enrichment so validation only ever sees Argus's own shape.
  validate(json)

  // Names are optional: if the lookup fails, the board shows hashes rather than
  // the request failing.
  if (!names || Date.now() - names.at > NAMES_TTL_MS) {
    try {
      names = { map: await fetchNames(base, key), at: Date.now() }
    } catch (err) {
      console.warn(`[pixels] project names lookup failed, the board shows hashes: ${describe(err)}`)
      names ??= { map: {}, at: Date.now() }
    }
  }
  return { body: JSON.stringify(publish(json, names.map)), at: Date.now() }
}

export const api = new Hono()

api.get('/api/pixels', async (c) => {
  const fresh = cache && Date.now() - cache.at < TTL_MS
  if (!fresh) {
    try {
      inflight ??= fetchUpstream().finally(() => {
        inflight = null
      })
      cache = await inflight
    } catch (err) {
      // The cause goes to the server log only: the browser treats every failure
      // alike, so the public body stays generic. No message carries the key, and
      // single-flight plus the TTL keep an outage to about one line per refresh.
      const outcome = cache
        ? `serving a payload ${Math.round((Date.now() - cache.at) / 1000)}s old`
        : 'nothing cached, answering 502'
      console.error(`[pixels] upstream refresh failed, ${outcome}: ${describe(err)}`)
      // Serve stale rather than nothing: a board a few minutes behind beats a
      // board that goes dark because one upstream call timed out.
      if (cache) {
        return c.json(JSON.parse(cache.body), 200, {
          'cache-control': 'no-store',
          'x-pixels-stale': String(Date.now() - cache.at),
        })
      }
      // The client treats any non-200 as "stay unlit", which is the honest
      // outcome when we have never had a good payload.
      return c.json({ error: 'upstream unavailable' }, 502, { 'cache-control': 'no-store' })
    }
  }

  return c.body(cache!.body, 200, {
    'content-type': 'application/json',
    // The payload changes every slot and carries a live flag; never let a proxy
    // or the browser hold it.
    'cache-control': 'no-store',
    'x-pixels-age': String(Date.now() - cache!.at),
  })
})

/** Liveness for the cluster. Deliberately does not touch Argus. */
api.get('/api/health', (c) => c.json({ ok: true }))

/** For `@hono/vite-dev-server`, which expects a default export; the same `api`. */
export default api
