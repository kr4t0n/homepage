/**
 * Keyboard reachability check.
 *
 * The neon wordmark links to GitHub, but a 3D click target cannot be tabbed to
 * or announced, so it can only ever be a redundant affordance. This asserts the
 * non-pointer routes still exist: tab through every place in the room to the
 * GitHub link at the end of the index, then open a hotspot and reach a real
 * anchor inside its panel. The link used to live in a Contact panel on the
 * sofa; when that went, the index became its only keyboard route, so it is
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
      inNav: !!el.closest('nav[aria-label="Places in the room"]'),
      inDialog: !!el.closest('[role="dialog"]'),
    }
  })

/** Press Tab (or Shift+Tab) until `match` accepts the focused element. */
const tabTo = async (match, { back = false, limit = 25 } = {}) => {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab')
    await page.waitForTimeout(90)
    const a = await active()
    if (a && match(a)) return a
  }
  return null
}

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

// Tab through the index to the GitHub link at its end. Every hotspot pill comes
// first, so the same walk proves the places in the room are reachable too.
const pills = new Set()
const github = await tabTo((a) => {
  if (a.tag === 'button' && a.inNav) pills.add(a.text)
  return a.tag === 'a' && a.inNav && a.href?.startsWith('https://github.com/kr4t0n')
})
check(pills.size > 0, `hotspot buttons are reachable by Tab alone (${[...pills].join(', ')})`)
check(github !== null, `GitHub is reachable by keyboard (${github?.href ?? 'not found'})`)

const shown = await navBox()
check(
  shown.w > 100 && shown.focusedOnScreen,
  `the index is visible while it has focus (${shown.w}x${shown.h})`,
)

// The link stands in for the neon sign, so focusing it lights the sign, the
// same way pointing at the sign does.
const lit = await page.evaluate(() => window.__hover?.())
check(lit === 'neon', `focusing the GitHub link lights the neon sign (hover=${lit})`)

// Back to a place, and open it with the keyboard.
const about = await tabTo((a) => a.tag === 'button' && a.text === 'About', { back: true })
check(about !== null, 'Shift+Tab walks back to a hotspot')
await page.keyboard.press('Enter')
await page.waitForTimeout(1600)
check(page.url().includes('#/about'), 'Enter opens the focused hotspot')

// Reach a real anchor inside the panel. About carries the Argus and nodex
// links, which the monitors otherwise hold behind a pointer.
const inPanel = await tabTo((a) => a.tag === 'a' && a.inDialog)
check(inPanel !== null, `a panel's links are reachable by keyboard (${inPanel?.href ?? 'not found'})`)

// Escape returns to the room.
await page.keyboard.press('Escape')
await page.waitForTimeout(1400)
check(!page.url().includes('#/'), 'Escape closes the panel')

if (failures) process.exitCode = 1
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
await browser.close()
