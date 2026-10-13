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
 * The page chrome over the room, which is deliberately almost none: the room is
 * for exploring, and the pointer cursor is the only sign an object does
 * something. The hotspot index is the keyboard route in, hidden until focused.
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
      {/* The keyboard index: `sr-only` until a pill takes focus. It fades
          rather than unmounting, so the pressed pill keeps focus under the panel
          and the next Tab moves into it. This wrapper has no size and inherits
          `pointer-events-none`, so it never takes a pointer from the room. */}
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
                hover === h.id ? 'border-acid text-acid' : 'text-mute hover:text-bright'
              }`}
            >
              {h.label}
            </button>
          ))}
          {/* Keyboard twins of the room's 3D link targets. Focus sets that
              object's hover state, so the visitor is shown where the link
              lives. */}
          {ROOM_LINKS.map((l) => (
            <a
              key={l.id}
              href={l.href}
              target="_blank"
              rel="noreferrer noopener"
              onFocus={() => setHover(l.id)}
              onBlur={() => setHover(null)}
              className={`hairline inline-flex items-center gap-1 rounded-full border bg-void/50 px-3.5 py-1.5 text-sm backdrop-blur-sm transition-colors active:scale-[0.98] ${
                hover === l.id ? 'border-acid text-acid' : 'text-mute hover:text-bright'
              }`}
            >
              {l.label}
              <ArrowUpRight size={13} weight="bold" aria-hidden />
            </a>
          ))}
        </nav>
      </div>

      {noPanel && (
        <>
          {/* A dark ground for the button over whatever the monitor stands on.
              Anchored to this root, the viewport, not the button's container:
              the gradient's opaque bottom edge is a hard line wherever it lands. */}
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
      <div className="absolute right-6 bottom-8 flex items-center gap-2 sm:right-10">
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

      {/* The room plays on its own, so this is a required control, top-right
          to stay reachable while a panel owns the lower half. It shows
          `playing`, never `on`, and the click follows the icon: a silent
          speaker always yields sound. See AGENTS.md on sound controls. */}
      <button
        type="button"
        onClick={() => setOn(!playing)}
        aria-label={playing ? 'Turn the music off' : 'Turn the music on'}
        aria-pressed={playing}
        className={`hairline pointer-events-auto absolute top-6 right-6 grid size-[34px] place-items-center rounded-full border bg-void/50 backdrop-blur-sm transition-all active:scale-[0.96] sm:top-8 sm:right-10 ${
          audio && screen === null ? 'opacity-100' : 'pointer-events-none opacity-0'
        } ${playing ? 'border-acid/40 text-acid' : 'text-mute hover:text-bright'}`}
      >
        {playing ? <SpeakerSimpleHigh size={15} /> : <SpeakerSimpleSlash size={15} />}
      </button>
    </div>
  )
}
