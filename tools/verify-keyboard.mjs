/**
 * Keyboard reachability check.
 *
 * The neon wordmark links to GitHub, but a 3D click target cannot be tabbed to
 * or announced, so it can only ever be a redundant affordance. This asserts the
 * non-pointer route still exists: tab to a hotspot, open it, and reach a real
 * anchor. Removing the header link made this the last such route, so it is
 * worth a test rather than an assumption.
 *
 * The hotspot index is also the one piece of chrome that is hidden from a
 * pointer on purpose: the room is left unlabelled so it can be explored, and the
 * index appears only while a pill has keyboard focus. Both halves are asserted.
 * Hidden at rest, or the room is labelled again; visible once focused, or a
 * keyboard visitor is tabbing through buttons nobody can see.
 *
 * Run against the dev server: node tools/verify-keyboard.mjs [url]
 */
import { chromium } from 'playwright'
import { BASE, requireOurServer } from './base.mjs'

// Identify the target before launching a browser at it: aimed at a port
// something else owns, this would otherwise time out hunting for a canvas.
await requireOurServer()


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

/** Rendered size of the hotspot index, and whether the focused pill is on screen. */
const navBox = () =>
  page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Places in the room"]')
    const r = nav?.getBoundingClientRect()
    const f = document.activeElement?.closest('nav') === nav
      ? document.activeElement.getBoundingClientRect()
      : null
    return {
      w: r ? Math.round(r.width) : null,
      h: r ? Math.round(r.height) : null,
      focusedOnScreen:
        f !== null && f.width > 1 && f.top >= 0 && f.bottom <= innerHeight && f.left >= 0,
    }
  })

const rest = await navBox()
check(
  rest.w !== null && rest.w <= 1 && rest.h <= 1,
  `the hotspot index is hidden until focused (${rest.w}x${rest.h})`,
)

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

const shown = await navBox()
check(
  shown.w > 100 && shown.focusedOnScreen,
  `the index is visible while a pill has focus (${shown.w}x${shown.h})`,
)

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
