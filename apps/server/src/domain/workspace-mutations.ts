import { isAbsolute, relative } from 'node:path'

import {
  durableApplicationStateSchema,
  workspaceCreateParamsSchema,
  tabMoveParamsSchema,
  tabOpenTerminalParamsSchema,
  tabOpenBrowserParamsSchema,
  paneSplitParamsSchema,
  tabUpdateParamsSchema,
  type DurableApplicationState,
  type WorkspaceUpdateRequest
} from '@agent-workspace/contracts'
import type { z } from 'zod'

type FocusTarget = DurableApplicationState['focusHistory']['entries'][number]

export class WorkspaceMutationError extends Error {
  public constructor(
    public readonly code:
      | 'workspace_not_found'
      | 'tab_not_found'
      | 'tab_not_terminal'
      | 'tab_already_selected'
      | 'tab_already_at_destination_index'
      | 'tab_unchanged'
      | 'pane_not_found'
      | 'pane_already_focused'
      | 'split_not_found'
      | 'split_ratio_unchanged'
      | 'split_would_empty_target'
      | 'group_not_found'
      | 'group_limit_reached'
      | 'layout_not_found'
      | 'layout_limit_reached'
      | 'unauthorized_layout_path'
      | 'policy_denied'
      | 'runtime_not_bound'
      | 'workspace_already_selected'
      | 'workspace_unchanged'
      | 'index_out_of_bounds'
      | 'window_not_found'
      | 'window_closing'
      | 'workspace_limit_reached'
      | 'duplicate_identity'
      | 'replacement_required'
      | 'unexpected_replacement'
      | 'legacy_limit_reduction_required'
      | 'invalid_timestamp'
      | 'revision_overflow',
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceMutationError'
  }
}

export interface NewWorkspaceIds {
  workspaceId: string
  paneId: string
  tabId: string
}

export interface NewPaneSplitIds {
  paneId: string
  splitId: string
  tabId: string
  browserSessionId: string
}

type Workspace = DurableApplicationState['workspaces'][number]

function workspaceCounts(workspaces: Workspace[]) {
  return workspaces.reduce(
    (counts, workspace) => {
      const panes = Object.keys(workspace.panes).length
      const tabs = Object.keys(workspace.tabs).length
      counts.workspaceCount += 1
      counts.maximumPanesInWorkspace = Math.max(counts.maximumPanesInWorkspace, panes)
      counts.maximumTabsInWorkspace = Math.max(counts.maximumTabsInWorkspace, tabs)
      counts.totalPaneCount += panes
      counts.totalTabCount += tabs
      return counts
    },
    {
      workspaceCount: 0,
      maximumPanesInWorkspace: 0,
      maximumTabsInWorkspace: 0,
      totalPaneCount: 0,
      totalTabCount: 0
    }
  )
}

function reconcileLegacyLimit(
  before: DurableApplicationState,
  after: DurableApplicationState
): void {
  if (!before.legacyOverLimit) return
  const counts = workspaceCounts(after.workspaces)
  const limits = {
    workspaceCount: 128,
    maximumPanesInWorkspace: 64,
    maximumTabsInWorkspace: 128,
    totalPaneCount: 1_024,
    totalTabCount: 2_048
  }
  let exceeds = false
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    if (counts[key] > limits[key]) {
      exceeds = true
      if (before.legacyOverLimit[key] <= limits[key] || counts[key] > before.legacyOverLimit[key]) {
        throw new WorkspaceMutationError(
          'legacy_limit_reduction_required',
          'Legacy workspace resources must not increase'
        )
      }
    }
  }
  after.legacyOverLimit = exceeds ? counts : null
}

function requireNewTabCapacity(state: DurableApplicationState, workspace: Workspace): void {
  if (
    Object.keys(workspace.tabs).length >= 128 ||
    workspaceCounts(state.workspaces).totalTabCount >= 2_048
  ) {
    throw new WorkspaceMutationError('workspace_limit_reached', 'Workspace tab limit reached')
  }
}

function replacementWorkspace(
  closing: Workspace,
  ids: NewWorkspaceIds,
  createdAt: number
): Workspace {
  const terminal = Object.values(closing.tabs)
    .sort((a, b) => a.id.localeCompare(b.id))
    .find((tab) => tab.content.kind === 'terminal')
  const launch = terminal?.content.kind === 'terminal' ? terminal.content.launch : undefined
  return {
    id: ids.workspaceId,
    name: 'Workspace 1',
    description: null,
    color: null,
    workingDirectory: closing.workingDirectory,
    layout: { kind: 'leaf', paneId: ids.paneId },
    selectedPaneId: ids.paneId,
    panes: {
      [ids.paneId]: { id: ids.paneId, tabs: [ids.tabId], selectedTabId: ids.tabId, title: null }
    },
    tabs: {
      [ids.tabId]: {
        id: ids.tabId,
        paneId: ids.paneId,
        title: 'Terminal',
        customTitle: null,
        content: {
          kind: 'terminal',
          launch: {
            cwd: closing.workingDirectory,
            rows: launch?.rows ?? 24,
            cols: launch?.cols ?? 80
          }
        },
        createdAt
      }
    },
    createdAt,
    updatedAt: createdAt
  }
}

function workspaceFromParams(
  request: z.output<typeof workspaceCreateParamsSchema>,
  ids: NewWorkspaceIds,
  createdAt: number
): Workspace {
  return {
    id: ids.workspaceId,
    name: request.name,
    description: request.description ?? null,
    color: request.color ?? null,
    workingDirectory: request.workingDirectory,
    layout: { kind: 'leaf', paneId: ids.paneId },
    selectedPaneId: ids.paneId,
    panes: {
      [ids.paneId]: { id: ids.paneId, tabs: [ids.tabId], selectedTabId: ids.tabId, title: null }
    },
    tabs: {
      [ids.tabId]: {
        id: ids.tabId,
        paneId: ids.paneId,
        title: 'Terminal',
        customTitle: null,
        content: {
          kind: 'terminal',
          launch: {
            cwd: request.initialTerminal.cwd,
            rows: request.initialTerminal.rows,
            cols: request.initialTerminal.cols
          }
        },
        createdAt
      }
    },
    createdAt,
    updatedAt: createdAt
  }
}

function validFocus(state: DurableApplicationState, target: FocusTarget): boolean {
  const placement = state.windowPlacements.find((item) => item.id === target.windowId)
  const workspace = state.workspaces.find((item) => item.id === target.workspaceId)
  return Boolean(
    placement?.workspaceIds.includes(target.workspaceId) &&
    workspace?.panes[target.paneId]?.tabs.includes(target.tabId) &&
    workspace.tabs[target.tabId]?.paneId === target.paneId
  )
}

