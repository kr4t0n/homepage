/**
 * Draco decoder origin check.
 *
 * `room.glb` is Draco-compressed, and drei's `useGLTF` fetches the decoder from
 * Google's CDN unless told otherwise. That default is silent and easy to
 * reintroduce, and where gstatic is unreachable the room never appears. This
 * loads the built site and fails if the decoder came from anywhere but the
 * site's own origin, or if any request at all left it. The second assertion is
 * the stronger property: this page makes no third-party request today, and that
 * should stay a decision rather than drift.
 *
 * Run: npm run build && node tools/verify-draco.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const ROOT = 'dist'

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
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

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

/** Every http(s) request the page made, with the status it got back. */
const requests = new Map()
page.on('request', (r) => {
  if (/^https?:/.test(r.url())) requests.set(r.url(), null)
})
page.on('response', (r) => {
  if (requests.has(r.url())) requests.set(r.url(), r.status())
})

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
// The preloader is driven by real load progress and removes itself only once
// the GLB has been fetched *and* decoded, which is the step that needs Draco.
const loaded = await page
  .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
  .then(() => true, () => false)

check('the room loaded and the preloader dismissed itself', loaded)

const foreign = [...requests.keys()].filter((u) => !u.startsWith(`${BASE}/`))
check('no request left the origin', foreign.length === 0, foreign.join(' '))

for (const file of ['draco_wasm_wrapper.js', 'draco_decoder.wasm']) {
  const status = requests.get(`${BASE}/draco/${file}`)
  check(
    `${file} was fetched from /draco/ and served`,
    status === 200,
    status === undefined ? 'never requested' : `status ${status}`,
  )
}

await browser.close()
server.close()

if (fails.length) {
  console.log(`\n${fails.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
