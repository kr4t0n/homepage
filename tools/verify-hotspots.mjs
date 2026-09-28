/**
 * Hotspot verification. From the home camera, focuses each nav item in turn and
 * captures the emissive highlight, so it is unambiguous which physical object
 * each hotspot actually owns.
 *
 * Focus rather than hover: the index is hidden from a pointer and appears only
 * while a pill has keyboard focus, and focusing a pill drives the same hover
 * state that pointing at its object does. The revealed index is therefore in
 * every capture, bottom left.
 *
 * Run: node tools/verify-hotspots.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const ROOT = 'dist'
const OUT = 'tools/shots/hover'
mkdirSync(OUT, { recursive: true })

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
}

const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '')
  try {
    const buf = await readFile(join(ROOT, rel))
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(404).end('nope')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => {})
await page.waitForTimeout(2500)

const spots = await page.evaluate(() =>
  [...document.querySelectorAll('nav[aria-label="Places in the room"] button')].map((b) =>
    b.textContent?.trim(),
  ),
)

for (const [i, name] of spots.entries()) {
  // Focus only. No Enter, so the camera stays on the home framing and every
  // capture is directly comparable.
  await page.focus(`nav[aria-label="Places in the room"] button:nth-child(${i + 1})`)
  await page.waitForTimeout(700)
  await page.screenshot({
    path: `${OUT}/${String(i + 1).padStart(2, '0')}_${name.toLowerCase()}.png`,
  })
  console.log('hover', name)
}

await browser.close()
server.close()
