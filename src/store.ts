import { create } from 'zustand'
import { HOTSPOTS, SCREENS } from './content'

const PANELS = new Set(HOTSPOTS.map((h) => h.id))
const SCREEN_IDS = new Set(SCREENS.map((s) => s.id))

/**
 * The page has two mutually exclusive focused modes, both of which live in the
 * URL so that browser back closes them and a view can be linked to.
 *
 *   #/work            a content panel
 *   #/screen/nodex    a monitor, framed dead-on, no panel
 */
type Route =
  | { kind: 'home' }
  | { kind: 'panel'; id: string }
  | { kind: 'screen'; id: string }

const readRoute = (): Route => {
  const raw = window.location.hash.replace(/^#\/?/, '')
  if (!raw) return { kind: 'home' }
  const screen = raw.match(/^screen\/(.+)$/)
  if (screen && SCREEN_IDS.has(screen[1])) return { kind: 'screen', id: screen[1] }
  if (PANELS.has(raw)) return { kind: 'panel', id: raw }
  return { kind: 'home' }
}

const hashFor = (r: Route) =>
  r.kind === 'panel' ? `#/${r.id}` : r.kind === 'screen' ? `#/screen/${r.id}` : ''

const push = (r: Route) => {
  const next = hashFor(r)
  const current = window.location.hash
  if (current === next) return
  window.history.pushState(null, '', next || window.location.pathname)
}

interface SceneState {
  /** Hotspot id whose panel is open, or null. */
  focus: string | null
  /** Screen id currently framed, or null. Never set alongside `focus`. */
  screen: string | null
  /** Hotspot, link or screen id under the pointer. */
  hover: string | null
  /** GLB finished loading and the intro camera move has played. */
  ready: boolean
  /** User has dragged or zoomed at least once; hides the affordance hint. */
  orbited: boolean
  setFocus: (id: string | null) => void
  setScreen: (id: string | null) => void
  setHover: (id: string | null) => void
  setReady: (v: boolean) => void
  setOrbited: (v: boolean) => void
  /** Leave whichever focused mode is active. */
  clearFocus: () => void
}

const initial = typeof window === 'undefined' ? ({ kind: 'home' } as Route) : readRoute()

export const useScene = create<SceneState>((set, get) => ({
  focus: initial.kind === 'panel' ? initial.id : null,
  screen: initial.kind === 'screen' ? initial.id : null,
  hover: null,
  ready: false,
  orbited: false,

  setFocus: (id) => {
    const next = id && PANELS.has(id) ? id : null
    push(next ? { kind: 'panel', id: next } : { kind: 'home' })
    // Opening a panel leaves any framed screen; the two cannot both be active.
    set({ focus: next, screen: null, hover: null })
  },

  setScreen: (id) => {
    const next = id && SCREEN_IDS.has(id) ? id : null
    push(next ? { kind: 'screen', id: next } : { kind: 'home' })
    set({ screen: next, focus: null })
  },

  setHover: (id) => set({ hover: id }),
  setReady: (v) => set({ ready: v }),
  setOrbited: (v) => set({ orbited: v }),

  clearFocus: () => {
    const { focus, screen } = get()
    if (focus === null && screen === null) return
    push({ kind: 'home' })
    set({ focus: null, screen: null })
  },
}))

/**
 * One owner for the pointer cursor.
 *
 * Room hotspots, wall links and screens all write `hover`, so a single rule
 * covers them. Managing it inside each of those components instead meant
 * several effects racing to set and clear it on the same state change.
 */
export const bindCursor = () => {
  const unsub = useScene.subscribe((s) => {
    document.body.style.cursor = s.hover ? 'pointer' : 'auto'
  })
  return () => {
    unsub()
    document.body.style.cursor = 'auto'
  }
}

/** Keep browser back/forward in sync with whichever mode is focused. */
export const bindHistory = () => {
  const sync = () => {
    const r = readRoute()
    useScene.setState({
      focus: r.kind === 'panel' ? r.id : null,
      screen: r.kind === 'screen' ? r.id : null,
    })
  }
  window.addEventListener('popstate', sync)
  return () => window.removeEventListener('popstate', sync)
}

// Dev-only handle for the verification scripts. They used to locate objects by
// scraping the hover readout out of the DOM; with that gone, they read the
// state directly. Stripped from production builds.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__hover = () =>
    useScene.getState().hover
}

/** Escape leaves any focused mode, from anywhere on the page. */
export const bindEscape = () => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') useScene.getState().clearFocus()
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
