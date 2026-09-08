/**
 * Contract tests for the /api/pixels proxy, against a stubbed upstream.
 *
 * This is the gate that can run anywhere, because it needs no credential and no
 * network: a throwaway HTTP server impersonates Argus, `ARGUS`/`ARGUS_KEY` point
 * at it, and the real Hono app is driven in-process through `api.fetch`.
 *
 * Stubbing the upstream rather than testing against the live one is not a
 * convenience. It is the stronger test. Asserting redaction against real data
 * only proves we stripped whatever Argus happened to send today; if it stopped
 * returning `costUsd`, the check would pass while the reduction was broken. The
 * fixture below carries every field on the forbidden list by construction, so a
 * pass means the stripping actually works.
 *
 * What it cannot do is notice Argus growing a new field, because the fixture is
 * whatever we wrote. That is the scheduled drift job's problem, not this one's.
 *
 * Run: node tools/verify-proxy.mjs
 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

/**
 * Everything that must never reach a visitor, plus two fields that exist only
 * here.
 *
 * `sneakyTopLevel` and `sneakyProjectField` are the point of this file. They are
 * not real Argus fields; they stand in for whatever Argus adds next. Before the
 * payload was rebuilt from named fields these rode straight through to the
 * browser, because the response was a `JSON.stringify` of the upstream object.
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

const PIXELS_FIXTURE = {
  start: '2026-07-26T16:00:00.000Z',
  slotMinutes: 60,
  slotCount: 4,
  tz: 'Asia/Shanghai',
  winners: [null, 0, 1, null],
  intensity: [0, 50, 100, 0],
  breakdown: { 1: { 0: 415, 1: 301 } },
  projects: [
    // A project object carrying a field Argus does not send today.
    { key: 'hash-a', wonSeconds: 10, sneakyProjectField: '/home/kyle/secret' },
    { key: 'hash-b', wonSeconds: 5 },
  ],
  live: [0],
  // A top-level field Argus does not send today.
  sneakyTopLevel: { machineId: 'box-1', costUsd: 12345.67 },
}

const NAMES_FIXTURE = {
  projects: [
    {
      key: 'hash-a',
      name: 'fluvio',
      // The revealing half of /me/usage/by-project, present in full so that a
      // pass means these were actually dropped.
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

/**
 * Stand in for Argus.
 *
 * `behaviour` lets a single scenario decide what the upstream does, so the
 * failure paths documented in api.ts -- an upstream 500, a payload the validator
 * rejects, a names lookup that dies -- can be exercised rather than described.
 * It also records the headers it was called with, which is how the one positive
 * assertion here works: that the key IS sent upstream.
 */
