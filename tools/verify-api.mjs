/**
 * API checks that need a build or a running server: secret containment in the
 * built client, and what the live proxy discloses.
 *
 * The first section is the important one. A leaked credential would show up as
 * nothing at all until someone read the bundle. The proxy exists solely so
 * ARGUS_KEY never reaches the browser, and exactly one thing protects it: the
 * variable is not prefixed VITE_. Rename it to VITE_ARGUS_KEY, or import
 * src/server/api.ts from client code, and the key ships to every visitor with no
 * warning from any tool. This test is that warning.
 *
 * The payload validator, the grid and ranking maths, and the proxy against a
 * stubbed upstream are unit tests beside the code: `pnpm run test`.
 *
 * Run: pnpm run build && node tools/verify-api.mjs [base-url]
 *
 * The live proxy section needs this project's own server answering at
 * `base-url` (default http://localhost:5173, or VERIFY_BASE). When it is not
 * there the section is skipped with the actual reason -- unless VERIFY_STRICT=1,
 * under which a section that could not run is a failure.
 *
 * CI must set VERIFY_STRICT=1. Without it these checks pass by never executing,
 * which is precisely how they behaved before: with nothing of ours on the port
 * the run printed "all checks passed" and exited 0, having tested none of the
 * disclosure invariants that are the reason this file exists.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, STRICT, describe, identify } from './base.mjs'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

// ---------------------------------------------------------------- secrets --
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

  // Read the real secret if present, so this catches an actual leak rather than
  // just the literal string "ARGUS_KEY".
  let key = null
  if (existsSync('.env')) {
    const m = readFileSync('.env', 'utf8').match(/^\s*ARGUS_KEY\s*=\s*(.+)$/m)
    if (m) key = m[1].trim().replace(/^["']|["']$/g, '')
  }
  check(
    'the real ARGUS_KEY value is not in dist/',
    key ? !text.includes(key) : true,
    key ? `checked ${files.length} files` : '(no .env; skipped the literal check)',
  )
  check('no bundled file names ARGUS_KEY', !text.includes('ARGUS_KEY'))
  check(
    'the upstream path /me/pixels stays server-side',
    !text.includes('me/pixels'),
    'client should only ever know /api/pixels',
  )
  check('the server module is not bundled into the client', !text.includes('X-API-Key'))
}

// ------------------------------------------------ what the proxy discloses --
// The naming lookup reads /me/usage/by-project, which is far more revealing
// than the pixel payload: absolute workingDir paths carrying a username and
// machine layout, machineId, projectId, per-project token counts and costUsd in
// the thousands. The proxy reduces all that to a name and a token count.
// Forwarding the raw object instead — an easy "just pass it through" change —
// would publish every one of those fields to any visitor who opens devtools.
//
// The raw usage field names stay forbidden even though tokens are now published
// deliberately: they only appear in a response that spread `...p.usage`, and
// that spread carries costUsd out with them. The proxy renames to in/out/cached
// precisely so a leak of the whole object cannot pass as the intended feature.
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
]
const ALLOWED_PROJECT_FIELDS = ['key', 'name', 'wonSeconds', 'tokens', 'other']
const ALLOWED_TOKEN_FIELDS = ['in', 'out', 'cached']

/**
 * Work out what is answering at BASE before asserting anything against it.
 *
 * The previous version fetched /api/pixels inside a try/catch and reported every
 * failure as "dev server not reachable". That message was capable of being
 * false, and was: with an unrelated app on port 5173 the fetch succeeded, the
 * body parsed, `the proxy discloses no path, machine or cost fields` was
 * evaluated against that app's response and PASSED, and the run only stopped
 * when `json.projects` came back undefined -- which was then reported as the
 * server being unreachable. A security assertion passing against a different
 * application is worse than one that does not run.
 *
 * `identify` in base.mjs settles which server it is. This adds the part specific
 * to these checks: whether that server is actually serving a payload.
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
      why: `our proxy is up but /api/pixels answered ${res.status}; ARGUS and ARGUS_KEY are probably unset`,
    }
  }

  let json
  try {
    json = JSON.parse(body)
  } catch {
    return { state: 'malformed', why: '/api/pixels did not return JSON' }
  }
  // Shape-checked here rather than inside the assertions, so a payload we cannot
  // read is reported as such instead of crashing an assertion and being caught
  // as a connection problem.
  if (!Array.isArray(json?.projects)) {
    return { state: 'malformed', why: '/api/pixels returned JSON with no projects array' }
  }
  return { state: 'live', body, json }
}

const proxy = await reachProxy()

if (proxy.state !== 'live') {
  // Deliberately a failure under STRICT rather than a note. These are the
  // checks the file exists for; silently not running them is the failure mode
  // this branch was written to remove.
  if (STRICT) {
    check('the live proxy checks ran', false, proxy.why)
  } else {
    console.log(`skip  live proxy checks - ${proxy.why}`)
    console.log('      (VERIFY_STRICT=1 makes this a failure; CI sets it)')
  }
} else {
  // Note the absence of a try/catch around the assertions themselves. If one of
  // these throws it is a real defect in the payload or in this file, and it
  // should surface as a crash rather than be swallowed as "server unreachable".
  const { body, json } = proxy
  const leaked = FORBIDDEN.filter((f) => body.includes(f))
  check(
    'the proxy discloses no path, machine or cost fields',
    leaked.length === 0,
    leaked.join(', '),
  )

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

  const named = json.projects.filter((p) => p.name).length
  check('hashes resolve to names', named > 0, `${named}/${json.projects.length} named`)

  const withTokens = json.projects.filter((p) => p.tokens)
  check(
    'projects carry token counts',
    withTokens.length > 0,
    `${withTokens.length}/${json.projects.length} counted`,
  )
  // `in` is the sum that includes cache reads, so cached can equal it but never
  // exceed it. If it does, the two numbers came from different fields and the
  // panel's "N% of input is cache reads" is above 100.
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
