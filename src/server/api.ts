import { Hono } from 'hono'
import { validate } from '../shared/pixels'
import type { PixelPayload } from '../shared/pixels'

/**
 * The `/api/pixels` proxy.
 *
 * It exists for one reason: ARGUS_KEY must never reach the browser. Everything
 * else here — the cache, the validation — is in service of that single hop
 * being cheap and honest.
 *
 * Mounted twice, but written once: `@hono/vite-dev-server` serves it during
 * `npm run dev`, and `@hono/node-server` serves it in the container alongside
 * the built `dist/`. Same handler both sides, so dev cannot drift from prod.
 */

/**
 * Six weeks, which is the board's 42 columns. Shared by both upstream calls so
 * the hours and the token counts shown beside them describe the same window.
 */
const WINDOW_DAYS = 42

/** Slot 0 of the grid; must stay in step with the board's 24x42 geometry. */
const QUERY = `tz=Asia/Shanghai&days=${WINDOW_DAYS}&slotMinutes=60&clampMinutes=60&breakdown=1`

/**
 * Names change far more slowly than activity does, and this is a second
 * upstream call, so it gets its own much longer TTL rather than riding the 9s
 * pixel cache.
 */
const NAMES_TTL_MS = 5 * 60_000

/**
 * The client polls every ~10s to keep the live cell blinking. Without a cache
 * that is one upstream call per visitor per 10s; with it, one per 10s total.
 * Slightly under the poll interval so a caller rarely waits on a refresh.
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
 * Map each project hash to a display name, and discard everything else.
 *
 * `/me/usage/by-project` answers the naming question, but it is a far more
 * revealing payload than `/me/pixels` — which carries opaque hashes on purpose,
 * with no names or paths. This one adds `workingDir` (absolute paths exposing a
 * username and machine layout, e.g. /home/kyle/projects/argus), `machineId`,
 * `projectId`, per-project token counts and `costUsd` running into thousands of
 * dollars.
 *
 * None of that belongs on a public homepage, so the reduction happens here
 * rather than in the browser: the response is boiled down to hash -> name and
 * the rest never crosses the wire. Forwarding this endpoint as-is, or doing the
 * mapping client-side, would publish all of it.
 *
 * `name` is null for a third of entries, where the directory's own basename is
 * the honest fallback — that is a project name, not a path, and it is the same
 * word a human would use.
 *
 * Token counts come along too, since the owner asked to show them. `costUsd` is
 * deliberately NOT forwarded: it is in the same `usage` object, it runs to five
 * figures across these projects, and nobody asked for spend to be public. It
 * stays server-side unless that changes on purpose rather than by a careless
 * spread of `...p.usage`.
 *
 * `days` is passed explicitly even though 42 is currently this endpoint's own
 * default. Omitting it reads as equivalent and is not: the tokens are rendered
 * beside hours won from a 42-day pixel grid, so if that default ever moved, the
 * two numbers on one row would silently start describing different windows —
 * a wrong number that still looks right.
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
    // Cache reads are 85% of the total across these projects, so a single
    // summed figure would be dominated by them and read as far more work than
    // actually happened. Kept apart so the UI can be honest about the split.
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
 * Rebuild the sparse per-slot breakdown from scalars.
 *
 * Shape is slot index -> project index -> seconds, and every key and value in it
 * is a number. Copying the object wholesale would be one line, but it would also
 * be the one place a nested upstream value could still ride through unexamined,
 * which is exactly what `publish` exists to stop. Non-numeric entries are
 * dropped rather than passed on: this feeds a tooltip, and a value we cannot
 * account for has no business being rendered or published.
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
 * Build the public payload out of named fields.
 *
 * The point is that nothing reaches a visitor because it happened to arrive.
 * `fetchNames` already worked this way -- it constructs its output, which is why
 * `costUsd` sitting in the same upstream object as the token counts has never
 * been able to leak. The pixel payload did not: it was `JSON.stringify` of
 * whatever Argus returned, so any field added upstream would have been published
 * silently, with no change on our side and nothing to notice it. A test proved
 * it: two invented fields planted in a stubbed upstream arrived intact in the
 * response.
 *
 * That asymmetry is now gone. Adding a field to this response takes an edit
 * here, which is the property worth having on the boundary between a private
 * upstream and a public page.
 *
 * The cost is that a genuinely new upstream field needs a line adding before it
 * can be used. That is the correct trade for a public endpoint, and it is the
 * one `fetchNames` has always made.
 */
function publish(p: PixelPayload, meta: Record<string, ProjectMeta>): PixelPayload {
  return {
    start: p.start,
    slotMinutes: p.slotMinutes,
    slotCount: p.slotCount,
    tz: p.tz,
    // Arrays of numbers, already checked element by element by `validate`, so
    // naming them is the whole job -- there is no nested object to hide in.
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
  // Vite's dev server and Node both expose process.env here; this module only
  // ever runs server-side, so reading the secret is safe. It is deliberately
  // NOT prefixed VITE_, which is what keeps it out of the client bundle.
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

  // Names are a nicety, not a requirement. If the lookup fails the board still
  // works and simply shows hashes, so a failure here must not take the whole
  // request down with it.
  if (!names || Date.now() - names.at > NAMES_TTL_MS) {
    try {
      names = { map: await fetchNames(base, key), at: Date.now() }
    } catch (err) {
      console.warn(`[pixels] project names lookup failed, the board shows hashes: ${describe(err)}`)
      names ??= { map: {}, at: Date.now() }
    }
  }
  // Built rather than mutated-and-forwarded. See `publish`: this is the line
  // that decides what a visitor can see, and it should be readable as a list.
  return { body: JSON.stringify(publish(json, names.map)), at: Date.now() }
}

export const api = new Hono()

api.get('/api/pixels', async (c) => {
  const fresh = cache && Date.now() - cache.at < TTL_MS
  if (!fresh) {
    try {
      // Reuse an in-flight request rather than stampeding upstream when several
      // callers miss at once.
      inflight ??= fetchUpstream().finally(() => {
        inflight = null
      })
      cache = await inflight
    } catch (err) {
      // The cause goes to the server log and only there. Upstream status codes,
      // validator complaints and whether the credential is even configured are
      // operational detail, and the browser does the same thing with every
      // failure regardless, so the public body says nothing specific. None of
      // these messages carry the key. Single-flight plus the TTL cap this at
      // about one line per refresh window during an outage.
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

/**
 * Default export for `@hono/vite-dev-server`, which expects an app rather than a
 * named binding. Same object as `api`, so there is still only one handler.
 */
export default api
