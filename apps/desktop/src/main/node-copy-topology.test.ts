import { describe, expect, it } from 'vitest'

import { matchesNodeCopyBase } from './node-copy-topology'

const rust = {
  workspaceIds: ['workspace-a'],
  windowIds: ['window-a'],
  selectedWorkspaceId: 'workspace-a'
}

describe('Node copy topology gate', () => {
  it('accepts additional private windows on resume while rejecting them on a fresh copy', () => {
    const node = { ...rust, windowIds: ['window-a', 'window-b', 'window-c'] }
    expect(matchesNodeCopyBase(rust, node, true)).toBe(true)
    expect(matchesNodeCopyBase(rust, node, false)).toBe(false)
  })

  it('rejects unrelated and incomplete resumed copies', () => {
    expect(
      matchesNodeCopyBase(
        rust,
        {
          workspaceIds: ['workspace-b'],
          windowIds: ['window-b'],
          selectedWorkspaceId: 'workspace-b'
        },
        true
      )
    ).toBe(false)
    expect(
      matchesNodeCopyBase(
        rust,
        {
          ...rust,
          workspaceIds: [],
          windowIds: ['window-a', 'window-b']
        },
        true
      )
    ).toBe(false)
    expect(
      matchesNodeCopyBase(
        rust,
        {
          ...rust,
          windowIds: ['window-b']
        },
        true
      )
    ).toBe(false)
  })
})
