import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PixelPayload } from '../shared/pixels'
import { publish } from './api'
import { LIVE_QUERY, gridQuery, gridStart, slotEnd, tokensQuery } from './prometheus'

/**
 * Everything that must never reach a visitor: the labels and citizens the stub
 * attaches to every series, and fields that stand in for whatever Prometheus
 * adds next. The fixtures plant each one by construction, so the sweep would
 * fail if any of them were passed through.
 */
const FORBIDDEN = [
  'agent',
  'eng-1',
  'eng-2',
  'instance',
  'pod',
  '__name__',
  'stellaris_',
  'cache_read',
  'cache_write',
  'sneaky',
]

/** 13:00:30 in Shanghai: the current hour is slot 997, 30 seconds old. */
const NOW = Date.parse('2026-11-12T05:00:30Z')
const START = gridStart(NOW)
const CUR = 997

/** Turn-steps per slot: the turns running, summed over the hour's 30-second steps. */
const GRID: Record<number, Record<string, number>> = {
  [CUR]: { demo: 1 },
  // Contested: demo held 80 of the 120 turn-steps, under 70% of what ran.
  [CUR - 1]: { demo: 80, 'web-app': 40 },
  // Two turns for the whole hour: 7200 s in a one-hour cell, as Argus summed them.
  990: { 'web-app': 240 },
  500: { docs: 30 },
}

const TOKENS: Record<string, Record<string, number>> = {
  demo: { input: 100, output: 20, cache_read: 850, cache_write: 30 },
  'web-app': { input: 5, output: 1, cache_read: 0, cache_write: 0 },
  // Spent tokens in the window without winning an hour.
  archive: { input: 7, output: 3 },
}

/** What Prometheus attaches to a series beyond the labels asked for. */
const planted = (agent: string) => ({
  agent,
  instance: '10.0.0.7:4701',
  pod: 'server-0',
  __name__: 'stellaris_turns_running',
})

const answer = (resultType: string, result: unknown[]) => ({
  status: 'success',
  data: { resultType, result, sneakyData: 1 },
  infos: ['sneaky info'],
})

function gridAnswer(start: number, end: number, step: number) {
  const byProject: Record<string, [number, string][]> = {}
  for (let at = start; at <= end; at += step) {
    const slot = (at - START / 1000) / 3600 - 1
    for (const [project, steps] of Object.entries(GRID[slot] ?? {})) {
      ;(byProject[project] ??= []).push([at, String(steps)])
    }
  }
  return answer(
    'matrix',
    Object.entries(byProject).map(([project, values]) => ({
      metric: { project, ...planted('eng-1') },
      values,
    })),
  )
}

const tokensAnswer = () =>
  answer(
    'vector',
    Object.entries(TOKENS).flatMap(([project, kinds]) =>
      Object.entries(kinds).map(([kind, n]) => ({
        metric: { project, kind, ...planted('eng-2') },
        value: [NOW / 1000, String(n)],
      })),
    ),
  )

const liveAnswer = () =>
  answer('vector', [{ metric: { project: 'demo', ...planted('eng-1') }, value: [NOW / 1000, '2'] }])

describe('publish', () => {
  const spent = { demo: { in: 980, out: 20, cached: 850 } }
  const assembled = (): PixelPayload => ({
    start: '2026-07-26T16:00:00.000Z',
    slotMinutes: 60,
    slotCount: 4,
    tz: 'Asia/Shanghai',
    winners: [null, 0, 1, null],
    intensity: [0, 50, 100, 0],
    breakdown: { 1: { 0: 415, 1: 301 } },
    projects: [{ key: 'demo' }, { key: 'web-app' }],
    live: [0],
  })

  it('keeps the grid', () => {
    const { start, slotMinutes, slotCount, tz, winners, intensity, live } = assembled()
    expect(publish(assembled(), spent)).toMatchObject({
      start,
      slotMinutes,
      slotCount,
      tz,
      winners,
      intensity,
      live,
    })
  })

  it('drops an unknown top-level or per-project field', () => {
    const p = Object.assign(assembled(), { sneakyTopLevel: 1 })
    Object.assign(p.projects[0], { sneakyProjectField: 1, name: 'x' })
    const out = publish(p, spent)
    expect(Object.keys(out).sort()).toEqual([
      'breakdown',
      'intensity',
      'live',
      'projects',
      'slotCount',
      'slotMinutes',
      'start',
      'tz',
      'winners',
    ])
    expect(out.projects).toEqual([{ key: 'demo', tokens: spent.demo }, { key: 'web-app' }])
  })

  it('copies token counts field by field', () => {
    const out = publish(assembled(), { demo: { ...spent.demo, sneaky: 1 } as never })
    expect(out.projects[0].tokens).toEqual(spent.demo)
    expect(out.projects[0].tokens).not.toBe(spent.demo)
  })

  // Every key and value in a breakdown is a number. Anything else is dropped
  // rather than passed on, so nothing nested can ride through unexamined.
  it('rebuilds the breakdown from numbers alone', () => {
    const p = assembled()
    Object.assign(p, {
      breakdown: {
        1: { 0: 415, 1: '301', 2: Number.NaN, 3: Infinity, 4: { agent: 1 } },
        2: { 0: 'x' },
        3: 'not a cell',
        4: null,
      },
    })
    const out = publish(p, spent)
    expect(out.breakdown).toEqual({ 1: { 0: 415 } })
    expect(out.breakdown).not.toBe(p.breakdown)
  })
})

