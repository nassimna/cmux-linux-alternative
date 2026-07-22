export interface ApplicationExitCleanupOptions {
  commitTeardown(): void | Promise<void>
  flushWindowState(): void | Promise<void>
  logStage?(stage: ApplicationExitCleanupStage): void
  reconcileShutdownFailure(): void | Promise<void>
  stopService(): void | Promise<void>
}

export type ApplicationExitCleanupStage =
  | 'flush-window-state:start'
  | 'flush-window-state:complete'
  | 'flush-window-state:failed'
  | 'stop-service:start'
  | 'stop-service:complete'
  | 'stop-service:failed'
  | 'reconcile-shutdown-failure:start'
  | 'reconcile-shutdown-failure:complete'
  | 'reconcile-shutdown-failure:failed'
  | 'commit-teardown:start'
  | 'commit-teardown:complete'
  | 'commit-teardown:failed'

export async function performExitCleanup(options: ApplicationExitCleanupOptions): Promise<void> {
  options.logStage?.('flush-window-state:start')
  try {
    await options.flushWindowState()
  } catch {
    options.logStage?.('flush-window-state:failed')
    throw new Error('Application window-state flush failed')
  }
  options.logStage?.('flush-window-state:complete')
  options.logStage?.('stop-service:start')
  try {
    await options.stopService()
  } catch {
    options.logStage?.('stop-service:failed')
    options.logStage?.('reconcile-shutdown-failure:start')
    await Promise.resolve()
      .then(() => options.reconcileShutdownFailure())
      .then(
        () => options.logStage?.('reconcile-shutdown-failure:complete'),
        () => options.logStage?.('reconcile-shutdown-failure:failed')
      )
    throw new Error('Application service shutdown failed')
  }
  options.logStage?.('stop-service:complete')
  options.logStage?.('commit-teardown:start')
  try {
    await options.commitTeardown()
  } catch {
    options.logStage?.('commit-teardown:failed')
    throw new Error('Application teardown failed')
  }
  options.logStage?.('commit-teardown:complete')
}
