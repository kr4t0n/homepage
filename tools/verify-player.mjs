/**
 * Player verification.
 *
 * The point of this harness is the autoplay policy, so Chromium is launched with
 * `--autoplay-policy=document-user-activation-required` rather than the headless
 * default, which is permissive enough to hide the exact bug we care about. Under
 * the strict policy the run proves the design: silent before any gesture,
 * playing after one, and stoppable at any time.
 *
 * Playback is asserted through the mini-player's own elapsed readout rather than
 * by reaching into the audio element. The element is created with `new Audio()`
 * and never enters the DOM, so the readout advancing is both the only handle
 * available in a production build and the thing a visitor actually sees.
 *
 * Run: node tools/verify-player.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const ROOT = 'dist'

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
}

let served = 0
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '')
  try {
    const buf = await readFile(join(ROOT, rel))
    if (rel.endsWith('.mp3')) served += 1
    // Range support: Chromium asks for byte ranges on media and will stall
    // forever against a server that answers 200 to every request.
    const range = req.headers.range
    if (range && rel.endsWith('.mp3')) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)
      const start = Number(m[1])
      const end = m[2] ? Number(m[2]) : buf.length - 1
      res.writeHead(206, {
        'content-type': 'audio/mpeg',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${buf.length}`,
        'content-length': end - start + 1,
      })
      res.end(buf.subarray(start, end + 1))
      return
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(rel)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
    })
    res.end(buf)
  } catch {
    res.writeHead(404).end('nope')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    // The whole point: behave like a real browser meeting a real visitor.
    '--autoplay-policy=document-user-activation-required',
    '--mute-audio',
  ],
})

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => {})
await page.waitForTimeout(1500)

/** Elapsed seconds as the mini-player reports them, or null if not mounted. */
const elapsedOn = async (p) => {
  const t = await p.textContent('[data-elapsed]').catch(() => null)
  if (!t) return null
  const [mm, ss] = t.split('/')[0].trim().split(':').map(Number)
  return mm * 60 + ss
}
const elapsed = () => elapsedOn(page)

// --- 1. Silent before any gesture -------------------------------------------
// Open the panel by URL, which is not a user activation, so the policy still
// applies and nothing should be advancing.
await page.goto(`${BASE}/#/player`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const before = await elapsed()
check('mini-player mounts from the URL', before !== null, `elapsed=${before}`)
await page.waitForTimeout(1800)
const stillBefore = await elapsed()
check(
  'silent until the visitor interacts',
  before === 0 && stillBefore === 0,
  `${before}s -> ${stillBefore}s`,
)

// The trap this guards against: the speaker used to render the stored intent,
// so it lit up as "sound is on" during the window before the browser allows
// any. Clicking the thing that is lying to you then wrote `off` to
// localStorage, permanently, and no amount of clicking the room brought it
// back. The control must report real sound, never intent.
const coldLabel = await page.getAttribute('button[aria-label^="Turn the music"]', 'aria-label')
check(
  'the speaker does not claim sound before there is any',
  coldLabel === 'Turn the music on',
  `label="${coldLabel}"`,
)

// --- 2. Track metadata is what content.ts says ------------------------------
const body = (await page.textContent('[role="dialog"]')) ?? ''
check('shows the track title', body.includes('A Moment Apart'))
check('shows the artist', body.includes('ODESZA'))

// --- 3. A gesture starts it -------------------------------------------------
// Press a key rather than click, to prove the arming is not tied to one event.
await page.keyboard.press('Space')
await page.waitForTimeout(2600)
const afterGesture = await elapsed()
check(
  'a gesture starts playback',
  afterGesture !== null && afterGesture > 0,
  `elapsed=${afterGesture}s`,
)
check('the mp3 was actually fetched', served > 0, `${served} request(s)`)

// --- 4. Progress is real ----------------------------------------------------
const t1 = await elapsed()
await page.waitForTimeout(2200)
const t2 = await elapsed()
check('playback progresses', t2 > t1, `${t1}s -> ${t2}s`)

// --- 5. Turning it off stops it, and the choice survives a reload -----------
await page.click('button[aria-label="Turn the music off"]')
// Longer than the 1.6s fade, so the pause has definitely landed.
await page.waitForTimeout(2400)
const m1 = await elapsed()
await page.waitForTimeout(1800)
const m2 = await elapsed()
check('turning it off halts playback', m1 === m2, `held at ${m1}s`)

const pressed = await page.getAttribute('button[aria-label="Turn the music on"]', 'aria-pressed')
check('the sound button reports its state', pressed === 'false', `aria-pressed=${pressed}`)

await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.keyboard.press('Space')
await page.waitForTimeout(2200)
const afterReload = await elapsed()
check(
  'the choice survives a reload',
  afterReload === 0,
  `elapsed=${afterReload}s after a gesture`,
)

// --- 6. Turning it back on resumes -----------------------------------------
await page.click('button[aria-label="Turn the music on"]')
await page.waitForTimeout(2600)
const un = await elapsed()
check('turning it back on resumes playback', un > 0, `elapsed=${un}s`)

// Leave the preference clean, or the next run starts muted.
await page.evaluate(() => window.localStorage.removeItem('kr4t0n:music'))

// --- 7. One press of the speaker is enough, from cold -----------------------
// A fresh context, not a reload: navigating the same tab keeps its user
// activation, so the track simply carries on playing and the assertions below
// would pass against a document that was never cold. This is the only way to
// get a document the browser genuinely does not trust yet.
const coldCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const cold = await coldCtx.newPage()
await cold.goto(`${BASE}/#/player`, { waitUntil: 'networkidle', timeout: 120_000 })
await cold
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => {})
await cold.waitForTimeout(1800)

const c0 = await elapsedOn(cold)
check('a genuinely cold visit starts silent', c0 === 0, `elapsed=${c0}s`)
const coldBtn = await cold.getAttribute('button[aria-label^="Turn the music"]', 'aria-label')
check('cold speaker offers to start, not to stop', coldBtn === 'Turn the music on', `label="${coldBtn}"`)
await cold.click('button[aria-label="Turn the music on"]')
await cold.waitForTimeout(2600)
const c1 = await elapsedOn(cold)
check('one press of the speaker starts it from cold', c1 > 0, `elapsed=${c1}s`)
await coldCtx.close()

// --- 8. A click on the room itself arms it ----------------------------------
// The headline behaviour is "interact with the room and music starts", but the
// gesture above is a keypress, which exercises a different listener. A visitor
// clicking the scene and getting silence is the exact confusion this guards
// against, so assert the pointer path separately, in its own fresh context.
const roomCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const room = await roomCtx.newPage()
await room.goto(`${BASE}/#/player`, { waitUntil: 'networkidle', timeout: 120_000 })
await room
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => {})
await room.waitForTimeout(1800)
check('room click: silent to begin with', (await elapsedOn(room)) === 0)
// Well clear of the panel and of the speaker button, i.e. bare scene.
await room.mouse.click(720, 250)
await room.waitForTimeout(2800)
const clicked = await elapsedOn(room)
check('clicking the room starts the music', clicked > 0, `elapsed=${clicked}s`)
await roomCtx.close()

// --- 9. The decks are reachable by clicking the object ---------------------
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await page.click('nav[aria-label="Places in the room"] button:has-text("Now playing")')
await page.waitForTimeout(2800)
check('nav opens the decks', page.url().includes('#/player'), page.url().split('/').pop())
await page.screenshot({ path: 'tools/shots/player.png' })

await browser.close()
server.close()

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : 'all checks passed'}`)
process.exit(fails.length ? 1 : 0)
