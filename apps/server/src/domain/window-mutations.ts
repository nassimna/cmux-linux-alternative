import type { DurableApplicationState } from '@agent-workspace/contracts'
import { durableApplicationStateSchema } from '@agent-workspace/contracts'
import { isAbsolute, relative } from 'node:path'

type State = DurableApplicationState
type Placement = State['windowPlacements'][number]
type FocusTarget = State['focusHistory']['entries'][number]

export class WindowMutationError extends Error {
  constructor(public readonly code: 'source_not_found' | 'target_not_found' |
    'stale_window_revision' | 'policy_denied' | 'resource_limit', message: string) {
    super(message)
    this.name = 'WindowMutationError'
  }
}

function requirePlacement(state: State, id: string, expectedRevision: number,
  missing: 'source_not_found' | 'target_not_found'): Placement {
  const placement = state.windowPlacements.find((item) => item.id === id)
  if (!placement) throw new WindowMutationError(missing, 'Window placement does not exist')
  if (placement.revision !== expectedRevision)
    throw new WindowMutationError('stale_window_revision', 'Window placement changed')
  return placement
}

function currentFocus(state: State): FocusTarget {
  const workspace = state.workspaces.find((item) => item.id === state.selectedWorkspaceId)!
  const pane = workspace.panes[workspace.selectedPaneId]!
  return {
    windowId: state.focusedWindowId, workspaceId: workspace.id,
    paneId: pane.id, tabId: pane.selectedTabId
  }
}

function validFocus(state: State, target: FocusTarget): boolean {
  const placement = state.windowPlacements.find((item) => item.id === target.windowId)
  const workspace = state.workspaces.find((item) => item.id === target.workspaceId)
  return Boolean(placement?.workspaceIds.includes(target.workspaceId) &&
    workspace?.panes[target.paneId]?.tabs.includes(target.tabId))
}

function commit(state: State): State {
  if (state.revision >= Number.MAX_SAFE_INTEGER)
    throw new WindowMutationError('resource_limit', 'Application revision cannot advance')
  state.revision += 1
  return durableApplicationStateSchema.parse(state)
}

function pruneHistory(state: State): void {
  const history = state.focusHistory
  const beforeCursor = history.entries.slice(0, history.cursor + 1).filter((entry) => validFocus(state, entry)).length
  history.entries = history.entries.filter((entry) => validFocus(state, entry))
  history.cursor = Math.min(Math.max(0, beforeCursor - 1), Math.max(0, history.entries.length - 1))
}

function recordFocus(state: State, target: FocusTarget): void {
  const history = state.focusHistory
  history.entries = history.entries.slice(0, history.cursor + 1)
  const last = history.entries.at(-1)
  if (!last || Object.keys(target).some((key) => last[key as keyof FocusTarget] !== target[key as keyof FocusTarget]))
    history.entries.push(target)
  if (history.entries.length > 128) history.entries.shift()
  history.cursor = Math.max(0, history.entries.length - 1)
}

export function createWindowPlacement(state: State, input: {
  sourceWindowId: string; sourceRevision: number; workspaceId: string;
  windowId: string; label: string
}): State {
  const source = requirePlacement(state, input.sourceWindowId, input.sourceRevision, 'source_not_found')
  if (state.windowPlacements.length >= 16)
    throw new WindowMutationError('resource_limit', 'Window placement limit reached')
  if (!source.workspaceIds.includes(input.workspaceId))
    throw new WindowMutationError('source_not_found', 'Workspace is not owned by source window')
  if (source.hostingState !== 'hosted')
    throw new WindowMutationError('policy_denied', 'Source window is not hosted')
  // A final source placement has to retain a workspace. Closing and moving the
  // final workspace needs the Rust provider transfer saga, outside this slice.
  if (source.workspaceIds.length < 2)
    throw new WindowMutationError('policy_denied', 'Source window needs another workspace')
  const next = structuredClone(state)
  const sourceNext = next.windowPlacements.find((item) => item.id === source.id)!
  sourceNext.workspaceIds = sourceNext.workspaceIds.filter((id) => id !== input.workspaceId)
  if (sourceNext.focusedWorkspaceId === input.workspaceId)
    sourceNext.focusedWorkspaceId = sourceNext.workspaceIds[0]!
  sourceNext.revision += 1
  next.windowPlacements.push({
    id: input.windowId, label: input.label, workspaceIds: [input.workspaceId],
    focusedWorkspaceId: input.workspaceId, hostingState: 'unhosted', revision: 0
  })
  next.focusedWindowId = input.windowId
  next.selectedWorkspaceId = input.workspaceId
  next.workspaceSelection = [input.workspaceId]
  pruneHistory(next)
  recordFocus(next, currentFocus(next))
  return commit(next)
}

export function focusWindowPlacement(state: State, input: {
  windowId: string; expectedRevision: number
}): State {
  const placement = requirePlacement(state, input.windowId, input.expectedRevision, 'target_not_found')
  if (placement.hostingState !== 'hosted')
    throw new WindowMutationError('policy_denied', 'Window is not hosted')
  const next = structuredClone(state)
  next.focusedWindowId = placement.id
  next.selectedWorkspaceId = placement.focusedWorkspaceId
  next.workspaceSelection = [placement.focusedWorkspaceId]
  recordFocus(next, currentFocus(next))
  return commit(next)
}

