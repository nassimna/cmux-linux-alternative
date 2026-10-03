// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import type {
  ApplicationSnapshot,
  MutationResult,
  NotificationSnapshot
} from '@agent-workspace/protocol-client'

import { jumpToNotification, resolveNotificationTarget, waitForVisibleTarget } from './jump'

const emptyAttention = { unreadCount: 0, highestLevel: null, latestUnread: null }

function snapshot(selectedWorkspaceId = 'workspace-a'): ApplicationSnapshot {
  return {
    revision: 1,
    selectedWorkspaceId,
    shortcutOverrides: [],
    attention: emptyAttention,
    workspaces: [
      {
        id: 'workspace-a',
        name: 'Workspace',
        description: null,
        color: null,
        workingDirectory: '/tmp',
        layout: { kind: 'leaf', paneId: 'pane-new' },
        selectedPaneId: 'pane-old',
        panes: [
          { id: 'pane-old', tabIds: [], selectedTabId: '', title: null, attention: emptyAttention },
          {
            id: 'pane-new',
            tabIds: ['tab-a'],
            selectedTabId: 'other-tab',
            title: null,
            attention: emptyAttention
          }
        ],
        tabs: [
          {
            id: 'tab-a',
            paneId: 'pane-new',
            title: 'Agent',
            customTitle: null,
            content: {
              kind: 'browser',
              state: {
                browserSessionId: 'browser-session-a',
                url: 'https://example.com/',
                navigationTitle: 'Agent',
                canBack: false,
                canForward: false,
                loading: false,
                devToolsOpen: false,
                profilePartition: 'persist:workspace-a',
                stateRevision: 0,
                correlationId: null
              }
            },
            attention: emptyAttention,
            createdAt: 1
          }
        ],
        attention: emptyAttention,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
}

function notification(overrides: Partial<NotificationSnapshot> = {}): NotificationSnapshot {
  return {
    id: 'notification-a',
    workspaceId: 'workspace-a',
    paneId: 'pane-old',
    tabId: 'tab-a',
    source: 'cli',
    level: 'warning',
    title: 'Needs attention',
    createdAt: 2,
    ...overrides
  }
}

function result(value: ApplicationSnapshot): MutationResult {
  return { revision: value.revision, snapshot: value }
}

describe('notification jump', () => {
  it('resolves a moved tab through its current pane', () => {
    expect(resolveNotificationTarget(notification(), snapshot())).toEqual({
      ok: true,
      target: { workspaceId: 'workspace-a', paneId: 'pane-new', tabId: 'tab-a' }
    })
  })

  it('focuses the current pane, selects the tab, waits for visibility, then marks read', async () => {
    let current = snapshot()
    const order: string[] = []
    const focused = structuredClone(current)
    focused.revision = 2
    focused.workspaces[0]!.selectedPaneId = 'pane-new'
    const selected = structuredClone(focused)
    selected.revision = 3
    selected.workspaces[0]!.panes[1]!.selectedTabId = 'tab-a'

    const response = await jumpToNotification(notification(), {
      getSnapshot: () => current,
      applyMutation: (mutation) => {
        current = mutation.snapshot
      },
      selectWorkspace: vi.fn(),
      focusPane: () => {
        order.push('focus')
        return Promise.resolve(result(focused))
      },
      selectTab: () => {
        order.push('select')
        return Promise.resolve(result(selected))
      },
      waitUntilVisible: () => {
        order.push('visible')
        return Promise.resolve(true)
      },
      markRead: () => {
        order.push('read')
        return Promise.resolve()
      }
    })

    expect(response.ok).toBe(true)
    expect(order).toEqual(['focus', 'select', 'visible', 'read'])
  })

  it('keeps stale and invisible targets unread', async () => {
    const markRead = vi.fn()
    const stale = await jumpToNotification(notification({ tabId: 'missing' }), {
      getSnapshot: () => snapshot(),
      applyMutation: vi.fn(),
      selectWorkspace: vi.fn(),
      focusPane: vi.fn(),
      selectTab: vi.fn(),
      waitUntilVisible: vi.fn(),
      markRead
    })
    expect(stale).toEqual({
      ok: false,
      message: 'This notification target is no longer available.'
    })
    expect(markRead).not.toHaveBeenCalled()

    const invisible = await jumpToNotification(notification(), {
      getSnapshot: () => snapshot(),
      applyMutation: vi.fn(),
      selectWorkspace: vi.fn(),
      focusPane: () => Promise.resolve(result(snapshot())),
      selectTab: () => Promise.resolve(result(snapshot())),
      waitUntilVisible: () => Promise.resolve(false),
      markRead
    })
    expect(invisible.ok).toBe(false)
    expect(invisible).toEqual({
      ok: false,
      message: 'The notification target could not be made visible.'
    })
    expect(markRead).not.toHaveBeenCalled()
  })

  it('returns the open failure when navigation throws and keeps the target unread', async () => {
    const markRead = vi.fn()

    const response = await jumpToNotification(notification(), {
      getSnapshot: () => snapshot(),
      applyMutation: vi.fn(),
      selectWorkspace: vi.fn(),
      focusPane: () => Promise.reject(new Error('focus failed')),
      selectTab: vi.fn(),
      waitUntilVisible: vi.fn(),
      markRead
    })

    expect(response).toEqual({
      ok: false,
      message: 'The notification target could not be opened.'
    })
    expect(markRead).not.toHaveBeenCalled()
  })

  it('finds a workspace-only target through persistent content when the sidebar is absent', async () => {
    document.body.innerHTML = `
      <main>
        <section
          data-selected="true"
          data-workspace-content-id="workspace-a"
          tabindex="-1"
        ></section>
      </main>
    `

    const target = document.querySelector<HTMLElement>('[data-workspace-content-id="workspace-a"]')
    expect(document.querySelector('[data-workspace-id]')).toBeNull()
    await expect(waitForVisibleTarget({ workspaceId: 'workspace-a' }, document, 1)).resolves.toBe(
      true
    )
    expect(document.activeElement).toBe(target)
  })

  it('only resolves a pane-only target after focus moves inside the selected pane', async () => {
    document.body.innerHTML = `
      <button type="button">Outside pane</button>
      <section data-pane-id="pane-old" data-selected="true">
        <button type="button">Pane control</button>
      </section>
    `

    const outside = document.querySelector<HTMLElement>('button')
    const pane = document.querySelector<HTMLElement>('[data-pane-id="pane-old"]')
    outside?.focus()

    await expect(
      waitForVisibleTarget({ workspaceId: 'workspace-a', paneId: 'pane-old' }, document, 1)
    ).resolves.toBe(false)
    expect(document.activeElement).toBe(outside)

    pane?.setAttribute('tabindex', '-1')
    await expect(
      waitForVisibleTarget({ workspaceId: 'workspace-a', paneId: 'pane-old' }, document, 1)
    ).resolves.toBe(true)
    expect(document.activeElement).toBe(pane)
  })
})
