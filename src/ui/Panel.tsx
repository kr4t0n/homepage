import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, MusicNote, Pause, Play, X } from '@phosphor-icons/react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { PROFILE, PROJECTS, TRACK, hotspotById } from '../content'
import { useScene } from '../store'
import { NOTES, playNote, unlockAudio } from '../audio/synth'
import { duckTrack, usePlayer } from '../audio/player'

gsap.registerPlugin(useGSAP)

/** Shown on any panel whose real content does not exist yet. */
function Pending({ what }: { what: string }) {
  return (
    <div className="hairline rounded-[14px] border border-dashed p-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-mute">
        Not published yet
      </p>
      <p className="mt-3 text-body">{what}</p>
    </div>
  )
}

function Projects() {
  return (
    <div className="grid gap-px overflow-hidden rounded-[14px] bg-hair">
      {PROJECTS.map((p) => (
        <article key={p.name} className="bg-ink p-6 sm:p-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-2xl tracking-tight text-bright">{p.name}</h3>
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-acid">
              {p.status === 'live' ? 'Live' : 'In design'}
            </span>
          </div>
          <p className="mt-1 text-body">{p.tagline}</p>
          <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-mute">{p.body}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {p.stack.map((s) => (
              <span
                key={s}
                className="hairline rounded-full border px-2.5 py-1 font-mono text-[10.5px] text-mute"
              >
                {s}
              </span>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={p.href}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-full bg-acid px-4 py-2 text-sm font-medium text-void transition-transform active:scale-[0.98]"
            >
              Open {p.name}
              <ArrowUpRight size={15} weight="bold" />
            </a>
            {p.repo && (
              <a
                href={p.repo}
                target="_blank"
                rel="noreferrer noopener"
                className="hairline inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm text-body transition-transform active:scale-[0.98] hover:text-bright"
              >
                Source
                <ArrowUpRight size={15} />
              </a>
            )}
          </div>
        </article>
      ))}
    </div>
  )
}

const mmss = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/**
 * The decks: transport for the room's backing track.
 *
 * Deliberately small. It reports what is playing and lets you stop it, and
 * nothing else — a queue or a library would be inventing a feature the room
 * does not have. The seek control is a real range input rather than a styled
 * div so that dragging, arrow keys and screen readers all work for free.
 */
function Player() {
  const available = usePlayer((s) => s.available)
  const playing = usePlayer((s) => s.playing)
  const time = usePlayer((s) => s.time)
  const duration = usePlayer((s) => s.duration)
  const setOn = usePlayer((s) => s.setOn)
  const seek = usePlayer((s) => s.seek)

  if (!available) {
    return (
      <Pending what="No track is being served. The audio file is not committed to this repo, so a fresh clone runs the room in silence — drop one in as public/track.mp3." />
    )
  }

  return (
    <div className="hairline flex items-center gap-5 rounded-[14px] border p-5 sm:p-6">
      {/* Follows `playing`, not the stored intent, for the reason in Hud.tsx:
          a transport that shows Pause while silent invites the one click that
          turns the music off for good. Pressing this is itself a gesture, so
          it starts playback even on a cold visit where autoplay was refused. */}
      <button
        type="button"
        onClick={() => setOn(!playing)}
        aria-label={playing ? `Pause ${TRACK.title}` : `Play ${TRACK.title}`}
        className="grid size-12 shrink-0 place-items-center rounded-full bg-acid text-void transition-transform active:scale-[0.96]"
      >
        {playing ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-lg tracking-tight text-bright">{TRACK.title}</p>
        {/* The artist line is the attribution. It is not decoration: the track
            is somebody else's record, so this credit stays even though the
            longer disclaimer that used to sit below the card is gone. */}
        <p className="truncate font-mono text-[11px] uppercase tracking-[0.18em] text-mute">
          {TRACK.artist}
        </p>

        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.floor(duration))}
            value={Math.min(time, duration)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
            className="h-1 w-full min-w-0 cursor-pointer accent-acid"
          />
          <span
            data-elapsed
            className="shrink-0 font-mono text-[11px] tabular-nums text-mute"
          >
            {mmss(time)} / {mmss(duration)}
          </span>
        </div>
      </div>
    </div>
  )
}

