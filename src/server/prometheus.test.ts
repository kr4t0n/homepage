import { describe, expect, it, vi } from 'vitest'
import { validate } from '../shared/pixels'
import {
  LIVE_QUERY,
  SLOT_COUNT,
  assemble,
  currentSlot,
  gridQuery,
  gridStart,
  parseGrid,
  parseLive,
  parseTokens,
  slotEnd,
  tokensQuery,
} from './prometheus'
import type { Hours } from './prometheus'

/** 13:00 in Shanghai on 12 Nov 2026. */
const NOW = Date.parse('2026-11-12T05:00:00Z')
const START = Date.parse('2026-10-01T16:00:00Z')

const matrix = (result: unknown[]) => ({
  status: 'success',
  data: { resultType: 'matrix', result },
})
const vector = (result: unknown[]) => ({
  status: 'success',
  data: { resultType: 'vector', result },
})

describe('grid geometry', () => {
  it('starts at Shanghai midnight 41 days back', () => {
    expect(new Date(gridStart(NOW)).toISOString()).toBe(new Date(START).toISOString())
    // A second before midnight there, the grid still ends with the old day.
    expect(gridStart(Date.parse('2026-11-12T15:59:59Z'))).toBe(START)
    expect(gridStart(Date.parse('2026-11-12T16:00:00Z'))).toBe(START + 86_400_000)
  })

  it('does not depend on the host zone', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      vi.stubEnv('TZ', tz)
      expect(gridStart(NOW)).toBe(START)
    }
  })

  it('puts now in the last column, with the rest of the day still to come', () => {
    const cur = currentSlot(START, NOW)
    expect(cur).toBe(41 * 24 + 13)
    expect(slotEnd(START, cur)).toBe(NOW / 1000 + 3600)
    expect(slotEnd(START, SLOT_COUNT - 1)).toBe(START / 1000 + 42 * 86_400)
  })
})

describe('the queries', () => {
  const all = [gridQuery(NOW / 1000), LIVE_QUERY, tokensQuery(3_600_000)]

  // The citizen label must be summed away inside Prometheus, so no answer can
  // carry it; the society's own scope is not a project.
  it('group by project alone, or project and kind', () => {
    for (const q of all) {
      expect(q).not.toContain('agent')
      const groups = [...q.matchAll(/by \(([^)]*)\)/g)].map((m) => m[1])
      expect(groups.length).toBeGreaterThan(0)
      expect(groups.every((g) => g === 'project' || g === 'project, kind')).toBe(true)
    }
  })

  it('leave the society scope and unlabelled series out of every selector', () => {
    for (const q of all) {
      const selectors = [...q.matchAll(/stellaris_\w+\{([^}]*)\}/g)].map((m) => m[1])
      expect(selectors.length).toBeGreaterThan(0)
      for (const s of selectors) expect(s).toContain('project!="",project!="society"')
    }
  })

  it('stop counting at now, so the current hour reads no samples it has not had', () => {
    expect(gridQuery(1_794_462_433)).toContain('vector(time()) <= 1794462433')
  })
})

describe('parseGrid', () => {
  const ends = [100_800, 104_400]
  const series = (of: string, values: unknown[], project: unknown = 'demo') => ({
    metric: { project, of },
    values,
  })

  it('reads steps and turns per hour and project', () => {
    const hours = parseGrid(
      matrix([
        series('steps', [
          [100_800, '120'],
          [104_400, '3'],
        ]),
        series('turns', [[100_800, '240']]),
      ]),
      ends,
    )
    expect(hours.get(100_800)?.get('demo')).toEqual({ steps: 120, turns: 240 })
    expect(hours.get(104_400)?.get('demo')).toEqual({ steps: 3, turns: 0 })
  })

  it('reads an empty answer as nothing ran', () => {
    expect(parseGrid(matrix([]), ends).size).toBe(0)
  })

  it.each([
    ['an error status', { status: 'error', error: 'bad query' }],
    ['a vector', vector([])],
    ['a label that is no project slug', matrix([series('steps', [[100_800, '1']], '../etc')])],
    ['no project label', matrix([{ metric: { of: 'steps' }, values: [[100_800, '1']] }])],
    ['an unknown series', matrix([{ metric: { project: 'demo' }, values: [[100_800, '1']] }])],
    ['an hour not asked for', matrix([series('steps', [[100_801, '1']])])],
    ['more steps than an hour holds', matrix([series('steps', [[100_800, '121']])])],
    ['a fraction of a step', matrix([series('steps', [[100_800, '1.5']])])],
    ['a negative value', matrix([series('turns', [[100_800, '-1']])])],
    ['NaN', matrix([series('turns', [[100_800, 'NaN']])])],
    ['a number where Prometheus sends a string', matrix([series('steps', [[100_800, 1]])])],
  ])('refuses %s', (_, json) => {
    expect(() => parseGrid(json, ends)).toThrow(/malformed prometheus answer/)
  })
})

