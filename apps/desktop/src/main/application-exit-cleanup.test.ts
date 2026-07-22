import { describe, expect, it, vi } from 'vitest'

import { performExitCleanup } from './application-exit-cleanup'
import { ApplicationQuitOrchestrator } from './application-quit-orchestrator'

describe('performExitCleanup', () => {
  it('retains the live window on shutdown refusal and completes a later quit retry', async () => {
    const flushWindowState = vi.fn().mockResolvedValue(undefined)
    const stopService = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('/private/termination/detail'))
      .mockResolvedValueOnce(undefined)
    let windowState: 'ready' | 'shutdown-failed' | 'released' = 'ready'
    const reconcileShutdownFailure = vi.fn(() => {
      windowState = 'shutdown-failed'
      return Promise.resolve()
    })
    const commitTeardown = vi.fn(() => {
      windowState = 'released'
      return Promise.resolve()
    })
    const cleanup = (): Promise<void> =>
      performExitCleanup({
        commitTeardown,
        flushWindowState,
        reconcileShutdownFailure,
        stopService
      })
    const finalQuit = vi.fn()
    const logFailure = vi.fn()
    const orchestrator = new ApplicationQuitOrchestrator({ cleanup, logFailure, quit: finalQuit })

    orchestrator.beforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(logFailure).toHaveBeenCalledOnce())

    expect(windowState).toBe('shutdown-failed')
    expect(commitTeardown).not.toHaveBeenCalled()
    expect(finalQuit).not.toHaveBeenCalled()
    expect(orchestrator.isQuitStarted()).toBe(false)

    orchestrator.beforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(finalQuit).toHaveBeenCalledOnce())

    expect(windowState).toBe('released')
    expect(stopService).toHaveBeenCalledTimes(2)
    expect(commitTeardown).toHaveBeenCalledOnce()
    expect(JSON.stringify(logFailure.mock.calls)).not.toContain('/private')
  })

  it('does not commit teardown when shutdown reconciliation itself fails', async () => {
    const commitTeardown = vi.fn()

    await expect(
      performExitCleanup({
        commitTeardown,
        flushWindowState: vi.fn(),
        stopService: vi.fn().mockRejectedValue(new Error('/private/stop')),
        reconcileShutdownFailure: vi.fn().mockRejectedValue(new Error('/private/reconcile'))
      })
    ).rejects.toThrow('Application service shutdown failed')

    expect(commitTeardown).not.toHaveBeenCalled()
  })

  it('sanitizes synchronous reconciliation failures and logs the failed stage', async () => {
    const stages: string[] = []

    await expect(
      performExitCleanup({
        commitTeardown: vi.fn(),
        flushWindowState: vi.fn(),
        logStage: (stage) => stages.push(stage),
        stopService: vi.fn().mockRejectedValue(new Error('/private/stop')),
        reconcileShutdownFailure: vi.fn(() => {
          throw new Error('/private/reconcile')
        })
      })
    ).rejects.toThrow('Application service shutdown failed')

    expect(stages).toEqual([
      'flush-window-state:start',
      'flush-window-state:complete',
      'stop-service:start',
      'stop-service:failed',
      'reconcile-shutdown-failure:start',
      'reconcile-shutdown-failure:failed'
    ])
    expect(JSON.stringify(stages)).not.toContain('/private')
  })

  it('logs content-free shutdown stage transitions in order', async () => {
    const stages: string[] = []

    await performExitCleanup({
      commitTeardown: vi.fn(),
      flushWindowState: vi.fn(),
      logStage: (stage) => stages.push(stage),
      reconcileShutdownFailure: vi.fn(),
      stopService: vi.fn()
    })

    expect(stages).toEqual([
      'flush-window-state:start',
      'flush-window-state:complete',
      'stop-service:start',
      'stop-service:complete',
      'commit-teardown:start',
      'commit-teardown:complete'
    ])
  })

  it('logs the failed stage without exposing failure details', async () => {
    const stages: string[] = []

    await expect(
      performExitCleanup({
        commitTeardown: vi.fn(),
        flushWindowState: vi.fn(),
        logStage: (stage) => stages.push(stage),
        reconcileShutdownFailure: vi.fn(),
        stopService: vi.fn().mockRejectedValue(new Error('/private/service'))
      })
    ).rejects.toThrow('Application service shutdown failed')

    expect(stages).toEqual([
      'flush-window-state:start',
      'flush-window-state:complete',
      'stop-service:start',
      'stop-service:failed',
      'reconcile-shutdown-failure:start',
      'reconcile-shutdown-failure:complete'
    ])
    expect(JSON.stringify(stages)).not.toContain('/private')
  })
})
