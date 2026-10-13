/**
 * Signals is one hotspot over two wall boards. Both must pick, the far one must
 * open Signals too, and focusing it opens no panel.
 *
 * Hover is read from `__hover`, not from pixels, since pointer parallax moves
 * the camera. The pill is focused rather than hovered: `Hud.tsx` sets hover on
 * focus, and the index takes no pointer events.
 *
 * Run against a dev server: pnpm run dev, then node tools/verify-boards.mjs [url]
 */
import { chromium } from 'playwright'
import { BASE, requireOurServer } from './base.mjs'

await requireOurServer()

/**
 * Pickable width in px at 1440x900 on the home view: ~130 for the pixel board
 * alone, ~170 for both, so losing either node fails.
 */
const SPAN_FLOOR = 150

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
})
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120_000 })
await page.waitForFunction(() => !document.querySelector('output'), { timeout: 120_000 })
await page.waitForTimeout(3000)

const sig = page
  .locator('nav[aria-label="Places in the room"] button', { hasText: 'Signals' })
  .first()
await sig.focus()
await page.waitForTimeout(400)
const sigHover = await page.evaluate(() => window.__hover?.())
check('the Signals pill hovers the signals hotspot', sigHover === 'signals', String(sigHover))

// Both boards must pick. Sweep the band they hang in and collect the horizontal
// extent of the region that resolves to signals.
await page.mouse.move(1350, 860)
await page.waitForTimeout(300)
const hits = []
for (let y = 140; y <= 460; y += 20) {
  for (let x = 220; x <= 760; x += 12) {
    await page.mouse.move(x, y)
    if ((await page.evaluate(() => window.__hover?.())) === 'signals') hits.push({ x, y })
  }
}
check('the boards are pickable in the room', hits.length > 0, `${hits.length} points`)
const xs = hits.map((h) => h.x)
const span = hits.length ? Math.max(...xs) - Math.min(...xs) : 0
check(
  'the pickable region spans both boards',
  span > SPAN_FLOOR,
  `${span}px, x ${Math.min(...xs)}..${Math.max(...xs)}`,
)

// The far end of that region is the ranking board, which must open Signals too.
const far = hits.filter((h) => h.x >= Math.max(...xs) - 12).pop()
await page.mouse.move(far.x, far.y)
await page.waitForTimeout(300)
await page.mouse.click(far.x, far.y)
await page.waitForTimeout(1600)
check(
  'clicking the far board opens Signals',
  page.url().includes('#/signals'),
  `url=${page.url()} from (${far.x},${far.y})`,
)

// Focused, the boards are the whole readout, so no panel opens. Counted by role,
// not by `.glass`, which PixelTooltip also carries.
const dialogs = await page.getByRole('dialog').count()
check('focusing the boards opens no panel', dialogs === 0, `${dialogs} dialog(s)`)

// The tooltip is the only place an individual hour can be read.
await page.mouse.move(500, 450)
await page.waitForTimeout(500)
const tip = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.glass')].find((n) => n.textContent?.trim())
  return el?.textContent?.trim().slice(0, 40) ?? null
})
check('hovering a cell still gives a readout', tip !== null, tip ?? 'nothing shown')

const exit = page.getByRole('button', { name: /back to the room/i })
check('a way back out is still on screen', await exit.isVisible())

// With no panel there is no close button to tab to, so Escape is the keyboard
// route out.
await page.keyboard.press('Escape')
await page.waitForTimeout(1400)
check('Escape leaves the focused boards', !page.url().includes('#/signals'), `url=${page.url()}`)

check('no page errors', errors.length === 0, errors.join('; ').slice(0, 120))
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : 'all checks passed'}`,
)
await browser.close()
process.exit(fails.length ? 1 : 0)