// The real Hono app, driven in-process through `api.fetch`, against a
// throwaway HTTP server that stands in for Prometheus. It needs no network
// beyond loopback. Date is frozen at NOW, so the grid's slots are fixed.
describe('/api/pixels against a stubbed Prometheus', () => {
  const servers: ReturnType<typeof createServer>[] = []
  let errors: string[]
  let warnings: string[]

  type Kind = 'history' | 'recent' | 'live' | 'tokens'
  interface Behaviour {
    status?: Partial<Record<Kind, number>>
    body?: Partial<Record<Kind, unknown>>
  }
  interface Asked {
    kind: Kind
    path: string
    params: Record<string, string>
  }

  async function startPrometheus(behaviour: Behaviour = {}) {
    const asked: Asked[] = []
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://prometheus')
      const params = Object.fromEntries(url.searchParams)
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      let kind: Kind
      let body: () => unknown
      if (url.pathname.endsWith('/api/v1/query_range')) {
        const [start, end, step] = [params.start, params.end, params.step].map(Number)
        kind = (end - start) / step + 1 > 2 ? 'history' : 'recent'
        body = () => gridAnswer(start, end, step)
      } else if (url.pathname.endsWith('/api/v1/query')) {
        kind = params.query.includes('increase(') ? 'tokens' : 'live'
        body = kind === 'tokens' ? tokensAnswer : liveAnswer
      } else {
        send(404, { status: 'error', error: 'unknown path' })
        return
      }
      asked.push({ kind, path: url.pathname, params })
      const status = behaviour.status?.[kind]
      if (status) send(status, { status: 'error', error: `stub ${kind} failed` })
      else send(200, behaviour.body?.[kind] ?? body())
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    const count = (kind: Kind) => asked.filter((a) => a.kind === kind).length
    return { server, asked, count, base: `http://127.0.0.1:${port}` }
  }

  /**
   * A fresh copy of the proxy. Its caches live at module scope, which is right
   * in production and would otherwise hand one scenario the previous scenario's answer.
   */
  async function freshProxy(url: string | null): Promise<Hono> {
    vi.stubEnv('PROMETHEUS_URL', url ?? undefined)
    vi.resetModules()
    return (await import('./api')).api
  }

  const get = async (app: Hono, path = '/api/pixels') =>
    await app.fetch(new Request(`http://proxy${path}`))

  // The proxy logs every failure server-side. Captured rather than printed, so
  // the scenarios can check what was said.
  beforeEach(() => {
    errors = []
    warnings = []
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args.join(' ')))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  afterAll(async () => {
    await Promise.all(
      servers.filter((s) => s.listening).map((s) => new Promise((done) => s.close(done))),
    )
  })

  describe('with a healthy Prometheus', () => {
    let res: Response
    let body: string
    let json: PixelPayload
    let asked: Asked[]
    const index = (key: string) => json.projects.findIndex((p) => p.key === key)

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
      const up = await startPrometheus()
      res = await get(await freshProxy(up.base))
      body = await res.text()
      json = JSON.parse(body) as PixelPayload
      asked = up.asked
      vi.useRealTimers()
    })

    it('serves 200', () => {
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('lets no citizen, label or unknown field into the response', () => {
      expect(FORBIDDEN.filter((f) => body.includes(f))).toEqual([])
    })

    it('gives projects only a key and tokens', () => {
      const fields = new Set(json.projects.flatMap((p) => Object.keys(p)))
      expect([...fields].sort()).toEqual(['key', 'tokens'])
    })

    it('ranks projects by the time they won, then by key', () => {
      // web-app won 7200s, demo 30s + 2400s, docs 900s; archive only spent tokens.
      expect(json.projects.map((p) => p.key)).toEqual(['web-app', 'demo', 'docs', 'archive'])
    })

    it('starts the grid at Shanghai midnight 41 days back', () => {
      expect(json.start).toBe('2026-10-01T16:00:00.000Z')
      expect(json.slotCount).toBe(1008)
      expect(json.tz).toBe('Asia/Shanghai')
    })

    it('lights the hours that ran, from both the history and the recent query', () => {
      const lit = Object.fromEntries(
        json.winners.flatMap((w, slot) => (w === null ? [] : [[slot, json.projects[w].key]])),
      )
      expect(lit).toEqual({ 500: 'docs', 990: 'web-app', 996: 'demo', 997: 'demo' })
    })

    it('scales brightness against the busiest hour', () => {
      expect([json.intensity[990], json.intensity[996], json.intensity[500]]).toEqual([100, 50, 13])
      // One turn-step against 240 rounds to dark, though demo owns the hour.
      expect(json.intensity[997]).toBe(0)
      expect(json.winners[997]).toBe(index('demo'))
    })

    it('splits only the contested hour, in seconds', () => {
      expect(json.breakdown).toEqual({
        996: { [index('demo')]: 2400, [index('web-app')]: 1200 },
      })
    })

    it('blinks for the project running now', () => {
      expect(json.live).toEqual([index('demo')])
    })

    // `in` counts both cache kinds, so cached can equal it but never pass it.
    it('counts tokens as in/out/cached', () => {
      expect(json.projects[index('demo')].tokens).toEqual({ in: 980, out: 20, cached: 850 })
      expect(json.projects[index('web-app')].tokens).toEqual({ in: 5, out: 1, cached: 0 })
      expect(json.projects[index('archive')].tokens).toEqual({ in: 7, out: 3, cached: 0 })
      expect(json.projects[index('docs')].tokens).toBeUndefined()
    })

    it('sends only the fixed queries', () => {
      const nowSec = NOW / 1000
      expect(new Set(asked.map((a) => a.params.query))).toEqual(
        new Set([gridQuery(nowSec), LIVE_QUERY, tokensQuery(nowSec - START / 1000)]),
      )
      expect(asked.filter((a) => a.params.time).every((a) => a.params.time === `${nowSec}`)).toBe(
        true,
      )
    })

    it('asks for every hour of the window, the last two apart', () => {
      const range = (kind: Kind) => {
        const a = asked.find((x) => x.kind === kind)!.params
        return [a.start, a.end, a.step].map(Number)
      }
      expect(range('history')).toEqual([slotEnd(START, 0), slotEnd(START, CUR - 2), 3600])
      expect(range('recent')).toEqual([slotEnd(START, CUR - 1), slotEnd(START, CUR), 3600])
    })
  })

  it('serves an unlit board while Prometheus has no series yet', async () => {
    const empty = answer('vector', [])
    const up = await startPrometheus({
      body: {
        history: answer('matrix', []),
        recent: answer('matrix', []),
        live: empty,
        tokens: empty,
      },
    })
    const res = await get(await freshProxy(up.base))
    expect(res.status).toBe(200)
    const json = (await res.json()) as PixelPayload
    expect(json.winners.every((w) => w === null)).toBe(true)
    expect(json.intensity.every((v) => v === 0)).toBe(true)
    expect(json.projects).toEqual([])
    expect(json.live).toEqual([])
  })

  it('turns a Prometheus 503 into a 502 that says nothing about why', async () => {
    const up = await startPrometheus({ status: { recent: 503 } })
    const res = await get(await freshProxy(up.base))
    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ error: 'upstream unavailable' })
    // The cause stays in the server log.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('prometheus query_range responded 503: stub recent failed')
  })

  // A label that is no project slug could carry anything into a public page,
  // so such an answer must never be served or cached.
  it('neither serves nor caches an answer the parser refuses', async () => {
    const bad = gridAnswer(slotEnd(START, CUR - 1), slotEnd(START, CUR), 3600)
    Object.assign((bad.data.result[0] as { metric: object }).metric, { project: '/home/eng-1' })
    const up = await startPrometheus({ body: { recent: bad } })
    const app = await freshProxy(up.base)
    expect((await get(app)).status).toBe(502)
    expect(errors[0]).toContain('is not a project slug')
    expect((await get(app)).status).toBe(502)
    expect(up.count('recent')).toBe(2)
  })

  // Tokens are a nicety. Losing them must cost the ranking, not the grid.
  it('serves the grid without tokens when the token query fails', async () => {
    const up = await startPrometheus({ status: { tokens: 500 } })
    const res = await get(await freshProxy(up.base))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(FORBIDDEN.filter((f) => body.includes(f))).toEqual([])
    const json = JSON.parse(body) as PixelPayload
    expect(json.projects).toEqual([{ key: 'web-app' }, { key: 'demo' }, { key: 'docs' }])
    expect(warnings[0]).toContain('token lookup failed')
  })

  it('makes one round of queries for concurrent misses', async () => {
    const up = await startPrometheus()
    const app = await freshProxy(up.base)
    const all = await Promise.all([get(app), get(app), get(app)])
    expect(all.map((r) => r.status)).toEqual([200, 200, 200])
    expect(up.asked.map((a) => a.kind).sort()).toEqual(['history', 'live', 'recent', 'tokens'])
  })

  // The cache is keyed on Date.now(), so faking Date alone crosses the 9s TTL
  // while sockets and fetch keep real timers. The stale request must land past
  // the TTL, or the fresh cache answers it and the test proves nothing.
  it('caches for 9s, then serves a stale payload once Prometheus is gone', async () => {
    const up = await startPrometheus()
    const app = await freshProxy(up.base)

    const first = await get(app)
    expect(first.status).toBe(200)
    expect(first.headers.get('x-pixels-age')).toBe('0')
    const payload = await first.text()
    const askedAfterFirst = up.asked.length

    vi.setSystemTime(NOW + 8_999)
    expect((await get(app)).status).toBe(200)
    expect(up.asked).toHaveLength(askedAfterFirst)

    // The recent hours and the live set refresh; the history and the tokens,
    // on their own clocks, do not.
    vi.setSystemTime(NOW + 9_000)
    expect((await get(app)).status).toBe(200)
    expect([up.count('recent'), up.count('live')]).toEqual([2, 2])
    expect([up.count('history'), up.count('tokens')]).toEqual([1, 1])

    up.server.close()
    await once(up.server, 'close')
    vi.setSystemTime(NOW + 18_500)
    const stale = await get(app)
    expect(stale.status).toBe(200)
    expect(stale.headers.get('x-pixels-stale')).toBe('9500')
    expect(stale.headers.get('cache-control')).toBe('no-store')
    expect(await stale.text()).toBe(payload)
    expect(errors[0]).toContain('serving a payload 10s old')
  })

  it('reads the history again once the current hour moves on', async () => {
    const up = await startPrometheus()
    const app = await freshProxy(up.base)
    await get(app)
    // 13:59:50, then 14:00:00: ten seconds apart, past the response cache.
    vi.setSystemTime(NOW + 3_560_000)
    await get(app)
    expect(up.count('history')).toBe(1)

    vi.setSystemTime(NOW + 3_570_000)
    await get(app)
    expect(up.count('history')).toBe(2)
    const last = up.asked.filter((a) => a.kind === 'history').at(-1)!.params
    expect(Number(last.end)).toBe(slotEnd(START, CUR - 1))
  })

  it('refreshes tokens after five minutes, and keeps the last good ones if that fails', async () => {
    const behaviour: Behaviour = {}
    const up = await startPrometheus(behaviour)
    const app = await freshProxy(up.base)
    const demoTokens = async () =>
      ((await (await get(app)).json()) as PixelPayload).projects.find((p) => p.key === 'demo')
        ?.tokens

    expect(await demoTokens()).toEqual({ in: 980, out: 20, cached: 850 })
    vi.setSystemTime(NOW + 5 * 60_000)
    expect(await demoTokens()).toEqual({ in: 980, out: 20, cached: 850 })
    expect(up.count('tokens')).toBe(1)

    // Past both TTLs: the grid refreshes, and the tokens are due again.
    behaviour.status = { tokens: 500 }
    vi.setSystemTime(NOW + 5 * 60_000 + 9_000)
    expect(await demoTokens()).toEqual({ in: 980, out: 20, cached: 850 })
    expect(up.count('tokens')).toBe(2)
    expect(warnings[0]).toContain('token lookup failed')
  })

  it('reaches a Prometheus served under a path prefix', async () => {
    const up = await startPrometheus()
    expect((await get(await freshProxy(`${up.base}/prometheus`))).status).toBe(200)
    expect(up.asked.every((a) => a.path.startsWith('/prometheus/api/v1/'))).toBe(true)
  })

  it.each([
    ['no URL is configured', null, 'PROMETHEUS_URL must be set'],
    ['the URL has no scheme', 'prometheus.monitoring:9090', 'must start with http://'],
  ])('answers 502 without calling Prometheus when %s', async (_, url, why) => {
    const up = await startPrometheus()
    const res = await get(await freshProxy(url))
    expect(res.status).toBe(502)
    expect(up.asked).toEqual([])
    expect(errors[0]).toContain(why)
  })

  it('answers health without calling Prometheus', async () => {
    const up = await startPrometheus()
    const res = await get(await freshProxy(up.base), '/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(up.asked).toEqual([])
  })
})
