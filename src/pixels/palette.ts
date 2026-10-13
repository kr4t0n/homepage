import * as THREE from 'three'
import type { PixelPayload } from '../shared/pixels'

/**
 * Turning activity data into lit pixels.
 *
 * Argus sends no per-project colour and no collapsed tail, so the palette and
 * the cut-off for how many projects get their own colour both live here.
 */

/**
 * Project colours, by position in `projects[]`. A framed cell is only ~20
 * screen pixels, where close hues blur together, so these are spaced widely
 * round the wheel rather than ramped, and chosen to sit beside the acid accent.
 */
const PALETTE = [
  '#9ef01a', // acid — the room's own accent, for the busiest project
  '#22d3ee', // cyan
  '#f472b6', // pink
  '#fbbf24', // amber
  '#a78bfa', // violet
  '#34d399', // emerald
].map((hex) => new THREE.Color(hex))

/**
 * Shared by every project past the palette: a cell this small cannot carry more
 * distinct hues. A tail hour still happened, so it stays lit at its real
 * brightness; it just claims no identity.
 */
const TAIL = new THREE.Color('#64748b')

/** Unlit: nothing ran in that hour. */
const OFF = new THREE.Color('#000000')

/** How hard a fully busy pixel glows. Tuned against the room's night lighting. */
const MAX_EMISSIVE = 2.4

/** Slots after the live one have not happened yet; see cellAppearance. */
const FUTURE_INTENSITY = 0

export function colourFor(projectIndex: number | null): THREE.Color {
  if (projectIndex === null) return OFF
  return PALETTE[projectIndex] ?? TAIL
}

/** Number of projects that get their own colour before the tail collapses. */
export const PALETTE_SIZE = PALETTE.length

/**
 * Material name of the pixel at a grid position. The board exports as one mesh
 * of 1009 primitives with a material each, `Pixel Light R01 C01` to `R24 C42`;
 * those per-cell materials are the only handle on individual cells.
 */
export function materialName(row: number, col: number): string {
  const pad = (n: number) => String(n + 1).padStart(2, '0')
  return `Pixel Light R${pad(row)} C${pad(col)}`
}

/**
 * Slot index from a pixel's material name, or null if it is not a pixel. Read
 * from the name alone so the hover path needs no map shared between Room and
 * PixelBoard.
 */
export function slotFromMaterialName(name: string, slotsPerDay = 24): number | null {
  const m = /^Pixel Light R(\d+) C(\d+)$/.exec(name)
  if (!m) return null
  const row = Number(m[1]) - 1
  const col = Number(m[2]) - 1
  return col * slotsPerDay + row
}

export interface PixelCell {
  material: THREE.MeshStandardMaterial
  /**
   * The mesh carrying this pixel. Each glTF primitive loads as its own Mesh, so
   * every cell is a separate raycast target.
   */
  mesh: THREE.Mesh
  /** Slot index this cell shows, for the painter to look up. */
  slot: number
}

/**
 * Index every pixel material in the board, keyed by slot. Meant to run once per
 * scene clone, not per poll: the mapping only changes with a re-export.
 */
export function indexCells(root: THREE.Object3D, slotsPerDay = 24): Map<number, PixelCell> {
  const byName = new Map<string, { material: THREE.MeshStandardMaterial; mesh: THREE.Mesh }>()
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) {
      if (m instanceof THREE.MeshStandardMaterial && m.name.startsWith('Pixel Light ')) {
        byName.set(m.name, { material: m, mesh: o })
      }
    }
  })

  const cells = new Map<number, PixelCell>()
  for (const [name, { material, mesh }] of byName) {
    const m = /^Pixel Light R(\d+) C(\d+)$/.exec(name)
    if (!m) continue
    const row = Number(m[1]) - 1
    const col = Number(m[2]) - 1
    const slot = col * slotsPerDay + row
    cells.set(slot, { material, mesh, slot })
  }
  return cells
}

/**
 * What a single slot should look like. Pure, so it can be tested without a GPU.
 *
 * Hue answers "who owned this hour", brightness answers "how busy was it". They
 * are deliberately not folded together: a quiet hour owned outright by one
 * project keeps that project's colour, dim.
 */
export function cellAppearance(
  p: PixelPayload,
  slot: number,
  live: number,
): { colour: THREE.Color; intensity: number } {
  // The last column runs to end of day, so slots after the live one are still to
  // come and stay dark whatever the payload holds.
  if (live >= 0 && slot > live) {
    return { colour: OFF, intensity: FUTURE_INTENSITY }
  }
  const winner = p.winners[slot] ?? null
  if (winner === null) return { colour: OFF, intensity: 0 }
  return {
    colour: colourFor(winner),
    intensity: (p.intensity[slot] / 100) * MAX_EMISSIVE,
  }
}
