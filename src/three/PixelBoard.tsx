import { useEffect, useMemo, useRef } from 'react'
import gsap from 'gsap'
import * as THREE from 'three'
import { usePixels } from '../pixels/usePixels'
import { cellAppearance, indexCells } from '../pixels/palette'

/**
 * Lights the pixel board (`hot_pixelboard`) from live Argus activity. Renders
 * nothing: it writes emissive on the 1008 pixel materials in Room's cloned
 * scene, since those are the instances the room actually draws.
 */

/** One revolution of the blink. Slow enough to read as a pulse, not a strobe. */
const BLINK_SECONDS = 1.6

export function PixelBoard({ root }: { root: THREE.Object3D }) {
  const data = usePixels((s) => s.data)
  const live = usePixels((s) => s.live)
  const blink = useRef<gsap.core.Tween | null>(null)

  // Once per clone, not per poll: the mapping only changes with a re-export.
  const cells = useMemo(() => indexCells(root), [root])

  // Dev-only handle for the verify scripts, like __hover and __orbit.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__board = () => ({
      cells: cells.size,
      // Distinct meshes across all cells. If this equals the cell count each
      // pixel is its own raycast target; if it is 1 they are merged and a
      // per-cell hover would need UV maths instead.
      meshes: new Set([...cells.values()].map((c) => c.mesh)).size,
    })
  }, [cells])

  useEffect(() => {
    if (!data) return

    for (const [slot, cell] of cells) {
      const { colour, intensity } = cellAppearance(data, slot, live)
      cell.material.emissive.copy(colour)
      cell.material.emissiveIntensity = intensity
    }
  }, [data, live, cells])

  // The blink marks the hour currently being worked in.
  useEffect(() => {
    blink.current?.kill()
    blink.current = null
    if (!data || live < 0) return
    // Pulse only while something is running; otherwise the winner stays painted.
    if (data.live.length === 0) return

    const cell = cells.get(live)
    if (!cell) return

    const { intensity } = cellAppearance(data, live, live)
    const mm = gsap.matchMedia()
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      blink.current = gsap.to(cell.material, {
        emissiveIntensity: Math.max(intensity, 0.35) * 2.2,
        duration: BLINK_SECONDS / 2,
        ease: 'sine.inOut',
        yoyo: true,
        repeat: -1,
      })
      return () => {
        blink.current?.kill()
        // Put it back where the data says it belongs, or the cell keeps
        // whatever brightness the tween was mid-way through.
        cell.material.emissiveIntensity = intensity
      }
    })
    return () => mm.revert()
  }, [data, live, cells])

  return null
}
