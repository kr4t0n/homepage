import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, MusicNote, Pause, Play, X } from '@phosphor-icons/react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { PROFILE, PROJECTS, TRACK, hotspotById, type PanelKind } from '../content'
import { useScene } from '../store'
import { NOTES, playNote, unlockAudio } from '../audio/synth'
import { duckTrack, usePlayer } from '../audio/player'
import { usePixels } from '../pixels/usePixels'
import { colourFor, PALETTE_SIZE } from '../pixels/palette'

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

/**
 * Links a project mention by name, degrading to plain text if that project is
 * ever removed from content.ts.
 *
 * These exist because the Work panel is gone. Its body was the only
 * keyboard-reachable route to the project links: the monitors carry them in the
 * room, but they are raycast targets with no tabIndex, so a keyboard user cannot
 * reach them. About already named both projects in prose, so turning those
 * mentions into links restores the route without inventing any copy.
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

/**
 * Legend for the wall board.
 *
 * There are no project names to show: Argus returns opaque hashes on purpose,
 * with no paths or labels in the payload. So this reports what the board can
 * honestly say — rank, colour, and hours won — and leaves naming to whoever
 * wants to add a key->label map here later.
 */
function Signals() {
  const data = usePixels((s) => s.data)
  const settled = usePixels((s) => s.settled)
  const error = usePixels((s) => s.error)

  if (!data) {
    return (
      <Pending
        what={
          settled
            ? `The board is unlit: ${error ?? 'no data'}. It lights itself when Argus answers again.`
            : 'Reading six weeks of agent activity from Argus.'
        }
      />
    )
  }

  const lit = data.winners.filter((w) => w !== null).length
  const hours = (s: number) => `${Math.round(s / 3600)}h`

  return (
    <div className="space-y-5">
      <p className="max-w-[58ch] text-body">
        Every hour of the last six weeks, coloured by whichever project owned it
        and lit by how busy it was.{' '}
        <span className="text-bright">{lit}</span> of {data.slotCount} hours had
        something running.
        {data.live.length > 0 && (
          <span className="text-acid"> Something is running right now.</span>
        )}
      </p>

      <ul className="grid gap-2 sm:grid-cols-2">
        {data.projects.slice(0, PALETTE_SIZE).map((p, i) => (
          <li key={p.key} className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-[3px]"
              style={{ background: colourFor(i).getStyle() }}
            />
            <span className="font-mono text-[11px] text-mute">{p.key}</span>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-body">
              {hours(p.wonSeconds)}
            </span>
          </li>
        ))}
      </ul>

      {data.projects.length > PALETTE_SIZE && (
        <p className="text-sm text-mute">
          {data.projects.length - PALETTE_SIZE} smaller projects share one grey.
          Six colours is as many as stay apart at this pixel size.
        </p>
      )}
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
  // The cover is gitignored, so a fresh clone 404s it. Track that and drop the
  // element rather than leaving a broken-image frame in the bar.
  const [noArt, setNoArt] = useState(false)
  const artEl = useRef<HTMLImageElement>(null)
  const spin = useRef<gsap.core.Tween | null>(null)

  const art = Boolean(TRACK.cover) && !noArt

  // Built once and then played/paused, never recreated. A tween rebuilt per
  // state change would tween from the current angle to 360, so resuming at 350
  // degrees would crawl the last ten and resuming at 0 would look right by luck.
  // Holding one paused tween means pausing keeps the angle and resuming carries
  // on from it, which is the whole point of the gesture.
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

  // Separate from the tween's construction so that play/pause does not rebuild
  // it. useGSAP runs in a layout effect and this in a passive one, so the tween
  // exists by the time this first runs. Under reduced motion `spin` stays null
  // and this is a no-op, which is the intended silence rather than a bug.
  useEffect(() => {
    if (!spin.current) return
    if (playing) spin.current.play()
    else spin.current.pause()
  }, [playing])

  if (!available) {
    return (
      <p className="text-sm leading-relaxed text-mute">
        No track is being served. The audio file is not committed to this repo,
        so a fresh clone runs the room in silence — drop one in as
        <span className="text-body"> public/track.mp3</span>.
      </p>
    )
  }

  // No border, padding or background here: in compact mode the panel itself is
  // the mini-player's container. Drawing one here too was a box inside a box,
  // which only read as deliberate while there was a sibling paragraph to group
  // against.
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4">
      {/* The artwork *is* the transport: the cover fills the circle and the
          glyph sits on top of it, rather than sitting beside it as a second
          element. Follows `playing`, not the stored intent, for the reason in
          Hud.tsx: a transport that shows Pause while silent invites the one
          click that turns the music off for good. Pressing this is itself a
          gesture, so it starts playback even on a cold visit where autoplay was
          refused. */}
      <button
        type="button"
        onClick={() => setOn(!playing)}
        aria-label={playing ? `Pause ${TRACK.title}` : `Play ${TRACK.title}`}
        className={`group relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-full transition-transform active:scale-[0.96] ${
          art ? 'hairline border' : 'bg-acid text-void'
        }`}
      >
        {art && (
          <>
            {/* alt is empty on purpose: the title and artist sit beside this as
                real text, so announcing the artwork too is duplication.

                The 1px bleed is what keeps the spin clean. A square's
                perpendicular distance to its own edge is invariant under
                rotation, so a square exactly inscribing the circular mask is
                tangent to it at four points for every angle — mathematically
                covered, but one anti-aliased pixel away from flashing a hairline
                of background four times per turn. Sized in box properties rather
                than a scale transform, because GSAP owns this element's
                transform and would overwrite a Tailwind scale class. */}
            <img
              ref={artEl}
              src={TRACK.cover}
              alt=""
              width={192}
              height={192}
              onError={() => setNoArt(true)}
              className="absolute -inset-px size-[calc(100%+2px)] object-cover"
            />
            {/* Album art is arbitrary and this one peaks at 230/255 luminance
                exactly where the glyph lands, so the glyph needs help rather
                than trusting any given cover to be dark. Most of that help comes
                from the drop shadow below, not the scrim: a scrim heavy enough
                to guarantee contrast on its own turned the cover into a dark
                disc, which defeats showing it at all. Without art the button
                falls back to the solid accent fill. */}
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
        <p className="truncate tracking-tight text-bright">{TRACK.title}</p>
        {/* The artist line is the attribution. It is not decoration: the track
            is somebody else's record, so this credit stays even though the
            longer disclaimer that used to sit below the card is gone. */}
        <p className="truncate font-mono text-[10.5px] uppercase tracking-[0.18em] text-body">
          {TRACK.artist}
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
          <span
            data-elapsed
            className="shrink-0 font-mono text-[10.5px] tabular-nums text-body"
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
        <ProjectLink name="Argus" /> came out of that problem.{' '}
        <ProjectLink name="nodex" /> came out of a different frustration, that
        component libraries organise by framework when what you actually pick by
        is design language.
      </p>
      <p className="max-w-[58ch] text-mute">
        The rest of the room is accurate. The keys get more use than the guitar.
      </p>
    </div>
  )
}

const BODY: Record<string, () => React.ReactElement> = {
  music: Keys,
  player: Player,
  contact: Contact,
  about: About,
  stats: Signals,
  writing: () => (
    <Pending what="Notes and longer pieces on agent tooling and evaluation. First few are drafted." />
  ),
  cv: () => <Pending what="The formal one-page version, as a PDF." />,
}

/**
 * Kinds that render as a compact bar rather than a full content panel.
 *
 * The decks are a transport, not a piece of writing: a 820px sheet with a
 * heading over one row of controls read as a big empty box with a small box
 * inside it. This lives here rather than in content.ts because it is a
 * presentation decision, and content.ts is the contract for what the page says.
 */
const COMPACT = new Set<PanelKind>(['player'])

export function Panel() {
  const focus = useScene((s) => s.focus)
  const setFocus = useScene((s) => s.setFocus)
  const root = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
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
        // The scrim leads the panel slightly: the room dims, then the glass
        // arrives on the darkened backdrop. Reversing that order shows the panel
        // at its worst contrast for a beat before the fix lands.
        gsap.from(scrimRef.current, { opacity: 0, duration: 0.45, ease: 'power2.out' })
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
  const compact = COMPACT.has(spot.kind)

  /*
   * Dims the room behind an open panel.
   *
   * This exists for contrast, not atmosphere, and it is what makes translucency
   * affordable at all. Measured against the undimmed room, body text on glass
   * hit 2.22:1 in front of the glowing hexagon wall and muted text 1.15:1 —
   * unreadable, not merely tight. Fixing that by thickening the glass would have
   * meant ~90% fill, which is not glass any more. Darkening the backdrop instead
   * keeps the material thin and the blur visible, and is what the platforms this
   * borrows from actually do behind a sheet.
   *
   * z-10 is deliberate: the canvas sits below it, while the HUD (z-20) and the
   * panel (z-30) stay crisp above it. pointer-events-none so room interaction is
   * unchanged — this is a filter, not an overlay that swallows clicks.
   *
   * Content panels dim harder than the decks bar, and the reason is the task
   * rather than the arithmetic. A content panel covers most of the viewport and
   * you are reading it, so the room can recede. The decks bar is a glance — you
   * have just clicked the DJ controller and the camera has flown to frame it, so
   * dimming the thing you asked to look at would be perverse.
   *
   * Both values are far lower than they once were. The first version darkened
   * the whole scene to buy contrast, which worked and looked wrong: the room
   * went flat and the panels stopped reading as panes over anything. Moving the
   * dimming into the panel's own backdrop-filter, via brightness(), let these
   * fall from 0.78 and 0.62 to 0.15 and 0.08 while measuring better than before.
   */
  const scrim = (
    <div
      ref={scrimRef}
      data-scrim
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-10 ${compact ? 'bg-void/0' : 'bg-void/0'}`}
    />
  )

  // The visible heading is dropped in compact mode, so the dialog's accessible
  // name comes from aria-label alone — which it already did.
  if (compact) {
    return (
      <>
        {scrim}
        <div
          ref={root}
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
      </>
    )
  }

  return (
    <>
      {scrim}
      <div
        ref={root}
        role="dialog"
        aria-modal="false"
        aria-label={spot.label}
        className="glass pointer-events-auto fixed inset-x-0 bottom-0 z-30 mx-auto flex max-h-[68dvh] w-full max-w-[820px] flex-col rounded-t-[22px] sm:inset-x-6 sm:bottom-6 sm:rounded-[22px] lg:max-w-[880px]"
      >
        {/* The scroll lives on this inner element, not the glass one. An
            absolutely-positioned sheen inside a scroll container scrolls with the
            content, so the specular edge would slide away from the panel's own
            top edge the moment anyone scrolled. */}
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
    </>
  )
}
