import { describe, expect, it } from 'vitest'
import { HOTSPOTS, hotspotNodes } from './content'
import manifest from './scene-manifest.json'

// Signals is one hotspot over two meshes, all of it data, so it is checked here
// rather than by sweeping a pointer over screenshots, which pointer parallax
// makes unreliable.
describe('the signals hotspot', () => {
  const signals = HOTSPOTS.find((h) => h.id === 'signals')
  const nodes = signals ? hotspotNodes(signals) : []
  const entries = Object.values(manifest)
  const box = (node: string) => entries.find((e) => e.node === node)

  it('covers both wall boards', () => {
    expect(nodes).toContain('hot_pixelboard')
    expect(nodes).toContain('hot_ranking')
  })

  it('claims only nodes that exist in the manifest', () => {
    expect(nodes.filter((n) => !box(n))).toEqual([])
  })

  // Framing is the union of both boxes. If it silently fell back to the first
  // node, the camera would centre on the pixel board and push the ranking board
  // to the edge of frame, which still looks like a deliberate composition.
  const boxes = nodes.flatMap((n) => box(n) ?? [])
  const unionZ = [Math.min(...boxes.map((b) => b.min[2])), Math.max(...boxes.map((b) => b.max[2]))]

  it('frames the union of both boards, not just the pixel board', () => {
    const unionCentreZ = (unionZ[0] + unionZ[1]) / 2
    expect(Math.abs(unionCentreZ - (box('hot_pixelboard')?.centre[2] ?? NaN))).toBeGreaterThan(0.1)
  })

  // The pair has to fit the frame and fill enough of it for the labels to carry;
  // this ratio, not the standoff, is the invariant. At the 34° lens, visible
  // half-width is 0.49x the distance.
  it('fits both boards in the frame and fills most of it', () => {
    const frameWidth = 2 * 0.49 * (signals?.offset?.[0] ?? 0)
    const fill = (unionZ[1] - unionZ[0]) / frameWidth
    expect(fill).toBeGreaterThan(0.5)
    expect(fill).toBeLessThan(0.92)
  })

  it('opens no panel, since the boards carry the readout', () => {
    expect(signals?.bare).toBe(true)
  })
})
