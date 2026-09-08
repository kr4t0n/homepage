/**
 * Hover-highlight tuning sweep.
 *
 * Renders the same hovered object at several accent strengths so the value is
 * chosen against real frames instead of guessed. Writes a numbered set to
 * tools/shots/highlight/ plus an un-hovered reference.
 *
 * Run against the dev server: node tools/sweep-highlight.mjs [url]
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { BASE, requireOurServer } from './base.mjs'

// Identify the target before launching a browser at it: aimed at a port
// something else owns, this would otherwise time out hunting for a canvas.
await requireOurServer()

const OUT = 'tools/shots/highlight'
mkdirSync(OUT, { recursive: true })

// mix = how far the accent is blended into the material's own emissive.
// intensity = emissive floor for props that do not glow on their own.
const VARIANTS = [
  { mix: 1.0, intensity: 0.85, note: 'previous' },
  { mix: 0.7, intensity: 0.45 },
  { mix: 0.55, intensity: 0.3 },
  { mix: 0.4, intensity: 0.22 },
  { mix: 0.28, intensity: 0.15 },
]

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
})
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => {})
await page.waitForTimeout(2500)

const hasHook = await page.evaluate(() => !!window.__highlight)
if (!hasHook) {
  console.log('FAIL __highlight hook missing (dev server required)')
  await browser.close()
  process.exit(1)
}

// Hover the sofa directly in the canvas rather than via its nav pill: a large,
// mid-tone, non-emissive prop is the worst case for an accent wash, and going
// through the canvas exercises the same path a visitor does.
const SOFA = [470, 360]

const unhover = async () => {
  await page.mouse.move(1180, 640)
  await page.waitForTimeout(350)
}

await unhover()
await page.screenshot({ path: `${OUT}/0_none.png` })
console.log('captured reference (no hover)')

for (const [i, v] of VARIANTS.entries()) {
  await page.evaluate(
    ([mix, intensity]) => {
      window.__highlight.mix = mix
      window.__highlight.intensity = intensity
    },
    [v.mix, v.intensity],
  )
  // The paint runs in a hover-change effect, so re-trigger it.
  await unhover()
  await page.mouse.move(SOFA[0], SOFA[1])
  await page.waitForTimeout(600)
  const name = `${i + 1}_mix${String(v.mix).replace('.', '')}_int${String(v.intensity).replace('.', '')}`
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`captured mix=${v.mix} intensity=${v.intensity}${v.note ? ` (${v.note})` : ''}`)
}

await browser.close()
