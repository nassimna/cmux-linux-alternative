import { randomUUID } from 'node:crypto'

import {
  browserAutomationOperationInvokeParamsSchema,
  browserAutomationOperationCancelParamsSchema,
  browserAutomationScreenshotReadParamsSchema,
  browserAutomationScreenshotReadResultSchema,
  browserAutomationScreenshotReleaseParamsSchema,
  browserAutomationScreenshotReleaseResultSchema,
  browserAutomationSessionCreateParamsSchema,
  browserAutomationSessionParamsSchema
} from '@agent-workspace/protocol-client'
import type {
  BrowserAutomationOperationInvokeParams,
  BrowserAutomationOperationCancelParams,
  BrowserAutomationOperationSnapshot,
  BrowserAutomationProviderRequest,
  BrowserAutomationScreenshotReadParams,
  BrowserAutomationScreenshotReadResult,
  BrowserAutomationScreenshotReleaseParams,
  BrowserAutomationScreenshotReleaseResult,
  BrowserAutomationSessionCreateParams,
  BrowserAutomationSessionSnapshot,
  BrowserAutomationSessionParams
} from '@agent-workspace/protocol-client'

import { BrowserAutomationProviderAuthority } from './provider-authority'
import { BrowserAutomationDurableRecords } from './durable-records'

const SESSION_TTL_MS = 30 * 60_000

/** Caller lifecycle bound to the current trusted desktop provider. */
export class BrowserAutomationRuntime {
  private transferInflight = 0
  private readonly pendingCreates = new Map<string, Promise<BrowserAutomationSessionSnapshot>>()
  public constructor(
    private readonly authority: BrowserAutomationProviderAuthority,
    private readonly records: BrowserAutomationDurableRecords,
    private readonly callerId: string,
    private readonly currentIdempotencyEpoch: () => string,
    private readonly now: () => number = Date.now
  ) {}

  public async createSession(
    input: BrowserAutomationSessionCreateParams
  ): Promise<BrowserAutomationSessionSnapshot> {
    const params = browserAutomationSessionCreateParamsSchema.parse(input)
    if (params.idempotency.epoch !== this.currentIdempotencyEpoch())
      throw new Error('idempotency_expired')
    const replay = this.records.sessionReplay(
      params as BrowserAutomationSessionCreateParams,
      this.callerId
    )
    if (replay.state === 'replay') return replay.snapshot!
    if (replay.state === 'pending') {
      const pending = this.pendingCreates.get(replay.sessionId!)
      if (!pending) throw new Error('interrupted')
      return pending
    }
    const { identity, target } = this.authority.claim(params.target?.window)
    const instant = this.instant()
    const request: BrowserAutomationProviderRequest = {
      kind: 'create',
      identity,
      target,
      provision: {
        automationSessionId: randomUUID(),
        generation: 1,
        mode: params.mode,
        profileKey: params.profileKey,
        ...(params.target ? { requestedTarget: params.target } : {}),
        createdAtMs: instant,
        expiresAtMs: instant + SESSION_TTL_MS
      },
      operationId: randomUUID(),
      correlationId: params.correlationId,
      attemptEpoch: 1
    }
    this.records.stageSession(request, {
      callerId: this.callerId,
      idempotencyEpoch: params.idempotency.epoch,
      idempotencyKey: params.idempotency.key
    })
    const pending = this.dispatch(request)
      .then(() => {
        const session = this.records.getOwnedSession(
          request.provision.automationSessionId,
          1,
          this.callerId
        )
        if (!session || session.state !== 'ready') throw new Error('interrupted')
        return session
      })
      .finally(() => this.pendingCreates.delete(request.provision.automationSessionId))
    this.pendingCreates.set(request.provision.automationSessionId, pending)
    return pending
  }

  public listSessions(): BrowserAutomationSessionSnapshot[] {
    return this.records.listSessions(this.callerId)
  }

