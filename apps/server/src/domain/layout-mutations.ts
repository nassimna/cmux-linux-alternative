import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  durableApplicationStateSchema,
  layoutExportEnvelopeSchema,
  layoutExportResultSchema,
  layoutGetResultSchema,
  layoutListResultSchema,
  layoutTemplateSnapshotSchema,
  type DurableApplicationState,
  type LayoutTemplate
} from '@agent-workspace/contracts'

import { WorkspaceMutationError } from './workspace-mutations'

type Workspace = DurableApplicationState['workspaces'][number]
type Layout = DurableApplicationState['savedLayouts'][number]
type LayoutTree = LayoutTemplate['workspaces'][number]['layout']

export type LayoutBoundTab = { workspaceId: string; paneId: string; tabId: string }

/** Catalog rows can outlive a runtime, so even closed bindings must remain addressable. */
export function assertLayoutBindingsPreserved(
  before: DurableApplicationState,
  candidate: DurableApplicationState,
  bindings: readonly LayoutBoundTab[]
): void {
  for (const binding of bindings) {
    const previous = before.workspaces.find((item) => item.id === binding.workspaceId)
    const workspace = candidate.workspaces.find((item) => item.id === binding.workspaceId)
    const previousTab = previous?.tabs[binding.tabId]
    const nextTab = workspace?.tabs[binding.tabId]
    if (
      previousTab?.content.kind !== 'terminal' ||
      nextTab?.content.kind !== 'terminal' ||
      !isDeepStrictEqual(previousTab.content.launch, nextTab.content.launch) ||
      !workspace?.panes[binding.paneId]?.tabs.includes(binding.tabId) ||
      nextTab.paneId !== binding.paneId ||
      previousTab.paneId !== binding.paneId
    ) {
      throw new WorkspaceMutationError(
        'policy_denied',
        'Saved layout would remove an agent or remote session binding'
      )
    }
  }
}

function requireLayout(state: DurableApplicationState, layoutId: string): Layout {
  const layout = state.savedLayouts.find((item) => item.id === layoutId)
  if (!layout) throw new WorkspaceMutationError('layout_not_found', 'Saved layout does not exist')
  return layout
}

function commit(next: DurableApplicationState): DurableApplicationState {
  if (next.revision >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceMutationError('revision_overflow', 'Application revision cannot advance')
  }
  next.revision += 1
  return durableApplicationStateSchema.parse(next)
}

/** Rust's portable browser URL removes credentials, query, and fragment. */
export function portableBrowserUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WorkspaceMutationError('policy_denied', 'Browser URL is not portable')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new WorkspaceMutationError('policy_denied', 'Browser URL is not portable')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.href
}

function templateFromWorkspace(workspace: Workspace): LayoutTemplate['workspaces'][number] {
  const tabs = Object.fromEntries(
    Object.entries(workspace.tabs).map(([id, tab]) => [
      id,
      {
        id: tab.id,
        paneId: tab.paneId,
        title: tab.title,
        customTitle: tab.customTitle,
        content:
          tab.content.kind === 'terminal'
            ? { kind: 'terminal' as const, launch: tab.content.launch }
            : {
                kind: 'browser' as const,
                url: portableBrowserUrl(tab.content.metadata.url)
              },
        createdAt: tab.createdAt
      }
    ])
  )
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    color: workspace.color,
    workingDirectory: workspace.workingDirectory,
    layout: workspace.layout as LayoutTree,
    selectedPaneId: workspace.selectedPaneId,
    panes: workspace.panes,
    tabs,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt
  }
}

function requireDistinctSplitIds(template: LayoutTemplate): void {
  const splits = new Set<string>()
  const walk = (node: LayoutTree): void => {
    if (node.kind === 'leaf') return
    if (splits.has(node.splitId)) {
      throw new WorkspaceMutationError('duplicate_identity', 'Saved layout split ID is duplicated')
    }
    splits.add(node.splitId)
    walk(node.first)
    walk(node.second)
  }
  for (const workspace of template.workspaces) walk(workspace.layout)
}