async function startUpstream(behaviour = {}) {
  const seen = { keys: [], paths: [] }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.paths.push(url.pathname + url.search)
    seen.keys.push(req.headers['x-api-key'])

    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }

    if (url.pathname === '/me/pixels') {
      if (behaviour.pixelsStatus) return send(behaviour.pixelsStatus, { error: 'nope' })
      return send(200, behaviour.pixelsBody ?? PIXELS_FIXTURE)
    }
    if (url.pathname === '/me/usage/by-project') {
      if (behaviour.namesStatus) return send(behaviour.namesStatus, { error: 'nope' })
      return send(200, NAMES_FIXTURE)
    }
    send(404, { error: 'unknown path' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` }
}

/**
 * A fresh copy of the proxy per scenario.
 *
 * api.ts holds its cache and its resolved names at module scope, which is
 * correct in production and would otherwise mean scenario two silently reading
 * scenario one's answer. The ESM registry is keyed by URL, so a query string
 * buys a clean module without adding a reset hatch to production code.
 */
/**
 * Bundled rather than imported straight from source, because api.ts imports
 * `../shared/pixels` without an extension. Vite and esbuild both resolve that;
 * Node's ESM resolver does not. Bundling is also what the container does, so
 * this exercises the module in the same form it ships in, and it avoids
 * rewriting production imports to suit a test.
 */
const workdir = mkdtempSync(join(tmpdir(), 'verify-proxy-'))
const bundle = join(workdir, 'api.mjs')
await build({
  entryPoints: ['src/server/api.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: bundle,
  logLevel: 'silent',
})

let instance = 0
async function freshProxy(base) {
  process.env.ARGUS = base
  process.env.ARGUS_KEY = 'test-key-not-a-real-credential'
  const mod = await import(`${pathToFileURL(bundle)}?case=${instance++}`)
  return mod.api
}

const get = (app, path = '/api/pixels') => app.fetch(new Request(`http://proxy${path}`))

// ------------------------------------------------------- the happy path --
{
  const up = await startUpstream()
  const app = await freshProxy(up.base)
  const res = await get(app)
  const body = await res.text()
  const json = JSON.parse(body)

  check('serves 200 when the upstream is healthy', res.status === 200, `got ${res.status}`)

  const leaked = FORBIDDEN.filter((f) => body.includes(f))
  check('no forbidden field survives into the response', leaked.length === 0, leaked.join(', '))

  // Stated separately from the sweep above so a regression names the actual
  // problem rather than "something leaked".
  check(
    'an unknown top-level upstream field is dropped',
    !Object.keys(json).includes('sneakyTopLevel'),
    Object.keys(json).join(', '),
  )
  check(
    'an unknown per-project upstream field is dropped',
    !json.projects.some((p) => 'sneakyProjectField' in p),
  )

  const fields = [...new Set(json.projects.flatMap(Object.keys))].sort()
  check(
    'projects carry only key, wonSeconds, name and tokens',
    fields.every((f) => ['key', 'wonSeconds', 'name', 'tokens'].includes(f)),
    fields.join(', '),
  )

  check('the grid survives intact', json.slotCount === 4 && json.winners.length === 4)
  check('breakdown survives, rebuilt', JSON.stringify(json.breakdown) === '{"1":{"0":415,"1":301}}',
    JSON.stringify(json.breakdown))

  // The names lookup is what turns a hash into a word, and it reads the most
  // revealing endpoint to do it. Both halves matter: the name arrives, the rest
  // of that payload does not.
  check('hashes resolve to names', json.projects[0].name === 'fluvio', json.projects[0].name)
  check(
    'a null name falls back to the directory basename',
    json.projects[1].name === 'harbor',
    json.projects[1].name,
  )
  check(
    'tokens are renamed to in/out/cached',
    json.projects[0].tokens.in === 980 && json.projects[0].tokens.out === 20 &&
      json.projects[0].tokens.cached === 850,
    JSON.stringify(json.projects[0].tokens),
  )

  // The only positive assertion about the credential: it has to go upstream, or
  // the proxy is not doing its job. Nothing else here can tell the difference
  // between "sent correctly" and "never sent".
  check(
    'the API key is sent upstream on both calls',
    up.seen.keys.length >= 2 && up.seen.keys.every((k) => k === 'test-key-not-a-real-credential'),
    JSON.stringify(up.seen.keys),
  )
  check(
    'both upstream calls request the same 42 day window',
    up.seen.paths.every((p) => p.includes('days=42')),
    up.seen.paths.join(' | '),
  )
  up.server.close()
}

// --------------------------------------------------------- failure paths --
{
  const up = await startUpstream({ pixelsStatus: 503 })
  const app = await freshProxy(up.base)
  const res = await get(app)
  const body = await res.text()
  check('an upstream 503 becomes a 502', res.status === 502, `got ${res.status}`)
  check(
    'the public body says nothing about why',
    body.includes('upstream unavailable') && !body.includes('503'),
    body.slice(0, 80),
  )
  up.server.close()
}

{
  // winners[1] indexes a project that does not exist. The validator exists for
  // exactly this: an out-of-range index paints the wrong project's colour
  // rather than failing, so it must never be cached or served.
  const bad = structuredClone(PIXELS_FIXTURE)
  bad.winners = [null, 9, 1, null]
  const up = await startUpstream({ pixelsBody: bad })
  const app = await freshProxy(up.base)
  const res = await get(app)
  check('a payload the validator rejects is not served', res.status === 502, `got ${res.status}`)
  up.server.close()
}

{
  // Names are a nicety. Losing them must cost the names, not the board.
  const up = await startUpstream({ namesStatus: 500 })
  const app = await freshProxy(up.base)
  const res = await get(app)
  const json = await res.json()
  check('a failed names lookup still serves the board', res.status === 200, `got ${res.status}`)
  check(
    'and falls back to hashes rather than inventing names',
    json.projects.every((p) => !p.name),
    JSON.stringify(json.projects.map((p) => p.name)),
  )
  up.server.close()
}

{
  // Caching, then serving stale. Serving a slightly old board beats going dark
  // because one call timed out.
  //
  // This scenario waits out the proxy's 9s TTL, which is the only way to reach
  // the stale branch: the cache is keyed on wall-clock time with no seam to
  // inject. Written the obvious way -- populate, kill the upstream, request
  // again -- it passes without testing anything, because the second request is
  // inside the TTL and is answered from the fresh cache without the upstream
  // being contacted at all. It did exactly that here first.
  const TTL_MS = 9_000
  const up = await startUpstream()
  const app = await freshProxy(up.base)

  const first = await get(app)
  check('first request populates the cache', first.status === 200 && first.headers.has('x-pixels-age'))
  const callsAfterFirst = up.seen.paths.length

  const second = await get(app)
  check(
    'a second request inside the TTL is served without touching the upstream',
    second.status === 200 && up.seen.paths.length === callsAfterFirst,
    `${up.seen.paths.length - callsAfterFirst} extra upstream calls`,
  )

  up.server.close()
  await once(up.server, 'close')
  await new Promise((r) => setTimeout(r, TTL_MS + 500))

  const third = await get(app)
  check(
    'once the cache expires and the upstream is gone, the payload is still served',
    third.status === 200,
    `got ${third.status}`,
  )
  check('and it is marked stale', third.headers.has('x-pixels-stale'),
    `headers: ${[...third.headers.keys()].join(', ')}`)
}

{
  const up = await startUpstream()
  delete process.env.ARGUS_KEY
  const mod = await import(`${pathToFileURL(bundle)}?case=${instance++}`)
  const res = await mod.api.fetch(new Request('http://proxy/api/pixels'))
  check('no credential configured is a 502, not a crash', res.status === 502, `got ${res.status}`)
  check('and the upstream was never called', up.seen.paths.length === 0, up.seen.paths.join(', '))
  up.server.close()
}

{
  const up = await startUpstream()
  const app = await freshProxy(up.base)
  const res = await get(app, '/api/health')
  check('health answers without touching the upstream', res.status === 200)
  check('and really does not call it', up.seen.paths.length === 0, up.seen.paths.join(', '))
  up.server.close()
}

rmSync(workdir, { recursive: true, force: true })

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : 'all checks passed'}`)
process.exit(fails.length ? 1 : 0)
