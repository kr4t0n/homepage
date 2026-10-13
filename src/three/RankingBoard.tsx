import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { usePixels } from '../pixels/usePixels'
import { rankByTokens, shortTokens, ROWS, SEGMENTS } from '../pixels/ranking'
import anchors from '../ranking-anchors.json'

/**
 * Drives the project ranking board on the -x wall, beside the pixel board.
 *
 * The LED bars are lit through their per-segment materials, as the pixel board
 * lights its cells. glTF has no text, so names and totals are drawn into a
 * canvas on a transparent plane just in front of the board face, in place of
 * the placeholder labels the export deletes. A canvas rather than drei `<Text>`
 * because troika cannot read the WOFF2-only webfont.
 */

/** Pixels per metre for the text canvas. The board's text is ~27mm tall. */
const PPM = 1100

/**
 * Text colour, from `Ranking - Project NN text` in the source scene: emissive
 * (0.68, 0.791, 0.694) linear, converted to sRGB. Taken from the material
 * rather than picked, so the live text matches the baked chrome around it.
 */
const INK = '#d8e6da'

/** How dark an unlit segment sits, as a fraction of its row's lit colour. */
const DIM = 0.16

interface Row {
  /** 32 materials, S01..S32 left to right. */
  segments: THREE.MeshStandardMaterial[]
  /** The row's designed colour, read off its own brightest segment. */
  lit: THREE.Color
}

/**
 * Find the board's LED materials and read each row's colour off the asset, so
 * the model's gold-to-olive ramp is not duplicated here. The mockup leaves a
 * scattered on/off pattern, so a row's brightest segment is its lit colour.
 */
function indexRows(root: THREE.Object3D): Row[] {
  const found = new Map<string, THREE.MeshStandardMaterial>()
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) {
      if (m instanceof THREE.MeshStandardMaterial && m.name.startsWith('Ranking - LED ')) {
        found.set(m.name, m)
      }
    }
  })

  const rows: Row[] = []
  for (let p = 1; p <= ROWS; p++) {
    const segments: THREE.MeshStandardMaterial[] = []
    for (let s = 1; s <= SEGMENTS; s++) {
      const m = found.get(
        `Ranking - LED P${String(p).padStart(2, '0')} S${String(s).padStart(2, '0')}`,
      )
      if (m) segments.push(m)
    }
    if (segments.length !== SEGMENTS) continue
    const brightest = segments.reduce((a, b) =>
      a.emissive.r + a.emissive.g + a.emissive.b >= b.emissive.r + b.emissive.g + b.emissive.b
        ? a
        : b,
    )
    rows.push({ segments, lit: brightest.emissive.clone() })
  }
  return rows
}

/** Where the text plane sits and how big its canvas is, derived from the asset. */
function planeFromAnchors() {
  const s = anchors.screen
  const height = s.max[1] - s.min[1]
  const width = s.max[2] - s.min[2]
  return {
    height,
    width,
    // Just clear of the text layer at x = -1.914, which is itself in front of
    // the recessed screen. Close enough to read as printed on the board,
    // far enough not to z-fight the baked rules behind it.
    x: -1.9125,
    centreY: (s.min[1] + s.max[1]) / 2,
    centreZ: (s.min[2] + s.max[2]) / 2,
    w: Math.round(width * PPM),
    h: Math.round(height * PPM),
  }
}

