/**
 * API checks that need a build or a running server: that the built client holds
 * no trace of the upstream, and what the live proxy discloses.
 *
 * Only the missing VITE_ prefix keeps PROMETHEUS_URL's value out of the bundle:
 * renamed VITE_PROMETHEUS_URL, it ships to every visitor with no warning from
 * any tool but the containment section, which also fails if the server module
 * is bundled.
 *
 * The payload validator, the grid and ranking maths, and the proxy against a
 * stubbed Prometheus are unit tests beside the code: `pnpm run test`.
 *
 * Run: pnpm run build && node tools/verify-api.mjs [base-url]
 *
 * The live proxy section needs this project's own server answering at
 * `base-url` (default http://localhost:5173, or VERIFY_BASE). When it is not
 * there the section is skipped with the actual reason -- unless VERIFY_STRICT=1,
 * under which a section that could not run is a failure. A CI run must set it,
 * or these checks can pass by never executing.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, STRICT, describe, identify } from './base.mjs'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

// ------------------------------------------------------------ containment --
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

if (!existsSync('dist')) {
  fails.push('dist/ missing — run pnpm run build first')
} else {
  const files = walk('dist')
  const text = files
    .filter((f) => /\.(js|css|html|json|map)$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

  // Read the real address if present, so this catches an actual leak rather than
  // just the literal string "PROMETHEUS_URL".
  let url = null
  if (existsSync('.env')) {
    const m = readFileSync('.env', 'utf8').match(/^\s*PROMETHEUS_URL\s*=\s*(.+)$/m)
    if (m) url = m[1].trim().replace(/^["']|["']$/g, '')
  }
  check(
    'the real PROMETHEUS_URL value is not in dist/',
    url ? !text.includes(url) : true,
    url ? `checked ${files.length} files` : '(no .env; skipped the literal check)',
  )
  check('no bundled file names PROMETHEUS_URL', !text.includes('PROMETHEUS_URL'))
  check(
    "Prometheus's query API stays server-side",
    !text.includes('api/v1/query'),
    'client should only ever know /api/pixels',
  )
  check(
    'the server module is not bundled into the client',
    !text.includes('stellaris_turns_running'),
  )
}

// ------------------------------------------------ what the proxy discloses --
// Prometheus's series carry the citizen who ran each turn (`agent`) and the
// scrape target's labels; the proxy publishes a project slug and token counts
// per project. The names below can only appear if a series' labels were passed
// through. Not `cli` or `kind`, which are substrings of ordinary project names.
const FORBIDDEN = ['agent', 'instance', '__name__', 'stellaris_', 'cache_read', 'cache_write']
const ALLOWED_PROJECT_FIELDS = ['key', 'name', 'tokens', 'other']
const ALLOWED_TOKEN_FIELDS = ['in', 'out', 'cached']
/** A project slug, as Stellaris allows them. `society` is its own scope, not a project. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * Work out what is answering at BASE before asserting anything against it, so
 * a disclosure check can never pass against another application's response.
 * `identify` in base.mjs settles whose server it is; this adds whether it is
 * serving a payload.
 */
async function reachProxy() {
  const found = await identify(BASE)
  if (found.state !== 'ours') return found

  let res, body
  try {
    res = await fetch(`${BASE}/api/pixels`, { signal: AbortSignal.timeout(20_000) })
    body = await res.text()
  } catch (err) {
    return { state: 'unlit', why: `/api/pixels could not be read (${describe(err).slice(0, 60)})` }
  }
  if (!res.ok) {
    return {
      state: 'unlit',
      why: `our proxy is up but /api/pixels answered ${res.status}; PROMETHEUS_URL is probably unset or unreachable`,
    }
  }

  let json
  try {
    json = JSON.parse(body)
  } catch {
    return { state: 'malformed', why: '/api/pixels did not return JSON' }
  }
  // Shape-checked here, so an unreadable payload is reported as malformed
  // rather than crashing an assertion.
  if (!Array.isArray(json?.projects)) {
    return { state: 'malformed', why: '/api/pixels returned JSON with no projects array' }
  }
  // A valid board with nothing on it: no check below would have anything to read.
  if (json.projects.length === 0) {
    return { state: 'unlit', why: 'our proxy answered, but Prometheus has no project series yet' }
  }
  return { state: 'live', body, json }
}

const proxy = await reachProxy()

if (proxy.state !== 'live') {
  // A failure under STRICT, not a note: these are the checks this file exists for.
  if (STRICT) {
    check('the live proxy checks ran', false, proxy.why)
  } else {
    console.log(`skip  live proxy checks - ${proxy.why}`)
    console.log(
      '      (VERIFY_STRICT=1 makes this a failure; set it wherever the result is a gate)',
    )
  }
} else {
  // No try/catch on purpose: a throw here is a real defect and should crash, not
  // read as an unreachable server.
  const { body, json } = proxy
  const leaked = FORBIDDEN.filter((f) => body.includes(f))
  check('the proxy discloses no citizen or series label', leaked.length === 0, leaked.join(', '))

  const extra = [...new Set(json.projects.flatMap(Object.keys))].filter(
    (f) => !ALLOWED_PROJECT_FIELDS.includes(f),
  )
  check(
    'projects carry only the allowlisted fields',
    extra.length === 0,
    extra.length ? `unexpected: ${extra.join(', ')}` : '',
  )

  const extraTokens = [
    ...new Set(json.projects.flatMap((p) => Object.keys(p.tokens ?? {}))),
  ].filter((f) => !ALLOWED_TOKEN_FIELDS.includes(f))
  check(
    'token objects carry only in/out/cached',
    extraTokens.length === 0,
    extraTokens.length ? `unexpected: ${extraTokens.join(', ')}` : '',
  )

  const odd = json.projects.filter((p) => !SLUG.test(p.key) || p.key === 'society')
  check(
    'every key is a project slug, and none is the society scope',
    odd.length === 0,
    odd.map((p) => JSON.stringify(p.key)).join(', '),
  )

  const withTokens = json.projects.filter((p) => p.tokens)
  check(
    'projects carry token counts',
    withTokens.length > 0,
    `${withTokens.length}/${json.projects.length} counted`,
  )
  // `in` includes cache reads, so cached can equal it but never exceed it; if it
  // does, the two numbers came from different upstream fields.
  const impossible = withTokens.filter((p) => p.tokens.cached > p.tokens.in)
  check(
    'cache reads never exceed input',
    impossible.length === 0,
    impossible.map((p) => p.name ?? p.key).join(', '),
  )
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : 'all checks passed'}`,
)
process.exit(fails.length ? 1 : 0)
