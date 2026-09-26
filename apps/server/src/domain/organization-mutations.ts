import {
  durableApplicationStateSchema,
  workspaceOrganizationGetResultSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'

import { WorkspaceMutationError } from './workspace-mutations'

/** Produces the protocol organization view without exposing unrelated durable data. */
export function projectOrganization(state: DurableApplicationState) {
  const legacy = state.legacyOverLimit
  const organization = {
    revision: state.revision,
    selection: state.workspaceSelection,
    focusedWorkspaceId: state.selectedWorkspaceId,
    pins: state.workspacePins,
    groups: state.workspaceGroups,
    assignments: Object.entries(state.workspaceGroupAssignments)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([workspaceId, groupId]) => ({ workspaceId, groupId })),
    ...(legacy
      ? {
          legacyOverLimit: {
            ...legacy,
            exceededDimensions: [
              legacy.workspaceCount > 128 && 'workspaces',
              legacy.maximumPanesInWorkspace > 64 && 'panesPerWorkspace',
              legacy.maximumTabsInWorkspace > 128 && 'tabsPerWorkspace',
              legacy.totalPaneCount > 1_024 && 'totalPanes',
              legacy.totalTabCount > 2_048 && 'totalTabs'
            ].filter(Boolean)
          }
        }
      : {})
  }
  return workspaceOrganizationGetResultSchema.parse({ organization })
}

function commit(next: DurableApplicationState): DurableApplicationState {
  if (next.revision >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceMutationError('revision_overflow', 'Application revision cannot advance')
  }
  next.revision += 1
  return durableApplicationStateSchema.parse(next)
}

function groupIndex(state: DurableApplicationState, groupId: string): number {
  const index = state.workspaceGroups.findIndex((group) => group.id === groupId)
  if (index < 0)
    throw new WorkspaceMutationError('group_not_found', 'Workspace group does not exist')
  return index
}

/** Pin membership is ordered by the first successful pin, as in Rust. */
export function setWorkspacePinned(
  state: DurableApplicationState,
  workspaceId: string,
  pinned: boolean
): DurableApplicationState {
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  }
  const present = state.workspacePins.includes(workspaceId)
  if (present === pinned) return state
  if (pinned && state.workspacePins.length >= 128) {
    throw new WorkspaceMutationError('workspace_limit_reached', 'Workspace pin limit reached')
  }
  const next = structuredClone(state)
  if (pinned) next.workspacePins.push(workspaceId)
  else next.workspacePins = next.workspacePins.filter((id) => id !== workspaceId)
  return commit(next)
}

export function createGroup(
  state: DurableApplicationState,
  groupId: string,
  name: string
): DurableApplicationState {
  if (state.workspaceGroups.some((group) => group.id === groupId)) {
    throw new WorkspaceMutationError('duplicate_identity', 'Workspace group ID is in use')
  }
  if (state.workspaceGroups.length >= 128) {
    throw new WorkspaceMutationError('group_limit_reached', 'Workspace group limit reached')
  }
  const next = structuredClone(state)
  next.workspaceGroups.push({
    id: groupId,
    name,
    collapsed: false,
    order: next.workspaceGroups.length
  })
  return commit(next)
}

export function renameGroup(
  state: DurableApplicationState,
  groupId: string,
  name: string
): DurableApplicationState {
  const index = groupIndex(state, groupId)
  if (state.workspaceGroups[index]!.name === name) return state
  const next = structuredClone(state)
  next.workspaceGroups[index]!.name = name
  return commit(next)
}

export function deleteGroup(
  state: DurableApplicationState,
  groupId: string
): DurableApplicationState {
  const index = groupIndex(state, groupId)
  const next = structuredClone(state)
  next.workspaceGroups.splice(index, 1)
  next.workspaceGroups.forEach((group, order) => {
    group.order = order
  })
  next.workspaceGroupAssignments = Object.fromEntries(
    Object.entries(next.workspaceGroupAssignments).filter(([, assigned]) => assigned !== groupId)
  )
  return commit(next)
}

export function moveGroup(
  state: DurableApplicationState,
  groupId: string,
  destinationIndex: number
): DurableApplicationState {
  const sourceIndex = groupIndex(state, groupId)
  if (destinationIndex < 0 || destinationIndex >= state.workspaceGroups.length) {
    throw new WorkspaceMutationError('index_out_of_bounds', 'Group destination index is invalid')
  }
  if (destinationIndex === sourceIndex) return state
  const next = structuredClone(state)
  const [group] = next.workspaceGroups.splice(sourceIndex, 1)
  next.workspaceGroups.splice(destinationIndex, 0, group!)
  next.workspaceGroups.forEach((item, order) => {
    item.order = order
  })
  return commit(next)
}

export function assignGroup(
  state: DurableApplicationState,
  workspaceId: string,
  groupId?: string
): DurableApplicationState {
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  }
  if (groupId !== undefined) groupIndex(state, groupId)
  if (state.workspaceGroupAssignments[workspaceId] === groupId) return state
  if (
    groupId !== undefined &&
    state.workspaceGroupAssignments[workspaceId] === undefined &&
    Object.keys(state.workspaceGroupAssignments).length >= 128
  ) {
    throw new WorkspaceMutationError('group_limit_reached', 'Group assignment limit reached')
  }
  const next = structuredClone(state)
  if (groupId === undefined) delete next.workspaceGroupAssignments[workspaceId]
  else next.workspaceGroupAssignments[workspaceId] = groupId
  return commit(next)
}

export function collapseGroup(
  state: DurableApplicationState,
  groupId: string,
  collapsed: boolean
): DurableApplicationState {
  const index = groupIndex(state, groupId)
  if (state.workspaceGroups[index]!.collapsed === collapsed) return state
  const next = structuredClone(state)
  next.workspaceGroups[index]!.collapsed = collapsed
  return commit(next)
}
