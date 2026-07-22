import { describe, expect, it, vi } from 'vitest'

import { ProviderRecoveryCoordinator } from './provider-recovery-coordinator'

describe('ProviderRecoveryCoordinator', () => {
  it('uses bounded backoff and remains single-flight', async () => {
    vi.useFakeTimers()
    const recover = vi.fn().mockResolvedValue(false)
    const coordinator = createCoordinator(recover, [0, 10, 20])

    coordinator.request('lease-a')
    coordinator.request('lease-a')
    await vi.runAllTimersAsync()

    expect(recover).toHaveBeenCalledTimes(3)
    expect(coordinator.active).toBe(false)
    vi.useRealTimers()
  })

  it('cancels shutdown retries and ignores a late recovery result', async () => {
    vi.useFakeTimers()
    let finish!: (recovered: boolean) => void
    const recover = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const coordinator = createCoordinator(recover, [0, 10])

    coordinator.request('lease-a')
    await vi.advanceTimersByTimeAsync(0)
    coordinator.cancel()
    finish(false)
    await Promise.resolve()
    await vi.runAllTimersAsync()

    expect(recover).toHaveBeenCalledTimes(1)
    expect(coordinator.active).toBe(false)
    vi.useRealTimers()
  })

  it('fences an old in-flight recovery from clobbering a newer provider request', async () => {
    vi.useFakeTimers()
    const completions = new Map<string, (value: boolean) => void>()
    const recover = vi.fn(
      (context: string) =>
        new Promise<boolean>((resolve) => {
          completions.set(context, resolve)
        })
    )
    const coordinator = createCoordinator(recover, [0, 10])

    coordinator.request('old')
    await vi.advanceTimersByTimeAsync(0)
    coordinator.request('new')
    completions.get('old')?.(false)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    completions.get('new')?.(true)
    await Promise.resolve()

    expect(recover.mock.calls.map(([context]) => context)).toEqual(['old', 'new'])
    expect(coordinator.active).toBe(false)
    vi.useRealTimers()
  })
})

function createCoordinator(
  recover: (context: string) => Promise<boolean>,
  delaysMs: readonly number[]
): ProviderRecoveryCoordinator<string> {
  return new ProviderRecoveryCoordinator({
    delaysMs,
    recover,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle)
  })
}
