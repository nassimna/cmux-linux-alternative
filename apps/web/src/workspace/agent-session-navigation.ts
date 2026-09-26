import type {
  AgentSessionBinding,
  ApplicationSnapshot,
  MutationResult
} from '@agent-workspace/protocol-client'

interface AgentNavigationDependencies {
  loadSnapshot(): Promise<ApplicationSnapshot>
  selectWorkspace(params: { workspaceId: string }): Promise<MutationResult>
  focusPane(params: { workspaceId: string; paneId: string }): Promise<MutationResult>
  selectTab(params: { workspaceId: string; tabId: string }): Promise<MutationResult>
  applyMutation(result: MutationResult): void
  waitUntilVisible(target: { workspaceId: string; paneId: string; tabId: string }): Promise<boolean>
}

export async function navigateToAgentBinding(
  binding: AgentSessionBinding,
  dependencies: AgentNavigationDependencies
): Promise<void> {
  let snapshot = await dependencies.loadSnapshot()
  dependencies.applyMutation({ revision: snapshot.revision, snapshot })
  if (snapshot.selectedWorkspaceId !== binding.workspaceId) {
    const result = await dependencies.selectWorkspace({ workspaceId: binding.workspaceId })
    requireBinding(result, binding, 'workspace')
    dependencies.applyMutation(result)
    snapshot = result.snapshot
  }
  let workspace = snapshot.workspaces.find(({ id }) => id === binding.workspaceId)
  if (workspace?.selectedPaneId !== binding.paneId) {
    const paneResult = await dependencies.focusPane({
      workspaceId: binding.workspaceId,
      paneId: binding.paneId
    })
    requireBinding(paneResult, binding, 'pane')
    dependencies.applyMutation(paneResult)
    workspace = paneResult.snapshot.workspaces.find(({ id }) => id === binding.workspaceId)
  }
  if (workspace?.panes.find(({ id }) => id === binding.paneId)?.selectedTabId !== binding.tabId) {
    const tabResult = await dependencies.selectTab({
      workspaceId: binding.workspaceId,
      tabId: binding.tabId
    })
    requireBinding(tabResult, binding, 'tab')
    dependencies.applyMutation(tabResult)
  }
  if (!(await dependencies.waitUntilVisible(binding))) {
    throw new Error('Agent session target is not visible')
  }
}

function requireBinding(
  result: MutationResult,
  binding: AgentSessionBinding,
  stage: 'workspace' | 'pane' | 'tab'
): void {
  const workspace = result.snapshot.workspaces.find(({ id }) => id === binding.workspaceId)
  const pane = workspace?.panes.find(({ id }) => id === binding.paneId)
  const tab = workspace?.tabs.find(({ id }) => id === binding.tabId)
  if (
    !workspace ||
    !pane ||
    !tab ||
    tab.paneId !== binding.paneId ||
    (stage !== 'workspace' && workspace.selectedPaneId !== binding.paneId) ||
    (stage === 'tab' && pane.selectedTabId !== binding.tabId)
  ) {
    throw new Error('Agent session target changed during navigation')
  }
}
