import { useEffect, useMemo, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import { type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { HOTSPOTS, PICKABLE_HOTSPOTS, ROOM_HOTSPOTS } from '../content'
import { useScene } from '../store'
import { HIGHLIGHT, highlight } from './highlight'
import { orbit } from './orbit'

const GLB = '/room.glb'


/**
 * Loads the converted diorama and wires the interactive nodes.
 *
 * The exporter merges every object into one mesh per semantic group and names
 * them `hot_*` / `static_*`, so raycasting is a handful of meshes rather than
 * the 193 unnamed objects the asset shipped with.
 */
export function Room() {
  const { scene } = useGLTF(GLB)
  const hover = useScene((s) => s.hover)
  const setHover = useScene((s) => s.setHover)
  const setFocus = useScene((s) => s.setFocus)

  // Node -> hotspot id, so a raycast hit resolves to content in one lookup.
  const nodeToId = useMemo(() => {
    const m = new Map<string, string>()
    // Only pickable ones: the monitors are handled by Screens.tsx.
    PICKABLE_HOTSPOTS().forEach((h) => m.set(h.node, h.id))
    return m
  }, [])

  /** Original emissive + intensity per material, so hover is reversible. */
  const baseline = useRef(new Map<THREE.Material, { color: THREE.Color; intensity: number }>())

  const cloned = useMemo(() => {
    const root = scene.clone(true)

    // Object3D.clone() shares material instances, and the source asset reuses
    // one material across unrelated props. Without per-node copies, hovering
    // the desk also lights up a figurine on the far shelf. Give every
    // interactive node its own materials so the wash stays contained.
    const owned = new Set<string>(ROOM_HOTSPOTS().map((h) => h.node))
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

        // The hex panels, monitors and LED strips were authored as emissive
        // materials. Under tone mapping they need a real intensity to read as
        // light sources rather than as flat pale shapes.
        if (m.emissive.r + m.emissive.g + m.emissive.b > 0.05) {
          m.emissiveIntensity = 2.6
        }

        // Walls and floor are the largest surfaces by far, so they set the
        // overall key. Pulled down to keep the room reading as night.
        if (o.name.startsWith('static_shell')) {
          m.color.multiplyScalar(0.34)
        }

        baseline.current.set(m, {
          color: m.emissive.clone(),
          intensity: m.emissiveIntensity,
        })
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
          const base = baseline.current.get(m)
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
    if (hovered) {
      const node = cloned.getObjectByName(hovered.node)
      if (node) paint(node, true)
    }
  }, [hover, cloned])

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
        setHover(pick(e))
      }}
      onPointerOut={() => setHover(null)}
      onClick={(e) => {
        e.stopPropagation()
        // Releasing an orbit drag over an object should not open it.
        if (orbit.suppressClick) return
        const id = pick(e as unknown as ThreeEvent<PointerEvent>)
        if (id) setFocus(id)
      }}
    >
      <primitive object={cloned} />
    </group>
  )
}

useGLTF.preload(GLB)