function changedPlacement(
  before: DurableApplicationState['windowPlacements'][number],
  after: DurableApplicationState['windowPlacements'][number]
): boolean {
  return (
    before.label !== after.label ||
    before.hostingState !== after.hostingState ||
    before.focusedWorkspaceId !== after.focusedWorkspaceId ||
    before.workspaceIds.length !== after.workspaceIds.length ||
    before.workspaceIds.some((id, index) => id !== after.workspaceIds[index])
  )
}

/** Closes one workspace and repairs the placement, focus, and selection graph. */
export function closeWorkspace(
  state: DurableApplicationState,
  workspaceId: string,
  replacementIds?: NewWorkspaceIds,
  createdAt?: number
): DurableApplicationState {
  const index = state.workspaces.findIndex((item) => item.id === workspaceId)
  if (index < 0) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  const finalWorkspace = state.workspaces.length === 1
  if (finalWorkspace && !replacementIds) {
    throw new WorkspaceMutationError('replacement_required', 'Final workspace needs a replacement')
  }
  if (!finalWorkspace && replacementIds) {
    throw new WorkspaceMutationError('unexpected_replacement', 'Replacement is not needed')
  }
  if (finalWorkspace && (!Number.isSafeInteger(createdAt) || createdAt! < 0)) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Workspace timestamp is invalid')
  }

  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  if (finalWorkspace) {
    if (replacementIds!.workspaceId === workspaceId) {
      throw new WorkspaceMutationError('duplicate_identity', 'Replacement workspace ID is in use')
    }
    const replacement = replacementWorkspace(state.workspaces[0]!, replacementIds!, createdAt!)
    for (const placement of next.windowPlacements) {
      placement.workspaceIds = placement.workspaceIds.map((id) =>
        id === workspaceId ? replacement.id : id
      )
      if (placement.focusedWorkspaceId === workspaceId) {
        placement.focusedWorkspaceId = replacement.id
      }
    }
    next.workspaces[0] = replacement
    next.selectedWorkspaceId = replacement.id
    next.workspaceSelection = [replacement.id]
  } else {
    next.workspaces.splice(index, 1)
    next.workspaceSelection = next.workspaceSelection.filter((id) => id !== workspaceId)
    if (next.selectedWorkspaceId === workspaceId) {
      next.selectedWorkspaceId = next.workspaces[Math.min(index, next.workspaces.length - 1)]!.id
    }
    if (!next.workspaceSelection.includes(next.selectedWorkspaceId)) {
      next.workspaceSelection.push(next.selectedWorkspaceId)
    }
    for (const placement of next.windowPlacements) {
      placement.workspaceIds = placement.workspaceIds.filter((id) => id !== workspaceId)
      if (
        placement.workspaceIds.length > 0 &&
        !placement.workspaceIds.includes(placement.focusedWorkspaceId)
      ) {
        placement.focusedWorkspaceId = placement.workspaceIds[0]!
      }
    }
    next.windowPlacements = next.windowPlacements.filter((item) => item.workspaceIds.length > 0)
  }
  next.workspacePins = next.workspacePins.filter((id) => id !== workspaceId)
  delete next.workspaceGroupAssignments[workspaceId]
  reconcileLegacyLimit(state, next)

  const selectedPlacement = next.windowPlacements.find((item) =>
    item.workspaceIds.includes(next.selectedWorkspaceId)
  )!
  next.focusedWindowId = selectedPlacement.id
  selectedPlacement.focusedWorkspaceId = next.selectedWorkspaceId

  const oldHistory = next.focusHistory
  const retainedThroughCursor = oldHistory.entries
    .slice(0, oldHistory.cursor + 1)
    .filter((entry) => validFocus(next, entry)).length
  oldHistory.entries = oldHistory.entries.filter((entry) => validFocus(next, entry))
  oldHistory.cursor = Math.min(
    Math.max(0, retainedThroughCursor - 1),
    Math.max(0, oldHistory.entries.length - 1)
  )
  const newFocus = focusTarget(next, next.selectedWorkspaceId)
  if (!sameTarget(previousFocus, newFocus)) {
    if (oldHistory.entries.length === 0 && validFocus(next, previousFocus)) {
      oldHistory.entries.push(previousFocus)
    }
    if (oldHistory.entries.length === 0 || !sameTarget(oldHistory.entries.at(-1)!, newFocus)) {
      oldHistory.entries = oldHistory.entries.slice(0, oldHistory.cursor + 1)
      oldHistory.entries.push(newFocus)
    }
    if (oldHistory.entries.length > 128) oldHistory.entries.shift()
    oldHistory.cursor = oldHistory.entries.length - 1
  }

  for (const placement of next.windowPlacements) {
    const previous = state.windowPlacements.find((item) => item.id === placement.id)
    if (previous && changedPlacement(previous, placement)) {
      if (previous.revision >= Number.MAX_SAFE_INTEGER) {
        throw new WorkspaceMutationError('revision_overflow', 'Window revision cannot advance')
      }
      placement.revision = previous.revision + 1
    }
  }
  return commitChangedState(next)
}

export interface WorkspaceBatchReplacement {
  params: z.input<typeof workspaceCreateParamsSchema>
  ids: NewWorkspaceIds
  createdAt: number
}