export function closeWindowPlacement(state: State, input: {
  windowId: string; expectedRevision: number;
  targetWindowId: string; targetRevision: number
}): State {
  const source = requirePlacement(state, input.windowId, input.expectedRevision, 'source_not_found')
  const target = requirePlacement(state, input.targetWindowId, input.targetRevision, 'target_not_found')
  if (source.id === target.id || target.hostingState !== 'hosted' ||
      target.workspaceIds.length + source.workspaceIds.length > 128)
    throw new WindowMutationError('policy_denied', 'Window cannot be rehomed to target')
  const next = structuredClone(state)
  const targetNext = next.windowPlacements.find((item) => item.id === target.id)!
  targetNext.workspaceIds.push(...source.workspaceIds)
  targetNext.focusedWorkspaceId = source.focusedWorkspaceId
  targetNext.revision += 1
  next.windowPlacements = next.windowPlacements.filter((item) => item.id !== source.id)
  next.focusedWindowId = target.id
  next.selectedWorkspaceId = source.focusedWorkspaceId
  next.workspaceSelection = [source.focusedWorkspaceId]
  pruneHistory(next)
  recordFocus(next, currentFocus(next))
  return commit(next)
}

/** Close a Node-created placement and its workspaces in one durable transition. */
export function closeWindowWorkspaces(state: State, input: {
  windowId: string; expectedRevision: number; closedItemIds: readonly string[]; now: number
}): State {
  const source = requirePlacement(state, input.windowId, input.expectedRevision, 'source_not_found')
  const closing = new Set(source.workspaceIds)
  if (closing.size === state.workspaces.length)
    throw new WindowMutationError('policy_denied', 'Closing the final window needs a replacement workspace')
  if (!Number.isSafeInteger(input.now) || input.now < 0)
    throw new WindowMutationError('policy_denied', 'Window close timestamp is invalid')
  const tabs = state.workspaces.filter((workspace) => closing.has(workspace.id))
    .flatMap((workspace) => Object.values(workspace.tabs).map((tab) => ({ workspace, tab })))
  if (tabs.length !== input.closedItemIds.length ||
      new Set(input.closedItemIds).size !== input.closedItemIds.length ||
      input.closedItemIds.some((id) => state.recentlyClosed.some((item) => item.id === id)))
    throw new WindowMutationError('policy_denied', 'Window close records are invalid')
  const records: State['recentlyClosed'] = tabs.map(({ workspace, tab }, index) => {
    let restore: State['recentlyClosed'][number]['restore']
    if (tab.content.kind === 'terminal') {
      const cwd = relative(workspace.workingDirectory, tab.content.launch.cwd)
      if (isAbsolute(cwd) || cwd.split('/').some((part) => part === '.' || part === '..'))
        throw new WindowMutationError('policy_denied', 'Terminal restore path is outside the workspace')
      restore = { kind: 'terminal', authorized_root_id: workspace.id,
        root_relative_cwd: cwd, rows: tab.content.launch.rows, cols: tab.content.launch.cols }
    } else {
      const url = new URL(tab.content.metadata.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new WindowMutationError('policy_denied', 'Browser restore URL is unsafe')
      url.search = ''; url.hash = ''
      restore = { kind: 'browser', url: url.href }
    }
    const title = tab.customTitle ?? tab.title
    if ([...title].length > 160 || Buffer.byteLength(JSON.stringify(restore)) > 8 * 1024)
      throw new WindowMutationError('policy_denied', 'Tab restore metadata is unsafe')
    return { id: input.closedItemIds[index]!, itemKind: 'tab', priorWorkspaceId: workspace.id,
      priorTabId: tab.id, contentKind: tab.content.kind, title, closedAt: input.now, restore }
  })
  const next = structuredClone(state)
  next.workspaces = next.workspaces.filter((workspace) => !closing.has(workspace.id))
  next.windowPlacements = next.windowPlacements.filter((placement) => placement.id !== source.id)
  next.workspacePins = next.workspacePins.filter((id) => !closing.has(id))
  for (const id of closing) delete next.workspaceGroupAssignments[id]
  next.workspaceSelection = next.workspaceSelection.filter((id) => !closing.has(id))
  if (closing.has(next.selectedWorkspaceId)) {
    next.selectedWorkspaceId = next.workspaces[0]!.id
    next.workspaceSelection = [next.selectedWorkspaceId]
  }
  if (!next.workspaceSelection.includes(next.selectedWorkspaceId))
    next.workspaceSelection.push(next.selectedWorkspaceId)
  const owner = next.windowPlacements.find((placement) =>
    placement.workspaceIds.includes(next.selectedWorkspaceId))!
  next.focusedWindowId = owner.id
  owner.focusedWorkspaceId = next.selectedWorkspaceId
  if (owner.revision >= Number.MAX_SAFE_INTEGER)
    throw new WindowMutationError('resource_limit', 'Window revision cannot advance')
  owner.revision += 1
  next.recentlyClosed.push(...records)
  next.recentlyClosed = next.recentlyClosed
    .filter((item) => Math.max(0, input.now - item.closedAt) <= 30 * 24 * 60 * 60 * 1_000)
    .sort((a, b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id)).slice(-100)
  pruneHistory(next)
  recordFocus(next, currentFocus(next))
  return commit(next)
}
