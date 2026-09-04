/**
 * Glass contrast gate.
 *
 * The frosted panels are only legible because several values were tuned together
 * against measurement: the scrim opacity, each material's fill and
 * `brightness()`, and the text colours. Nudging any one can drop text under WCAG
 * AA with no visible warning, because the failure only appears in front of the
 * room's bright surfaces — the hexagon light wall behind the Work panel is the
 * worst case, and it is off screen when the panel is closed. Before this test
 * existed, body text measured 2.22:1 there and nobody could have noticed.
 *
 * Method, per panel:
 *   1. Read the computed colour and type size of every piece of visible text.
 *      Testing the *actual* colours matters: an earlier version checked three
 *      fixed roles everywhere and reported failures for a role the panel did not
 *      even use, which looked like a real regression and was not.
 *   2. Hide the contents so only the composited glass surface remains, and find
 *      the brightest tile — the worst backdrop any glyph in that panel could
 *      land on.
 *   3. Check every colour against it, at 3:1 for large text and 4.5:1 otherwise,
 *      per WCAG 1.4.3.
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

/**
 * Every routable panel, by hotspot *id* — not by panel kind, which is what
 * `stats` is. Must match the ids in HOTSPOTS in src/content.ts; `signals` is
 * included even though it is `unverified` and hidden from the room, because it
 * is still reachable by URL and so still has to be legible.
 */
const PANELS = ['music', 'player', 'writing', 'about', 'cv', 'contact', 'signals']

