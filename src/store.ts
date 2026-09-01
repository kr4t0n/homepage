import { create } from 'zustand'
import { HOTSPOTS } from './content'

const VALID = new Set(HOTSPOTS.map((h) => h.id))

const readHash = (): string | null => {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return VALID.has(raw) ? raw : null
}

interface SceneState {
  /** Hotspot id currently focused, or null for the home view. */
  focus: string | null
  /** Hotspot id under the pointer. */
  hover: string | null
  /** GLB finished loading and the intro camera move has played. */
  ready: boolean
  /** User has dragged or zoomed at least once; hides the affordance hint. */
  orbited: boolean
  setFocus: (id: string | null) => void
  setHover: (id: string | null) => void
  setReady: (v: boolean) => void
  setOrbited: (v: boolean) => void
}

export const useScene = create<SceneState>((set) => ({
  focus: typeof window === 'undefined' ? null : readHash(),
  hover: null,
  ready: false,
  orbited: false,
  setFocus: (id) => {
    const next = id && VALID.has(id) ? id : null
    const hash = next ? `#/${next}` : ' '
    if (readHash() !== next) {
      window.history.pushState(null, '', next ? hash : window.location.pathname)
    }
    set({ focus: next, hover: null })
  },
  setHover: (id) => set({ hover: id }),
  setReady: (v) => set({ ready: v }),
  setOrbited: (v) => set({ orbited: v }),
}))

/** Keep browser back/forward in sync with the focused hotspot. */
export const bindHistory = () => {
  const sync = () => useScene.setState({ focus: readHash() })
  window.addEventListener('popstate', sync)
  return () => window.removeEventListener('popstate', sync)
}
