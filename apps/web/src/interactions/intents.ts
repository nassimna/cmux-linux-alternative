import {
  dropZoneAtPoint,
  type DropZoneOptions,
  type Point,
  type Rect,
  type SplitDirection
} from './geometry'

export type TabMutationIntent =
  | {
      readonly kind: 'move-tab'
      readonly tabId: string
      readonly sourcePaneId: string
      readonly targetPaneId: string
      readonly targetIndex: number
    }
  | {
      readonly kind: 'split-pane'
      readonly tabId: string
      readonly sourcePaneId: string
      readonly targetPaneId: string
      readonly direction: SplitDirection
    }

export type TabDropAction =
  | { readonly kind: 'move'; readonly targetPaneId: string; readonly targetIndex: number }
  | {
      readonly kind: 'split'
      readonly targetPaneId: string
      readonly direction: SplitDirection
    }

export interface TabMutationSource {
  readonly tabId: string
  readonly sourcePaneId: string
}

export interface PointerDropRequest extends TabMutationSource {
  readonly point: Point
  readonly targetRect: Rect
  readonly targetPaneId: string
  readonly targetIndex: number
  readonly zoneOptions?: DropZoneOptions
}

export type PointerDropTarget = Omit<PointerDropRequest, keyof TabMutationSource>

function hasValidIdentity(source: TabMutationSource, targetPaneId: string): boolean {
  return source.tabId.length > 0 && source.sourcePaneId.length > 0 && targetPaneId.length > 0
}

/** Shared action-to-mutation path used by both pointer and keyboard entry points. */
export function tabActionToMutation(
  source: TabMutationSource,
  action: TabDropAction
): TabMutationIntent | null {
  if (!hasValidIdentity(source, action.targetPaneId)) return null
  if (action.kind === 'move') {
    if (!Number.isSafeInteger(action.targetIndex) || action.targetIndex < 0) return null
    return {
      kind: 'move-tab',
      tabId: source.tabId,
      sourcePaneId: source.sourcePaneId,
      targetPaneId: action.targetPaneId,
      targetIndex: action.targetIndex
    }
  }
  return {
    kind: 'split-pane',
    tabId: source.tabId,
    sourcePaneId: source.sourcePaneId,
    targetPaneId: action.targetPaneId,
    direction: action.direction
  }
}

export function pointerToDropAction(request: PointerDropTarget): TabDropAction | null {
  const zone = dropZoneAtPoint(request.targetRect, request.point, request.zoneOptions)
  if (zone === null) return null
  return zone === 'move'
    ? { kind: 'move', targetPaneId: request.targetPaneId, targetIndex: request.targetIndex }
    : { kind: 'split', targetPaneId: request.targetPaneId, direction: zone }
}

export function pointerDropToMutation(request: PointerDropRequest): TabMutationIntent | null {
  const action = pointerToDropAction(request)
  if (action === null) return null
  return tabActionToMutation(request, action)
}

export function keyboardDropToMutation(
  source: TabMutationSource,
  action: TabDropAction
): TabMutationIntent | null {
  return tabActionToMutation(source, action)
}
