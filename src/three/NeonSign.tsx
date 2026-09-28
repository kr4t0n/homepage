import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { ROOM_LINKS } from '../content'
import { useScene } from '../store'
import { orbit } from './orbit'

/**
 * Neon wordmark on the wall behind the monitors.
 *
 * Drawn to a canvas rather than built from geometry: the room is flat-shaded
 * low-poly, so an extruded tube would be the highest-fidelity object in the
 * scene by a wide margin and would look pasted in. A glowing canvas texture
 * sits at the same level of abstraction as everything else here, and it lets
 * the sign reuse the site's own typeface.
 *
 * Wall plane measured by tools/find_walls.py. The wall is a slab with faces at
 * z -2.10 and z -1.99; as elsewhere in this asset the reported normals are
 * inverted, and the surface actually facing the room is the one at z -1.99. Its
 * span is x -2.09 to 4.49 and y -0.21 to 2.61. Placement is in glTF space.
 */
const TEXT = 'kr4t0n'

/** Accent, matching --color-acid. */
const NEON = '#9ef01a'

/**
 * Brightness controls.
 *
 * `opacity` scales the whole additive contribution, which is the honest knob
 * for "dimmer": the canvas bakes a fixed glow and this attenuates all of it at
 * once. `light` is the spill onto the surrounding wall. Tune with
 * tools/sweep-neon.mjs rather than by guessing; additive blending on a dark
 * wall saturates much faster than it looks like it should.
 */
const neon = { opacity: 0.48, light: 0.4 }

/** The sign is a link. Hovering lifts it toward this multiple of the base. */
const HOVER_GAIN = 1.7

/**
 * Padded, invisible click target.
 *
 * The visible plane is 0.88 x 0.223, which is a small thing to hit on a wall
 * across the room. This gives the pointer somewhere to land without making the
 * glow any bigger. Sized to stay inside the wall (x ends 4.49, y ends 2.61) so
 * it never catches clicks aimed past the room.
 */
const HIT = { width: 0.94, height: 0.36 }

const LINK = ROOM_LINKS.find((l) => l.id === 'neon')!

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__neon = neon
}

const PLACEMENT = {
  // Upper right of the back wall, in the gap above the framed picture.
  //
  // Three things bound this. Circle.022, the pale-disc panel, runs from x -0.66
  // to 3.41 and past the ceiling line, so the sign sits right of it.
  // Plane.006, the framed picture, occupies x 3.48 to 4.73 up to y 1.98, so the
  // sign sits above it. The wall itself ends at x 4.49 and y 2.61.
  //
  // With half-extents of 0.44 and 0.112 that leaves very little slack: the
  // right edge lands 0.03 short of the wall edge and the top edge 0.07 short of
  // the ceiling line. Pushed into that corner deliberately, so the wordmark
  // reads as high and to the right without overhanging anything.
  centre: [4.02, 2.42, -1.976] as [number, number, number],
  width: 0.88,
  height: 0.223,
}

/**
 * Renders the wordmark to a canvas with a layered glow.
 *
 * Several increasingly tight shadow passes build the halo, then a near-white
 * core goes on top: a real tube reads as white-hot in the middle with the gas
 * colour bleeding outward, and painting it flat accent looks like a sticker.
 */
function useNeonTexture(text: string, color: string) {
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null)

  useEffect(() => {
    let cancelled = false
    let made: THREE.CanvasTexture | null = null

    const draw = async () => {
      // The site's own webfont has to be resolved before measuring or drawing,
      // otherwise the canvas silently falls back to a system monospace.
      if (document.fonts?.ready) await document.fonts.ready
      if (cancelled) return

      const W = 1024
      const H = 260
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      ctx.clearRect(0, 0, W, H)
      ctx.font = '600 132px "Geist Mono Variable", ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'

      const cx = W / 2
      const cy = H / 2 + 4

      // Outer halo through to inner glow.
      ctx.shadowColor = color
      for (const [blur, alpha, lw] of [
        [46, 0.16, 13],
        [28, 0.24, 10],
        [15, 0.38, 7],
        [8, 0.55, 4.5],
      ] as const) {
        ctx.shadowBlur = blur
        ctx.globalAlpha = alpha
        ctx.strokeStyle = color
        ctx.lineWidth = lw
        ctx.strokeText(text, cx, cy)
      }

      // Hot core.
      ctx.globalAlpha = 0.9
      ctx.shadowBlur = 8
      ctx.strokeStyle = '#d8f7a8'
      ctx.lineWidth = 2
      ctx.strokeText(text, cx, cy)
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1
      ctx.fillStyle = '#edffd4'
      ctx.fillText(text, cx, cy)

      if (cancelled) return
      made = new THREE.CanvasTexture(canvas)
      made.colorSpace = THREE.SRGBColorSpace
      made.anisotropy = 8
      made.needsUpdate = true
      setTexture(made)
    }

    void draw()
    return () => {
      cancelled = true
      made?.dispose()
    }
  }, [text, color])

  return texture
}