/** Closes the current selection atomically, with a caller-supplied final replacement. */
export function closeSelectedWorkspaces(
  state: DurableApplicationState,
  replacement?: WorkspaceBatchReplacement
): DurableApplicationState {
  const closing = new Set(state.workspaceSelection)
  if (closing.size === 0 || !closing.has(state.selectedWorkspaceId)) {
    throw new WorkspaceMutationError('policy_denied', 'Workspace selection is invalid')
  }
  const final = closing.size === state.workspaces.length
  if (final && !replacement) {
    throw new WorkspaceMutationError('replacement_required', 'Final selection needs a workspace')
  }
  if (!final && replacement) {
    throw new WorkspaceMutationError('unexpected_replacement', 'Replacement is not needed')
  }
  if (replacement) {
    if (!Number.isSafeInteger(replacement.createdAt) || replacement.createdAt < 0) {
      throw new WorkspaceMutationError('invalid_timestamp', 'Replacement timestamp is invalid')
    }
    if (
      state.workspaces.some(
        (workspace) =>
          workspace.id === replacement.ids.workspaceId ||
          workspace.panes[replacement.ids.paneId] !== undefined ||
          workspace.tabs[replacement.ids.tabId] !== undefined
      )
    ) {
      throw new WorkspaceMutationError('duplicate_identity', 'Replacement identity is in use')
    }
  }

  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  if (final) {
    const created = workspaceFromParams(
      workspaceCreateParamsSchema.parse(replacement!.params),
      replacement!.ids,
      replacement!.createdAt
    )
    for (const placement of next.windowPlacements) {
      placement.workspaceIds = placement.workspaceIds.map((id) =>
        id === state.selectedWorkspaceId ? created.id : id
      )
      if (placement.focusedWorkspaceId === state.selectedWorkspaceId) {
        placement.focusedWorkspaceId = created.id
      }
    }
    next.workspaces = [created]
    next.selectedWorkspaceId = created.id
    next.workspaceSelection = [created.id]
    next.workspacePins = []
    next.workspaceGroupAssignments = {}
  } else {
    const focusedIndex = state.workspaces.findIndex(
      (workspace) => workspace.id === state.selectedWorkspaceId
    )
    const successor =
      state.workspaces.slice(focusedIndex + 1).find((workspace) => !closing.has(workspace.id)) ??
      state.workspaces
        .slice(0, focusedIndex)
        .reverse()
        .find((workspace) => !closing.has(workspace.id))
    if (!successor) throw new WorkspaceMutationError('policy_denied', 'No successor workspace')
    next.workspaces = next.workspaces.filter((workspace) => !closing.has(workspace.id))
    next.selectedWorkspaceId = successor.id
    next.workspaceSelection = [successor.id]
    next.workspacePins = next.workspacePins.filter((id) => !closing.has(id))
    next.workspaceGroupAssignments = Object.fromEntries(
      Object.entries(next.workspaceGroupAssignments).filter(([id]) => !closing.has(id))
    )
  }

  const remaining = new Set(next.workspaces.map((workspace) => workspace.id))
  for (const placement of next.windowPlacements) {
    placement.workspaceIds = placement.workspaceIds.filter((id) => remaining.has(id))
    if (
      placement.workspaceIds.length > 0 &&
      !placement.workspaceIds.includes(placement.focusedWorkspaceId)
    ) {
      placement.focusedWorkspaceId = placement.workspaceIds[0]!
    }
  }
  next.windowPlacements = next.windowPlacements.filter(
    (placement) => placement.workspaceIds.length > 0
  )
  const selectedPlacement = next.windowPlacements.find((placement) =>
    placement.workspaceIds.includes(next.selectedWorkspaceId)
  )
  if (!selectedPlacement)
    throw new WorkspaceMutationError('window_not_found', 'Selected workspace has no window')
  next.focusedWindowId = selectedPlacement.id
  selectedPlacement.focusedWorkspaceId = next.selectedWorkspaceId
  reconcileTabFocus(next, previousFocus)
  reconcileLegacyLimit(state, next)
  for (const placement of next.windowPlacements) {
    const previous = state.windowPlacements.find((item) => item.id === placement.id)
    if (previous && changedPlacement(previous, placement)) {
      if (placement.revision >= Number.MAX_SAFE_INTEGER) {
        throw new WorkspaceMutationError('revision_overflow', 'Window revision cannot advance')
      }
      placement.revision += 1
    }
  }
  return commitChangedState(next)
}

/** Builds Rust's persistent workspace graph. Process launch belongs to the caller. */
export function createWorkspace(
  state: DurableApplicationState,
  input: z.input<typeof workspaceCreateParamsSchema>,
  ids: NewWorkspaceIds,
  createdAt: number,
  windowId?: string
): DurableApplicationState {
  const request = workspaceCreateParamsSchema.parse(input)
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Workspace timestamp is invalid')
  }
  if (
    state.workspaces.some((item) => item.id === ids.workspaceId) ||
    state.workspaces.some((item) => ids.paneId in item.panes || ids.tabId in item.tabs)
  ) {
    throw new WorkspaceMutationError('duplicate_identity', 'Workspace identity already exists')
  }
  const targetId = windowId ?? state.focusedWindowId
  const target = state.windowPlacements.find((item) => item.id === targetId)
  if (!target) throw new WorkspaceMutationError('window_not_found', 'Window does not exist')
  if (windowId && target.hostingState === 'closing') {
    throw new WorkspaceMutationError('window_closing', 'Window is closing')
  }
  if (
    state.legacyOverLimit === null &&
    (state.workspaces.length >= 128 ||
      state.workspaces.reduce((sum, item) => sum + Object.keys(item.panes).length, 0) >= 1_024 ||
      state.workspaces.reduce((sum, item) => sum + Object.keys(item.tabs).length, 0) >= 2_048)
  ) {
    throw new WorkspaceMutationError('workspace_limit_reached', 'Workspace resource limit reached')
  }
  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  next.workspaces.push(workspaceFromParams(request, ids, createdAt))
  next.selectedWorkspaceId = ids.workspaceId
  next.workspaceSelection = [ids.workspaceId]
  next.focusedWindowId = targetId
  const placement = next.windowPlacements.find((item) => item.id === targetId)!
  placement.workspaceIds.push(ids.workspaceId)
  placement.focusedWorkspaceId = ids.workspaceId
  if (placement.revision >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceMutationError('revision_overflow', 'Window revision cannot advance')
  }
  placement.revision += 1
  const nextFocus = {
    windowId: targetId,
    workspaceId: ids.workspaceId,
    paneId: ids.paneId,
    tabId: ids.tabId
  }
  if (next.focusHistory.entries.length === 0) next.focusHistory.entries.push(previousFocus)
  next.focusHistory.entries = next.focusHistory.entries.slice(0, next.focusHistory.cursor + 1)
  next.focusHistory.entries.push(nextFocus)
  if (next.focusHistory.entries.length > 128) next.focusHistory.entries.shift()
  next.focusHistory.cursor = next.focusHistory.entries.length - 1
  reconcileLegacyLimit(state, next)
  return commitChangedState(next)
}

function focusTarget(state: DurableApplicationState, workspaceId: string): FocusTarget {
  const workspace = state.workspaces.find((item) => item.id === workspaceId)
  const placement = state.windowPlacements.find((item) => item.workspaceIds.includes(workspaceId))
  if (!workspace || !placement) {
    throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  }
  const pane = workspace.panes[workspace.selectedPaneId]!
  return {
    windowId: placement.id,
    workspaceId,
    paneId: pane.id,
    tabId: pane.selectedTabId
  }
}

function sameTarget(first: FocusTarget, second: FocusTarget): boolean {
  return (
    first.windowId === second.windowId &&
    first.workspaceId === second.workspaceId &&
    first.paneId === second.paneId &&
    first.tabId === second.tabId
  )
}

