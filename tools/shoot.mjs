/**
 * Screenshot harness. Serves dist/ from an in-process static server, loads it
 * in headless Chromium with a software WebGL context, waits for the GLB to
 * finish parsing, then captures the home view and each hotspot.
 *
 * Single foreground process: no detached server to leak.
 *
 * Run: node tools/shoot.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const ROOT = 'dist'
const OUT = 'tools/shots'
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
  '.jpeg': 'image/jpeg',
  // Chromium refuses to decode audio served as octet-stream, so the track has
  // to carry a real type here or every audio assertion fails for the wrong
  // reason.
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '')
  try {
    const buf = await readFile(join(ROOT, rel))
    res.writeHead(200, {
      'content-type': TYPES[extname(rel)] ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
    })
    res.end(buf)
  } catch {
    res.writeHead(404).end('not found')
  }
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
console.log('serving', ROOT, 'at', BASE)

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
})

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`))

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })

// The preloader only unmounts once the GLB has actually parsed.
await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .catch(() => console.log('! preloader still up after 120s'))

await page.waitForTimeout(3000)
await page.screenshot({ path: `${OUT}/00_home.png` })
console.log('shot 00_home')

const spots = await page.evaluate(() =>
  [...document.querySelectorAll('nav[aria-label="Places in the room"] button')].map(
    (b) => b.textContent?.trim() ?? '',
  ),
)
console.log('hotspots:', spots.join(', ') || '(none found)')

for (const [i, name] of spots.entries()) {
  await page.click(`nav[aria-label="Places in the room"] button:nth-child(${i + 1})`)
  await page.waitForTimeout(2400)
  await page.screenshot({
    path: `${OUT}/${String(i + 1).padStart(2, '0')}_${name.toLowerCase()}.png`,
  })
  console.log('shot', name)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1000)
}

await page.setViewportSize({ width: 500, height: 900 })
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/90_fallback.png`, fullPage: true })
console.log('shot fallback')

console.log(errors.length ? `\nCONSOLE ERRORS:\n${[...new Set(errors)].join('\n')}` : '\nno console errors')

await browser.close()
server.close()
