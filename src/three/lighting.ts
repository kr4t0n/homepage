import * as THREE from 'three'

/**
 * Scene light rig.
 *
 * three.js has no global illumination. Cycles renders this asset correctly
 * under an equivalent-looking rig because its world light wraps the scene and
 * the floor bounces; three.js gives you only what you place. With a single key
 * and a flat ambient, anything not facing that key crushes to black, which is
 * how the DJ controller ended up reading as a slab with glowing dots on it.
 *
 * The answer is fill, not a brighter key: a hemisphere term standing in for
 * sky-and-floor, plus a weak bounce light from the opposite side. Raising the
 * key instead blows out the flat base colours, which is the failure the very
 * first version of this scene had.
 *
 * Tune by editing these numbers with the dev server running: they are React
 * props and a runtime handle would not re-apply them, so HMR is the loop.
 * Check the home view and a focused hotspot together, since fill that reads
 * well up close can wash out the wide shot.
 */
export const lighting = {
  /** Uniform floor under everything. Keep low; it flattens if pushed. */
  ambient: 0.26,
  /** Sky/ground fill, the stand-in for the missing environment. */
  hemi: 0.5,
  /** The single key, high and to one side. */
  key: 0.8,
  /** Weak bounce from the opposite side, so far faces are not pure black. */
  fill: 0.22,
  /** Accent spill, tying the room to the acid green. */
  accent: 0.12,
  exposure: 0.78,
}

export const SKY = new THREE.Color('#8ea6e8')
export const GROUND = new THREE.Color('#141b2d')
export const KEY_COLOUR = new THREE.Color('#cdd9ff')
export const FILL_COLOUR = new THREE.Color('#9fb0d8')
export const ACCENT_COLOUR = new THREE.Color('#9ef01a')
