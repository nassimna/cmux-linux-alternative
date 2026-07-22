export interface WindowCreationEntrypointsOptions<Window> {
  createWindow(): Promise<Window | undefined>
  getLiveWindow(): Window | undefined
  hasLiveWindow(): boolean
  isQuitStarted(): boolean
  isWindowLive(window: Window): boolean
  logError(message: string): void
  quit(): void
}

export class WindowCreationEntrypoints<Window> {
  readonly #options: WindowCreationEntrypointsOptions<Window>

  public constructor(options: WindowCreationEntrypointsOptions<Window>) {
    this.#options = options
  }

  public async recoverStartup(error: unknown, canRetry: boolean): Promise<void> {
    void error
    this.#options.logError('Desktop startup failed safely')
    if (this.#options.isQuitStarted()) return

    if (!canRetry || this.#options.hasLiveWindow()) {
      this.#options.quit()
      return
    }

    try {
      await this.#options.createWindow()
      if (!this.#options.isQuitStarted() && !this.#options.hasLiveWindow()) this.#options.quit()
    } catch {
      this.#options.logError('Desktop startup recovery failed safely')
      if (!this.#options.isQuitStarted()) this.#options.quit()
    }
  }

  public activate(): Promise<void> {
    return this.#createForEntrypoint('Desktop activation failed safely')
  }

  public secondInstance(onWindow: (window: Window) => void): Promise<void> {
    const liveWindow = this.#options.getLiveWindow()
    if (liveWindow && this.#options.isWindowLive(liveWindow)) {
      onWindow(liveWindow)
      return Promise.resolve()
    }
    return this.#createForEntrypoint('Desktop second-instance handling failed safely', onWindow)
  }

  async #createForEntrypoint(
    errorMessage: string,
    onWindow?: (window: Window) => void
  ): Promise<void> {
    if (this.#options.isQuitStarted()) return

    try {
      const window = await this.#options.createWindow()
      if (!window || this.#options.isQuitStarted() || !this.#options.isWindowLive(window)) {
        return
      }
      onWindow?.(window)
    } catch {
      this.#options.logError(errorMessage)
      if (!this.#options.isQuitStarted() && !this.#options.hasLiveWindow()) this.#options.quit()
    }
  }
}
