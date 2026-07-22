import type { BrowserViewManager } from './browser-view-manager'
import type { WindowRegistryBinding } from './window-registry'
import type { WindowStateController } from './window-state-controller'
import type { ControlClient } from './control-client'

/** Mutable lifecycle behind an otherwise stable WindowRegistry entry. */
export class DesktopWindowBinding implements WindowRegistryBinding {
  #browserViews: BrowserViewManager | undefined
  #disposeReady: (() => Promise<void>) | undefined
  #client: ControlClient | undefined
  #disposed = false

  public constructor(public readonly stateController: WindowStateController) {}

  public get browserViews(): BrowserViewManager {
    if (!this.#browserViews) throw new Error('Window renderer is not ready')
    return this.#browserViews
  }

  public get client(): ControlClient {
    if (!this.#client) throw new Error('Window renderer is not ready')
    return this.#client
  }

  public replaceReady(
    client: ControlClient,
    browserViews: BrowserViewManager,
    dispose: () => Promise<void>
  ): void {
    if (this.#disposed) throw new Error('Window binding is disposed')
    if (this.#browserViews) throw new Error('Window renderer is already bound')
    this.#browserViews = browserViews
    this.#client = client
    this.#disposeReady = dispose
  }

  public async clearReady(): Promise<void> {
    const dispose = this.#disposeReady
    this.#disposeReady = undefined
    this.#browserViews = undefined
    this.#client = undefined
    await dispose?.()
    this.stateController.clearClient()
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.clearReady()
    await this.stateController.dispose()
  }
}
