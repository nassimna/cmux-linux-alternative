import type {
  BrowserAutomationErrorCode,
  BrowserAutomationExecutionRequest,
  BrowserAutomationProviderAcknowledgeParams,
  BrowserAutomationProviderAcknowledgeResult,
  BrowserAutomationProviderPollParams,
  BrowserAutomationProviderPollResult,
  BrowserAutomationProviderRequest,
  BrowserAutomationProviderTransferRespondParams,
  DesktopProviderIdentityParams
} from '@agent-workspace/protocol-client'

import {
  BrowserAutomationFailure,
  type BrowserAutomationManager
} from './browser-automation-manager'

const POLL_TIMEOUT_MS = 5_000
const MAX_INFLIGHT_REQUESTS = 64

export interface BrowserAutomationProviderTransport {
  poll(
    params: BrowserAutomationProviderPollParams,
    signal: AbortSignal
  ): Promise<BrowserAutomationProviderPollResult>
  acknowledge(
    params: BrowserAutomationProviderAcknowledgeParams
  ): Promise<BrowserAutomationProviderAcknowledgeResult>
  respondTransfer(params: BrowserAutomationProviderTransferRespondParams): Promise<void>
}

export interface BrowserAutomationProviderOptions {
  readonly identity: DesktopProviderIdentityParams
  readonly transport: BrowserAutomationProviderTransport
  readonly resolveManager: (
    windowId: string,
    windowGeneration: number
  ) => BrowserAutomationManager | undefined
  readonly managers: () => Iterable<BrowserAutomationManager>
  readonly onProviderLost: (reason: string) => void
  readonly logError?: (message: string, error?: unknown) => void
}

/** Reverse-provider loop. It has no renderer/preload registration surface. */
export class BrowserAutomationProvider {
  #abort: AbortController | undefined
  #polling: Promise<void> | undefined
  readonly #inflight = new Set<Promise<void>>()
  #transferInflight = 0
  #stopped = false
  #lossReported = false

  public constructor(private readonly options: BrowserAutomationProviderOptions) {}

