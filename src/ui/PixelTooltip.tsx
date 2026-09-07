import { usePixels } from '../pixels/usePixels'
import { colourFor, PALETTE_SIZE } from '../pixels/palette'
import { gridPos, slotLabel, slotShares } from '../shared/pixels'

/**
 * Per-cell readout for the activity board.
 *
 * Anchored to where the pointer entered the cell rather than tracking it
 * continuously. A cell is roughly 20 screen pixels when the board is framed, so
 * an anchored card sits close enough to read as attached while costing one
 * render per cell instead of one per mouse event.
 *
 * Deliberately not the room-wide hover hint that used to live here and was
 * removed: this appears only for the focused board, only over a cell, and it
 * carries real numbers rather than restating a label already on screen.
 *
 * It is the one surface in the room that does NOT use clear glass, and that is
 * forced rather than chosen. Every other panel floats over the room; this floats
 * over the activity board, which is the brightest thing in the scene and made
 * entirely of saturated colour. Measured on clear glass, body text over a lit
 * acid cell came out at 1.03:1 — the worst contrast anywhere in the project.
 * Solving for the fill that brings muted text to 4.5:1 over rgb(154,213,18)
 * gives ~0.80, so 0.92 leaves margin for whatever colour a cell happens to be.
 * The hairline edge and radius stay, so it still reads as part of the family.
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

  // Flip to the left of the pointer near the right edge, and sit above it near
  // the bottom, so the card never runs off screen or covers the cell it
  // describes.
  const flipX = x + W + MARGIN * 2 > window.innerWidth
  const left = flipX ? x - W - MARGIN : x + MARGIN

  return (
    <div
      // Purely informational and driven by a 3D hover a screen reader cannot
      // perform, so it is hidden from the accessibility tree rather than
      // announced as orphaned numbers. The panel's legend carries the same data
      // in a readable form.
      aria-hidden
      className="glass pointer-events-none fixed z-40 rounded-[14px] bg-void/92 px-3.5 py-3"
      style={{ left, top: Math.min(y + MARGIN, window.innerHeight - 150), width: W }}
    >
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-mute">
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
                  {/* Named where the proxy could resolve one, hash otherwise —
                      a third of projects have no name upstream and fall back to
                      their directory basename, and a few may have neither. */}
                  {data.projects[s.projectIndex]?.name ??
                    data.projects[s.projectIndex]?.key ??
                    '—'}
                  {s.projectIndex >= PALETTE_SIZE && (
                    <span className="text-mute"> · tail</span>
                  )}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums text-body">
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
