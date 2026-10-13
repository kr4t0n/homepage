import { usePixels } from '../pixels/usePixels'
import { colourFor, PALETTE_SIZE } from '../pixels/palette'
import { gridPos, slotLabel, slotShares } from '../shared/pixels'

/**
 * Per-cell readout for the focused activity board, anchored where the pointer
 * entered the cell (see setPixelHover).
 *
 * The one glass surface with a fill (`bg-void/92`): it sits over saturated lit
 * cells, where muted text needs a ~0.80 fill to reach 4.5:1 over acid, so 0.92
 * leaves margin for any cell colour.
 */

/** Keep the card fully on screen when a cell is near an edge. */
const W = 208
const MARGIN = 12

function seconds(s: number): string {
  if (s >= 3600) {
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  if (s >= 60) return `${Math.round(s / 60)}m`
  return `${Math.round(s)}s`
}

export function PixelTooltip() {
  const data = usePixels((s) => s.data)
  const hover = usePixels((s) => s.hover)
  const live = usePixels((s) => s.live)

  if (!data || !hover) return null

  const { slot, x, y } = hover
  const { row, col } = gridPos(data, slot)
  const future = live >= 0 && slot > live
  const shares = future ? [] : slotShares(data, slot)
  const busy = data.intensity[slot] ?? 0
  const isLive = slot === live && data.live.length > 0

  // Flip to the left of the pointer near the right edge, and clamp near the
  // bottom, so the card stays on screen.
  const flipX = x + W + MARGIN * 2 > window.innerWidth
  const left = flipX ? x - W - MARGIN : x + MARGIN

  return (
    <div
      // Driven by a 3D hover a screen reader cannot perform, so hidden rather
      // than announced as orphaned numbers. Nothing else in the DOM carries this
      // data; see Known gaps in README.
      aria-hidden
      className="glass pointer-events-none fixed z-40 rounded-[14px] bg-void/92 px-3.5 py-3"
      style={{ left, top: Math.min(y + MARGIN, window.innerHeight - 150), width: W }}
    >
      <p className="font-mono text-[10.5px] tracking-[0.18em] text-mute uppercase">
        {slotLabel(data, slot)}
      </p>

      {future ? (
        <p className="mt-2 text-sm text-mute">Hasn&rsquo;t happened yet.</p>
      ) : shares.length === 0 ? (
        <p className="mt-2 text-sm text-mute">Nothing ran.</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {shares.map((s) => (
              <li key={s.projectIndex} className="flex items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ background: colourFor(s.projectIndex).getStyle() }}
                />
                <span className="truncate text-[11px] text-body">
                  {/* The proxy's name where it resolved one, else the hash. */}
                  {data.projects[s.projectIndex]?.name ??
                    data.projects[s.projectIndex]?.key ??
                    'unknown'}
                  {s.projectIndex >= PALETTE_SIZE && <span className="text-mute"> · tail</span>}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-body tabular-nums">
                  {seconds(s.seconds)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 font-mono text-[10.5px] text-mute">
            {busy}% busy
            {isLive && <span className="text-acid"> · running now</span>}
          </p>
        </>
      )}

      <p className="mt-1 font-mono text-[10px] text-mute/70">
        row {row} · col {col}
      </p>
    </div>
  )
}
