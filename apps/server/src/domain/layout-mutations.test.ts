import { randomUUID } from 'node:crypto'

import { durableApplicationStateSchema } from '@agent-workspace/contracts'
import { expect, it } from 'vitest'

import {
  assertLayoutBindingsPreserved,
  planLayoutApplication,
  saveLayout
} from './layout-mutations'

function fixture() {
  const windowId = randomUUID()
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const tabId = randomUUID()
  const layoutId = randomUUID()
  const state = durableApplicationStateSchema.parse({
    revision: 1,
    workspaces: [
      {
        id: workspaceId,
        name: 'Workspace',
        description: null,
        color: null,
        workingDirectory: '/tmp',
        layout: { kind: 'leaf', paneId },
        selectedPaneId: paneId,
        panes: { [paneId]: { id: paneId, tabs: [tabId], selectedTabId: tabId, title: null } },
        tabs: {
          [tabId]: {
            id: tabId,
            paneId,
            title: 'Terminal',
            customTitle: null,
            content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } },
            createdAt: 1
          }
        },
        createdAt: 1,
        updatedAt: 1
      }
    ],
    selectedWorkspaceId: workspaceId,
    workspaceSelection: [workspaceId],
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
        workspaceIds: [workspaceId],
        focusedWorkspaceId: workspaceId,
        hostingState: 'hosted',
        revision: 1
      }
    ],
    focusedWindowId: windowId,
    focusHistory: { entries: [], cursor: 0 }
  })
  const saved = saveLayout(state, layoutId, 'Fresh workspace', [workspaceId], 2)
  const freshWorkspaceId = randomUUID()
  saved.savedLayouts[0]!.template.workspaces[0]!.id = freshWorkspaceId
  return { state: saved, windowId, layoutId, freshWorkspaceId }
}

it('refuses an imported layout that would remove a workspace needed by copy resume', () => {
  const { state, windowId, layoutId, freshWorkspaceId } = fixture()
  expect(state.workspaces[0]!.id).not.toBe(freshWorkspaceId)
  expect(() => planLayoutApplication(state, layoutId, randomUUID, windowId)).toThrow(
    'Saved layout would remove a workspace required by the copy'
  )
})

it('retains the hosted caller window when the layout preserves workspace identities', () => {
  const { state, windowId, layoutId } = fixture()
  state.savedLayouts[0]!.template.workspaces[0]!.id = state.workspaces[0]!.id
  const applied = planLayoutApplication(state, layoutId, randomUUID, windowId)
  expect(applied.windowPlacements[0]).toMatchObject({
    id: windowId,
    workspaceIds: [state.workspaces[0]!.id],
    hostingState: 'hosted'
  })
  expect(durableApplicationStateSchema.safeParse(applied).success).toBe(true)
})

it.each(['hosted', 'unhosted'] as const)(
  'refuses layout apply when another %s window would disappear',
  (hostingState) => {
    const { state, windowId, layoutId } = fixture()
    const otherWindowId = randomUUID()
    const secondWorkspace = structuredClone(state.workspaces[0]!)
    const secondWorkspaceId = randomUUID()
    const secondPaneId = randomUUID()
    const secondTabId = randomUUID()
    const originalPane = secondWorkspace.panes[secondWorkspace.selectedPaneId]!
    const originalTab = secondWorkspace.tabs[originalPane.selectedTabId]!
    secondWorkspace.id = secondWorkspaceId
    secondWorkspace.layout = { kind: 'leaf', paneId: secondPaneId }
    secondWorkspace.selectedPaneId = secondPaneId
    secondWorkspace.panes = {
      [secondPaneId]: {
        ...originalPane,
        id: secondPaneId,
        tabs: [secondTabId],
        selectedTabId: secondTabId
      }
    }
    secondWorkspace.tabs = {
      [secondTabId]: { ...originalTab, id: secondTabId, paneId: secondPaneId }
    }
    state.workspaces.push(secondWorkspace)
    state.windowPlacements.push({
      id: otherWindowId,
      label: 'Second',
      workspaceIds: [secondWorkspaceId],
      focusedWorkspaceId: secondWorkspaceId,
      hostingState,
      revision: 1
    })
    expect(durableApplicationStateSchema.safeParse(state).success).toBe(true)
    const withFullLayout = saveLayout(
      state,
      layoutId,
      'Both workspaces',
      [secondWorkspaceId, state.selectedWorkspaceId],
      3
    )
    expect(() => planLayoutApplication(withFullLayout, layoutId, randomUUID, windowId)).toThrow(
      hostingState === 'hosted'
        ? 'Saved layout apply requires one hosted window'
        : 'Saved layout would remove another window'
    )
  }
)

it('refuses a target window without a live host', () => {
  const { state, windowId, layoutId } = fixture()
  state.windowPlacements[0]!.hostingState = 'unhosted'
  expect(() => planLayoutApplication(state, layoutId, randomUUID, windowId)).toThrow(
    'Window is not hosted'
  )
})

it('preserves exact catalog tab bindings when a layout replaces pane content', () => {
  const { state, windowId, layoutId } = fixture()
  const workspace = state.workspaces[0]!
  const originalPane = workspace.panes[workspace.selectedPaneId]!
  const oldTabId = originalPane.selectedTabId
  const replacementTabId = randomUUID()
  const template = state.savedLayouts[0]!.template.workspaces[0]!
  template.id = workspace.id
  const oldTab = template.tabs[oldTabId]!
  template.panes[template.selectedPaneId]!.tabs = [replacementTabId]
  template.panes[template.selectedPaneId]!.selectedTabId = replacementTabId
  delete template.tabs[oldTabId]
  template.tabs[replacementTabId] = { ...oldTab, id: replacementTabId }
  const candidate = planLayoutApplication(state, layoutId, randomUUID, windowId)
  expect(durableApplicationStateSchema.safeParse(candidate).success).toBe(true)
  expect(() =>
    assertLayoutBindingsPreserved(state, candidate, [
      {
        workspaceId: workspace.id,
        paneId: originalPane.id,
        tabId: oldTabId
      }
    ])
  ).toThrow('Saved layout would remove an agent or remote session binding')
})

it('refuses to replace the launch of a catalog-bound terminal with the same IDs', () => {
  const { state, windowId, layoutId } = fixture()
  const workspace = state.workspaces[0]!
  const paneId = workspace.selectedPaneId
  const tabId = workspace.panes[paneId]!.selectedTabId
  const template = state.savedLayouts[0]!.template.workspaces[0]!
  template.id = workspace.id
  const tab = template.tabs[tabId]!
  if (tab.content.kind !== 'terminal') throw new Error('Expected terminal template')
  tab.content.launch = { ...tab.content.launch, cols: 100 }
  const candidate = planLayoutApplication(state, layoutId, randomUUID, windowId)
  expect(() =>
    assertLayoutBindingsPreserved(state, candidate, [{ workspaceId: workspace.id, paneId, tabId }])
  ).toThrow('Saved layout would remove an agent or remote session binding')
})
