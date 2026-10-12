import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { gridPos } from '../shared/pixels'
import type { PixelPayload } from '../shared/pixels'
import {
  PALETTE_SIZE,
  cellAppearance,
  colourFor,
  indexCells,
  materialName,
  slotFromMaterialName,
} from './palette'

const hex = (c: THREE.Color) => `#${c.getHexString()}`

describe('colourFor', () => {
  it('leaves an hour nobody won unlit', () => {
    expect(hex(colourFor(null))).toBe('#000000')
  })

  it('gives the busiest project the room’s acid accent', () => {
    expect(hex(colourFor(0))).toBe('#9ef01a')
  })

  it('gives every palette project a colour of its own', () => {
    const colours = Array.from({ length: PALETTE_SIZE }, (_, i) => hex(colourFor(i)))
    expect(new Set(colours).size).toBe(PALETTE_SIZE)
    expect(colours).not.toContain('#000000')
  })

  // The tail is still lit, since the hour happened, but in one shared colour.
  it('collapses every project past the palette into one tail colour', () => {
    const tail = hex(colourFor(PALETTE_SIZE))
    expect(tail).toBe('#64748b')
    expect(hex(colourFor(PALETTE_SIZE + 5))).toBe(tail)
    expect(tail).not.toBe('#000000')
  })
})

describe('material names', () => {
  it('names cells from R01 C01 to R24 C42', () => {
    expect(materialName(0, 0)).toBe('Pixel Light R01 C01')
    expect(materialName(23, 41)).toBe('Pixel Light R24 C42')
  })

  // A raycast hit is resolved from the material name alone, so the name has to
  // lead back to the slot the painter lit through gridPos.
  it('lead back to the slot gridPos placed there, for all 1008 cells', () => {
    const p = { slotMinutes: 60 } as PixelPayload
    const wrong = Array.from({ length: 1008 }, (_, slot) => slot).filter((slot) => {
      const { row, col } = gridPos(p, slot)
      return slotFromMaterialName(materialName(row, col)) !== slot
    })
    expect(wrong).toEqual([])
  })

  it.each(['Wall', 'Pixel Light R01', 'Pixel Light R01 C01.001', 'pixel light R01 C01'])(
    'reads %j as no pixel at all',
    (name) => {
      expect(slotFromMaterialName(name)).toBeNull()
    },
  )
})

describe('indexCells', () => {
  const pixel = (name: string) => new THREE.MeshStandardMaterial({ name })

  it('keys every pixel material by its slot, with the mesh that carries it', () => {
    const r02c01 = new THREE.Mesh(new THREE.BufferGeometry(), pixel('Pixel Light R02 C01'))
    const r01c02 = new THREE.Mesh(new THREE.BufferGeometry(), [
      new THREE.MeshStandardMaterial({ name: 'Frame' }),
      pixel('Pixel Light R01 C02'),
    ])
    const root = new THREE.Group().add(new THREE.Group().add(r02c01), r01c02)

    const cells = indexCells(root)
    expect([...cells.keys()].sort((a, b) => a - b)).toEqual([1, 24])
    expect(cells.get(1)).toMatchObject({ slot: 1, mesh: r02c01, material: r02c01.material })
    expect(cells.get(24)?.mesh).toBe(r01c02)
    expect(cells.get(24)?.material.name).toBe('Pixel Light R01 C02')
  })

  it('ignores what is not a standard pixel material', () => {
    const root = new THREE.Group().add(
      new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ name: 'Pixel Light R01 C01' }),
      ),
      new THREE.Mesh(new THREE.BufferGeometry(), pixel('Pixel Light trim')),
    )
    expect(indexCells(root).size).toBe(0)
  })
})

describe('cellAppearance', () => {
  const p: PixelPayload = {
    start: '2026-07-26T16:00:00.000Z',
    slotMinutes: 60,
    slotCount: 4,
    tz: 'Asia/Shanghai',
    winners: [null, 0, 1, 1],
    intensity: [0, 50, 100, 10],
    projects: [
      { key: 'a', wonSeconds: 10 },
      { key: 'b', wonSeconds: 5 },
    ],
    live: [],
  }

  it('leaves an hour nobody won dark', () => {
    const cell = cellAppearance(p, 0, 3)
    expect(hex(cell.colour)).toBe('#000000')
    expect(cell.intensity).toBe(0)
  })

  it('colours a cell by its winner and brightens it by how busy the hour was', () => {
    const half = cellAppearance(p, 1, 3)
    const full = cellAppearance(p, 2, 3)
    expect(hex(half.colour)).toBe(hex(colourFor(0)))
    expect(hex(full.colour)).toBe(hex(colourFor(1)))
    expect(full.intensity).toBeGreaterThan(0)
    expect(half.intensity).toBeCloseTo(full.intensity / 2)
  })

  // Hue says who owned the hour and brightness how busy it was, so a quiet hour
  // keeps its owner's colour.
  it('keeps a quiet hour in its owner’s colour', () => {
    const quiet = cellAppearance(p, 3, 3)
    expect(hex(quiet.colour)).toBe(hex(colourFor(1)))
    expect(quiet.intensity).toBeCloseTo(cellAppearance(p, 2, 3).intensity / 10)
  })

  // The last column runs to end-of-day, so slots after the live one have not
  // happened yet and must not read as activity.
  it('leaves every slot after the live one dark', () => {
    const future = cellAppearance(p, 2, 1)
    expect(hex(future.colour)).toBe('#000000')
    expect(future.intensity).toBe(0)
    expect(cellAppearance(p, 1, 1).intensity).toBeGreaterThan(0)
  })
})