function commitChangedState(next: DurableApplicationState): DurableApplicationState {
  if (next.revision >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceMutationError('revision_overflow', 'Application revision cannot advance')
  }
  next.revision += 1
  if (!durableApplicationStateSchema.safeParse(next).success) {
    throw new Error('Workspace mutation produced an invalid state')
  }
  return next
}

type PaneLayout =
  | { kind: 'leaf'; paneId: string }
  | {
      kind: 'split'
      splitId: string
      axis: 'horizontal' | 'vertical'
      ratio: number
      first: PaneLayout
      second: PaneLayout
    }

function collapsePane(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.kind === 'leaf') {
    throw new WorkspaceMutationError('pane_not_found', 'Pane is not in the layout')
  }
  if (layout.first.kind === 'leaf' && layout.first.paneId === paneId) return layout.second
  if (layout.second.kind === 'leaf' && layout.second.paneId === paneId) return layout.first
  if (layout.first.kind === 'split') {
    try {
      return { ...layout, first: collapsePane(layout.first, paneId) }
    } catch (error) {
      if (!(error instanceof WorkspaceMutationError) || error.code !== 'pane_not_found') throw error
    }
  }
  return { ...layout, second: collapsePane(layout.second, paneId) }
}

function firstLeaf(layout: PaneLayout): string {
  return layout.kind === 'leaf' ? layout.paneId : firstLeaf(layout.first)
}

function findSplit(
  layout: PaneLayout,
  splitId: string
): Extract<PaneLayout, { kind: 'split' }> | null {
  if (layout.kind === 'leaf') return null
  if (layout.splitId === splitId) return layout
  return findSplit(layout.first, splitId) ?? findSplit(layout.second, splitId)
}

function splitLeaf(
  layout: PaneLayout,
  targetPaneId: string,
  newPaneId: string,
  splitId: string,
  axis: 'horizontal' | 'vertical',
  ratio: number,
  placement: 'before' | 'after'
): PaneLayout | null {
  if (layout.kind === 'leaf') {
    if (layout.paneId !== targetPaneId) return null
    const newPane: PaneLayout = { kind: 'leaf', paneId: newPaneId }
    return {
      kind: 'split',
      splitId,
      axis,
      ratio,
      first: placement === 'before' ? newPane : layout,
      second: placement === 'before' ? layout : newPane
    }
  }
  const first = splitLeaf(layout.first, targetPaneId, newPaneId, splitId, axis, ratio, placement)
  if (first) return { ...layout, first }
  const second = splitLeaf(layout.second, targetPaneId, newPaneId, splitId, axis, ratio, placement)
  return second ? { ...layout, second } : null
}

function reconcileTabFocus(next: DurableApplicationState, previousFocus: FocusTarget): void {
  const history = next.focusHistory
  const retainedThroughCursor = history.entries
    .slice(0, history.cursor + 1)
    .filter((entry) => validFocus(next, entry)).length
  history.entries = history.entries.filter((entry) => validFocus(next, entry))
  history.cursor = Math.min(
    Math.max(0, retainedThroughCursor - 1),
    Math.max(0, history.entries.length - 1)
  )
  const nextFocus = focusTarget(next, next.selectedWorkspaceId)
  if (sameTarget(previousFocus, nextFocus)) return
  if (history.entries.length === 0 && validFocus(next, previousFocus)) {
    history.entries.push(previousFocus)
  }
  if (history.entries.length === 0 || !sameTarget(history.entries.at(-1)!, nextFocus)) {
    history.entries = history.entries.slice(0, history.cursor + 1)
    history.entries.push(nextFocus)
  }
  if (history.entries.length > 128) history.entries.shift()
  history.cursor = history.entries.length - 1
}

/** Mirrors Rust's insertion-index normalization and empty-pane collapse. */
export function moveTab(
  state: DurableApplicationState,
  input: z.input<typeof tabMoveParamsSchema>,
  updatedAt: number
): DurableApplicationState {
  const request = tabMoveParamsSchema.parse(input)
  const original = state.workspaces.find((item) => item.id === request.workspaceId)
  if (!original) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  if (!original.panes[request.destinationPaneId]) {
    throw new WorkspaceMutationError('pane_not_found', 'Destination pane does not exist')
  }
  const originalTab = original.tabs[request.tabId]
  if (!originalTab) throw new WorkspaceMutationError('tab_not_found', 'Tab does not exist')
  const destinationLength = original.panes[request.destinationPaneId]!.tabs.length
  if (request.destinationIndex > destinationLength) {
    throw new WorkspaceMutationError('index_out_of_bounds', 'Tab destination index is invalid')
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Workspace timestamp is invalid')
  }

  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === request.workspaceId)!
  const source = workspace.panes[originalTab.paneId]!
  const destination = workspace.panes[request.destinationPaneId]!
  const sourceIndex = source.tabs.indexOf(request.tabId)
  if (sourceIndex < 0) throw new WorkspaceMutationError('tab_not_found', 'Tab is not in its pane')
  if (source.id === destination.id) {
    const normalized =
      sourceIndex < request.destinationIndex
        ? request.destinationIndex - 1
        : request.destinationIndex
    if (normalized === sourceIndex) {
      throw new WorkspaceMutationError(
        'tab_already_at_destination_index',
        'Tab is already at the destination index'
      )
    }
    source.tabs.splice(sourceIndex, 1)
    source.tabs.splice(normalized, 0, request.tabId)
    source.selectedTabId = request.tabId
  } else {
    source.tabs.splice(sourceIndex, 1)
    if (source.tabs.length === 0) {
      delete workspace.panes[source.id]
      workspace.layout = collapsePane(workspace.layout as PaneLayout, source.id)
    } else if (source.selectedTabId === request.tabId) {
      source.selectedTabId = source.tabs[Math.min(sourceIndex, source.tabs.length - 1)]!
    }
    workspace.tabs[request.tabId]!.paneId = destination.id
    destination.tabs.splice(request.destinationIndex, 0, request.tabId)
    destination.selectedTabId = request.tabId
  }
  workspace.selectedPaneId = destination.id
  workspace.updatedAt = updatedAt
  reconcileTabFocus(next, previousFocus)
  reconcileLegacyLimit(state, next)
  return commitChangedState(next)
}

