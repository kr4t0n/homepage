import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import gsap from 'gsap'
import * as THREE from 'three'
import manifest from '../scene-manifest.json'
import { HOME_CAMERA, hotspotById, screenById, type Hotspot } from '../content'
import { LIMITS, attachOrbit, homeView, orbit, rememberHomeView } from './orbit'
import { useScene } from '../store'

type ManifestEntry = { node: string; centre: number[]; min: number[]; max: number[] }
const NODES = Object.values(manifest as unknown as Record<string, ManifestEntry>)

/** Look up a hotspot's exported bounding box by its glTF node name. */
const entryFor = (h: Hotspot): ManifestEntry | undefined =>
  NODES.find((n) => n.node === h.node)

/**
 * Authored camera pose, expressed as an orbit rather than a point.
 *
 * Spherical is the important choice here: user drag and zoom manipulate the
 * same three numbers GSAP tweens, so manual control and scripted flights
 * compose instead of overwriting each other.
 */
interface Pose {
  theta: number
  phi: number
  radius: number
  tx: number
  ty: number
  tz: number
}

const _v = new THREE.Vector3()
const _s = new THREE.Spherical()

const poseBetween = (
  pos: readonly [number, number, number] | number[],
  target: readonly [number, number, number] | number[],
): Pose => {
  _v.set(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2])
  _s.setFromVector3(_v)
  return {
    theta: _s.theta,
    phi: _s.phi,
    radius: _s.radius,
    tx: target[0],
    ty: target[1],
    tz: target[2],
  }
}

const poseForHotspot = (id: string | null): Pose | null => {
  const h = hotspotById(id)
  if (!h) return null
  const c = entryFor(h)?.centre ?? [0, 1, 0]
  return poseBetween(
    [c[0] + h.offset[0], c[1] + h.offset[1], c[2] + h.offset[2]],
    [c[0] + h.look[0], c[1] + h.look[1], c[2] + h.look[2]],
  )
}

/** Leaves this much of the frame around a framed screen. */
const SCREEN_MARGIN = 1.32

/**
 * Frames a screen square-on, at whatever distance actually fits it.
 *
 * Derived from the live camera rather than hard-coded, because the limiting
 * dimension flips with the viewport: these panels are 2.4:1, so on a wide
 * window height constrains and on a narrow one width does.
 */
const poseForScreen = (id: string | null, cam: THREE.Camera): Pose | null => {
  const s = screenById(id)
  if (!s) return null
  const p = cam as THREE.PerspectiveCamera
  const vFov = THREE.MathUtils.degToRad(p.fov ?? 34)
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (p.aspect || 1.6))
  const dist =
    Math.max(
      s.width / 2 / Math.tan(hFov / 2),
      s.height / 2 / Math.tan(vFov / 2),
    ) * SCREEN_MARGIN

  const n = new THREE.Vector3(...s.normal).normalize()
  const centre = new THREE.Vector3(...s.centre)
  const eye = centre.clone().addScaledVector(n, dist)
  return poseBetween([eye.x, eye.y, eye.z], [centre.x, centre.y, centre.z])
}

const homePose = () => poseBetween(HOME_CAMERA.position, HOME_CAMERA.target)

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Owns the camera outright.
 *
 * One authored pose, tweened by GSAP on focus change. User orbit and zoom are
 * bounded offsets on top of it; idle drift is a much smaller offset again, and
 * pauses while the user is driving. Nothing else writes camera.position.
 */
export function CameraDirector({
  focus,
  screen,
  idle,
}: {
  focus: string | null
  screen: string | null
  idle: boolean
}) {
  const camera = useThree((s) => s.camera)
  const domEl = useThree((s) => s.gl.domElement)
  const setOrbited = useScene((s) => s.setOrbited)
  const pose = useRef<Pose>(homePose())
  const parallax = useRef(new THREE.Vector2())
  // Previous target, so the effect can tell 'leaving home' from a move between
  // two focused things.
  const prevTarget = useRef<string | null>(focus ?? screen)
  const lookAt = useMemo(() => new THREE.Vector3(), [])

  useEffect(
    () =>
      attachOrbit(domEl, () => {
        // Fires on every drag frame, so only touch the store on transition.
        if (!useScene.getState().orbited) setOrbited(true)
      }),
    [domEl, setOrbited],
  )

  // Pointer parallax target, read in useFrame. Never touches React state.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      parallax.current.set(
        e.clientX / window.innerWidth - 0.5,
        e.clientY / window.innerHeight - 0.5,
      )
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  // Fly to the new pose whenever focus changes.
  //
  // Going into a hotspot eases the user's orbit out so the panel gets its
  // authored framing; coming back out restores whatever view they had set up
  // before, rather than dumping them at the default angle.
  useEffect(() => {
    const target = focus ?? screen
    const leavingHome = prevTarget.current === null && target !== null
    if (leavingHome) rememberHomeView()
    prevTarget.current = target

    const next =
      poseForHotspot(focus) ?? poseForScreen(screen, camera) ?? homePose()
    const orbitTo =
      target === null
        ? { dTheta: homeView.dTheta, dPhi: homeView.dPhi, zoom: homeView.zoom }
        : { dTheta: 0, dPhi: 0, zoom: 1 }

    if (prefersReduced()) {
      Object.assign(pose.current, next)
      Object.assign(orbit, orbitTo)
      return
    }
    const tweens = [
      gsap.to(pose.current, {
        ...next,
        duration: target ? 1.15 : 1.35,
        ease: target ? 'power3.inOut' : 'power2.out',
        overwrite: true,
      }),
      gsap.to(orbit, {
        ...orbitTo,
        duration: 0.9,
        ease: 'power2.out',
        overwrite: true,
      }),
    ]
    return () => tweens.forEach((t) => t.kill())
  }, [focus, screen, camera])

  useFrame((_, dt) => {
    const p = pose.current

    // Idle drift keeps the scene alive, but only on the home view and only
    // when the user is not driving the camera themselves.
    let driftT = 0
    let driftP = 0
    if (idle && !orbit.dragging && !prefersReduced()) {
      const t = performance.now() / 1000
      driftT = Math.sin(t * 0.11) * 0.022 + parallax.current.x * 0.05
      driftP = Math.cos(t * 0.09) * 0.014 - parallax.current.y * 0.03
    }

    const theta = p.theta + orbit.dTheta + driftT
    const phi = THREE.MathUtils.clamp(
      p.phi + orbit.dPhi + driftP,
      LIMITS.phiMin,
      LIMITS.phiMax,
    )
    _s.set(p.radius * orbit.zoom, phi, theta)
    _v.setFromSpherical(_s)

    // Frame-rate independent smoothing toward the resolved pose.
    const k = 1 - Math.pow(0.0015, dt)
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, p.tx + _v.x, k)
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, p.ty + _v.y, k)
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, p.tz + _v.z, k)
    lookAt.set(p.tx, p.ty, p.tz)
    camera.lookAt(lookAt)
  })

  return null
}