  public getSession(input: BrowserAutomationSessionParams): BrowserAutomationSessionSnapshot {
    const params = browserAutomationSessionParamsSchema.parse(input)
    const snapshot = this.records.getOwnedSession(
      params.automationSessionId,
      params.generation,
      this.callerId
    )
    if (!snapshot) throw new Error('session_not_found')
    return snapshot
  }

  public async invoke(
    input: BrowserAutomationOperationInvokeParams
  ): Promise<BrowserAutomationOperationSnapshot> {
    const params = browserAutomationOperationInvokeParamsSchema.parse(input)
    const replay = this.records.operationReplay(params, this.callerId)
    if (replay.state === 'replay') return replay.snapshot!
    if (params.idempotency.epoch !== this.currentIdempotencyEpoch())
      throw new Error('idempotency_expired')
    const session = this.records.getOwnedSession(
      params.automationSessionId,
      params.sessionGeneration,
      this.callerId
    )
    if (!session || session.state !== 'ready') throw new Error('session_not_found')
    if (
      session.generation !== params.sessionGeneration ||
      session.navigationEpoch !== params.navigationEpoch
    )
      throw new Error('session_generation_mismatch')
    const { identity, target } = this.authority.claim(session.target.window)
    const request: BrowserAutomationProviderRequest = {
      kind: 'execute',
      request: { identity, target, session, operation: params }
    }
    this.records.stageOperation(request, {
      callerId: this.callerId,
      idempotencyEpoch: params.idempotency.epoch,
      idempotencyKey: params.idempotency.key
    })
    try {
      const { completion } = this.authority.mailbox.publish(request)
      void completion.then((result) => {
        if (result.kind === 'interrupted') this.records.interrupt(request)
      })
    } catch (error) {
      this.records.interrupt(request)
      throw error
    }
    const operation = this.records.getOperationSnapshot(params.operationId)
    if (!operation) throw new Error('interrupted')
    return operation
  }

  public cancelOperation(
    input: BrowserAutomationOperationCancelParams
  ): BrowserAutomationOperationSnapshot {
    const params = browserAutomationOperationCancelParamsSchema.parse(input)
    const { snapshot, canceledNow, identity, target } = this.records.cancelOperation(
      params,
      this.callerId
    )
    if (canceledNow) {
      this.authority.mailbox.cancelQueued(params.operationId)
      if (this.authority.isCurrent(identity, target)) {
        const request: BrowserAutomationProviderRequest = {
          kind: 'cancel',
          identity,
          target,
          automationSessionId: params.automationSessionId,
          sessionGeneration: params.sessionGeneration,
          operationId: params.operationId,
          correlationId: params.correlationId
        }
        try {
          this.authority.mailbox.publish(request, 30_000)
        } catch {
          /* durable cancellation already won */
        }
      }
    }
    return snapshot
  }

  public async destroySession(
    input: BrowserAutomationSessionParams
  ): Promise<BrowserAutomationSessionSnapshot> {
    const params = browserAutomationSessionParamsSchema.parse(input)
    const session = this.records.getOwnedSession(
      params.automationSessionId,
      params.generation,
      this.callerId
    )
    if (!session || session.generation !== params.generation || session.state !== 'ready')
      throw new Error('session_not_found')
    const { identity, target } = this.authority.claim(session.target.window)
    const request: BrowserAutomationProviderRequest = {
      kind: 'destroy',
      identity,
      target,
      session,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      attemptEpoch: identity.providerEpoch
    }
    this.records.stageDestroy(request, this.callerId)
    await this.dispatch(request)
    const destroyed = this.records.getSessionSnapshot(params.automationSessionId)
    if (!destroyed) throw new Error('interrupted')
    return destroyed
  }

