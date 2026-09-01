import { useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import { type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { SCREENS, type Screen as ScreenDef } from '../content'
import { useScene } from '../store'
import { orbit } from './orbit'

/**
 * The three monitor panels, as independently interactive surfaces.
 *
 * They are merged into `hot_screens` in the GLB, so no individual panel can be
 * addressed as a node, and the source UVs did not survive the join. Each screen
 * is instead an independent plane placed over its panel from world geometry
 * measured by tools/find_screens.py.
 *
 * Interaction is two-stage. The first click frames the screen dead-on; a second
 * click on an already-framed screen opens its link. A single click that
 * navigated off-site would be far too easy to hit by accident while looking
 * around a room, and the framed state gives the second click an unambiguous
 * target.
 */

/** Sit just proud of the panel so the two planes do not z-fight. */
const LIFT = 0.006

function orientation(screen: ScreenDef) {
  const n = new THREE.Vector3(...screen.normal).normalize()
  const position = new THREE.Vector3(...screen.centre).addScaledVector(n, LIFT)
  // A plane's own normal is +Z, so rotate that onto the panel normal. These
  // normals are horizontal, which makes it a pure yaw and leaves the image the
  // right way up without an explicit roll.
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    n,
  )
  return { position, quaternion }
}

/** The picture on a screen. Separate component so the hook is unconditional. */
function ScreenImage({ screen }: { screen: ScreenDef }) {
  const texture = useTexture(screen.image!)
  const { position, quaternion } = useMemo(() => orientation(screen), [screen])

  useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    texture.needsUpdate = true
  }, [texture])

  return (
    <mesh
      position={position}
      quaternion={quaternion}
      // The hit plane in front owns picking; this one only draws.
      raycast={() => null}
    >
      <planeGeometry args={[screen.width, screen.height]} />
      {/* Unlit and untonemapped: a monitor emits its own light, and letting the
          scene's deliberately dim key wash over it makes the page unreadable. */}
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  )
}

function ScreenHit({ screen }: { screen: ScreenDef }) {
  const focused = useScene((s) => s.screen)
  const setScreen = useScene((s) => s.setScreen)
  const setHover = useScene((s) => s.setHover)
  const { quaternion } = useMemo(() => orientation(screen), [screen])

  // Slightly in front of the image so it always wins the raycast.
  const hitPos = useMemo(() => {
    const n = new THREE.Vector3(...screen.normal).normalize()
    return new THREE.Vector3(...screen.centre).addScaledVector(n, LIFT + 0.004)
  }, [screen])

  return (
    <mesh
      position={hitPos}
      quaternion={quaternion}
      onPointerMove={(e) => {
        // The room's own move handler sits behind this and resolves the wall,
        // which would clear the hover every frame if it were allowed to run.
        e.stopPropagation()
        setHover(screen.id)
      }}
      onPointerOut={() => setHover(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation()
        // Ending an orbit drag on a screen must neither reframe nor navigate.
        if (orbit.suppressClick) return
        if (focused !== screen.id) {
          setScreen(screen.id)
        } else if (screen.href) {
          window.open(screen.href, '_blank', 'noopener,noreferrer')
        }
      }}
    >
      <planeGeometry args={[screen.width, screen.height]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  )
}

export function Screens() {
  return (
    <>
      {SCREENS.map((s) => (
        <ScreenHit key={s.id} screen={s} />
      ))}
      {SCREENS.filter((s) => s.image).map((s) => (
        <ScreenImage key={`img-${s.id}`} screen={s} />
      ))}
    </>
  )
}

SCREENS.forEach((s) => {
  if (s.image) useTexture.preload(s.image)
})
