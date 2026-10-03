import { describe, expect, it, vi } from 'vitest'

import { TerminalReconciler, type TerminalWriteSink } from './TerminalReconciler'

function sink(): TerminalWriteSink & { output: Array<string | Uint8Array> } {
  return {
    output: [],
    reset: vi.fn(),
    write(data, callback) {
      this.output.push(data)
      callback?.()
    }
  }
}

const terminal = {
  id: '3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30',
  processId: 42,
  command: ['/bin/sh'],
  cwd: '/tmp',
  rows: 24,
  cols: 80,
  exited: false
}

describe('TerminalReconciler', () => {
  it('restores a checkpoint and journal without waiting for new output', async () => {
    const terminalSink = sink()
    const reconciler = new TerminalReconciler(terminalSink, vi.fn())

    await reconciler.restore({
      terminal,
      checkpoint: {
        sequence: 7,
        rows: 24,
        cols: 80,
        activeBuffer: 'normal',
        data: 'serialized-screen'
      },
      output: [{ sequence: 8, data: 'YWZ0ZXI=', byteLength: 5 }],
      lastSequence: 8,
      reconstructionComplete: true
    })

    expect(terminalSink.output[0]).toBe('serialized-screen')
    expect(new TextDecoder().decode(terminalSink.output[1] as Uint8Array)).toBe('after')
    expect(reconciler.lastAppliedSequence).toBe(8)
  })

  it('deduplicates replayed chunks and detects a sequence gap', async () => {
    const onGap = vi.fn()
    const reconciler = new TerminalReconciler(sink(), onGap)
    await reconciler.restore({
      terminal,
      output: [{ sequence: 1, data: 'YQ==', byteLength: 1 }],
      lastSequence: 1,
      reconstructionComplete: true
    })

    await reconciler.applyChunk({ sequence: 1, data: 'YQ==', byteLength: 1 })
    await reconciler.applyChunk({ sequence: 3, data: 'Yw==', byteLength: 1 })

    expect(reconciler.lastAppliedSequence).toBe(1)
    expect(onGap).toHaveBeenCalledTimes(1)
  })

  it('keeps the last safe checkpoint and discards an incomplete journal', async () => {
    const onGap = vi.fn()
    const terminalSink = sink()
    const reconciler = new TerminalReconciler(terminalSink, onGap)

    await reconciler.restore({
      terminal,
      checkpoint: {
        sequence: 7,
        rows: 24,
        cols: 80,
        activeBuffer: 'normal',
        data: 'serialized-screen'
      },
      output: [{ sequence: 9, data: 'bWlzc2luZy04', byteLength: 9 }],
      lastSequence: 9,
      reconstructionComplete: false
    })

    expect(terminalSink.output).toEqual(['serialized-screen'])
    expect(reconciler.lastAppliedSequence).toBe(9)
    expect(onGap).not.toHaveBeenCalled()
  })

  it('resets to a clean view when the startup journal was truncated before a checkpoint', async () => {
    const onGap = vi.fn()
    const terminalSink = sink()
    const reconciler = new TerminalReconciler(terminalSink, onGap)

    await reconciler.restore({
      terminal,
      output: [{ sequence: 7, data: 'G1szMW0=', byteLength: 5 }],
      lastSequence: 7,
      reconstructionComplete: false
    })

    expect(terminalSink.output).toEqual([])
    expect(reconciler.lastAppliedSequence).toBe(7)
    expect(onGap).not.toHaveBeenCalled()

    await reconciler.applyChunk({ sequence: 8, data: 'bGl2ZQ==', byteLength: 4 })

    expect(new TextDecoder().decode(terminalSink.output[0] as Uint8Array)).toBe('live')
    expect(reconciler.lastAppliedSequence).toBe(8)
  })

  it('batches concurrent live chunks and acknowledges them only after parsing', async () => {
    const callbacks: Array<() => void> = []
    const terminalSink: TerminalWriteSink & { output: Array<string | Uint8Array> } = {
      output: [],
      reset: vi.fn(),
      write(data, callback) {
        this.output.push(data)
        if (callback) {
          callbacks.push(callback)
        }
      }
    }
    const onGap = vi.fn()
    const reconciler = new TerminalReconciler(terminalSink, onGap)
    await reconciler.restore({
      terminal,
      output: [],
      lastSequence: 0,
      reconstructionComplete: true
    })

    const first = reconciler.applyChunk({ sequence: 1, data: 'YQ==', byteLength: 1 })
    const second = reconciler.applyChunk({ sequence: 2, data: 'Yg==', byteLength: 1 })
    await vi.waitFor(() => expect(terminalSink.output).toHaveLength(1))
    expect(new TextDecoder().decode(terminalSink.output[0] as Uint8Array)).toBe('ab')
    expect(reconciler.lastAppliedSequence).toBe(0)
    const idle = vi.fn()
    void reconciler.whenIdle().then(idle)
    await Promise.resolve()
    expect(idle).not.toHaveBeenCalled()
    callbacks.shift()?.()
    await Promise.all([first, second, reconciler.whenIdle()])

    expect(reconciler.lastAppliedSequence).toBe(2)
    expect(onGap).not.toHaveBeenCalled()
  })

  it('bounds writes while draining a burst larger than one batch', async () => {
    const callbacks: Array<() => void> = []
    const writes: Uint8Array[] = []
    const reconciler = new TerminalReconciler(
      {
        reset: vi.fn(),
        write: (data, callback) => {
          writes.push(data as Uint8Array)
          if (callback) callbacks.push(callback)
        }
      },
      vi.fn()
    )
    const data = btoa('x'.repeat(64 * 1024))
    const pending = Array.from({ length: 5 }, (_, index) =>
      reconciler.applyChunk({ sequence: index + 1, data, byteLength: 64 * 1024 })
    )
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toHaveLength(256 * 1024)
    expect(reconciler.lastAppliedSequence).toBe(0)
    callbacks.shift()?.()
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]).toHaveLength(64 * 1024)
    expect(reconciler.lastAppliedSequence).toBe(4)
    callbacks.shift()?.()
    await Promise.all(pending)
    expect(reconciler.lastAppliedSequence).toBe(5)
  })

  it('preserves split UTF-8 and ANSI bytes and skips duplicate output within a batch', async () => {
    const terminalSink = sink()
    const reconciler = new TerminalReconciler(terminalSink, vi.fn())
    const bytes = new TextEncoder().encode('\u001b[31m中文🚀\u001b[0m')
    const chunks = [bytes.slice(0, 2), bytes.slice(2, 7), bytes.slice(7)].map((part, index) => ({
      sequence: index + 1,
      data: btoa(String.fromCharCode(...part)),
      byteLength: part.byteLength
    }))
    await Promise.all([
      reconciler.applyChunk(chunks[0]!),
      reconciler.applyChunk(chunks[0]!),
      reconciler.applyChunk(chunks[1]!),
      reconciler.applyChunk(chunks[2]!)
    ])
    expect(terminalSink.output).toEqual([bytes])
    expect(reconciler.lastAppliedSequence).toBe(3)
  })

  it('does not acknowledge corrupt chunks or write across a missing sequence', async () => {
    const terminalSink = sink()
    const onGap = vi.fn()
    const reconciler = new TerminalReconciler(terminalSink, onGap)
    await Promise.all([
      reconciler.applyChunk({ sequence: 1, data: 'YQ==', byteLength: 1 }),
      reconciler.applyChunk({ sequence: 2, data: 'Yg==', byteLength: 2 }),
      reconciler.applyChunk({ sequence: 3, data: 'Yw==', byteLength: 1 })
    ])
    expect(new TextDecoder().decode(terminalSink.output[0] as Uint8Array)).toBe('a')
    expect(reconciler.lastAppliedSequence).toBe(1)
    expect(onGap).toHaveBeenCalledOnce()
  })

  it('keeps a restore between earlier and later live output while parsing is pending', async () => {
    const callbacks: Array<() => void> = []
    const writes: Array<string | Uint8Array> = []
    const reset = vi.fn()
    const reconciler = new TerminalReconciler(
      {
        reset,
        write: (data, callback) => {
          writes.push(data)
          if (callback) callbacks.push(callback)
        }
      },
      vi.fn()
    )
    const first = reconciler.applyChunk({ sequence: 1, data: 'YQ==', byteLength: 1 })
    const restoring = reconciler.restore({
      terminal,
      checkpoint: { sequence: 7, rows: 24, cols: 80, activeBuffer: 'normal', data: 'checkpoint' },
      output: [],
      lastSequence: 7,
      reconstructionComplete: true
    })
    const last = reconciler.applyChunk({ sequence: 8, data: 'Yg==', byteLength: 1 })
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(reset).not.toHaveBeenCalled()
    callbacks.shift()?.()
    await first
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(reset).toHaveBeenCalledOnce()
    expect(writes[1]).toBe('checkpoint')
    callbacks.shift()?.()
    await restoring
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    callbacks.shift()?.()
    await last
    expect(new TextDecoder().decode(writes[2] as Uint8Array)).toBe('b')
    expect(reconciler.lastAppliedSequence).toBe(8)
  })

  it('settles a pending xterm write when disposed', async () => {
    const terminalSink: TerminalWriteSink & { output: Array<string | Uint8Array> } = {
      output: [],
      reset: vi.fn(),
      write(data) {
        this.output.push(data)
      }
    }
    const reconciler = new TerminalReconciler(terminalSink, vi.fn())
    const restoring = reconciler.restore({
      terminal,
      output: [{ sequence: 1, data: 'YQ==', byteLength: 1 }],
      lastSequence: 1,
      reconstructionComplete: true
    })
    await vi.waitFor(() => expect(terminalSink.output).toHaveLength(1))

    reconciler.dispose()

    await expect(restoring).resolves.toBeUndefined()
    await expect(reconciler.whenIdle()).resolves.toBeUndefined()
  })
})
