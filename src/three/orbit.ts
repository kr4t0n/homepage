import * as THREE from 'three'

/**
 * Shared, mutable camera-interaction state.
 *
 * Deliberately not in the zustand store: these values change on every pointer
 * move, and routing them through React state would re-render the tree at
 * pointer frequency. The camera loop reads them directly each frame.
 */
export const orbit = {
  /** User azimuth offset from the authored pose, radians. */
  dTheta: 0,
  /** User polar offset from the authored pose, radians. */
  dPhi: 0,
  /** User zoom as a multiplier on the authored radius. */
  zoom: 1,
  /** True while a drag is in progress, so idle drift pauses. */
  dragging: false,
  /**
   * Set on pointerup when the pointer travelled far enough to count as a drag.
   * Read by the room so releasing a drag over an object does not open it.
   */
  suppressClick: false,
}

/**
 * The diorama has only two walls. Past roughly 50 degrees either side of the
 * authored angle you start seeing through the open sides, so the arc is
 * clamped rather than free.
 */
export const LIMITS = {
  theta: 0.85,
  /** Max polar offset from the authored pose, radians. */
  phi: 0.55,
  /** Absolute polar bounds, measured from +Y. Keeps the camera off the floor
   *  and out of a pure top-down view. */
  phiMin: 0.42,
  phiMax: 1.44,
  zoomMin: 0.42,
  zoomMax: 1.85,
}

export const resetOrbit = () => {
  orbit.dTheta = 0
  orbit.dPhi = 0
  orbit.zoom = 1
  homeView.dTheta = 0
  homeView.dPhi = 0
  homeView.zoom = 1
}

/**
 * The user's orbit on the home view, remembered across a hotspot visit.
 *
 * Focused hotspots are always framed by their authored pose, so the user's
 * orbit is eased out on the way in. Without stashing it first, closing the
 * panel would drop them back at the default angle and silently discard the
 * view they had set up.
 */
export const homeView = { dTheta: 0, dPhi: 0, zoom: 1 }

export const rememberHomeView = () => {
  homeView.dTheta = orbit.dTheta
  homeView.dPhi = orbit.dPhi
  homeView.zoom = orbit.zoom
}

// Dev-only handle so the verification scripts can assert on camera state
// directly instead of inferring it from pixels. Stripped from production
// builds by the bundler along with the branch.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__orbit = { orbit, homeView }
}

/**
 * Wires drag-to-orbit, wheel-to-zoom and pinch-to-zoom onto the canvas.
 * Returns a teardown that removes every listener.
 *
 * `onUse` fires on every meaningful interaction rather than only the first, so
 * that resetting the view and then orbiting again brings the reset control
 * back. The caller is responsible for making repeat calls cheap.
 */
export function attachOrbit(el: HTMLElement, onUse: () => void): () => void {
  const active = new Map<number, { x: number; y: number }>()
  let last = { x: 0, y: 0 }
  let travelled = 0
  let pinchStart = 0
  let pinchZoom = 1

  const spread = () => {
    const pts = [...active.values()]
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
  }

  const down = (e: PointerEvent) => {
    active.set(e.pointerId, { x: e.clientX, y: e.clientY })
    orbit.suppressClick = false
    if (active.size === 1) {
      orbit.dragging = true
      travelled = 0
      last = { x: e.clientX, y: e.clientY }
    } else if (active.size === 2) {
      orbit.dragging = false
      pinchStart = spread()
      pinchZoom = orbit.zoom
    }
  }

  const move = (e: PointerEvent) => {
    if (!active.has(e.pointerId)) return
    active.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (active.size >= 2) {
      const d = spread()
      if (pinchStart > 0) {
        orbit.zoom = THREE.MathUtils.clamp(
          pinchZoom * (pinchStart / d),
          LIMITS.zoomMin,
          LIMITS.zoomMax,
        )
        onUse()
      }
      return
    }
    if (!orbit.dragging) return

    const dx = e.clientX - last.x
    const dy = e.clientY - last.y
    last = { x: e.clientX, y: e.clientY }
    travelled += Math.abs(dx) + Math.abs(dy)

    orbit.dTheta = THREE.MathUtils.clamp(
      orbit.dTheta - dx * 0.0042,
      -LIMITS.theta,
      LIMITS.theta,
    )
    // Clamped at the source as well as at apply time. If it were only clamped
    // when applied, dragging past the limit would bank up offset that has to be
    // unwound before the camera responds to a drag back.
    orbit.dPhi = THREE.MathUtils.clamp(
      orbit.dPhi - dy * 0.0034,
      -LIMITS.phi,
      LIMITS.phi,
    )
    if (travelled > 8) onUse()
  }

  const up = (e: PointerEvent) => {
    active.delete(e.pointerId)
    if (active.size < 2) pinchStart = 0
    if (active.size === 0) {
      orbit.dragging = false
      // A drag that ends over a hotspot should not open it.
      orbit.suppressClick = travelled > 8
    }
  }

  const wheel = (e: WheelEvent) => {
    // The canvas fills the viewport, so the page has nothing to scroll; without
    // this the wheel would bounce the document on some platforms.
    e.preventDefault()
    orbit.zoom = THREE.MathUtils.clamp(
      orbit.zoom * Math.exp(e.deltaY * 0.0011),
      LIMITS.zoomMin,
      LIMITS.zoomMax,
    )
    onUse()
  }

  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  el.addEventListener('wheel', wheel, { passive: false })

  return () => {
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    el.removeEventListener('wheel', wheel)
  }
}
