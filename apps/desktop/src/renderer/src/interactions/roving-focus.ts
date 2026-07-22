export type RovingFocusAction = 'next' | 'previous' | 'home' | 'end'

function validCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0
}

/** Returns -1 for an empty collection. Invalid current indices recover to a boundary. */
export function rovingFocusIndex(
  currentIndex: number,
  itemCount: number,
  action: RovingFocusAction,
  wrap = true
): number {
  if (!validCount(itemCount) || itemCount === 0) return -1
  if (action === 'home') return 0
  if (action === 'end') return itemCount - 1

  const currentIsValid =
    Number.isSafeInteger(currentIndex) && currentIndex >= 0 && currentIndex < itemCount
  if (!currentIsValid) return action === 'next' ? 0 : itemCount - 1
  if (action === 'next') {
    return currentIndex === itemCount - 1 ? (wrap ? 0 : currentIndex) : currentIndex + 1
  }
  return currentIndex === 0 ? (wrap ? itemCount - 1 : currentIndex) : currentIndex - 1
}

export const nextRovingFocusIndex = (
  currentIndex: number,
  itemCount: number,
  wrap = true
): number => rovingFocusIndex(currentIndex, itemCount, 'next', wrap)

export const previousRovingFocusIndex = (
  currentIndex: number,
  itemCount: number,
  wrap = true
): number => rovingFocusIndex(currentIndex, itemCount, 'previous', wrap)

export const homeRovingFocusIndex = (itemCount: number): number =>
  rovingFocusIndex(0, itemCount, 'home')

export const endRovingFocusIndex = (itemCount: number): number =>
  rovingFocusIndex(0, itemCount, 'end')
