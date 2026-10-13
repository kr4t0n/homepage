import * as THREE from 'three'

/**
 * Scene light rig. three.js has no global illumination, so the room gets fill (a
 * hemisphere for sky and floor, a weak opposite bounce), never a brighter key,
 * which blows the flat base colours out to pale grey and loses the room's navy.
 *
 * Tune with the dev server running: these are React props, so HMR applies them
 * and a runtime handle would not. Judge the home view and a focused hotspot
 * together, since fill that suits a close-up can wash out the wide shot.
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
