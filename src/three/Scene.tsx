import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { AdaptiveDpr, Preload } from '@react-three/drei'
import * as THREE from 'three'
import { Room } from './Room'
import { Screens } from './Screens'
import { NeonSign } from './NeonSign'
import { CameraDirector } from './CameraDirector'
import { HOME_CAMERA } from '../content'
import { useScene } from '../store'

/**
 * The asset ships with no baked lighting and no textures, so the scene is lit
 * cheaply and deliberately.
 *
 * Kept deliberately dim: the flat base colours blow out to pale grey under
 * anything brighter, which loses the navy the room is built around. The
 * emissive hex panels and monitors carry the accent light instead, which is
 * free and matches how the room was authored.
 */
function Lighting() {
  return (
    <>
      <ambientLight intensity={0.18} color="#7c92cc" />
      <directionalLight position={[7, 10, 7]} intensity={0.75} color="#cdd9ff" />
      <directionalLight position={[-6, 3, -2]} intensity={0.12} color="#9ef01a" />
    </>
  )
}

export function Scene() {
  const focus = useScene((s) => s.focus)
  const screen = useScene((s) => s.screen)
  const clearFocus = useScene((s) => s.clearFocus)
  const setReady = useScene((s) => s.setReady)

  return (
    <Canvas
      // Clamped DPR: retina phones otherwise render 3x the pixels for no
      // perceptible gain on a scene this flat-shaded.
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 0.72
        setReady(true)
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
      <AdaptiveDpr pixelated />
    </Canvas>
  )
}
