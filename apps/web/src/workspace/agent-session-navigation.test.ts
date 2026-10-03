import { expect, it, vi } from 'vitest'

import type { ApplicationSnapshot } from '@agent-workspace/protocol-client'

import { navigateToAgentBinding } from './agent-session-navigation'

const binding = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  paneId: '00000000-0000-4000-8000-000000000002',
  tabId: '00000000-0000-4000-8000-000000000003',
  agentSessionId: '00000000-0000-4000-8000-000000000004'
}

it('reconciles a stale renderer and skips already-selected pane and tab mutations', async () => {
  const snapshot = {
    revision: 8,
    selectedWorkspaceId: binding.workspaceId,
    workspaces: [
      {
        id: binding.workspaceId,
        selectedPaneId: binding.paneId,
        panes: [{ id: binding.paneId, selectedTabId: binding.tabId }],
        tabs: [{ id: binding.tabId, paneId: binding.paneId }]
      }
    ]
  } as ApplicationSnapshot
  const selectWorkspace = vi.fn()
  const focusPane = vi.fn()
  const selectTab = vi.fn()
  const applyMutation = vi.fn()
  const waitUntilVisible = vi.fn().mockResolvedValue(true)
  await navigateToAgentBinding(binding, {
    loadSnapshot: async () => snapshot,
    selectWorkspace,
    focusPane,
    selectTab,
    applyMutation,
    waitUntilVisible
  })
  expect(selectWorkspace).not.toHaveBeenCalled()
  expect(focusPane).not.toHaveBeenCalled()
  expect(selectTab).not.toHaveBeenCalled()
  expect(applyMutation).toHaveBeenCalledWith({ revision: 8, snapshot })
  expect(waitUntilVisible).toHaveBeenCalledWith(binding)
})
