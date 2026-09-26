import type { TerminalAttachResult, TerminalOutputChunk } from '@agent-workspace/protocol-client'

export interface TerminalWriteSink {
  reset(): void
  write(data: string | Uint8Array, callback?: () => void): void
}

export class TerminalReconciler {
  private disposed = false
  private lastSequence = 0
  private operations: Promise<void> = Promise.resolve()
  private pendingWriteResolutions = new Set<() => void>()
  private resyncRequested = false
  private writes: Promise<void> = Promise.resolve()

  public constructor(
    private readonly sink: TerminalWriteSink,
    private readonly onSequenceGap: () => void
  ) {}

  public get lastAppliedSequence(): number {
    return this.lastSequence
  }

  public async restore(snapshot: TerminalAttachResult): Promise<void> {
    return this.schedule(() => this.restoreNow(snapshot))
  }

  public async applyChunk(chunk: TerminalOutputChunk): Promise<void> {
    return this.schedule(() => this.applyChunkNow(chunk))
  }

  public whenIdle(): Promise<void> {
    return this.operations
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const resolve of this.pendingWriteResolutions) resolve()
    this.pendingWriteResolutions.clear()
  }

  private async restoreNow(snapshot: TerminalAttachResult): Promise<void> {
    this.resyncRequested = false
    this.sink.reset()
    this.writes = Promise.resolve()

    if (!snapshot.reconstructionComplete) {
      if (snapshot.checkpoint) {
        await this.enqueueWrite(snapshot.checkpoint.data)
      }
      // A truncated journal can begin inside an ANSI escape sequence or UTF-8 code point.
      // Do not replay it into a reset terminal. Acknowledge the discarded range so live
      // output can continue from the next sequence without a resync loop.
      this.lastSequence = snapshot.lastSequence
      return
    }

    if (snapshot.checkpoint) {
      await this.enqueueWrite(snapshot.checkpoint.data)
      this.lastSequence = snapshot.checkpoint.sequence
    } else {
      const firstSequence = snapshot.output.at(0)?.sequence
      this.lastSequence = firstSequence === undefined ? 0 : Math.max(0, firstSequence - 1)
    }

    for (const chunk of [...snapshot.output].sort(
      (left, right) => left.sequence - right.sequence
    )) {
      if (chunk.sequence <= this.lastSequence) {
        continue
      }
      if (chunk.sequence !== this.lastSequence + 1) {
        this.requestResync()
        break
      }
      await this.writeChunk(chunk)
    }
    if (this.lastSequence !== snapshot.lastSequence) {
      this.requestResync()
    }
  }

  private async applyChunkNow(chunk: TerminalOutputChunk): Promise<void> {
    if (chunk.sequence <= this.lastSequence) {
      return
    }
    if (chunk.sequence !== this.lastSequence + 1) {
      this.requestResync()
      return
    }
    await this.writeChunk(chunk)
  }

  private async writeChunk(chunk: TerminalOutputChunk): Promise<void> {
    let decoded: Uint8Array
    try {
      decoded = decodeBase64(chunk.data)
    } catch {
      this.requestResync()
      return
    }
    if (decoded.byteLength !== chunk.byteLength) {
      this.requestResync()
      return
    }
    await this.enqueueWrite(decoded)
    this.lastSequence = chunk.sequence
  }

  private enqueueWrite(data: string | Uint8Array): Promise<void> {
    this.writes = this.writes.then(() => {
      if (this.disposed) return
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (): void => {
          if (settled) return
          settled = true
          this.pendingWriteResolutions.delete(settle)
          resolve()
        }
        this.pendingWriteResolutions.add(settle)
        if (this.disposed) {
          settle()
          return
        }
        try {
          this.sink.write(data, settle)
        } catch (error) {
          this.pendingWriteResolutions.delete(settle)
          reject(error instanceof Error ? error : new Error('Terminal write failed'))
        }
      })
    })
    return this.writes
  }

  private requestResync(): void {
    if (!this.resyncRequested) {
      this.resyncRequested = true
      this.onSequenceGap()
    }
  }

  private schedule(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation)
    this.operations = result.catch(() => undefined)
    return result
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
