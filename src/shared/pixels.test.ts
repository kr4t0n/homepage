import { describe, expect, it, vi } from 'vitest'
import { gridPos, liveSlot, slotLabel, slotShares, validate } from './pixels'
import type { PixelPayload } from './pixels'

const good = (): PixelPayload => ({
  start: '2026-07-26T16:00:00.000Z',
  slotMinutes: 60,
  slotCount: 4,
  tz: 'Asia/Shanghai',
  winners: [null, 0, 1, null],
  intensity: [0, 50, 100, 0],
  projects: [{ key: 'a' }, { key: 'b' }],
  live: [0],
})

/** The board's real geometry: six weeks of hourly slots, 24 rows by 42 columns. */
const board = (): PixelPayload => ({
  ...good(),
  slotCount: 1008,
  winners: Array<null>(1008).fill(null),
  intensity: Array<number>(1008).fill(0),
})

describe('validate', () => {
  it('accepts a well-formed payload', () => {
    expect(() => validate(good())).not.toThrow()
  })

  // Each case breaks one rule and expects that rule's own message, so a check
  // that stops working cannot hide behind a later one that happens to throw.
  it.each<[string, (p: PixelPayload) => void, RegExp]>([
    ['winners shorter than slotCount', (p) => p.winners.pop(), /winners length 3 !== slotCount 4/],
    [
      'intensity shorter than slotCount',
      (p) => p.intensity.pop(),
      /intensity length 3 !== slotCount 4/,
    ],
    // The one that matters most: winners are indices, so an out-of-range value
    // paints the wrong project's colour rather than failing loudly.
    [
      'a winner index past the end of projects',
      (p) => (p.winners[1] = 9),
      /winners\[1\] = 9 does not index/,
    ],
    [
      'a winner index one past the end of projects',
      (p) => (p.winners[1] = 2),
      /winners\[1\] = 2 does not index/,
    ],
    ['a negative winner index', (p) => (p.winners[1] = -1), /winners\[1\] = -1 does not index/],
    ['a fractional winner index', (p) => (p.winners[1] = 0.5), /winners\[1\] = 0.5 does not index/],
    ['intensity above 100', (p) => (p.intensity[1] = 101), /intensity\[1\] = 101 outside 0-100/],
    ['intensity below 0', (p) => (p.intensity[1] = -1), /intensity\[1\] = -1 outside 0-100/],
    [
      'an intensity that is not a number',
      (p) => ((p.intensity as unknown[])[1] = '50'),
      /intensity\[1\] = 50 outside 0-100/,
    ],
    ['a live index that names no project', (p) => (p.live = [7]), /live entry 7 does not index/],
    ['a live index one past the end', (p) => (p.live = [2]), /live entry 2 does not index/],
    ['a negative live index', (p) => (p.live = [-1]), /live entry -1 does not index/],
    ['live that is not an array', (p) => Object.assign(p, { live: 0 }), /live is not an array/],
    ['an unparseable start', (p) => (p.start = 'yesterday'), /start is not an ISO instant/],
    ['a missing start', (p) => Object.assign(p, { start: undefined }), /start is not an ISO/],
    ['slotMinutes of zero', (p) => (p.slotMinutes = 0), /: slotMinutes$/],
    [
      'slotCount of zero',
      (p) => Object.assign(p, { slotCount: 0, winners: [], intensity: [] }),
      /: slotCount$/,
    ],
    ['an empty tz', (p) => (p.tz = ''), /: tz$/],
    [
      'projects that is not an array',
      (p) => Object.assign(p, { projects: {} }),
      /projects is not an array/,
    ],
  ])('rejects %s', (_, mutate, message) => {
    const p = good()
    mutate(p)
    expect(() => validate(p)).toThrow(message)
  })

  it.each([null, undefined, 'payload', 42])('rejects %j, which is not an object', (p) => {
    expect(() => validate(p)).toThrow(/not an object/)
  })

  // Argus sends neither field, but a payload carrying them must still pass.
  it('tolerates projects with no hue and no other flag', () => {
    const p = good()
    expect(p.projects.some((x) => 'hue' in x || 'other' in x)).toBe(false)
    expect(() => validate(p)).not.toThrow()
  })

  it('tolerates hue and other if they come back', () => {
    const p = good()
    Object.assign(p.projects[0], { hue: 120, other: true })
    expect(() => validate(p)).not.toThrow()
  })
})

