import { Hono } from 'hono'
import { validate } from '../shared/pixels'

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

/** Slot 0 of the grid; must stay in step with the board's 24x42 geometry. */
const QUERY = 'tz=Asia/Shanghai&days=42&slotMinutes=60&clampMinutes=60&breakdown=1'

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
  // cache write, so a bad payload is never served and never stored.
  validate(json)
  return { body: JSON.stringify(json), at: Date.now() }
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
      const why = err instanceof Error ? err.message : String(err)
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
      return c.json({ error: why }, 502, { 'cache-control': 'no-store' })
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
