import {
  durableApplicationStateSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'
import { tabMoveExactParamsSchema } from '@agent-workspace/protocol-client'
import type { z } from 'zod'

import { WindowMutationError } from './window-mutations'

type Request = z.infer<typeof tabMoveExactParamsSchema>
type FocusTarget = DurableApplicationState['focusHistory']['entries'][number]
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

function validFocus(state: DurableApplicationState, focus: FocusTarget): boolean {
  const placement = state.windowPlacements.find((item) => item.id === focus.windowId)
  const workspace = state.workspaces.find((item) => item.id === focus.workspaceId)
  return Boolean(
    placement?.workspaceIds.includes(focus.workspaceId) &&
    workspace?.panes[focus.paneId]?.tabs.includes(focus.tabId)
  )
}

/** Moves one live terminal or browser identity into an exact durable destination. */
export function moveExactTab(
  state: DurableApplicationState,
  input: Request,
  now: number
): DurableApplicationState {
  const request = tabMoveExactParamsSchema.parse(input)
  const sourceWindow = state.windowPlacements.find((item) => item.id === request.source.windowId)
  const targetWindow = state.windowPlacements.find((item) => item.id === request.target.windowId)
  if (!sourceWindow)
    throw new WindowMutationError('source_not_found', 'Source window is unavailable')
  if (!targetWindow)
    throw new WindowMutationError('target_not_found', 'Target window is unavailable')
  if (
    sourceWindow.revision !== request.source.expectedWindowRevision ||
    targetWindow.revision !== request.target.expectedWindowRevision
  ) {
    throw new WindowMutationError('stale_window_revision', 'Window placement changed')
  }
  if (!sourceWindow.workspaceIds.includes(request.source.workspaceId))
    throw new WindowMutationError('source_not_found', 'Source workspace is not in its window')
  if (
    !targetWindow.workspaceIds.includes(request.target.workspaceId) ||
    targetWindow.hostingState !== 'hosted'
  ) {
    throw new WindowMutationError('target_not_found', 'Target workspace is not hosted')
  }
  const original = state.workspaces.find((item) => item.id === request.source.workspaceId)
  const destination = state.workspaces.find((item) => item.id === request.target.workspaceId)
  const originalTab = original?.tabs[request.source.tabId]
  const originalPane = original?.panes[request.source.paneId]
  const destinationPane = destination?.panes[request.target.paneId]
  if (
    !originalTab ||
    originalTab.paneId !== request.source.paneId ||
    !originalPane?.tabs.includes(originalTab.id)
  ) {
    throw new WindowMutationError('source_not_found', 'Source tab is unavailable')
  }
  if (!destination || !destinationPane)
    throw new WindowMutationError('target_not_found', 'Target pane is unavailable')
  if (
    originalTab.content.kind !== 'terminal' &&
    (originalTab.content.kind !== 'browser' || !originalTab.content.metadata.browserSessionId)
  )
    throw new WindowMutationError('policy_denied', 'Tab has no transferable runtime identity')
  if (request.target.destinationIndex > destinationPane.tabs.length)
    throw new WindowMutationError('target_not_found', 'Target index is outside the pane')
  if (original !== destination && Object.keys(original!.tabs).length === 1)
    throw new WindowMutationError('policy_denied', 'The source workspace needs a terminal')
  if (state.legacyOverLimit || !Number.isSafeInteger(now) || now < 0)
    throw new WindowMutationError('policy_denied', 'Tab move is unavailable in this state')
  if (
    state.revision >= Number.MAX_SAFE_INTEGER ||
    sourceWindow.revision >= Number.MAX_SAFE_INTEGER ||
    targetWindow.revision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new WindowMutationError('resource_limit', 'Revision cannot advance')
  }
  if (original !== destination && Object.keys(destination.tabs).length >= 128)
    throw new WindowMutationError('resource_limit', 'Target workspace is full')

  const next = structuredClone(state)
  const from = next.workspaces.find((item) => item.id === request.source.workspaceId)!
  const to = next.workspaces.find((item) => item.id === request.target.workspaceId)!
  const sourcePane = from.panes[request.source.paneId]!
  const targetPane = to.panes[request.target.paneId]!
  const sourceIndex = sourcePane.tabs.indexOf(request.source.tabId)
  let insertionIndex = request.target.destinationIndex
  if (sourcePane === targetPane && sourceIndex < insertionIndex) insertionIndex -= 1
  if (sourcePane === targetPane && sourceIndex === insertionIndex)
    throw new WindowMutationError('policy_denied', 'Tab is already at the target index')

  sourcePane.tabs.splice(sourceIndex, 1)
  if (sourcePane !== targetPane) {
    if (sourcePane.tabs.length === 0) {
      const collapsed = collapsePane(from.layout as Layout, sourcePane.id)
      if (!collapsed)
        throw new WindowMutationError('policy_denied', 'Source workspace cannot become empty')
      from.layout = collapsed
      delete from.panes[sourcePane.id]
      if (from.selectedPaneId === sourcePane.id) {
        from.selectedPaneId = Object.keys(from.panes)[0]!
      }
    } else if (sourcePane.selectedTabId === request.source.tabId) {
      sourcePane.selectedTabId = sourcePane.tabs[Math.min(sourceIndex, sourcePane.tabs.length - 1)]!
    }
    if (from !== to) {
      const moved = from.tabs[request.source.tabId]!
      delete from.tabs[request.source.tabId]
      to.tabs[request.source.tabId] = { ...moved, paneId: targetPane.id }
    } else {
      from.tabs[request.source.tabId]!.paneId = targetPane.id
    }
  }
  targetPane.tabs.splice(insertionIndex, 0, request.source.tabId)
  targetPane.selectedTabId = request.source.tabId
  to.selectedPaneId = targetPane.id
  from.updatedAt = now
  to.updatedAt = now
  const targetPlacement = next.windowPlacements.find((item) => item.id === targetWindow.id)!
  const sourcePlacement = next.windowPlacements.find((item) => item.id === sourceWindow.id)!
  sourcePlacement.revision += 1
  if (sourcePlacement !== targetPlacement) targetPlacement.revision += 1
  targetPlacement.focusedWorkspaceId = to.id
  next.focusedWindowId = targetPlacement.id
  next.selectedWorkspaceId = to.id
  next.workspaceSelection = [to.id]
  const history = next.focusHistory
  const retained = history.entries
    .slice(0, history.cursor + 1)
    .filter((entry) => validFocus(next, entry)).length
  history.entries = history.entries.filter((entry) => validFocus(next, entry))
  history.cursor = Math.min(Math.max(0, retained - 1), Math.max(0, history.entries.length - 1))
  const focus: FocusTarget = {
    windowId: targetPlacement.id,
    workspaceId: to.id,
    paneId: targetPane.id,
    tabId: request.source.tabId
  }
  history.entries = history.entries.slice(0, history.cursor + 1)
  const last = history.entries.at(-1)
  if (
    !last ||
    last.windowId !== focus.windowId ||
    last.workspaceId !== focus.workspaceId ||
    last.paneId !== focus.paneId ||
    last.tabId !== focus.tabId
  ) {
    history.entries.push(focus)
  }
  if (history.entries.length > 128) history.entries.shift()
  history.cursor = history.entries.length - 1
  next.revision += 1
  return durableApplicationStateSchema.parse(next)
}
