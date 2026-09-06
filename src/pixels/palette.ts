import * as THREE from 'three'
import type { PixelPayload } from '../shared/pixels'

/**
 * Turning activity data into lit pixels.
 *
 * Colour is entirely ours. Argus used to send a `hue` per project and a
 * collapsed `other` bucket; it now sends neither, so both the palette and the
 * decision about how many projects deserve their own colour live here.
 */

/**
 * Project colours, by position in `projects[]`.
 *
 * Chosen to sit beside the room's acid accent rather than fight it, and to stay
 * separable at the size one pixel occupies — roughly 20 screen pixels when the
 * board is framed. That size is the binding constraint: subtle neighbours are
 * indistinguishable, so these are spaced widely round the wheel instead of
 * being a pretty ramp.
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
 * Everything past the palette collapses to this.
 *
 * Argus returned 12 projects at time of writing and no longer collapses the
 * tail itself, so without this the board would need twelve distinguishable
 * colours, which does not exist at this pixel size. The tail is still *lit* —
 * it happened, and the brightness still carries how busy the hour was — it just
 * does not claim an identity it cannot legibly convey.
 */
const TAIL = new THREE.Color('#64748b')

/** Unlit: nothing ran in that hour. */
const OFF = new THREE.Color('#000000')

/** How hard a fully busy pixel glows. Tuned against the room's night lighting. */
const MAX_EMISSIVE = 2.4

/** Slots after the live one have not happened yet; see paint(). */
const FUTURE_INTENSITY = 0

export function colourFor(projectIndex: number | null): THREE.Color {
  if (projectIndex === null) return OFF
  return PALETTE[projectIndex] ?? TAIL
}

/** Number of projects that get their own colour before the tail collapses. */
export const PALETTE_SIZE = PALETTE.length

/**
 * Look up a pixel material by grid position.
 *
 * The board exports as one mesh with 1009 primitives, one material each, named
 * `Pixel Light R01 C01` through `R24 C42`. Joining the objects preserved the
 * materials, which is the only reason 1008 cells are individually addressable
 * without re-authoring the asset.
 */
export function materialName(row: number, col: number): string {
  const pad = (n: number) => String(n + 1).padStart(2, '0')
  return `Pixel Light R${pad(row)} C${pad(col)}`
}

/**
 * Slot index from a pixel's material name, or null if it is not a pixel.
 *
 * Stateless on purpose. The name already encodes the grid position, so a
 * raycast hit can be resolved without consulting the cell index — which means
 * the hover path needs no shared map between Room and PixelBoard.
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
   * The mesh carrying this pixel.
   *
   * glTF meshes with several primitives load as a Group of one Mesh per
   * primitive, so the board's 1008 pixels arrive as 1008 separate meshes rather
   * than one merged surface. That is what makes a per-cell raycast possible at
   * all — see PixelTooltip.
   */
  mesh: THREE.Mesh
  /** Slot index this cell shows, for the painter to look up. */
  slot: number
}

/**
 * Index every pixel material in the board, keyed by slot.
 *
 * Done once per scene clone. Walking 1009 primitives on each of ~360 repaints
 * an hour would be wasteful, and the mapping cannot change without a re-export.
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
  // The last column runs to end-of-day, so its later slots are in the future and
  // permanently idle. Left as ordinary empty cells they read as a block of false
  // dark hanging off today's column, as if activity had stopped.
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
