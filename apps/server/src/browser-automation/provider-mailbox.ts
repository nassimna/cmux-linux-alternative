import { randomUUID } from 'node:crypto'

import {
  browserAutomationProviderAcknowledgeParamsSchema,
  browserAutomationProviderPollParamsSchema,
  browserAutomationProviderRequestSchema,
  browserAutomationProviderTransferRespondParamsSchema
} from '@agent-workspace/protocol-client'
import type {
  ActionInvocationTarget,
  BrowserAutomationProviderAcknowledgeParams,
  BrowserAutomationProviderPollParams,
  BrowserAutomationProviderRequest,
  BrowserAutomationProviderTransferRespondParams,
  DesktopProviderIdentityParams
} from '@agent-workspace/protocol-client'

type Completion =
  | { kind: 'acknowledge'; value: BrowserAutomationProviderAcknowledgeParams }
  | { kind: 'transfer'; value: BrowserAutomationProviderTransferRespondParams }
  | { kind: 'interrupted' }

type Entry = {
  request: BrowserAutomationProviderRequest
  requestId: string
  correlationId: string
  identity: DesktopProviderIdentityParams
  target: ActionInvocationTarget
  state: 'queued' | 'inFlight'
  complete: (value: Completion) => void
  timeout: ReturnType<typeof setTimeout>
}

type PollWaiter = {
  identity: DesktopProviderIdentityParams
  finish: (request?: BrowserAutomationProviderRequest) => void
  timeout: ReturnType<typeof setTimeout>
}

const MAX_PENDING = 64
const MAX_POLL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** Caller-facing errors contain no URL, selector, text, or screenshot content. */
export class BrowserAutomationMailboxError extends Error {
  public constructor(
    public readonly code:
      | 'provider_epoch_mismatch'
      | 'provider_unavailable'
      | 'automation_backpressure'
      | 'invalid_operation'
      | 'canceled'
  ) {
    super(code)
    this.name = 'BrowserAutomationMailboxError'
  }
}

/**
 * In-memory reverse-provider transport. The owner must resolve a lease from trusted
 * provider registration state, including the window claim, on every call.
 * Durable operation/session records and content-handle ownership belong above this layer.
 */
export class BrowserAutomationProviderMailbox {
  private readonly entries = new Map<string, Entry>()
  private readonly queue: string[] = []
  private readonly pollWaiters = new Map<string, PollWaiter>()
  private closed = false

  public constructor(
    private readonly current: (
      identity: DesktopProviderIdentityParams,
      target?: ActionInvocationTarget
    ) => boolean
  ) {}

  public publish(
    input: BrowserAutomationProviderRequest,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): { requestId: string; completion: Promise<Completion> } {
    // Generated Rust DTOs use required fields with undefined while Zod strips optional fields.
    const request = browserAutomationProviderRequestSchema.parse(input) as BrowserAutomationProviderRequest
    const { requestId: providerRequestId, correlationId, identity, target } = requestFence(request)
    // Cancel has no provider response of its own. Keep its queue key distinct
    // from the execute operation so a late execute acknowledgement can still
    // match the original in-flight entry after durable cancellation wins.
    const requestId = request.kind === 'cancel' ? randomUUID() : providerRequestId
    if (this.closed) throw new BrowserAutomationMailboxError('provider_unavailable')
    if (!this.current(identity, target))
      throw new BrowserAutomationMailboxError('provider_epoch_mismatch')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_REQUEST_TIMEOUT_MS)
      throw new BrowserAutomationMailboxError('invalid_operation')
    if (this.entries.has(requestId)) throw new BrowserAutomationMailboxError('invalid_operation')
    if (this.entries.size >= MAX_PENDING)
      throw new BrowserAutomationMailboxError('automation_backpressure')

