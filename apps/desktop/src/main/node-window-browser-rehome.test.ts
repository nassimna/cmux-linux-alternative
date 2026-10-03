import { describe, expect, it, vi } from 'vitest'

import { rehomeNodeBrowsers } from './node-window-browser-rehome'

const descriptor = {
  workspaceId: 'workspace-a', paneId: 'pane-a', tabId: 'tab-a',
  browserSessionId: 'browser-a', lifecycleId: 'lifecycle-a',
  profilePartition: 'persist:test', stateRevision: 3, title: 'Page', url: 'https://example.test',
  history: { entries: [{ url: 'https://example.test', title: 'Page' }], index: 0 }
}

function fixture() {
  const events: string[] = []
  const resume = vi.fn(() => events.push('resume'))
  const source = {
    ownedTransferDescriptors: vi.fn(() => [descriptor]),
    suspendOwnedSession: vi.fn(() => { events.push('suspend'); return resume }),
    destroyOwnedSession: vi.fn(() => events.push('destroy-source'))
  }
  const target = {
    ownsSession: vi.fn(() => false),
    mountTransferred: vi.fn(async () => { events.push('mount-target') }),
    destroyOwnedSession: vi.fn(() => events.push('destroy-target')),
    activateTransferredSession: vi.fn(() => events.push('activate-target'))
  }
  const commit = vi.fn(async () => { events.push('commit') })
  const transferred = vi.fn(() => events.push('record-owner'))
  const input = {
    source, target, sourceWorkspaceIds: new Set(['workspace-a']),
    assertCurrent: vi.fn(), commit,
    resolveCommit: vi.fn(async (): Promise<'committed' | 'not-committed' | 'unknown'> =>
      'not-committed'),
    transferred
  }
  return { events, resume, source, target, commit, transferred, input }
}

describe('Node native browser close transfer', () => {
  it('stages a replacement before durable commit, then destroys source ownership', async () => {
    const test = fixture()
    await rehomeNodeBrowsers(test.input)
    expect(test.events).toEqual([
      'suspend', 'mount-target', 'commit', 'activate-target', 'destroy-source', 'record-owner'
    ])
    expect(test.resume).not.toHaveBeenCalled()
  })

  it('rolls back target and restores source when mounting or the durable close fails', async () => {
    const mount = fixture()
    mount.target.mountTransferred.mockRejectedValueOnce(new Error('target unavailable'))
    await expect(rehomeNodeBrowsers(mount.input)).rejects.toThrow('target unavailable')
    expect(mount.events).toEqual(['suspend', 'destroy-target', 'resume'])
    expect(mount.commit).not.toHaveBeenCalled()

    const close = fixture()
    close.commit.mockImplementationOnce(async () => {
      close.events.push('commit')
      throw new Error('revision conflict')
    })
    await expect(rehomeNodeBrowsers(close.input)).rejects.toThrow('revision conflict')
    expect(close.events).toEqual([
      'suspend', 'mount-target', 'commit', 'destroy-target', 'resume'
    ])
  })

  it('finalizes a proven committed close despite a lost response', async () => {
    const test = fixture()
    test.commit.mockImplementationOnce(async () => {
      test.events.push('commit')
      throw new Error('connection lost')
    })
    test.input.resolveCommit.mockResolvedValueOnce('committed')
    await rehomeNodeBrowsers(test.input)
    expect(test.events).toEqual([
      'suspend', 'mount-target', 'commit', 'activate-target', 'destroy-source', 'record-owner'
    ])
  })

  it('quarantines an unknown commit outcome without recreating two active owners', async () => {
    const test = fixture()
    test.commit.mockImplementationOnce(async () => {
      test.events.push('commit')
      throw new Error('connection lost')
    })
    test.input.resolveCommit.mockResolvedValueOnce('unknown')
    await expect(rehomeNodeBrowsers(test.input)).rejects.toThrow('quarantined')
    expect(test.events).toEqual(['suspend', 'mount-target', 'commit'])
  })

  it('rejects misplaced resources and stale owners before mutation', async () => {
    const misplaced = fixture()
    misplaced.input.sourceWorkspaceIds.clear()
    await expect(rehomeNodeBrowsers(misplaced.input)).rejects.toThrow('outside')
    expect(misplaced.events).toEqual([])

    const stale = fixture()
    stale.input.assertCurrent.mockImplementationOnce(() => {
      throw new Error('stale generation')
    })
    await expect(rehomeNodeBrowsers(stale.input)).rejects.toThrow('stale generation')
    expect(stale.events).toEqual([])
  })
})
