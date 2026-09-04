/**
 * Verifies the two-stage monitor interaction.
 *
 * Each screen is independently pickable; the first click frames it and opens no
 * panel; a second click on a screen with a link opens that link; a drag ending
 * on a screen does neither. The staging is the whole point, so the negative
 * cases matter as much as the positive ones.
 *
 * Run against the dev server: node tools/verify-screens.mjs [url]
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = 'tools/shots/screens'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
})
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => {})
await page.waitForTimeout(2500)

let failures = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) failures++
}

/**
 * Hovered id, straight from the store. Previously scraped from a hover readout
 * in the DOM, which no longer exists.
 */
const hovered = () => page.evaluate(() => window.__hover?.() ?? null)

const away = async () => {
  await page.mouse.move(250, 220)
  await page.waitForTimeout(250)
}

/** Sweep the desk area for the screen with the given id. */
const find = async (id) => {
  for (let x = 620; x <= 1180; x += 14) {
    for (let y = 250; y <= 350; y += 12) {
      await away()
      await page.mouse.move(x, y)
      await page.waitForTimeout(110)
      if ((await hovered()) === id) return [x, y]
    }
  }
  return null
}

const nodex = await find('nodex')
check(nodex !== null, `left monitor is pickable and announces nodex ${nodex ?? ''}`)
if (!nodex) {
  await browser.close()
  process.exit(1)
}

const centre = await find('centre')
check(centre !== null, `centre monitor is independently pickable ${centre ?? ''}`)

// First click frames it, and opens no panel.
await away()
await page.mouse.click(nodex[0], nodex[1])
await page.waitForTimeout(2000)
await page.screenshot({ path: `${OUT}/1_framed.png` })
check(page.url().includes('#/screen/nodex'), `first click frames the screen (${page.url().split('/').pop()})`)
check(
  (await page.locator('[role="dialog"]').count()) === 0,
  'no panel opens for a monitor',
)
check(
  (await page.locator('text=Back to the room').count()) === 1,
  'framed screen offers a way back',
)

// Second click on the framed screen opens the link. The screen now fills the
// frame, so the centre of the viewport is over it.
const [popup] = await Promise.all([
  page.waitForEvent('popup', { timeout: 8000 }).catch(() => null),
  page.mouse.click(720, 450),
])
check(
  popup !== null && popup.url().startsWith('https://nodex.kubitnodes.com'),
  `second click opens ${popup ? popup.url() : 'nothing'}`,
)
await popup?.close()

// Escape returns to the room.
await page.keyboard.press('Escape')
await page.waitForTimeout(1800)
check(!page.url().includes('#/'), 'Escape leaves the framed screen')
await page.screenshot({ path: `${OUT}/2_back.png` })

// A drag ending on a screen must not frame it.
await away()
const before = page.url()
await page.mouse.move(nodex[0] - 170, nodex[1] + 110)
await page.mouse.down()
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(nodex[0] - 170 + (170 * i) / 12, nodex[1] + 110 - (110 * i) / 12)
  await page.waitForTimeout(16)
}
await page.mouse.up()
await page.waitForTimeout(1200)
check(page.url() === before, 'a drag ending on a screen does not frame it')

// Every screen that carries a link must open it from the framed state. Reached
// by deep link rather than by hunting for coordinates: framing is what the
// block above already covers, and this keeps the link assertion deterministic.
const LINKED = [
  ['nodex', 'https://nodex.kubitnodes.com'],
  ['centre', 'https://kr4t0n.github.io/argus'],
]
for (const [id, href] of LINKED) {
  await page.goto(`${BASE}/#/screen/${id}`, { waitUntil: 'networkidle' })

  // Wait for the condition, not for a duration. A fixed sleep was enough for
  // the first screen and not the second, because the flight between two screens
  // is longer than the flight in from the home view, so the click landed while
  // the camera was still moving and missed.
  let settled = false
  for (let i = 0; i < 40 && !settled; i++) {
    await page.mouse.move(705, 445)
    await page.waitForTimeout(150)
    settled = (await hovered()) === id
  }
  check(settled, `${id} is under the pointer once framed`)

  // Record the window.open call rather than wait for a real popup. Chromium
  // rate-limits popups per page, and two real ones have already fired above, so
  // a third would be blocked for reasons that say nothing about our code. The
  // genuine end-to-end popup is covered once, earlier in this file.
  await page.evaluate(() => {
    window.__opened = []
    window.open = (url) => {
      window.__opened.push(String(url))
      return null
    }
  })
  await page.mouse.move(1420, 880)
  await page.waitForTimeout(200)
  await page.mouse.click(705, 445)
  await page.waitForTimeout(400)
  const opened = await page.evaluate(() => window.__opened ?? [])
  check(
    opened.some((u) => u.startsWith(href)),
    `${id} opens ${opened.length ? opened.join(', ') : 'nothing'}`,
  )
}

// Back to the room for the remaining checks.
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2400)

// The Work panel used to be asserted here, as the only keyboard route to the
// project links. It has been removed — the monitors carry those projects and are
// the real presentation — so what has to hold now is that the links did not
// vanish with it. The monitors are raycast targets with no tabIndex, so About
// carries them for anyone not using a pointer.
await page.goto(`${BASE}/#/about`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2200)
const links = await page.evaluate(() =>
  [...document.querySelectorAll('[role="dialog"] a')].map((a) => a.getAttribute('href')),
)
check(
  links.some((h) => h?.includes('kr4t0n.github.io/argus')),
  `Argus stays reachable without a pointer (${links.length} links in About)`,
)
check(
  links.some((h) => h?.includes('nodex.kubitnodes.com')),
  'nodex stays reachable without a pointer',
)

if (errors.length) console.log(`\nERRORS:\n${[...new Set(errors)].join('\n')}`)
if (failures) process.exitCode = 1
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
await browser.close()
