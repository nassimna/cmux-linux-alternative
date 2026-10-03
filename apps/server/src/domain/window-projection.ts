import type { DurableApplicationState } from '@agent-workspace/contracts'
import { windowListResultSchema } from '@agent-workspace/protocol-client'

/** Mirrors Rust's window_list/placement_snapshot over a validated isolated snapshot. */
export function projectWindowList(state: DurableApplicationState, idempotencyEpoch: string) {
  return windowListResultSchema.parse({
    revision: state.revision,
    idempotencyEpoch,
    focusedWindowId: state.focusedWindowId,
    windows: state.windowPlacements.map((placement) => {
      const workspace = state.workspaces.find(({ id }) => id === placement.focusedWorkspaceId)
      const pane = workspace?.panes[workspace.selectedPaneId]
      if (!workspace || !pane) throw new Error('Window focus references missing workspace or pane')
      return {
        windowId: placement.id,
        label: placement.label,
        workspaceIds: placement.workspaceIds,
        focusedWorkspaceId: placement.focusedWorkspaceId,
        hostingState: placement.hostingState,
        defaultTabDestination: {
          workspaceId: workspace.id,
          paneId: pane.id,
          destinationIndex: pane.tabs.length
        },
        revision: placement.revision
      }
    })
  })
}

/** Rust's project_state_to_window boundary for aggregate renderer reads. */
export function projectStateToWindow(
  state: DurableApplicationState,
  windowId: string
): DurableApplicationState | undefined {
  const placement = state.windowPlacements.find((item) => item.id === windowId)
  if (!placement) return undefined
  const owned = new Set(placement.workspaceIds)
  const projected = structuredClone(state)
  projected.workspaces = projected.workspaces.filter((item) => owned.has(item.id))
  projected.selectedWorkspaceId = owned.has(state.selectedWorkspaceId)
    ? state.selectedWorkspaceId : placement.focusedWorkspaceId
  projected.workspaceSelection = projected.workspaceSelection.filter((id) => owned.has(id))
  if (!projected.workspaceSelection.includes(projected.selectedWorkspaceId))
    projected.workspaceSelection.push(projected.selectedWorkspaceId)
  projected.workspacePins = projected.workspacePins.filter((id) => owned.has(id))
  projected.workspaceGroupAssignments = Object.fromEntries(
    Object.entries(projected.workspaceGroupAssignments).filter(([id]) => owned.has(id))
  )
  const ownedGroups = new Set(Object.values(projected.workspaceGroupAssignments))
  const assignedGroups = new Set(Object.values(state.workspaceGroupAssignments))
  projected.workspaceGroups = projected.workspaceGroups.filter((group) =>
    ownedGroups.has(group.id) || !assignedGroups.has(group.id)
  )
  projected.savedLayouts = []
  projected.legacyOverLimit = null
  projected.notifications = projected.notifications.filter((item) => owned.has(item.workspaceId))
  projected.windowPlacements = [structuredClone(placement)]
  projected.focusedWindowId = windowId
  projected.focusHistory.entries = projected.focusHistory.entries.filter((target) =>
    target.windowId === windowId
  )
  projected.focusHistory.cursor = Math.min(
    projected.focusHistory.cursor,
    Math.max(0, projected.focusHistory.entries.length - 1)
  )
  projected.recentlyClosed = projected.recentlyClosed.filter((item) =>
    owned.has(item.priorWorkspaceId)
  )
  return projected
}
