/**
 * Orbit verification. Drags left/right/up, zooms in and out, and checks that a
 * drag released over a hotspot does not open its panel.
 *
 * Run against the running dev server: node tools/verify-orbit.mjs [url]
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = 'tools/shots/orbit'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => console.log('! preloader stuck'))
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}/0_start.png` })

const cx = 640
const cy = 380

const drag = async (dx, dy, label) => {
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(cx + (dx * i) / 12, cy + (dy * i) / 12)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/${label}.png` })
  console.log('drag', label)
}

await drag(-320, 0, '1_drag_left')
await page.click('text=Reset view').catch(() => {})
await page.waitForTimeout(1400)

await drag(320, 0, '2_drag_right')
await page.click('text=Reset view').catch(() => {})
await page.waitForTimeout(1400)

await drag(0, -160, '3_drag_up')
await page.click('text=Reset view').catch(() => {})
await page.waitForTimeout(1400)

// Zoom in, then far out, to confirm the clamps hold.
await page.mouse.move(cx, cy)
for (let i = 0; i < 14; i++) {
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(40)
}
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/4_zoom_in.png` })
console.log('zoom in')

for (let i = 0; i < 30; i++) {
  await page.mouse.wheel(0, 120)
  await page.waitForTimeout(30)
}
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/5_zoom_out.png` })
console.log('zoom out')

// A drag that ends over an object must not open that object.
await page.click('text=Reset view').catch(() => {})
await page.waitForTimeout(1500)
const before = page.url()
await drag(-140, 40, '6_drag_no_open')
const after = page.url()
const fails = []
const check = (ok, pass, fail) => {
  console.log(ok ? `PASS ${pass}` : `FAIL ${fail}`)
  if (!ok) fails.push(pass)
}
check(after === before, 'drag did not open a panel', `drag opened ${after}`)

// A plain click on a nav pill must still work. The expected route comes from
// the pill itself rather than a hardcoded id: this asserted `#/work` from the
// first commit, Work was removed later, and because nothing here set an exit
// code the script printed FAIL and exited 0 for months.
const first = page.locator('nav[aria-label="Places in the room"] button').first()
const label = (await first.textContent())?.trim() ?? ''
await first.click()
await page.waitForTimeout(1800)
await page.screenshot({ path: `${OUT}/7_click_still_works.png` })
check(
  /#\/.+/.test(page.url()),
  `click on the first pill (${label}) opened ${page.url().split('#')[1]}`,
  `click on ${label} left url=${page.url()}`,
)

console.log(errors.length ? `\nERRORS:\n${[...new Set(errors)].join('\n')}` : '\nno console errors')
await browser.close()
if (fails.length) {
  console.log(`\n${fails.length} FAILED`)
  process.exit(1)
}
