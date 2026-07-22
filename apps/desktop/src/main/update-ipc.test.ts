/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel)
  }
}))

import { DESKTOP_IPC, type DesktopUpdateState } from '../shared/desktop-bridge'
import {
  DESKTOP_UPDATE_INVOKE_CHANNELS,
  registerDesktopUpdateHandlers,
  registerSenderBoundDesktopUpdateHandlers,
  type DesktopUpdateController
} from './update-ipc'

describe('desktop update IPC', () => {
  const mainFrame = {}
  const webContents = { mainFrame, send: vi.fn() }
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents
  } as unknown as Electron.BrowserWindow

  beforeEach(() => {
    electron.handlers.clear()
    vi.clearAllMocks()
  })

  it('validates sender and empty payloads for every bounded action', async () => {
    const { controller } = createController()
    registerDesktopUpdateHandlers(window, controller)
    expect([...electron.handlers.keys()]).toEqual(DESKTOP_UPDATE_INVOKE_CHANNELS)
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(electron.handlers.get(DESKTOP_IPC.updateCheck)?.(event)).resolves.toMatchObject({
      status: 'idle'
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.updateDownload)?.(event, { url: 'https://evil.invalid/' })
    ).rejects.toThrow(/payload/iu)
    await expect(
      electron.handlers.get(DESKTOP_IPC.updateInstall)?.({ sender: webContents, senderFrame: {} })
    ).rejects.toThrow(/Unauthorized/iu)
    expect(controller.download).not.toHaveBeenCalled()
    expect(controller.install).not.toHaveBeenCalled()
  })

  it('owns one forwarding listener and disposes it across renderer rebinds', () => {
    const first = createController()
    const disposeFirst = registerDesktopUpdateHandlers(window, first.controller)
    first.emit({ status: 'development', channel: 'stable' })
    expect(webContents.send).toHaveBeenCalledOnce()

    const second = createController()
    disposeFirst()
    const disposeSecond = registerDesktopUpdateHandlers(window, second.controller)
    first.emit({ status: 'development', channel: 'stable' })
    second.emit({ status: 'unconfigured', channel: 'beta' })
    expect(webContents.send).toHaveBeenCalledTimes(2)
    expect(webContents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.updateStateChanged, {
      status: 'unconfigured',
      channel: 'beta'
    })

    disposeSecond()
    expect(electron.handlers.size).toBe(0)
    expect(first.unsubscribe).toHaveBeenCalledOnce()
    expect(second.unsubscribe).toHaveBeenCalledOnce()
  })

  it('registers sender-bound handlers once and broadcasts state to every live window', async () => {
    const handlers = new Map<
      string,
      (entry: unknown, event: unknown, ...args: unknown[]) => unknown
    >()
    type SenderHandler = (entry: unknown, event: unknown, ...args: unknown[]) => unknown
    const router = {
      handle: vi.fn((channel: string, handler: SenderHandler): void => {
        handlers.set(channel, handler)
      })
    }
    const first = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } }
    const second = { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } }
    const registry = { list: vi.fn(() => [{ window: first }, { window: second }]) }
    const fixture = createController()
    const dispose = registerSenderBoundDesktopUpdateHandlers(
      router as never,
      registry as never,
      fixture.controller
    )

    await expect(handlers.get(DESKTOP_IPC.updateCheck)?.({}, {})).resolves.toMatchObject({
      status: 'idle'
    })
    await expect(handlers.get(DESKTOP_IPC.updateDownload)?.({}, {}, 'bad')).rejects.toThrow(
      /payload/iu
    )
    fixture.emit({ status: 'development', channel: 'stable' })
    expect(first.webContents.send).toHaveBeenCalledOnce()
    expect(second.webContents.send).toHaveBeenCalledOnce()
    dispose()
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
  })
})

function createController(): {
  controller: DesktopUpdateController & {
    check: ReturnType<typeof vi.fn>
    download: ReturnType<typeof vi.fn>
    install: ReturnType<typeof vi.fn>
  }
  emit(state: DesktopUpdateState): void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  let listener: ((state: DesktopUpdateState) => void) | undefined
  const unsubscribe = vi.fn(() => {
    listener = undefined
  })
  const controller = {
    getState: vi.fn(() => ({
      status: 'idle' as const,
      channel: 'stable' as const,
      packageType: 'appimage' as const
    })),
    check: vi.fn(async () => controller.getState()),
    download: vi.fn(async () => controller.getState()),
    install: vi.fn(async () => undefined),
    subscribe: vi.fn((next: (state: DesktopUpdateState) => void) => {
      listener = next
      return unsubscribe
    })
  }
  return { controller, emit: (state) => listener?.(state), unsubscribe }
}
