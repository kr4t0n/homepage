/**
 * Glass contrast gate.
 *
 * The frosted panels are only legible because three values were tuned together
 * against measurement: the scrim opacity, the glass fill, and --color-mute.
 * Nudging any one of them can drop text under WCAG AA with no visible warning,
 * because the failure only appears in front of the room's bright surfaces — the
 * hexagon light wall behind the Work panel is the worst case, and it is off
 * screen when the panel is closed. Before this test existed, body text measured
 * 2.22:1 there and nobody could have noticed by looking.
 *
 * Method: open each panel, hide its contents so only the composited glass
 * surface remains, screenshot it, and find the brightest tile — that is the
 * worst backdrop any glyph in that panel could sit on. Then check every text
 * role against it.
 *
 * Pixel decoding happens inside the page: Node has no PNG decoder, so the shot
 * is handed back to the browser, drawn to a canvas and read with getImageData.
 * That keeps this dependency-free.
 *
 * Run: npm run build && node tools/verify-glass.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
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
    const buf = await readFile(join('dist', rel))
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

/** Text roles as authored in index.css. Keep in sync with @theme. */
const ROLES = {
  body: [182, 192, 214], // --color-body
  mute: [139, 152, 182], // --color-mute
  bright: [238, 242, 251], // --color-bright
}

/**
 * Every routable panel, by hotspot *id* — not by panel kind, which is what
 * `stats` is. Must match the ids in HOTSPOTS in src/content.ts; `signals` is
 * included even though it is `unverified` and hidden from the room, because it
 * is still reachable by URL and so still has to be legible.
 */
const PANELS = ['work', 'music', 'player', 'writing', 'about', 'cv', 'contact', 'signals']

const AA = 4.5

const fails = []
const rows = []

for (const id of PANELS) {
  await page.goto(`${BASE}/#/${id}`, { waitUntil: 'networkidle', timeout: 120_000 })
  await page
    .waitForFunction(() => !document.querySelector('[role="status"]'), { timeout: 120_000 })
    .catch(() => {})
  // Long enough for the camera flight to land. Measuring early samples the
  // *home* view through the glass, which is brighter than the hotspot framing,
  // and produced failures that no amount of CSS would have fixed. Note the room
  // also drifts continuously, so a run near the threshold is inherently noisy —
  // the values are tuned to leave margin rather than to scrape past 4.5:1.
  await page.waitForTimeout(3800)

  const dialog = page.locator('[role="dialog"]')
  if ((await dialog.count()) === 0) {
    fails.push(`${id}: no panel opened`)
    continue
  }

  // Keep the box and the glass, drop the content, so what is left is exactly
  // the surface a glyph would be drawn onto.
  await page.evaluate(() => {
    for (const c of document.querySelector('[role="dialog"]').children) {
      c.style.visibility = 'hidden'
    }
  })
  await page.waitForTimeout(350)

  const box = await dialog.boundingBox()
  const shot = (await page.screenshot({ clip: box })).toString('base64')

  const measured = await page.evaluate(
    async ([b64, roles, threshold]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.naturalWidth
      cv.height = img.naturalHeight
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height)

      const lin = (c) => {
        const v = c / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

      // Brightest 8x8 average, sampled on a grid. Averaging rather than taking
      // a single pixel avoids failing on one stray anti-aliased dot, while still
      // catching a genuinely bright region behind a line of text.
      // Inset past the decorative edge. The border, the inset rim light and the
      // specular sheen are all bright and all within ~3px of the boundary, and
      // no glyph ever lands there — every panel has at least 16px of padding.
      // Sampling from the boundary measured the chrome instead of the backdrop,
      // and only started failing when the fill dropped far enough that the rim
      // became the brightest thing in the frame. Measure where text can be.
      const PAD = 16
      let worst = null
      const T = 8
      for (let y = PAD; y + T < height - PAD; y += 6) {
        for (let x = PAD; x + T < width - PAD; x += 6) {
          let r = 0, g = 0, bl = 0
          for (let dy = 0; dy < T; dy++) {
            for (let dx = 0; dx < T; dx++) {
              const i = ((y + dy) * width + (x + dx)) * 4
              r += data[i]; g += data[i + 1]; bl += data[i + 2]
            }
          }
          const n = T * T
          const avg = [Math.round(r / n), Math.round(g / n), Math.round(bl / n)]
          if (!worst || lum(avg) > lum(worst)) worst = avg
        }
      }

      const ratio = (fg, bg) => {
        const a = lum(fg), b = lum(bg)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      }
      const out = { worst, roles: {}, pass: true }
      for (const [name, rgb] of Object.entries(roles)) {
        const r = ratio(rgb, worst)
        out.roles[name] = Math.round(r * 100) / 100
        if (r < threshold) out.pass = false
      }
      return out
    },
    [shot, ROLES, AA],
  )

  rows.push({ id, ...measured })
  if (!measured.pass) {
    const under = Object.entries(measured.roles).filter(([, r]) => r < AA)
    fails.push(`${id}: ${under.map(([n, r]) => `${n} ${r}:1`).join(', ')} under ${AA}:1`)
  }
}

console.log(`\n${'panel'.padEnd(9)}${'worst backdrop'.padEnd(18)}${Object.keys(ROLES).map((r) => r.padStart(8)).join('')}`)
for (const r of rows) {
  const cells = Object.keys(ROLES).map((k) => String(r.roles[k]).padStart(8)).join('')
  console.log(`${r.id.padEnd(9)}${`rgb(${r.worst.join(',')})`.padEnd(18)}${cells}  ${r.pass ? 'ok' : 'FAIL'}`)
}

await browser.close()
server.close()

if (fails.length) {
  console.log(`\n${fails.length} FAILED:`)
  for (const f of fails) console.log(`  ${f}`)
  console.log(`\nThe scrim opacity, the .glass fill and --color-mute are tuned together.`)
  console.log(`Raising translucency or darkening a text role means re-running this.`)
} else {
  console.log(`\nall panels clear AA (${AA}:1) for every text role, at their worst backdrop`)
}
process.exit(fails.length ? 1 : 0)