const lin = (c) => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (fg, bg) => {
  const a = lum(fg)
  const b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
/** WCAG 1.4.3: 3:1 for large text, 4.5:1 otherwise. */
const threshold = (px, weight) => (px >= 24 || (px >= 18.66 && weight >= 700) ? 3 : 4.5)

/**
 * Panels knowingly shipping under WCAG AA, with the ratio measured when the
 * decision was made.
 *
 * This is a waiver, not a pass. The owner chose crystal-clear glass over
 * contrast after viewing both in a real browser: content panels sit in front of
 * the lit monitors and the hexagon wall, and clear glass there puts 14px muted
 * text between 1.03:1 and 2.89:1 against a 4.5:1 requirement. That is a real
 * accessibility cost, taken deliberately and with the numbers in hand.
 *
 * The gate still earns its keep. A panel listed here fails if it gets
 * *worse* than its baseline, a panel not listed here must clear AA outright, and
 * a newly added panel cannot land under the bar unnoticed. Tolerance is 15%,
 * comfortably wider than the ~2% run-to-run variation from the room's idle
 * drift, so this does not flap.
 *
 * The route back to a clean pass is the camera, not the CSS: reframe these
 * hotspots over darker parts of the room, the way the decks bar already is, and
 * clear glass becomes affordable. Delete an entry the moment its panel passes.
 */
const ACCEPTED = {
  about: 1.03,
  contact: 1.09,
  signals: 1.57,
  writing: 1.64,
  music: 1.78,
  cv: 2.89,
}
const TOLERANCE = 0.85

const fails = []
const waived = []
const rows = []

for (const id of PANELS) {
  // Unique query so this is a real document load, not a same-document hash
  // change. Without it React reuses nodes across panels and the
  // visibility:hidden applied below survives into the next iteration.
  await page.goto(`${BASE}/?panel=${id}#/${id}`, { waitUntil: 'networkidle', timeout: 120_000 })
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

  // Step 1: what text is actually on this panel, and in what colour.
  const specs = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    const seen = new Map()
    for (const el of d.querySelectorAll('*')) {
      // Only elements holding their own text, so a wrapper does not report the
      // colour its children override.
      const own = [...el.childNodes].some(
        (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
      )
      if (!own) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      const px = parseFloat(cs.fontSize)
      const weight = parseInt(cs.fontWeight, 10) || 400
      // Walk up for the first background opaque enough to be what this text
      // actually sits on — but STOP AT THE PANEL. Walking past it reaches
      // <body>, which is opaque --color-void, and every glass panel then
      // "passed" at 6.85:1 against a background that is nowhere near the text:
      // the blurred canvas composites above the body fill. That was a false
      // pass that bypassed the glass measurement entirely, and it looked
      // convincing because the number was plausible. Inside the panel the glass
      // fills are all under 0.9 alpha so they are skipped, leaving the measured
      // surface; an opaque acid button is found and judged against itself.
      let bg = null
      for (let n = el; n && n !== d.parentElement; n = n.parentElement) {
        const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g)
        if (!m) continue
        const a = m.length >= 4 ? Number(m[3]) : 1
        if (a >= 0.9) {
          bg = [Number(m[0]), Number(m[1]), Number(m[2])]
          break
        }
      }
      const key = `${cs.color}|${Math.round(px)}|${weight}|${bg}`
      if (!seen.has(key)) {
        seen.set(key, {
          color: cs.color,
          px,
          weight,
          bg,
          sample: el.textContent.trim().slice(0, 22),
        })
      }
    }
    return [...seen.values()]
  })

  // Step 2: the bare surface, and its brightest tile.
  await page.evaluate(() => {
    for (const c of document.querySelector('[role="dialog"]').children) {
      c.style.visibility = 'hidden'
    }
  })
  await page.waitForTimeout(350)

  const box = await dialog.boundingBox()
  const shot = (await page.screenshot({ clip: box })).toString('base64')

  const worst = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = img.naturalWidth
    cv.height = img.naturalHeight
    const ctx = cv.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height)

    const l = (c) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    const L = ([r, g, b]) => 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b)

    // Inset past the decorative edge. The border, the inset rim light and the
    // specular sheen are all bright and all within ~3px of the boundary, and no
    // glyph ever lands there — every panel has at least 16px of padding.
    // Sampling from the boundary measured the chrome instead of the backdrop,
    // and only started failing when the fill dropped far enough that the rim
    // became the brightest thing in frame. Measure where text can be.
    const PAD = 16
    const T = 8
    let out = null
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
        if (!out || L(avg) > L(out)) out = avg
      }
    }
    return out
  }, shot)

  // Step 3: judge each colour that is actually used.
  let worstRatio = Infinity
  let culprit = null
  let tightest = Infinity
  const under = []
  for (const s of specs) {
    const m = s.color.match(/(\d+(?:\.\d+)?)/g)
    if (!m) continue
    const rgb = m.slice(0, 3).map(Number)
    // Fully transparent text cannot be read either way; skip rather than divide.
    if (m.length >= 4 && Number(m[3]) === 0) continue
    // Judge against whatever is really behind this text.
    const against = s.bg ?? worst
    const r = contrast(rgb, against)
    const need = threshold(s.px, s.weight)
    if (r < need) {
      under.push(
        `${id}: ${s.color} at ${Math.round(s.px)}px on ${s.bg ? `opaque rgb(${s.bg.join(',')})` : 'glass'}` +
          ` needs ${need}:1, measured ${r.toFixed(2)}:1  ("${s.sample}")`,
      )
      if (r < tightest) tightest = r
    }
    const slack = r / need
    if (slack < worstRatio) {
      worstRatio = slack
      culprit = { ...s, r, need }
    }
  }

  const baseline = ACCEPTED[id]
  if (under.length === 0) {
    // A waived panel that now passes: the waiver is stale and should go.
    if (baseline !== undefined) {
      fails.push(`${id}: now clears AA — delete its ACCEPTED entry (was ${baseline}:1)`)
    }
  } else if (baseline === undefined) {
    fails.push(...under)
  } else if (tightest < baseline * TOLERANCE) {
    fails.push(
      `${id}: REGRESSED past its accepted baseline — was ${baseline}:1, now ${tightest.toFixed(2)}:1`,
      ...under,
    )
  } else {
    waived.push(`${id}: ${under.length} run(s) under AA, tightest ${tightest.toFixed(2)}:1 (accepted ${baseline}:1)`)
  }

  rows.push({ id, worst, specs: specs.length, culprit })
}

console.log(
  `\n${'panel'.padEnd(9)}${'worst backdrop'.padEnd(19)}${'texts'.padEnd(7)}tightest text`,
)
for (const r of rows) {
  const c = r.culprit
  const tight = c
    ? `${c.r.toFixed(2)}:1 vs ${c.need}:1 needed  ${Math.round(c.px)}px ${c.color}`
    : 'no text found'
  console.log(
    `${r.id.padEnd(9)}${`rgb(${r.worst.join(',')})`.padEnd(19)}${String(r.specs).padEnd(7)}${tight}`,
  )
}

await browser.close()
server.close()

if (waived.length) {
  console.log(`\n${waived.length} panel(s) knowingly under AA — see ACCEPTED in this file:`)
  for (const w of waived) console.log(`  ${w}`)
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED:`)
  for (const f of fails) console.log(`  ${f}`)
  console.log(`\nEither a panel got worse than its accepted baseline, or one that`)
  console.log(`was passing stopped. Clear glass is unforgiving of what sits behind it.`)
} else if (waived.length) {
  console.log(`\nno regressions; the accepted deviations above are unchanged`)
} else {
  console.log(`\nevery text colour on every panel clears WCAG AA at its worst backdrop`)
}
process.exit(fails.length ? 1 : 0)
