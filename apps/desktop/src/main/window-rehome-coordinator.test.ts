import { describe, expect, it, vi } from 'vitest'

import { WindowRegistry, type WindowRegistryBinding } from './window-registry'
import { WindowRehomeCoordinator } from './window-rehome-coordinator'

function register(registry: WindowRegistry, windowId: string, contentsId: number) {
  const browserViews = {
    ownsSession: vi.fn(() => false),
    dispose: vi.fn()
  }
  const binding = {
    browserViews,
    stateController: {},
    dispose: vi.fn().mockResolvedValue(undefined)
  }
  const mainFrame = {}
  registry.register(
    windowId,
    {
      webContents: { id: contentsId, mainFrame },
      isDestroyed: () => false
    } as unknown as Electron.BrowserWindow,
    binding as unknown as WindowRegistryBinding
  )
  return { binding, browserViews }
}

describe('WindowRehomeCoordinator', () => {
  it('moves terminal ownership according to the committed plan before disposal', async () => {
    const registry = new WindowRegistry()
    const source = register(registry, 'source', 1)
    register(registry, 'target', 2)
    registry.addTerminalAttachment('source', 'terminal-a')
    const transferTerminal = vi.fn().mockResolvedValue(undefined)
    const coordinator = new WindowRehomeCoordinator(registry, {
      resolvePlan: vi.fn().mockResolvedValue({
        targetWindowId: 'target',
        terminalIds: ['terminal-a'],
        browsers: []
      }),
      transferTerminal,
      markTransferFailed: vi.fn().mockResolvedValue(undefined)
    })

    await coordinator.remove('source', 'closed')

    expect(transferTerminal).toHaveBeenCalledWith('terminal-a', 'source', 'target')
    expect(registry.get('target')?.terminalAttachments).toEqual(new Set(['terminal-a']))
    expect(registry.get('source')).toBeUndefined()
    expect(source.binding.dispose).toHaveBeenCalledOnce()
  })

  it('cleans committed source ownership when its rehome target disappeared', async () => {
    const registry = new WindowRegistry()
    const source = register(registry, 'source', 1)
    const markTransferFailed = vi.fn().mockResolvedValue(undefined)
    registry.addTerminalAttachment('source', 'terminal-a')
    const coordinator = new WindowRehomeCoordinator(registry, {
      resolvePlan: vi.fn().mockResolvedValue({
        targetWindowId: 'missing',
        terminalIds: ['terminal-a'],
        browsers: []
      }),
      transferTerminal: vi.fn(),
      markTransferFailed
    })

    await expect(coordinator.remove('source', 'renderer-crashed')).rejects.toThrow(
      'unavailable target'
    )
    expect(registry.get('source')).toBeUndefined()
    expect(markTransferFailed).toHaveBeenCalledWith(
      'terminal-a',
      'Rehome plan selected an unavailable target window'
    )
    expect(source.binding.dispose).toHaveBeenCalledOnce()
  })

  it('destroys native ownership for an explicitly unhosted plan', async () => {
    const registry = new WindowRegistry()
    const source = register(registry, 'source', 1)
    const coordinator = new WindowRehomeCoordinator(registry, {
      resolvePlan: vi.fn().mockResolvedValue({ terminalIds: [], browsers: [] }),
      transferTerminal: vi.fn(),
      markTransferFailed: vi.fn()
    })

    await coordinator.remove('source', 'closed')
    expect(registry.size).toBe(0)
    expect(source.binding.dispose).toHaveBeenCalledOnce()
  })

  it('finishes source cleanup after a partially failed committed rehome', async () => {
    const registry = new WindowRegistry()
    const source = register(registry, 'source', 1)
    register(registry, 'target', 2)
    registry.addTerminalAttachment('source', 'terminal-a')
    registry.addTerminalAttachment('source', 'terminal-b')
    const markTransferFailed = vi.fn().mockResolvedValue(undefined)
    const coordinator = new WindowRehomeCoordinator(registry, {
      resolvePlan: vi.fn().mockResolvedValue({
        targetWindowId: 'target',
        terminalIds: ['terminal-a', 'terminal-b'],
        browsers: []
      }),
      transferTerminal: vi.fn((terminalId: string) =>
        terminalId === 'terminal-b'
          ? Promise.reject(new Error('target disappeared'))
          : Promise.resolve()
      ),
      markTransferFailed
    })

    await expect(coordinator.remove('source', 'renderer-crashed')).rejects.toThrow(
      'rehome transfers failed'
    )
    expect(registry.get('source')).toBeUndefined()
    expect(registry.get('target')?.terminalAttachments).toEqual(new Set(['terminal-a']))
    expect(markTransferFailed).toHaveBeenCalledWith('terminal-b', 'target disappeared')
    expect(source.binding.dispose).toHaveBeenCalledOnce()
  })
})
