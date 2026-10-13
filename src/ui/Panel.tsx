import { useCallback, useEffect, useRef, useState } from 'react'
import { MusicNote, Pause, Play, X } from '@phosphor-icons/react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { PROJECTS, hotspotById, type PanelKind } from '../content'
import { useScene } from '../store'
import { NOTES, playNote, unlockAudio } from '../audio/synth'
import { duckTrack, usePlayer } from '../audio/player'

gsap.registerPlugin(useGSAP)

/** Shown on any panel whose real content does not exist yet. */
function Pending({ what }: { what: string }) {
  return (
    <div className="hairline rounded-[14px] border border-dashed p-6">
      <p className="font-mono text-[11px] tracking-[0.2em] text-mute uppercase">
        Not published yet
      </p>
      <p className="mt-3 text-body">{what}</p>
    </div>
  )
}

/**
 * Links a project mention by name, degrading to plain text if that project is
 * ever removed from content.ts. These are the keyboard route to the project
 * links, which the monitors carry only as raycast targets.
 */
function ProjectLink({ name }: { name: string }) {
  const p = PROJECTS.find((x) => x.name === name)
  if (!p) return <>{name}</>
  return (
    <a
      href={p.href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-body underline decoration-hair underline-offset-4 hover:text-bright"
    >
      {name}
    </a>
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
  const track = usePlayer((s) => s.track)
  const playing = usePlayer((s) => s.playing)
  const time = usePlayer((s) => s.time)
  const duration = usePlayer((s) => s.duration)
  const setOn = usePlayer((s) => s.setOn)
  const seek = usePlayer((s) => s.seek)
  // The manifest can name a cover that is not actually on the volume. Track a
  // 404 and drop the element rather than leaving a broken-image frame in the bar.
  const [noArt, setNoArt] = useState(false)
  const artEl = useRef<HTMLImageElement>(null)
  const spin = useRef<gsap.core.Tween | null>(null)

  const art = Boolean(track?.cover) && !noArt

  // Built once and then played/paused, never recreated: a rebuilt tween runs
  // from the current angle to 360, so resuming at 350 degrees would crawl the
  // last ten.
  useGSAP(
    () => {
      if (!art) return
      const mm = gsap.matchMedia()
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        spin.current = gsap.to(artEl.current, {
          rotation: 360,
          duration: 9,
          ease: 'none',
          repeat: -1,
          paused: true,
        })
        return () => {
          spin.current?.kill()
          spin.current = null
        }
      })
      return () => mm.revert()
    },
    { dependencies: [art] },
  )

  // Separate so that play/pause never rebuilds the tween. useGSAP runs in a
  // layout effect and this in a passive one, so the tween exists first. Under
  // reduced motion `spin` stays null and this is deliberately a no-op.
  useEffect(() => {
    if (!spin.current) return
    if (playing) spin.current.play()
    else spin.current.pause()
  }, [playing])

  if (!available) {
    return (
      <p className="text-sm leading-relaxed text-mute">
        No track is being served. Audio is not part of this repo or its image, so the room runs in
        silence until a track and its
        <span className="text-body"> media/track.json</span> are provided.
      </p>
    )
  }

  // The manifest is still on its way. It is one small same-origin request, so
  // this is rarely visible at all, and never long enough to warrant a skeleton.
  if (!track) return null

  // No border, padding or background here: in compact mode the panel itself is
  // the mini-player's container.
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4">
      {/* The artwork is the transport, glyph on the cover. Follows `playing`,
          not `on`: a Pause shown over silence invites the click that turns the
          music off for good. Pressing it is a gesture, so it plays even on a
          cold visit. */}
      <button
        type="button"
        onClick={() => setOn(!playing)}
        aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
        className={`group relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-full transition-transform active:scale-[0.96] ${
          art ? 'hairline border' : 'bg-acid text-void'
        }`}
      >
        {art && (
          <>
            {/* alt is empty: the title and artist beside it are real text. The
                1px bleed stops the spinning square grazing the circular mask; it
                is box-sized because GSAP owns this element's transform. */}
            <img
              ref={artEl}
              src={track.cover}
              alt=""
              width={192}
              height={192}
              onError={() => setNoArt(true)}
              className="absolute -inset-px size-[calc(100%+2px)] object-cover"
            />
            {/* Covers can be bright under the glyph, so it gets a light scrim and
                a drop shadow that does most of the work: a scrim heavy enough on
                its own turns the cover into a dark disc. */}
            <span className="absolute inset-0 bg-void/25 transition-colors group-hover:bg-void/10" />
          </>
        )}
        <span
          className={`relative ${art ? 'text-bright drop-shadow-[0_1px_4px_rgba(0,0,0,0.95)]' : ''}`}
        >
          {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
        </span>
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate tracking-tight text-bright">{track.title}</p>
        {/* The artist line is the attribution for somebody else's record, not
            decoration. */}
        <p className="truncate font-mono text-[10.5px] tracking-[0.18em] text-body uppercase">
          {track.artist}
        </p>

        <div className="mt-2.5 flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.floor(duration))}
            value={Math.min(time, duration)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
            className="h-1 w-full min-w-0 cursor-pointer accent-acid"
          />
          <span data-elapsed className="shrink-0 font-mono text-[10.5px] text-body tabular-nums">
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
        <p className="mx-auto mt-4 max-w-[46ch] text-body">
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
      <div className="relative flex h-44 justify-center gap-1 select-none">
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
            <span className="absolute right-0 bottom-2 left-0 text-center font-mono text-[10px] text-mute">
              {n.key}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-5 max-w-[52ch] text-sm text-mute">
        Click, or use your keyboard row. My own tracks will live here once they are mixed; this is
        the instrument, not the record.
      </p>
    </div>
  )
}

function About() {
  return (
    <div className="space-y-4 text-body">
      <p className="max-w-[58ch]">
        I work on AI systems, mostly the unglamorous part: making agents observable when you are
        running a dozen of them across machines you do not have a window into.
      </p>
      <p className="max-w-[58ch] text-mute">
        <ProjectLink name="Argus" /> came out of that problem. <ProjectLink name="nodex" /> came out
        of a different frustration, that component libraries organise by framework when what you
        actually pick by is design language.
      </p>
      <p className="max-w-[58ch] text-mute">
        The rest of the room is accurate. The keys get more use than the guitar.
      </p>
    </div>
  )
}

const BODY: Record<string, () => React.ReactElement | null> = {
  music: Keys,
  player: Player,
  about: About,
  writing: () => (
    <Pending what="Notes and longer pieces on agent tooling and evaluation. First few are drafted." />
  ),
  cv: () => <Pending what="The formal one-page version, as a PDF." />,
}

/** For a kind with no body. Module-level, so its identity is the same every render. */
const NoBody = () => null

/**
 * Kinds that render as a compact bar rather than a full content panel, because
 * a heading over one row of controls leaves a big empty sheet. Kept out of
 * content.ts, which is the contract for what the page says, not how.
 */
const COMPACT = new Set<PanelKind>(['player'])

export function Panel() {
  const focus = useScene((s) => s.focus)
  const setFocus = useScene((s) => s.setFocus)
  const root = useRef<HTMLDivElement>(null)
  const spot = hotspotById(focus)

  // The camera moves first, then the glass arrives: the fade waits 0.45s into
  // the 1.15s flight. Gated by matchMedia because gsap.from() applies its start
  // state at once, and would leave the panel at opacity 0 under reduced motion.
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
  // A bare hotspot has no panel; Hud renders the way back out. Decided here
  // rather than upstream, so the panel alone decides whether there is one.
  if (spot.bare) return null
  const Body = BODY[spot.kind] ?? NoBody
  const compact = COMPACT.has(spot.kind)

  // Not a <dialog>: Chromium focuses one on any click inside it, ringing the
  // whole panel and taking the arrow keys from its scrolling content. Compact
  // mode has no visible heading, so aria-label is the dialog's only name.
  if (compact) {
    return (
      <div
        ref={root}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <dialog> takes focus on click
        role="dialog"
        aria-modal="false"
        aria-label={spot.label}
        className="glass pointer-events-auto fixed inset-x-0 bottom-6 z-30 mx-auto flex w-[calc(100%-3rem)] max-w-[540px] items-center gap-4 rounded-[22px] p-4"
      >
        <Body />
        <button
          type="button"
          onClick={() => setFocus(null)}
          aria-label="Close and return to the room"
          className="hairline shrink-0 self-start rounded-full border p-1.5 text-mute transition-colors hover:text-bright"
        >
          <X size={14} weight="bold" />
        </button>
      </div>
    )
  }

  return (
    <div
      ref={root}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <dialog> takes focus on click
      role="dialog"
      aria-modal="false"
      aria-label={spot.label}
      className="glass pointer-events-auto fixed inset-x-0 bottom-0 z-30 mx-auto flex max-h-[68dvh] w-full max-w-[820px] flex-col rounded-t-[22px] sm:inset-x-6 sm:bottom-6 sm:rounded-[22px] lg:max-w-[880px]"
    >
      {/* The scroll lives here, not on the glass: an absolute sheen inside a
          scroll container scrolls with the content and would slide off the
          panel's top edge. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
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
    </div>
  )
}
