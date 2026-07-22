import { isValidRect, type Rect } from './geometry'

export type FocusDirection = 'left' | 'right' | 'up' | 'down'

export interface PaneGeometry {
  readonly id: string
  readonly rect: Rect
}

interface CandidateScore {
  readonly pane: PaneGeometry
  readonly primaryDistance: number
  readonly hasOverlap: boolean
  readonly secondaryGap: number
  readonly secondaryCenterDistance: number
}

const centerX = (rect: Rect): number => rect.x + rect.width / 2
const centerY = (rect: Rect): number => rect.y + rect.height / 2

function intervalGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.max(aStart, bStart) - Math.min(aEnd, bEnd))
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0
}

function scoreCandidate(
  current: Rect,
  candidate: PaneGeometry,
  direction: FocusDirection
): CandidateScore | null {
  const horizontal = direction === 'left' || direction === 'right'
  const sign = direction === 'left' || direction === 'up' ? -1 : 1
  const currentPrimary = horizontal ? centerX(current) : centerY(current)
  const candidatePrimary = horizontal ? centerX(candidate.rect) : centerY(candidate.rect)
  const primaryDistance = sign * (candidatePrimary - currentPrimary)
  if (primaryDistance <= 0) return null

  const currentSecondaryStart = horizontal ? current.y : current.x
  const currentSecondaryEnd = horizontal ? current.y + current.height : current.x + current.width
  const candidateSecondaryStart = horizontal ? candidate.rect.y : candidate.rect.x
  const candidateSecondaryEnd = horizontal
    ? candidate.rect.y + candidate.rect.height
    : candidate.rect.x + candidate.rect.width
  const secondaryGap = intervalGap(
    currentSecondaryStart,
    currentSecondaryEnd,
    candidateSecondaryStart,
    candidateSecondaryEnd
  )
  const currentSecondaryCenter = horizontal ? centerY(current) : centerX(current)
  const candidateSecondaryCenter = horizontal ? centerY(candidate.rect) : centerX(candidate.rect)

  return {
    pane: candidate,
    primaryDistance,
    hasOverlap: intervalsOverlap(
      currentSecondaryStart,
      currentSecondaryEnd,
      candidateSecondaryStart,
      candidateSecondaryEnd
    ),
    secondaryGap,
    secondaryCenterDistance: Math.abs(candidateSecondaryCenter - currentSecondaryCenter)
  }
}

/** Finds a pane in the requested center half-plane using deterministic geometry ranking. */
export function findDirectionalPane(
  currentPaneId: string,
  direction: FocusDirection,
  panes: readonly PaneGeometry[]
): string | null {
  const current = panes.find((pane) => pane.id === currentPaneId)
  if (current === undefined || !isValidRect(current.rect)) return null

  const scores = panes
    .filter((pane) => pane.id !== currentPaneId && pane.id.length > 0 && isValidRect(pane.rect))
    .map((pane) => scoreCandidate(current.rect, pane, direction))
    .filter((score): score is CandidateScore => score !== null)

  scores.sort(
    (left, right) =>
      left.primaryDistance - right.primaryDistance ||
      Number(right.hasOverlap) - Number(left.hasOverlap) ||
      left.secondaryGap - right.secondaryGap ||
      left.secondaryCenterDistance - right.secondaryCenterDistance ||
      left.pane.id.localeCompare(right.pane.id)
  )
  return scores[0]?.pane.id ?? null
}