  public async readScreenshot(
    input: BrowserAutomationScreenshotReadParams,
    signal?: AbortSignal
  ): Promise<BrowserAutomationScreenshotReadResult> {
    const params = browserAutomationScreenshotReadParamsSchema.parse(input)
    const ownership = this.records.handles.get(
      params.handleId,
      this.callerId,
      params.automationSessionId,
      params.sessionGeneration
    )
    if (params.chunkIndex >= ownership.handle.chunkCount) throw new Error('invalid_operation')
    const request: BrowserAutomationProviderRequest = {
      kind: 'screenshotRead',
      identity: ownership.identity,
      target: ownership.target,
      requestId: randomUUID(),
      correlationId: randomUUID(),
      params
    }
    const outcome = await this.transfer(request, signal)
    if (outcome.kind === 'error') throw new Error(outcome.errorCode)
    if (outcome.kind !== 'screenshotRead') throw new Error('invalid_operation')
    const result = browserAutomationScreenshotReadResultSchema.parse(outcome.result)
    if (
      result.handleId !== params.handleId ||
      result.chunkIndex !== params.chunkIndex ||
      result.chunkCount !== ownership.handle.chunkCount ||
      result.sha256 !== ownership.handle.sha256 ||
      result.expiresAtMs > ownership.handle.expiresAtMs
    )
      throw new Error('invalid_operation')
    const expectedBytes =
      params.chunkIndex === ownership.handle.chunkCount - 1
        ? ownership.handle.byteLength - params.chunkIndex * 512 * 1024
        : 512 * 1024
    if (Buffer.byteLength(result.dataBase64, 'base64') !== expectedBytes)
      throw new Error('invalid_operation')
    return result
  }

  public async releaseScreenshot(
    input: BrowserAutomationScreenshotReleaseParams,
    signal?: AbortSignal
  ): Promise<BrowserAutomationScreenshotReleaseResult> {
    const params = browserAutomationScreenshotReleaseParamsSchema.parse(input)
    const ownership = this.records.handles.get(
      params.handleId,
      this.callerId,
      params.automationSessionId,
      params.sessionGeneration
    )
    const request: BrowserAutomationProviderRequest = {
      kind: 'screenshotRelease',
      identity: ownership.identity,
      target: ownership.target,
      requestId: randomUUID(),
      correlationId: randomUUID(),
      params
    }
    const outcome = await this.transfer(request, signal)
    if (outcome.kind === 'error') throw new Error(outcome.errorCode)
    if (outcome.kind !== 'screenshotRelease') throw new Error('invalid_operation')
    this.records.handles.release(params.handleId)
    return browserAutomationScreenshotReleaseResultSchema.parse({ released: outcome.released })
  }

  private async transfer(
    request: Extract<
      BrowserAutomationProviderRequest,
      { kind: 'screenshotRead' | 'screenshotRelease' }
    >,
    signal?: AbortSignal
  ) {
    if (signal?.aborted) throw new Error('interrupted')
    if (!this.authority.isCurrent(request.identity, request.target))
      throw new Error('provider_epoch_mismatch')
    if (this.transferInflight >= 4) throw new Error('automation_backpressure')
    this.transferInflight += 1
    try {
      const { requestId, completion } = this.authority.mailbox.publish(request, 30_000)
      const cancel = () => this.authority.mailbox.cancel(requestId)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      let response: Awaited<typeof completion>
      try {
        response = await completion
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
      if (response.kind === 'interrupted') throw new Error('timeout')
      if (response.kind !== 'transfer') throw new Error('invalid_operation')
      return response.value.outcome
    } finally {
      this.transferInflight -= 1
    }
  }

  private async dispatch(request: BrowserAutomationProviderRequest): Promise<void> {
    try {
      const { completion } = this.authority.mailbox.publish(request)
      const result = await completion
      if (result.kind === 'interrupted') {
        this.records.interrupt(request)
        throw new Error('interrupted')
      }
      if (result.kind !== 'acknowledge') throw new Error('invalid_operation')
      if (result.value.state !== 'succeeded')
        throw new Error(result.value.errorCode ?? 'interrupted')
    } catch (error) {
      this.records.interrupt(request)
      throw error
    }
  }

  private instant(): number {
    const value = this.now()
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - SESSION_TTL_MS
    )
      throw new Error('automation_clock_unavailable')
    return value
  }
}
