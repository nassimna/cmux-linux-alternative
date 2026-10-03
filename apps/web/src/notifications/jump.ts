import type {
  ApplicationSnapshot,
  MutationResult,
  NotificationSnapshot
} from '@agent-workspace/protocol-client'

import { messages } from '../messages'

export interface NotificationJumpOperations {
  applyMutation(result: MutationResult): void
  focusPane(params: { workspaceId: string; paneId: string }): Promise<MutationResult>
  getSnapshot(): ApplicationSnapshot | null
  markRead(notificationId: string): Promise<void>
  selectTab(params: { workspaceId: string; tabId: string }): Promise<MutationResult>
  selectWorkspace(params: { workspaceId: string }): Promise<MutationResult>
  waitUntilVisible(target: ResolvedNotificationTarget): Promise<boolean>
}

export interface ResolvedNotificationTarget {
  paneId?: string
  tabId?: string
  workspaceId: string
}

export type NotificationJumpResult =
  { ok: true; target: ResolvedNotificationTarget } | { ok: false; message: string }

export function resolveNotificationTarget(
  notification: NotificationSnapshot,
  snapshot: ApplicationSnapshot | null
): NotificationJumpResult {
  const workspace = snapshot?.workspaces.find(({ id }) => id === notification.workspaceId)
  if (!workspace) return unavailable()

  if (notification.tabId) {
    const tab = workspace.tabs.find(({ id }) => id === notification.tabId)
    if (!tab || !workspace.panes.some(({ id }) => id === tab.paneId)) return unavailable()
    return {
      ok: true,
      target: { workspaceId: workspace.id, paneId: tab.paneId, tabId: tab.id }
    }
  }

  if (notification.paneId) {
    const pane = workspace.panes.find(({ id }) => id === notification.paneId)
    if (!pane) return unavailable()
    return { ok: true, target: { workspaceId: workspace.id, paneId: pane.id } }
  }

  return { ok: true, target: { workspaceId: workspace.id } }
}

export async function jumpToNotification(
  notification: NotificationSnapshot,
  operations: NotificationJumpOperations
): Promise<NotificationJumpResult> {
  try {
    const resolution = resolveNotificationTarget(notification, operations.getSnapshot())
    if (!resolution.ok) return resolution
    const { target } = resolution

    let snapshot = operations.getSnapshot()
    if (snapshot?.selectedWorkspaceId !== target.workspaceId) {
      const result = await operations.selectWorkspace({ workspaceId: target.workspaceId })
      operations.applyMutation(result)
      snapshot = result.snapshot
    }

    if (target.paneId) {
      const workspace = snapshot?.workspaces.find(({ id }) => id === target.workspaceId)
      if (!workspace) return unavailable()
      if (workspace.selectedPaneId !== target.paneId) {
        const result = await operations.focusPane({
          workspaceId: target.workspaceId,
          paneId: target.paneId
        })
        operations.applyMutation(result)
        snapshot = result.snapshot
      }
    }

    if (target.tabId && target.paneId) {
      const workspace = snapshot?.workspaces.find(({ id }) => id === target.workspaceId)
      const pane = workspace?.panes.find(({ id }) => id === target.paneId)
      if (!pane) return unavailable()
      if (pane.selectedTabId !== target.tabId) {
        const result = await operations.selectTab({
          workspaceId: target.workspaceId,
          tabId: target.tabId
        })
        operations.applyMutation(result)
      }
    }

    if (!(await operations.waitUntilVisible(target))) {
      return { ok: false, message: messages.notificationJump.notVisible }
    }
    if (notification.readAt === undefined) await operations.markRead(notification.id)
    return { ok: true, target }
  } catch {
    return { ok: false, message: messages.notificationJump.notOpened }
  }
}

export async function waitForVisibleTarget(
  target: ResolvedNotificationTarget,
  root: Document = document,
  attempts = 12
): Promise<boolean> {
  const selector = target.tabId
    ? `[data-tab-id="${selectorValue(target.tabId)}"][data-selected="true"]`
    : target.paneId
      ? `[data-pane-id="${selectorValue(target.paneId)}"][data-selected="true"]`
      : `[data-workspace-content-id="${selectorValue(target.workspaceId)}"][data-selected="true"]`

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const element = root.querySelector<HTMLElement>(selector)
    if (element && isVisible(element, root)) {
      element.focus({ preventScroll: true })
      const activeElement = root.activeElement
      if (
        activeElement === element ||
        (activeElement !== null && element.contains(activeElement))
      ) {
        return true
      }
    }
    await nextFrame()
  }
  return false
}

function isVisible(element: HTMLElement, root: Document): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  const style = root.defaultView?.getComputedStyle(element)
  return style?.display !== 'none' && style?.visibility !== 'hidden'
}

function unavailable(): NotificationJumpResult {
  return { ok: false, message: messages.notificationJump.targetUnavailable }
}

function selectorValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}
