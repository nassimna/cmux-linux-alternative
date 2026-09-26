import {
  applicationSnapshotSchema,
  paneTreeNodeSchema,
  type ApplicationSnapshot,
  type DurableApplicationState
} from '@agent-workspace/contracts'

type Notification = DurableApplicationState['notifications'][number]
type AttentionSummary = ApplicationSnapshot['attention']
type AttentionExcerpt = NonNullable<AttentionSummary['latestUnread']>
type PaneTree = ApplicationSnapshot['workspaces'][number]['layout']

const DEFAULT_SHORTCUT_COMMAND_IDS = [
  'workspace.new',
  'terminal.new',
  'tab.close',
  'pane.splitRight',
  'pane.splitDown',
  'sidebar.toggle',
  'commandPalette.toggle',
  'terminal.search',
  'browser.openSplit',
  'notifications.toggle',
  'notifications.latestUnread',
  'settings.open'
] as const

const severity = { info: 0, warning: 1, error: 2 } as const

function emptyAttention(): AttentionSummary {
  return { unreadCount: 0, highestLevel: null, latestUnread: null }
}

function include(summary: AttentionSummary, notification: Notification): void {
  summary.unreadCount += 1
  if (
    summary.highestLevel === null ||
    severity[notification.level] > severity[summary.highestLevel]
  ) {
    summary.highestLevel = notification.level
  }
  const latest = summary.latestUnread
  if (
    latest === null ||
    notification.createdAt > latest.createdAt ||
    (notification.createdAt === latest.createdAt && notification.id > latest.notificationId)
  ) {
    const excerpt: AttentionExcerpt = {
      notificationId: notification.id,
      title: notification.title,
      bodyExcerpt:
        notification.body === null ? null : [...notification.body].slice(0, 160).join(''),
      source: notification.source,
      createdAt: notification.createdAt
    }
    summary.latestUnread = excerpt
  }
}

function includeFor(
  summaries: Map<string, AttentionSummary>,
  id: string,
  notification: Notification
): void {
  let summary = summaries.get(id)
  if (!summary) {
    summary = emptyAttention()
    summaries.set(id, summary)
  }
  include(summary, notification)
}

function paneOrder(layout: PaneTree): string[] {
  if (layout.kind === 'leaf') return [layout.paneId]
  return [...paneOrder(layout.first), ...paneOrder(layout.second)]
}

/** Project durable Rust state into the exact renderer and CLI workspace snapshot shape. */
export function projectApplicationSnapshot(
  state: DurableApplicationState,
  sessionForTab?: (tabId: string) => string | undefined
): ApplicationSnapshot {
  const applicationAttention = emptyAttention()
  const workspaceAttention = new Map<string, AttentionSummary>()
  const paneAttention = new Map<string, AttentionSummary>()
  const tabAttention = new Map<string, AttentionSummary>()
  const tabOwners = new Map<string, { workspaceId: string; paneId: string }>()
  for (const workspace of state.workspaces) {
    for (const tab of Object.values(workspace.tabs)) {
      tabOwners.set(tab.id, { workspaceId: workspace.id, paneId: tab.paneId })
    }
  }
  for (const notification of state.notifications) {
    if (notification.readAt !== null) continue
    include(applicationAttention, notification)
    if (notification.tabId !== null) {
      const owner = tabOwners.get(notification.tabId)
      if (!owner) continue
      includeFor(workspaceAttention, owner.workspaceId, notification)
      includeFor(paneAttention, owner.paneId, notification)
      includeFor(tabAttention, notification.tabId, notification)
      continue
    }
    const workspace = state.workspaces.find((item) => item.id === notification.workspaceId)
    if (!workspace) continue
    if (notification.paneId !== null) {
      if (!workspace.panes[notification.paneId]) continue
      includeFor(paneAttention, notification.paneId, notification)
    }
    includeFor(workspaceAttention, workspace.id, notification)
  }

  const workspaces = state.workspaces.map((workspace) => {
    const layout = paneTreeNodeSchema.parse(workspace.layout)
    const orderedPanes = paneOrder(layout)
    const panes = orderedPanes.map((paneId) => {
      const pane = workspace.panes[paneId]!
      return {
        id: pane.id,
        tabIds: pane.tabs,
        selectedTabId: pane.selectedTabId,
        title: pane.title,
        attention: paneAttention.get(pane.id) ?? emptyAttention()
      }
    })
    const tabs = orderedPanes.flatMap((paneId) =>
      workspace.panes[paneId]!.tabs.map((tabId) => {
        const tab = workspace.tabs[tabId]!
        const runtimeSessionId =
          tab.content.kind === 'terminal' ? sessionForTab?.(tab.id) : undefined
        const content =
          tab.content.kind === 'terminal'
            ? {
                kind: 'terminal' as const,
                launch: tab.content.launch,
                ...(runtimeSessionId ? { runtimeSessionId } : {})
              }
            : {
                kind: 'browser' as const,
                state: {
                  browserSessionId: tab.content.metadata.browserSessionId,
                  url: tab.content.metadata.url,
                  navigationTitle: tab.content.metadata.navigationTitle ?? '',
                  canBack: tab.content.metadata.canBack ?? false,
                  canForward: tab.content.metadata.canForward ?? false,
                  loading: tab.content.metadata.loading ?? false,
                  devToolsOpen: tab.content.metadata.devToolsOpen ?? false,
                  profilePartition:
                    tab.content.metadata.profilePartition ?? 'persist:agent-workspace-default',
                  stateRevision: tab.content.metadata.stateRevision ?? 0,
                  correlationId: tab.content.metadata.correlationId ?? null
                }
              }
        return {
          id: tab.id,
          paneId: tab.paneId,
          title: tab.title,
          customTitle: tab.customTitle,
          content,
          attention: tabAttention.get(tab.id) ?? emptyAttention(),
          createdAt: tab.createdAt
        }
      })
    )
    return {
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      color: workspace.color,
      workingDirectory: workspace.workingDirectory,
      layout,
      selectedPaneId: workspace.selectedPaneId,
      panes,
      tabs,
      attention: workspaceAttention.get(workspace.id) ?? emptyAttention(),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt
    }
  })
  const shortcutOverrides = DEFAULT_SHORTCUT_COMMAND_IDS.flatMap((commandId) => {
    const shortcut = state.shortcutOverrides[commandId]
    return shortcut === undefined ? [] : [{ commandId, shortcut }]
  })
  return applicationSnapshotSchema.parse({
    revision: state.revision,
    workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    shortcutOverrides,
    attention: applicationAttention
  })
}
