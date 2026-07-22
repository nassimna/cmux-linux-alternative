import { describe, expect, it, vi } from 'vitest'

import { DesktopWindowBinding } from './desktop-window-binding'
import { invalidateProviderWindowBindings } from './provider-loss-cleanup'
import { WindowRegistry } from './window-registry'

describe('provider loss cleanup', () => {
  it('revokes child clients, native views, and terminal ownership for every live window', async () => {
    const registry = new WindowRegistry()
    const disposeReady = vi.fn().mockResolvedValue(undefined)
    const clearClient = vi.fn()
    const binding = new DesktopWindowBinding({ clearClient, dispose: vi.fn() } as never)
    binding.replaceReady({} as never, {} as never, disposeReady)
    const contents = { id: 1, mainFrame: {} }
    registry
      .register('window-a', { webContents: contents, isDestroyed: () => false } as never, binding)
      .terminalAttachments.add('terminal-a')
    const rollback = vi.fn()

    await invalidateProviderWindowBindings(registry, rollback)

    expect(rollback).toHaveBeenCalledOnce()
    expect(registry.get('window-a')?.terminalAttachments.size).toBe(0)
    expect(disposeReady).toHaveBeenCalledOnce()
    expect(clearClient).toHaveBeenCalledOnce()
    expect(() => binding.client).toThrow('Window renderer is not ready')
    expect(() => binding.browserViews).toThrow('Window renderer is not ready')
  })
})
