import type { PixelPayload, PixelProject } from '../shared/pixels'

/**
 * Who is winning, by total tokens.
 *
 * The wall board has five physical rows of thirty-two LED segments, so this
 * reduces twelve projects to the five the hardware can show and turns each into
 * a segment count. Kept pure and free of three.js so the arithmetic can be
 * checked without a GPU — the board itself is unreadable in a screenshot at any
 * resolution the harness can afford.
 *
 * The metric is `in + out`, which is what "total tokens" means and what was
 * asked for. It is worth being clear-eyed about what that ranks: `in` carries
 * cache reads and they are ~85% of it, so this is very largely a ranking by
 * context replayed rather than by output produced. Ranking by `out` alone would
 * be a different and equally defensible board; it is not this one.
 *
 * It also disagrees with the pixel board beside it, on purpose. That board is
 * coloured by hours *won*, and an hour goes to whichever project was busiest in
 * it. `researchers` ranks third here on 1.3B tokens while holding a single hour
 * over on the heatmap. Two boards, two questions, two answers.
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
  /** 0-100 against the leader, which is what the board's "SCORE / 100" means. */
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
      // At least one segment for anything that made the board. The spread here
      // is extreme -- the leader is often 3-5x the runner-up -- so the lower
      // rows round to nothing, and a row with a name and an unlit bar reads as
      // broken rather than as small.
      lit: Math.max(1, Math.min(SEGMENTS, Math.round((score / 100) * SEGMENTS))),
    }
  })
}

/**
 * Abbreviate a token count for the board.
 *
 * Deliberately not the panel's formatter. The board has ~40mm of physical width
 * for this figure at a distance where 11px of screen text is generous, so it
 * takes one significant decimal and no unit words: `5.7B`, not `5.7B in`.
 */
export function shortTokens(n: number): string {
  const [div, unit] = n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : [1e3, 'K']
  const v = n / div
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${unit}`
}
