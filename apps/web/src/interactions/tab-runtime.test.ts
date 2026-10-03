import { describe, expect, it } from 'vitest'

import type { WorkspaceSnapshot } from '@agent-workspace/protocol-client'

import { keyboardDropToMutation, pointerDropToMutation } from './intents'
import { resolveTabMutationCommand } from './tab-runtime'

const workspace = {
  id: 'workspace-1',
  panes: [
    { id: 'pane-a', tabIds: ['tab-a', 'tab-b'], selectedTabId: 'tab-a' },
    { id: 'pane-b', tabIds: ['tab-c'], selectedTabId: 'tab-c' }
  ],
  tabs: [{ id: 'tab-a' }, { id: 'tab-b' }, { id: 'tab-c' }]
} as unknown as WorkspaceSnapshot

describe('tab mutation runtime', () => {
  it('converts same-pane final position to the backend pre-removal boundary', () => {
    expect(
      resolveTabMutationCommand(workspace, {
        kind: 'move-tab',
        tabId: 'tab-a',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-a',
        targetIndex: 1
      })
    ).toEqual({
      method: 'moveTab',
      params: {
        workspaceId: 'workspace-1',
        tabId: 'tab-a',
        destinationPaneId: 'pane-a',
        destinationIndex: 2
      }
    })
  })

  it('preserves a cross-pane insertion index including append', () => {
    expect(
      resolveTabMutationCommand(workspace, {
        kind: 'move-tab',
        tabId: 'tab-a',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
        targetIndex: 1
      })
    ).toEqual({
      method: 'moveTabToPane',
      params: {
        workspaceId: 'workspace-1',
        tabId: 'tab-a',
        destinationPaneId: 'pane-b',
        destinationIndex: 1
      }
    })
  })

  it.each([
    ['left', 'horizontal', 'before'],
    ['right', 'horizontal', 'after'],
    ['top', 'vertical', 'before'],
    ['bottom', 'vertical', 'after']
  ] as const)('maps %s to the exact split payload', (direction, axis, placement) => {
    expect(
      resolveTabMutationCommand(workspace, {
        kind: 'split-pane',
        tabId: 'tab-a',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
        direction
      })
    ).toEqual({
      method: 'splitPane',
      params: {
        workspaceId: 'workspace-1',
        targetPaneId: 'pane-b',
        axis,
        ratio: 0.5,
        placement,
        content: { kind: 'existingTab', tabId: 'tab-a' }
      }
    })
  })

  it('rejects splitting a pane by moving its only tab beside itself', () => {
    expect(
      resolveTabMutationCommand(workspace, {
        kind: 'split-pane',
        tabId: 'tab-c',
        sourcePaneId: 'pane-b',
        targetPaneId: 'pane-b',
        direction: 'right'
      })
    ).toBeNull()
  })

  it('resolves equivalent pointer and keyboard actions to one bridge command', () => {
    const source = { tabId: 'tab-a', sourcePaneId: 'pane-a' }
    const pointerIntent = pointerDropToMutation({
      ...source,
      point: { x: 100, y: 60 },
      targetRect: { x: 0, y: 0, width: 200, height: 120 },
      targetPaneId: 'pane-b',
      targetIndex: 1
    })
    const keyboardIntent = keyboardDropToMutation(source, {
      kind: 'move',
      targetPaneId: 'pane-b',
      targetIndex: 1
    })

    expect(pointerIntent).not.toBeNull()
    expect(resolveTabMutationCommand(workspace, pointerIntent!)).toEqual(
      resolveTabMutationCommand(workspace, keyboardIntent!)
    )
  })
})
