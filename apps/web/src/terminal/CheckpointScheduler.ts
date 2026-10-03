const CHECKPOINT_INTERVAL_MS = 5_000
const OUTPUT_THRESHOLD_BYTES = 1024 * 1024

export class CheckpointScheduler {
  private bytesSinceCheckpoint = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> | undefined
  private needsFlush = false
  private disposed = false

  public constructor(private readonly flushCheckpoint: () => Promise<void>) {}

  public recordOutput(byteLength: number): void {
    if (this.disposed) {
      return
    }
    this.bytesSinceCheckpoint += byteLength
    if (this.bytesSinceCheckpoint >= OUTPUT_THRESHOLD_BYTES) {
      this.scheduleFlush()
      return
    }
    this.timer ??= setTimeout(() => this.scheduleFlush(), CHECKPOINT_INTERVAL_MS)
  }

  public afterResize(): void {
    if (!this.disposed) {
      this.scheduleFlush()
    }
  }

  public request(): void {
    if (!this.disposed) {
      this.scheduleFlush()
    }
  }

  public async flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing
    }
    this.needsFlush = true
    this.clearTimer()
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }

  public dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private scheduleFlush(): void {
    this.needsFlush = true
    this.clearTimer()
    if (!this.flushing) {
      void this.flush().catch(() => undefined)
    }
  }

  private async drain(): Promise<void> {
    while (this.needsFlush && !this.disposed) {
      this.needsFlush = false
      const bytesAtStart = this.bytesSinceCheckpoint
      try {
        await this.flushCheckpoint()
        this.bytesSinceCheckpoint = Math.max(0, this.bytesSinceCheckpoint - bytesAtStart)
      } catch (error) {
        this.needsFlush = true
        throw error
      }
    }
  }
}
