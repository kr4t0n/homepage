/**
 * Hotspot verification: which physical objects does each hotspot own?
 *
 * The exporter tags objects into groups by hand-authored world-space boxes, and
 * a box catches whatever is inside it, so a region's name is not evidence of its
 * contents. This tints every mesh one hotspot owns, from the home camera, and
 * writes one capture per hotspot to tools/shots/hover/, so it is unambiguous
 * which physical object each hotspot actually is.
 *
 * The room has no hover highlight of its own, so the tint is applied here,
 * through the dev-only `__room` handle. Each owned mesh gets a temporary lit
 * copy of its material, and the originals go back before the next hotspot.
 * Copies rather than edits, because the asset shares materials between props:
 * lighting a material in place would also light objects the hotspot does not
 * own, which is exactly the mistake this tool exists to catch.
 *
 * Run against the dev server: node tools/verify-hotspots.mjs [url]
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { BASE, requireOurServer } from './base.mjs'

// Identify the target before launching a browser at it: aimed at a port
// something else owns, this would otherwise time out hunting for a canvas.
await requireOurServer()

const OUT = 'tools/shots/hover'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
// Reduced motion so the camera holds still and every capture shares a frame.
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => {})
await page.waitForTimeout(2500)
// Bare background, so the pointer is over nothing.
await page.mouse.move(40, 780)

const ids = await page.evaluate(() =>
  window.__room ? [...new Set(window.__room.nodeToId.values())] : null,
)
if (!ids) {
  console.log('FAIL __room hook missing (dev server required)')
  await browser.close()
  process.exit(1)
}

let failures = 0
for (const [i, id] of ids.entries()) {
  const tinted = await page.evaluate((id) => {
    const { root, nodeToId } = window.__room
    const nodes = [...nodeToId].filter(([, owner]) => owner === id).map(([node]) => node)
    const swapped = []
    const lit = (m) => {
      const c = m.clone()
      c.emissive?.set('#9ef01a')
      if ('emissiveIntensity' in c) c.emissiveIntensity = 0.9
      return c
    }
    for (const name of nodes) {
      root.getObjectByName(name)?.traverse((o) => {
        if (!o.isMesh) return
        swapped.push([o, o.material])
        o.material = Array.isArray(o.material) ? o.material.map(lit) : lit(o.material)
      })
    }
    window.__untint = () =>
      swapped.forEach(([o, original]) => {
        ;[o.material].flat().forEach((c) => c.dispose())
        o.material = original
      })
    return { nodes, meshes: swapped.length }
  }, id)

  if (tinted.meshes === 0) {
    console.log(`FAIL ${id}: no meshes found under ${tinted.nodes.join(', ') || '(no nodes)'}`)
    failures++
    continue
  }
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${String(i + 1).padStart(2, '0')}_${id}.png` })
  await page.evaluate(() => window.__untint())
  console.log(`tinted ${id}: ${tinted.meshes} mesh(es) under ${tinted.nodes.join(', ')}`)
}

await browser.close()
if (failures) process.exit(1)
