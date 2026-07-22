export interface WindowCreationCoordinatorOptions<Window, State> {
  getCurrentWindow(): Window | undefined
  isWindowLive(window: Window): boolean
  isQuitStarted(): boolean
  resolveState(): Promise<State>
  createWindow(state: State): Promise<Window>
  discardWindow(window: Window): void
}

export class WindowCreationCoordinator<Window, State> {
  readonly #options: WindowCreationCoordinatorOptions<Window, State>
  #inFlight: Promise<Window | undefined> | undefined

  public constructor(options: WindowCreationCoordinatorOptions<Window, State>) {
    this.#options = options
  }

  public ensureWindow(): Promise<Window | undefined> {
    if (this.#options.isQuitStarted()) return Promise.resolve(undefined)
    if (this.#inFlight) return this.#inFlight

    const currentWindow = this.#liveCurrentWindow()
    if (currentWindow) return Promise.resolve(currentWindow)

    const attempt = this.#createWindow().finally(() => {
      if (this.#inFlight === attempt) this.#inFlight = undefined
    })
    this.#inFlight = attempt
    return attempt
  }

  async #createWindow(): Promise<Window | undefined> {
    const state = await this.#options.resolveState()
    if (this.#options.isQuitStarted()) return undefined

    const currentWindow = this.#liveCurrentWindow()
    if (currentWindow) return currentWindow

    const createdWindow = await this.#options.createWindow(state)
    if (this.#options.isQuitStarted()) {
      this.#discardWindow(createdWindow)
      return undefined
    }

    const currentWindowAfterCreation = this.#liveCurrentWindow()
    if (currentWindowAfterCreation) {
      if (currentWindowAfterCreation !== createdWindow) this.#discardWindow(createdWindow)
      return currentWindowAfterCreation
    }
    return this.#options.isWindowLive(createdWindow) ? createdWindow : undefined
  }

  #discardWindow(window: Window): void {
    if (this.#options.isWindowLive(window)) this.#options.discardWindow(window)
  }

  #liveCurrentWindow(): Window | undefined {
    const window = this.#options.getCurrentWindow()
    return window && this.#options.isWindowLive(window) ? window : undefined
  }
}

export class OwnedBinding<Owner> {
  #binding: { owner: Owner; dispose(): void } | undefined

  public replace(owner: Owner, dispose: () => void): void {
    this.clear()
    this.#binding = { owner, dispose: once(dispose) }
  }

  public clear(owner?: Owner): boolean {
    const binding = this.#binding
    if (!binding || (owner !== undefined && binding.owner !== owner)) return false
    this.#binding = undefined
    binding.dispose()
    return true
  }
}

function once(dispose: () => void): () => void {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    dispose()
  }
}