export function listLayouts(state: DurableApplicationState) {
  return layoutListResultSchema.parse({
    revision: state.revision,
    layouts: state.savedLayouts.map((layout) => ({
      id: layout.id,
      name: layout.name,
      formatVersion: layout.formatVersion,
      createdAt: layout.createdAt,
      updatedAt: layout.updatedAt,
      workspaceCount: layout.template.workspaces.length
    }))
  })
}

export function getLayout(state: DurableApplicationState, layoutId: string) {
  return layoutGetResultSchema.parse({
    revision: state.revision,
    layout: requireLayout(state, layoutId)
  })
}

/** Exports only paths still under a currently open workspace root. */
export function exportLayout(state: DurableApplicationState, layoutId: string) {
  const layout = requireLayout(state, layoutId)
  const roots = state.workspaces.map((workspace) => authorizedRealPath(workspace.workingDirectory))
  for (const workspace of layout.template.workspaces) {
    verifyPath(workspace.workingDirectory, roots)
    for (const tab of Object.values(workspace.tabs)) {
      if (tab.content.kind === 'terminal') verifyPath(tab.content.launch.cwd, roots)
    }
  }
  return layoutExportResultSchema.parse({
    envelope: {
      formatVersion: layout.formatVersion,
      name: layout.name,
      template: layout.template
    }
  })
}

function authorizedRealPath(path: string): string {
  if (!isAbsolute(path) || path.split(sep).includes('..')) {
    throw new WorkspaceMutationError(
      'unauthorized_layout_path',
      'Saved layout path is not authorized'
    )
  }
  try {
    return realpathSync.native(path)
  } catch {
    throw new WorkspaceMutationError('unauthorized_layout_path', 'Saved layout path is unavailable')
  }
}

function verifyPath(path: string, roots: string[]): string {
  const real = authorizedRealPath(path)
  if (!roots.some((root) => real === root || real.startsWith(`${root}${sep}`))) {
    throw new WorkspaceMutationError(
      'unauthorized_layout_path',
      'Saved layout path escapes open workspaces'
    )
  }
  return real
}

export function saveLayout(
  state: DurableApplicationState,
  layoutId: string,
  name: string,
  workspaceIds: string[],
  updatedAt: number
): DurableApplicationState {
  const workspaces = workspaceIds.map((id) => {
    const workspace = state.workspaces.find((item) => item.id === id)
    if (!workspace)
      throw new WorkspaceMutationError('workspace_not_found', 'Workspace does not exist')
    return workspace
  })
  const parsed = layoutTemplateSnapshotSchema.safeParse({
    workspaces: workspaces.map(templateFromWorkspace)
  })
  if (!parsed.success) {
    throw new WorkspaceMutationError(
      'layout_limit_reached',
      'Saved layout template is invalid or too large'
    )
  }
  const template = parsed.data
  requireDistinctSplitIds(template)
  const previous = state.savedLayouts.find((layout) => layout.id === layoutId)
  if (
    previous &&
    previous.name === name &&
    JSON.stringify(previous.template) === JSON.stringify(template)
  ) {
    return state
  }
  if (!previous && state.savedLayouts.length >= 64) {
    throw new WorkspaceMutationError('layout_limit_reached', 'Saved layout limit reached')
  }
  const next = structuredClone(state)
  const layout = {
    id: layoutId,
    name,
    formatVersion: 1 as const,
    createdAt: previous?.createdAt ?? updatedAt,
    updatedAt,
    template
  }
  if (previous)
    next.savedLayouts[next.savedLayouts.findIndex((item) => item.id === layoutId)] = layout
  else next.savedLayouts.push(layout)
  return commit(next)
}

