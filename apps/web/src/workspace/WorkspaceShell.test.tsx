// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import { canShowNodeRecentlyClosed, canShowNodeTaskManager } from './WorkspaceShell'

describe('Node Recently Closed tools gate', () => {
  const capabilities = ['node-core-demo', 'recentlyClosed.list', 'recentlyClosed.reopen']
  const bridge = {
    listRecentlyClosed: vi.fn(),
    reopenRecentlyClosed: vi.fn()
  }

  it('requires both granular capabilities and both bridge methods', () => {
    expect(canShowNodeRecentlyClosed(capabilities, bridge)).toBe(true)
    for (const capability of capabilities) {
      expect(
        canShowNodeRecentlyClosed(
          capabilities.filter((available) => available !== capability),
          bridge
        )
      ).toBe(false)
    }
    expect(
      canShowNodeRecentlyClosed(capabilities, { reopenRecentlyClosed: bridge.reopenRecentlyClosed })
    ).toBe(false)
    expect(
      canShowNodeRecentlyClosed(capabilities, { listRecentlyClosed: bridge.listRecentlyClosed })
    ).toBe(false)
  })
})

describe('Node Task Manager tools gate', () => {
  const capabilities = ['node-core-demo', 'task.list', 'task.detach']
  const bridge = { listTasks: vi.fn(), actOnTask: vi.fn() }

  it('requires the verified Node list capability and bridge method', () => {
    expect(canShowNodeTaskManager(capabilities, bridge)).toEqual({ list: true, detach: true })
    expect(canShowNodeTaskManager(['node-core-demo', 'task.list'], bridge)).toEqual({
      list: true,
      detach: false
    })
    expect(canShowNodeTaskManager(['task.list', 'task.detach'], bridge).list).toBe(false)
    expect(canShowNodeTaskManager(['node-core-demo', 'task.detach'], bridge).list).toBe(false)
    expect(canShowNodeTaskManager(capabilities, { actOnTask: bridge.actOnTask }).list).toBe(false)
  })

  it('advertises detach only with its separate capability and bridge method', () => {
    expect(canShowNodeTaskManager(capabilities, { listTasks: bridge.listTasks })).toEqual({
      list: true,
      detach: false
    })
  })
})
