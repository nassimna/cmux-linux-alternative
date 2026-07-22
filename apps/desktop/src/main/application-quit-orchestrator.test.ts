import { describe, expect, it, vi } from 'vitest'

import { ApplicationQuitOrchestrator } from './application-quit-orchestrator'

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined
  let reject: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return {
    promise,
    reject: (reason?: unknown) => reject?.(reason),
    resolve: (value: T) => resolve?.(value)
  }
}

describe('ApplicationQuitOrchestrator', () => {
  it('prevents and coalesces before-quit while cleanup is running, then requests one final quit', async () => {
    const cleanup = deferred<void>()
    const finalQuit = vi.fn()
    const orchestrator = new ApplicationQuitOrchestrator({
      cleanup: vi.fn(() => cleanup.promise),
      logFailure: vi.fn(),
      quit: finalQuit
    })
    const first = { preventDefault: vi.fn() }
    const concurrent = { preventDefault: vi.fn() }

    orchestrator.beforeQuit(first)
    orchestrator.beforeQuit(concurrent)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(concurrent.preventDefault).toHaveBeenCalledOnce()
    expect(orchestrator.isQuitStarted()).toBe(true)

    cleanup.resolve(undefined)
    await vi.waitFor(() => expect(finalQuit).toHaveBeenCalledOnce())
    orchestrator.beforeQuit({ preventDefault: vi.fn() })
    expect(finalQuit).toHaveBeenCalledOnce()
  })

  it('retains the last window while cleanup is pending and allows it to close only after cleanup', async () => {
    const cleanup = deferred<void>()
    const finalQuit = vi.fn()
    const orchestrator = new ApplicationQuitOrchestrator({
      cleanup: vi.fn(() => cleanup.promise),
      logFailure: vi.fn(),
      quit: finalQuit
    })
    finalQuit.mockImplementation(() => {
      orchestrator.beforeQuit({ preventDefault: vi.fn() })
    })
    const firstClose = { preventDefault: vi.fn() }
    const repeatedClose = { preventDefault: vi.fn() }

    orchestrator.windowClose(firstClose)
    orchestrator.windowClose(repeatedClose)

    expect(firstClose.preventDefault).toHaveBeenCalledOnce()
    expect(repeatedClose.preventDefault).toHaveBeenCalledOnce()
    expect(finalQuit).toHaveBeenCalledOnce()
    expect(orchestrator.isQuitStarted()).toBe(true)

    cleanup.resolve(undefined)
    await vi.waitFor(() => expect(finalQuit).toHaveBeenCalledTimes(2))

    const finalClose = { preventDefault: vi.fn() }
    orchestrator.windowClose(finalClose)
    expect(finalClose.preventDefault).not.toHaveBeenCalled()
  })

  it('retains the last window after failed cleanup and retries from a later close request', async () => {
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('/private/stop'))
      .mockResolvedValueOnce(undefined)
    const finalQuit = vi.fn()
    const orchestrator = new ApplicationQuitOrchestrator({
      cleanup,
      logFailure: vi.fn(),
      quit: finalQuit
    })
    finalQuit.mockImplementation(() => {
      orchestrator.beforeQuit({ preventDefault: vi.fn() })
    })

    const firstClose = { preventDefault: vi.fn() }
    orchestrator.windowClose(firstClose)
    await vi.waitFor(() => expect(orchestrator.isQuitStarted()).toBe(false))

    const retryClose = { preventDefault: vi.fn() }
    orchestrator.windowClose(retryClose)
    await vi.waitFor(() => expect(finalQuit).toHaveBeenCalledTimes(3))

    expect(firstClose.preventDefault).toHaveBeenCalledOnce()
    expect(retryClose.preventDefault).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('never permits final quit after failed cleanup and repeated attempts cannot bypass it', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('/private/service/failure'))
    const finalQuit = vi.fn()
    const logFailure = vi.fn()
    const orchestrator = new ApplicationQuitOrchestrator({ cleanup, logFailure, quit: finalQuit })
    const first = { preventDefault: vi.fn() }
    const repeated = { preventDefault: vi.fn() }

    orchestrator.beforeQuit(first)
    await vi.waitFor(() => expect(logFailure).toHaveBeenCalledTimes(1))
    orchestrator.beforeQuit(repeated)
    await vi.waitFor(() => expect(logFailure).toHaveBeenCalledTimes(2))

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(finalQuit).not.toHaveBeenCalled()
    expect(orchestrator.isQuitStarted()).toBe(false)
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('/private')
  })

  it('coalesces updater preparation and lets the updater-owned quit pass after success', async () => {
    const cleanup = deferred<void>()
    const cleanupFunction = vi.fn(() => cleanup.promise)
    const finalQuit = vi.fn()
    const orchestrator = new ApplicationQuitOrchestrator({
      cleanup: cleanupFunction,
      logFailure: vi.fn(),
      quit: finalQuit
    })

    const first = orchestrator.prepare()
    const concurrent = orchestrator.prepare()
    await Promise.resolve()
    expect(cleanupFunction).toHaveBeenCalledOnce()
    cleanup.resolve(undefined)
    await expect(Promise.all([first, concurrent])).resolves.toEqual([undefined, undefined])

    const updaterQuit = { preventDefault: vi.fn() }
    orchestrator.beforeQuit(updaterQuit)
    expect(updaterQuit.preventDefault).not.toHaveBeenCalled()
    expect(finalQuit).not.toHaveBeenCalled()
  })

  it('rejects preparation with a stable content-free error and supports an explicit retry', async () => {
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('/private/raw/error'))
      .mockResolvedValueOnce(undefined)
    const logFailure = vi.fn()
    const orchestrator = new ApplicationQuitOrchestrator({
      cleanup,
      logFailure,
      quit: vi.fn()
    })

    await expect(orchestrator.prepare()).rejects.toThrow('Application cleanup failed')
    await expect(orchestrator.prepare()).resolves.toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('/private')
  })
})