  public start(): void {
    if (this.#stopped) throw new Error('Browser automation provider is stopped')
    if (this.#polling) return
    this.#abort = new AbortController()
    const polling = this.pollLoop(this.#abort.signal)
    const tracked = polling.finally(() => {
      if (this.#polling === tracked) this.#polling = undefined
    })
    this.#polling = tracked
  }

  public async pause(reason = 'browser automation polling paused'): Promise<void> {
    const polling = this.#polling
    this.#abort?.abort(reason)
    this.#abort = undefined
    await Promise.all([...this.options.managers()].map((manager) => manager.dispose()))
    await polling?.catch(() => undefined)
    await Promise.allSettled([...this.#inflight])
    if (this.#polling === polling) this.#polling = undefined
  }

  public async stop(reason = 'browser automation provider stopped'): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    await this.pause(reason)
  }

  public get active(): boolean {
    return !this.#stopped
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#stopped) {
      let result: BrowserAutomationProviderPollResult
      try {
        result = await this.options.transport.poll(
          { identity: this.options.identity, timeoutMs: POLL_TIMEOUT_MS },
          signal
        )
      } catch (error) {
        if (!signal.aborted) this.providerLost('browser automation poll failed', error)
        return
      }
      if (signal.aborted || !result.request) continue
      if (this.#inflight.size >= MAX_INFLIGHT_REQUESTS) {
        this.providerLost(
          'browser automation in-flight bound exceeded',
          new Error('Automation provider request bound exceeded')
        )
        return
      }
      const handling = this.handle(result.request, signal)
        .catch((error: unknown) => {
          if (!signal.aborted) this.providerLost('browser automation protocol failed', error)
        })
        .finally(() => this.#inflight.delete(handling))
      this.#inflight.add(handling)
    }
  }

  private async handle(
    request: BrowserAutomationProviderRequest,
    signal: AbortSignal
  ): Promise<void> {
    const identity = request.kind === 'execute' ? request.request.identity : request.identity
    if (!sameIdentity(identity, this.options.identity))
      throw new Error('Automation identity mismatch')
    const target = request.kind === 'execute' ? request.request.target : request.target
    const manager = this.options.resolveManager(target.windowId, target.windowGeneration)
    if (!manager) {
      if (request.kind === 'execute') {
        await this.acknowledgeFailure(request.request, 'target_not_found')
      } else if (request.kind === 'cancel') {
        return
      } else if (request.kind === 'create' || request.kind === 'destroy') {
        const session = request.kind === 'create' ? request.provision : request.session
        await this.options.transport.acknowledge({
          identity: this.options.identity,
          target: request.target,
          automationSessionId: session.automationSessionId,
          sessionGeneration: session.generation,
          operationId: request.operationId,
          correlationId: request.correlationId,
          attemptEpoch: request.attemptEpoch,
          state: 'failed',
          errorCode: 'target_not_found'
        })
      } else {
        await this.options.transport.respondTransfer({
          identity: this.options.identity,
          target: request.target,
          requestId: request.requestId,
          correlationId: request.correlationId,
          outcome: { kind: 'error', errorCode: 'target_not_found' }
        })
      }
      return
    }
    if (signal.aborted) return
    if (request.kind === 'cancel') {
      manager.cancel(request.automationSessionId, request.sessionGeneration, request.operationId)
      return
    }
    if (request.kind === 'create') {
      try {
        const session = await manager.createProvision(request.provision, request.target)
        if (
          signal.aborted ||
          !this.isCurrentManager(manager, request.target) ||
          !manager.canAcknowledgeSession(session)
        ) {
          return
        }
        await this.options.transport.acknowledge({
          identity: this.options.identity,
          target: request.target,
          automationSessionId: session.automationSessionId,
          sessionGeneration: session.generation,
          operationId: request.operationId,
          correlationId: request.correlationId,
          attemptEpoch: request.attemptEpoch,
          state: 'succeeded',
          session
        })
      } catch (error) {
        if (signal.aborted || !this.isCurrentManager(manager, request.target)) return
        await this.options.transport.acknowledge({
          identity: this.options.identity,
          target: request.target,
          automationSessionId: request.provision.automationSessionId,
          sessionGeneration: request.provision.generation,
          operationId: request.operationId,
          correlationId: request.correlationId,
          attemptEpoch: request.attemptEpoch,
          state: 'failed',
          errorCode: automationError(error)
        })
      }
      return
    }
    if (request.kind === 'destroy') {
      await manager.destroySession(request.session.automationSessionId, request.session.generation)
      if (signal.aborted || !this.isCurrentManager(manager, request.target)) return
      await this.options.transport.acknowledge({
        identity: this.options.identity,
        target: request.target,
        automationSessionId: request.session.automationSessionId,
        sessionGeneration: request.session.generation,
        operationId: request.operationId,
        correlationId: request.correlationId,
        attemptEpoch: request.attemptEpoch,
        state: 'succeeded'
      })
      return
    }
    if (request.kind === 'screenshotRead' || request.kind === 'screenshotRelease') {
      if (signal.aborted) return
      if (this.#transferInflight >= 4) {
        if (!this.isCurrentManager(manager, request.target)) return
        await this.options.transport.respondTransfer({
          identity: this.options.identity,
          target: request.target,
          requestId: request.requestId,
          correlationId: request.correlationId,
          outcome: { kind: 'error', errorCode: 'automation_backpressure' }
        })
        return
      }
      this.#transferInflight += 1
      try {
        const outcome =
          request.kind === 'screenshotRead'
            ? {
                kind: 'screenshotRead' as const,
                result: manager.readScreenshot(
                  request.params.automationSessionId,
                  request.params.sessionGeneration,
                  request.params.handleId,
                  request.params.chunkIndex
                )
              }
            : {
                kind: 'screenshotRelease' as const,
                released: manager.releaseScreenshot(
                  request.params.automationSessionId,
                  request.params.sessionGeneration,
                  request.params.handleId
                )
              }
        if (signal.aborted || !this.isCurrentManager(manager, request.target)) return
        await this.options.transport.respondTransfer({
          identity: this.options.identity,
          target: request.target,
          requestId: request.requestId,
          correlationId: request.correlationId,
          outcome
        })
      } catch (error) {
        if (signal.aborted || !this.isCurrentManager(manager, request.target)) return
        await this.options.transport.respondTransfer({
          identity: this.options.identity,
          target: request.target,
          requestId: request.requestId,
          correlationId: request.correlationId,
          outcome: { kind: 'error', errorCode: automationError(error) }
        })
      } finally {
        this.#transferInflight -= 1
      }
      return
    }

    let snapshot
    try {
      snapshot = await manager.execute(request.request)
    } catch (error) {
      // Target/session preflight in execute runs before its operation-level catch.
      // An invalidated attached tab is one failed operation, not a lost provider.
      if (!(error instanceof BrowserAutomationFailure)) throw error
      if (signal.aborted || !this.isCurrentManager(manager, request.request.target)) return
      await this.acknowledgeFailure(request.request, error.code)
      return
    }
    if (signal.aborted || !manager.canAcknowledge(request.request)) return
    await this.options.transport.acknowledge({
      identity: this.options.identity,
      target: request.request.target,
      automationSessionId: snapshot.automationSessionId,
      sessionGeneration: snapshot.sessionGeneration,
      operationId: snapshot.operationId,
      correlationId: snapshot.correlationId,
      attemptEpoch: snapshot.attemptEpoch,
      state: snapshot.state,
      ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
      ...(snapshot.errorCode === undefined ? {} : { errorCode: snapshot.errorCode })
    })
  }

  private async acknowledgeFailure(
    request: BrowserAutomationExecutionRequest,
    errorCode: BrowserAutomationErrorCode
  ): Promise<void> {
    await this.options.transport.acknowledge({
      identity: this.options.identity,
      target: request.target,
      automationSessionId: request.operation.automationSessionId,
      sessionGeneration: request.operation.sessionGeneration,
      operationId: request.operation.operationId,
      correlationId: request.operation.correlationId,
      attemptEpoch: request.operation.attemptEpoch,
      state: 'failed',
      errorCode
    })
  }

  private isCurrentManager(
    manager: BrowserAutomationManager,
    target: { windowId: string; windowGeneration: number }
  ): boolean {
    return this.options.resolveManager(target.windowId, target.windowGeneration) === manager
  }

  private providerLost(message: string, error: unknown): void {
    if (this.#lossReported) return
    this.#lossReported = true
    this.options.logError?.(message, error)
    this.#abort?.abort(message)
    for (const manager of this.options.managers()) void manager.dispose()
    this.options.onProviderLost(message)
  }
}

function automationError(error: unknown): BrowserAutomationErrorCode {
  return error instanceof Error && 'code' in error
    ? (error.code as BrowserAutomationErrorCode)
    : 'invalid_operation'
}

function sameIdentity(
  left: DesktopProviderIdentityParams,
  right: DesktopProviderIdentityParams
): boolean {
  return (
    left.providerId === right.providerId &&
    left.providerEpoch === right.providerEpoch &&
    left.leaseId === right.leaseId
  )
}