describe('parseLive', () => {
  it('keeps projects with a turn running', () => {
    const live = parseLive(
      vector([
        { metric: { project: 'demo' }, value: [1, '2'] },
        { metric: { project: 'web-app' }, value: [1, '0'] },
      ]),
    )
    expect([...live]).toEqual(['demo'])
  })

  it('refuses a matrix', () => {
    expect(() => parseLive(matrix([]))).toThrow(/resultType matrix, not vector/)
  })
})

describe('parseTokens', () => {
  const kinds = (project: string, k: Record<string, string>) =>
    Object.entries(k).map(([kind, v]) => ({ metric: { project, kind }, value: [1, v] }))

  it('counts both cache kinds in `in`, and cache reads again as `cached`', () => {
    const spent = parseTokens(
      vector(
        kinds('demo', { input: '100', output: '20', cache_read: '850.4', cache_write: '30.2' }),
      ),
    )
    expect(spent).toEqual({ demo: { in: 981, out: 20, cached: 850 } })
  })

  it('keeps `cached` within `in` after rounding', () => {
    const spent = parseTokens(vector(kinds('demo', { cache_read: '0.6', input: '0.4' })))
    expect(spent.demo).toEqual({ in: 1, out: 0, cached: 1 })
  })

  it('leaves out a project that spent nothing in the window', () => {
    expect(parseTokens(vector(kinds('idle', { input: '0', output: '0.2' })))).toEqual({})
  })

  it('refuses a kind it does not know how to count', () => {
    expect(() => parseTokens(vector(kinds('demo', { reasoning: '5' })))).toThrow(/token kind/)
  })
})

describe('assemble', () => {
  const at = (slot: number) => slotEnd(START, slot)
  const hours = (byEnd: Record<number, Record<string, [number, number?]>>): Hours =>
    new Map(
      Object.entries(byEnd).map(([end, byProject]) => [
        Number(end),
        new Map(
          Object.entries(byProject).map(([p, [steps, turns]]) => [
            p,
            { steps, turns: turns ?? steps },
          ]),
        ),
      ]),
    )

  it('gives each hour to the project busy for most of it', () => {
    const p = assemble(START, hours({ [at(3)]: { demo: [30], 'web-app': [90] } }), new Set(), [])
    expect(p.projects).toEqual([{ key: 'web-app' }, { key: 'demo' }])
    expect(p.winners[3]).toBe(0)
    expect(p.winners.filter((w) => w !== null)).toHaveLength(1)
  })

  // Union time ties at a full hour whenever two projects worked all of it.
  it('breaks a tie on busy time by turns running, then by key', () => {
    const p = assemble(
      START,
      hours({
        [at(1)]: { demo: [120, 120], 'web-app': [120, 360] },
        [at(2)]: { demo: [120, 360], 'web-app': [120, 120] },
        [at(4)]: { zeta: [6, 6], alpha: [6, 6] },
      }),
      new Set(),
      [],
    )
    const key = (slot: number) => p.projects[p.winners[slot]!].key
    expect([key(1), key(2), key(4)]).toEqual(['web-app', 'demo', 'alpha'])
  })

  it('scales brightness by all the busy time in an hour, against the busiest hour', () => {
    const p = assemble(
      START,
      hours({ [at(0)]: { demo: [120], 'web-app': [120] }, [at(1)]: { demo: [60] } }),
      new Set(),
      [],
    )
    expect([p.intensity[0], p.intensity[1], p.intensity[2]]).toEqual([100, 25, 0])
  })

  it('splits an hour the winner held under 70% of, in seconds', () => {
    const p = assemble(
      START,
      hours({
        [at(0)]: { demo: [69], 'web-app': [31] },
        [at(1)]: { demo: [70], 'web-app': [30] },
        [at(2)]: { demo: [120] },
      }),
      new Set(),
      [],
    )
    expect(p.breakdown).toEqual({ 0: { 0: 2070, 1: 930 } })
  })

  it('lists what ran, runs now or spent tokens, ranked by the time it won', () => {
    const p = assemble(
      START,
      hours({
        [at(0)]: { demo: [100], 'web-app': [50] },
        [at(1)]: { docs: [10] },
      }),
      new Set(['live-only', 'docs']),
      ['tokens-only', 'demo'],
    )
    expect(p.projects.map((x) => x.key)).toEqual([
      'demo',
      'docs',
      'live-only',
      'tokens-only',
      'web-app',
    ])
    expect(p.live).toEqual([1, 2])
  })

  it('skips hours outside the grid, and an hour where nothing ran', () => {
    const p = assemble(
      START,
      hours({
        [at(-1)]: { demo: [120] },
        [at(SLOT_COUNT)]: { demo: [120] },
        [at(5)]: { demo: [0] },
      }),
      new Set(),
      [],
    )
    expect(p.winners.every((w) => w === null)).toBe(true)
    expect(p.projects).toEqual([])
  })

  it('builds a payload the validator accepts, empty or full', () => {
    const full = assemble(START, hours({ [at(7)]: { demo: [1] } }), new Set(['demo']), ['x'])
    for (const p of [assemble(START, new Map(), new Set(), []), full]) {
      expect(() => validate(p)).not.toThrow()
      expect(p.slotCount).toBe(1008)
      expect(p.start).toBe(new Date(START).toISOString())
    }
  })
})