    let complete!: (value: Completion) => void
    const completion = new Promise<Completion>((resolve) => {
      complete = resolve
    })
    const timeout = setTimeout(() => this.remove(requestId, { kind: 'interrupted' }), timeoutMs)
    const entry: Entry = {
      request,
      requestId,
      correlationId,
      identity,
      target,
      state: 'queued',
      complete,
      timeout
    }
    this.entries.set(requestId, entry)
    const waiter = this.pollWaiters.get(identity.providerId)
    if (waiter) {
      if (sameIdentity(waiter.identity, identity)) {
        this.pollWaiters.delete(identity.providerId)
        entry.state = 'inFlight'
        waiter.finish(request)
      } else {
        waiter.finish()
        this.queue.push(requestId)
      }
    } else {
      this.queue.push(requestId)
    }
    return { requestId, completion }
  }

  public async poll(input: BrowserAutomationProviderPollParams): Promise<{ request?: BrowserAutomationProviderRequest }> {
    const params = browserAutomationProviderPollParamsSchema.parse(input)
    const identity = params.identity
    if (this.closed || !this.current(identity))
      throw new BrowserAutomationMailboxError('provider_epoch_mismatch')
    const existingWaiter = this.pollWaiters.get(identity.providerId)
    if (existingWaiter) {
      if (sameIdentity(existingWaiter.identity, identity))
        throw new BrowserAutomationMailboxError('automation_backpressure')
      existingWaiter.finish()
    }
    const queuedCount = this.queue.length
    for (let scanned = 0; scanned < queuedCount; scanned += 1) {
      const requestId = this.queue.shift()!
      const entry = this.entries.get(requestId)
      if (!entry || entry.state !== 'queued') continue
      if (!sameIdentity(entry.identity, identity)) {
        this.queue.push(requestId)
        continue
      }
      if (!this.current(identity, entry.target)) {
        this.remove(requestId, { kind: 'interrupted' })
        continue
      }
      entry.state = 'inFlight'
      return { request: entry.request }
    }
    if (params.timeoutMs === 0) return {}
    return new Promise((resolve) => {
      const finish = (request?: BrowserAutomationProviderRequest): void => {
        clearTimeout(waiter.timeout)
        if (this.pollWaiters.get(identity.providerId) === waiter)
          this.pollWaiters.delete(identity.providerId)
        resolve(request ? { request } : {})
      }
      const waiter: PollWaiter = {
        identity,
        finish,
        timeout: setTimeout(() => finish(), Math.min(params.timeoutMs, MAX_POLL_MS))
      }
      this.pollWaiters.set(identity.providerId, waiter)
    })
  }

  public acknowledge(input: BrowserAutomationProviderAcknowledgeParams): void {
    const { entry, value } = this.checkedAcknowledge(input)
    this.remove(entry.requestId, { kind: 'acknowledge', value })
  }

  /** Synchronous preflight for a durable owner before its SQLite transaction commits. */
  public validateAcknowledge(input: BrowserAutomationProviderAcknowledgeParams): void {
    this.checkedAcknowledge(input)
  }

  private checkedAcknowledge(input: BrowserAutomationProviderAcknowledgeParams): {
    entry: Entry
    value: BrowserAutomationProviderAcknowledgeParams
  } {
    const value = browserAutomationProviderAcknowledgeParamsSchema.parse(input) as BrowserAutomationProviderAcknowledgeParams
    const entry = this.match(value.operationId, value.correlationId, value.identity, value.target)
    if (entry.request.kind === 'screenshotRead' || entry.request.kind === 'screenshotRelease' || entry.request.kind === 'cancel')
      throw new BrowserAutomationMailboxError('invalid_operation')
    const expectedSession = entry.request.kind === 'create'
      ? entry.request.provision.automationSessionId
      : entry.request.kind === 'destroy'
        ? entry.request.session.automationSessionId
        : entry.request.request.session.automationSessionId
    const expectedGeneration = entry.request.kind === 'create'
      ? entry.request.provision.generation
      : entry.request.kind === 'destroy'
        ? entry.request.session.generation
        : entry.request.request.session.generation
    const expectedAttempt = entry.request.kind === 'execute'
      ? entry.request.request.operation.attemptEpoch
      : entry.request.attemptEpoch
    if (value.automationSessionId !== expectedSession ||
        value.sessionGeneration !== expectedGeneration ||
        value.attemptEpoch !== expectedAttempt)
      throw new BrowserAutomationMailboxError('provider_epoch_mismatch')
    if (value.state === 'succeeded') {
      const valid = entry.request.kind === 'create'
        ? value.session !== undefined && value.result === undefined
        : entry.request.kind === 'destroy'
          ? value.session === undefined && value.result === undefined
          : value.session === undefined && value.result !== undefined
      if (!valid) throw new BrowserAutomationMailboxError('invalid_operation')
      if (entry.request.kind === 'create' && value.session &&
          (value.session.mode !== entry.request.provision.mode ||
           value.session.profileKey !== entry.request.provision.profileKey ||
           value.session.createdAtMs !== entry.request.provision.createdAtMs ||
           (entry.request.provision.requestedTarget !== undefined &&
            !sameBinding(value.session.target, entry.request.provision.requestedTarget))))
        throw new BrowserAutomationMailboxError('invalid_operation')
      if (entry.request.kind === 'execute' && value.result) {
        const operation = entry.request.request.operation.operation
        const expectedResult = operation.kind === 'navigate' ? 'navigation'
          : operation.kind === 'query' ? 'query'
            : operation.kind === 'screenshot' ? 'screenshot' : 'empty'
        if (value.result.kind !== expectedResult ||
            (value.result.kind === 'navigation' &&
             value.result.navigationEpoch !== entry.request.request.operation.navigationEpoch + 1))
          throw new BrowserAutomationMailboxError('invalid_operation')
      }
    }
    return { entry, value }
  }

  public respondTransfer(input: BrowserAutomationProviderTransferRespondParams): void {
    const value = browserAutomationProviderTransferRespondParamsSchema.parse(input)
    const entry = this.match(value.requestId, value.correlationId, value.identity, value.target)
    if (entry.request.kind !== 'screenshotRead' && entry.request.kind !== 'screenshotRelease')
      throw new BrowserAutomationMailboxError('invalid_operation')
    if (value.outcome.kind !== 'error' &&
        (entry.request.kind === 'screenshotRead' ? value.outcome.kind !== 'screenshotRead' : value.outcome.kind !== 'screenshotRelease'))
      throw new BrowserAutomationMailboxError('invalid_operation')
    if (entry.request.kind === 'screenshotRead' && value.outcome.kind === 'screenshotRead' &&
        (value.outcome.result.handleId !== entry.request.params.handleId ||
         value.outcome.result.chunkIndex !== entry.request.params.chunkIndex))
      throw new BrowserAutomationMailboxError('invalid_operation')
    this.remove(entry.requestId, { kind: 'transfer', value })
  }

  /** Called when a provider lease/window claim is revoked or a caller cancels work. */
  public cancel(requestId: string): void {
    this.remove(requestId, { kind: 'interrupted' })
  }

  public has(requestId: string): boolean {
    return this.entries.has(requestId)
  }

  public cancelSession(sessionId: string): void {
    for (const entry of [...this.entries.values()]) {
      const request = entry.request
      const owned = request.kind === 'create'
        ? request.provision.automationSessionId === sessionId
        : request.kind === 'destroy'
          ? request.session.automationSessionId === sessionId
          : request.kind === 'execute'
            ? request.request.session.automationSessionId === sessionId
            : request.kind === 'cancel'
              ? request.automationSessionId === sessionId
              : request.params.automationSessionId === sessionId
      if (owned) this.cancel(entry.requestId)
    }
  }

  /** Remove work the provider has not received; preserve in-flight ack fencing. */
  public cancelQueued(requestId: string): void {
    if (this.entries.get(requestId)?.state === 'queued') this.cancel(requestId)
  }

  public revokeProvider(providerId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.identity.providerId === providerId)
        this.remove(entry.requestId, { kind: 'interrupted' })
    }
    const waiter = this.pollWaiters.get(providerId)
    if (waiter) waiter.finish()
  }

  public dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of [...this.entries.values()])
      this.remove(entry.requestId, { kind: 'interrupted' })
    for (const waiter of this.pollWaiters.values()) waiter.finish()
    this.pollWaiters.clear()
  }

  private match(
    requestId: string,
    correlationId: string,
    identity: DesktopProviderIdentityParams,
    target: ActionInvocationTarget
  ): Entry {
    const entry = this.entries.get(requestId)
    if (!entry || entry.state !== 'inFlight')
      throw new BrowserAutomationMailboxError('canceled')
    if (!sameIdentity(entry.identity, identity) || !sameTarget(entry.target, target) ||
        entry.correlationId !== correlationId || !this.current(identity, target))
      throw new BrowserAutomationMailboxError('provider_epoch_mismatch')
    return entry
  }

  private remove(requestId: string, completion: Completion): void {
    const entry = this.entries.get(requestId)
    if (!entry) return
    this.entries.delete(requestId)
    clearTimeout(entry.timeout)
    const queued = this.queue.indexOf(requestId)
    if (queued >= 0) this.queue.splice(queued, 1)
    entry.complete(completion)
  }
}

