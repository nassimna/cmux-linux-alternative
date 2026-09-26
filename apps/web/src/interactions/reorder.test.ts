import { describe, expect, it } from 'vitest'

import {
  destinationBoundaryForMove,
  normalizeReorder,
  normalizeTabReorder,
  normalizeWorkspaceReorder,
  reorderAtBoundary
} from './reorder'

describe('reorder normalization', () => {
  it('converts final indexes into pre-removal boundaries in both directions', () => {
    expect(destinationBoundaryForMove(0, 1, 3)).toBe(2)
    expect(destinationBoundaryForMove(0, 2, 3)).toBe(3)
    expect(destinationBoundaryForMove(2, 0, 3)).toBe(0)
    expect(destinationBoundaryForMove(1, 1, 3)).toBe(1)
  })

  it('rejects desired indexes outside the list', () => {
    expect(destinationBoundaryForMove(-1, 0, 2)).toBeNull()
    expect(destinationBoundaryForMove(0, 2, 2)).toBeNull()
    expect(destinationBoundaryForMove(0, 0, 0)).toBeNull()
  })

  it.each([
    [1, 4, 3, ['a', 'c', 'd', 'b']],
    [3, 1, 1, ['a', 'd', 'b', 'c']],
    [2, 2, 2, ['a', 'b', 'c', 'd']],
    [2, 3, 2, ['a', 'b', 'c', 'd']]
  ] as const)(
    'normalizes same-list boundary %i -> %i to index %i',
    (sourceIndex, targetBoundary, expectedIndex, expected) => {
      expect(normalizeWorkspaceReorder(sourceIndex, targetBoundary, 4)?.targetIndex).toBe(
        expectedIndex
      )
      expect(reorderAtBoundary(['a', 'b', 'c', 'd'], sourceIndex, targetBoundary)).toEqual(expected)
    }
  )

  it('normalizes cross-pane insertion, empty targets, bounds, and empty-target policy', () => {
    expect(
      normalizeReorder({
        sourceIndex: 1,
        targetIndex: 9,
        sourceLength: 3,
        targetLength: 2,
        sameList: false
      })
    ).toEqual({ sourceIndex: 1, targetIndex: 2, noOp: false })
    expect(
      normalizeReorder({
        sourceIndex: 0,
        targetIndex: -3,
        sourceLength: 1,
        targetLength: 0,
        sameList: false
      })
    ).toEqual({ sourceIndex: 0, targetIndex: 0, noOp: false })
    expect(
      normalizeReorder({
        sourceIndex: 0,
        targetIndex: 0,
        sourceLength: 1,
        targetLength: 0,
        sameList: false,
        emptyTargetPolicy: 'reject'
      })
    ).toBeNull()
  })

  it('derives same-pane removal shifts from pane identity', () => {
    expect(
      normalizeTabReorder({
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-a',
        sourceIndex: 1,
        targetIndex: 4,
        sourceLength: 4,
        targetLength: 4
      })
    ).toEqual({ sourceIndex: 1, targetIndex: 3, noOp: false })
    expect(
      normalizeTabReorder({
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
        sourceIndex: 1,
        targetIndex: 4,
        sourceLength: 4,
        targetLength: 4
      })
    ).toEqual({ sourceIndex: 1, targetIndex: 4, noOp: false })
  })

  it.each([
    { sourceIndex: -1, targetIndex: 0, sourceLength: 2, targetLength: 2, sameList: true },
    { sourceIndex: 2, targetIndex: 0, sourceLength: 2, targetLength: 2, sameList: true },
    { sourceIndex: 0.5, targetIndex: 0, sourceLength: 2, targetLength: 2, sameList: true },
    { sourceIndex: 0, targetIndex: 0, sourceLength: 2, targetLength: 3, sameList: true }
  ])('rejects invalid request %#', (request) => {
    expect(normalizeReorder(request)).toBeNull()
  })
})
