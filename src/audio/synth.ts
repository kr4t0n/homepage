/**
 * A tiny subtractive synth on the Web Audio API.
 *
 * Deliberately not a backing track: shipping a recording of a well-known song
 * on a public page is a licensing problem, and a sampled loop would need
 * hosting anyway. Synthesising in the browser is zero bytes, zero rights
 * clearance, and it makes the keys genuinely playable rather than decorative.
 * Swap `playNote` for a sampler when there is an original track to serve.
 */

let ctx: AudioContext | null = null
let master: GainNode | null = null

const ensure = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = 0.22
    // Gentle low-pass so the square wave is not harsh on laptop speakers.
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 2400
    tone.Q.value = 0.6
    master.connect(tone)
    tone.connect(ctx.destination)
  }
  return ctx
}

/** Browsers require a user gesture before audio starts. */
export const unlockAudio = async () => {
  const c = ensure()
  if (c && c.state === 'suspended') await c.resume()
  return !!c
}

export const NOTES = [
  { key: 'a', label: 'C', midi: 60 },
  { key: 'w', label: 'C#', midi: 61, sharp: true },
  { key: 's', label: 'D', midi: 62 },
  { key: 'e', label: 'D#', midi: 63, sharp: true },
  { key: 'd', label: 'E', midi: 64 },
  { key: 'f', label: 'F', midi: 65 },
  { key: 't', label: 'F#', midi: 66, sharp: true },
  { key: 'g', label: 'G', midi: 67 },
  { key: 'y', label: 'G#', midi: 68, sharp: true },
  { key: 'h', label: 'A', midi: 69 },
  { key: 'u', label: 'A#', midi: 70, sharp: true },
  { key: 'j', label: 'B', midi: 71 },
  { key: 'k', label: 'C', midi: 72 },
] as const

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)

/** One plucked voice. Returns immediately; the voice cleans itself up. */
export const playNote = (midi: number) => {
  const c = ensure()
  if (!c || !master) return
  const now = c.currentTime
  const osc = c.createOscillator()
  const sub = c.createOscillator()
  const env = c.createGain()

  osc.type = 'triangle'
  osc.frequency.value = hz(midi)
  sub.type = 'sine'
  sub.frequency.value = hz(midi - 12)

  const subGain = c.createGain()
  subGain.gain.value = 0.35

  env.gain.setValueAtTime(0.0001, now)
  env.gain.exponentialRampToValueAtTime(0.9, now + 0.008)
  env.gain.exponentialRampToValueAtTime(0.28, now + 0.14)
  env.gain.exponentialRampToValueAtTime(0.0001, now + 1.5)

  osc.connect(env)
  sub.connect(subGain)
  subGain.connect(env)
  env.connect(master)

  osc.start(now)
  sub.start(now)
  osc.stop(now + 1.6)
  sub.stop(now + 1.6)
  osc.onended = () => {
    osc.disconnect()
    sub.disconnect()
    subGain.disconnect()
    env.disconnect()
  }
}