function requestFence(request: BrowserAutomationProviderRequest): {
  requestId: string
  correlationId: string
  identity: DesktopProviderIdentityParams
  target: ActionInvocationTarget
} {
  if (request.kind === 'execute') return {
    requestId: request.request.operation.operationId,
    correlationId: request.request.operation.correlationId,
    identity: request.request.identity,
    target: request.request.target
  }
  return {
    requestId: request.kind === 'screenshotRead' || request.kind === 'screenshotRelease'
      ? request.requestId : request.operationId,
    correlationId: request.correlationId,
    identity: request.identity,
    target: request.target
  }
}

function sameIdentity(a: DesktopProviderIdentityParams, b: DesktopProviderIdentityParams): boolean {
  return a.providerId === b.providerId && a.providerEpoch === b.providerEpoch && a.leaseId === b.leaseId
}

function sameTarget(a: ActionInvocationTarget, b: ActionInvocationTarget): boolean {
  return a.windowId === b.windowId && a.windowGeneration === b.windowGeneration
}

function sameBinding(
  a: { workspaceId: string; paneId: string; tabId: string; browserSessionId: string; browserLifecycleId: string; window: ActionInvocationTarget },
  b: { workspaceId: string; paneId: string; tabId: string; browserSessionId: string; browserLifecycleId: string; window: ActionInvocationTarget }
): boolean {
  return a.workspaceId === b.workspaceId && a.paneId === b.paneId && a.tabId === b.tabId &&
    a.browserSessionId === b.browserSessionId && a.browserLifecycleId === b.browserLifecycleId &&
    sameTarget(a.window, b.window)
}
