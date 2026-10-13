/**
 * Player verification, under a real browser's autoplay policy: silent before
 * any gesture, playing after one, and stoppable at any time.
 *
 * Playback is read from the mini-player's elapsed readout: the element comes
 * from `new Audio()` and never enters the DOM, so the readout is the only
 * handle in a production build.
 *
 * It plays whatever `public/media/track.json` names, as built into dist/, and
 * expects that manifest's title and artist. With no track it fails rather than
 * skips, since every playback assertion would otherwise pass vacuously.
 *
 * Run: pnpm run build && node tools/verify-player.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'
import { captureDir } from './captures.mjs'

const ROOT = 'dist'
const MANIFEST_PATH = '/media/track.json'

const manifest = await readFile(join(ROOT, MANIFEST_PATH), 'utf8')
  .then(JSON.parse)
  .catch(() => null)
if (!manifest?.src || !manifest?.title || !manifest?.artist) {
  console.error(
    `FAIL  no usable ${ROOT}${MANIFEST_PATH}. Put a track and its track.json in public/media/ and rebuild; see README.`,
  )
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
}

let served = 0
/** Flipped on to simulate a manifest naming a cover that is not on the volume. */
let blockCover = false
/**
 * Replaces the manifest response: undefined serves the real file, null answers
 * 404 (the fresh-clone state), and an object is served as the manifest body.
 */
let manifestOverride
/** Every path requested, so a test can prove something was never fetched. */
const requested = []
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  requested.push(url)
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '')
  if (url === MANIFEST_PATH && manifestOverride !== undefined) {
    if (manifestOverride === null) res.writeHead(404).end('absent')
    else
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(manifestOverride))
    return
  }
  if (blockCover && manifest.cover && rel.endsWith(manifest.cover)) {
    res.writeHead(404).end('absent')
    return
  }
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
    // Named, not left to the build's default, since it decides what a missing
    // gesture does.
    '--autoplay-policy=document-user-activation-required',
    '--mute-audio',
  ],
})

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

const VIEWPORT = { width: 1440, height: 900 }
/**
 * Software GL under load takes minutes to bring up a fresh page, so every wait
 * that could only run out on a broken site gets this long rather than
 * Playwright's 30 s.
 */
const PATIENCE = 600_000
const PLAY_MARK = 'verify-player:play'

/**
 * A fresh context on `url`, returned once its player has attached and made its
 * first `play()` call. `firstPlay` is 'cold' if that call carried no user
 * activation, 'activated' if it did, and 'never' if it did not come.
 *
 * Nothing may query the page before that call. Playwright's Chromium driver
 * sends every query (`evaluate`, `waitForFunction`, `textContent`, `$`) with
 * CDP's `userGesture: true`, so one that lands first activates the page, lets
 * the call play, and makes a cold visit look like autoplay. The call is
 * reported on the console, which carries no gesture.
 */
const openFresh = async (url, options = {}) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT, ...options })
  ctx.setDefaultTimeout(PATIENCE)
  await ctx.addInitScript((mark) => {
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      console.debug(`${mark} ${navigator.userActivation.hasBeenActive}`)
      return play.call(this)
    }
  }, PLAY_MARK)
  const p = await ctx.newPage()
  const first = p
    .waitForEvent('console', {
      predicate: (m) => m.text().startsWith(PLAY_MARK),
      timeout: PATIENCE,
    })
    .then(
      (m) => (m.text().endsWith('false') ? 'cold' : 'activated'),
      () => 'never',
    )
  await p.goto(url, { waitUntil: 'networkidle', timeout: PATIENCE })
  const firstPlay = await first
  await p
    .waitForFunction(() => !document.querySelector('output'), null, { timeout: PATIENCE })
    .catch(() => {})
  return { ctx, p, firstPlay }
}

/**
 * Waits for `seconds` of GSAP time in `p`. GSAP's clock moves per animation
 * frame and counts a frame over 500 ms as 33 ms, so on a starved software
 * renderer the 1.6 s fade takes minutes and a wall-clock wait samples it
 * mid-flight. Every wait that follows a tween is measured here.
 */
