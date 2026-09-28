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

    // Every material in the clone is a copy, so nothing below can write into
    // the cached GLTF. Object3D.clone() shares material instances with it, and
    // the adjustments that follow are in-place edits. Under <StrictMode> this
    // memo runs twice in development, so while only hotspots were copied, both
    // runs edited the same cached materials and every other surface got the
    // wall-and-floor darkening twice: dev rendered the floor at rgb(19,25,37)
    // against production's rgb(52,63,88), from the first commit onwards, in the
    // environment lighting.ts is tuned in. A hot reload of this file compounded
    // it again, because the cache outlives the module.
    //
    // How the copies are made is load-bearing for production, which only ever
    // ran this once and must render exactly as it did. The roughness lift below
    // runs once per mesh, so a material shared by k meshes has always been
    // lifted k times; sharing has to survive the copy. Hotspot meshes get one
    // copy per mesh, as they always have, which also gives the wall boards
    // their own materials to write live emissive into. Everything else gets one
    // copy per material, shared by exactly the meshes that shared the original.
    //
    // The order the copies are made in is load-bearing too. three.js sorts
    // opaque draws by material id, and where two surfaces are exactly coplanar
    // the one drawn last wins the pixel. Copying in traversal order renumbered
    // the room and flipped a coplanar pixel on the desk in production. So the
    // copies are made to keep the old relative order: shared copies first, in
    // the originals' own id order, then hotspot copies in the order they were
    // always made. Measured against the previous build, the home view is
    // pixel-identical.
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
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => m.clone())
        : o.material.clone()
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
