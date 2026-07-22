export interface ProviderRecoveryCoordinatorOptions<TContext> {
  readonly delaysMs: readonly number[]
  readonly recover: (context: TContext) => Promise<boolean>
  readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly cancelSchedule: (handle: ReturnType<typeof setTimeout>) => void
  readonly sameContext?: (left: TContext, right: TContext) => boolean
  readonly logError?: (error: unknown) => void
}

/** Runs at most one bounded provider recovery series and fences late attempts after cancellation. */
export class ProviderRecoveryCoordinator<TContext> {
  #attempt = 0
  #context: TContext | undefined
  #generation = 0
  #running = false
  #scheduled: ReturnType<typeof setTimeout> | undefined

  public constructor(private readonly options: ProviderRecoveryCoordinatorOptions<TContext>) {
    if (
      options.delaysMs.length === 0 ||
      options.delaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
    ) {
      throw new Error('Provider recovery requires bounded non-negative retry delays')
    }
  }

  public request(context: TContext): void {
    if (
      this.#context !== undefined &&
      (this.options.sameContext?.(this.#context, context) ?? this.#context === context)
    ) {
      return
    }
    this.cancel()
    this.#context = context
    this.#attempt = 0
    const generation = this.#generation
    if (!this.#running) this.schedule(generation)
  }

  public cancel(): void {
    this.#generation += 1
    if (this.#scheduled) this.options.cancelSchedule(this.#scheduled)
    this.#scheduled = undefined
    this.#context = undefined
    this.#attempt = 0
  }

  public get active(): boolean {
    return this.#context !== undefined
  }

  private schedule(generation: number): void {
    const delay = this.options.delaysMs[this.#attempt]
    if (delay === undefined || generation !== this.#generation || this.#context === undefined) {
      this.#context = undefined
      return
    }
    this.#scheduled = this.options.schedule(() => {
      this.#scheduled = undefined
      void this.run(generation)
    }, delay)
  }

  private async run(generation: number): Promise<void> {
    const context = this.#context
    if (this.#running || context === undefined || generation !== this.#generation) return
    this.#running = true
    let recovered = false
    try {
      recovered = await this.options.recover(context)
    } catch (error) {
      this.options.logError?.(error)
    } finally {
      this.#running = false
    }
    if (generation !== this.#generation || this.#context !== context) {
      if (this.#context !== undefined && !this.#scheduled) this.schedule(this.#generation)
      return
    }
    if (recovered) {
      this.#context = undefined
      this.#attempt = 0
      return
    }
    this.#attempt += 1
    this.schedule(generation)
  }
}
