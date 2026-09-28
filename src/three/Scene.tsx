import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Preload } from '@react-three/drei'
import * as THREE from 'three'
import { Room } from './Room'
import { Screens } from './Screens'
import { NeonSign } from './NeonSign'
import { CameraDirector } from './CameraDirector'
import { HOME_CAMERA } from '../content'
import { useScene } from '../store'
import {
  ACCENT_COLOUR,
  FILL_COLOUR,
  GROUND,
  KEY_COLOUR,
  SKY,
  lighting,
} from './lighting'

/**
 * The asset ships with no baked lighting and no textures, so the scene is lit
 * cheaply and deliberately. Values live in ./lighting, with the reasoning.
 *
 * Still dim overall: the flat base colours blow out to pale grey under a
 * brighter key, which loses the navy the room is built around. The extra light
 * here is fill rather than key, which is what three.js is missing relative to
 * the offline renders.
 */
function Lighting() {
  return (
    <>
      <ambientLight intensity={lighting.ambient} color={SKY} />
      <hemisphereLight args={[SKY, GROUND, lighting.hemi]} />
      <directionalLight
        position={[7, 10, 7]}
        intensity={lighting.key}
        color={KEY_COLOUR}
      />
      <directionalLight
        position={[-5, 4, 8]}
        intensity={lighting.fill}
        color={FILL_COLOUR}
      />
      <directionalLight
        position={[-6, 3, -2]}
        intensity={lighting.accent}
        color={ACCENT_COLOUR}
      />
    </>
  )
}

export function Scene() {
  const focus = useScene((s) => s.focus)
  const screen = useScene((s) => s.screen)
  const clearFocus = useScene((s) => s.clearFocus)

  return (
    <Canvas
      // Clamped DPR: retina phones otherwise render 3x the pixels for no
      // perceptible gain on a scene this flat-shaded.
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = lighting.exposure
      }}
      camera={{ position: HOME_CAMERA.position, fov: 34, near: 0.1, far: 200 }}
      // Clicking past everything interactive returns to the home view.
      onPointerMissed={() => clearFocus()}
    >
      <color attach="background" args={['#070a12']} />
      <fog attach="fog" args={['#070a12', 18, 40]} />
      <Lighting />
      <Suspense fallback={null}>
        <Room />
        <Screens />
        <NeonSign />
        <Preload all />
      </Suspense>
      <CameraDirector
        focus={focus}
        screen={screen}
        idle={focus === null && screen === null}
      />
    </Canvas>
  )
}
