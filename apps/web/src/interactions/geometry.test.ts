import { describe, expect, it } from 'vitest'

import { calculateDropZones, dropZoneAtPoint, hitTestDropZone, type Point } from './geometry'

describe('drop-zone geometry', () => {
  const rect = { x: 0, y: 0, width: 200, height: 120 }
  const cases: readonly [string, Point][] = [
    ['left', { x: 10, y: 60 }],
    ['right', { x: 190, y: 60 }],
    ['top', { x: 100, y: 10 }],
    ['bottom', { x: 100, y: 110 }],
    ['move', { x: 100, y: 60 }]
  ]

  it.each(cases)('maps a point to the %s target', (zone, point) => {
    expect(dropZoneAtPoint(rect, point)).toBe(zone)
  })

  it('keeps every target usable for tiny valid rectangles', () => {
    const tiny = { x: 4, y: 7, width: 4, height: 4 }
    const layout = calculateDropZones(tiny)
    expect(layout).not.toBeNull()
    expect(hitTestDropZone(layout!, { x: layout!.bounds.x, y: 9 })).toBe('left')
    expect(hitTestDropZone(layout!, { x: layout!.bounds.x + layout!.bounds.width, y: 9 })).toBe(
      'right'
    )
    expect(hitTestDropZone(layout!, { x: 6, y: layout!.bounds.y })).toBe('top')
    expect(hitTestDropZone(layout!, { x: 6, y: layout!.bounds.y + layout!.bounds.height })).toBe(
      'bottom'
    )
    expect(dropZoneAtPoint(tiny, { x: 6, y: 9 })).toBe('move')
  })

  it('assigns center boundaries to move and resolves exact corner ties stably', () => {
    const layout = calculateDropZones(rect, { inset: 0, minSplitSize: 20 })
    expect(layout).not.toBeNull()
    expect(hitTestDropZone(layout!, { x: layout!.move.x, y: layout!.move.y })).toBe('move')
    expect(hitTestDropZone(layout!, { x: 0, y: 0 })).toBe('left')
  })

  it.each([
    [
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0, y: 0 }
    ],
    [
      { x: 0, y: 0, width: Number.NaN, height: 1 },
      { x: 0, y: 0 }
    ],
    [rect, { x: Number.POSITIVE_INFINITY, y: 0 }]
  ] as const)('rejects invalid geometry safely', (invalidRect, point) => {
    expect(dropZoneAtPoint(invalidRect, point)).toBeNull()
  })

  it('returns null in the configured inset and outside the pane', () => {
    expect(dropZoneAtPoint(rect, { x: 2, y: 60 })).toBeNull()
    expect(dropZoneAtPoint(rect, { x: 300, y: 60 })).toBeNull()
  })
})
