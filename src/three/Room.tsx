import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { HOTSPOTS, hotspotNodes } from '../content'
import { useScene } from '../store'
import { orbit } from './orbit'
import { PixelBoard } from './PixelBoard'
import { RankingBoard } from './RankingBoard'
import { setPixelHover } from '../pixels/usePixels'
import { slotFromMaterialName } from '../pixels/palette'

const GLB = '/room.glb'

/**
 * Where the Draco decoder is served from. drei's default is Google's CDN, which
 * is a third-party request nothing in the page declares, and the GLB cannot be
 * shown without the decoder, so wherever that host is unreachable the room
 * never appears. The wrapper and wasm are copied out of three's examples into
 * public/draco/ by `npm run draco`. Set once, at module level, before the
 * preload at the bottom of this file runs: drei keeps a single loader for the
 * whole app, so this covers every useGLTF call rather than one positional
 * argument that is easy to drop. tools/verify-draco.mjs guards it.
 */
const DRACO = '/draco/'
useGLTF.setDecoderPath(DRACO)

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
  const focus = useScene((s) => s.focus)
  const setHover = useScene((s) => s.setHover)
  const setFocus = useScene((s) => s.setFocus)

  // Node -> hotspot id, so a raycast hit resolves to content in one lookup.
  const nodeToId = useMemo(() => {
    const m = new Map<string, string>()
    // The monitors are handled by Screens.tsx and no hotspot claims hot_screens,
    // so they never reach this map. Every node a hotspot owns maps to it, so a
    // two-mesh hotspot picks from either half.
    HOTSPOTS.forEach((h) => hotspotNodes(h).forEach((n) => m.set(n, h.id)))
    return m
  }, [])

  const cloned = useMemo(() => {
    const root = scene.clone(true)

    // Object3D.clone() shares material instances, and the source asset reuses
    // one material across unrelated props. Every hotspot node gets its own
    // copies. This used to contain the hover wash, which is gone; it stays for
    // two reasons. The wall boards write live emissive into their materials,
    // which should land in this room's copies rather than the cached GLTF. And
    // the roughness lift below runs once per mesh, so a material shared by
    // several meshes is lifted once for each of them: dropping these copies
    // would change how every hotspot prop looks.
    const owned = new Set<string>(HOTSPOTS.flatMap(hotspotNodes))
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
      })
    })
    return root
  }, [scene])

  // Dev-only handle for tools/verify-hotspots.mjs. There is no hover
  // highlight, so nothing in the room shows which meshes a hotspot owns; the
  // tool tints them itself, from outside, to check the exporter's regions.
  // Stripped from production builds, like __hover and __orbit.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__room = { root: cloned, nodeToId }
  }, [cloned, nodeToId])

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
