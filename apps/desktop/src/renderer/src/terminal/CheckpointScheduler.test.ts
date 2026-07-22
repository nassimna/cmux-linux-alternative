import { afterEach, describe, expect, it, vi } from 'vitest'

import { CheckpointScheduler } from './CheckpointScheduler'

afterEach(() => vi.useRealTimers())

describe('CheckpointScheduler', () => {
  it('checkpoints active output every five seconds', async () => {
    vi.useFakeTimers()
    const flush = vi.fn().mockResolvedValue(undefined)
    const scheduler = new CheckpointScheduler(flush)

    scheduler.recordOutput(10)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(flush).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('checkpoints after one MiB of output and after resize', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const scheduler = new CheckpointScheduler(flush)

    scheduler.recordOutput(1024 * 1024)
    await scheduler.flush()
    scheduler.afterResize()
    await scheduler.flush()

    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('retains the output threshold after a failed checkpoint so a later output retries', async () => {
    const flush = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValue(undefined)
    const scheduler = new CheckpointScheduler(flush)

    scheduler.recordOutput(1024 * 1024)
    await expect(scheduler.flush()).rejects.toThrow('service unavailable')
    scheduler.recordOutput(1)
    await scheduler.flush()

    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('runs a follow-up checkpoint when the threshold is crossed during an active flush', async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const flush = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first)
      .mockResolvedValue(undefined)
    const scheduler = new CheckpointScheduler(flush)

    scheduler.recordOutput(1024 * 1024)
    scheduler.recordOutput(3 * 64 * 1024)
    releaseFirst?.()
    await scheduler.flush()

    expect(flush).toHaveBeenCalledTimes(2)
  })
})
