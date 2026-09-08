/**
 * Verifies the neon wordmark behaves as a link.
 *
 * Checks that hovering it announces the destination, that clicking opens
 * GitHub in a new tab, and that ending an orbit drag on it does not navigate.
 * That last one matters most: accidentally leaving the page is a worse failure
 * than accidentally opening a panel.
 *
 * Run against the dev server: node tools/verify-neon-link.mjs [url]
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { BASE, requireOurServer } from './base.mjs'

// Identify the target before launching a browser at it: aimed at a port
// something else owns, this would otherwise time out hunting for a canvas.
await requireOurServer()

const OUT = 'tools/shots/neon'
mkdirSync(OUT, { recursive: true })

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

let failures = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) failures++
}

/**
 * Hovered id, straight from the store.
 *
 * This used to scrape a hover readout out of the DOM. That readout has been
 * removed from the design, so the check now reads state through the dev-only
 * __hover handle instead of depending on visible chrome.
 */
const hovered = () => page.evaluate(() => window.__hover?.() ?? null)

const away = async () => {
  await page.mouse.move(300, 250)
  await page.waitForTimeout(300)
}

// Locate the sign by sweeping the upper right of the wall for the readout.
let target = null
for (let x = 1060; x <= 1200 && !target; x += 12) {
  for (let y = 250; y <= 340; y += 10) {
    await away()
    await page.mouse.move(x, y)
    await page.waitForTimeout(140)
    if ((await hovered()) === 'neon') {
      target = [x, y]
      break
    }
  }
}

if (!target) {
  console.log('FAIL could not find the sign by hovering; is it rendered?')
  await browser.close()
  process.exit(1)
}
console.log(`found sign at ${target[0]},${target[1]}`)
check(true, 'hovering the sign resolves to the GitHub link')

await page.mouse.move(target[0], target[1])
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/link_hover.png` })

check(
  (await page.evaluate(() => getComputedStyle(document.body).cursor)) === 'pointer',
  'cursor becomes a pointer over the sign',
)

// A plain click opens GitHub in a new tab.
const [popup] = await Promise.all([
  page.waitForEvent('popup', { timeout: 8000 }).catch(() => null),
  page.mouse.click(target[0], target[1]),
])
check(
  popup !== null && popup.url().startsWith('https://github.com/kr4t0n'),
  `click opens ${popup ? popup.url() : 'nothing'}`,
)
await popup?.close()

// The room must not have changed route behind the popup.
check(!page.url().includes('#/'), 'clicking the sign does not also open a panel')

// A drag that happens to end on the sign must not navigate.
await away()
let navigated = false
page.on('popup', () => {
  navigated = true
})
await page.mouse.move(target[0] - 150, target[1] + 90)
await page.mouse.down()
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(target[0] - 150 + (150 * i) / 12, target[1] + 90 - (90 * i) / 12)
  await page.waitForTimeout(16)
}
await page.mouse.up()
await page.waitForTimeout(1200)
check(!navigated, 'a drag ending on the sign does not navigate')

if (failures) process.exitCode = 1
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
await browser.close()