export function deleteLayout(
  state: DurableApplicationState,
  layoutId: string
): DurableApplicationState {
  const index = state.savedLayouts.findIndex((item) => item.id === layoutId)
  if (index < 0) throw new WorkspaceMutationError('layout_not_found', 'Saved layout does not exist')
  const next = structuredClone(state)
  next.savedLayouts.splice(index, 1)
  return commit(next)
}

function remapTree(node: LayoutTree, panes: Map<string, string>, newId: () => string): LayoutTree {
  if (node.kind === 'leaf') return { kind: 'leaf', paneId: panes.get(node.paneId)! }
  return {
    ...node,
    splitId: newId(),
    first: remapTree(node.first, panes, newId),
    second: remapTree(node.second, panes, newId)
  }
}

function freshTemplate(template: LayoutTemplate, newId: () => string): LayoutTemplate {
  const workspaces = template.workspaces.map((workspace) => {
    const panes = new Map(
      Object.keys(workspace.panes)
        .sort()
        .map((id) => [id, newId()])
    )
    const tabs = new Map(
      Object.keys(workspace.tabs)
        .sort()
        .map((id) => [id, newId()])
    )
    const id = newId()
    return {
      ...workspace,
      id,
      layout: remapTree(workspace.layout, panes, newId),
      selectedPaneId: panes.get(workspace.selectedPaneId)!,
      panes: Object.fromEntries(
        Object.entries(workspace.panes).map(([oldId, pane]) => {
          const id = panes.get(oldId)!
          return [
            id,
            {
              ...pane,
              id,
              tabs: pane.tabs.map((tabId) => tabs.get(tabId)!),
              selectedTabId: tabs.get(pane.selectedTabId)!
            }
          ]
        })
      ),
      tabs: Object.fromEntries(
        Object.entries(workspace.tabs).map(([oldId, tab]) => {
          const id = tabs.get(oldId)!
          return [id, { ...tab, id, paneId: panes.get(tab.paneId)! }]
        })
      )
    }
  })
  return layoutTemplateSnapshotSchema.parse({ workspaces })
}

export function importLayout(
  state: DurableApplicationState,
  layoutId: string,
  envelope: unknown,
  updatedAt: number,
  newId: () => string = randomUUID
): DurableApplicationState {
  const parsed = layoutExportEnvelopeSchema.parse(envelope)
  requireDistinctSplitIds(parsed.template)
  const existingIndex = state.savedLayouts.findIndex((layout) => layout.id === layoutId)
  if (existingIndex < 0 && state.savedLayouts.length >= 64) {
    throw new WorkspaceMutationError('layout_limit_reached', 'Saved layout limit reached')
  }
  const template = freshTemplate(parsed.template, newId)
  requireDistinctSplitIds(template)
  const next = structuredClone(state)
  const layout = {
    id: layoutId,
    name: parsed.name,
    formatVersion: 1 as const,
    createdAt: updatedAt,
    updatedAt,
    template
  }
  if (existingIndex < 0) next.savedLayouts.push(layout)
  else next.savedLayouts[existingIndex] = layout
  return commit(next)
}

type FocusTarget = DurableApplicationState['focusHistory']['entries'][number]

