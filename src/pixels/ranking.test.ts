import { describe, expect, it } from 'vitest'
import anchors from '../ranking-anchors.json'
import type { PixelPayload, PixelProject } from '../shared/pixels'
import { ROWS, SEGMENTS, rankByTokens, shortTokens } from './ranking'

// The board is five rows of thirty-two LEDs on a wall, ~30 screen pixels tall
// when the room is framed. A screenshot cannot tell a correct ranking from a
// reversed one, so the arithmetic is checked here instead.

const withTokens = (rows: [string, number, number][]): PixelProject[] =>
  rows.map(([key, i, o]) => ({ key, wonSeconds: 0, tokens: { in: i, out: o, cached: 0 } }))

const payload = (projects: PixelProject[]): PixelPayload => ({
  start: '2026-07-26T16:00:00.000Z',
  slotMinutes: 60,
  slotCount: 4,
  tz: 'Asia/Shanghai',
  winners: [null, null, null, null],
  intensity: [0, 0, 0, 0],
  projects,
  live: [],
})

describe('rankByTokens', () => {
  const seven = payload(
    withTokens([
      ['a', 100, 5], // 105
      ['b', 1000, 10], // 1010, the leader
      ['c', 500, 1], // 501
      ['d', 10, 0], // 10
      ['e', 300, 0], // 300
      ['f', 900, 0], // 900, second
      ['g', 1, 0], // 1, falls off a five-row board
    ]),
  )
  const ranked = rankByTokens(seven)

  it('ranks by in + out, not by in alone', () => {
    expect(ranked.map((r) => r.project.key).join('')).toBe('bfcea')
    expect(ranked[0].total).toBe(1010)
  })

  it('truncates to the board’s rows', () => {
    expect(ranked).toHaveLength(ROWS)
    expect(rankByTokens(seven, 3)).toHaveLength(3)
  })

  it('numbers rows from 1 and keeps each project’s index for the palette', () => {
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5])
    expect(ranked.map((r) => r.index)).toEqual([1, 5, 2, 4, 0])
  })

  it('scores the leader 100 and fills every segment', () => {
    expect(ranked[0].score).toBe(100)
    expect(ranked[0].lit).toBe(SEGMENTS)
  })

  it('scores against the leader', () => {
    expect(ranked[1].score).toBeCloseTo((900 / 1010) * 100)
    expect(ranked[1].lit).toBe(Math.round((900 / 1010) * SEGMENTS))
  })

  it('scores fall monotonically', () => {
    expect(ranked.every((r, i) => i === 0 || r.score <= ranked[i - 1].score)).toBe(true)
  })

  it('keeps segment counts in range', () => {
    expect(ranked.every((r) => r.lit >= 1 && r.lit <= SEGMENTS)).toBe(true)
  })

  // A row carrying a name above an entirely unlit bar reads as a broken board
  // rather than a small project, and the spread here reaches 500:1.
  it('always lights one segment for a project that made the board', () => {
    const tiny = rankByTokens(
      payload(
        withTokens([
          ['big', 1e9, 0],
          ['tiny', 1, 0],
        ]),
      ),
    )
    expect(tiny[1].lit).toBe(1)
  })

  // The names lookup may fail without taking the board down, and then no
  // project has tokens. An empty board is right; a board ranking everything at
  // zero is not.
  it('drops projects with no token data rather than ranking them as zero', () => {
    const untokened = payload([
      { key: 'x', wonSeconds: 99 },
      { key: 'y', wonSeconds: 1 },
    ])
    expect(rankByTokens(untokened)).toEqual([])
  })

  it('breaks ties on key so rows do not swap between polls', () => {
    const tied = rankByTokens(
      payload(
        withTokens([
          ['zeta', 500, 0],
          ['alpha', 500, 0],
        ]),
      ),
    )
    expect(tied.map((r) => r.project.key)).toEqual(['alpha', 'zeta'])
  })
})

describe('shortTokens', () => {
  it.each([
    [5_676_270_874, '5.7B'],
    [450_141_549, '450M'],
    [84_341_190, '84M'],
    [1_500_000, '1.5M'],
    [12_345, '12K'],
    [1_500, '1.5K'],
  ])('abbreviates %i as %s without inventing precision', (n, short) => {
    expect(shortTokens(n)).toBe(short)
  })
})

// The anchors are measured at export from objects the export then deletes. If
// the board is re-modelled with a different row count, the frontend would draw
// live text into rows that no longer exist.
describe('ranking-anchors.json', () => {
  it('describes exactly the board’s rows', () => {
    expect(anchors.rows).toHaveLength(ROWS)
  })

  it('gives every row a name and a score box', () => {
    expect(anchors.rows.every((row) => row.name?.min && row.score?.min)).toBe(true)
  })

  it('has a text plane with real extent', () => {
    expect(anchors.screen.max[1]).toBeGreaterThan(anchors.screen.min[1])
    expect(anchors.screen.max[2]).toBeGreaterThan(anchors.screen.min[2])
  })
})
