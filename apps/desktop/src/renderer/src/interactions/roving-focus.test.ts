import { describe, expect, it } from 'vitest'

import {
  endRovingFocusIndex,
  homeRovingFocusIndex,
  nextRovingFocusIndex,
  previousRovingFocusIndex,
  rovingFocusIndex
} from './roving-focus'

describe('roving focus indices', () => {
  it('handles empty and singleton collections', () => {
    expect(nextRovingFocusIndex(0, 0)).toBe(-1)
    expect(previousRovingFocusIndex(0, 0)).toBe(-1)
    expect(nextRovingFocusIndex(0, 1)).toBe(0)
    expect(previousRovingFocusIndex(0, 1)).toBe(0)
  })

  it('wraps next and previous by default', () => {
    expect(nextRovingFocusIndex(2, 3)).toBe(0)
    expect(previousRovingFocusIndex(0, 3)).toBe(2)
  })

  it('can stop at collection boundaries', () => {
    expect(nextRovingFocusIndex(2, 3, false)).toBe(2)
    expect(previousRovingFocusIndex(0, 3, false)).toBe(0)
  })

  it('supports home, end, and invalid-index recovery', () => {
    expect(homeRovingFocusIndex(4)).toBe(0)
    expect(endRovingFocusIndex(4)).toBe(3)
    expect(rovingFocusIndex(-1, 4, 'next')).toBe(0)
    expect(rovingFocusIndex(99, 4, 'previous')).toBe(3)
  })

  it('rejects invalid counts safely', () => {
    expect(rovingFocusIndex(0, Number.NaN, 'next')).toBe(-1)
    expect(rovingFocusIndex(0, -1, 'next')).toBe(-1)
  })
})
