export type WindowAcquisitionCleanup = () => void | Promise<void>

export interface MainWindowAcquisitionOptions<Window> {
  clear(window: Window): void
  create(): Window
  destroy(window: Window): void
  initialize(window: Window, acquisition: MainWindowAcquisition<Window>): void | Promise<void>
  isDestroyed(window: Window): boolean
  load(window: Window): Promise<void>
  publish(window: Window): void
}

export class MainWindowAcquisition<Window> {
  readonly #cleanups: WindowAcquisitionCleanup[] = []
  #cleanupOperation: Promise<void> | undefined
  #published = false

  public constructor(
    public readonly window: Window,
    private readonly options: Pick<
      MainWindowAcquisitionOptions<Window>,
      'clear' | 'destroy' | 'isDestroyed' | 'publish'
    >
  ) {}

  public addCleanup(cleanup: WindowAcquisitionCleanup): void {
    if (this.#cleanupOperation) throw new Error('Window acquisition is already being released')
    this.#cleanups.push(cleanup)
  }

  public publish(): void {
    if (this.#published) throw new Error('Window acquisition is already published')
    if (this.options.isDestroyed(this.window)) {
      throw new Error('Window was destroyed during acquisition')
    }
    // Mark first so abort still clears ownership if the publisher itself throws after a partial
    // assignment.
    this.#published = true
    this.options.publish(this.window)
  }

  public release(): Promise<void> {
    let clearError: Error | undefined
    try {
      this.options.clear(this.window)
    } catch (error) {
      clearError = toError(error)
    }
    this.#published = false
    this.#cleanupOperation ??= this.#runCleanups()
    if (!clearError) return this.#cleanupOperation
    return this.#cleanupOperation.then(
      () => Promise.reject(clearError),
      () => Promise.reject(clearError)
    )
  }

  public async abort(): Promise<void> {
    const cleanupOperation = this.release()
    let cleanupError: Error | undefined

    try {
      if (!this.options.isDestroyed(this.window)) this.options.destroy(this.window)
    } catch (error) {
      cleanupError ??= toError(error)
    }

    try {
      await cleanupOperation
    } catch (error) {
      cleanupError ??= toError(error)
    }

    if (cleanupError) throw cleanupError
  }

  async #runCleanups(): Promise<void> {
    let cleanupError: Error | undefined
    for (const cleanup of this.#cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        cleanupError ??= toError(error)
      }
    }
    if (cleanupError) throw cleanupError
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Main-window cleanup failed', { cause: error })
}

export async function acquireMainWindow<Window>(
  options: MainWindowAcquisitionOptions<Window>
): Promise<Window> {
  const window = options.create()
  const acquisition = new MainWindowAcquisition(window, options)

  try {
    await options.initialize(window, acquisition)
    acquisition.publish()
    await options.load(window)
    return window
  } catch (error) {
    await acquisition.abort().catch(() => undefined)
    throw error
  }
}
