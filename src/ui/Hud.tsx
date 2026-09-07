import { useRef } from 'react'
import { SpeakerSimpleHigh, SpeakerSimpleSlash } from '@phosphor-icons/react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { ROOM_HOTSPOTS, PROFILE, hotspotById } from '../content'
import { useScene } from '../store'
import { usePlayer } from '../audio/player'
import { resetOrbit } from '../three/orbit'

gsap.registerPlugin(useGSAP)

/**
 * Hero copy and the hotspot index.
 *
 * Both fade out once a hotspot is focused so the room and the panel own the
 * frame. The index doubles as the keyboard path into the scene: every hotspot
 * is a real button, tab-reachable, so the page is navigable without a pointer.
 *
 * There is no hover readout. Hovering is communicated in the scene itself, by
 * the accent wash on the object and the pointer cursor, which is enough and
 * keeps the room free of floating labels.
 */
export function Hud() {
  const focus = useScene((s) => s.focus)
  const hover = useScene((s) => s.hover)
  const ready = useScene((s) => s.ready)
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
      if (!ready) return
      // gsap.from() writes its start state immediately, so gating it behind
      // matchMedia matters for correctness and not just for taste: under
      // reduced motion the tween must never be created, otherwise the hero and
      // nav are left parked at opacity 0 and the page reads as empty.
      const mm = gsap.matchMedia()
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('[data-intro]', {
          opacity: 0,
          y: 20,
          duration: 0.8,
          stagger: 0.09,
          delay: 0.25,
          ease: 'power3.out',
        })
      })
      return () => mm.revert()
    },
    { dependencies: [ready], scope: root },
  )

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
          back wall, which is itself the GitHub link, and the Contact panel
          carries the same link as real tab-reachable markup. A header holding
          one duplicate link was costing the room its whole upper edge. */}
      <div
        data-fade
        className="absolute bottom-0 left-0 right-0 px-6 pb-8 sm:px-10 sm:pb-10"
      >
        {/* Scrim. The diorama sits low in frame, so the hero copy needs a
            floor to stay legible against the desk and DJ deck behind it. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[26rem] bg-gradient-to-t from-void via-void/85 to-transparent"
        />
        <div className="pointer-events-auto max-w-[38rem]">
          <h1
            data-intro
            className="text-[2.5rem] font-medium leading-[1.06] tracking-tight text-bright sm:text-[3rem]"
          >
            AI engineer,
            <br />
            and the room it happens in.
          </h1>
          <p data-intro className="mt-4 max-w-[42ch] text-body">
            {PROFILE.intro}
          </p>

          <nav data-intro aria-label="Places in the room" className="mt-7 flex flex-wrap gap-2">
            {ROOM_HOTSPOTS().map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => setFocus(h.id)}
                onPointerEnter={() => setHover(h.id)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(h.id)}
                onBlur={() => setHover(null)}
                className={`hairline rounded-full border px-3.5 py-1.5 text-sm transition-colors active:scale-[0.98] ${
                  hover === h.id
                    ? 'border-acid text-acid'
                    : 'text-mute hover:text-bright'
                }`}
              >
                {h.label}
              </button>
            ))}
          </nav>

          {/* Drag and zoom are not discoverable on a canvas, so say so once and
              then get out of the way permanently. */}
          <p
            data-intro
            aria-hidden
            className={`mt-4 font-mono text-[11px] tracking-wide text-mute transition-opacity duration-500 ${
              orbited ? 'opacity-0' : 'opacity-70'
            }`}
          >
            Drag to look around, scroll to zoom
          </p>
        </div>
      </div>

      {/* A framed screen and a bare hotspot both have no panel. The only chrome
          is the way out; the object itself is the content. Discoverability of
          the second click on a screen rests on the pointer cursor over it. */}
      {noPanel && (
        <div className="pointer-events-auto absolute inset-x-0 bottom-10 flex justify-center px-6">
          {/* The screen fills the frame at this distance, so the button would
              otherwise sit on whatever the monitor is standing on. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-t from-void via-void/75 to-transparent"
          />
          <button
            type="button"
            onClick={() => clearFocus()}
            className="hairline rounded-full border px-3.5 py-1.5 text-sm text-mute transition-colors hover:text-bright active:scale-[0.98]"
          >
            Back to the room
          </button>
        </div>
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
