/**
 * Keyboard reachability check.
 *
 * The neon wordmark links to GitHub, but a 3D click target cannot be tabbed to
 * or announced, so it can only ever be a redundant affordance. This asserts the
 * non-pointer route still exists: tab to a hotspot, open it, and reach a real
 * anchor. Removing the header link made this the last such route, so it is
 * worth a test rather than an assumption.
 *
 * Run against the dev server: node tools/verify-keyboard.mjs [url]
 */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:5173'

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

const active = () =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return null
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim().slice(0, 40),
      href: el.getAttribute('href'),
    }
  })

// Tab until a hotspot button takes focus, proving the room is enterable
// without a pointer.
let reachedNav = false
for (let i = 0; i < 20 && !reachedNav; i++) {
  await page.keyboard.press('Tab')
  await page.waitForTimeout(90)
  const a = await active()
  if (a?.tag === 'button' && a.text === 'Contact') reachedNav = true
}
check(reachedNav, 'a hotspot button is reachable by Tab alone')

// Open it with the keyboard.
await page.keyboard.press('Enter')
await page.waitForTimeout(1600)
check(page.url().includes('#/contact'), 'Enter opens the focused hotspot')

// Reach a real GitHub anchor inside the panel.
let githubHref = null
for (let i = 0; i < 25 && !githubHref; i++) {
  await page.keyboard.press('Tab')
  await page.waitForTimeout(90)
  const a = await active()
  if (a?.tag === 'a' && a.href?.startsWith('https://github.com/kr4t0n')) {
    githubHref = a.href
  }
}
check(githubHref !== null, `GitHub is reachable by keyboard (${githubHref ?? 'not found'})`)

// Escape returns to the room.
await page.keyboard.press('Escape')
await page.waitForTimeout(1400)
check(!page.url().includes('#/'), 'Escape closes the panel')

if (failures) process.exitCode = 1
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
await browser.close()
