import type { PixelPayload } from '../shared/pixels'

/**
 * What the wall boards ask Prometheus, and how its answers become the grid.
 * Server-only. The queries are fixed, and each sums the citizen label away, so
 * only a project's figures ever leave Prometheus.
 */

/** Six weeks, the board's 42 columns. The token counts cover the same window. */
export const WINDOW_DAYS = 42

/** The board's printed rows are this zone's hours. No daylight saving, so a day is 24 slots. */
export const TZ = 'Asia/Shanghai'

export const SLOT_MINUTES = 60
export const SLOT_COUNT = (WINDOW_DAYS * 24 * 60) / SLOT_MINUTES
export const SLOT_SECONDS = SLOT_MINUTES * 60

/** The Stellaris server's scrape interval: one reading of the gauge per step. */
export const STEP_SECONDS = 30
const STEPS_PER_SLOT = SLOT_SECONDS / STEP_SECONDS

/** Winner share below which an hour is contested and gets a `breakdown`, as Argus had it. */
const CONTESTED = 0.7

/**
 * Projects only. `society` is the scope of turns outside any project, and an
 * empty `project` is a series from before the label existed.
 */
const SCOPE = 'project!="",project!="society"'
const RUNNING = `stellaris_turns_running{${SCOPE}}`
const TOKENS = `stellaris_turn_tokens_total{${SCOPE},kind=~"input|output|cache_read|cache_write"}`

/** A project slug, as the board allows them. Anything else is not a label we publish. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * Per project and hour: `steps`, the 30-second steps at which any of its turns
 * was running, and `turns`, its turns summed over the hour's samples, which
 * only breaks ties. The guard stops the current hour's later steps from reading
 * the last sample through Prometheus's five-minute lookback.
 */
export function gridQuery(nowSec: number): string {
  const busy = `(sum by (project) (${RUNNING}) > bool 0) and on () (vector(time()) <= ${nowSec})`
  const steps = `sum_over_time((${busy})[${SLOT_MINUTES}m:${STEP_SECONDS}s])`
  const turns = `sum by (project) (sum_over_time(${RUNNING}[${SLOT_MINUTES}m]))`
  return `label_replace(${steps}, "of", "steps", "", "") or label_replace(${turns}, "of", "turns", "", "")`
}

/** Projects with a turn running now. */
export const LIVE_QUERY = `sum by (project) (${RUNNING}) > 0`

/** Tokens per project and kind over the last `windowSec` seconds. */
export function tokensQuery(windowSec: number): string {
  return `sum by (project, kind) (increase(${TOKENS}[${windowSec}s]))`
}

export interface Tokens {
  in: number
  out: number
  cached: number
}

/** Hour end (unix seconds) to project to its readings. */
export type Hours = Map<number, Map<string, { steps: number; turns: number }>>

/** UTC instant (ms) of slot 0: local midnight, `WINDOW_DAYS - 1` days back. */
export function gridStart(now: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, Number(p.value)]),
  )
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const offset = wall - Math.floor(now / 1000) * 1000
  return Date.UTC(parts.year, parts.month - 1, parts.day - (WINDOW_DAYS - 1)) - offset
}

/** Unix seconds at which slot `i` ends, the instant Prometheus evaluates it at. */
export const slotEnd = (startMs: number, i: number): number =>
  startMs / 1000 + (i + 1) * SLOT_SECONDS

/** The slot `now` falls in. */
export const currentSlot = (startMs: number, now: number): number =>
  Math.floor((now - startMs) / (SLOT_SECONDS * 1000))

type Series = { metric: Record<string, unknown>; values?: unknown; value?: unknown }

function malformed(why: string): never {
  throw new Error(`malformed prometheus answer: ${why}`)
}

/**
 * Read a Prometheus API answer, refusing anything but the shape asked for. A
 * grid painted from a misread answer looks authoritative and is wrong.
 */
function results(json: unknown, type: 'matrix' | 'vector'): Series[] {
  const d = json as { status?: unknown; data?: { resultType?: unknown; result?: unknown } }
  if (d?.status !== 'success') malformed(`status ${String(d?.status)}`)
  if (d.data?.resultType !== type)
    malformed(`resultType ${String(d.data?.resultType)}, not ${type}`)
  const result = d.data.result
  if (!Array.isArray(result)) malformed('result is not an array')
  for (const s of result as Series[]) {
    const project = s?.metric?.project
    if (typeof project !== 'string' || !SLUG.test(project)) {
      malformed(`project ${JSON.stringify(project)} is not a project slug`)
    }
  }
  return result as Series[]
}

/** A sample's value: Prometheus sends it as a string. */
function sample(v: unknown, what: string): number {
  const n = Array.isArray(v) && typeof v[1] === 'string' ? Number(v[1]) : Number.NaN
  if (!Number.isFinite(n) || n < 0) malformed(`${what} = ${JSON.stringify(v)}`)
  return n
}