/** Produces the redacted restore record and closes a tab in one durable revision. */
export function closeTab(
  state: DurableApplicationState,
  workspaceId: string,
  tabId: string,
  closedItemId: string,
  replacementTabId: string | null,
  now: number
): DurableApplicationState {
  const original = state.workspaces.find((item) => item.id === workspaceId)
  if (!original) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  const originalTab = original.tabs[tabId]
  if (!originalTab) throw new WorkspaceMutationError('tab_not_found', 'Tab does not exist')
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Tab close timestamp is invalid')
  }
  if (state.recentlyClosed.some((item) => item.id === closedItemId)) {
    throw new WorkspaceMutationError('duplicate_identity', 'Closed item ID is in use')
  }
  const finalTab = Object.keys(original.tabs).length === 1
  if (finalTab && !replacementTabId) {
    throw new WorkspaceMutationError('replacement_required', 'Final tab needs a replacement')
  }
  if (!finalTab && replacementTabId) {
    throw new WorkspaceMutationError('unexpected_replacement', 'Replacement tab is not needed')
  }
  if (replacementTabId && state.workspaces.some((workspace) => workspace.tabs[replacementTabId])) {
    throw new WorkspaceMutationError('duplicate_identity', 'Replacement tab ID is in use')
  }

  let restore: DurableApplicationState['recentlyClosed'][number]['restore']
  if (originalTab.content.kind === 'terminal') {
    const cwd = relative(original.workingDirectory, originalTab.content.launch.cwd)
    if (
      isAbsolute(cwd) ||
      cwd.split('/').some((part) => part === '.' || part === '..') ||
      originalTab.content.launch.cwd.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw new WorkspaceMutationError(
        'policy_denied',
        'Terminal restore path is outside the workspace'
      )
    }
    restore = {
      kind: 'terminal',
      authorized_root_id: workspaceId,
      root_relative_cwd: cwd,
      rows: originalTab.content.launch.rows,
      cols: originalTab.content.launch.cols
    }
  } else {
    const url = new URL(originalTab.content.metadata.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new WorkspaceMutationError('policy_denied', 'Browser restore URL is unsafe')
    }
    url.search = ''
    url.hash = ''
    restore = { kind: 'browser', url: url.href }
  }
  const title = originalTab.customTitle ?? originalTab.title
  if (Array.from(title).length > 160 || Buffer.byteLength(JSON.stringify(restore)) > 8 * 1024) {
    throw new WorkspaceMutationError('policy_denied', 'Tab restore metadata is unsafe')
  }
  const record: DurableApplicationState['recentlyClosed'][number] = {
    id: closedItemId,
    itemKind: 'tab',
    priorWorkspaceId: workspaceId,
    priorTabId: tabId,
    contentKind: originalTab.content.kind,
    title,
    closedAt: now,
    restore
  }

  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === workspaceId)!
  const pane = workspace.panes[originalTab.paneId]!
  if (finalTab) {
    const dimensions = Object.values(original.tabs)
      .sort((a, b) => a.id.localeCompare(b.id))
      .find((item) => item.content.kind === 'terminal')
    const launch = dimensions?.content.kind === 'terminal' ? dimensions.content.launch : undefined
    workspace.tabs[replacementTabId!] = {
      id: replacementTabId!,
      paneId: pane.id,
      title: 'Terminal',
      customTitle: null,
      content: {
        kind: 'terminal',
        launch: {
          cwd: workspace.workingDirectory,
          rows: launch?.rows ?? 24,
          cols: launch?.cols ?? 80
        }
      },
      createdAt: now
    }
    pane.tabs = [replacementTabId!]
    pane.selectedTabId = replacementTabId!
  } else {
    const index = pane.tabs.indexOf(tabId)
    pane.tabs.splice(index, 1)
    if (pane.tabs.length === 0) {
      delete workspace.panes[pane.id]
      workspace.layout = collapsePane(workspace.layout as PaneLayout, pane.id)
      if (workspace.selectedPaneId === pane.id) {
        workspace.selectedPaneId = firstLeaf(workspace.layout as PaneLayout)
      }
    } else if (pane.selectedTabId === tabId) {
      pane.selectedTabId = pane.tabs[Math.min(index, pane.tabs.length - 1)]!
    }
  }
  delete workspace.tabs[tabId]
  workspace.updatedAt = now
  next.recentlyClosed.push(record)
  next.recentlyClosed = next.recentlyClosed
    .filter((item) => Math.max(0, now - item.closedAt) <= 30 * 24 * 60 * 60 * 1_000)
    .sort((a, b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id))
    .slice(-100)
  reconcileTabFocus(next, previousFocus)
  reconcileLegacyLimit(state, next)
  return commitChangedState(next)
}

/** Inserts and selects a terminal tab; the launch command remains runtime-only. */
export function openTerminalTab(
  state: DurableApplicationState,
  input: z.input<typeof tabOpenTerminalParamsSchema>,
  tabId: string,
  createdAt: number
): DurableApplicationState {
  const request = tabOpenTerminalParamsSchema.parse(input)
  const original = state.workspaces.find((item) => item.id === request.workspaceId)
  if (!original) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  const originalPane = original.panes[request.paneId]
  if (!originalPane) throw new WorkspaceMutationError('pane_not_found', 'Pane does not exist')
  requireNewTabCapacity(state, original)
  if (state.workspaces.some((item) => item.tabs[tabId])) {
    throw new WorkspaceMutationError('duplicate_identity', 'Terminal tab ID is in use')
  }
  const index = request.destinationIndex ?? originalPane.tabs.length
  if (index > originalPane.tabs.length) {
    throw new WorkspaceMutationError('index_out_of_bounds', 'Tab destination index is invalid')
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Tab creation timestamp is invalid')
  }
  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === request.workspaceId)!
  const pane = workspace.panes[request.paneId]!
  workspace.tabs[tabId] = {
    id: tabId,
    paneId: request.paneId,
    title: 'Terminal',
    customTitle: null,
    content: {
      kind: 'terminal',
      launch: {
        cwd: request.launch.cwd,
        rows: request.launch.rows,
        cols: request.launch.cols
      }
    },
    createdAt
  }
  pane.tabs.splice(index, 0, tabId)
  pane.selectedTabId = tabId
  workspace.selectedPaneId = pane.id
  workspace.updatedAt = createdAt
  reconcileTabFocus(next, previousFocus)
  reconcileLegacyLimit(state, next)
  return commitChangedState(next)
}

