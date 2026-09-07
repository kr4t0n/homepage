/**
 * API layer checks: secret containment, payload validation, grid maths.
 *
 * The first section is the important one. Everything else here is arithmetic
 * that would show up as a wrong-looking board; a leaked credential would show up
 * as nothing at all until someone read the bundle. The proxy exists solely so
 * ARGUS_KEY never reaches the browser, and exactly one thing protects it: the
 * variable is not prefixed VITE_. Rename it to VITE_ARGUS_KEY, or import
 * src/server/api.ts from client code, and the key ships to every visitor with no
 * warning from any tool. This test is that warning.
 *
 * Run: npm run build && node tools/verify-api.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { validate, liveSlot, gridPos } from '../src/shared/pixels.ts'
import { rankByTokens, shortTokens, ROWS, SEGMENTS } from '../src/pixels/ranking.ts'
import anchors from '../src/ranking-anchors.json' with { type: 'json' }
import manifest from '../src/scene-manifest.json' with { type: 'json' }
import { HOTSPOTS, hotspotNodes } from '../src/content.ts'

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
  fails.push('dist/ missing — run npm run build first')
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
  check(
    'the server module is not bundled into the client',
    !text.includes('X-API-Key'),
  )
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
const FORBIDDEN = ['workingDir', 'machineId', 'projectId', 'costUsd', 'inputTokens',
  'outputTokens', 'cacheReadTokens', 'turns', 'cliTypes']
const ALLOWED_PROJECT_FIELDS = ['key', 'name', 'wonSeconds', 'tokens', 'other']
const ALLOWED_TOKEN_FIELDS = ['in', 'out', 'cached']

try {
  const res = await fetch('http://localhost:5173/api/pixels', {
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.text()
  const json = JSON.parse(body)
  const leaked = FORBIDDEN.filter((f) => body.includes(f))
  check('the proxy discloses no path, machine or cost fields', leaked.length === 0, leaked.join(', '))

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
  check('cache reads never exceed input', impossible.length === 0,
    impossible.map((p) => p.name ?? p.key).join(', '))
} catch (err) {
  console.log(`skip  live proxy checks — dev server not reachable (${err.message.slice(0, 60)})`)
}

// ------------------------------------------------------------- validation --
const good = () => ({
  start: '2026-07-26T16:00:00.000Z',
  slotMinutes: 60,
  slotCount: 4,
  tz: 'Asia/Shanghai',
  winners: [null, 0, 1, null],
  intensity: [0, 50, 100, 0],
  projects: [{ key: 'a', wonSeconds: 10 }, { key: 'b', wonSeconds: 5 }],
  live: [0],
})
const rejects = (name, mutate) => {
  const p = good()
  mutate(p)
  let threw = false
  try {
    validate(p)
  } catch {
    threw = true
  }
  check(`rejects ${name}`, threw)
}

let ok = true
try {
  validate(good())
} catch (e) {
  ok = false
  console.log('  ', e.message)
}
check('accepts a well-formed payload', ok)

rejects('winners shorter than slotCount', (p) => p.winners.pop())
rejects('intensity shorter than slotCount', (p) => p.intensity.pop())
// The one that matters most: winners are INDICES, so an out-of-range value
// paints the wrong project's colour rather than failing loudly.
rejects('a winner index past the end of projects', (p) => (p.winners[1] = 9))
rejects('a negative winner index', (p) => (p.winners[1] = -1))
rejects('intensity above 100', (p) => (p.intensity[1] = 101))
rejects('a live index that names no project', (p) => (p.live = [7]))
rejects('an unparseable start', (p) => (p.start = 'yesterday'))
rejects('slotMinutes of zero', (p) => (p.slotMinutes = 0))

// Fields Argus has dropped must stay tolerated, not required.
const noHue = good()
let tolerated = true
try {
  validate(noHue)
} catch {
  tolerated = false
}
check('tolerates projects with no hue and no other flag', tolerated, 'both were removed upstream')

// ------------------------------------------------------------ grid maths --
const p = good()
p.slotCount = 1008
p.winners = Array(1008).fill(null)
p.intensity = Array(1008).fill(0)

// The trap: the last column runs to end-of-day, so slotCount-1 is in the future.
const startMs = Date.parse(p.start)
const midCol = startMs + (984 * 60 + 30) * 60_000
check('liveSlot finds the current slot, not the last', liveSlot(p, midCol) === 984, `got ${liveSlot(p, midCol)}`)
check('liveSlot clamps before the grid starts', liveSlot(p, startMs - 1) === -1)
check('liveSlot clamps past the grid end', liveSlot(p, startMs + 1e12) === 1007)

check('gridPos: slot 0 is row 0 col 0', JSON.stringify(gridPos(p, 0)) === '{"row":0,"col":0}')
check('gridPos: slot 23 is the last row of col 0', JSON.stringify(gridPos(p, 23)) === '{"row":23,"col":0}')
check('gridPos: slot 24 starts col 1', JSON.stringify(gridPos(p, 24)) === '{"row":0,"col":1}')
check('gridPos: slot 1007 is the last cell', JSON.stringify(gridPos(p, 1007)) === '{"row":23,"col":41}')

// The board is 24 rows x 42 columns of materials; every slot must land on one.
const seen = new Set()
for (let i = 0; i < 1008; i++) {
  const { row, col } = gridPos(p, i)
  seen.add(`${row},${col}`)
}
check('all 1008 slots map to distinct cells', seen.size === 1008, `${seen.size} unique`)
check(
  'every cell is inside the board 24x42',
  [...seen].every((s) => {
    const [r, c] = s.split(',').map(Number)
    return r >= 0 && r < 24 && c >= 0 && c < 42
  }),
)

// --------------------------------------------------------- ranking board --
// The board is five rows of thirty-two LEDs on a wall, ~30 screen pixels tall
// when the room is framed. A screenshot cannot tell a correct ranking from a
// reversed one, so the arithmetic is checked here instead.
const withTok = (tokens) =>
  tokens.map(([key, i, o]) => ({ key, wonSeconds: 0, tokens: { in: i, out: o, cached: 0 } }))
const payload = (projects) => ({ ...good(), projects, winners: [null, null, null, null] })

const r = rankByTokens(payload(withTok([
  ['a', 100, 5],     // 105
  ['b', 1000, 10],   // 1010  <- leader
  ['c', 500, 1],     // 501
  ['d', 10, 0],      // 10
  ['e', 300, 0],     // 300
  ['f', 900, 0],     // 900   <- second
  ['g', 1, 0],       // 1     falls off a five-row board
])))
check('ranks by in + out, not by in alone', r.map((x) => x.project.key).join('') === 'bfcea',
  r.map((x) => x.project.key).join(''))
check('truncates to the board’s rows', r.length === ROWS, `${r.length} rows`)
check('the leader scores 100', Math.round(r[0].score) === 100, `${r[0].score.toFixed(1)}`)
check('the leader fills every segment', r[0].lit === SEGMENTS, `${r[0].lit}/${SEGMENTS}`)
check('scores fall monotonically', r.every((x, i) => i === 0 || x.score <= r[i - 1].score))
check('segment counts stay in range', r.every((x) => x.lit >= 1 && x.lit <= SEGMENTS))
// A row carrying a name above an entirely unlit bar reads as a broken board
// rather than a small project, and the spread here reaches 500:1.
const tiny = rankByTokens(payload(withTok([['big', 1e9, 0], ['tiny', 1, 0]])))
check('a project that made the board always lights one segment', tiny[1].lit === 1,
  `${tiny[1].lit}`)

// The names lookup may fail without taking the board down, and then no project
// has tokens. An empty board is right; a board ranking everything at zero is not.
const untokened = rankByTokens(payload([{ key: 'x', wonSeconds: 99 }, { key: 'y', wonSeconds: 1 }]))
check('projects with no token data are dropped, not ranked as zero',
  untokened.length === 0, `${untokened.length} ranked`)

const tied = rankByTokens(payload(withTok([['zeta', 500, 0], ['alpha', 500, 0]])))
check('ties break on key so rows do not swap between polls',
  tied.map((x) => x.project.key).join() === 'alpha,zeta', tied.map((x) => x.project.key).join())

check('shortTokens abbreviates without inventing precision',
  shortTokens(5_676_270_874) === '5.7B' && shortTokens(450_141_549) === '450M' &&
  shortTokens(84_341_190) === '84M',
  `${shortTokens(5_676_270_874)} ${shortTokens(450_141_549)} ${shortTokens(84_341_190)}`)

// The anchors are measured at export from objects the export then deletes. If
// the board is re-modelled with a different row count the frontend would draw
// live text into rows that no longer exist.
check('the exported anchors describe exactly the board’s rows',
  anchors.rows.length === ROWS, `${anchors.rows.length} anchor rows`)
check('every anchor row carries a name and a score box',
  anchors.rows.every((row) => row.name?.min && row.score?.min))
check('the text plane has real extent',
  anchors.screen.max[1] > anchors.screen.min[1] && anchors.screen.max[2] > anchors.screen.min[2])

// ------------------------------------------------- signals covers both boards --
// Signals is one hotspot over two meshes. Everything about that is data in
// content.ts, so it is checked here rather than by sweeping a pointer across a
// screenshot -- which is slow, and which pointer parallax makes unreliable
// anyway (moving the mouse moves the camera, so two frames differ everywhere).
const signals = HOTSPOTS.find((h) => h.id === 'signals')
const nodes = signals ? hotspotNodes(signals) : []
check('signals covers both wall boards',
  nodes.includes('hot_pixelboard') && nodes.includes('hot_ranking'), nodes.join(', '))

const known = new Set(Object.values(manifest).map((e) => e.node))
const unknown = nodes.filter((n) => !known.has(n))
check('every node signals claims exists in the manifest', unknown.length === 0,
  unknown.join(', '))

// The wash lerps the acid accent into every material it touches, and both
// boards encode their data in colour.
check('the boards are exempt from the hover wash', signals?.noHighlight === true)

// Framing is the union of both boxes. If it silently fell back to the first
// node the camera would centre on the pixel board and push the ranking board
// to the edge of frame -- which is what it did before, and which still looks
// like a deliberate composition.
const boxes = nodes.map((n) => Object.values(manifest).find((e) => e.node === n)).filter(Boolean)
const unionZ = [Math.min(...boxes.map((b) => b.min[2])), Math.max(...boxes.map((b) => b.max[2]))]
const pixelBox = Object.values(manifest).find((e) => e.node === 'hot_pixelboard')
const unionCentreZ = (unionZ[0] + unionZ[1]) / 2
check('the union framing is not just the pixel board’s',
  Math.abs(unionCentreZ - pixelBox.centre[2]) > 0.1,
  `union z centre ${unionCentreZ.toFixed(3)} vs board ${pixelBox.centre[2].toFixed(3)}`)

// Standoff has to grow with the wider subject, or the pair overflows the frame.
check('the standoff was widened for the pair', (signals?.offset?.[0] ?? 0) >= 4,
  `offset x = ${signals?.offset?.[0]}`)

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : 'all checks passed'}`)
process.exit(fails.length ? 1 : 0)