import { randomUUID } from 'node:crypto'
import { durableApplicationStateSchema } from '@agent-workspace/contracts'
import { expect, it } from 'vitest'

import { moveExactTab } from './advanced-tab-move'

it('moves a live tab identity across windows while keeping a valid source workspace', () => {
  const sourceWindow = randomUUID()
  const targetWindow = randomUUID()
  const sourceWorkspace = randomUUID()
  const targetWorkspace = randomUUID()
  const sourcePane = randomUUID()
  const targetPane = randomUUID()
  const movedTab = randomUUID()
  const remainingTab = randomUUID()
  const targetTab = randomUUID()
  const terminal = (id: string, paneId: string) => ({
    id,
    paneId,
    title: 'Terminal',
    customTitle: null,
    content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } },
    createdAt: 1
  })
  const state = durableApplicationStateSchema.parse({
    revision: 4,
    workspaces: [
      {
        id: sourceWorkspace,
        name: 'Source',
        description: null,
        color: null,
        workingDirectory: '/tmp',
        layout: { kind: 'leaf', paneId: sourcePane },
        selectedPaneId: sourcePane,
        panes: {
          [sourcePane]: {
            id: sourcePane,
            tabs: [movedTab, remainingTab],
            selectedTabId: movedTab,
            title: null
          }
        },
        tabs: {
          [movedTab]: terminal(movedTab, sourcePane),
          [remainingTab]: terminal(remainingTab, sourcePane)
        },
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: targetWorkspace,
        name: 'Target',
        description: null,
        color: null,
        workingDirectory: '/tmp',
        layout: { kind: 'leaf', paneId: targetPane },
        selectedPaneId: targetPane,
        panes: {
          [targetPane]: {
            id: targetPane,
            tabs: [targetTab],
            selectedTabId: targetTab,
            title: null
          }
        },
        tabs: { [targetTab]: terminal(targetTab, targetPane) },
        createdAt: 1,
        updatedAt: 1
      }
    ],
    selectedWorkspaceId: sourceWorkspace,
    workspaceSelection: [sourceWorkspace],
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
        id: sourceWindow,
        label: 'Source',
        workspaceIds: [sourceWorkspace],
        focusedWorkspaceId: sourceWorkspace,
        hostingState: 'hosted',
        revision: 2
      },
      {
        id: targetWindow,
        label: 'Target',
        workspaceIds: [targetWorkspace],
        focusedWorkspaceId: targetWorkspace,
        hostingState: 'hosted',
        revision: 3
      }
    ],
    focusedWindowId: sourceWindow,
    focusHistory: {
      entries: [
        {
          windowId: sourceWindow,
          workspaceId: sourceWorkspace,
          paneId: sourcePane,
          tabId: movedTab
        }
      ],
      cursor: 0
    }
  })
  const request = {
    mutation: { expectedRevision: 4, idempotencyEpoch: randomUUID(), idempotencyKey: randomUUID() },
    source: {
      windowId: sourceWindow,
      workspaceId: sourceWorkspace,
      paneId: sourcePane,
      tabId: movedTab,
      expectedWindowRevision: 2
    },
    target: {
      windowId: targetWindow,
      workspaceId: targetWorkspace,
      paneId: targetPane,
      destinationIndex: 1,
      expectedWindowRevision: 3
    }
  }
  const moved = moveExactTab(state, request, 5)
  expect(moved.workspaces[0]?.panes[sourcePane]?.tabs).toEqual([remainingTab])
  expect(moved.workspaces[1]?.panes[targetPane]?.tabs).toEqual([targetTab, movedTab])
  expect(moved.workspaces[1]?.tabs[movedTab]?.paneId).toBe(targetPane)
  expect(moved.workspaces[0]?.tabs[movedTab]).toBeUndefined()
  expect(moved.windowPlacements.map(({ revision }) => revision)).toEqual([3, 4])
  expect(moved.selectedWorkspaceId).toBe(targetWorkspace)
  expect(moved.focusHistory.entries.at(-1)).toMatchObject({
    tabId: movedTab,
    windowId: targetWindow
  })
  expect(durableApplicationStateSchema.safeParse(moved).success).toBe(true)
  expect(() =>
    moveExactTab(state, { ...request, source: { ...request.source, expectedWindowRevision: 1 } }, 5)
  ).toThrow('Window placement changed')

  const browserSessionId = randomUUID()
  const browserState = structuredClone(state)
  browserState.workspaces[0]!.tabs[movedTab]!.content = {
    kind: 'browser',
    metadata: {
      browserSessionId,
      url: 'https://example.test',
      profilePartition: 'persist:agent-workspace-default',
      stateRevision: 7
    }
  }
  const movedBrowser = moveExactTab(browserState, request, 5)
  expect(movedBrowser.workspaces[0]?.tabs[movedTab]).toBeUndefined()
  expect(movedBrowser.workspaces[1]?.tabs[movedTab]?.content).toEqual({
    kind: 'browser',
    metadata: {
      browserSessionId,
      url: 'https://example.test',
      profilePartition: 'persist:agent-workspace-default',
      stateRevision: 7
    }
  })
  delete browserState.workspaces[0]!.tabs[movedTab]!.content.metadata.browserSessionId
  expect(() => moveExactTab(browserState, request, 5)).toThrow(
    'Tab has no transferable runtime identity'
  )
})
