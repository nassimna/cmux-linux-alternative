import {
  durableApplicationStateSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'
import { tabDetachParamsSchema } from '@agent-workspace/protocol-client'
import type { z } from 'zod'

import { WindowMutationError } from './window-mutations'

type Request = z.infer<typeof tabDetachParamsSchema>
type Ids = { windowId: string; workspaceId: string; paneId: string; replacementTabId: string }
type Layout =
  | { kind: 'leaf'; paneId: string }
  | {
      kind: 'split'
      splitId: string
      axis: 'horizontal' | 'vertical'
      ratio: number
      first: Layout
      second: Layout
    }

function collapsePane(layout: Layout, paneId: string): Layout | null {
  if (layout.kind === 'leaf') return layout.paneId === paneId ? null : layout
  const first = collapsePane(layout.first, paneId)
  const second = collapsePane(layout.second, paneId)
  if (!first) return second
  if (!second) return first
  return { ...layout, first, second }
}

/** Creates one unhosted window and workspace with the same live tab identity. */
export function detachExactTab(
  state: DurableApplicationState,
  input: Request,
  ids: Ids,
  now: number
): DurableApplicationState {
  const request = tabDetachParamsSchema.parse(input)
  const placement = state.windowPlacements.find((item) => item.id === request.source.windowId)
  if (!placement || !placement.workspaceIds.includes(request.source.workspaceId))
    throw new WindowMutationError('source_not_found', 'Source window is unavailable')
  if (placement.revision !== request.source.expectedWindowRevision)
    throw new WindowMutationError('stale_window_revision', 'Window placement changed')
  if (placement.hostingState !== 'hosted')
    throw new WindowMutationError('policy_denied', 'Source window is not hosted')
  const source = state.workspaces.find((item) => item.id === request.source.workspaceId)
  const tab = source?.tabs[request.source.tabId]
  const pane = source?.panes[request.source.paneId]
  if (!source || !tab || tab.paneId !== pane?.id || !pane.tabs.includes(tab.id))
    throw new WindowMutationError('source_not_found', 'Source tab is unavailable')
  if (
    tab.content.kind !== 'terminal' &&
    (tab.content.kind !== 'browser' || !tab.content.metadata.browserSessionId)
  )
    throw new WindowMutationError('policy_denied', 'Tab has no transferable runtime identity')
  if (state.legacyOverLimit || !Number.isSafeInteger(now) || now < 0)
    throw new WindowMutationError('policy_denied', 'Tab detach is unavailable in this state')
  const sourceHasOneTab = Object.keys(source.tabs).length === 1
  const sourcePaneWillCollapse = !sourceHasOneTab && pane.tabs.length === 1
  const nextPaneCount =
    state.workspaces.reduce((total, workspace) => total + Object.keys(workspace.panes).length, 1) -
    (sourcePaneWillCollapse ? 1 : 0)
  const nextTabCount = state.workspaces.reduce(
    (total, workspace) => total + Object.keys(workspace.tabs).length,
    sourceHasOneTab ? 1 : 0
  )
  if (
    state.windowPlacements.length >= 16 ||
    state.workspaces.length >= 128 ||
    nextPaneCount > 1_024 ||
    nextTabCount > 2_048 ||
    state.revision >= Number.MAX_SAFE_INTEGER ||
    placement.revision >= Number.MAX_SAFE_INTEGER
  )
    throw new WindowMutationError('resource_limit', 'Tab detach capacity is exhausted')
  if (
    state.windowPlacements.some((item) => item.id === ids.windowId) ||
    state.workspaces.some((item) => item.id === ids.workspaceId) ||
    state.workspaces.some((item) => item.panes[ids.paneId] || item.tabs[ids.replacementTabId])
  )
    throw new WindowMutationError('policy_denied', 'New tab detach identity is unavailable')

  const next = structuredClone(state)
  const from = next.workspaces.find((item) => item.id === source.id)!
  const sourcePane = from.panes[pane.id]!
  const moving = from.tabs[tab.id]!
  const index = sourcePane.tabs.indexOf(tab.id)
  delete from.tabs[tab.id]
  if (Object.keys(from.tabs).length === 0) {
    const replacementId = ids.replacementTabId
    from.tabs[replacementId] = {
      id: replacementId,
      paneId: sourcePane.id,
      title: 'Terminal',
      customTitle: null,
      content: { kind: 'terminal', launch: { cwd: from.workingDirectory, rows: 24, cols: 80 } },
      createdAt: now
    }
    sourcePane.tabs = [replacementId]
    sourcePane.selectedTabId = replacementId
  } else {
    sourcePane.tabs.splice(index, 1)
    if (sourcePane.tabs.length === 0) {
      const collapsed = collapsePane(from.layout as Layout, sourcePane.id)
      if (!collapsed)
        throw new WindowMutationError('policy_denied', 'Source layout cannot be emptied')
      from.layout = collapsed
      delete from.panes[sourcePane.id]
      if (from.selectedPaneId === sourcePane.id) from.selectedPaneId = Object.keys(from.panes)[0]!
    } else if (sourcePane.selectedTabId === moving.id) {
      sourcePane.selectedTabId = sourcePane.tabs[Math.min(index, sourcePane.tabs.length - 1)]!
    }
  }
  from.updatedAt = now
  moving.paneId = ids.paneId
  const workspaceName = request.windowLabel || 'Detached'
  next.workspaces.push({
    id: ids.workspaceId,
    name: workspaceName,
    description: null,
    color: null,
    workingDirectory: from.workingDirectory,
    layout: { kind: 'leaf', paneId: ids.paneId },
    selectedPaneId: ids.paneId,
    panes: {
      [ids.paneId]: {
        id: ids.paneId,
        tabs: [moving.id],
        selectedTabId: moving.id,
        title: null
      }
    },
    tabs: { [moving.id]: moving },
    createdAt: now,
    updatedAt: now
  })
  const sourcePlacement = next.windowPlacements.find((item) => item.id === placement.id)!
  sourcePlacement.revision += 1
  next.windowPlacements.push({
    id: ids.windowId,
    label: request.windowLabel,
    workspaceIds: [ids.workspaceId],
    focusedWorkspaceId: ids.workspaceId,
    hostingState: 'unhosted',
    revision: 0
  })
  next.focusedWindowId = ids.windowId
  next.selectedWorkspaceId = ids.workspaceId
  next.workspaceSelection = [ids.workspaceId]
  const retained = next.focusHistory.entries
    .slice(0, next.focusHistory.cursor + 1)
    .filter((entry) => entry.tabId !== moving.id).length
  next.focusHistory.entries = next.focusHistory.entries.filter((entry) => entry.tabId !== moving.id)
  next.focusHistory.cursor = Math.min(
    Math.max(0, retained - 1),
    Math.max(0, next.focusHistory.entries.length - 1)
  )
  next.focusHistory.entries = next.focusHistory.entries.slice(0, next.focusHistory.cursor + 1)
  next.focusHistory.entries.push({
    windowId: ids.windowId,
    workspaceId: ids.workspaceId,
    paneId: ids.paneId,
    tabId: moving.id
  })
  if (next.focusHistory.entries.length > 128) next.focusHistory.entries.shift()
  next.focusHistory.cursor = next.focusHistory.entries.length - 1
  next.revision += 1
  return durableApplicationStateSchema.parse(next)
}