const tweenTime = (p, seconds) =>
  p.evaluate(
    (ms) =>
      new Promise((resolve) => {
        let total = 0
        let last = performance.now()
        const tick = (now) => {
          const dt = Math.max(0, now - last)
          last = now
          total += dt > 500 ? 33 : dt
          if (total >= ms) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    seconds * 1000,
  )

/**
 * Waits `seconds` and at least three animation frames, so that a window in
 * which nothing may happen holds frames in which the page could have reacted:
 * a starved renderer can go ten seconds between two.
 */
const settle = (p, seconds) =>
  p.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const end = performance.now() + ms
        let frames = 0
        const tick = () => {
          frames += 1
          if (frames >= 3 && performance.now() >= end) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    seconds * 1000,
  )

const { p: page, firstPlay } = await openFresh(BASE)
await page.waitForTimeout(1500)

/** Elapsed seconds as the mini-player reports them, or null if not mounted. */
const elapsedOn = async (p) => {
  const t = await p.textContent('[data-elapsed]').catch(() => null)
  if (!t) return null
  const [mm, ss] = t.split('/')[0].trim().split(':').map(Number)
  return mm * 60 + ss
}
const elapsed = () => elapsedOn(page)

/**
 * Elapsed seconds once the readout passes `min`, or the reading after PATIENCE.
 * Playback starts when the decoder is ready, not on the script's schedule:
 * under load `play()` has taken two minutes to resolve.
 */
const elapsedPast = async (p, min) => {
  await p
    .waitForFunction(
      (min) => {
        const t = document.querySelector('[data-elapsed]')?.textContent
        if (!t) return false
        const [mm, ss] = t.split('/')[0].trim().split(':').map(Number)
        return mm * 60 + ss > min
      },
      min,
      { timeout: PATIENCE },
    )
    .catch(() => {})
  return elapsedOn(p)
}

// --- 1. Silent before any gesture -------------------------------------------
// Open the panel by URL, which is not a user activation, so the policy still
// applies and nothing should be advancing.
await page.goto(`${BASE}/#/player`, { waitUntil: 'domcontentloaded' })
await settle(page, 1.2)
const before = await elapsed()
check('mini-player mounts from the URL', before !== null, `elapsed=${before}`)
await settle(page, 1.8)
const stillBefore = await elapsed()
check(
  'silent until the visitor interacts',
  firstPlay === 'cold' && before === 0 && stillBefore === 0,
  `first play() ${firstPlay}, ${before}s -> ${stillBefore}s`,
)

// The speaker must render real sound, not stored intent: lit over silence, it
// invites the press that stores `off` for good.
const coldLabel = await page.getAttribute('button[aria-label^="Turn the music"]', 'aria-label')
check(
  'the speaker does not claim sound before there is any',
  coldLabel === 'Turn the music on',
  `label="${coldLabel}"`,
)

// --- 2. Track metadata is what the manifest says -----------------------------
const body = (await page.textContent('[role="dialog"]')) ?? ''
check('shows the title from the manifest', body.includes(manifest.title), manifest.title)
check('shows the artist from the manifest', body.includes(manifest.artist), manifest.artist)

// Presence alone is not enough: a 404 would remove the element via onError, and
// a wrong MIME type would leave it present but undecoded. naturalWidth proves
// the bytes arrived and decoded.
const art = await page.evaluate(() => {
  const img = document.querySelector('[role="dialog"] img')
  if (!img) return { present: false }
  return { present: true, w: img.naturalWidth, h: img.naturalHeight, alt: img.alt }
})
check('cover art is present and decoded', art.present && art.w > 0, JSON.stringify(art))
check('cover art is not announced twice', art.alt === '', `alt="${art.alt}"`)

/**
 * A fresh context on the decks with the current manifest override applied.
 *
 * Waits for the player to settle, meaning a transport or the no-track note has
 * rendered, rather than for a fixed time: software GL on a small box can take
 * well over a minute to bring a fresh page up. `settled` false is a failure in
 * its own right, never a pass by default.
 */
const decksWith = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(`${BASE}/#/player`, { waitUntil: 'domcontentloaded', timeout: PATIENCE })
  // The text is read in the same poll that sees the player settle, so a re-render
  // between two separate queries cannot turn a settled page into a timeout.
  const text = await p
    .waitForFunction(
      () => {
        const d = document.querySelector('[role="dialog"]')
        const done =
          d &&
          (d.querySelector('[data-elapsed]') || d.textContent.includes('No track is being served'))
        return done ? d.textContent : false
      },
      null,
      { timeout: PATIENCE },
    )
    .then(
      (h) => h.jsonValue(),
      () => null,
    )
  return { ctx, p, settled: text !== null, text: text ?? '' }
}

// --- 2b. No manifest is the fresh-clone state, reported honestly ------------
// The song is in neither git nor the image, so this is what a fresh clone, or a
// deploy without a media volume, sees.
manifestOverride = null
{
  const { ctx, p, settled, text } = await decksWith()
  check(
    'no manifest: the decks say no track is served',
    settled && text.includes('No track is being served'),
  )
  check('no manifest: no transport is rendered', (await p.$('[data-elapsed]')) === null)
  await ctx.close()
}

// --- 2c. A manifest cannot point outside /media -----------------------------
// Only bare file names beside the manifest are accepted, so an edited
// track.json cannot aim the audio element at another path or another origin.
manifestOverride = { ...manifest, src: '../room.glb' }
{
  const before = requested.length
  const { ctx, settled, text } = await decksWith()
  const strays = requested
    .slice(before)
    .filter((u) => u.includes('room.glb') && u.startsWith('/media'))
  check(
    'a traversal src is refused as no track',
    settled && text.includes('No track is being served'),
  )
  check('and the stray path is never requested', strays.length === 0, strays.join(' '))
  await ctx.close()
}
manifestOverride = { ...manifest, src: 'https://example.com/x.mp3' }
{
  const { ctx, settled, text } = await decksWith()
  check(
    'an absolute URL src is refused as no track',
    settled && text.includes('No track is being served'),
  )
  await ctx.close()
}
manifestOverride = undefined

// --- 3. A gesture starts it -------------------------------------------------
// Press a key rather than click, to prove the arming is not tied to one event.
await page.keyboard.press('Space')
const afterGesture = await elapsedPast(page, 0)
check(
  'a gesture starts playback',
  afterGesture !== null && afterGesture > 0,
  `elapsed=${afterGesture}s`,
)
check('the mp3 was actually fetched', served > 0, `${served} request(s)`)

// --- 4. Progress is real ----------------------------------------------------
const t1 = await elapsed()
const t2 = await elapsedPast(page, t1)
check('playback progresses', t2 > t1, `${t1}s -> ${t2}s`)

// --- 4b. The artwork spins, holds its angle when paused, and resumes from it -
// The angle-holding is the load-bearing part. A tween rebuilt on each state
// change would restart from 0, so this distinguishes "continues" from "resets
// and happens to be moving".
const angle = () =>
  page.evaluate(() => {
    const img = document.querySelector('[role="dialog"] img')
    if (!img) return null
    const t = getComputedStyle(img).transform
    if (!t || t === 'none') return 0
    const m = new DOMMatrixReadOnly(t)
    return Math.round(((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360)
  })

const s1 = await angle()
await tweenTime(page, 1.6)
const s2 = await angle()
check('the artwork spins while playing', s1 !== s2, `${s1}deg -> ${s2}deg`)

await page.click('button[aria-label^="Pause"]')
// Past the 1.6s fade-out, so `playing` has actually flipped false.
await tweenTime(page, 2.4)
const paused = (await page.$('button[aria-label^="Play"]')) !== null
const h1 = await angle()
await tweenTime(page, 1.3)
const h2 = await angle()
check(
  'the artwork holds its angle when paused',
  paused && h1 === h2,
  paused ? `held at ${h1}deg` : 'still playing after the fade',
)
check('it paused mid-turn rather than snapping back', h1 > 0, `${h1}deg`)

let r1 = null
if (paused) {
  await page.click('button[aria-label^="Play"]')
  await tweenTime(page, 1.3)
  r1 = await angle()
}
// Continuing advances a little from where it stopped. Restarting would jump to
// roughly 52deg (1.3s of a 9s turn) regardless of where it had been.
const advance = (r1 - h1 + 360) % 360
check(
  'it resumes from the held angle, not from zero',
  paused && advance > 5 && advance < 150,
  `${h1}deg -> ${r1}deg (advanced ${advance}deg)`,
)

// --- 4c. Reduced motion means no spin at all --------------------------------
const { ctx: rmCtx, p: rm } = await openFresh(`${BASE}/#/player`, { reducedMotion: 'reduce' })
await rm.keyboard.press('Space')
const rmPlayed = await elapsedPast(rm, 0)
const rmAngle = async () =>
  rm.evaluate(() => {
    const img = document.querySelector('[role="dialog"] img')
    const t = img ? getComputedStyle(img).transform : 'none'
    if (!t || t === 'none') return 0
    const m = new DOMMatrixReadOnly(t)
    return Math.round(((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360)
  })
const rm1 = await rmAngle()
await tweenTime(rm, 1.6)
const rm2 = await rmAngle()
check('reduced motion: the artwork does not spin', rm1 === 0 && rm2 === 0, `${rm1}deg/${rm2}deg`)
check('reduced motion: the track still plays', rmPlayed > 0)
await rmCtx.close()

// --- 5. Turning it off stops it, and the choice survives a reload -----------
await page.click('button[aria-label="Turn the music off"]')
// Longer than the 1.6s fade, so the pause has definitely landed.
await tweenTime(page, 2.4)
const m1 = await elapsed()
await settle(page, 1.8)
const m2 = await elapsed()
check('turning it off halts playback', m1 === m2, `held at ${m1}s`)

const pressed = await page.getAttribute('button[aria-label="Turn the music on"]', 'aria-pressed')
check('the sound button reports its state', pressed === 'false', `aria-pressed=${pressed}`)

await page.reload({ waitUntil: 'networkidle' })
// The transport renders once the player has attached, so the gesture below
// reaches armed listeners rather than a page still loading.
await page.waitForSelector('[data-elapsed]')
await settle(page, 1.5)
await page.keyboard.press('Space')
await settle(page, 2.2)
const afterReload = await elapsed()
check('the choice survives a reload', afterReload === 0, `elapsed=${afterReload}s after a gesture`)

// --- 6. Turning it back on resumes -----------------------------------------
await page.click('button[aria-label="Turn the music on"]')
const un = await elapsedPast(page, 0)
check('turning it back on resumes playback', un > 0, `elapsed=${un}s`)

// Leave the preference clean, or the next run starts muted.
await page.evaluate(() => window.localStorage.removeItem('kr4t0n:music'))

// --- 7. One press of the speaker is enough, from cold -----------------------
// A fresh context, not a reload, so no stored choice or earlier activation can
// carry over into a document that should be cold.
const { ctx: coldCtx, p: cold, firstPlay: coldPlay } = await openFresh(`${BASE}/#/player`)
await settle(cold, 1.8)

const c0 = await elapsedOn(cold)
check(
  'a genuinely cold visit starts silent',
  coldPlay === 'cold' && c0 === 0,
  `first play() ${coldPlay}, elapsed=${c0}s`,
)
const coldBtn = await cold.getAttribute('button[aria-label^="Turn the music"]', 'aria-label')
check(
  'cold speaker offers to start, not to stop',
  coldBtn === 'Turn the music on',
  `label="${coldBtn}"`,
)
let c1 = null
if (coldBtn === 'Turn the music on') {
  await cold.click('button[aria-label="Turn the music on"]')
  c1 = await elapsedPast(cold, 0)
}
check('one press of the speaker starts it from cold', c1 > 0, `elapsed=${c1}s`)
await coldCtx.close()

// --- 8. A click on the room itself arms it ----------------------------------
// Section 3's gesture is a keypress; a click on the scene goes through a
// different listener, so the pointer path gets its own fresh context.
const { ctx: roomCtx, p: room, firstPlay: roomPlay } = await openFresh(`${BASE}/#/player`)
await settle(room, 1.8)
const r0 = await elapsedOn(room)
check(
  'room click: silent to begin with',
  roomPlay === 'cold' && r0 === 0,
  `first play() ${roomPlay}, elapsed=${r0}s`,
)
// Well clear of the panel and of the speaker button, i.e. bare scene.
await room.mouse.click(720, 250)
const clicked = await elapsedPast(room, 0)
check('clicking the room starts the music', clicked > 0, `elapsed=${clicked}s`)
await roomCtx.close()

// --- 9. A missing cover degrades to no artwork, not a broken frame ----------
// A manifest can name a cover that is not on the volume. A 404'd <img> that
// stayed in the DOM would render a broken-image glyph in the middle of the bar.
blockCover = true
const { ctx: bareCtx, p: bare } = await openFresh(`${BASE}/#/player`)
// The cover renders with the transport, and goes once its request has failed.
await bare.waitForSelector('[data-elapsed]').catch(() => {})
const noImage = await bare
  .waitForFunction(() => !document.querySelector('[role="dialog"] img'), null, {
    timeout: PATIENCE,
  })
  .then(
    () => true,
    () => false,
  )
check('a missing cover removes the image entirely', noImage)
const bareBody = (await bare.textContent('[role="dialog"]')) ?? ''
check(
  'the bar still works without artwork',
  bareBody.includes(manifest.title) && (await bare.$('[data-elapsed]')) !== null,
)
await bareCtx.close()
blockCover = false

// --- 10. The decks are reachable from the keyboard index --------------------
// The index is hidden from a pointer and appears only while a pill has focus,
// so this is the route a keyboard visitor takes.
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await page.press('nav[aria-label="Places in the room"] button:has-text("Now playing")', 'Enter')
await page.waitForFunction(() => location.hash === '#/player').catch(() => {})
check(
  'the keyboard index opens the decks',
  page.url().includes('#/player'),
  page.url().split('/').pop(),
)
await page.screenshot({ path: join(captureDir(), 'player.png') })

await browser.close()
server.close()

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : 'all checks passed'}`,
)
process.exit(fails.length ? 1 : 0)
