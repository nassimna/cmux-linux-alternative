import { randomUUID } from 'node:crypto'
import { durableApplicationStateSchema } from '@agent-workspace/contracts'
import { expect, it } from 'vitest'
import {
  closeWindowPlacement, closeWindowWorkspaces, createWindowPlacement,
  focusWindowPlacement, WindowMutationError
} from './window-mutations'
import { projectStateToWindow } from './window-projection'
import { projectApplicationSnapshot } from './application-projection'
import { projectOrganization } from './organization-mutations'
import { reopenClosedTab } from './recently-closed-mutations'

function fixture() {
  const windowId = randomUUID()
  const workspaces = [randomUUID(), randomUUID()]
  const panes = workspaces.map(() => randomUUID())
  const tabs = workspaces.map(() => randomUUID())
  const state = durableApplicationStateSchema.parse({
    revision: 1,
    workspaces: workspaces.map((id, index) => ({
      id, name: `Workspace ${index + 1}`, description: null, color: null,
      workingDirectory: '/tmp', layout: { kind: 'leaf', paneId: panes[index] },
      selectedPaneId: panes[index],
      panes: { [panes[index]!]: { id: panes[index], tabs: [tabs[index]],
        selectedTabId: tabs[index], title: null } },
      tabs: { [tabs[index]!]: { id: tabs[index], paneId: panes[index], title: 'Terminal',
        customTitle: null, content: { kind: 'terminal',
          launch: { cwd: '/tmp', rows: 24, cols: 80 } }, createdAt: 1 } },
      createdAt: 1, updatedAt: 1
    })),
    selectedWorkspaceId: workspaces[0], workspaceSelection: [workspaces[0]],
    workspacePins: [], workspaceGroups: [], workspaceGroupAssignments: {},
    savedLayouts: [], legacyOverLimit: null, shortcutOverrides: {},
    notifications: [], notificationSettings: { systemEnabled: true, includeBody: false },
    recentlyClosed: [],
    windowPlacements: [{ id: windowId, label: 'Main', workspaceIds: workspaces,
      focusedWorkspaceId: workspaces[0], hostingState: 'hosted', revision: 1 }],
    focusedWindowId: windowId, focusHistory: { entries: [], cursor: 0 }
  })
  return { state, windowId, workspaces }
}

it('moves one workspace, fences revisions, focuses only hosted windows, and rehomes on close', () => {
  const { state, windowId, workspaces } = fixture()
  const secondWindow = randomUUID()
  const created = createWindowPlacement(state, {
    sourceWindowId: windowId, sourceRevision: 1,
    workspaceId: workspaces[1]!, windowId: secondWindow, label: 'Second'
  })
  expect(created.windowPlacements).toHaveLength(2)
  expect(created.windowPlacements[0]).toMatchObject({
    workspaceIds: [workspaces[0]], revision: 2
  })
  expect(created.windowPlacements[1]).toMatchObject({
    workspaceIds: [workspaces[1]], hostingState: 'unhosted'
  })
  const scoped = projectStateToWindow(created, secondWindow)!
  expect(scoped.workspaces.map(({ id }) => id)).toEqual([workspaces[1]])
  expect(scoped.selectedWorkspaceId).toBe(workspaces[1])
  expect(projectApplicationSnapshot(scoped).workspaces.map(({ id }) => id))
    .toEqual([workspaces[1]])
  expect(projectOrganization(scoped).organization.selection).toEqual([workspaces[1]])
  expect(() => focusWindowPlacement(created, { windowId: secondWindow, expectedRevision: 0 }))
    .toThrow(WindowMutationError)
  const hosted = structuredClone(created)
  hosted.windowPlacements[1]!.hostingState = 'hosted'
  hosted.windowPlacements[1]!.revision = 1
  const focused = focusWindowPlacement(hosted, { windowId, expectedRevision: 2 })
  expect(focused.focusedWindowId).toBe(windowId)
  expect(focused.selectedWorkspaceId).toBe(workspaces[0])
  const secondaryRead = projectStateToWindow(focused, secondWindow)!
  expect(projectApplicationSnapshot(secondaryRead)).toMatchObject({
    selectedWorkspaceId: workspaces[1],
    workspaces: [{ id: workspaces[1] }]
  })
  expect(projectOrganization(secondaryRead).organization.focusedWorkspaceId).toBe(workspaces[1])
  expect(() => closeWindowPlacement(focused, {
    windowId: secondWindow, expectedRevision: 0,
    targetWindowId: windowId, targetRevision: 2
  })).toThrow(WindowMutationError)
  const closed = closeWindowPlacement(focused, {
    windowId: secondWindow, expectedRevision: 1,
    targetWindowId: windowId, targetRevision: 2
  })
  expect(closed.windowPlacements).toHaveLength(1)
  expect(closed.windowPlacements[0]).toMatchObject({
    workspaceIds: [workspaces[0], workspaces[1]], revision: 3
  })
  expect(closed.focusHistory.entries.every((entry) => entry.windowId === windowId)).toBe(true)
  expect(durableApplicationStateSchema.safeParse(closed).success).toBe(true)
})

it('atomically closes a nonfinal window with Rust-parity records and survivor focus', () => {
  const { state, windowId, workspaces } = fixture()
  const secondId = randomUUID()
  const moved = createWindowPlacement(state, {
    sourceWindowId: windowId, sourceRevision: 1,
    workspaceId: workspaces[1]!, windowId: secondId, label: 'Second'
  })
  const itemId = randomUUID()
  const closed = closeWindowWorkspaces(moved, {
    windowId: secondId, expectedRevision: 0, closedItemIds: [itemId], now: 2
  })
  expect(closed.revision).toBe(moved.revision + 1)
  expect(closed.windowPlacements.map((item) => item.id)).toEqual([windowId])
  expect(closed.workspaces.map((item) => item.id)).toEqual([workspaces[0]])
  expect(closed.focusedWindowId).toBe(windowId)
  expect(closed.recentlyClosed).toMatchObject([{
    id: itemId, priorWorkspaceId: workspaces[1], itemKind: 'tab',
    restore: { kind: 'terminal', authorized_root_id: workspaces[1] }
  }])
  // Rust records the removed workspace as the terminal authorization root.
  // Reopen must reject that stale root, even through a surviving window.
  const survivor = closed.workspaces[0]!
  const survivorPane = survivor.panes[survivor.selectedPaneId]!
  expect(() => reopenClosedTab(closed, itemId, {
    windowId, expectedWindowRevision: closed.windowPlacements[0]!.revision,
    workspaceId: survivor.id, paneId: survivorPane.id, destinationIndex: 0
  }, randomUUID(), randomUUID(), 3)).toThrowError('policy denied')
  expect(() => closeWindowWorkspaces(moved, {
    windowId: secondId, expectedRevision: 1, closedItemIds: [randomUUID()], now: 2
  })).toThrow(WindowMutationError)
  expect(() => closeWindowWorkspaces(state, {
    windowId, expectedRevision: 1, closedItemIds: [randomUUID(), randomUUID()], now: 2
  })).toThrow(WindowMutationError)
})
