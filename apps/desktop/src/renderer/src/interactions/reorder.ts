export type EmptyTargetPolicy = 'allow' | 'reject'

export interface ReorderRequest {
  readonly sourceIndex: number
  /** Insertion boundary in the target list before source removal. */
  readonly targetIndex: number
  readonly sourceLength: number
  readonly targetLength: number
  readonly sameList: boolean
  readonly emptyTargetPolicy?: EmptyTargetPolicy
}

export interface NormalizedReorder {
  readonly sourceIndex: number
  /** Insertion boundary after source removal, ready for Array.splice. */
  readonly targetIndex: number
  readonly noOp: boolean
}

export interface TabReorderRequest extends Omit<ReorderRequest, 'sameList'> {
  readonly sourcePaneId: string
  readonly targetPaneId: string
}

const isInteger = (value: number): boolean => Number.isSafeInteger(value)
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

/** Normalizes reorder boundaries without mutating either list. Invalid sources are rejected. */
export function normalizeReorder(request: ReorderRequest): NormalizedReorder | null {
  const { sourceIndex, targetIndex, sourceLength, targetLength, sameList } = request
  if (
    !isInteger(sourceIndex) ||
    !isInteger(targetIndex) ||
    !isInteger(sourceLength) ||
    !isInteger(targetLength) ||
    sourceLength <= 0 ||
    targetLength < 0 ||
    sourceIndex < 0 ||
    sourceIndex >= sourceLength ||
    (sameList && sourceLength !== targetLength) ||
    (targetLength === 0 && request.emptyTargetPolicy === 'reject')
  ) {
    return null
  }

  const boundedTarget = clamp(targetIndex, 0, targetLength)
  const shiftedTarget = sameList && sourceIndex < boundedTarget ? boundedTarget - 1 : boundedTarget
  const maximumAfterRemoval = sameList ? sourceLength - 1 : targetLength
  const normalizedTarget = clamp(shiftedTarget, 0, maximumAfterRemoval)
  return {
    sourceIndex,
    targetIndex: normalizedTarget,
    noOp: sameList && normalizedTarget === sourceIndex
  }
}

export function normalizeWorkspaceReorder(
  sourceIndex: number,
  targetIndex: number,
  workspaceCount: number
): NormalizedReorder | null {
  return normalizeReorder({
    sourceIndex,
    targetIndex,
    sourceLength: workspaceCount,
    targetLength: workspaceCount,
    sameList: true
  })
}

/** Derives same-list removal behavior from stable pane IDs. */
export function normalizeTabReorder(request: TabReorderRequest): NormalizedReorder | null {
  if (request.sourcePaneId.length === 0 || request.targetPaneId.length === 0) return null
  return normalizeReorder({
    sourceIndex: request.sourceIndex,
    targetIndex: request.targetIndex,
    sourceLength: request.sourceLength,
    targetLength: request.targetLength,
    sameList: request.sourcePaneId === request.targetPaneId,
    emptyTargetPolicy: request.emptyTargetPolicy ?? 'allow'
  })
}

export function reorderAtBoundary<T>(
  items: readonly T[],
  sourceIndex: number,
  targetIndex: number
): readonly T[] | null {
  const normalized = normalizeWorkspaceReorder(sourceIndex, targetIndex, items.length)
  if (normalized === null) return null
  if (normalized.noOp) return items
  const result = [...items]
  const [item] = result.splice(normalized.sourceIndex, 1)
  if (item === undefined) return null
  result.splice(normalized.targetIndex, 0, item)
  return result
}

/** Converts a desired final index into the server's pre-removal insertion boundary. */
export function destinationBoundaryForMove(
  sourceIndex: number,
  desiredIndex: number,
  itemCount: number
): number | null {
  if (
    !Number.isSafeInteger(sourceIndex) ||
    !Number.isSafeInteger(desiredIndex) ||
    !Number.isSafeInteger(itemCount) ||
    itemCount <= 0 ||
    sourceIndex < 0 ||
    sourceIndex >= itemCount ||
    desiredIndex < 0 ||
    desiredIndex >= itemCount
  ) {
    return null
  }
  return desiredIndex > sourceIndex ? desiredIndex + 1 : desiredIndex
}
