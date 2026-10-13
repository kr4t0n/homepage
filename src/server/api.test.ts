import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PixelPayload } from '../shared/pixels'
import { publish } from './api'

/**
 * Everything that must never reach a visitor. `sneakyTopLevel` and
 * `sneakyProjectField` exist only here and stand in for whatever Argus adds next.
 */
const FORBIDDEN = [
  'workingDir',
  'machineId',
  'projectId',
  'costUsd',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'turns',
  'cliTypes',
  'sneakyTopLevel',
  'sneakyProjectField',
]

// The fixtures carry every forbidden field by construction. Asserting redaction
// against live data would only prove we stripped whatever Argus sent that day;
// if it stopped sending `costUsd`, the check would pass with the reduction broken.
const PIXELS_FIXTURE = {
  start: '2026-07-26T16:00:00.000Z',
  slotMinutes: 60,
  slotCount: 4,
  tz: 'Asia/Shanghai',
  winners: [null, 0, 1, null],
  intensity: [0, 50, 100, 0],
  breakdown: { 1: { 0: 415, 1: 301 } },
  projects: [
    { key: 'hash-a', wonSeconds: 10, sneakyProjectField: '/home/kyle/secret' },
    { key: 'hash-b', wonSeconds: 5 },
    // Unknown to the names lookup, so nothing from it can add the fields back.
    { key: 'hash-c', wonSeconds: 1, sneakyProjectField: '/home/kyle/other' },
  ],
  live: [0],
  sneakyTopLevel: { machineId: 'box-1', costUsd: 12345.67 },
}

const NAMES_FIXTURE = {
  projects: [
    {
      key: 'hash-a',
      name: 'fluvio',
      workingDir: '/home/kyle/projects/fluvio',
      machineId: 'box-1',
      projectId: 'proj-1',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 850,
        cacheWriteTokens: 30,
        costUsd: 12345.67,
        turns: 42,
      },
    },
    {
      key: 'hash-b',
      name: null,
      workingDir: '/home/kyle/projects/harbor/',
      usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, costUsd: 0.5 },
    },
  ],
}

