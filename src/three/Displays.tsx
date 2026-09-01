import { useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'

/**
 * Displays laid over the monitor panels in the room.
 *
 * The three screens are merged into `hot_screens` at export, so an individual
 * panel cannot be addressed or re-textured directly. Instead each display is an
 * independent plane placed exactly over its panel, using world-space geometry
 * measured by tools/find_screens.py. That also sidesteps the source asset's UVs,
 * which survived the join in no useful state.
 *
 * Placement is in glTF space (Y up), matching src/scene-manifest.json.
 */
interface DisplayDef {
  /** Source object in the .blend, for traceability back to find_screens.py. */
  source: string
  src: string
  centre: [number, number, number]
  normal: [number, number, number]
  width: number
  height: number
}

const DISPLAYS: DisplayDef[] = [
  {
    // Leftmost panel as seen from the default camera. Confirmed by projecting
    // each screen centre onto the camera's right vector.
    //
    // Normal is negated from what find_screens.py reports. Blender's polygon
    // normal on these panels points into the back wall, away from the chair, so
    // using it verbatim buried the plane inside the monitor and backface-culled
    // it. A screen faces the room, which is +z in glTF here.
    source: 'Plane.033',
    src: '/nodex-screenshot.png',
    centre: [-0.1345, 1.302, -1.1292],
    normal: [0.7371, 0, 0.6758],
    width: 1.3661,
    height: 0.5689,
  },
]

/** Lift off the panel surface so the two planes do not z-fight. */
const LIFT = 0.006

function Display({ display }: { display: DisplayDef }) {
  const texture = useTexture(display.src)

  const { position, quaternion } = useMemo(() => {
    const n = new THREE.Vector3(...display.normal).normalize()
    const p = new THREE.Vector3(...display.centre).addScaledVector(n, LIFT)
    // A plane's own normal is +Z, so rotate that onto the panel normal. The
    // panel normals are horizontal, which makes this a pure yaw and leaves the
    // image the right way up without needing an explicit roll.
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      n,
    )
    return { position: p, quaternion: q }
  }, [display])

  useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    texture.needsUpdate = true
  }, [texture])

  return (
    <mesh
      position={position}
      quaternion={quaternion}
      // Invisible to picking, so the click still resolves to the merged
      // `hot_screens` node and opens the Work panel.
      raycast={() => null}
    >
      <planeGeometry args={[display.width, display.height]} />
      {/* Unlit and untonemapped: a monitor emits its own light, and letting the
          scene's dim key wash over it would make the page unreadable. */}
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  )
}

export function Displays() {
  return (
    <>
      {DISPLAYS.map((d) => (
        <Display key={d.source} display={d} />
      ))}
    </>
  )
}

DISPLAYS.forEach((d) => useTexture.preload(d.src))
