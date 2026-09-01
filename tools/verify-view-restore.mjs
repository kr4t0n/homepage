/**
 * Regression test: a tuned view must survive opening and closing a hotspot.
 *
 * Two assertions, in order of authority:
 *
 *  1. State. Reads the orbit offsets directly through the dev-only __orbit
 *     hook and requires them to come back exactly. This is the real contract.
 *  2. Pixels. Runs with reduced motion so the idle drift is off, then compares
 *     frames. Drift is a time-based sine, so without disabling it two frames
 *     seconds apart never match at high zoom, which says nothing about whether
 *     the view was restored.
 *
 * Run: node tools/verify-view-restore.mjs [url]
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = 'tools/shots/restore'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
// Reduced motion also exercises the instant-transition code path.
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
})
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message)))

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => console.log('! preloader stuck'))
await page.waitForTimeout(2500)

const readOrbit = () =>
  page.evaluate(() => {
    const h = window.__orbit
    return h ? { ...h.orbit } : null
  })

/** Mean absolute per-pixel difference, computed in the page. 0 = identical. */
const diff = (a, b) =>
  page.evaluate(
    ([x, y]) =>
      new Promise((resolve) => {
        const load = (src) =>
          new Promise((r) => {
            const i = new Image()
            i.onload = () => r(i)
            i.src = src
          })
        Promise.all([load(x), load(y)]).then(([ia, ib]) => {
          const w = 640
          const h = 400
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          const ctx = c.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(ia, 0, 0, w, h)
          const da = ctx.getImageData(0, 0, w, h).data
          ctx.clearRect(0, 0, w, h)
          ctx.drawImage(ib, 0, 0, w, h)
          const db = ctx.getImageData(0, 0, w, h).data
          let sum = 0
          for (let i = 0; i < da.length; i += 4) {
            sum +=
              Math.abs(da[i] - db[i]) +
              Math.abs(da[i + 1] - db[i + 1]) +
              Math.abs(da[i + 2] - db[i + 2])
          }
          resolve(sum / (w * h * 3))
        })
      }),
    [a, b],
  )

/**
 * Park the pointer over non-interactive geometry and drop keyboard focus, so a
 * frame captures camera pose only. Otherwise the diff is dominated by the hover
 * wash on whatever the drag finished over, and the focus ring on the nav button.
 */
const shot = async (name) => {
  await page.mouse.move(640, 110)
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.waitForTimeout(500)
  const buf = await page.screenshot({ path: `${OUT}/${name}.png` })
  return `data:image/png;base64,${buf.toString('base64')}`
}

const drag = async (dx, dy) => {
  await page.mouse.move(640, 380)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(640 + (dx * i) / 12, 380 + (dy * i) / 12)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(900)
}

let failures = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) failures++
}

const dflt = await shot('0_default')

// Tune the view well away from the default.
await drag(-260, -70)
await page.mouse.move(640, 380)
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(40)
}
await page.waitForTimeout(1200)
const tunedState = await readOrbit()
const tuned = await shot('1_tuned')

if (!tunedState) {
  console.log('FAIL __orbit hook missing (is this a dev server?)')
  process.exitCode = 1
} else {
  // Open a hotspot, then close it.
  await page.click('nav[aria-label="Places in the room"] button:nth-child(1)')
  await page.waitForTimeout(1800)
  const focusedState = await readOrbit()
  await shot('2_focused')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(2200)
  const restoredState = await readOrbit()
  const restored = await shot('3_restored')

  const near = (a, b) => Math.abs(a - b) < 1e-4
  check(
    near(focusedState.dTheta, 0) && near(focusedState.dPhi, 0) && near(focusedState.zoom, 1),
    'focused hotspot uses its authored framing',
  )
  check(
    near(restoredState.dTheta, tunedState.dTheta) &&
      near(restoredState.dPhi, tunedState.dPhi) &&
      near(restoredState.zoom, tunedState.zoom),
    `tuned view restored on close (dT ${tunedState.dTheta.toFixed(3)} z ${tunedState.zoom.toFixed(3)})`,
  )

  const dRestore = await diff(tuned, restored)
  const dControl = await diff(tuned, dflt)
  console.log(`  pixels: restored ${dRestore.toFixed(2)} vs control ${dControl.toFixed(2)}`)
  check(dRestore < dControl / 8, 'restored frame matches the tuned frame')

  await page.click('text=Reset view').catch(() => {})
  await page.waitForTimeout(1800)
  const afterReset = await readOrbit()
  const resetShot = await shot('4_after_reset')
  check(
    near(afterReset.dTheta, 0) && near(afterReset.dPhi, 0) && near(afterReset.zoom, 1),
    'reset returns to the default view',
  )
  check((await diff(resetShot, dflt)) < 1, 'reset frame matches the default frame')
}

if (errors.length) console.log(`\nERRORS:\n${[...new Set(errors)].join('\n')}`)
if (failures) process.exitCode = 1
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
await browser.close()
