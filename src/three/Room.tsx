import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { HOTSPOTS, PICKABLE_HOTSPOTS, ROOM_HOTSPOTS, hotspotNodes } from '../content'
import { useScene } from '../store'
import { HIGHLIGHT, highlight } from './highlight'
import { baseline, clearBaselines, setBaseline } from './materials'
import { orbit } from './orbit'
import { PixelBoard } from './PixelBoard'
import { RankingBoard } from './RankingBoard'
import { setPixelHover } from '../pixels/usePixels'
import { slotFromMaterialName } from '../pixels/palette'

const GLB = '/room.glb'


/**
 * Loads the converted diorama and wires the interactive nodes.
 *
 * The exporter merges every object into one mesh per semantic group and names
 * them `hot_*` / `static_*`, so raycasting is a handful of meshes rather than
 * the 193 unnamed objects the asset shipped with.
 */
/** The activity board's hotspot id. Its cells get a per-cell readout. */
const PIXEL_HOTSPOT = 'signals'

export function Room() {
  const { scene } = useGLTF(GLB)
  const hover = useScene((s) => s.hover)
  const focus = useScene((s) => s.focus)
  const setHover = useScene((s) => s.setHover)
  const setFocus = useScene((s) => s.setFocus)

  // Node -> hotspot id, so a raycast hit resolves to content in one lookup.
  const nodeToId = useMemo(() => {
    const m = new Map<string, string>()
    // Only pickable ones: the monitors are handled by Screens.tsx. Every node a
    // hotspot owns maps to it, so a two-mesh hotspot picks from either half.
    PICKABLE_HOTSPOTS().forEach((h) => hotspotNodes(h).forEach((n) => m.set(n, h.id)))
    return m
  }, [])

  // The emissive baseline lives in ./materials rather than here, because the
  // pixel board also writes emissive and has to be able to move a material's
  // resting value. Hover restores from the same map, so the two cooperate
  // instead of overwriting each other.
  const cloned = useMemo(() => {
    const root = scene.clone(true)
    clearBaselines()

    // Object3D.clone() shares material instances, and the source asset reuses
    // one material across unrelated props. Without per-node copies, hovering
    // the desk also lights up a figurine on the far shelf. Give every
    // interactive node its own materials so the wash stays contained.
    const owned = new Set<string>(ROOM_HOTSPOTS().flatMap(hotspotNodes))
    owned.forEach((nodeName) => {
      const node = root.getObjectByName(nodeName)
      node?.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        child.material = Array.isArray(child.material)
          ? child.material.map((m) => m.clone())
          : child.material.clone()
      })
    })

    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      o.castShadow = false
      o.receiveShadow = false
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      mats.forEach((m) => {
        if (!(m instanceof THREE.MeshStandardMaterial)) return
        // Asset shipped with no textures; flat colour reads better slightly
        // rougher, and it keeps the emissive panels doing the visual work.
        m.roughness = Math.min(1, m.roughness + 0.15)

        // Emissive intensity is deliberately left alone. Every glowing
        // material in this asset carries an authored KHR_materials_emissive_
        // strength between 1 and 10, which three.js already applies, so forcing
        // a single value here flattened the artist's lighting: the DJ
        // controller's LEDs (authored 5 and 10) were crushed while its dim
        // indicators (authored 1) were boosted, leaving a black slab with a few
        // glowing dots on it.

        // Walls and floor are the largest surfaces by far, so they set the
        // overall key. Pulled down to keep the room reading as night.
        if (o.name.startsWith('static_shell')) {
          m.color.multiplyScalar(0.34)
        }

        setBaseline(m, m.emissive, m.emissiveIntensity)
      })
    })
    return root
  }, [scene])

  // Drive the hover highlight from the store rather than per-frame state, so
  // pointer movement never re-renders the React tree.
  useEffect(() => {
    // Restore every material first. A hotspot node with several primitives is
    // loaded as a Group whose Mesh children are named `<node>_0`, `<node>_1`,
    // so matching on the node name alone would never hit an actual Mesh.
    const paint = (o: THREE.Object3D, on: boolean) => {
      o.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        const mats = Array.isArray(child.material) ? child.material : [child.material]
        mats.forEach((m) => {
          if (!(m instanceof THREE.MeshStandardMaterial)) return
          const base = baseline.get(m)
          if (!base) return
          if (on) {
            // Blend the accent into the material's own emissive instead of
            // overwriting it. Overwriting flattened every hovered prop into a
            // solid green silhouette and killed the glow on the screens.
            m.emissive.copy(base.color).lerp(HIGHLIGHT, highlight.mix)
            m.emissiveIntensity = Math.max(base.intensity, highlight.intensity)
          } else {
            m.emissive.copy(base.color)
            m.emissiveIntensity = base.intensity
          }
        })
      })
    }

    paint(cloned, false)
    const hovered = HOTSPOTS.find((h) => h.id === hover)
    // Do not wash the thing you are already looking at. The highlight is an
    // affordance meaning "clickable, click to focus"; once a hotspot IS focused
    // that promise has been kept, and the wash is just noise over the subject
    // the camera has flown to.
    //
    // It stopped being merely redundant when the pixel board arrived. That board
    // encodes data in colour, and the wash lerps the accent into every material
    // it touches — so hovering the focused board repaints six weeks of activity
    // in shades of green and destroys the reading. The monitors have always
    // looked right here for an accidental reason: nothing points a hotspot at
    // `hot_screens`, so they are never hovered at all.
    //
    // `noHighlight` extends that from "the focused board" to "these boards,
    // ever". Both wall boards encode their data in colour, so the wash was
    // never an affordance there -- it was a hover that scrambled the reading.
    const washed =
      hovered && hovered.id !== focus && !hovered.noHighlight ? hotspotNodes(hovered) : []
    washed.forEach((name) => {
      const node = cloned.getObjectByName(name)
      if (node) paint(node, true)
    })

    // Dev-only handle, alongside __hover and __orbit. The wash cannot be
    // asserted from a screenshot: pointer parallax moves the camera, so any two
    // frames taken with the pointer in different places differ almost
    // everywhere. This reports the intent directly.
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__wash = () => washed
    }
  }, [hover, focus, cloned])

  /**
   * Which pixel of the activity board is under the pointer, if any.
   *
   * Reads the hit material's name rather than consulting a lookup: the name
   * already encodes row and column, so no shared map is needed between here and
   * PixelBoard. This costs nothing extra per move — the board's meshes are
   * inside `cloned` and were already being raycast.
   */
  const pickPixel = (e: ThreeEvent<PointerEvent>): number | null => {
    for (const hit of e.intersections) {
      const o = hit.object
      if (!(o instanceof THREE.Mesh)) continue
      const mat = Array.isArray(o.material) ? o.material[0] : o.material
      const slot = mat?.name ? slotFromMaterialName(mat.name) : null
      if (slot !== null) return slot
    }
    return null
  }

  const pick = (e: ThreeEvent<PointerEvent>): string | null => {
    for (const hit of e.intersections) {
      let n: THREE.Object3D | null = hit.object
      while (n) {
        const id = nodeToId.get(n.name)
        if (id) return id
        n = n.parent
      }
    }
    return null
  }

  return (
    <group
      onPointerMove={(e) => {
        e.stopPropagation()
        const id = pick(e)
        setHover(id)
        // Per-cell readout, but only once the board is the focused subject.
        // From the home view the board is a thumbnail a couple of hundred pixels
        // wide, where a cell is barely two pixels and a readout would be noise
        // chasing the pointer. Focused, the camera has flown to it and each cell
        // is a real target worth inspecting.
        if (id === PIXEL_HOTSPOT && focus === PIXEL_HOTSPOT) {
          const slot = pickPixel(e)
          setPixelHover(
            slot === null ? null : { slot, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY },
          )
        } else {
          setPixelHover(null)
        }
      }}
      onPointerOut={() => {
        setHover(null)
        setPixelHover(null)
      }}
      onClick={(e) => {
        e.stopPropagation()
        // Releasing an orbit drag over an object should not open it.
        if (orbit.suppressClick) return
        const id = pick(e as unknown as ThreeEvent<PointerEvent>)
        if (id) setFocus(id)
      }}
    >
      <primitive object={cloned} />
      {/* Lights the wall board from live activity. Renders nothing; it writes
          emissive on materials that are already part of `cloned`. */}
      <PixelBoard root={cloned} />
      {/* The ranking board beside it. Writes emissive on `cloned` the same way,
          and adds one plane of its own for text the GLB cannot carry. */}
      <RankingBoard root={cloned} />
    </group>
  )
}

useGLTF.preload(GLB)
