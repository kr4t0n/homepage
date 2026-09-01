/**
 * Neon brightness tuning sweep.
 *
 * Frames the sign the way the room actually presents it and captures a range of
 * strengths. Additive blending on a dark wall saturates far faster than it
 * looks like it should, so this is worth doing by eye rather than by guessing.
 *
 * Run against the dev server: node tools/sweep-neon.mjs [url]
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const OUT = 'tools/shots/neon'
mkdirSync(OUT, { recursive: true })

const VARIANTS = [
  { opacity: 1.0, light: 0.85, note: 'previous' },
  { opacity: 0.62, light: 0.5 },
  { opacity: 0.48, light: 0.4 },
  { opacity: 0.36, light: 0.3 },
  { opacity: 0.26, light: 0.22 },
]

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
})
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => {})
await page.waitForTimeout(2500)

if (!(await page.evaluate(() => !!window.__neon))) {
  console.log('FAIL __neon hook missing (dev server required)')
  await browser.close()
  process.exit(1)
}

// Push in on the upper right of the back wall, where the sign lives.
await page.evaluate(() => {
  // Zooming alone pushes the sign out of frame, because the orbit target stays
  // at the room centre. A small rotation brings the upper right wall back in.
  window.__orbit.orbit.zoom = 0.6
  window.__orbit.orbit.dTheta = -0.14
  window.__orbit.orbit.dPhi = 0.1
})
await page.mouse.move(1380, 860)
await page.waitForTimeout(2500)

for (const [i, v] of VARIANTS.entries()) {
  await page.evaluate(
    ([o, l]) => {
      window.__neon.opacity = o
      window.__neon.light = l
    },
    [v.opacity, v.light],
  )
  await page.waitForTimeout(700)
  const name = `${i + 1}_op${String(v.opacity).replace('.', '')}`
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`captured opacity=${v.opacity} light=${v.light}${v.note ? ` (${v.note})` : ''}`)
}

await browser.close()
