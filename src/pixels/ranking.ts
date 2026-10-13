import type { PixelPayload, PixelProject } from '../shared/pixels'

/**
 * Who is winning, by total tokens: projects reduced to the board's five rows of
 * thirty-two LED segments. The metric is `in + out`, and `in` is mostly cache
 * reads, so this ranks context replayed more than output produced.
 */

/** Physical rows on the board. Cannot change without re-modelling it. */
export const ROWS = 5

/** LED segments per row. Likewise fixed by the mesh. */
export const SEGMENTS = 32

export interface RankedProject {
  project: PixelProject
  /** Index into `payload.projects`, so callers can reuse the board palette. */
  index: number
  /** 1-based row on the board. */
  rank: number
  /** tokens.in + tokens.out */
  total: number
  /** 0-100 against the leader. */
  score: number
  /** Segments to light, 1..SEGMENTS. */
  lit: number
}

/**
 * Rank projects by total tokens, best first, truncated to the board's rows.
 *
 * Projects with no `tokens` are dropped rather than sorted as zero. The lookup
 * that supplies them is allowed to fail, and a failed lookup should empty the
 * board rather than fill it with a meaningless bottom five.
 */
export function rankByTokens(payload: PixelPayload, rows = ROWS): RankedProject[] {
  const scored = payload.projects
    .map((project, index) => ({
      project,
      index,
      total: project.tokens ? project.tokens.in + project.tokens.out : -1,
    }))
    .filter((r) => r.total >= 0)
    // Key breaks ties so the board does not reshuffle equal rows between polls.
    .sort((a, b) => b.total - a.total || a.project.key.localeCompare(b.project.key))
    .slice(0, rows)

  const leader = scored[0]?.total ?? 0
  return scored.map((r, i) => {
    const score = leader > 0 ? (r.total / leader) * 100 : 0
    return {
      ...r,
      rank: i + 1,
      score,
      // At least one segment: the spread is wide enough to round lower rows to
      // nothing, and a named row over an unlit bar reads as broken, not small.
      lit: Math.max(1, Math.min(SEGMENTS, Math.round((score / 100) * SEGMENTS))),
    }
  })
}

/**
 * Abbreviate a token count for the board, which has ~40mm of width for it at a
 * distance where 11px of screen text is generous: at most one decimal and no
 * unit words, `5.7B` rather than `5.7B in`.
 */
export function shortTokens(n: number): string {
  const [div, unit] = n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : [1e3, 'K']
  const v = n / div
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${unit}`
}