export function RankingBoard({ root }: { root: THREE.Object3D }) {
  const data = usePixels((s) => s.data)

  const rows = useMemo(() => indexRows(root), [root])
  const plane = useMemo(planeFromAnchors, [])

  const canvas = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = plane.w
    c.height = plane.h
    return c
  }, [plane])

  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }, [canvas])

  useEffect(() => () => texture.dispose(), [texture])

  // ---------------------------------------------------------------- LEDs --
  useEffect(() => {
    if (!data || rows.length === 0) return
    const ranked = rankByTokens(data, rows.length)

    rows.forEach((row, i) => {
      const entry = ranked[i]
      row.segments.forEach((m, s) => {
        // A row with no project behind it is all unlit rather than keeping the
        // mockup's pattern, which would read as data.
        const on = entry ? s < entry.lit : false
        const colour = on ? row.lit : row.lit.clone().multiplyScalar(DIM)
        m.emissive.copy(colour)
        m.emissiveIntensity = 1
      })
    })
  }, [data, rows])

  // ---------------------------------------------------------------- text --
  useEffect(() => {
    if (!data) return
    let cancelled = false

    const draw = () => {
      if (cancelled) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const ranked = rankByTokens(data, ROWS)
      const s = anchors.screen

      // glTF metres -> canvas pixels. u runs with decreasing z because the
      // plane is rotated to face +x, which flips the board's left-to-right.
      const px = (z: number) => ((s.max[2] - z) / (s.max[2] - s.min[2])) * canvas.width
      const py = (y: number) => (1 - (y - s.min[1]) / (s.max[1] - s.min[1])) * canvas.height

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = INK

      /** Set a font size whose cap height matches `metres`, measured not guessed. */
      const fitCaps = (metres: number) => {
        const target = (metres / (s.max[1] - s.min[1])) * canvas.height
        ctx.font = `500 100px 'Geist Mono Variable', ui-monospace, monospace`
        const caps = ctx.measureText('H').actualBoundingBoxAscent || 71
        ctx.font = `500 ${(100 * target) / caps}px 'Geist Mono Variable', ui-monospace, monospace`
      }

      anchors.rows.forEach((row, i) => {
        const entry = ranked[i]
        if (!entry) return
        const tokens = entry.project.tokens
        if (!tokens) return

        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        fitCaps(row.name.max[1] - row.name.min[1])
        const label = (entry.project.name ?? entry.project.key).toUpperCase()
        ctx.fillText(label, px(row.name.max[2]), py(row.name.min[1]))

        ctx.textAlign = 'right'
        fitCaps(row.score.max[1] - row.score.min[1])
        ctx.fillText(shortTokens(entry.total), px(row.score.min[2]), py(row.score.min[1]))
      })

      // Where the mockup printed `SAMPLE PROJECTS`; the figures are real, so it
      // names the metric instead.
      ctx.textAlign = 'left'
      fitCaps(anchors.caption.max[1] - anchors.caption.min[1])
      ctx.fillText('BY TOTAL TOKENS', px(anchors.caption.max[2]), py(anchors.caption.min[1]))

      fitCaps(anchors.footer.max[1] - anchors.footer.min[1])
      ctx.fillText('MOST TOKENS FIRST', px(anchors.footer.max[2]), py(anchors.footer.min[1]))

      // Heads the right-hand column. The mockup said `SCORE / 100`; the column
      // prints totals, and `in + out` is the sum the board is ordered by.
      ctx.textAlign = 'right'
      fitCaps(anchors.metric.max[1] - anchors.metric.min[1])
      ctx.fillText('IN + OUT', px(anchors.metric.min[2]), py(anchors.metric.min[1]))

      texture.needsUpdate = true
    }

    // Drawing before the webfont loads silently falls back to default monospace.
    if (document.fonts?.status === 'loaded') draw()
    else void document.fonts?.ready.then(draw)

    return () => {
      cancelled = true
    }
  }, [data, canvas, texture])

  return (
    <mesh
      position={[plane.x, plane.centreY, plane.centreZ]}
      rotation={[0, Math.PI / 2, 0]}
      // Purely a readout. Leaving it pickable would put an invisible pane
      // between the pointer and the board's own hotspot.
      raycast={() => null}
    >
      <planeGeometry args={[plane.width, plane.height]} />
      <meshBasicMaterial
        map={texture}
        transparent
        depthWrite={false}
        // The board's text is emissive in the asset; tone mapping would grade
        // this against scene exposure and leave it dimmer than the chrome
        // printed beside it.
        toneMapped={false}
      />
    </mesh>
  )
}
