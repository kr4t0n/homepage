import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

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

/** Accent, matching --color-acid and the hover highlight. */
const NEON = '#9ef01a'

const PLACEMENT = {
  // Upper right of the back wall.
  //
  // The wall carries exactly one large decoration, Circle.022, the pale-disc
  // panel that runs from x -0.66 to 3.41 and up past the ceiling line. Right of
  // it the wall is completely bare out to its edge at x 4.49, confirmed by
  // querying every mesh near the wall plane. The sign sits in that gap with a
  // small margin at each side.
  centre: [3.97, 2.04, -1.976] as [number, number, number],
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
        [58, 0.30, 15],
        [34, 0.45, 12],
        [18, 0.75, 9],
        [9, 0.95, 6],
      ] as const) {
        ctx.shadowBlur = blur
        ctx.globalAlpha = alpha
        ctx.strokeStyle = color
        ctx.lineWidth = lw
        ctx.strokeText(text, cx, cy)
      }

      // Hot core.
      ctx.globalAlpha = 1
      ctx.shadowBlur = 12
      ctx.strokeStyle = '#eaffd0'
      ctx.lineWidth = 3
      ctx.strokeText(text, cx, cy)
      ctx.shadowBlur = 0
      ctx.fillStyle = '#f7ffe9'
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
  useFrame(() => {
    if (!light.current || reduce) return
    const t = performance.now() / 1000
    const wobble = 0.92 + Math.sin(t * 2.3) * 0.05 + Math.sin(t * 7.1) * 0.03
    light.current.intensity = 0.85 * wobble
  })

  if (!texture) return null

  return (
    <group>
      <mesh
        position={position}
        quaternion={quaternion}
        // Decor, not a hotspot: stay out of the picking path entirely.
        raycast={() => null}
      >
        <planeGeometry args={[PLACEMENT.width, PLACEMENT.height]} />
        {/* Additive so the halo builds on the wall behind instead of masking
            it with a dark rectangle. depthWrite off for the same reason. */}
        <meshBasicMaterial
          map={texture}
          transparent
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
        intensity={0.85}
        distance={2.3}
        decay={2}
      />
    </group>
  )
}
