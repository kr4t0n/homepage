import { Hono } from 'hono'
import { validate } from '../shared/pixels'
import type { PixelPayload } from '../shared/pixels'
import {
  LIVE_QUERY,
  SLOT_SECONDS,
  assemble,
  currentSlot,
  gridQuery,
  gridStart,
  parseGrid,
  parseLive,
  parseTokens,
  slotEnd,
  tokensQuery,
} from './prometheus'
import type { Hours, Tokens } from './prometheus'

/**
 * The `/api/pixels` proxy, which exists so the browser never reaches
 * Prometheus: the proxy sends fixed queries and publishes a project's figures
 * only. `@hono/vite-dev-server` and serve.ts both mount it, so routes belong here.
 */

/** Tokens change far more slowly than the live hour, so they get a much longer TTL. */
const TOKENS_TTL_MS = 5 * 60_000

/**
 * The client polls every ~10s; the cache makes that one upstream refresh per 10s
 * in total rather than per visitor. Just under the poll interval so a caller
 * rarely waits on a refresh.
 */
const TTL_MS = 9_000

/** Six weeks of hours is the slow query: seconds on the cluster's Prometheus. */
const HISTORY_TIMEOUT_MS = 30_000
const TIMEOUT_MS = 15_000

interface Cached {
  body: string
  at: number
}
let cache: Cached | null = null
/** Collapses concurrent misses into a single upstream request. */
let inflight: Promise<Cached> | null = null

/**
 * Every hour but the current one and the one before, which the refresh reads
 * itself. Fetched again once the current hour moves on, since nothing older changes.
 */
let history: { through: number; hours: Hours } | null = null

let tokens: { map: Record<string, Tokens>; at: number } | null = null

/**
 * Rebuild the sparse breakdown (slot index -> project index -> seconds) from
 * finite numbers only, rather than copying it, so no nested value can ride
 * through. Anything else is dropped.
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
 * because it was in hand. A new field needs a line here to be published.
 */
export function publish(p: PixelPayload, spent: Record<string, Tokens>): PixelPayload {
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
      const t = spent[project.key]
      return {
        key: project.key,
        ...(t ? { tokens: { in: t.in, out: t.out, cached: t.cached } } : {}),
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
  // Server-only, with no VITE_ prefix, which keeps it out of the client bundle.
  typeof process !== 'undefined' ? process.env[k] : undefined

/** The base URL, with a trailing slash so the API path resolves under any prefix. */
function prometheusBase(): URL {
  const raw = env('PROMETHEUS_URL')
  if (!raw) throw new Error('PROMETHEUS_URL must be set; see .env.example')
  if (!/^https?:\/\//.test(raw)) {
    throw new Error('PROMETHEUS_URL must start with http:// or https://')
  }
  return new URL(raw.endsWith('/') ? raw : `${raw}/`)
}

async function ask(
  base: URL,
  api: 'query' | 'query_range',
  params: Record<string, string | number>,
  timeout = TIMEOUT_MS,
): Promise<unknown> {
  const url = new URL(`api/v1/${api}`, base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!res.ok) {
    // Prometheus says why in `error`, e.g. a query it could not parse.
    const why = await res
      .json()
      .then((b: { error?: unknown }) => String(b?.error ?? '').slice(0, 200))
      .catch(() => '')
    throw new Error(`prometheus ${api} responded ${res.status}${why ? `: ${why}` : ''}`)
  }
  return res.json()
}

/** The grid query over the hours ending at slots `from` to `to`, inclusive. */
async function hoursOf(base: URL, start: number, from: number, to: number, nowSec: number) {
  const ends = Array.from({ length: to - from + 1 }, (_, i) => slotEnd(start, from + i))
  const json = await ask(
    base,
    'query_range',
    { query: gridQuery(nowSec), start: ends[0], end: ends[ends.length - 1], step: SLOT_SECONDS },
    to - from > 1 ? HISTORY_TIMEOUT_MS : TIMEOUT_MS,
  )
  return parseGrid(json, ends)
}

/**
 * Tokens are optional: if the lookup fails, the ranking keeps the last good
 * counts, or stays empty, rather than the request failing. Never throws.
 */
async function refreshTokens(base: URL, start: number, nowSec: number): Promise<void> {
  try {
    const json = await ask(base, 'query', {
      query: tokensQuery(nowSec - start / 1000),
      time: nowSec,
    })
    tokens = { map: parseTokens(json), at: Date.now() }
  } catch (err) {
    console.warn(`[pixels] token lookup failed, the ranking keeps what it had: ${describe(err)}`)
    tokens ??= { map: {}, at: Date.now() }
  }
}

async function fetchUpstream(): Promise<Cached> {
  const base = prometheusBase()
  const now = Date.now()
  const nowSec = Math.floor(now / 1000)
  const start = gridStart(now)
  const cur = currentSlot(start, now)
  const through = slotEnd(start, cur - 2)

  // Each answer is read strictly before anything is cached, so a misread grid
  // is never served and never stored.
  const [recent, live, older] = await Promise.all([
    hoursOf(base, start, Math.max(0, cur - 1), cur, nowSec),
    ask(base, 'query', { query: LIVE_QUERY, time: nowSec }).then(parseLive),
    history?.through === through || cur < 2
      ? (history?.hours ?? new Map())
      : hoursOf(base, start, 0, cur - 2, nowSec),
    !tokens || now - tokens.at > TOKENS_TTL_MS ? refreshTokens(base, start, nowSec) : null,
  ])
  history = { through, hours: older }
  const spent = tokens?.map ?? {}

  const payload = assemble(start, new Map([...older, ...recent]), live, Object.keys(spent))
  // Throws on anything we cannot render truthfully, before the cache write.
  validate(payload)
  return { body: JSON.stringify(publish(payload, spent)), at: Date.now() }
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
      // alike, so the public body stays generic. Single-flight plus the TTL keep
      // an outage to about one line per refresh.
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

/** Liveness for the cluster. Deliberately does not touch Prometheus. */
api.get('/api/health', (c) => c.json({ ok: true }))

/** For `@hono/vite-dev-server`, which expects a default export; the same `api`. */
export default api
