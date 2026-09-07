import { useEffect, useMemo, useRef } from 'react'
import gsap from 'gsap'
import * as THREE from 'three'
import { usePixels } from '../pixels/usePixels'
import { cellAppearance, indexCells } from '../pixels/palette'
import { setBaseline } from './materials'

/**
 * Lights the wall board from live Argus activity.
 *
 * Renders nothing itself. The geometry already exists in the GLB as
 * `hot_pixelboard`; this only writes emissive on the 1008 pixel materials the
 * export preserved. Kept out of Room.tsx so the room stays about the room, but
 * it takes Room's cloned scene, because those are the material instances the
 * room actually renders.
 */

/** One revolution of the blink. Slow enough to read as a pulse, not a strobe. */
const BLINK_SECONDS = 1.6

export function PixelBoard({ root }: { root: THREE.Object3D }) {
  const data = usePixels((s) => s.data)
  const live = usePixels((s) => s.live)
  const blink = useRef<gsap.core.Tween | null>(null)

  // Walking 1009 primitives is not something to repeat on every poll, and the
  // mapping cannot change without re-exporting the asset.
  const cells = useMemo(() => indexCells(root), [root])

  // Dev-only handle, matching the __hover and __orbit hooks the room already
  // exposes. The verification harnesses cannot reach into the R3F store, and
  // asserting on pixel state through screenshots alone is far too blunt.
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
      // Record where this pixel rests. Room restores every material from the
      // baseline map whenever the hover target changes, so without this the
      // board would blank the first time anything in the room was hovered.
      setBaseline(cell.material, colour, intensity)
    }
  }, [data, live, cells])

  // The blink marks the hour currently being worked in. The integration brief
  // asks for CSS keyframes; these are 3D materials with no DOM node, so it goes
  // on GSAP instead — which is also the room's single owner of animation, the
  // same rule the spinning album art follows.
  useEffect(() => {
    blink.current?.kill()
    blink.current = null
    if (!data || live < 0) return
    // `live` non-empty means something is running right now. When it empties the
    // hour is over: stop pulsing and leave the winner painted.
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
