import { useEffect, useMemo, useState } from 'react'
import { Scene } from './three/Scene'
import { Hud } from './ui/Hud'
import { Panel } from './ui/Panel'
import { Preloader } from './ui/Preloader'
import { Fallback2D } from './ui/Fallback2D'
import { bindCursor, bindEscape, bindHistory } from './store'
import { bindTrack } from './audio/player'

/** One-shot capability probe. A failed context here means no canvas at all. */
const hasWebGL = (): boolean => {
  try {
    const c = document.createElement('canvas')
    return !!(
      window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl'))
    )
  } catch {
    return false
  }
}

/**
 * Below this width the hotspots are smaller than a fingertip and the GPU cost
 * is not worth it, so phones get the 2D route by default.
 */
const MIN_3D_WIDTH = 820

export default function App() {
  const gl = useMemo(hasWebGL, [])
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= MIN_3D_WIDTH,
  )

  useEffect(() => bindHistory(), [])
  useEffect(() => bindCursor(), [])
  // Escape leaves any focused mode, panel or framed screen alike.
  useEffect(() => bindEscape(), [])

  // Only the 3D room gets a soundtrack. The 2D fallback is what phones and
  // WebGL-less browsers see, and unprompted audio on a phone is worse than
  // silence: it is likely to be in public, and the fallback has no player to
  // turn it off from. The hook runs either way to keep hook order stable.
  useEffect(() => {
    if (!gl || !wide) return
    return bindTrack()
  }, [gl, wide])

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${MIN_3D_WIDTH}px)`)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  if (!gl) return <Fallback2D reason="nogl" />
  if (!wide) return <Fallback2D reason="small" />

  return (
    <>
      <div className="fixed inset-0">
        <Scene />
      </div>
      <Hud />
      <Panel />
      <Preloader />
    </>
  )
}
