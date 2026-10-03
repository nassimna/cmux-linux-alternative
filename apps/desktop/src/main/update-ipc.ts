import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import {
  DESKTOP_IPC,
  parseDesktopUpdateState,
  type DesktopUpdateState
} from '@agent-workspace/contracts/desktop/desktop-bridge'
import type { SenderBoundIpcRouter } from './sender-bound-ipc-router'
import type { WindowRegistry } from './window-registry'

export interface DesktopUpdateController {
  getState(): DesktopUpdateState
  check(): Promise<DesktopUpdateState>
  download(): Promise<DesktopUpdateState>
  install(): Promise<void>
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
}

export const DESKTOP_UPDATE_INVOKE_CHANNELS = [
  DESKTOP_IPC.updateGetState,
  DESKTOP_IPC.updateCheck,
  DESKTOP_IPC.updateDownload,
  DESKTOP_IPC.updateInstall
] as const

export function registerDesktopUpdateHandlers(
  window: BrowserWindow,
  controller: DesktopUpdateController
): () => void {
  removeDesktopUpdateHandlers()
  const validate = (event: IpcMainInvokeEvent, args: unknown[]): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unauthorized desktop IPC sender')
    }
    if (args.length !== 0) throw new Error('Invalid desktop update payload')
  }

  ipcMain.handle(DESKTOP_IPC.updateGetState, (event, ...args: unknown[]) => {
    validate(event, args)
    return parseDesktopUpdateState(controller.getState())
  })
  ipcMain.handle(DESKTOP_IPC.updateCheck, async (event, ...args: unknown[]) => {
    validate(event, args)
    return parseDesktopUpdateState(await controller.check())
  })
  ipcMain.handle(DESKTOP_IPC.updateDownload, async (event, ...args: unknown[]) => {
    validate(event, args)
    return parseDesktopUpdateState(await controller.download())
  })
  ipcMain.handle(DESKTOP_IPC.updateInstall, async (event, ...args: unknown[]) => {
    validate(event, args)
    await controller.install()
  })

  const stopForwarding = controller.subscribe((state) => {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC.updateStateChanged, parseDesktopUpdateState(state))
    }
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    stopForwarding()
    removeDesktopUpdateHandlers()
  }
}

export function removeDesktopUpdateHandlers(): void {
  for (const channel of DESKTOP_UPDATE_INVOKE_CHANNELS) ipcMain.removeHandler(channel)
}

/** Registers updater commands once and forwards state to every live registered renderer. */
export function registerSenderBoundDesktopUpdateHandlers(
  router: SenderBoundIpcRouter,
  registry: WindowRegistry,
  controller: DesktopUpdateController
): () => void {
  const validate = (args: unknown[]): void => {
    if (args.length !== 0) throw new Error('Invalid desktop update payload')
  }
  router.handle(DESKTOP_IPC.updateGetState, (_entry, _event, ...args) => {
    validate(args)
    return parseDesktopUpdateState(controller.getState())
  })
  router.handle(DESKTOP_IPC.updateCheck, async (_entry, _event, ...args) => {
    validate(args)
    return parseDesktopUpdateState(await controller.check())
  })
  router.handle(DESKTOP_IPC.updateDownload, async (_entry, _event, ...args) => {
    validate(args)
    return parseDesktopUpdateState(await controller.download())
  })
  router.handle(DESKTOP_IPC.updateInstall, async (_entry, _event, ...args) => {
    validate(args)
    await controller.install()
  })
  return controller.subscribe((state) => {
    const parsed = parseDesktopUpdateState(state)
    for (const { window } of registry.list()) {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.updateStateChanged, parsed)
    }
  })
}
