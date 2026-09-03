import { create } from 'zustand'
import gsap from 'gsap'
import { TRACK } from '../content'

/**
 * The room's backing track.
 *
 * Streamed through an HTMLAudioElement rather than the Web Audio API on
 * purpose: decoding a four-minute file into an AudioBuffer costs ~100 MB of
 * resident memory and delays first sound until the whole body has arrived,
 * whereas the element starts on the first few packets and seeks without
 * re-decoding. The synth in `synth.ts` keeps its own AudioContext; the two are
 * independent graphs and mix at the output device.
 *
 * The file itself is gitignored, so `available` going false is a supported
 * state and not an error path — anyone cloning this repo gets a silent room
 * with the player UI honestly reporting that there is no track.
 *
 * There is deliberately one piece of user state, `on`, and not a mute flag as
 * well as a paused flag. Two flags meant the speaker button and the transport
 * button could disagree about the same track: pausing from the decks left the
 * HUD still claiming the sound was on. Both controls now write `on`.
 */

/** Playing at full tilt under the hero copy is obnoxious; this is a bed. */
const TARGET_VOLUME = 0.42

/** Volume while the Music panel is open, so the playable keys stay audible. */
const DUCKED_VOLUME = 0.1

const FADE = 1.6

const PREF_KEY = 'kr4t0n:music'

interface PlayerState {
  /** False when there is no track.mp3 to serve, or it failed to load. */
  available: boolean
  /**
   * The visitor's intent: should this room be playing music. Persisted, so a
   * second visit does not re-litigate a decision already made. Distinct from
   * `playing`, because between load and the first gesture the intent is yes and
   * the browser's answer is still no.
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

export const usePlayer = create<PlayerState>((set, get) => ({
  available: true,
  on: typeof window === 'undefined' ? true : readPref(),
  playing: false,
  time: 0,
  duration: TRACK.seconds,

  setOn: (v) => {
    set({ on: v })
    try {
      window.localStorage.setItem(PREF_KEY, v ? 'on' : 'off')
    } catch {
      /* non-fatal */
    }
    if (!el || !get().available) return
    if (v) {
      void el.play().then(() => fadeTo(TARGET_VOLUME)).catch(() => {})
    } else {
      // Fade rather than cut, then pause once silent.
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
 * Start the track, working with the autoplay policy rather than against it.
 *
 * Chrome and Safari refuse audible playback until the visitor has interacted
 * with the page, and this page has no click-to-enter — the preloader dismisses
 * itself. So: attempt playback immediately, since a returning visitor with
 * media engagement is allowed it, and if the attempt is rejected, wait for the
 * first gesture of any kind. Exploring the room is itself the gesture, which is
 * why no "click to enable sound" prompt is needed.
 */
export const bindTrack = () => {
  el = new Audio(TRACK.src)
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
    void el
      .play()
      .then(() => {
        // Re-check: the gesture that unblocked playback may itself have been a
        // click on the speaker button, which resolves after play() does. Volume
        // is still 0 here, so bailing out now is silent rather than a blip.
        if (!usePlayer.getState().on) {
          el?.pause()
          return
        }
        fadeTo(TARGET_VOLUME)
        disarm()
      })
      .catch(() => {
        /* Blocked. The gesture listeners below are still armed. */
      })
  }

  const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
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
