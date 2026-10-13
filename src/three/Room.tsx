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
 * Self-hosted Draco decoder, filled by `pnpm run draco`; drei would fetch it
 * from Google. Set at module level, before the preload at the bottom runs, and
 * drei shares one loader, so it covers every useGLTF call.
 */
const DRACO = '/draco/'
useGLTF.setDecoderPath(DRACO)

/** The activity board's hotspot id. Its cells get a per-cell readout. */
const PIXEL_HOTSPOT = 'signals'

/**
 * Loads the exported room and wires picking. The exporter joins it into one
 * mesh per semantic group, named `hot_*` / `static_*`, so a raycast tests a
 * handful of meshes.
 */
export function Room() {
  const { scene } = useGLTF(GLB)
  const focus = useScene((s) => s.focus)
  const setHover = useScene((s) => s.setHover)
  const setFocus = useScene((s) => s.setFocus)

  // Node -> hotspot id, so a raycast hit resolves to content in one lookup.
  const nodeToId = useMemo(() => {
    const m = new Map<string, string>()
    // Every node a hotspot owns, so a multi-mesh hotspot picks from any part.
    // hot_screens is absent: no hotspot claims it, and Screens.tsx owns the monitors.
    HOTSPOTS.forEach((h) => hotspotNodes(h).forEach((n) => m.set(n, h.id)))
    return m
  }, [])

  const cloned = useMemo(() => {
    const root = scene.clone(true)

    // Every material is copied so the in-place edits below never reach drei's
    // cache, where StrictMode's second dev run would apply them again. Copies
    // keep the originals' sharing (the roughness lift compounds per mesh) and
    // relative id order (opaque draws sort by material id, which settles
    // coplanar pixels). Hotspot meshes get one copy each, for the wall boards'
    // live emissive. See AGENTS.md on keeping the scene-clone memo pure.
    const hotspotMeshes: THREE.Mesh[] = []
    new Set(HOTSPOTS.flatMap(hotspotNodes)).forEach((name) =>
      root.getObjectByName(name)?.traverse((o) => {
        if (o instanceof THREE.Mesh) hotspotMeshes.push(o)
      }),
    )
    const isHotspot = new Set<THREE.Object3D>(hotspotMeshes)
    const originals = new Set<THREE.Material>()
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && !isHotspot.has(o)) {
        ;[o.material].flat().forEach((m: THREE.Material) => originals.add(m))
      }
    })
    // `id` is the sequential number WebGLRenderLists sorts by. three.js sets it
    // at runtime and @types/three does not declare it.
    const idOf = (m: THREE.Material) => (m as THREE.Material & { id: number }).id
    const shared = new Map<THREE.Material, THREE.Material>()
    ;[...originals].sort((a, b) => idOf(a) - idOf(b)).forEach((m) => shared.set(m, m.clone()))
    hotspotMeshes.forEach((o) => {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone()
    })
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || isHotspot.has(o)) return
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => shared.get(m)!)
        : shared.get(o.material)!
    })

    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      o.castShadow = false
      o.receiveShadow = false
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      mats.forEach((m) => {
        if (!(m instanceof THREE.MeshStandardMaterial)) return
        // The asset has no textures; flat colour reads better slightly rougher,
        // and it leaves the emissive panels to do the visual work.
        m.roughness = Math.min(1, m.roughness + 0.15)

        // emissiveIntensity is left as authored: three.js already applies each
        // material's KHR_materials_emissive_strength (1 to 10), and one forced
        // value flattens them. Scale it if it ever needs changing, never replace it.

        // Walls and floor are the largest surfaces by far, so they set the
        // overall key. Pulled down to keep the room reading as night.
        if (o.name.startsWith('static_shell')) {
          m.color.multiplyScalar(0.34)
        }
      })
    })
    return root
  }, [scene])

  // Dev-only handle for tools/verify-hotspots.mjs, which tints each hotspot's
  // meshes to check the exporter's regions. Stripped from production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__room = { root: cloned, nodeToId }
  }, [cloned, nodeToId])

  /**
   * Which cell of the activity board is under the pointer, if any. Read from
   * the hit material's name, which encodes the cell, so no map is shared with
   * PixelBoard; the board is already part of the room's raycast.
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
        // Per-cell readout only while the board is focused: from the home view a
        // cell is about two pixels wide, and a readout would just chase the pointer.
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
