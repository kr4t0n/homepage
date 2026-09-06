/**
 * Shape of the Argus pixel payload, and the validation that decides whether we
 * are willing to serve it.
 *
 * Two fields the original integration brief describes are NOT here, because the
 * live endpoint no longer returns them, verified against production:
 *
 *   - `hue` on each project. Colour is entirely ours now; see PALETTE.
 *   - `other: true`, the collapsed tail of small projects. Argus returns every
 *     project individually (12 at time of writing), so collapsing the tail is
 *     also ours.
 *
 * Both are treated as optional rather than forbidden: if Argus reinstates them
 * the proxy keeps working and simply ignores them.
 */

export interface PixelProject {
  /** Opaque hash. Deliberately carries no name or path. */
  key: string
  wonSeconds: number
  /** Gone from the live payload; tolerated if it comes back. */
  other?: boolean
}

export interface PixelPayload {
  /** UTC instant of slot 0, ISO 8601. */
  start: string
  slotMinutes: number
  slotCount: number
  /** Zone the slots were bucketed in. NOT the viewer's zone — see readGrid. */
  tz: string
  /** Index into `projects`, or null when nothing ran. Length === slotCount. */
  winners: (number | null)[]
  /** 0-100, scaled against the busiest slot in this grid. Length === slotCount. */
  intensity: number[]
  projects: PixelProject[]
  /** Sparse: slot index -> project index -> seconds. Only for contested slots. */
  breakdown?: Record<string, Record<string, number>>
  /** Project indices running right now. Non-empty means blink. */
  live: number[]
}

/**
 * Reject a payload we cannot render truthfully.
 *
 * This is deliberately strict and runs on the server, not the client. A grid
 * painted from a malformed payload is worse than no grid: it looks authoritative
 * and is wrong. Better to fail the request and let the board stay unlit.
 */
export function validate(p: unknown): asserts p is PixelPayload {
  const bad = (why: string): never => {
    throw new Error(`malformed pixel payload: ${why}`)
  }
  if (typeof p !== 'object' || p === null) bad('not an object')
  const d = p as Record<string, unknown>

  if (typeof d.start !== 'string' || Number.isNaN(Date.parse(d.start))) {
    bad(`start is not an ISO instant (${String(d.start)})`)
  }
  if (typeof d.slotMinutes !== 'number' || d.slotMinutes <= 0) bad('slotMinutes')
  if (typeof d.slotCount !== 'number' || d.slotCount <= 0) bad('slotCount')
  if (typeof d.tz !== 'string' || !d.tz) bad('tz')

  const n = d.slotCount as number
  if (!Array.isArray(d.winners) || d.winners.length !== n) {
    bad(`winners length ${(d.winners as unknown[])?.length} !== slotCount ${n}`)
  }
  if (!Array.isArray(d.intensity) || d.intensity.length !== n) {
    bad(`intensity length ${(d.intensity as unknown[])?.length} !== slotCount ${n}`)
  }
  if (!Array.isArray(d.projects)) bad('projects is not an array')

  const projects = d.projects as unknown[]
  // The load-bearing check. `winners` holds INDICES into `projects`, so an index
  // past the end silently paints the wrong colour, or crashes the renderer.
  for (let i = 0; i < n; i++) {
    const w = (d.winners as unknown[])[i]
    if (w === null) continue
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w >= projects.length) {
      bad(`winners[${i}] = ${String(w)} does not index projects[0..${projects.length - 1}]`)
    }
    const v = (d.intensity as unknown[])[i]
    if (typeof v !== 'number' || v < 0 || v > 100) {
      bad(`intensity[${i}] = ${String(v)} outside 0-100`)
    }
  }
  if (!Array.isArray(d.live)) bad('live is not an array')
  for (const l of d.live as unknown[]) {
    if (typeof l !== 'number' || l < 0 || l >= projects.length) {
      bad(`live entry ${String(l)} does not index projects`)
    }
  }
}

/**
 * The slot that is happening right now, which is NOT slotCount - 1.
 *
 * The last column runs to end-of-day, so its later slots are in the future and
 * permanently idle. Rendering them as ordinary empty cells ends today's column
 * in a block of false dark. Callers should dim or omit anything past this index.
 *
 * Returns -1 if the grid has not started, or slotCount - 1 if it is entirely in
 * the past, so the result is always a safe array index to compare against.
 */
export function liveSlot(p: PixelPayload, now = Date.now()): number {
  const elapsed = now - Date.parse(p.start)
  const i = Math.floor(elapsed / (p.slotMinutes * 60_000))
  return Math.max(-1, Math.min(i, p.slotCount - 1))
}

/**
 * Grid position for a slot index.
 *
 * Days are columns, hours are rows. Derived from the index alone and never from
 * formatting a Date: the payload was already bucketed in its own `tz`, so a
 * visitor in another timezone must see an identical grid.
 */
export function gridPos(p: PixelPayload, i: number): { row: number; col: number } {
  const slotsPerDay = 1440 / p.slotMinutes
  return { row: i % slotsPerDay, col: Math.floor(i / slotsPerDay) }
}

/**
 * Human label for a slot, in the grid's own timezone.
 *
 * The timezone handling is the whole point of this function. `start` is a UTC
 * instant, but the grid was bucketed in `p.tz`, so slot 14 of a column is 14:00
 * *there* — not 14:00 wherever the visitor happens to be. Formatting a Date with
 * default locale settings would relabel every cell for anyone outside that zone
 * and quietly disagree with the row labels printed on the board itself, which
 * come from `i % 24` and cannot move.
 *
 * So the instant is computed by arithmetic on the slot index and then formatted
 * with an explicit `timeZone`. A visitor in London and one in Shanghai see the
 * same label on the same cell.
 */
export function slotLabel(p: PixelPayload, slot: number): string {
  const at = new Date(Date.parse(p.start) + slot * p.slotMinutes * 60_000)
  const day = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: p.tz,
  }).format(at)
  const hour = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: p.tz,
  }).format(at)
  return `${day}, ${hour}`
}

/** A slot's contested split, if Argus sent one. Sparse: most slots have none. */
export interface SlotShare {
  projectIndex: number
  seconds: number
}

/**
 * Who worked a slot and for how long, busiest first.
 *
 * `breakdown` is only present for slots where the winner held under ~70% of the
 * time, which is roughly a third of lit slots. When it is absent the winner had
 * the hour to itself, so the single-entry fallback is accurate rather than a
 * guess — but it is capped at the slot length, since Argus clamps concurrent
 * work and an hour cannot contain more than an hour.
 */
export function slotShares(p: PixelPayload, slot: number): SlotShare[] {
  const raw = p.breakdown?.[String(slot)]
  if (raw) {
    return Object.entries(raw)
      .map(([k, seconds]) => ({ projectIndex: Number(k), seconds }))
      .sort((a, b) => b.seconds - a.seconds)
  }
  const winner = p.winners[slot]
  if (winner === null || winner === undefined) return []
  return [{ projectIndex: winner, seconds: p.slotMinutes * 60 }]
}
