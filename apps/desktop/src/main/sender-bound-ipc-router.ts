import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { WindowRegistry, WindowRegistryEntry } from './window-registry'

export type SenderBoundHandler = (
  entry: WindowRegistryEntry,
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown

export interface IpcHandlerHost {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ): void
  removeHandler(channel: string): void
}

/** Registers global IPC once while resolving privilege from the current sender. */
export class SenderBoundIpcRouter {
  readonly #channels = new Set<string>()

  public constructor(
    private readonly registry: WindowRegistry,
    private readonly host: IpcHandlerHost = ipcMain
  ) {}

  public handle(channel: string, handler: SenderBoundHandler): void {
    if (this.#channels.has(channel)) return
    this.host.handle(channel, (event, ...args) => {
      const entry = this.registry.resolveSender(event)
      return handler(entry, event, ...args)
    })
    this.#channels.add(channel)
  }

  public remove(channel: string): void {
    if (!this.#channels.delete(channel)) return
    this.host.removeHandler(channel)
  }

  public dispose(): void {
    for (const channel of this.#channels) this.host.removeHandler(channel)
    this.#channels.clear()
  }
}