export function NeonSign() {
  const texture = useNeonTexture(TEXT, NEON)
  const light = useRef<THREE.PointLight>(null)
  const material = useRef<THREE.MeshBasicMaterial>(null)
  const hover = useScene((s) => s.hover)
  const setHover = useScene((s) => s.setHover)
  const hovered = hover === LINK.id
  /** Eased 0..1 hover amount, so the lift is not a hard switch. */
  const lift = useRef(0)

  const { position, quaternion } = useMemo(() => {
    // The wall's normal is +z, so the sign faces straight out into the room and
    // needs no rotation beyond the plane's default orientation.
    const p = new THREE.Vector3(...PLACEMENT.centre)
    return { position: p, quaternion: new THREE.Quaternion() }
  }, [])

  const reduce = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  // Gas tubes are never perfectly steady. This is a slow, shallow wobble on the
  // spill light only, not a broken-sign stutter, and it is off under reduced
  // motion. The sign texture itself never changes.
  useFrame((_, dt) => {
    // Ease toward the hover state rather than snapping, so brushing past the
    // sign does not strobe it. Frame-rate independent.
    const want = hovered ? 1 : 0
    lift.current = THREE.MathUtils.lerp(
      lift.current,
      want,
      reduce ? 1 : 1 - Math.pow(0.002, dt),
    )
    const gain = 1 + (HOVER_GAIN - 1) * lift.current

    if (material.current) {
      material.current.opacity = Math.min(1, neon.opacity * gain)
    }
    if (!light.current) return
    if (reduce) {
      light.current.intensity = neon.light * gain
      return
    }
    const t = performance.now() / 1000
    const wobble = 0.92 + Math.sin(t * 2.3) * 0.05 + Math.sin(t * 7.1) * 0.03
    light.current.intensity = neon.light * gain * wobble
  })

  if (!texture) return null

  return (
    <group>
      {/* Click target. Separate from the glow so the hit area can be padded
          without enlarging what is drawn. */}
      <mesh
        position={[
          PLACEMENT.centre[0],
          PLACEMENT.centre[1],
          PLACEMENT.centre[2] + 0.004,
        ]}
        quaternion={quaternion}
        onPointerMove={(e) => {
          // Stops the room's own move handler, which sits behind this and would
          // otherwise resolve the wall and immediately clear the hover.
          e.stopPropagation()
          setHover(LINK.id)
        }}
        onPointerOut={() => setHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          // Ending an orbit drag on the sign must not navigate away. Losing the
          // page is a worse accident than opening the wrong panel.
          if (orbit.suppressClick) return
          window.open(LINK.href, '_blank', 'noopener,noreferrer')
        }}
      >
        <planeGeometry args={[HIT.width, HIT.height]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <mesh
        position={position}
        quaternion={quaternion}
        // The padded mesh above owns picking; this one just draws.
        raycast={() => null}
      >
        <planeGeometry args={[PLACEMENT.width, PLACEMENT.height]} />
        {/* Additive so the halo builds on the wall behind instead of masking
            it with a dark rectangle. depthWrite off for the same reason. */}
        <meshBasicMaterial
          ref={material}
          map={texture}
          transparent
          opacity={neon.opacity}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* Spill onto the surrounding wall, so the sign looks like it is lighting
          the room rather than being a decal stuck on it. */}
      <pointLight
        ref={light}
        position={[
          PLACEMENT.centre[0],
          PLACEMENT.centre[1],
          PLACEMENT.centre[2] + 0.30,
        ]}
        color={NEON}
        intensity={neon.light}
        distance={2.1}
        decay={2}
      />
    </group>
  )
}