/** Browser creation follows Rust's browser mutation path, which retains focus history. */
export function openBrowserTab(
  state: DurableApplicationState,
  input: z.input<typeof tabOpenBrowserParamsSchema>,
  tabId: string,
  browserSessionId: string,
  createdAt: number
): DurableApplicationState {
  const request = tabOpenBrowserParamsSchema.parse(input)
  const original = state.workspaces.find((item) => item.id === request.workspaceId)
  if (!original) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  const originalPane = original.panes[request.paneId]
  if (!originalPane) throw new WorkspaceMutationError('pane_not_found', 'Pane does not exist')
  if (state.legacyOverLimit) {
    throw new WorkspaceMutationError(
      'legacy_limit_reduction_required',
      'Browser creation requires normalized workspace limits'
    )
  }
  requireNewTabCapacity(state, original)
  if (state.workspaces.some((item) => item.tabs[tabId])) {
    throw new WorkspaceMutationError('duplicate_identity', 'Browser tab ID is in use')
  }
  if (
    state.workspaces.some((item) =>
      Object.values(item.tabs).some(
        (tab) =>
          tab.content.kind === 'browser' &&
          tab.content.metadata.browserSessionId === browserSessionId
      )
    )
  ) {
    throw new WorkspaceMutationError('duplicate_identity', 'Browser session ID is in use')
  }
  const index = request.destinationIndex ?? originalPane.tabs.length
  if (index > originalPane.tabs.length) {
    throw new WorkspaceMutationError('index_out_of_bounds', 'Tab destination index is invalid')
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Tab creation timestamp is invalid')
  }

  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === request.workspaceId)!
  const pane = workspace.panes[request.paneId]!
  workspace.tabs[tabId] = {
    id: tabId,
    paneId: pane.id,
    title: 'Browser',
    customTitle: null,
    content: {
      kind: 'browser',
      metadata: {
        browserSessionId,
        url: request.metadata.url,
        navigationTitle: '',
        canBack: false,
        canForward: false,
        loading: false,
        devToolsOpen: false,
        profilePartition: request.profilePartition ?? 'persist:agent-workspace-default',
        stateRevision: 0,
        correlationId: null
      }
    },
    createdAt
  }
  pane.tabs.splice(index, 0, tabId)
  pane.selectedTabId = tabId
  workspace.selectedPaneId = pane.id
  workspace.updatedAt = createdAt
  return commitChangedState(next)
}

/** Changes the selected pane and records a focus transition for the active workspace. */
export function focusPane(
  state: DurableApplicationState,
  workspaceId: string,
  paneId: string,
  updatedAt: number
): DurableApplicationState {
  const original = state.workspaces.find((item) => item.id === workspaceId)
  if (!original) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  if (!original.panes[paneId]) {
    throw new WorkspaceMutationError('pane_not_found', 'Pane does not exist')
  }
  if (original.selectedPaneId === paneId) {
    throw new WorkspaceMutationError('pane_already_focused', 'Pane is already focused')
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Pane focus timestamp is invalid')
  }
  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === workspaceId)!
  workspace.selectedPaneId = paneId
  workspace.updatedAt = updatedAt
  reconcileTabFocus(next, previousFocus)
  return commitChangedState(next)
}

/** Stores Rust's six-decimal canonical split ratio after protocol range validation. */
export function resizePane(
  state: DurableApplicationState,
  workspaceId: string,
  splitId: string,
  ratio: number,
  updatedAt: number
): DurableApplicationState {
  const original = state.workspaces.find((item) => item.id === workspaceId)
  if (!original) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  if (!Number.isFinite(ratio) || ratio < 0.05 || ratio > 0.95) {
    throw new WorkspaceMutationError('index_out_of_bounds', 'Split ratio is outside its range')
  }
  const stored = findSplit(original.layout as PaneLayout, splitId)
  if (!stored) throw new WorkspaceMutationError('split_not_found', 'Split does not exist')
  const canonical = Math.round(ratio * 1_000_000) / 1_000_000
  if (stored.ratio === canonical) {
    throw new WorkspaceMutationError('split_ratio_unchanged', 'Split ratio is unchanged')
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Pane resize timestamp is invalid')
  }
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === workspaceId)!
  findSplit(workspace.layout as PaneLayout, splitId)!.ratio = canonical
  workspace.updatedAt = updatedAt
  return commitChangedState(next)
}

/** Splits a leaf with one new content source, preserving moved tab and PTY identity. */
export function splitPane(
  state: DurableApplicationState,
  input: z.input<typeof paneSplitParamsSchema>,
  ids: NewPaneSplitIds,
  createdAt: number
): DurableApplicationState {
  const request = paneSplitParamsSchema.parse(input)
  const original = state.workspaces.find((item) => item.id === request.workspaceId)
  if (!original) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  if (!original.panes[request.targetPaneId]) {
    throw new WorkspaceMutationError('pane_not_found', 'Target pane does not exist')
  }
  if (state.workspaces.some((item) => item.panes[ids.paneId])) {
    throw new WorkspaceMutationError('duplicate_identity', 'New pane ID is in use')
  }
  if (state.workspaces.some((item) => findSplit(item.layout as PaneLayout, ids.splitId))) {
    throw new WorkspaceMutationError('duplicate_identity', 'New split ID is in use')
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Pane split timestamp is invalid')
  }

  const existing =
    request.content.kind === 'existingTab' ? original.tabs[request.content.tabId] : undefined
  if (request.content.kind === 'existingTab' && !existing) {
    throw new WorkspaceMutationError('tab_not_found', 'Tab does not exist')
  }
  const sourcePane = existing ? original.panes[existing.paneId]! : undefined
  if (sourcePane && sourcePane.id === request.targetPaneId && sourcePane.tabs.length === 1) {
    throw new WorkspaceMutationError(
      'split_would_empty_target',
      'Split would empty its target pane'
    )
  }
  const collapsesSource = Boolean(sourcePane && sourcePane.tabs.length === 1)
  const counts = workspaceCounts(state.workspaces)
  if (
    !collapsesSource &&
    (Object.keys(original.panes).length >= 64 || counts.totalPaneCount >= 1_024)
  ) {
    throw new WorkspaceMutationError('workspace_limit_reached', 'Workspace pane limit reached')
  }
  if (request.content.kind !== 'existingTab') {
    requireNewTabCapacity(state, original)
    if (state.workspaces.some((item) => item.tabs[ids.tabId])) {
      throw new WorkspaceMutationError('duplicate_identity', 'New tab ID is in use')
    }
  }
  if (
    request.content.kind === 'newBrowser' &&
    state.workspaces.some((item) =>
      Object.values(item.tabs).some(
        (tab) =>
          tab.content.kind === 'browser' &&
          tab.content.metadata.browserSessionId === ids.browserSessionId
      )
    )
  ) {
    throw new WorkspaceMutationError('duplicate_identity', 'Browser session ID is in use')
  }

  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === request.workspaceId)!
  const content = request.content
  let tabId: string
  if (content.kind === 'existingTab') {
    tabId = content.tabId
    const tab = workspace.tabs[tabId]!
    const source = workspace.panes[tab.paneId]!
    const index = source.tabs.indexOf(tabId)
    source.tabs.splice(index, 1)
    if (source.tabs.length === 0) {
      delete workspace.panes[source.id]
      workspace.layout = collapsePane(workspace.layout as PaneLayout, source.id)
    } else if (source.selectedTabId === tabId) {
      source.selectedTabId = source.tabs[Math.min(index, source.tabs.length - 1)]!
    }
    tab.paneId = ids.paneId
  } else {
    tabId = ids.tabId
    workspace.tabs[tabId] = {
      id: tabId,
      paneId: ids.paneId,
      title: content.kind === 'newTerminal' ? 'Terminal' : 'Browser',
      customTitle: null,
      content:
        content.kind === 'newTerminal'
          ? {
              kind: 'terminal',
              launch: {
                cwd: content.launch.cwd,
                rows: content.launch.rows,
                cols: content.launch.cols
              }
            }
          : {
              kind: 'browser',
              metadata: {
                browserSessionId: ids.browserSessionId,
                url: content.url,
                navigationTitle: '',
                canBack: false,
                canForward: false,
                loading: false,
                devToolsOpen: false,
                profilePartition: content.profilePartition ?? 'persist:agent-workspace-default',
                stateRevision: 0,
                correlationId: null
              }
            },
      createdAt
    }
  }
  workspace.panes[ids.paneId] = {
    id: ids.paneId,
    tabs: [tabId],
    selectedTabId: tabId,
    title: null
  }
  const layout = splitLeaf(
    workspace.layout as PaneLayout,
    request.targetPaneId,
    ids.paneId,
    ids.splitId,
    request.axis,
    Math.round(request.ratio * 1_000_000) / 1_000_000,
    request.placement
  )
  if (!layout) throw new WorkspaceMutationError('pane_not_found', 'Target pane is not in layout')
  workspace.layout = layout
  workspace.selectedPaneId = ids.paneId
  workspace.updatedAt = createdAt
  reconcileTabFocus(next, previousFocus)
  reconcileLegacyLimit(state, next)
  return commitChangedState(next)
}