function focusTarget(state: DurableApplicationState): FocusTarget {
  const workspace = state.workspaces.find((item) => item.id === state.selectedWorkspaceId)!
  const pane = workspace.panes[workspace.selectedPaneId]!
  const placement = state.windowPlacements.find((item) => item.workspaceIds.includes(workspace.id))!
  return {
    windowId: placement.id,
    workspaceId: workspace.id,
    paneId: pane.id,
    tabId: pane.selectedTabId
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

function reconcileLayoutTopology(
  before: DurableApplicationState,
  next: DurableApplicationState,
  targetWindowId?: string
): void {
  const workspaceIds = new Set(next.workspaces.map((workspace) => workspace.id))
  for (const placement of next.windowPlacements) {
    placement.workspaceIds = placement.workspaceIds.filter((id) => workspaceIds.has(id))
  }
  if (targetWindowId) {
    const target = next.windowPlacements.find((placement) => placement.id === targetWindowId)
    if (!target) throw new WorkspaceMutationError('window_not_found', 'Window does not exist')
    // The first saved workspace becomes selected. Move it into the caller's hosted
    // window even when its previous placement belonged to another window.
    for (const placement of next.windowPlacements) {
      if (placement.id !== targetWindowId) {
        placement.workspaceIds = placement.workspaceIds.filter(
          (id) => id !== next.selectedWorkspaceId
        )
      }
    }
    if (!target.workspaceIds.includes(next.selectedWorkspaceId)) {
      target.workspaceIds.push(next.selectedWorkspaceId)
    }
  }
  next.windowPlacements = next.windowPlacements.filter(
    (placement) => placement.workspaceIds.length > 0 || placement.id === targetWindowId
  )
  const placed = new Set(next.windowPlacements.flatMap((placement) => placement.workspaceIds))
  const missing = next.workspaces.map((workspace) => workspace.id).filter((id) => !placed.has(id))
  if (next.windowPlacements.length === 0) {
    next.windowPlacements.push({
      id: next.selectedWorkspaceId,
      label: 'Main',
      workspaceIds: missing,
      focusedWorkspaceId: next.selectedWorkspaceId,
      hostingState: 'unhosted',
      revision: 0
    })
  } else if (missing.length > 0) {
    const target =
      next.windowPlacements.find((placement) => placement.id === targetWindowId) ??
      next.windowPlacements.find((placement) => placement.id === next.focusedWindowId) ??
      next.windowPlacements[0]!
    target.workspaceIds.push(...missing)
    target.focusedWorkspaceId = next.selectedWorkspaceId
  }
  for (const placement of next.windowPlacements) {
    if (!placement.workspaceIds.includes(placement.focusedWorkspaceId)) {
      placement.focusedWorkspaceId = placement.workspaceIds[0]!
    }
  }
  if (!next.windowPlacements.some((placement) => placement.id === next.focusedWindowId)) {
    next.focusedWindowId = next.windowPlacements[0]!.id
  }
  const selectedPlacement = next.windowPlacements.find((placement) =>
    placement.workspaceIds.includes(next.selectedWorkspaceId)
  )!
  next.focusedWindowId = selectedPlacement.id
  selectedPlacement.focusedWorkspaceId = next.selectedWorkspaceId

  const history = next.focusHistory
  const retainedThroughCursor = history.entries
    .slice(0, history.cursor + 1)
    .filter((entry) => validFocus(next, entry)).length
  history.entries = history.entries.filter((entry) => validFocus(next, entry))
  history.cursor = Math.min(
    Math.max(0, retainedThroughCursor - 1),
    Math.max(0, history.entries.length - 1)
  )
  const previousFocus = focusTarget(before)
  const currentFocus = focusTarget(next)
  if (!isDeepStrictEqual(previousFocus, currentFocus)) {
    if (history.entries.length === 0 && validFocus(next, previousFocus)) {
      history.entries.push(previousFocus)
    }
    if (!isDeepStrictEqual(history.entries.at(-1), currentFocus)) {
      if (history.entries.length > 0) history.entries = history.entries.slice(0, history.cursor + 1)
      history.entries.push(currentFocus)
    }
    if (history.entries.length > 128) history.entries.shift()
    history.cursor = history.entries.length - 1
  }

  for (const placement of next.windowPlacements) {
    const old = before.windowPlacements.find((item) => item.id === placement.id)
    if (!old) continue
    placement.revision = old.revision
    if (!isDeepStrictEqual(placement, old)) {
      if (old.revision >= Number.MAX_SAFE_INTEGER) {
        throw new WorkspaceMutationError('revision_overflow', 'Window revision cannot advance')
      }
      placement.revision += 1
    }
  }
}

/** Builds Rust's checked layout candidate before any PTY is launched or stopped. */
export function planLayoutApplication(
  state: DurableApplicationState,
  layoutId: string,
  newId: () => string = randomUUID,
  targetWindowId?: string
): DurableApplicationState {
  if (targetWindowId) {
    const placement = state.windowPlacements.find((item) => item.id === targetWindowId)
    if (!placement) throw new WorkspaceMutationError('window_not_found', 'Window does not exist')
    if (placement.hostingState !== 'hosted') {
      throw new WorkspaceMutationError('policy_denied', 'Window is not hosted')
    }
    if (
      state.windowPlacements.some(
        (item) => item.id !== targetWindowId && item.hostingState === 'hosted'
      )
    ) {
      throw new WorkspaceMutationError(
        'policy_denied',
        'Saved layout apply requires one hosted window'
      )
    }
  }
  const layout = requireLayout(state, layoutId)
  const roots = state.workspaces.map((workspace) => authorizedRealPath(workspace.workingDirectory))
  const currentTabs = new Map(
    state.workspaces.flatMap((workspace) => Object.entries(workspace.tabs))
  )
  const next = structuredClone(state)
  next.workspaces = layout.template.workspaces.map((template) => {
    const workingDirectory = verifyPath(template.workingDirectory, roots)
    const tabs: Workspace['tabs'] = {}
    for (const [id, tab] of Object.entries(template.tabs)) {
      const current = currentTabs.get(id)
      if (tab.content.kind === 'terminal') {
        tabs[id] = {
          id: tab.id,
          paneId: tab.paneId,
          title: tab.title,
          customTitle: tab.customTitle,
          content: {
            kind: 'terminal',
            launch: { ...tab.content.launch, cwd: verifyPath(tab.content.launch.cwd, roots) }
          },
          createdAt: tab.createdAt
        }
      } else {
        const metadata =
          current?.content.kind === 'browser' &&
          portableBrowserUrl(current.content.metadata.url) === tab.content.url
            ? current.content.metadata
            : {
                browserSessionId: newId(),
                url: tab.content.url,
                navigationTitle: '',
                canBack: false,
                canForward: false,
                loading: false,
                devToolsOpen: false,
                profilePartition: 'persist:agent-workspace-default',
                stateRevision: 0,
                correlationId: null
              }
        tabs[id] = {
          id: tab.id,
          paneId: tab.paneId,
          title: tab.title,
          customTitle: tab.customTitle,
          content: { kind: 'browser', metadata: structuredClone(metadata) },
          createdAt: tab.createdAt
        }
      }
    }
    return {
      ...template,
      workingDirectory,
      layout: structuredClone(template.layout),
      panes: structuredClone(template.panes),
      tabs
    }
  })
  if (targetWindowId) {
    const nextWorkspaceIds = new Set(next.workspaces.map((workspace) => workspace.id))
    if (state.workspaces.some((workspace) => !nextWorkspaceIds.has(workspace.id))) {
      throw new WorkspaceMutationError(
        'policy_denied',
        'Saved layout would remove a workspace required by the copy'
      )
    }
  }
  next.selectedWorkspaceId = next.workspaces[0]!.id
  next.workspaceSelection = [next.selectedWorkspaceId]
  const retained = new Set(next.workspaces.map((workspace) => workspace.id))
  next.workspacePins = next.workspacePins.filter((id) => retained.has(id))
  next.workspaceGroupAssignments = Object.fromEntries(
    Object.entries(next.workspaceGroupAssignments).filter(([id]) => retained.has(id))
  )
  next.legacyOverLimit = null
  reconcileLayoutTopology(state, next, targetWindowId)
  if (
    targetWindowId &&
    state.windowPlacements.some(
      (placement) =>
        placement.id !== targetWindowId &&
        !next.windowPlacements.some((candidate) => candidate.id === placement.id)
    )
  ) {
    throw new WorkspaceMutationError('policy_denied', 'Saved layout would remove another window')
  }
  if (isDeepStrictEqual(state, next)) return state
  return commit(next)
}
