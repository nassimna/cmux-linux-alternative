import { randomUUID } from 'node:crypto'
import { durableApplicationStateSchema } from '@agent-workspace/contracts'
import { expect, it } from 'vitest'

import { navigateFocusHistory } from './focus-history-mutations'
import { WindowMutationError } from './window-mutations'

it('moves backward and forward through durable focus without adding entries', () => {
  const windowId = randomUUID()
  const workspaceIds = [randomUUID(), randomUUID()]
  const paneIds = [randomUUID(), randomUUID()]
  const tabIds = [randomUUID(), randomUUID()]
  const targets = workspaceIds.map((workspaceId, index) => ({
    windowId,
    workspaceId,
    paneId: paneIds[index]!,
    tabId: tabIds[index]!
  }))
  const state = durableApplicationStateSchema.parse({
    revision: 3,
    workspaces: workspaceIds.map((id, index) => ({
      id,
      name: `Workspace ${index + 1}`,
      description: null,
      color: null,
      workingDirectory: '/tmp',
      layout: { kind: 'leaf', paneId: paneIds[index] },
      selectedPaneId: paneIds[index],
      panes: {
        [paneIds[index]!]: {
          id: paneIds[index],
          tabs: [tabIds[index]],
          selectedTabId: tabIds[index],
          title: null
        }
      },
      tabs: {
        [tabIds[index]!]: {
          id: tabIds[index],
          paneId: paneIds[index],
          title: 'Terminal',
          customTitle: null,
          content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } },
          createdAt: 1
        }
      },
      createdAt: 1,
      updatedAt: 1
    })),
    selectedWorkspaceId: workspaceIds[1],
    workspaceSelection: [workspaceIds[1]],
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
        id: windowId,
        label: 'Main',
        workspaceIds,
        focusedWorkspaceId: workspaceIds[1],
        hostingState: 'hosted',
        revision: 2
      }
    ],
    focusedWindowId: windowId,
    focusHistory: { entries: targets, cursor: 1 }
  })
  const back = navigateFocusHistory(state, 'back')
  expect(back.target).toEqual(targets[0])
  expect(back.state).toMatchObject({
    revision: 4,
    selectedWorkspaceId: workspaceIds[0],
    focusHistory: { entries: targets, cursor: 0 }
  })
  expect(() => navigateFocusHistory(back.state, 'back')).toThrow(WindowMutationError)
  const forward = navigateFocusHistory(back.state, 'forward')
  expect(forward.target).toEqual(targets[1])
  expect(forward.state.revision).toBe(5)
  expect(forward.state.focusHistory.entries).toEqual(targets)
})
