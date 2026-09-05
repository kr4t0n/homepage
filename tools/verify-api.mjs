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

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : 'all checks passed'}`)
process.exit(fails.length ? 1 : 0)
