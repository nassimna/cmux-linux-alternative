export interface WorkspaceGroupProjection {
  id: string
  name: string
  collapsed: boolean
  order: number
}

export interface WorkspaceGroupAssignmentProjection {
  workspaceId: string
  groupId: string
}

export interface WorkspaceOrganizationProjection {
  revision: number
  selection: readonly string[]
  focusedWorkspaceId: string
  pins: readonly string[]
  groups: readonly WorkspaceGroupProjection[]
  assignments: readonly WorkspaceGroupAssignmentProjection[]
}

export interface WorkspacePresentationSection {
  id: string
  kind: 'pinned' | 'group' | 'ungrouped'
  name: string | null
  collapsed: boolean
  workspaceIds: readonly string[]
}

/**
 * Builds the sidebar presentation without changing the durable canonical order.
 * A pinned workspace retains its assignment, but is emitted only in the pinned section.
 */
export function workspacePresentationSections(
  canonicalWorkspaceIds: readonly string[],
  organization: WorkspaceOrganizationProjection
): readonly WorkspacePresentationSection[] {
  const existing = new Set(canonicalWorkspaceIds)
  const emitted = new Set<string>()
  const pinned = new Set(organization.pins.filter((workspaceId) => existing.has(workspaceId)))
  const pins = canonicalWorkspaceIds.filter((workspaceId) => {
    if (!pinned.has(workspaceId) || emitted.has(workspaceId)) return false
    emitted.add(workspaceId)
    return true
  })
  const assignmentByWorkspace = new Map(
    organization.assignments.map(({ workspaceId, groupId }) => [workspaceId, groupId] as const)
  )
  const groups = [...organization.groups].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id)
  )
  const result: WorkspacePresentationSection[] = []

  if (pins.length > 0) {
    result.push({ id: 'pinned', kind: 'pinned', name: null, collapsed: false, workspaceIds: pins })
  }

  for (const group of groups) {
    const workspaceIds = canonicalWorkspaceIds.filter((workspaceId) => {
      if (emitted.has(workspaceId) || assignmentByWorkspace.get(workspaceId) !== group.id) {
        return false
      }
      emitted.add(workspaceId)
      return true
    })
    result.push({
      id: group.id,
      kind: 'group',
      name: group.name,
      collapsed: group.collapsed,
      workspaceIds: group.collapsed ? [] : workspaceIds
    })
  }

  const ungrouped = canonicalWorkspaceIds.filter((workspaceId) => {
    if (emitted.has(workspaceId) || assignmentByWorkspace.has(workspaceId)) return false
    emitted.add(workspaceId)
    return true
  })
  if (ungrouped.length > 0) {
    result.push({
      id: 'ungrouped',
      kind: 'ungrouped',
      name: null,
      collapsed: false,
      workspaceIds: ungrouped
    })
  }
  return result
}

export interface SelectionModifiers {
  additive: boolean
  range: boolean
}

export interface WorkspaceSelectionReplacement {
  selection: string[]
  focusedWorkspaceId: string
}

export function workspaceCardSelectionState(
  workspaceId: string,
  organization: Pick<WorkspaceOrganizationProjection, 'selection' | 'focusedWorkspaceId'>
): { selected: boolean; focused: boolean } {
  return {
    selected: organization.selection.includes(workspaceId),
    focused: organization.focusedWorkspaceId === workspaceId
  }
}

/**
 * Produces the blank terminal replacement required when a batch close covers every workspace.
 * IDs remain service-owned and no command, environment, runtime identity, output, or browser state
 * is copied from the closing workspaces.
 */
export function workspaceBatchCloseReplacement(
  workspaces: readonly WorkspaceSnapshot[],
  organization: Pick<WorkspaceOrganizationProjection, 'selection' | 'focusedWorkspaceId'>
): WorkspaceCreateParams | undefined {
  if (workspaces.length === 0) return undefined
  const selection = new Set(organization.selection)
  if (selection.size !== workspaces.length || !workspaces.every(({ id }) => selection.has(id))) {
    return undefined
  }

  const source =
    workspaces.find(({ id }) => id === organization.focusedWorkspaceId) ?? workspaces[0]
  if (!source) return undefined
  const terminal = source.tabs.find(({ content }) => content.kind === 'terminal')
  const dimensions =
    terminal?.content.kind === 'terminal'
      ? terminal.content.launch
      : { rows: LEGACY_REPLACEMENT_ROWS, cols: LEGACY_REPLACEMENT_COLS }

  return {
    name: 'Workspace 1',
    workingDirectory: source.workingDirectory,
    initialTerminal: {
      cwd: source.workingDirectory,
      rows: dimensions.rows,
      cols: dimensions.cols
    }
  }
}

/** Returns the complete authoritative replacement payload in canonical order. */
export function workspaceSelectionReplacement(
  canonicalWorkspaceIds: readonly string[],
  organization: Pick<WorkspaceOrganizationProjection, 'selection' | 'focusedWorkspaceId'>,
  targetWorkspaceId: string,
  modifiers: SelectionModifiers
): WorkspaceSelectionReplacement | null {
  if (!canonicalWorkspaceIds.includes(targetWorkspaceId)) return null
  const selected = new Set(
    organization.selection.filter((workspaceId) => canonicalWorkspaceIds.includes(workspaceId))
  )

  if (modifiers.range) {
    const anchorIndex = canonicalWorkspaceIds.indexOf(organization.focusedWorkspaceId)
    const targetIndex = canonicalWorkspaceIds.indexOf(targetWorkspaceId)
    const start = anchorIndex < 0 ? targetIndex : Math.min(anchorIndex, targetIndex)
    const end = anchorIndex < 0 ? targetIndex : Math.max(anchorIndex, targetIndex)
    if (!modifiers.additive) selected.clear()
    for (const workspaceId of canonicalWorkspaceIds.slice(start, end + 1)) {
      selected.add(workspaceId)
    }
  } else if (modifiers.additive) {
    if (selected.has(targetWorkspaceId) && selected.size > 1) selected.delete(targetWorkspaceId)
    else selected.add(targetWorkspaceId)
  } else {
    selected.clear()
    selected.add(targetWorkspaceId)
  }

  const selection = canonicalWorkspaceIds.filter((workspaceId) => selected.has(workspaceId))
  const focusedWorkspaceId = selected.has(targetWorkspaceId)
    ? targetWorkspaceId
    : selected.has(organization.focusedWorkspaceId)
      ? organization.focusedWorkspaceId
      : nearestSelectedWorkspace(canonicalWorkspaceIds, selected, targetWorkspaceId)
  if (!focusedWorkspaceId) return null
  return { selection, focusedWorkspaceId }
}

function nearestSelectedWorkspace(
  canonicalWorkspaceIds: readonly string[],
  selected: ReadonlySet<string>,
  targetWorkspaceId: string
): string | undefined {
  const targetIndex = canonicalWorkspaceIds.indexOf(targetWorkspaceId)
  return (
    canonicalWorkspaceIds.slice(targetIndex + 1).find((workspaceId) => selected.has(workspaceId)) ??
    canonicalWorkspaceIds
      .slice(0, targetIndex)
      .reverse()
      .find((workspaceId) => selected.has(workspaceId))
  )
}
import type { WorkspaceCreateParams, WorkspaceSnapshot } from '@agent-workspace/protocol-client'

const LEGACY_REPLACEMENT_ROWS = 24
const LEGACY_REPLACEMENT_COLS = 80
