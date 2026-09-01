import { useProgress } from '@react-three/drei'
import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP)

/**
 * Load screen driven by real GLB progress, not a fake timer.
 *
 * The room is a 3.6 MB Draco payload; on a slow connection this is the page for
 * a few seconds, so it carries the name rather than a spinner.
 */
export function Preloader() {
  const { progress, active } = useProgress()
  const [gone, setGone] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)

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

  return (
    <div
      ref={root}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-void"
      role="status"
      aria-live="polite"
    >
      <p className="font-mono text-sm tracking-tight text-bright">kr4t0n</p>
      <div className="mt-5 h-px w-40 overflow-hidden bg-hair">
        <div ref={bar} className="h-full origin-left scale-x-0 bg-acid" />
      </div>
      <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.2em] text-mute">
        Loading the room {Math.round(progress)}%
      </p>
    </div>
  )
}
