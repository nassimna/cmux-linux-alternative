import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import { SenderBoundIpcRouter, type IpcHandlerHost } from './sender-bound-ipc-router'
import {
  WindowRegistry,
  type WindowRegistryBinding,
  type WindowRegistryEntry
} from './window-registry'

describe('SenderBoundIpcRouter', () => {
  it('registers once and routes from the exact current sender', async () => {
    const listeners = new Map<
      string,
      (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
    >()
    const host: IpcHandlerHost = {
      handle: (channel, listener) => listeners.set(channel, listener),
      removeHandler: vi.fn()
    }
    const registry = new WindowRegistry()
    const mainFrame = {}
    const contents = { id: 9, mainFrame }
    registry.register(
      'window-a',
      { webContents: contents, isDestroyed: () => false } as unknown as Electron.BrowserWindow,
      { dispose: vi.fn() } as unknown as WindowRegistryBinding
    )
    const router = new SenderBoundIpcRouter(registry, host)
    const handler = vi.fn((_entry, _event, value) => Promise.resolve(value))
    router.handle('window:list', handler)

    await expect(
      listeners.get('window:list')?.(
        { sender: contents, senderFrame: mainFrame } as unknown as Electron.IpcMainInvokeEvent,
        'ok'
      )
    ).resolves.toBe('ok')
    expect((handler.mock.calls[0]?.[0] as WindowRegistryEntry).windowId).toBe('window-a')
    router.handle('window:list', handler)
    expect(listeners.size).toBe(1)
    expect(() =>
      listeners.get('window:list')?.({
        sender: contents,
        senderFrame: {}
      } as unknown as Electron.IpcMainInvokeEvent)
    ).toThrow('Unauthorized desktop IPC sender')
  })

  it('removes all owned channels without touching unrelated IPC', () => {
    const removeHandler = vi.fn()
    const host: IpcHandlerHost = { handle: vi.fn(), removeHandler }
    const router = new SenderBoundIpcRouter(new WindowRegistry(), host)
    router.handle('one', vi.fn())
    router.handle('two', vi.fn())
    router.dispose()
    router.dispose()
    expect(removeHandler).toHaveBeenCalledTimes(2)
    expect(removeHandler).toHaveBeenCalledWith('one')
    expect(removeHandler).toHaveBeenCalledWith('two')
  })
})
