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

interface PixelState {
  data: PixelPayload | null
  /** Set once a fetch has completed, successfully or not. */
  settled: boolean
  error: string | null
  /** Index of the slot happening now, or -1. Recomputed on every tick. */
  live: number
}

export const usePixels = create<PixelState>(() => ({
  data: null,
  settled: false,
  error: null,
  live: -1,
}))

async function poll(signal: AbortSignal) {
  try {
    const res = await fetch('/api/pixels', { signal })
    if (!res.ok) throw new Error(`proxy responded ${res.status}`)
    const json = await res.json()
    // Validated again on this side. The proxy already checked, but the board
    // indexes arrays by winner value and reads slot counts as loop bounds; a
    // shape surprise here is an exception inside the render tree.
    validate(json)
    usePixels.setState({
      data: json,
      settled: true,
      error: null,
      live: liveSlot(json),
    })
  } catch (err) {
    if (signal.aborted) return
    const why = err instanceof Error ? err.message : String(err)
    // Keep whatever we last had. A transient blip should not blank a board that
    // is already showing six weeks of correct history.
    usePixels.setState((s) => ({ ...s, settled: true, error: why }))
  }
}

/**
 * Start polling. Returns a teardown, matching the bind* convention used by the
 * store and audio modules.
 */
export function bindPixels() {
  const ac = new AbortController()
  void poll(ac.signal)

  const id = window.setInterval(() => {
    // Recompute the live slot every tick even if the payload has not changed:
    // the grid advances an hour at a time on its own, and a visitor who leaves
    // the page open should watch the live cell move rather than stick.
    const { data } = usePixels.getState()
    if (data) usePixels.setState({ live: liveSlot(data) })
    void poll(ac.signal)
  }, POLL_MS)

  // Polling a hidden tab burns the visitor's battery to update pixels nobody is
  // looking at. Catch up immediately on return so the board is never stale in
  // front of someone.
  const onVisible = () => {
    if (document.visibilityState === 'visible') void poll(ac.signal)
  }
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    ac.abort()
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
