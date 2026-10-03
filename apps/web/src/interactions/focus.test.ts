import { describe, expect, it } from 'vitest'

import { findDirectionalPane, type FocusDirection, type PaneGeometry } from './focus'

describe('directional pane focus', () => {
  const panes: readonly PaneGeometry[] = [
    { id: 'center', rect: { x: 100, y: 100, width: 40, height: 40 } },
    { id: 'left', rect: { x: 20, y: 100, width: 40, height: 40 } },
    { id: 'right', rect: { x: 180, y: 100, width: 40, height: 40 } },
    { id: 'up', rect: { x: 100, y: 20, width: 40, height: 40 } },
    { id: 'down', rect: { x: 100, y: 180, width: 40, height: 40 } }
  ]

  it.each([
    ['left', 'left'],
    ['right', 'right'],
    ['up', 'up'],
    ['down', 'down']
  ] as const)('finds the exact %s neighbor', (direction, expected) => {
    expect(findDirectionalPane('center', direction, panes)).toBe(expected)
  })

  it('filters candidates outside the requested half-plane', () => {
    expect(findDirectionalPane('right', 'right', panes)).toBeNull()
  })

  it('prefers orthogonal overlap after equal primary distance', () => {
    const candidates: readonly PaneGeometry[] = [
      { id: 'current', rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'diagonal', rect: { x: 150, y: 120, width: 100, height: 100 } },
      { id: 'overlap', rect: { x: 150, y: 90, width: 100, height: 100 } }
    ]
    expect(findDirectionalPane('current', 'right', candidates)).toBe('overlap')
  })

  it('uses stable IDs after all geometric ties', () => {
    const candidates: readonly PaneGeometry[] = [
      { id: 'current', rect: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'z-pane', rect: { x: 20, y: 0, width: 10, height: 10 } },
      { id: 'a-pane', rect: { x: 20, y: 0, width: 10, height: 10 } }
    ]
    expect(findDirectionalPane('current', 'right', candidates)).toBe('a-pane')
  })

  it.each(['left', 'right', 'up', 'down'] as readonly FocusDirection[])(
    'ignores invalid geometry when moving %s',
    (direction) => {
      expect(
        findDirectionalPane('current', direction, [
          { id: 'current', rect: { x: 0, y: 0, width: 10, height: 10 } },
          { id: 'invalid', rect: { x: Number.NaN, y: 0, width: 10, height: 10 } }
        ])
      ).toBeNull()
    }
  )
})
