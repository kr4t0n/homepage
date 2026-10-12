import { useProgress } from '@react-three/drei'
import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP)

/**
 * Load screen driven by real GLB progress, not a fake timer.
 *
 * The room is a 4.1 MB Draco payload; on a slow connection this is the page for
 * a few seconds, so it carries the name rather than a spinner.
 */
export function Preloader() {
  const { progress, active } = useProgress()
  const [gone, setGone] = useState(false)
  const root = useRef<HTMLOutputElement>(null)
  const bar = useRef<HTMLSpanElement>(null)

  useGSAP(
    () => {
      gsap.to(bar.current, {
        scaleX: Math.max(0.04, progress / 100),
        duration: 0.4,
        ease: 'power2.out',
      })
    },
    { dependencies: [progress], scope: root },
  )

  useEffect(() => {
    if (active || progress < 100) return
    const t = window.setTimeout(() => {
      gsap.to(root.current, {
        opacity: 0,
        duration: 0.6,
        ease: 'power2.inOut',
        onComplete: () => setGone(true),
      })
    }, 250)
    return () => window.clearTimeout(t)
  }, [active, progress])

  if (gone) return null

  // <output> is a status region, as role="status" on a div was. It takes only
  // phrasing content, so its children are spans made block.
  return (
    <output
      ref={root}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-void"
      aria-live="polite"
    >
      <span className="block font-mono text-sm tracking-tight text-bright">kr4t0n</span>
      <span className="mt-5 block h-px w-40 overflow-hidden bg-hair">
        <span ref={bar} className="block h-full origin-left scale-x-0 bg-acid" />
      </span>
      <span className="mt-4 block font-mono text-[11px] tracking-[0.2em] text-mute uppercase">
        Loading the room {Math.round(progress)}%
      </span>
    </output>
  )
}