function Keys() {
  const [armed, setArmed] = useState(false)
  const [lit, setLit] = useState<number | null>(null)

  // Drop the backing track down while the keys are open, so the instrument is
  // audible over it. Restored when the panel closes.
  useEffect(() => {
    duckTrack(true)
    return () => duckTrack(false)
  }, [])

  const hit = useCallback((midi: number) => {
    playNote(midi)
    setLit(midi)
    window.setTimeout(() => setLit((v) => (v === midi ? null : v)), 140)
  }, [])

  // Physical keyboard mapping, active only once audio is unlocked.
  useEffect(() => {
    if (!armed) return
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const n = NOTES.find((x) => x.key === e.key.toLowerCase())
      if (n) {
        e.preventDefault()
        hit(n.midi)
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [armed, hit])

  if (!armed) {
    return (
      <div className="hairline rounded-[14px] border p-8 text-center">
        <MusicNote size={26} className="mx-auto text-acid" />
        <p className="mt-4 max-w-[46ch] mx-auto text-body">
          The keys are playable, in the browser, with nothing to download.
        </p>
        <button
          type="button"
          onClick={async () => setArmed(await unlockAudio())}
          className="mt-6 rounded-full bg-acid px-5 py-2.5 text-sm font-medium text-void transition-transform active:scale-[0.98]"
        >
          Turn on sound
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="relative flex h-44 select-none justify-center gap-1">
        {NOTES.filter((n) => !('sharp' in n && n.sharp)).map((n) => (
          <button
            key={n.midi}
            type="button"
            onPointerDown={() => hit(n.midi)}
            aria-label={`Play ${n.label}`}
            className={`hairline relative w-11 rounded-b-[8px] border transition-colors sm:w-14 ${
              lit === n.midi ? 'bg-acid' : 'bg-ink-2 hover:bg-hair'
            }`}
          >
            <span className="absolute bottom-2 left-0 right-0 text-center font-mono text-[10px] text-mute">
              {n.key}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-5 max-w-[52ch] text-sm text-mute">
        Click, or use your keyboard row. My own tracks will live here once they
        are mixed; this is the instrument, not the record.
      </p>
    </div>
  )
}

function Contact() {
  return (
    <div className="space-y-5">
      <p className="max-w-[54ch] text-body">
        Best way to reach me is a GitHub issue or discussion on whichever
        project you are here about. I read all of them.
      </p>
      <a
        href={PROFILE.github}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1.5 rounded-full bg-acid px-4 py-2 text-sm font-medium text-void transition-transform active:scale-[0.98]"
      >
        github.com/kr4t0n
        <ArrowUpRight size={15} weight="bold" />
      </a>
    </div>
  )
}

function About() {
  return (
    <div className="space-y-4 text-body">
      <p className="max-w-[58ch]">
        I work on AI systems, mostly the unglamorous part: making agents
        observable when you are running a dozen of them across machines you do
        not have a window into.
      </p>
      <p className="max-w-[58ch] text-mute">
        Argus came out of that problem. nodex came out of a different
        frustration, that component libraries organise by framework when what
        you actually pick by is design language.
      </p>
      <p className="max-w-[58ch] text-mute">
        The rest of the room is accurate. The keys get more use than the guitar.
      </p>
    </div>
  )
}

const BODY: Record<string, () => React.ReactElement> = {
  projects: Projects,
  music: Keys,
  player: Player,
  contact: Contact,
  about: About,
  stats: () => (
    <Pending what="A live board for agent token usage from Argus, plus GitHub activity. Wiring it up once the Argus metrics endpoint is public." />
  ),
  writing: () => (
    <Pending what="Notes and longer pieces on agent tooling and evaluation. First few are drafted." />
  ),
  cv: () => <Pending what="The formal one-page version, as a PDF." />,
}

export function Panel() {
  const focus = useScene((s) => s.focus)
  const setFocus = useScene((s) => s.setFocus)
  const root = useRef<HTMLDivElement>(null)
  const spot = hotspotById(focus)

  // Panel arrives after the camera has committed to the move, so the two reads
  // as one gesture rather than two competing ones. Gated behind matchMedia:
  // gsap.from() applies its start state immediately, so under reduced motion an
  // ungated tween would leave the panel stuck at opacity 0.
  useGSAP(
    () => {
      if (!spot) return
      const mm = gsap.matchMedia()
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from(root.current, {
          opacity: 0,
          y: 18,
          duration: 0.5,
          delay: 0.45,
          ease: 'power3.out',
        })
      })
      return () => mm.revert()
    },
    { dependencies: [focus], scope: root },
  )

  if (!spot) return null
  const Body = BODY[spot.kind] ?? (() => null)

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="false"
      aria-label={spot.label}
      className="pointer-events-auto fixed inset-x-0 bottom-0 z-30 mx-auto max-h-[68dvh] w-full max-w-[820px] overflow-y-auto rounded-t-[14px] border-t border-hair bg-void/92 p-6 backdrop-blur-xl sm:inset-x-6 sm:bottom-6 sm:rounded-[14px] sm:border sm:p-8 lg:max-w-[880px]"
    >
      <div className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h2 className="text-3xl tracking-tight text-bright sm:text-4xl">{spot.label}</h2>
          <p className="mt-1 text-sm text-mute">{spot.hint}</p>
        </div>
        <button
          type="button"
          onClick={() => setFocus(null)}
          aria-label="Close and return to the room"
          className="hairline shrink-0 rounded-full border p-2 text-mute transition-colors hover:text-bright"
        >
          <X size={16} weight="bold" />
        </button>
      </div>
      <Body />
    </div>
  )
}
