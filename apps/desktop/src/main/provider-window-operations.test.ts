import { describe, expect, it, vi } from 'vitest'

import { closeTransferredProviderWindow, focusProviderWindow } from './provider-window-operations'
import { WindowRegistry, type WindowRegistryBinding } from './window-registry'

function register(registry: WindowRegistry, windowId: string, contentsId: number) {
  const browserViews = { size: 0 }
  const binding = {
    browserViews,
    stateController: {},
    dispose: vi.fn().mockResolvedValue(undefined)
  }
  const window = {
    webContents: { id: contentsId, mainFrame: {} },
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn()
  }
  const entry = registry.register(
    windowId,
    window as unknown as Electron.BrowserWindow,
    binding as unknown as WindowRegistryBinding
  )
  return { binding, browserViews, entry, window }
}

describe('provider window operations', () => {
  it('closes only after planned resource transfers vacate the source', async () => {
    const registry = new WindowRegistry()
    const source = register(registry, 'source', 1)
    const target = register(registry, 'target', 2)
    source.entry.terminalAttachments.add('terminal-a')

    await expect(closeTransferredProviderWindow(registry, source.entry)).rejects.toThrow(
      'still owns live resources'
    )
    source.entry.terminalAttachments.delete('terminal-a')
    target.entry.terminalAttachments.add('terminal-a')
    await closeTransferredProviderWindow(registry, source.entry)

    expect(registry.get('source')).toBeUndefined()
    expect(registry.get('target')?.terminalAttachments).toEqual(new Set(['terminal-a']))
    expect(source.binding.dispose).toHaveBeenCalledOnce()
    expect(source.window.destroy).toHaveBeenCalledOnce()
  })

  it('focuses the native target through one provider operation', () => {
    const registry = new WindowRegistry()
    const target = register(registry, 'target', 1)
    target.window.isMinimized.mockReturnValue(true)

    focusProviderWindow(target.entry)

    expect(target.window.restore).toHaveBeenCalledOnce()
    expect(target.window.focus).toHaveBeenCalledOnce()
  })
})