/** Closes a pane, retaining a live terminal when it was the workspace's final pane. */
export function closePane(
  state: DurableApplicationState,
  workspaceId: string,
  paneId: string,
  replacementTabId: string | null,
  updatedAt: number
): DurableApplicationState {
  const original = state.workspaces.find((item) => item.id === workspaceId)
  if (!original) throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  const pane = original.panes[paneId]
  if (!pane) throw new WorkspaceMutationError('pane_not_found', 'Pane does not exist')
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Pane close timestamp is invalid')
  }
  const finalPane = Object.keys(original.panes).length === 1
  if (finalPane && !replacementTabId) {
    throw new WorkspaceMutationError('replacement_required', 'Final pane needs a terminal')
  }
  if (!finalPane && replacementTabId) {
    throw new WorkspaceMutationError('unexpected_replacement', 'Replacement tab is not needed')
  }
  if (replacementTabId && state.workspaces.some((item) => item.tabs[replacementTabId])) {
    throw new WorkspaceMutationError('duplicate_identity', 'Replacement tab ID is in use')
  }

  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === workspaceId)!
  const closing = workspace.panes[paneId]!
  if (finalPane) {
    const dimensions = Object.values(original.tabs)
      .sort((a, b) => a.id.localeCompare(b.id))
      .find((tab) => tab.content.kind === 'terminal')
    const launch = dimensions?.content.kind === 'terminal' ? dimensions.content.launch : undefined
    for (const tabId of closing.tabs) delete workspace.tabs[tabId]
    workspace.tabs[replacementTabId!] = {
      id: replacementTabId!,
      paneId,
      title: 'Terminal',
      customTitle: null,
      content: {
        kind: 'terminal',
        launch: {
          cwd: workspace.workingDirectory,
          rows: launch?.rows ?? 24,
          cols: launch?.cols ?? 80
        }
      },
      createdAt: updatedAt
    }
    workspace.panes[paneId] = {
      id: paneId,
      tabs: [replacementTabId!],
      selectedTabId: replacementTabId!,
      title: null
    }
  } else {
    for (const tabId of closing.tabs) delete workspace.tabs[tabId]
    delete workspace.panes[paneId]
    workspace.layout = collapsePane(workspace.layout as PaneLayout, paneId)
    if (workspace.selectedPaneId === paneId) {
      workspace.selectedPaneId = firstLeaf(workspace.layout as PaneLayout)
    }
  }
  workspace.updatedAt = updatedAt
  reconcileTabFocus(next, previousFocus)
  reconcileLegacyLimit(state, next)
  return commitChangedState(next)
}

/** Rust-compatible selection topology and focus-history mutation on a validated snapshot. */
export function selectWorkspace(
  state: DurableApplicationState,
  workspaceId: string
): DurableApplicationState {
  if (state.selectedWorkspaceId === workspaceId) {
    throw new WorkspaceMutationError('workspace_already_selected', 'Workspace is already selected')
  }
  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const nextFocus = focusTarget(state, workspaceId)
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceMutationError('revision_overflow', 'Application revision cannot advance')
  }

  const next = structuredClone(state)
  next.selectedWorkspaceId = workspaceId
  next.workspaceSelection = [workspaceId]
  next.focusedWindowId = nextFocus.windowId
  const placement = next.windowPlacements.find((item) => item.id === nextFocus.windowId)!
  if (placement.focusedWorkspaceId !== workspaceId) {
    placement.focusedWorkspaceId = workspaceId
    if (placement.revision >= Number.MAX_SAFE_INTEGER) {
      throw new WorkspaceMutationError('revision_overflow', 'Window revision cannot advance')
    }
    placement.revision += 1
  }

  const history = next.focusHistory
  if (history.entries.length === 0) history.entries.push(previousFocus)
  if (!sameTarget(history.entries.at(-1)!, nextFocus)) {
    history.entries = history.entries.slice(0, history.cursor + 1)
    history.entries.push(nextFocus)
  }
  if (history.entries.length > 128) history.entries.shift()
  history.cursor = history.entries.length - 1
  return commitChangedState(next)
}