/** The grid query's answer, keyed by hour end. Only the hours in `ends` are accepted. */
export function parseGrid(json: unknown, ends: number[]): Hours {
  const expected = new Set(ends)
  const hours: Hours = new Map()
  for (const s of results(json, 'matrix')) {
    const project = s.metric.project as string
    const of = s.metric.of
    if (of !== 'steps' && of !== 'turns') malformed(`series of ${JSON.stringify(of)}`)
    if (!Array.isArray(s.values)) malformed(`no values for ${project}`)
    for (const v of s.values as unknown[]) {
      const at = Array.isArray(v) ? v[0] : undefined
      if (typeof at !== 'number' || !expected.has(at)) {
        malformed(`${project} at ${String(at)} is no hour end asked for`)
      }
      const n = sample(v, `${of} of ${project}`)
      if (of === 'steps' && (!Number.isInteger(n) || n > STEPS_PER_SLOT)) {
        malformed(`${n} steps of ${project} in one hour`)
      }
      let hour = hours.get(at)
      if (!hour) hours.set(at, (hour = new Map()))
      const reading = hour.get(project) ?? { steps: 0, turns: 0 }
      reading[of] = n
      hour.set(project, reading)
    }
  }
  return hours
}

/** The live query's answer: projects with a turn running. */
export function parseLive(json: unknown): Set<string> {
  return new Set(
    results(json, 'vector')
      .filter((s) => sample(s.value, `turns running in ${String(s.metric.project)}`) > 0)
      .map((s) => s.metric.project as string),
  )
}

/**
 * The tokens query's answer, as `in` (input and both cache kinds), `out` and
 * `cached` (cache reads, part of `in`). A project with none in the window is left out.
 */
export function parseTokens(json: unknown): Record<string, Tokens> {
  const kinds: Record<string, Record<string, number>> = {}
  for (const s of results(json, 'vector')) {
    const project = s.metric.project as string
    const kind = s.metric.kind
    if (kind !== 'input' && kind !== 'output' && kind !== 'cache_read' && kind !== 'cache_write') {
      malformed(`token kind ${JSON.stringify(kind)}`)
    }
    kinds[project] ??= {}
    kinds[project][kind] = sample(s.value, `${kind} tokens of ${project}`)
  }
  const out: Record<string, Tokens> = {}
  for (const [project, k] of Object.entries(kinds)) {
    const read = k.cache_read ?? 0
    // Rounded after summing, so `cached` can never exceed `in`.
    const t = {
      in: Math.round((k.input ?? 0) + read + (k.cache_write ?? 0)),
      out: Math.round(k.output ?? 0),
      cached: Math.round(read),
    }
    if (t.in + t.out > 0) out[project] = t
  }
  return out
}

/**
 * Build the grid from readings. Each hour goes to the project with the most
 * busy steps, then the most turns, then the first key. Brightness is the hour's
 * busy time over all projects, against the busiest hour. `projects` is every
 * project that ran, runs now or spent tokens, ranked by the time it won.
 */
export function assemble(
  startMs: number,
  hours: Hours,
  live: Set<string>,
  spent: Iterable<string>,
): PixelPayload {
  const slots: { slot: number; ran: [string, { steps: number; turns: number }][] }[] = []
  for (const [at, byProject] of hours) {
    const slot = Math.round((at - startMs / 1000) / SLOT_SECONDS) - 1
    if (slot < 0 || slot >= SLOT_COUNT) continue
    const ran = [...byProject].filter(([, r]) => r.steps > 0)
    if (ran.length) slots.push({ slot, ran })
  }

  const won = new Map<string, number>()
  for (const p of [...live, ...spent]) won.set(p, 0)
  const winnerOf = new Map<number, string>()
  for (const { slot, ran } of slots) {
    ran.sort(([a, ra], [b, rb]) => rb.steps - ra.steps || rb.turns - ra.turns || a.localeCompare(b))
    const [winner, r] = ran[0]
    winnerOf.set(slot, winner)
    for (const [p] of ran) won.set(p, won.get(p) ?? 0)
    won.set(winner, won.get(winner)! + r.steps * STEP_SECONDS)
  }

  const ranked = [...won].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([p]) => p)
  const indexOf = new Map(ranked.map((p, i) => [p, i]))

  const total = (ran: [string, { steps: number }][]) => ran.reduce((n, [, r]) => n + r.steps, 0)
  const busiest = Math.max(0, ...slots.map(({ ran }) => total(ran)))
  const winners: (number | null)[] = new Array(SLOT_COUNT).fill(null)
  const intensity: number[] = new Array(SLOT_COUNT).fill(0)
  const breakdown: Record<string, Record<string, number>> = {}
  for (const { slot, ran } of slots) {
    const sum = total(ran)
    winners[slot] = indexOf.get(winnerOf.get(slot)!)!
    intensity[slot] = Math.round((sum / busiest) * 100)
    if (ran[0][1].steps / sum < CONTESTED) {
      breakdown[slot] = Object.fromEntries(
        ran.map(([p, r]) => [indexOf.get(p)!, r.steps * STEP_SECONDS]),
      )
    }
  }

  return {
    start: new Date(startMs).toISOString(),
    slotMinutes: SLOT_MINUTES,
    slotCount: SLOT_COUNT,
    tz: TZ,
    winners,
    intensity,
    projects: ranked.map((key) => ({ key })),
    breakdown,
    live: [...live].map((p) => indexOf.get(p)!).sort((a, b) => a - b),
  }
}
