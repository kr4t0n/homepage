import * as THREE from 'three'

/**
 * The emissive each material should return to when nothing is hovering it.
 *
 * This is shared rather than private to Room.tsx because two things now write
 * emissive: the hover highlight, and the pixel board painting live activity.
 * Room restores *every* material from this map on each hover change, so if the
 * board wrote emissive without updating the baseline, hovering anything in the
 * room would blank the board until the next poll. Whoever paints a lasting
 * colour records it here; hover then washes over it and returns to it.
 */
export const baseline = new Map<
  THREE.Material,
  { color: THREE.Color; intensity: number }
>()

/** Record where a material rests. Clones the colour so later mutation is safe. */
export function setBaseline(m: THREE.Material, color: THREE.Color, intensity: number) {
  baseline.set(m, { color: color.clone(), intensity })
}

/**
 * Drop every entry. Called when the room re-clones its scene: the old materials
 * are garbage by then, and keeping them would pin them in memory across an HMR
 * reload for no benefit.
 */
export function clearBaselines() {
  baseline.clear()
}
