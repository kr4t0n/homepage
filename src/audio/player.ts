import { create } from 'zustand'
import gsap from 'gsap'
import { MANIFEST, parseTrack, type Track } from './track'

/**
 * The room's backing track.
 *
 * An HTMLAudioElement rather than Web Audio: decoding a four-minute file into an
 * AudioBuffer costs ~100 MB and waits for the whole body, while the element
 * starts on the first packets. `available` false is a fresh clone's normal
 * state, not an error. `on` is the only user state, written by both controls.
 */

/** Playing at full tilt while someone explores the room is obnoxious; this is a bed. */
const TARGET_VOLUME = 0.42

/** Volume while the Music panel is open, so the playable keys stay audible. */
const DUCKED_VOLUME = 0.1

const FADE = 1.6

const PREF_KEY = 'kr4t0n:music'

interface PlayerState {
  /** False when there is no valid manifest, or its audio failed to load. */
  available: boolean
  /** The manifest once it has loaded; null before that and when there is none. */
  track: Track | null
  /**
   * The visitor's intent, persisted across visits. Distinct from `playing`:
   * between load and the first gesture the intent is yes and the browser's
   * answer is still no.
   */
  on: boolean
  /** Whether sound is actually coming out right now. */
  playing: boolean
  /** Seconds. Updated ~4x/sec, and only ever read by the open mini-player. */
  time: number
  duration: number
  setOn: (v: boolean) => void
  seek: (seconds: number) => void
}

let el: HTMLAudioElement | null = null

/** Volume lives on this proxy so GSAP owns the ramp and never fights itself. */
const level = { v: 0 }

const readPref = () => {
  try {
    return window.localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    // Safari private mode throws on localStorage access.
    return true
  }
}

const fadeTo = (v: number, done?: () => void) => {
  gsap.killTweensOf(level)
  gsap.to(level, {
    v,
    duration: FADE,
    ease: 'sine.inOut',
    onUpdate: () => {
      if (el) el.volume = Math.max(0, Math.min(1, level.v))
    },
    onComplete: done,
  })
}

/**
 * Make the element audible and start it, in that order, synchronously.
 *
 * No fade-in: WebKit lets volume-0 media play, then pauses it once it becomes
 * audible outside a gesture, and a GSAP tick is never a gesture. iOS Safari
 * ignores `volume` writes anyway.
 */
const playAudible = () => {
  if (!el) return Promise.reject(new Error('no element'))
  gsap.killTweensOf(level)
  level.v = TARGET_VOLUME
  el.volume = TARGET_VOLUME
  return el.play()
}

export const usePlayer = create<PlayerState>((set, get) => ({
  available: true,
  track: null,
  on: typeof window === 'undefined' ? true : readPref(),
  playing: false,
  time: 0,
  // The element reports the real length on loadedmetadata, which lands well
  // before anyone can open the decks.
  duration: 0,

  setOn: (v) => {
    set({ on: v })
    try {
      window.localStorage.setItem(PREF_KEY, v ? 'on' : 'off')
    } catch {
      /* non-fatal */
    }
    if (!el || !get().available) return
    if (v) {
      void playAudible().catch(() => {})
    } else {
      // Fade rather than cut, then pause once silent. Ramping *down* is safe
      // outside a gesture; only becoming audible is restricted.
      fadeTo(0, () => el?.pause())
    }
  },

  seek: (seconds) => {
    if (!el || !Number.isFinite(el.duration)) return
    el.currentTime = Math.max(0, Math.min(el.duration, seconds))
    set({ time: el.currentTime })
  },
}))

/**
 * Start the track at once, since a returning visitor with media engagement may
 * autoplay, and otherwise on the first gesture of any kind. There is no
 * click-to-enter, so exploring the room is that gesture.
 */
const attach = (track: Track) => {
  el = new Audio(track.src)
  el.loop = true
  el.preload = 'auto'
  el.volume = 0

  const onTime = () => usePlayer.setState({ time: el?.currentTime ?? 0 })
  const onMeta = () => {
    if (el && Number.isFinite(el.duration)) {
      usePlayer.setState({ duration: el.duration })
    }
  }
  const onPlay = () => usePlayer.setState({ playing: true })
  const onPause = () => usePlayer.setState({ playing: false })
  const onError = () => usePlayer.setState({ available: false, playing: false })

  el.addEventListener('timeupdate', onTime)
  el.addEventListener('loadedmetadata', onMeta)
  el.addEventListener('play', onPlay)
  el.addEventListener('pause', onPause)
  el.addEventListener('error', onError)

  let disarm = () => {}

  const start = () => {
    const { on, available } = usePlayer.getState()
    if (!el || !on || !available) return
    void playAudible()
      .then(() => {
        // `play()` resolves after the gesture that unblocked it, and that
        // gesture may have been a request to stop.
        if (!usePlayer.getState().on) {
          el?.pause()
          return
        }
        disarm()
      })
      .catch(() => {
        /* Blocked. The gesture listeners below are still armed. */
      })
  }

  // `mousedown` and `click` back up `pointerdown` for WebKit before Safari 13,
  // which has no Pointer Events. Repeat calls are harmless: `play()` on a
  // playing element resolves as a no-op.
  const EVENTS = ['pointerdown', 'mousedown', 'click', 'keydown', 'wheel', 'touchstart'] as const
  const onGesture = () => start()
  disarm = () => EVENTS.forEach((e) => window.removeEventListener(e, onGesture))
  EVENTS.forEach((e) => window.addEventListener(e, onGesture, { passive: true }))

  start()

  return () => {
    disarm()
    el?.removeEventListener('timeupdate', onTime)
    el?.removeEventListener('loadedmetadata', onMeta)
    el?.removeEventListener('play', onPlay)
    el?.removeEventListener('pause', onPause)
    el?.removeEventListener('error', onError)
    gsap.killTweensOf(level)
    el?.pause()
    el = null
  }
}

/**
 * Load the manifest, then attach the track it names.
 *
 * `no-cache` so a song swapped on the volume shows on the next load; the audio
 * and cover need no such care, as a new song arrives under a new file name. The
 * abort stops StrictMode's double mount in dev from attaching two elements.
 */
export const bindTrack = () => {
  const ctrl = new AbortController()
  let detach = () => {}

  const none = () => usePlayer.setState({ available: false, track: null })

  fetch(MANIFEST, { cache: 'no-cache', signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((json: unknown) => {
      if (ctrl.signal.aborted) return
      const track = parseTrack(json)
      if (!track) return none()
      usePlayer.setState({ track })
      detach = attach(track)
    })
    .catch(() => {
      if (!ctrl.signal.aborted) none()
    })

  return () => {
    ctrl.abort()
    detach()
  }
}

/**
 * Duck the bed while the playable keys are open.
 *
 * Without this the track and the synth compete at the same level and the keys
 * stop sounding like an instrument.
 */
export const duckTrack = (ducked: boolean) => {
  const { playing, on } = usePlayer.getState()
  if (!el || !playing || !on) return
  fadeTo(ducked ? DUCKED_VOLUME : TARGET_VOLUME)
}
