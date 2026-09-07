/**
 * Signals is one hotspot over two wall boards, and neither takes the hover wash.
 *
 * Two of these assertions are cheap because nav pills drive the same room hover
 * state that pointing at the object does (`Hud.tsx` calls `setHover` on
 * pointer enter), so the wash can be checked without hunting for the boards on
 * screen at all.
 *
 * The wash is read from the dev-only `__wash` hook rather than from pixels.
 * A screenshot cannot answer this: pointer parallax moves the camera, so two
 * frames taken with the pointer in different places differ almost everywhere,
 * and an early version of this test reported 158,000 changed pixels for a
 * hotspot that was not washed at all.
 *
 * Run against a dev server: npm run dev, then node tools/verify-boards.mjs
 */
import { chromium } from 'playwright'

/** Between the one-board and two-board measurements. See the sweep below. */
const SPAN_FLOOR = 150

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 120_000 })
await page.waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
await page.waitForTimeout(3000)

const pill = async (label) => {
  const b = page.locator('nav[aria-label="Places in the room"] button', { hasText: label }).first()
  await b.hover()
  await page.waitForTimeout(400)
  return page.evaluate(() => ({ hover: window.__hover?.(), wash: window.__wash?.() }))
}

const sig = await pill('Signals')
check('the Signals pill hovers the signals hotspot', sig.hover === 'signals', String(sig.hover))
check('neither wall board takes the hover wash', Array.isArray(sig.wash) && sig.wash.length === 0,
  JSON.stringify(sig.wash))

// The wash still has to work everywhere else, or this test would pass just as
// well if the highlight were broken outright.
const wri = await pill('Writing')
check('an ordinary prop still washes', Array.isArray(wri.wash) && wri.wash.length > 0,
  JSON.stringify(wri.wash))

// Both boards must pick. Sweep the band they hang in and collect the horizontal
// extent of the region that resolves to signals.
//
// Measured at 1440x900 on the home view: 130px (x 370..500) with only
// `hot_pixelboard` wired, 170px (x 370..540) with the ranking board too. The
// floor sits between those, so dropping either node fails rather than passing
// on the half that remains.
await page.mouse.move(1350, 860)
await page.waitForTimeout(300)
const hits = []
for (let y = 140; y <= 460; y += 20) {
  for (let x = 220; x <= 760; x += 12) {
    await page.mouse.move(x, y)
    if (await page.evaluate(() => window.__hover?.()) === 'signals') hits.push({ x, y })
  }
}
check('the boards are pickable in the room', hits.length > 0, `${hits.length} points`)
const xs = hits.map((h) => h.x)
const span = hits.length ? Math.max(...xs) - Math.min(...xs) : 0
check('the pickable region spans both boards', span > SPAN_FLOOR,
  `${span}px, x ${Math.min(...xs)}..${Math.max(...xs)}`)

// The far end of that region is the ranking board. It must open Signals too,
// which is the whole point of it sharing the hotspot.
const far = hits.filter((h) => h.x >= Math.max(...xs) - 12).pop()
await page.mouse.move(far.x, far.y)
await page.waitForTimeout(300)
await page.mouse.click(far.x, far.y)
await page.waitForTimeout(1600)
check('clicking the far board opens Signals', page.url().includes('#/signals'),
  `url=${page.url()} from (${far.x},${far.y})`)

check('no page errors', errors.length === 0, errors.join('; ').slice(0, 120))
console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : 'all checks passed'}`)
await browser.close()
process.exit(fails.length ? 1 : 0)
