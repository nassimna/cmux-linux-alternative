import type {
  PaneMoveTabParams,
  PaneSplitParams,
  TabMoveParams,
  WorkspaceSnapshot
} from '@agent-workspace/protocol-client'

import type { TabMutationIntent } from './intents'
import { destinationBoundaryForMove } from './reorder'

export type TabMutationCommand =
  | { readonly method: 'moveTab'; readonly params: TabMoveParams }
  | { readonly method: 'moveTabToPane'; readonly params: PaneMoveTabParams }
  | { readonly method: 'splitPane'; readonly params: PaneSplitParams }

const splitPlacement = {
  left: { axis: 'horizontal', placement: 'before' },
  right: { axis: 'horizontal', placement: 'after' },
  top: { axis: 'vertical', placement: 'before' },
  bottom: { axis: 'vertical', placement: 'after' }
} as const

/**
 * Resolves a serializable UI intent against the current projection. Pointer and
 * keyboard entry points both use this function before invoking the preload bridge.
 */
export function resolveTabMutationCommand(
  workspace: WorkspaceSnapshot,
  intent: TabMutationIntent
): TabMutationCommand | null {
  const sourcePane = workspace.panes.find((pane) => pane.id === intent.sourcePaneId)
  const targetPane = workspace.panes.find((pane) => pane.id === intent.targetPaneId)
  if (
    !sourcePane ||
    !targetPane ||
    !sourcePane.tabIds.includes(intent.tabId) ||
    !workspace.tabs.some((tab) => tab.id === intent.tabId)
  ) {
    return null
  }

  if (intent.kind === 'split-pane') {
    // Moving a pane's only tab into a split targeting that same pane would leave
    // the target leaf empty while trying to create its sibling.
    if (sourcePane.id === targetPane.id && sourcePane.tabIds.length === 1) return null
    const split = splitPlacement[intent.direction]
    return {
      method: 'splitPane',
      params: {
        workspaceId: workspace.id,
        targetPaneId: targetPane.id,
        axis: split.axis,
        ratio: 0.5,
        placement: split.placement,
        content: { kind: 'existingTab', tabId: intent.tabId }
      }
    }
  }

  if (!Number.isSafeInteger(intent.targetIndex) || intent.targetIndex < 0) return null
  if (sourcePane.id !== targetPane.id) {
    if (intent.targetIndex > targetPane.tabIds.length) return null
    return {
      method: 'moveTabToPane',
      params: {
        workspaceId: workspace.id,
        tabId: intent.tabId,
        destinationPaneId: targetPane.id,
        destinationIndex: intent.targetIndex
      }
    }
  }

  const sourceIndex = sourcePane.tabIds.indexOf(intent.tabId)
  if (intent.targetIndex >= sourcePane.tabIds.length || intent.targetIndex === sourceIndex) {
    return null
  }
  const destinationIndex = destinationBoundaryForMove(
    sourceIndex,
    intent.targetIndex,
    sourcePane.tabIds.length
  )
  if (destinationIndex === null) return null
  return {
    method: 'moveTab',
    params: {
      workspaceId: workspace.id,
      tabId: intent.tabId,
      destinationPaneId: targetPane.id,
      destinationIndex
    }
  }
}
