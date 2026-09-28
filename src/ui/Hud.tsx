import { useRef } from 'react'
import { ArrowUpRight, SpeakerSimpleHigh, SpeakerSimpleSlash } from '@phosphor-icons/react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { HOTSPOTS, ROOM_LINKS, hotspotById } from '../content'
import { useScene } from '../store'
import { usePlayer } from '../audio/player'
import { resetOrbit } from '../three/orbit'

gsap.registerPlugin(useGSAP)

/**
 * The page chrome over the room, which is deliberately almost none.
 *
 * There is no hero copy, no visible hotspot index and no "drag to look around"
 * hint. The room is meant to be explored: every object that opens something is
 * an easter egg for the visitor to find by pointing at it, and a row of labelled
 * pills in the corner answered that question before anyone could ask it.
 *
 * The index still exists, for the keyboard only. A 3D object has no tabIndex,
 * so without it nothing in the room is reachable without a pointer, and the
 * GitHub, Argus and nodex links inside the panels go with it. It is visually
 * hidden until something inside it takes focus, then appears where the hero
 * used to be. A pointer never lands on it, so the room stays unlabelled for
 * anyone who can explore it directly.
 *
 * There is no hover readout. Hovering is communicated in the scene itself, by
 * the accent wash on the object and the pointer cursor, which is enough and
 * keeps the room free of floating labels.
 */
