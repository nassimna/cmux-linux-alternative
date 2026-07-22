export interface DesktopProviderLease {
  readonly leaseId: string
  readonly heartbeatIntervalMs: number
  readonly providerEpoch?: number
}

export interface DesktopProviderRequest {
  readonly requestId: string
}

export interface DesktopProviderTransport<
  TRequest extends DesktopProviderRequest,
  TAcknowledgement
> {
  register(): Promise<DesktopProviderLease>
  heartbeat(leaseId: string): Promise<void>
  unregister(leaseId: string): Promise<void>
  poll(leaseId: string, signal: AbortSignal): Promise<TRequest | null>
  acknowledge(leaseId: string, acknowledgement: TAcknowledgement): Promise<void>
  cancel(leaseId: string, requestId: string, reason: string): Promise<void>
}

export interface DesktopProviderControllerOptions<
  TRequest extends DesktopProviderRequest,
  TAcknowledgement
> {
  transport: DesktopProviderTransport<TRequest, TAcknowledgement>
  execute(request: TRequest, signal: AbortSignal): Promise<TAcknowledgement>
  executionFailed?(request: TRequest, error: unknown): TAcknowledgement
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  cancelSchedule(handle: ReturnType<typeof setTimeout>): void
  logError(message: string, error?: unknown): void
  onLeaseLost?(reason: string): Promise<void> | void
  acknowledged?(request: TRequest, acknowledgement: TAcknowledgement): Promise<void> | void
  maxSeenRequests?: number
  acknowledgementCache?: DesktopProviderAcknowledgementCache<TAcknowledgement>
  /** Register and heartbeat immediately, but wait for exact native-window bindings before polling. */
  deferPolling?: boolean
}

/**
 * Process-owned acknowledgement memory. A replacement controller for the same
 * provider epoch reuses exact acknowledgements after an ack response is lost.
 */
export class DesktopProviderAcknowledgementCache<TAcknowledgement> {
  readonly #acknowledgements = new Map<string, TAcknowledgement>()
  #providerEpoch: number | undefined

  public constructor(private readonly maximum = 1024) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65_536) {
      throw new Error('Invalid desktop-provider deduplication capacity')
    }
  }

  public useProviderEpoch(providerEpoch: number | undefined): void {
    if (providerEpoch === this.#providerEpoch) return
    this.#providerEpoch = providerEpoch
    this.#acknowledgements.clear()
  }

  public get(requestId: string): TAcknowledgement | undefined {
    return this.#acknowledgements.get(requestId)
  }

  public remember(requestId: string, acknowledgement: TAcknowledgement): void {
    this.#acknowledgements.set(requestId, acknowledgement)
    while (this.#acknowledgements.size > this.maximum) {
      const oldest = this.#acknowledgements.keys().next().value
      if (oldest === undefined) break
      this.#acknowledgements.delete(oldest)
    }
  }
}

/**
 * Owns one private desktop-provider lease. Polling and execution are serialized,
 * request IDs are consumed at most once, and stop aborts/cancels in-flight work
 * before unregistering the lease.
 */
export class DesktopProviderController<TRequest extends DesktopProviderRequest, TAcknowledgement> {
  readonly #activeRequests = new Map<string, AbortController>()
  readonly #acknowledgementCache: DesktopProviderAcknowledgementCache<TAcknowledgement>
  #lease: DesktopProviderLease | undefined
  #heartbeat: ReturnType<typeof setTimeout> | undefined
  #pollAbort: AbortController | undefined
  #polling: Promise<void> | undefined
  #pausing: Promise<void> | undefined
  #starting: Promise<void> | undefined
  #generation = 0

  public constructor(
    private readonly options: DesktopProviderControllerOptions<TRequest, TAcknowledgement>
  ) {
    this.#acknowledgementCache =
      options.acknowledgementCache ??
      new DesktopProviderAcknowledgementCache(options.maxSeenRequests ?? 1024)
  }