describe('publish', () => {
  const meta = { 'hash-a': { name: 'fluvio', tokens: { in: 980, out: 20, cached: 850 } } }
  const upstream = () => structuredClone(PIXELS_FIXTURE) as unknown as PixelPayload

  it('keeps the grid', () => {
    const out = publish(upstream(), meta)
    const { start, slotMinutes, slotCount, tz, winners, intensity, live } = PIXELS_FIXTURE
    expect(out).toMatchObject({ start, slotMinutes, slotCount, tz, winners, intensity, live })
  })

  it('drops an unknown top-level field', () => {
    expect(Object.keys(publish(upstream(), meta)).sort()).toEqual([
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
  })

  it('drops an unknown per-project field, whether or not the lookup knew the project', () => {
    const [a, b, c] = publish(upstream(), meta).projects
    expect(Object.keys(a).sort()).toEqual(['key', 'name', 'tokens', 'wonSeconds'])
    expect(Object.keys(b).sort()).toEqual(['key', 'wonSeconds'])
    expect(c).toEqual({ key: 'hash-c', wonSeconds: 1 })
    expect(publish(upstream(), {}).projects).toEqual([
      { key: 'hash-a', wonSeconds: 10 },
      { key: 'hash-b', wonSeconds: 5 },
      { key: 'hash-c', wonSeconds: 1 },
    ])
  })

  it('adds a name and tokens only where the lookup found them', () => {
    const [a, b] = publish(upstream(), meta).projects
    expect(a).toEqual({ key: 'hash-a', wonSeconds: 10, ...meta['hash-a'] })
    expect(b).toEqual({ key: 'hash-b', wonSeconds: 5 })
    expect(
      publish(upstream(), { 'hash-a': { tokens: meta['hash-a'].tokens } }).projects[0],
    ).toEqual({ key: 'hash-a', wonSeconds: 10, tokens: meta['hash-a'].tokens })
  })

  // Every key and value in a breakdown is a number. Anything else is dropped
  // rather than passed on, so nothing nested can ride through unexamined.
  it('rebuilds the breakdown from numbers alone', () => {
    const p = upstream()
    Object.assign(p, {
      breakdown: {
        1: { 0: 415, 1: '301', 2: Number.NaN, 3: Infinity, 4: { costUsd: 1 } },
        2: { 0: 'x' },
        3: 'not a cell',
        4: null,
      },
    })
    const out = publish(p, meta)
    expect(out.breakdown).toEqual({ 1: { 0: 415 } })
    expect(out.breakdown).not.toBe(p.breakdown)
  })

  it('adds no breakdown when upstream sent none', () => {
    const p = upstream()
    delete p.breakdown
    expect('breakdown' in publish(p, meta)).toBe(false)
  })
})

// The real Hono app, driven in-process through `api.fetch`, against a
// throwaway HTTP server that stands in for Argus. It needs no credential and no
// network beyond loopback.
describe('/api/pixels against a stubbed upstream', () => {
  const KEY = 'test-key-not-a-real-credential'
  const servers: ReturnType<typeof createServer>[] = []
  let errors: string[]
  let warnings: string[]

  interface Behaviour {
    pixelsStatus?: number
    pixelsBody?: unknown
    namesStatus?: number
  }

  async function startUpstream(behaviour: Behaviour = {}) {
    const seen = { keys: [] as (string | string[] | undefined)[], paths: [] as string[] }
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://upstream')
      seen.paths.push(url.pathname + url.search)
      seen.keys.push(req.headers['x-api-key'])
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/me/pixels') {
        if (behaviour.pixelsStatus) send(behaviour.pixelsStatus, { error: 'nope' })
        else send(200, behaviour.pixelsBody ?? PIXELS_FIXTURE)
      } else if (url.pathname === '/me/usage/by-project') {
        if (behaviour.namesStatus) send(behaviour.namesStatus, { error: 'nope' })
        else send(200, NAMES_FIXTURE)
      } else {
        send(404, { error: 'unknown path' })
      }
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return { server, seen, base: `http://127.0.0.1:${port}` }
  }

  /**
   * A fresh copy of the proxy. Its cache and resolved names live at module
   * scope, which is right in production and would otherwise hand one scenario
   * the previous scenario's answer.
   */
  async function freshProxy(base: string, key: string | null = KEY): Promise<Hono> {
    vi.stubEnv('ARGUS', base)
    vi.stubEnv('ARGUS_KEY', key ?? undefined)
    vi.resetModules()
    return (await import('./api')).api
  }

  const get = async (app: Hono, path = '/api/pixels') =>
    await app.fetch(new Request(`http://proxy${path}`))

  // The proxy logs every failure server-side. Captured rather than printed, so
  // the scenarios can check what was said and that the key was not in it.
  beforeEach(() => {
    errors = []
    warnings = []
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

  describe('with a healthy upstream', () => {
    let res: Response
    let body: string
    let json: PixelPayload
    let seen: Awaited<ReturnType<typeof startUpstream>>['seen']

    beforeAll(async () => {
      const up = await startUpstream()
      res = await get(await freshProxy(up.base))
      body = await res.text()
      json = JSON.parse(body) as PixelPayload
      seen = up.seen
    })

    it('serves 200', () => {
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('lets no forbidden field into the response', () => {
      expect(FORBIDDEN.filter((f) => body.includes(f))).toEqual([])
    })

    // Stated apart from the sweep above, so a regression names the actual
    // problem rather than "something leaked".
    it('drops an unknown top-level upstream field', () => {
      expect(Object.keys(json)).not.toContain('sneakyTopLevel')
    })

    it('drops an unknown per-project upstream field', () => {
      expect(json.projects.some((p) => 'sneakyProjectField' in p)).toBe(false)
    })

    it('gives projects only key, wonSeconds, name and tokens', () => {
      const fields = new Set(json.projects.flatMap((p) => Object.keys(p)))
      expect([...fields].sort()).toEqual(['key', 'name', 'tokens', 'wonSeconds'])
    })

    it('keeps the grid intact', () => {
      expect(json.slotCount).toBe(4)
      expect(json.winners).toEqual([null, 0, 1, null])
    })

    it('keeps the breakdown, rebuilt', () => {
      expect(json.breakdown).toEqual({ 1: { 0: 415, 1: 301 } })
    })

    // The names lookup reads the most revealing endpoint upstream. Both halves
    // matter: the name arrives, and the rest of that payload does not.
    it('resolves hashes to names', () => {
      expect(json.projects[0].name).toBe('fluvio')
    })

    it('falls back to the directory basename when a name is null', () => {
      expect(json.projects[1].name).toBe('harbor')
    })

    // `in` counts cache reads and writes, so cached can equal it but never pass it.
    it('renames tokens to in/out/cached', () => {
      expect(json.projects[0].tokens).toEqual({ in: 980, out: 20, cached: 850 })
      expect(json.projects[1].tokens).toEqual({ in: 5, out: 1, cached: 0 })
    })

    // The one positive assertion about the credential: it has to go upstream, or
    // the proxy is not doing its job.
    it('sends the API key upstream on both calls', () => {
      expect(seen.keys).toEqual([KEY, KEY])
    })

    it('asks both upstream calls for the same 42-day window', () => {
      expect(seen.paths).toHaveLength(2)
      expect(seen.paths.every((p) => p.includes('days=42'))).toBe(true)
    })
  })

  it('turns an upstream 503 into a 502 that says nothing about why', async () => {
    const up = await startUpstream({ pixelsStatus: 503 })
    const res = await get(await freshProxy(up.base))
    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ error: 'upstream unavailable' })
    // The cause stays in the server log, and the key stays out of it.
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('argus responded 503')
    expect(errors[0]).not.toContain(KEY)
  })

  // winners[1] indexes a project that does not exist. An out-of-range index
  // paints the wrong project's colour rather than failing, so such a payload
  // must never be served or cached.
  it('neither serves nor caches a payload the validator rejects', async () => {
    const bad = { ...PIXELS_FIXTURE, winners: [null, 9, 1, null] }
    const up = await startUpstream({ pixelsBody: bad })
    const app = await freshProxy(up.base)
    expect((await get(app)).status).toBe(502)
    expect(errors[0]).toContain('winners[1] = 9 does not index')
    expect((await get(app)).status).toBe(502)
    expect(up.seen.paths.filter((p) => p.startsWith('/me/pixels'))).toHaveLength(2)
  })

  // Names are a nicety. Losing them must cost the names, not the board, and
  // must not let a project out unreduced.
  it('serves the board with hashes when the names lookup fails', async () => {
    const up = await startUpstream({ namesStatus: 500 })
    const res = await get(await freshProxy(up.base))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(FORBIDDEN.filter((f) => body.includes(f))).toEqual([])
    const json = JSON.parse(body) as PixelPayload
    expect(json.projects).toEqual([
      { key: 'hash-a', wonSeconds: 10 },
      { key: 'hash-b', wonSeconds: 5 },
      { key: 'hash-c', wonSeconds: 1 },
    ])
    expect(warnings[0]).toContain('names lookup failed')
  })

  it('makes one upstream request for concurrent misses', async () => {
    const up = await startUpstream()
    const app = await freshProxy(up.base)
    const all = await Promise.all([get(app), get(app), get(app)])
    expect(all.map((r) => r.status)).toEqual([200, 200, 200])
    expect(up.seen.paths.filter((p) => p.startsWith('/me/pixels'))).toHaveLength(1)
  })

  // The cache is keyed on Date.now(), so faking Date alone crosses the 9s TTL
  // while sockets and fetch keep real timers. The stale request must land past
  // the TTL, or the fresh cache answers it and the test proves nothing.
  it('caches for 9s, then serves a stale payload once the upstream is gone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    const up = await startUpstream()
    const app = await freshProxy(up.base)
    const calls = (path: string) => up.seen.paths.filter((p) => p.startsWith(path)).length

    const first = await get(app)
    expect(first.status).toBe(200)
    expect(first.headers.get('x-pixels-age')).toBe('0')
    const payload = await first.text()
    const callsAfterFirst = up.seen.paths.length

    vi.setSystemTime(t0 + 8_999)
    const second = await get(app)
    expect(second.status).toBe(200)
    expect(up.seen.paths).toHaveLength(callsAfterFirst)

    // The pixels refresh; the names, on their own five-minute TTL, do not.
    vi.setSystemTime(t0 + 9_000)
    expect((await get(app)).status).toBe(200)
    expect(calls('/me/pixels')).toBe(2)
    expect(calls('/me/usage/by-project')).toBe(1)

    up.server.close()
    await once(up.server, 'close')
    vi.setSystemTime(t0 + 18_500)
    const stale = await get(app)
    expect(stale.status).toBe(200)
    expect(stale.headers.get('x-pixels-stale')).toBe('9500')
    expect(stale.headers.get('cache-control')).toBe('no-store')
    expect(await stale.text()).toBe(payload)
    expect(errors[0]).toContain('serving a payload 10s old')
  })

  it('refreshes names after five minutes, and keeps the last good ones if that fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    const behaviour: Behaviour = {}
    const up = await startUpstream(behaviour)
    const app = await freshProxy(up.base)
    const namesCalls = () => up.seen.paths.filter((p) => p.startsWith('/me/usage')).length
    const firstName = async () => ((await (await get(app)).json()) as PixelPayload).projects[0].name

    expect(await firstName()).toBe('fluvio')
    vi.setSystemTime(t0 + 5 * 60_000)
    expect(await firstName()).toBe('fluvio')
    expect(namesCalls()).toBe(1)

    // Past both TTLs: the pixels refresh, and the names are due again.
    behaviour.namesStatus = 500
    vi.setSystemTime(t0 + 5 * 60_000 + 9_000)
    expect(await firstName()).toBe('fluvio')
    expect(namesCalls()).toBe(2)
    expect(warnings[0]).toContain('names lookup failed')
  })

  it('answers 502 without calling upstream when no key is configured', async () => {
    const up = await startUpstream()
    const res = await get(await freshProxy(up.base, null))
    expect(process.env.ARGUS_KEY).toBeUndefined()
    expect(res.status).toBe(502)
    expect(up.seen.paths).toEqual([])
    expect(errors[0]).toContain('ARGUS and ARGUS_KEY must be set')
  })

  it('answers health without calling upstream', async () => {
    const up = await startUpstream()
    const res = await get(await freshProxy(up.base), '/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(up.seen.paths).toEqual([])
  })
})
