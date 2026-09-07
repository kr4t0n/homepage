import { create } from 'zustand'
import { validate, liveSlot, type PixelPayload } from '../shared/pixels'

/**
 * Live activity data for the pixel board.
 *
 * Fetches only `/api/pixels`, never Argus: the credential lives in the proxy and
 * the browser has no way to reach upstream. See src/server/api.ts.
 *
 * Every failure path lands on the same outcome — the board stays unlit and the
 * room is otherwise untouched. A wall panel that fails to light is a wall panel;
 * a thrown error inside the R3F tree takes the whole canvas down with it, which
 * is a far worse trade for a decorative surface.
 */

/**
 * The brief asks for ~10s. The proxy caches for 9s, so most polls are served
 * from memory and only one call per 10s reaches Argus regardless of visitors.
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
 * Record which cell the pointer is over.
 *
 * Only writes when the slot actually changes, never on every pointer move. The
 * position is captured on entry rather than tracked continuously: a cell is
 * about 20 screen pixels, so an anchored readout follows the pointer closely
 * enough while costing one render per cell instead of one per mouse event.
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
    // Validated again on this side. The proxy already checked, but the board
    // indexes arrays by winner value and reads slot counts as loop bounds; a
    // shape surprise here is an exception inside the render tree.
    validate(json)
    usePixels.setState({ data: json, live: liveSlot(json) })
  } catch {
    // Keep whatever we last had. A transient blip should not blank a board that
    // is already showing six weeks of correct history, and a board that never
    // lit is the designed outcome when the proxy is down or unconfigured. The
    // proxy logs the cause server-side; nothing here needs to.
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
    // Recompute the live slot every tick even if the payload has not changed:
    // the grid advances an hour at a time on its own, and a visitor who leaves
    // the page open should watch the live cell move rather than stick.
    const { data } = usePixels.getState()
    if (data) usePixels.setState({ live: liveSlot(data) })
    void poll(ac.signal)
  }

  const id = window.setInterval(() => {
    // Polling a hidden tab burns the visitor's battery and a proxy hit to update
    // pixels nobody is looking at, so the tick is skipped outright. The
    // visibility handler below catches up the moment the tab is shown again.
    if (document.visibilityState !== 'visible') return
    tick()
  }, POLL_MS)

  // Catch up immediately on return, live slot included: the tab may have been
  // hidden for hours, and the first visible frame should not show the live cell
  // where it was when the visitor left.
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
