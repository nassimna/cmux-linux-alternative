export interface Point {
  readonly x: number
  readonly y: number
}

export interface Rect extends Point {
  readonly width: number
  readonly height: number
}

export type SplitDirection = 'left' | 'right' | 'top' | 'bottom'
export type DropZone = 'move' | SplitDirection

export interface DropZoneOptions {
  /** Empty space between the pane bounds and its active drop targets. */
  readonly inset?: number
  /** Preferred fraction of each axis occupied by each edge target. */
  readonly splitRatio?: number
  /** Preferred minimum thickness of an edge target in pixels. */
  readonly minSplitSize?: number
  /** Preferred minimum width and height of the center target in pixels. */
  readonly minCenterSize?: number
}

export interface DropZoneLayout {
  readonly bounds: Rect
  readonly move: Rect
  readonly left: Rect
  readonly right: Rect
  readonly top: Rect
  readonly bottom: Rect
}

const DEFAULT_OPTIONS = {
  inset: 8,
  splitRatio: 0.25,
  minSplitSize: 40,
  minCenterSize: 24
} as const

const isFiniteNumber = (value: number): boolean => Number.isFinite(value)

export function isValidPoint(point: Point): boolean {
  return isFiniteNumber(point.x) && isFiniteNumber(point.y)
}

export function isValidRect(rect: Rect): boolean {
  return (
    isValidPoint(rect) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

function isValidOptions(options: DropZoneOptions): boolean {
  return (
    (options.inset === undefined || (isFiniteNumber(options.inset) && options.inset >= 0)) &&
    (options.splitRatio === undefined ||
      (isFiniteNumber(options.splitRatio) && options.splitRatio > 0 && options.splitRatio < 0.5)) &&
    (options.minSplitSize === undefined ||
      (isFiniteNumber(options.minSplitSize) && options.minSplitSize >= 0)) &&
    (options.minCenterSize === undefined ||
      (isFiniteNumber(options.minCenterSize) && options.minCenterSize >= 0))
  )
}

function axisLayout(length: number, ratio: number, minSplit: number, minCenter: number) {
  // Preserve a non-zero center hit target. For very small panes this deliberately
  // shrinks both the requested inset and minimum sizes rather than hiding zones.
  const centerSize = Math.max(Math.min(minCenter, length / 3), Number.EPSILON)
  const maximumSplit = Math.max(0, (length - centerSize) / 2)
  const splitSize = Math.min(maximumSplit, Math.max(length * ratio, minSplit))
  return { splitSize, centerSize: length - splitSize * 2 }
}

/**
 * Calculates the five drop targets. Edge targets intentionally overlap at the
 * corners; `hitTestDropZone` resolves those overlaps by normalized edge distance.
 */
export function calculateDropZones(
  rect: Rect,
  options: DropZoneOptions = {}
): DropZoneLayout | null {
  if (!isValidRect(rect) || !isValidOptions(options)) return null

  const inset = options.inset ?? DEFAULT_OPTIONS.inset
  const maxInset = Math.max(0, Math.min(rect.width / 4, rect.height / 4))
  const effectiveInset = Math.min(inset, maxInset)
  const bounds: Rect = {
    x: rect.x + effectiveInset,
    y: rect.y + effectiveInset,
    width: rect.width - effectiveInset * 2,
    height: rect.height - effectiveInset * 2
  }
  const horizontal = axisLayout(
    bounds.width,
    options.splitRatio ?? DEFAULT_OPTIONS.splitRatio,
    options.minSplitSize ?? DEFAULT_OPTIONS.minSplitSize,
    options.minCenterSize ?? DEFAULT_OPTIONS.minCenterSize
  )
  const vertical = axisLayout(
    bounds.height,
    options.splitRatio ?? DEFAULT_OPTIONS.splitRatio,
    options.minSplitSize ?? DEFAULT_OPTIONS.minSplitSize,
    options.minCenterSize ?? DEFAULT_OPTIONS.minCenterSize
  )

  return {
    bounds,
    move: {
      x: bounds.x + horizontal.splitSize,
      y: bounds.y + vertical.splitSize,
      width: horizontal.centerSize,
      height: vertical.centerSize
    },
    left: { x: bounds.x, y: bounds.y, width: horizontal.splitSize, height: bounds.height },
    right: {
      x: bounds.x + bounds.width - horizontal.splitSize,
      y: bounds.y,
      width: horizontal.splitSize,
      height: bounds.height
    },
    top: { x: bounds.x, y: bounds.y, width: bounds.width, height: vertical.splitSize },
    bottom: {
      x: bounds.x,
      y: bounds.y + bounds.height - vertical.splitSize,
      width: bounds.width,
      height: vertical.splitSize
    }
  }
}

function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** Center boundaries belong to move; exact corner ties use left, right, top, bottom order. */
export function hitTestDropZone(layout: DropZoneLayout, point: Point): DropZone | null {
  if (
    !isValidRect(layout.bounds) ||
    !isValidRect(layout.move) ||
    !isValidRect(layout.left) ||
    !isValidRect(layout.right) ||
    !isValidRect(layout.top) ||
    !isValidRect(layout.bottom) ||
    !isValidPoint(point) ||
    !contains(layout.bounds, point)
  ) {
    return null
  }
  if (contains(layout.move, point)) return 'move'

  const distances: readonly [SplitDirection, number][] = [
    ['left', (point.x - layout.bounds.x) / layout.bounds.width],
    ['right', (layout.bounds.x + layout.bounds.width - point.x) / layout.bounds.width],
    ['top', (point.y - layout.bounds.y) / layout.bounds.height],
    ['bottom', (layout.bounds.y + layout.bounds.height - point.y) / layout.bounds.height]
  ]
  const eligible = distances.filter(([zone]) => contains(layout[zone], point))
  eligible.sort((left, right) => left[1] - right[1])
  return eligible[0]?.[0] ?? 'move'
}

export function dropZoneAtPoint(
  rect: Rect,
  point: Point,
  options: DropZoneOptions = {}
): DropZone | null {
  const layout = calculateDropZones(rect, options)
  return layout === null ? null : hitTestDropZone(layout, point)
}
