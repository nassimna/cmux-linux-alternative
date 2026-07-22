import { describe, expect, it, vi } from 'vitest'

import type { ControlClient } from './control-client'
import { WindowRegistry, type WindowRegistryBinding } from './window-registry'
import { connectWindowScopedClient, rebindRegisteredWindows } from './window-client-rebinding'

function nativeWindow(id: number): Electron.BrowserWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { id, mainFrame: {} }
  } as unknown as Electron.BrowserWindow
}

describe('window client rebinding', () => {
  it('rebinds every live window with its current generation after a service restart', async () => {
    const registry = new WindowRegistry()
    const binding = { dispose: vi.fn() } as unknown as WindowRegistryBinding
    registry.register('window-a', nativeWindow(1), binding, 4)
    registry.register('window-b', nativeWindow(2), binding, 8)
    registry.refreshRenderer('window-b')
    const children = registry.list().map(() => ({ bindWindow: vi.fn(), close: vi.fn() }))
    let childIndex = 0
    const connector = {
      connectAdditionalClient: vi.fn(() =>
        Promise.resolve(children[childIndex++] as unknown as ControlClient)
      )
    }
    const identity = {
      providerId: 'desktop-a',
      providerEpoch: 3,
      leaseId: 'lease-a'
    }

    await rebindRegisteredWindows(registry, {} as ControlClient, async (window) => {
      const entry = registry.findByWindow(window)
      if (!entry) throw new Error('missing test window')
      await connectWindowScopedClient(connector, identity, entry)
    })

    expect(children[0]?.bindWindow).toHaveBeenCalledWith({
      identity,
      window: { windowId: 'window-a', generation: 4 }
    })
    expect(children[1]?.bindWindow).toHaveBeenCalledWith({
      identity,
      window: { windowId: 'window-b', generation: 9 }
    })
  })

  it('closes a child whose scoped bind is rejected', async () => {
    const child = {
      bindWindow: vi.fn().mockRejectedValue(new Error('stale claim')),
      close: vi.fn()
    }
    await expect(
      connectWindowScopedClient(
        {
          connectAdditionalClient: vi.fn(() => Promise.resolve(child as unknown as ControlClient))
        },
        { providerId: 'desktop-a', providerEpoch: 3, leaseId: 'lease-a' },
        { windowId: 'window-a', generation: 2 }
      )
    ).rejects.toThrow('stale claim')
    expect(child.close).toHaveBeenCalledOnce()
  })
})