/** Replaces the authoritative selection and focuses its chosen workspace. */
export function replaceWorkspaceSelection(
  state: DurableApplicationState,
  selection: string[],
  focusedWorkspaceId: string
): DurableApplicationState {
  if (
    selection.length === 0 ||
    new Set(selection).size !== selection.length ||
    !selection.includes(focusedWorkspaceId)
  ) {
    throw new WorkspaceMutationError('policy_denied', 'Workspace selection is invalid')
  }
  for (const id of selection) {
    if (!state.workspaces.some((workspace) => workspace.id === id)) {
      throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
    }
  }
  if (
    state.selectedWorkspaceId === focusedWorkspaceId &&
    state.workspaceSelection.length === selection.length &&
    state.workspaceSelection.every((id, index) => id === selection[index])
  ) {
    return state
  }
  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  next.workspaceSelection = [...selection]
  next.selectedWorkspaceId = focusedWorkspaceId
  const placement = next.windowPlacements.find((item) =>
    item.workspaceIds.includes(focusedWorkspaceId)
  )
  if (!placement) throw new WorkspaceMutationError('window_not_found', 'Workspace has no window')
  next.focusedWindowId = placement.id
  placement.focusedWorkspaceId = focusedWorkspaceId
  reconcileTabFocus(next, previousFocus)
  for (const window of next.windowPlacements) {
    const previous = state.windowPlacements.find((item) => item.id === window.id)
    if (previous && changedPlacement(previous, window)) {
      if (window.revision >= Number.MAX_SAFE_INTEGER) {
        throw new WorkspaceMutationError('revision_overflow', 'Window revision cannot advance')
      }
      window.revision += 1
    }
  }
  return commitChangedState(next)
}

/** Reorders the canonical workspace list without changing window placement order. */
export function moveWorkspace(
  state: DurableApplicationState,
  workspaceId: string,
  destinationIndex: number
): DurableApplicationState {
  const sourceIndex = state.workspaces.findIndex((item) => item.id === workspaceId)
  if (sourceIndex < 0) {
    throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  }
  if (
    !Number.isInteger(destinationIndex) ||
    destinationIndex < 0 ||
    destinationIndex >= state.workspaces.length
  ) {
    throw new WorkspaceMutationError(
      'index_out_of_bounds',
      'Workspace destination index is invalid'
    )
  }
  if (sourceIndex === destinationIndex) return state
  const next = structuredClone(state)
  const [workspace] = next.workspaces.splice(sourceIndex, 1)
  next.workspaces.splice(destinationIndex, 0, workspace!)
  return commitChangedState(next)
}

/** Applies metadata edits with Rust's unchanged-state and timestamp rules. */
export function updateWorkspace(
  state: DurableApplicationState,
  request: WorkspaceUpdateRequest,
  updatedAt: number
): DurableApplicationState {
  const original = state.workspaces.find((item) => item.id === request.workspaceId)
  if (!original) {
    throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Workspace timestamp is invalid')
  }
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === request.workspaceId)!
  if (request.name !== undefined) workspace.name = request.name
  if (request.description !== undefined) workspace.description = request.description.value
  if (request.color !== undefined) workspace.color = request.color.value
  if (request.workingDirectory !== undefined) workspace.workingDirectory = request.workingDirectory
  if (
    workspace.name === original.name &&
    workspace.description === original.description &&
    workspace.color === original.color &&
    workspace.workingDirectory === original.workingDirectory
  ) {
    throw new WorkspaceMutationError('workspace_unchanged', 'Workspace metadata is unchanged')
  }
  workspace.updatedAt = updatedAt
  return commitChangedState(next)
}

/** A restart keeps durable launch metadata and tab identity while advancing workspace time. */
export function restartTerminal(
  state: DurableApplicationState,
  workspaceId: string,
  tabId: string,
  updatedAt: number
): DurableApplicationState {
  const workspace = state.workspaces.find((item) => item.id === workspaceId)
  if (!workspace) {
    throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  }
  const tab = workspace.tabs[tabId]
  if (!tab) throw new WorkspaceMutationError('tab_not_found', 'Tab does not exist')
  if (tab.content.kind !== 'terminal') {
    throw new WorkspaceMutationError('tab_not_terminal', 'Tab is not a terminal')
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Workspace timestamp is invalid')
  }
  const next = structuredClone(state)
  next.workspaces.find((item) => item.id === workspaceId)!.updatedAt = updatedAt
  return commitChangedState(next)
}

/** Selects a tab and its pane, recording a focus transition for the active workspace. */
export function selectTab(
  state: DurableApplicationState,
  workspaceId: string,
  tabId: string,
  updatedAt: number
): DurableApplicationState {
  const workspace = state.workspaces.find((item) => item.id === workspaceId)
  if (!workspace) {
    throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  }
  const tab = workspace.tabs[tabId]
  if (!tab) throw new WorkspaceMutationError('tab_not_found', 'Tab does not exist')
  const pane = workspace.panes[tab.paneId]!
  if (workspace.selectedPaneId === tab.paneId && pane.selectedTabId === tabId) {
    throw new WorkspaceMutationError('tab_already_selected', 'Tab is already selected')
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Workspace timestamp is invalid')
  }
  const previousFocus = focusTarget(state, state.selectedWorkspaceId)
  const next = structuredClone(state)
  const selected = next.workspaces.find((item) => item.id === workspaceId)!
  selected.panes[tab.paneId]!.selectedTabId = tabId
  selected.selectedPaneId = tab.paneId
  selected.updatedAt = updatedAt
  const nextFocus = focusTarget(next, next.selectedWorkspaceId)
  if (!sameTarget(previousFocus, nextFocus)) {
    const history = next.focusHistory
    if (history.entries.length === 0) history.entries.push(previousFocus)
    if (!sameTarget(history.entries.at(-1)!, nextFocus)) {
      history.entries = history.entries.slice(0, history.cursor + 1)
      history.entries.push(nextFocus)
    }
    if (history.entries.length > 128) history.entries.shift()
    history.cursor = history.entries.length - 1
  }
  return commitChangedState(next)
}

/** Updates durable tab titles without changing its content or runtime ownership. */
export function updateTab(
  state: DurableApplicationState,
  input: z.input<typeof tabUpdateParamsSchema>,
  updatedAt: number
): DurableApplicationState {
  const request = tabUpdateParamsSchema.parse(input)
  const workspace = state.workspaces.find((item) => item.id === request.workspaceId)
  if (!workspace) {
    throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
  }
  const tab = workspace.tabs[request.tabId]
  if (!tab) throw new WorkspaceMutationError('tab_not_found', 'Tab does not exist')
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new WorkspaceMutationError('invalid_timestamp', 'Workspace timestamp is invalid')
  }
  const next = structuredClone(state)
  const selectedWorkspace = next.workspaces.find((item) => item.id === request.workspaceId)!
  const nextTab = selectedWorkspace.tabs[request.tabId]!
  if (request.title !== undefined) nextTab.title = request.title
  if (request.customTitle !== undefined) nextTab.customTitle = request.customTitle.value
  if (nextTab.title === tab.title && nextTab.customTitle === tab.customTitle) {
    throw new WorkspaceMutationError('tab_unchanged', 'Tab metadata is unchanged')
  }
  selectedWorkspace.updatedAt = updatedAt
  return commitChangedState(next)
}