export function Hud() {
  const focus = useScene((s) => s.focus)
  const hover = useScene((s) => s.hover)
  const setFocus = useScene((s) => s.setFocus)
  const setHover = useScene((s) => s.setHover)
  const screen = useScene((s) => s.screen)
  const clearFocus = useScene((s) => s.clearFocus)
  const orbited = useScene((s) => s.orbited)
  const setOrbited = useScene((s) => s.setOrbited)
  const audio = usePlayer((s) => s.available)
  const playing = usePlayer((s) => s.playing)
  const setOn = usePlayer((s) => s.setOn)
  const root = useRef<HTMLDivElement>(null)

  const open = focus === null && screen === null
  // A framed screen and a `bare` hotspot are the same situation: the room is
  // the content and there is no panel, so this is the only way back out.
  const noPanel = screen !== null || hotspotById(focus)?.bare === true

  useGSAP(
    () => {
      // A state change, so it still happens under reduced motion, just instantly.
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      gsap.to('[data-fade]', {
        opacity: open ? 1 : 0,
        duration: reduce ? 0 : 0.35,
        ease: 'power2.out',
        pointerEvents: open ? 'auto' : 'none',
      })
    },
    { dependencies: [open], scope: root },
  )

  return (
    <div ref={root} className="pointer-events-none fixed inset-0 z-20">
      {/* No chrome across the top. The wordmark moved to the neon sign on the
          back wall, which is itself the GitHub link, and the keyboard index
          below carries the same link as real tab-reachable markup. A header
          holding one duplicate link was costing the room its whole upper edge.

          Nor across the bottom-left, where the hero and a visible hotspot
          index used to be. What remains is the keyboard route into the room:
          `sr-only` until a pill takes focus, shown in place while one has it.
          Focusing a pill washes its object exactly as pointing at it does, so
          a keyboard visitor is still shown where each thing is.

          It stays mounted and fades when a panel opens rather than unmounting.
          The pill that was just pressed keeps focus underneath the panel, so the
          next Tab moves forward into the panel's own links instead of starting
          over from the top of the page. The wrapper has no size of its own and
          inherits `pointer-events-none`, so hidden or not, it never takes a
          pointer event away from the room. */}
      <div className="absolute bottom-8 left-6 max-w-[38rem] sm:bottom-10 sm:left-10">
        <nav
          data-fade
          aria-label="Places in the room"
          className="sr-only flex flex-wrap gap-2 focus-within:not-sr-only"
        >
          {HOTSPOTS.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => setFocus(h.id)}
              onFocus={() => setHover(h.id)}
              onBlur={() => setHover(null)}
              className={`hairline rounded-full border bg-void/50 px-3.5 py-1.5 text-sm backdrop-blur-sm transition-colors active:scale-[0.98] ${
                hover === h.id
                  ? 'border-acid text-acid'
                  : 'text-mute hover:text-bright'
              }`}
            >
              {h.label}
            </button>
          ))}
          {/* The room's links, after its places. Each is the keyboard twin of
              a 3D click target, and focusing one lights that object the same
              way a pill washes its hotspot, so the visitor is shown where the
              link lives. Real anchors, so they open like any other link. */}
          {ROOM_LINKS.map((l) => (
            <a
              key={l.id}
              href={l.href}
              target="_blank"
              rel="noreferrer noopener"
              onFocus={() => setHover(l.id)}
              onBlur={() => setHover(null)}
              className={`hairline inline-flex items-center gap-1 rounded-full border bg-void/50 px-3.5 py-1.5 text-sm backdrop-blur-sm transition-colors active:scale-[0.98] ${
                hover === l.id
                  ? 'border-acid text-acid'
                  : 'text-mute hover:text-bright'
              }`}
            >
              {l.label}
              <ArrowUpRight size={13} weight="bold" aria-hidden />
            </a>
          ))}
        </nav>
      </div>

      {/* A framed screen and a bare hotspot both have no panel. The only chrome
          is the way out; the object itself is the content. Discoverability of
          the second click on a screen rests on the pointer cursor over it. */}
      {noPanel && (
        <>
          {/* The screen fills the frame at this distance, so the button would
              otherwise sit on whatever the monitor is standing on.

              Anchored to this root, which is the viewport, and deliberately not
              nested inside the button's container below. The gradient reaches
              full opacity at its own bottom edge, so wherever that edge lands is
              a hard line -- and inside a `bottom-10` container, `bottom-0` means
              the button's bottom, leaving the last 40px of the room undimmed
              under an opaque band. That seam ran the full width of the screen in
              both focused modes and read as a grey border with the room showing
              brighter beneath it. Measured before the fix: rgb(7,10,18) at
              y=859 against rgb(11,14,25) at y=860. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-48 bg-gradient-to-t from-void via-void/75 to-transparent"
          />
          <div className="pointer-events-auto absolute inset-x-0 bottom-10 flex justify-center px-6">
            <button
              type="button"
              onClick={() => clearFocus()}
              className="hairline rounded-full border px-3.5 py-1.5 text-sm text-mute transition-colors hover:text-bright active:scale-[0.98]"
            >
              Back to the room
            </button>
          </div>
        </>
      )}

      {/* Bottom-right controls. Reset appears only once the view has moved. */}
      <div className="absolute bottom-8 right-6 flex items-center gap-2 sm:right-10">
        <button
          type="button"
          onClick={() => {
            resetOrbit()
            setOrbited(false)
          }}
          className={`hairline pointer-events-auto rounded-full border px-3.5 py-1.5 text-sm text-mute transition-all hover:text-bright active:scale-[0.98] ${
            orbited && open ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          Reset view
        </button>
      </div>

      {/* Sound, top-right.
          The room starts playing on its own, so stopping it must not depend on
          first finding the decks. That makes this the one required control on
          the page rather than decoration, which is why it sits apart from the
          rest of the chrome that was stripped from this edge: it is not a
          duplicate link, and hiding it costs accessibility.
          Top rather than bottom because it stays reachable while a panel owns
          the lower half — muting while reading About is exactly when you want
          it. Hidden only for a framed screen, which fills the whole frame.

          It reports `playing`, the real state, and never `on`, the intent. An
          earlier version showed intent, which meant it lit up as "sound is on"
          during the window before the browser has allowed any: the honest
          reading of that is "this is lying", the natural response is to click
          it, and clicking it wrote `off` to localStorage permanently. So the
          click follows the icon rather than the intent — press a silent speaker
          and you get sound, which is also a user gesture, so it works on the
          very first press. */}
      <button
        type="button"
        onClick={() => setOn(!playing)}
        aria-label={playing ? 'Turn the music off' : 'Turn the music on'}
        aria-pressed={playing}
        className={`hairline pointer-events-auto absolute right-6 top-6 grid size-[34px] place-items-center rounded-full border bg-void/50 backdrop-blur-sm transition-all active:scale-[0.96] sm:right-10 sm:top-8 ${
          audio && screen === null ? 'opacity-100' : 'pointer-events-none opacity-0'
        } ${playing ? 'border-acid/40 text-acid' : 'text-mute hover:text-bright'}`}
      >
        {playing ? <SpeakerSimpleHigh size={15} /> : <SpeakerSimpleSlash size={15} />}
      </button>

    </div>
  )
}
