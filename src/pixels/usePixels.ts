import { create } from 'zustand'
import { validate, liveSlot, type PixelPayload } from '../shared/pixels'

/**
 * Live activity data for the wall boards, from the proxy's `/api/pixels`.
 *
 * No failure here ever throws: a board that fails to light is still a wall
 * panel, but an error inside the R3F tree takes the whole canvas down.
 */

/**
 * Just over the proxy's 9s cache, so Argus sees about one call per interval
 * however many visitors are polling.
 */
const POLL_MS = 10_000

/** Which cell the pointer is over, and where to put its readout. */
export interface PixelHover {
  slot: number
  /** Viewport coords, captured when the pointer entered this cell. */
  x: number
  y: number
}

interface PixelState {
  data: PixelPayload | null
  /** Index of the slot happening now, or -1. Recomputed on every tick. */
  live: number
  /** Non-null only while the board is focused and the pointer is on a cell. */
  hover: PixelHover | null
}

export const usePixels = create<PixelState>(() => ({
  data: null,
  live: -1,
  hover: null,
}))

/**
 * Record which cell the pointer is over, keeping the position where it entered
 * the cell. A cell is ~20 screen pixels, so the readout still reads as attached,
 * at one render per cell rather than one per pointer move.
 */
export function setPixelHover(next: PixelHover | null) {
  const cur = usePixels.getState().hover
  if (cur?.slot === next?.slot) return
  usePixels.setState({ hover: next })
}

async function poll(signal: AbortSignal) {
  try {
    const res = await fetch('/api/pixels', { signal })
    if (!res.ok) throw new Error(`proxy responded ${res.status}`)
    const json = await res.json()
    // Checked again despite the proxy: the boards index by winner and loop on
    // slotCount, so a bad shape would throw inside the render tree.
    validate(json)
    usePixels.setState({ data: json, live: liveSlot(json) })
  } catch {
    // Keep the last good payload through a transient failure; a board that never
    // lit is the designed state when the proxy is down or unconfigured. The proxy
    // logs the cause.
  }
}

/**
 * Start polling. Returns a teardown, matching the bind* convention used by the
 * store and audio modules.
 */
export function bindPixels() {
  const ac = new AbortController()
  void poll(ac.signal)

  const tick = () => {
    // The live slot advances with the clock, not the payload.
    const { data } = usePixels.getState()
    if (data) usePixels.setState({ live: liveSlot(data) })
    void poll(ac.signal)
  }

  const id = window.setInterval(() => {
    // A hidden tab would spend battery and a proxy hit on pixels nobody sees;
    // onVisible catches up when it is shown.
    if (document.visibilityState !== 'visible') return
    tick()
  }, POLL_MS)

  // Catch up on return, live slot included: the tab may have been hidden for hours.
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick()
  }
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    ac.abort()
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