describe('liveSlot', () => {
  const p = board()
  const startMs = Date.parse(p.start)
  const hour = 60 * 60_000

  // The trap: the last column runs to end-of-day, so slotCount - 1 is in the
  // future.
  it('finds the current slot, not the last', () => {
    expect(liveSlot(p, startMs + 984 * hour + 30 * 60_000)).toBe(984)
  })

  it('changes slot on the hour, not before', () => {
    expect(liveSlot(p, startMs)).toBe(0)
    expect(liveSlot(p, startMs + hour - 1)).toBe(0)
    expect(liveSlot(p, startMs + hour)).toBe(1)
  })

  it('clamps before the grid starts', () => {
    expect(liveSlot(p, startMs - 1)).toBe(-1)
    expect(liveSlot(p, startMs - 5 * hour)).toBe(-1)
  })

  it('clamps past the grid end', () => {
    expect(liveSlot(p, startMs + 1e12)).toBe(1007)
  })
})

describe('gridPos', () => {
  const p = board()

  it.each([
    [0, { row: 0, col: 0 }, 'slot 0 is row 0 col 0'],
    [23, { row: 23, col: 0 }, 'slot 23 is the last row of col 0'],
    [24, { row: 0, col: 1 }, 'slot 24 starts col 1'],
    [1007, { row: 23, col: 41 }, 'slot 1007 is the last cell'],
  ])('maps slot %i to %o: %s', (slot, pos) => {
    expect(gridPos(p, slot)).toEqual(pos)
  })

  it('derives rows per column from slotMinutes', () => {
    expect(gridPos({ ...p, slotMinutes: 30 }, 48)).toEqual({ row: 0, col: 1 })
  })

  // The board is 24 rows x 42 columns of materials; every slot must land on one.
  it('maps all 1008 slots to distinct cells inside the 24x42 board', () => {
    const cells = Array.from({ length: 1008 }, (_, i) => gridPos(p, i))
    expect(new Set(cells.map(({ row, col }) => `${row},${col}`)).size).toBe(1008)
    expect(cells.every(({ row, col }) => row >= 0 && row < 24 && col >= 0 && col < 42)).toBe(true)
  })
})

describe('slotLabel', () => {
  const p = good()

  // 16:00 UTC is midnight in Shanghai, so slot 0 is the start of Monday there.
  it('labels a slot in the grid’s own timezone', () => {
    expect(slotLabel(p, 0)).toBe('Mon 27 Jul, 00:00')
    expect(slotLabel(p, 14)).toBe('Mon 27 Jul, 14:00')
    expect(slotLabel(p, 24)).toBe('Tue 28 Jul, 00:00')
  })

  it('gives every visitor the same label, wherever they are', () => {
    for (const tz of ['America/Los_Angeles', 'Europe/London', 'Asia/Shanghai']) {
      vi.stubEnv('TZ', tz)
      expect(slotLabel(p, 14)).toBe('Mon 27 Jul, 14:00')
    }
  })
})

describe('slotShares', () => {
  it('lists a contested slot busiest first', () => {
    const p = { ...good(), breakdown: { 1: { 0: 301, 1: 415 } } }
    expect(slotShares(p, 1)).toEqual([
      { projectIndex: 1, seconds: 415 },
      { projectIndex: 0, seconds: 301 },
    ])
  })

  it('gives an uncontested slot to its winner for the whole slot', () => {
    expect(slotShares(good(), 1)).toEqual([{ projectIndex: 0, seconds: 3600 }])
  })

  it('gives a slot nobody won to nobody', () => {
    expect(slotShares(good(), 0)).toEqual([])
    expect(slotShares(good(), 99)).toEqual([])
  })
})
