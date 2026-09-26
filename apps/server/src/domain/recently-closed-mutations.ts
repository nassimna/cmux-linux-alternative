import { isAbsolute, relative, resolve } from 'node:path'

import {
  durableApplicationStateSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'

export interface ExactReopenTarget {
  windowId: string
  workspaceId: string
  paneId: string
  destinationIndex: number
  expectedWindowRevision: number
}

export class RecentlyClosedError extends Error {
  public constructor(
    public readonly code:
      | 'source_not_found'
      | 'target_not_found'
      | 'stale_window_revision'
      | 'policy_denied'
      | 'resource_limit'
      | 'stale_revision'
      | 'unauthorized'
      | 'runtime_unavailable'
  ) {
    super(code.replaceAll('_', ' '))
    this.name = 'RecentlyClosedError'
  }
}

type Focus = DurableApplicationState['focusHistory']['entries'][number]

function currentFocus(state: DurableApplicationState): Focus {
  const workspace = state.workspaces.find((item) => item.id === state.selectedWorkspaceId)!
  const window = state.windowPlacements.find((item) => item.workspaceIds.includes(workspace.id))!
  const pane = workspace.panes[workspace.selectedPaneId]!
  return {
    windowId: window.id,
    workspaceId: workspace.id,
    paneId: pane.id,
    tabId: pane.selectedTabId
  }
}

function validFocus(state: DurableApplicationState, focus: Focus): boolean {
  const window = state.windowPlacements.find((item) => item.id === focus.windowId)
  const workspace = state.workspaces.find((item) => item.id === focus.workspaceId)
  return Boolean(
    window?.workspaceIds.includes(focus.workspaceId) &&
    workspace?.panes[focus.paneId]?.tabs.includes(focus.tabId)
  )
}

function sameFocus(a: Focus, b: Focus): boolean {
  return (
    a.windowId === b.windowId &&
    a.workspaceId === b.workspaceId &&
    a.paneId === b.paneId &&
    a.tabId === b.tabId
  )
}

/** Consumes one redacted tab record and creates fresh durable tab/browser identities. */
export function reopenClosedTab(
  state: DurableApplicationState,
  closedItemId: string,
  target: ExactReopenTarget,
  tabId: string,
  browserSessionId: string,
  now: number
): DurableApplicationState {
  const record = state.recentlyClosed.find((item) => item.id === closedItemId)
  if (!record || record.itemKind !== 'tab') throw new RecentlyClosedError('source_not_found')
  const placement = state.windowPlacements.find((item) => item.id === target.windowId)
  if (!placement || !placement.workspaceIds.includes(target.workspaceId))
    throw new RecentlyClosedError('target_not_found')
  if (placement.revision !== target.expectedWindowRevision)
    throw new RecentlyClosedError('stale_window_revision')
  const original = state.workspaces.find((item) => item.id === target.workspaceId)
  const originalPane = original?.panes[target.paneId]
  if (
    !original ||
    !originalPane ||
    !Number.isSafeInteger(target.destinationIndex) ||
    target.destinationIndex < 0 ||
    target.destinationIndex > originalPane.tabs.length
  )
    throw new RecentlyClosedError('target_not_found')
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    state.revision >= Number.MAX_SAFE_INTEGER ||
    placement.revision >= Number.MAX_SAFE_INTEGER
  )
    throw new RecentlyClosedError('stale_revision')
  if (
    state.legacyOverLimit ||
    Object.keys(original.tabs).length >= 128 ||
    state.workspaces.reduce((count, workspace) => count + Object.keys(workspace.tabs).length, 0) >=
      2_048
  )
    throw new RecentlyClosedError('resource_limit')
  if (record.priorTabId === tabId || state.workspaces.some((workspace) => workspace.tabs[tabId]))
    throw new RecentlyClosedError('policy_denied')

  // Rust's aggregate requires the restored title to equal the record exactly.
  if (record.title.length === 0) throw new RecentlyClosedError('policy_denied')
  const title = record.title
  let content: DurableApplicationState['workspaces'][number]['tabs'][string]['content']
  if (record.restore.kind === 'terminal') {
    const restore = record.restore
    const root = state.workspaces.find((workspace) => workspace.id === restore.authorized_root_id)
    if (!root) throw new RecentlyClosedError('policy_denied')
    const cwd = resolve(root.workingDirectory, restore.root_relative_cwd)
    const within = relative(root.workingDirectory, cwd)
    if (isAbsolute(within) || within.split('/').some((part) => part === '..'))
      throw new RecentlyClosedError('policy_denied')
    content = { kind: 'terminal', launch: { cwd, rows: restore.rows, cols: restore.cols } }
  } else {
    if (
      state.workspaces.some((workspace) =>
        Object.values(workspace.tabs).some(
          (tab) =>
            tab.content.kind === 'browser' &&
            tab.content.metadata.browserSessionId === browserSessionId
        )
      )
    )
      throw new RecentlyClosedError('policy_denied')
    content = {
      kind: 'browser',
      metadata: {
        browserSessionId,
        url: record.restore.url,
        navigationTitle: '',
        canBack: false,
        canForward: false,
        loading: false,
        devToolsOpen: false,
        profilePartition: 'persist:agent-workspace-default',
        stateRevision: 0,
        correlationId: null
      }
    }
  }

  const previousFocus = currentFocus(state)
  const next = structuredClone(state)
  const workspace = next.workspaces.find((item) => item.id === target.workspaceId)!
  const pane = workspace.panes[target.paneId]!
  workspace.tabs[tabId] = {
    id: tabId,
    paneId: pane.id,
    title,
    customTitle: null,
    content,
    createdAt: now
  }
  pane.tabs.splice(target.destinationIndex, 0, tabId)
  pane.selectedTabId = tabId
  workspace.selectedPaneId = pane.id
  workspace.updatedAt = now
  next.recentlyClosed = next.recentlyClosed.filter((item) => item.id !== closedItemId)
  next.selectedWorkspaceId = workspace.id
  next.workspaceSelection = [workspace.id]
  next.focusedWindowId = placement.id
  const nextPlacement = next.windowPlacements.find((item) => item.id === placement.id)!
  if (nextPlacement.focusedWorkspaceId !== workspace.id) {
    nextPlacement.focusedWorkspaceId = workspace.id
    nextPlacement.revision += 1
  }
  const history = next.focusHistory
  const retained = history.entries
    .slice(0, history.cursor + 1)
    .filter((item) => validFocus(next, item)).length
  history.entries = history.entries.filter((item) => validFocus(next, item))
  history.cursor = Math.min(Math.max(0, retained - 1), Math.max(0, history.entries.length - 1))
  const focus = currentFocus(next)
  if (!sameFocus(previousFocus, focus)) {
    if (history.entries.length === 0 && validFocus(next, previousFocus))
      history.entries.push(previousFocus)
    if (history.entries.length === 0 || !sameFocus(history.entries.at(-1)!, focus)) {
      history.entries = history.entries.slice(0, history.cursor + 1)
      history.entries.push(focus)
    }
    if (history.entries.length > 128) history.entries.shift()
    history.cursor = history.entries.length - 1
  }
  next.revision += 1
  if (!durableApplicationStateSchema.safeParse(next).success)
    throw new RecentlyClosedError('policy_denied')
  return next
}
