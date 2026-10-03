import { randomUUID } from 'node:crypto'
import { durableApplicationStateSchema } from '@agent-workspace/contracts'
import { expect, it } from 'vitest'

import { detachExactTab } from './advanced-tab-detach'

it('atomically detaches a final browser tab and replaces its source with a terminal', () => {
  const ids = {
    sourceWindow: randomUUID(),
    sourceWorkspace: randomUUID(),
    sourcePane: randomUUID(),
    tabId: randomUUID(),
    browserSessionId: randomUUID(),
    windowId: randomUUID(),
    workspaceId: randomUUID(),
    paneId: randomUUID(),
    replacementTabId: randomUUID()
  }
  const state = durableApplicationStateSchema.parse({
    revision: 4,
    workspaces: [
      {
        id: ids.sourceWorkspace,
        name: 'Source',
        description: null,
        color: null,
        workingDirectory: '/tmp',
        layout: { kind: 'leaf', paneId: ids.sourcePane },
        selectedPaneId: ids.sourcePane,
        panes: {
          [ids.sourcePane]: {
            id: ids.sourcePane,
            tabs: [ids.tabId],
            selectedTabId: ids.tabId,
            title: null
          }
        },
        tabs: {
          [ids.tabId]: {
            id: ids.tabId,
            paneId: ids.sourcePane,
            title: 'Browser',
            customTitle: null,
            content: {
              kind: 'browser',
              metadata: {
                browserSessionId: ids.browserSessionId,
                url: 'https://example.test'
              }
            },
            createdAt: 1
          }
        },
        createdAt: 1,
        updatedAt: 1
      }
    ],
    selectedWorkspaceId: ids.sourceWorkspace,
    workspaceSelection: [ids.sourceWorkspace],
    workspacePins: [],
    workspaceGroups: [],
    workspaceGroupAssignments: {},
    savedLayouts: [],
    legacyOverLimit: null,
    shortcutOverrides: {},
    notifications: [],
    notificationSettings: { systemEnabled: true, includeBody: false },
    recentlyClosed: [],
    windowPlacements: [
      {
        id: ids.sourceWindow,
        label: 'Source',
        workspaceIds: [ids.sourceWorkspace],
        focusedWorkspaceId: ids.sourceWorkspace,
        hostingState: 'hosted',
        revision: 2
      }
    ],
    focusedWindowId: ids.sourceWindow,
    focusHistory: {
      entries: [
        {
          windowId: ids.sourceWindow,
          workspaceId: ids.sourceWorkspace,
          paneId: ids.sourcePane,
          tabId: ids.tabId
        }
      ],
      cursor: 0
    }
  })
  const request = {
    mutation: { expectedRevision: 4, idempotencyEpoch: randomUUID(), idempotencyKey: randomUUID() },
    source: {
      windowId: ids.sourceWindow,
      workspaceId: ids.sourceWorkspace,
      paneId: ids.sourcePane,
      tabId: ids.tabId,
      expectedWindowRevision: 2
    },
    windowLabel: 'Detached browser'
  }
  const detached = detachExactTab(state, request, ids, 5)
  expect(detached.revision).toBe(5)
  expect(detached.workspaces[0]?.tabs[ids.tabId]).toBeUndefined()
  expect(detached.workspaces[0]?.tabs[ids.replacementTabId]?.content.kind).toBe('terminal')
  expect(detached.workspaces[1]?.tabs[ids.tabId]?.content).toEqual({
    kind: 'browser',
    metadata: {
      browserSessionId: ids.browserSessionId,
      url: 'https://example.test'
    }
  })
  expect(detached.workspaces[1]?.tabs[ids.tabId]?.paneId).toBe(ids.paneId)
  expect(detached.windowPlacements[0]?.revision).toBe(3)
  expect(detached.windowPlacements[1]).toMatchObject({
    id: ids.windowId,
    hostingState: 'unhosted',
    workspaceIds: [ids.workspaceId]
  })
  expect(detached.focusHistory.entries.at(-1)?.tabId).toBe(ids.tabId)
  expect(() =>
    detachExactTab(
      state,
      {
        ...request,
        source: { ...request.source, expectedWindowRevision: 1 }
      },
      ids,
      5
    )
  ).toThrow('Window placement changed')
  expect(state.workspaces).toHaveLength(1)

  const terminalState = structuredClone(state)
  terminalState.workspaces[0]!.tabs[ids.tabId]!.content = {
    kind: 'terminal',
    launch: { cwd: '/tmp', rows: 30, cols: 100 }
  }
  const detachedTerminal = detachExactTab(terminalState, request, ids, 5)
  expect(detachedTerminal.workspaces[1]?.tabs[ids.tabId]?.content).toEqual({
    kind: 'terminal',
    launch: { cwd: '/tmp', rows: 30, cols: 100 }
  })
})
