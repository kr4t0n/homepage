import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { ROOM_HOTSPOTS, PROFILE, readoutFor, screenById } from '../content'
import { useScene } from '../store'
import { resetOrbit } from '../three/orbit'

gsap.registerPlugin(useGSAP)

/**
 * Hero copy and the hotspot index.
 *
 * Both fade out once a hotspot is focused so the room and the panel own the
 * frame. The index doubles as the keyboard path into the scene: every hotspot
 * is a real button, tab-reachable, so the page is navigable without a pointer.
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
  const root = useRef<HTMLDivElement>(null)

  const open = focus === null && screen === null
  const hovered = readoutFor(hover, screen)
  const framed = screenById(screen)

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

      {/* A framed screen has no panel, so this is the only thing telling the
          visitor what the second click does and how to get back out. */}
      {framed && (
        <div className="pointer-events-auto absolute inset-x-0 bottom-10 flex flex-col items-center gap-3 px-6 text-center">
          {/* The screen fills the frame at this distance, so the copy would
              otherwise land on whatever the monitor is standing on. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-56 bg-gradient-to-t from-void via-void/80 to-transparent"
          />
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-acid">
            {framed.label}
          </p>
          <p className="text-body">
            {framed.href ? framed.action : framed.hint}
          </p>
          <button
            type="button"
            onClick={() => clearFocus()}
            className="hairline rounded-full border px-3.5 py-1.5 text-sm text-mute transition-colors hover:text-bright active:scale-[0.98]"
          >
            Back to the room
          </button>
        </div>
      )}

      {/* Reset appears only once the view has actually been moved. */}
      <button
        type="button"
        onClick={() => {
          resetOrbit()
          setOrbited(false)
        }}
        className={`hairline pointer-events-auto absolute bottom-8 right-6 rounded-full border px-3.5 py-1.5 text-sm text-mute transition-all hover:text-bright active:scale-[0.98] sm:right-10 ${
          orbited && open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        Reset view
      </button>

      {/* Hover readout. Fixed position rather than following the cursor, which
          keeps it legible and avoids a custom-cursor pattern. */}
      <div
        aria-hidden
        className={`absolute right-6 top-1/2 -translate-y-1/2 text-right transition-opacity duration-200 sm:right-10 ${
          hovered && open ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-acid">
          {hovered?.label}
        </p>
        <p className="mt-1 max-w-[18ch] text-sm text-mute">{hovered?.hint}</p>
      </div>
    </div>
  )
}
