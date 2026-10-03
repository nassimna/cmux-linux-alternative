import {
  durableApplicationStateSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'
import { tabDuplicateParamsSchema } from '@agent-workspace/protocol-client'
import type { z } from 'zod'

import { openBrowserTab, openTerminalTab } from './workspace-mutations'
import { WindowMutationError } from './window-mutations'

type Request = z.infer<typeof tabDuplicateParamsSchema>

/** Duplicate content into an exact window placement with fresh runtime identities. */
export function duplicateTabExact(
  state: DurableApplicationState,
  request: Request,
  ids: { tabId: string; browserSessionId: string },
  now: number
): DurableApplicationState {
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
  )
    throw new WindowMutationError(
      'target_not_found',
      'Target workspace is not hosted in its window'
    )
  const source = state.workspaces.find((item) => item.id === request.source.workspaceId)
  const target = state.workspaces.find((item) => item.id === request.target.workspaceId)
  const tab = source?.tabs[request.source.tabId]
  if (
    !tab ||
    tab.paneId !== request.source.paneId ||
    !source?.panes[request.source.paneId]?.tabs.includes(tab.id)
  )
    throw new WindowMutationError('source_not_found', 'Source tab is unavailable')
  if (!target?.panes[request.target.paneId])
    throw new WindowMutationError('target_not_found', 'Target pane is unavailable')
  const destination = {
    workspaceId: target.id,
    paneId: request.target.paneId,
    destinationIndex: request.target.destinationIndex
  }
  const next =
    tab.content.kind === 'terminal'
      ? openTerminalTab(state, { ...destination, launch: tab.content.launch }, ids.tabId, now)
      : openBrowserTab(
          state,
          {
            ...destination,
            metadata: { url: tab.content.metadata.url },
            profilePartition: tab.content.metadata.profilePartition
          },
          ids.tabId,
          ids.browserSessionId,
          now
        )
  const cloned = next.workspaces.find((item) => item.id === target.id)!.tabs[ids.tabId]!
  cloned.title = tab.title
  cloned.customTitle = tab.customTitle
  for (const placement of next.windowPlacements) {
    if (placement.id === request.target.windowId) {
      if (placement.revision >= Number.MAX_SAFE_INTEGER)
        throw new WindowMutationError('resource_limit', 'Window revision exhausted')
      placement.revision += 1
    }
  }
  return durableApplicationStateSchema.parse(next)
}
