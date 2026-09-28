import * as THREE from 'three'

/** Accent used for the hover wash. Matches --color-acid in the stylesheet. */
export const HIGHLIGHT = new THREE.Color('#9ef01a')

/**
 * How strongly hover tints an object.
 *
 * `mix` blends the accent into whatever the material already emits rather than
 * replacing it, so a hovered prop still reads as itself and props that glow on
 * their own (screens, light panels) keep their own light. `intensity` is the
 * emissive floor applied to props that do not glow; already-glowing ones keep
 * theirs, via a max rather than an assignment.
 *
 * These values were picked by rendering the sweep in tools/sweep-highlight.mjs
 * against three cases that fail differently: a light prop (the sofa, where a
 * strong wash flattens the cushion forms into a silhouette; no longer a
 * hotspot, so the sweep now hovers the desk), a dark prop (the
 * DJ controller, where too little is invisible), and an emissive prop (the
 * monitors, where replacing emissive kills the glow).
 *
 * Lives in its own module so Room.tsx exports only components and fast refresh
 * keeps working.
 */
export const highlight = { mix: 0.28, intensity: 0.15 }

// Dev-only handle for the tuning sweep. Stripped from production builds.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__highlight = highlight
}