  public async start(): Promise<void> {
    if (this.#lease) return
    if (this.#starting) return this.#starting
    const starting = this.startLease()
    this.#starting = starting
    try {
      await starting
    } finally {
      if (this.#starting === starting) this.#starting = undefined
    }
  }

  private async startLease(): Promise<void> {
    const generation = ++this.#generation
    const lease = await this.options.transport.register()
    if (generation !== this.#generation) {
      await this.options.transport.unregister(lease.leaseId).catch(() => undefined)
      return
    }
    if (!Number.isSafeInteger(lease.heartbeatIntervalMs) || lease.heartbeatIntervalMs < 100) {
      await this.options.transport.unregister(lease.leaseId).catch(() => undefined)
      throw new Error('Invalid desktop-provider heartbeat interval')
    }
    this.#acknowledgementCache.useProviderEpoch(lease.providerEpoch)
    this.#lease = lease
    this.scheduleHeartbeat(generation)
    if (!this.options.deferPolling) this.startPolling()
  }

  public startPolling(): void {
    const lease = this.#lease
    const generation = this.#generation
    if (!lease) throw new Error('Desktop-provider lease is unavailable')
    if (this.#polling) return
    this.#pollAbort = new AbortController()
    this.#polling = this.pollLoop(lease, generation, this.#pollAbort.signal)
  }

  /**
   * Quiesces provider work without surrendering the lease. Renderer generation
   * changes use this barrier so no request can execute against stale bindings.
   */
  public async pausePolling(reason = 'desktop provider polling paused'): Promise<void> {
    if (this.#pausing) return this.#pausing
    const pausing = this.pausePollLoop(reason)
    this.#pausing = pausing
    try {
      await pausing
    } finally {
      if (this.#pausing === pausing) this.#pausing = undefined
    }
  }

  private async pausePollLoop(reason: string): Promise<void> {
    const lease = this.#lease
    const polling = this.#polling
    this.#pollAbort?.abort(reason)
    this.#pollAbort = undefined
    for (const controller of this.#activeRequests.values()) controller.abort(reason)
    if (lease) {
      await Promise.allSettled(
        [...this.#activeRequests.keys()].map((requestId) =>
          this.options.transport.cancel(lease.leaseId, requestId, reason)
        )
      )
    }
    await polling?.catch(() => undefined)
    this.#activeRequests.clear()
    if (this.#polling === polling) this.#polling = undefined
  }

  public async stop(reason = 'desktop provider disconnected'): Promise<void> {
    await this.stopLease(reason, false)
  }

  private async stopLease(reason: string, calledFromPoll: boolean): Promise<void> {
    this.#generation += 1
    const lease = this.#lease
    this.#lease = undefined
    if (this.#heartbeat) this.options.cancelSchedule(this.#heartbeat)
    this.#heartbeat = undefined
    this.#pollAbort?.abort(reason)
    this.#pollAbort = undefined
    for (const controller of this.#activeRequests.values()) controller.abort(reason)
    if (lease) {
      await Promise.allSettled(
        [...this.#activeRequests.keys()].map((requestId) =>
          this.options.transport.cancel(lease.leaseId, requestId, reason)
        )
      )
    }
    this.#activeRequests.clear()
    if (!calledFromPoll) await this.#polling?.catch(() => undefined)
    this.#polling = undefined
    if (lease) await this.options.transport.unregister(lease.leaseId).catch(() => undefined)
  }

  public get active(): boolean {
    return this.#lease !== undefined
  }

  public get activeRequestCount(): number {
    return this.#activeRequests.size
  }

  public async heartbeatNow(): Promise<void> {
    const lease = this.#lease
    const generation = this.#generation
    if (!lease) throw new Error('Desktop-provider lease is unavailable')
    if (this.#heartbeat) this.options.cancelSchedule(this.#heartbeat)
    this.#heartbeat = undefined
    try {
      await this.options.transport.heartbeat(lease.leaseId)
    } catch (error) {
      this.options.logError('Desktop-provider heartbeat failed', error)
      await this.handleLeaseLoss('desktop provider lease lost')
      throw error
    }
    this.scheduleHeartbeat(generation)
  }

  private scheduleHeartbeat(generation: number): void {
    const lease = this.#lease
    if (!lease || generation !== this.#generation) return
    this.#heartbeat = this.options.schedule(() => {
      this.#heartbeat = undefined
      void this.options.transport
        .heartbeat(lease.leaseId)
        .then(() => this.scheduleHeartbeat(generation))
        .catch((error) => {
          this.options.logError('Desktop-provider heartbeat failed', error)
          void this.handleLeaseLoss('desktop provider lease lost')
        })
    }, lease.heartbeatIntervalMs)
  }

  private async pollLoop(
    lease: DesktopProviderLease,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted && generation === this.#generation && this.#lease === lease) {
      let request: TRequest | null
      try {
        request = await this.options.transport.poll(lease.leaseId, signal)
      } catch (error) {
        if (signal.aborted) return
        this.options.logError('Desktop-provider poll failed', error)
        await this.handleLeaseLoss('desktop provider poll failed', true)
        return
      }
      if (!request || signal.aborted) continue
      const previousAcknowledgement = this.#acknowledgementCache.get(request.requestId)
      if (previousAcknowledgement !== undefined) {
        try {
          await this.options.transport.acknowledge(lease.leaseId, previousAcknowledgement)
          await this.options.acknowledged?.(request, previousAcknowledgement)
        } catch (error) {
          this.options.logError('Desktop-provider acknowledgement failed', error)
          await this.handleLeaseLoss('desktop provider acknowledgement failed', true)
          return
        }
        continue
      }
      const execution = new AbortController()
      this.#activeRequests.set(request.requestId, execution)
      try {
        const acknowledgement = await this.options.execute(request, execution.signal)
        if (!execution.signal.aborted && generation === this.#generation && this.#lease === lease) {
          this.rememberAcknowledgement(request.requestId, acknowledgement)
          try {
            await this.options.transport.acknowledge(lease.leaseId, acknowledgement)
            await this.options.acknowledged?.(request, acknowledgement)
          } catch (error) {
            this.options.logError('Desktop-provider acknowledgement failed', error)
            await this.handleLeaseLoss('desktop provider acknowledgement failed', true)
            return
          }
        }
      } catch (error) {
        if (!execution.signal.aborted) {
          this.options.logError('Desktop-provider execution failed', error)
          const acknowledgement = this.options.executionFailed?.(request, error)
          if (acknowledgement !== undefined) {
            this.rememberAcknowledgement(request.requestId, acknowledgement)
            try {
              await this.options.transport.acknowledge(lease.leaseId, acknowledgement)
              await this.options.acknowledged?.(request, acknowledgement)
            } catch (acknowledgementError) {
              this.options.logError('Desktop-provider acknowledgement failed', acknowledgementError)
              await this.handleLeaseLoss('desktop provider acknowledgement failed', true)
              return
            }
          } else {
            const canceled = await this.cancelRequest(
              lease,
              request.requestId,
              error instanceof Error ? error.message : 'desktop action failed'
            )
            if (!canceled) {
              await this.handleLeaseLoss('desktop provider cancellation failed', true)
              return
            }
          }
        }
      } finally {
        this.#activeRequests.delete(request.requestId)
      }
    }
  }

  private rememberAcknowledgement(requestId: string, acknowledgement: TAcknowledgement): void {
    this.#acknowledgementCache.remember(requestId, acknowledgement)
  }

  private async handleLeaseLoss(reason: string, calledFromPoll = false): Promise<void> {
    await this.stopLease(reason, calledFromPoll)
    await this.options.onLeaseLost?.(reason)
  }

  private async cancelRequest(
    lease: DesktopProviderLease,
    requestId: string,
    reason: string
  ): Promise<boolean> {
    try {
      await this.options.transport.cancel(lease.leaseId, requestId, reason)
      return true
    } catch (error) {
      this.options.logError('Desktop-provider cancellation failed', error)
      return false
    }
  }
}
