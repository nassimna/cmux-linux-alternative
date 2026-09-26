import { describe, expect, it, vi } from 'vitest'

import { WindowRegistry, type WindowRegistryBinding } from './window-registry'

function fixture(id: number) {
  const mainFrame = { id: `frame-${id}` }
  const webContents = { id, mainFrame }
  const isDestroyed = vi.fn(() => false)
  const window = { webContents, isDestroyed }
  const binding = { dispose: vi.fn().mockResolvedValue(undefined) }
  return {
    binding: binding as typeof binding & WindowRegistryBinding,
    dispose: binding.dispose,
    event: { sender: webContents, senderFrame: mainFrame },
    isDestroyed,
    window: window as unknown as Electron.BrowserWindow
  }
}

describe('WindowRegistry', () => {
  it('invalidates private provider claims before rekey, reload, and native removal', async () => {
    const invalidated = vi.fn()
    const registry = new WindowRegistry(invalidated)
    const owned = fixture(99)
    registry.register('window-before', owned.window, owned.binding)
    registry.rekey('window-before', 'window-after')
    registry.refreshRenderer('window-after')
    await registry.removeWindow(owned.window, 'closed')
    expect(invalidated.mock.calls).toEqual([
      ['window-before'], ['window-after'], ['window-after']
    ])
  })
  it('fails closed and releases a rekeyed binding without dereferencing destroyed WebContents', async () => {
    const registry = new WindowRegistry()
    const destroyed = fixture(11)
    registry.register('window-destroyed', destroyed.window, destroyed.binding)
    registry.rekey('window-destroyed', 'window-rekeyed')
    destroyed.isDestroyed.mockReturnValue(true)
    Object.defineProperty(destroyed.window, 'webContents', {
      get: () => {
        throw new TypeError('Object has been destroyed')
      }
    })

    expect(registry.findByWindow(destroyed.window)).toBeUndefined()
    await expect(registry.removeWindow(destroyed.window, 'closed')).resolves.toMatchObject({
      entry: { windowId: 'window-rekeyed' },
      reason: 'closed'
    })
    expect(destroyed.dispose).toHaveBeenCalledOnce()
    expect(registry.size).toBe(0)
  })

  it('reserves exact unique generations for a persisted native-window restore', () => {
    const registry = new WindowRegistry()

    expect(registry.reserveRendererGenerations(['window-a', 'window-b'])).toEqual([
      { windowId: 'window-a', generation: 1 },
      { windowId: 'window-b', generation: 2 }
    ])
    expect(() => registry.reserveRendererGenerations(['window-c', 'window-c'])).toThrow(
      'duplicate window placements'
    )

    const bounded = new WindowRegistry()
    const maximum = fixture(10)
    bounded.register('window-max', maximum.window, maximum.binding, Number.MAX_SAFE_INTEGER)
    expect(() => bounded.reserveRendererGenerations(['window-overflow'])).toThrow(
      'generation capacity is exhausted'
    )
    expect(() => bounded.refreshRenderer('window-max')).toThrow('generation capacity is exhausted')
    expect(bounded.get('window-max')?.generation).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('bounds renderer ownership tombstones and frees capacity after authoritative deletion', () => {
    const registry = new WindowRegistry()
    for (let index = 0; index < 4096; index += 1) {
      registry.recordRendererOwnership(`resource-${String(index)}`, 'window-a')
    }
    expect(() => registry.recordRendererOwnership('overflow', 'window-a')).toThrow(
      'capacity is exhausted'
    )
    registry.forgetRendererOwnership('resource-0', 'wrong-window')
    expect(registry.rendererOwnershipCount).toBe(4096)
    registry.forgetRendererOwnership('resource-0', 'window-a')
    registry.recordRendererOwnership('replacement', 'window-b')
    registry.reconcileRendererOwnership('window-a', new Set())
    expect(registry.rendererOwnershipCount).toBe(1)
  })

  it('preserves sibling-window ownership during scoped authoritative cleanup', async () => {
    const registry = new WindowRegistry()
    registry.recordRendererOwnership('closed-local', 'window-a')
    registry.recordRendererOwnership('live-local', 'window-a')
    registry.recordRendererOwnership('sibling', 'window-b')

    registry.reconcileRendererOwnership('window-a', new Set(['live-local']))

    expect(registry.rendererOwnershipCount).toBe(2)
    let resolved = false
    const siblingBarrier = registry
      .waitForOwnershipTransfer('sibling', 'window-c')
      .then(() => {
        resolved = true
      })
      .catch(() => undefined)
    await Promise.resolve()
    expect(resolved).toBe(false)
    registry.failOwnershipTransfers('test complete')
    await siblingBarrier
  })

  it('routes only the exact current main-frame sender', () => {
    const registry = new WindowRegistry()
    const first = fixture(11)
    const entry = registry.register('window-a', first.window, first.binding)

    expect(registry.resolveSender(first.event as unknown as Electron.IpcMainInvokeEvent)).toBe(
      entry
    )
    expect(() =>
      registry.resolveSender({
        ...first.event,
        senderFrame: {}
      } as unknown as Electron.IpcMainInvokeEvent)
    ).toThrow('Unauthorized desktop IPC sender')
    expect(() => registry.register('window-a', fixture(12).window, fixture(12).binding)).toThrow(
      'already hosted'
    )
  })

  it('invalidates stale senders before asynchronous disposal', async () => {
    const registry = new WindowRegistry()
    const first = fixture(21)
    let release!: () => void
    first.dispose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    registry.register('window-a', first.window, first.binding)

    const removing = registry.remove('window-a', 'renderer-crashed')
    expect(() =>
      registry.resolveSender(first.event as unknown as Electron.IpcMainInvokeEvent)
    ).toThrow('Unauthorized desktop IPC sender')
    release()
    await removing
    expect(registry.size).toBe(0)
  })

  it('serializes transfers per resource and cleans failed queues', async () => {
    const registry = new WindowRegistry()
    const order: string[] = []
    let release!: () => void
    const first = registry.transfer('browser-a', async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => (release = resolve))
      order.push('first:end')
    })
    const second = registry.transfer('browser-a', () => {
      order.push('second')
      return Promise.reject(new Error('transfer failed'))
    })
    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    release()
    await first
    await expect(second).rejects.toThrow('transfer failed')
    expect(order).toEqual(['first:start', 'first:end', 'second'])
    expect(registry.pendingTransferCount).toBe(0)
  })

  it('applies monotonic ownership epochs and permits only detach then attach at one epoch', async () => {
    const registry = new WindowRegistry()
    const applied: string[] = []
    registry.resetProviderEpoch(7)

    await registry.transferOwnership('terminal-a', 4, 'detachOwnership', 'source', () => {
      applied.push('detach')
      return Promise.resolve()
    })
    await registry.transferOwnership('terminal-a', 4, 'attachOwnership', 'target', () => {
      applied.push('attach')
      return Promise.resolve()
    })
    await registry.transferOwnership('terminal-a', 4, 'attachOwnership', 'other', () => {
      applied.push('conflict')
      return Promise.resolve()
    })
    await registry.transferOwnership('terminal-a', 3, 'detachOwnership', 'target', () => {
      applied.push('stale')
      return Promise.resolve()
    })

    expect(applied).toEqual(['detach', 'attach'])
    registry.resetProviderEpoch(8)
    await registry.transferOwnership('terminal-a', 1, 'detachOwnership', 'target', () => {
      applied.push('new-provider')
      return Promise.resolve()
    })
    expect(applied).toEqual(['detach', 'attach', 'new-provider'])
  })

  it('gates target renderer acquisition for event-before-provider ordering', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)
    registry.observeOwnershipTransfer('terminal-a', 4, 'source', 'target')
    let acquired = false
    const renderer = registry.waitForOwnershipTransfer('terminal-a', 'target').then(() => {
      acquired = true
    })

    await registry.transferOwnership('terminal-a', 4, 'detachOwnership', 'source', () =>
      Promise.resolve()
    )
    expect(acquired).toBe(false)
    await registry.transferOwnership('terminal-a', 4, 'attachOwnership', 'target', () =>
      Promise.resolve()
    )
    await renderer
    expect(acquired).toBe(true)
  })

  it('opens a late event barrier when provider attach completed first', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)
    await registry.transferOwnership('browser-a', 5, 'detachOwnership', 'source', () =>
      Promise.resolve()
    )
    await registry.transferOwnership('browser-a', 5, 'attachOwnership', 'target', () =>
      Promise.resolve()
    )

    registry.observeOwnershipTransfer('browser-a', 5, 'source', 'target')
    await expect(registry.waitForOwnershipTransfer('browser-a', 'target')).resolves.toBeUndefined()
  })

  it('blocks projection-before-event acquisition until the matching provider transition completes', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)
    registry.recordRendererOwnership('browser-a', 'source')

    let acquired = false
    const waiting = registry.waitForOwnershipTransfer('browser-a', 'target').then(() => {
      acquired = true
    })
    await Promise.resolve()
    expect(acquired).toBe(false)

    await registry.transferOwnership('browser-a', 5, 'detachOwnership', 'source', () =>
      Promise.resolve()
    )
    expect(acquired).toBe(false)
    await registry.transferOwnership('browser-a', 5, 'attachOwnership', 'target', () =>
      Promise.resolve()
    )
    await waiting
    expect(acquired).toBe(true)

    registry.observeOwnershipTransfer('browser-a', 5, 'source', 'target')
    await expect(registry.waitForOwnershipTransfer('browser-a', 'target')).resolves.toBeUndefined()
  })

  it('settles event-first acquisition only after atomic recovery owns the target', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)
    registry.observeOwnershipTransfer('terminal-a', 6, 'source', 'target')
    let acquired = false
    const waiting = registry.waitForOwnershipTransfer('terminal-a', 'target').then(() => {
      acquired = true
    })

    await registry.recoverOwnership('terminal-a', 6, 'source', 'target', () => {
      expect(acquired).toBe(false)
      return Promise.resolve()
    })
    await waiting
    expect(acquired).toBe(true)

    const staleApply = vi.fn()
    await expect(
      registry.recoverOwnership('terminal-a', 5, 'source', 'target', () => {
        staleApply()
        return Promise.resolve()
      })
    ).resolves.toBe(false)
    expect(staleApply).not.toHaveBeenCalled()
  })

  it('keeps a target waiter alive across newer hosting events for the same placement', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)
    registry.observeOwnershipTransfer('browser-a', 4, 'source', 'target')
    let acquired = false
    const waiting = registry.waitForOwnershipTransfer('browser-a', 'target').then(() => {
      acquired = true
    })

    registry.observeOwnershipTransfer('browser-a', 5, 'target', 'target')
    await Promise.resolve()
    expect(acquired).toBe(false)
    await registry.transferOwnership('browser-a', 4, 'detachOwnership', 'source', () =>
      Promise.resolve()
    )
    await registry.transferOwnership('browser-a', 4, 'attachOwnership', 'target', () =>
      Promise.resolve()
    )

    await waiting
    expect(acquired).toBe(true)
  })

  it('ignores a standalone ownership event that stays within one window', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)

    registry.observeOwnershipTransfer('terminal-a', 4, 'window-a', 'window-a')

    await expect(
      registry.waitForOwnershipTransfer('terminal-a', 'window-a')
    ).resolves.toBeUndefined()
  })

  it('lets source cleanup proceed while rejecting target acquisition on failure or lease loss', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)
    registry.observeOwnershipTransfer('terminal-a', 6, 'source', 'target')

    await expect(
      registry.transferOwnership('terminal-a', 6, 'detachOwnership', 'source', () =>
        Promise.reject(new Error('detach failed'))
      )
    ).rejects.toThrow('detach failed')
    await expect(registry.waitForOwnershipTransfer('terminal-a', 'target')).rejects.toThrow(
      'detach failed'
    )
    await expect(registry.waitForOwnershipTransfer('terminal-a', 'source')).resolves.toBeUndefined()

    registry.observeOwnershipTransfer('browser-a', 7, 'source', 'target')
    const waiting = registry.waitForOwnershipTransfer('browser-a', 'target')
    registry.failOwnershipTransfers('lease lost')
    await expect(waiting).rejects.toThrow('lease lost')
  })

  it('rejects attach-before-detach and opens future renderer retries after provider recovery', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)
    registry.observeOwnershipTransfer('terminal-a', 8, 'source', 'target')

    await expect(
      registry.transferOwnership('terminal-a', 8, 'attachOwnership', 'target', () =>
        Promise.resolve()
      )
    ).rejects.toThrow('preceded its committed detachment')
    await expect(registry.waitForOwnershipTransfer('terminal-a', 'target')).rejects.toThrow(
      'preceded its committed detachment'
    )

    await registry.transferOwnership('terminal-a', 8, 'detachOwnership', 'source', () =>
      Promise.resolve()
    )
    await registry.transferOwnership('terminal-a', 8, 'attachOwnership', 'target', () =>
      Promise.resolve()
    )
    await expect(registry.waitForOwnershipTransfer('terminal-a', 'target')).resolves.toBeUndefined()
  })

  it('fails closed when live transfer tombstones reach their bound and resets on a new epoch', async () => {
    const registry = new WindowRegistry()
    registry.resetProviderEpoch(7)
    for (let index = 0; index < 4096; index += 1) {
      await registry.transferOwnership(
        `terminal-${String(index)}`,
        1,
        'detachOwnership',
        'source',
        () => Promise.resolve()
      )
    }
    await expect(
      registry.transferOwnership('terminal-overflow', 1, 'detachOwnership', 'source', () =>
        Promise.resolve()
      )
    ).rejects.toThrow('capacity is exhausted')

    registry.resetProviderEpoch(8)
    await expect(
      registry.transferOwnership('terminal-overflow', 1, 'detachOwnership', 'source', () =>
        Promise.resolve()
      )
    ).resolves.toBe(true)
  })

  it('tracks terminal ownership and disposes every window once', async () => {
    const registry = new WindowRegistry()
    const first = fixture(31)
    const second = fixture(32)
    registry.register('window-a', first.window, first.binding)
    registry.register('window-b', second.window, second.binding)
    registry.addTerminalAttachment('window-a', 'terminal-a')

    expect(registry.get('window-a')?.terminalAttachments).toEqual(new Set(['terminal-a']))
    await registry.dispose()
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(registry.size).toBe(0)
  })

  it('rekeys provisional ownership without preserving stale authority', () => {
    const registry = new WindowRegistry()
    const first = fixture(41)
    registry.register('provisional', first.window, first.binding)
    const entry = registry.rekey('provisional', 'service-window')

    expect(entry.windowId).toBe('service-window')
    expect(registry.get('provisional')).toBeUndefined()
    expect(registry.findByWindow(first.window)).toBe(entry)
    expect(registry.resolveSender(first.event as unknown as Electron.IpcMainInvokeEvent)).toBe(
      entry
    )
  })

  it('increments renderer generation after a crash while retaining owned resources', () => {
    const registry = new WindowRegistry()
    const first = fixture(51)
    const original = registry.register('window-a', first.window, first.binding)
    original.terminalAttachments.add('terminal-a')
    const refreshed = registry.refreshRenderer('window-a')

    expect(refreshed.generation).toBeGreaterThan(original.generation)
    expect(refreshed.terminalAttachments).toBe(original.terminalAttachments)
    expect(registry.resolveSender(first.event as unknown as Electron.IpcMainInvokeEvent)).toBe(
      refreshed
    )
  })

  it('holds renderer initialization until the exact provider-created generation is acknowledged', async () => {
    const registry = new WindowRegistry()
    const first = fixture(61)
    registry.deferWindowActivation('window-a', 4)
    const entry = registry.register('window-a', first.window, first.binding, 4)
    let ready = false
    const waiting = registry.waitForWindowActivation(entry).then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)

    registry.activateWindow('window-a', 4)
    await waiting
    expect(ready).toBe(true)
  })
})
