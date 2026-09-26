import {
  durableApplicationStateSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'

import { WindowMutationError } from './window-mutations'

type FocusTarget = DurableApplicationState['focusHistory']['entries'][number]

/** Moves the persisted focus cursor without appending a new history entry. */
export function navigateFocusHistory(
  state: DurableApplicationState,
  direction: 'back' | 'forward'
): { state: DurableApplicationState; target: FocusTarget } {
  const cursor = state.focusHistory.cursor + (direction === 'back' ? -1 : 1)
  const target = state.focusHistory.entries[cursor]
  if (!target) throw new WindowMutationError('policy_denied', 'No focus history in that direction')
  if (state.revision >= Number.MAX_SAFE_INTEGER)
    throw new WindowMutationError('resource_limit', 'Application revision cannot advance')

  const next = structuredClone(state)
  const placement = next.windowPlacements.find((item) => item.id === target.windowId)
  const workspace = next.workspaces.find((item) => item.id === target.workspaceId)
  const pane = workspace?.panes[target.paneId]
  if (!placement?.workspaceIds.includes(target.workspaceId) || !pane?.tabs.includes(target.tabId)) {
    throw new WindowMutationError('target_not_found', 'Focus history target is no longer present')
  }
  next.focusHistory.cursor = cursor
  next.focusedWindowId = target.windowId
  next.selectedWorkspaceId = target.workspaceId
  next.workspaceSelection = [target.workspaceId]
  placement.focusedWorkspaceId = target.workspaceId
  workspace!.selectedPaneId = target.paneId
  pane.selectedTabId = target.tabId
  next.revision += 1
  return { state: durableApplicationStateSchema.parse(next), target }
}
