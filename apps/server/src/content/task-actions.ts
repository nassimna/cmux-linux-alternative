import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'

import Database from 'better-sqlite3'
import {
  taskActionParamsSchema,
  taskActionResultSchema,
  taskConfirmationIssueParamsSchema,
  taskConfirmationIssueResultSchema
} from '@agent-workspace/protocol-client'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { RemoteCatalogError } from '../persistence/remote-catalog'
import type { RemoteSessionActivationService } from '../remote/remote-session-activation-service'
import type { TaskBoundWindow } from './task-catalog'

type Action = ReturnType<typeof taskActionParamsSchema.parse>
type Target = Action['target']
type Result = ReturnType<typeof taskActionResultSchema.parse>
type Confirmation = ReturnType<typeof taskConfirmationIssueResultSchema.parse>['confirmation']

const MAX_CONFIRMATIONS = 256
const MAX_OUTCOMES = 4_096
const TTL_MS = 30_000

export class TaskActionError extends Error {
  constructor(
    public readonly code:
      | 'invalid_params'
      | 'unauthorized'
      | 'invalid_state'
      | 'stale_revision'
      | 'idempotency_conflict'
      | 'resource_limit'
      | 'provider_unavailable',
    message: string
  ) {
    super(message)
    this.name = 'TaskActionError'
  }
}

function fail(code: TaskActionError['code'], message: string): never {
  throw new TaskActionError(code, message)
}

function sameTarget(left: Target, right: Target): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.revision === right.revision
  )
}

function lifecycle(state: string): Result['lifecycle'] {
  switch (state) {
    case 'connected':
      return 'running'
    case 'detached':
      return 'detached'
    case 'closed':
      return 'terminated'
    case 'failed':
      return 'failed'
    default:
      return 'created'
  }
}

interface ConfirmationRow {
  invocation_id: string
  action: string
  task_kind: string
  session_id: string
  generation: number
  revision: number
  provider_id: string
  provider_epoch: number
  provider_lease_id: string
  window_id: string
  window_generation: number
  request_hash: string
  nonce_hash: string
  expires_at_ms: number
  consumed_at_ms: number | null
  consumed_idempotency_key: string | null
}

interface OutcomeRow {
  action: string
  task_kind: string
  session_id: string
  generation: number
  revision: number
  request_hash: string
  result_json: string
}

/** Task actions use only the Node-owned remote provider and the private window binding. */
export class TaskActions {
  private readonly database: Database.Database
  private readonly providerId = randomUUID()
  private readonly leaseId = randomUUID()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    databasePath: string,
    private readonly state: ApplicationStateStore,
    private readonly remote: RemoteSessionActivationService,
    private readonly now: () => number = Date.now
  ) {
    const file = lstatSync(databasePath)
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
      fail('invalid_state', 'Task database must be a private regular file')
    this.database = new Database(databasePath, { fileMustExist: true, timeout: 5_000 })
    try {
      this.database.pragma('foreign_keys = ON')
      // Rust invalidates outstanding challenges whenever an owner starts.
      this.database
        .prepare('UPDATE task_confirmations SET consumed_at_ms = ? WHERE consumed_at_ms IS NULL')
        .run(this.timestamp())
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  issue(input: unknown, binding: TaskBoundWindow) {
    const parsed = taskConfirmationIssueParamsSchema.safeParse(input)
    if (!parsed.success) fail('invalid_params', 'Task confirmation parameters are invalid')
    const request = parsed.data
    this.checkWindow(binding, request.window.windowId, request.window.windowGeneration)
    if (request.action === 'detach')
      fail('invalid_params', 'Detach does not use a destructive confirmation')
    this.exactRemote(request.target)
    const instant = this.timestamp()
    const confirmation: Confirmation = {
      invocationId: randomUUID(),
      action: request.action,
      kind: 'remoteSession',
      target: request.target,
      providerId: this.providerId,
      providerEpoch: 1,
      providerLeaseId: this.leaseId,
      windowId: binding.windowId,
      windowGeneration: request.window.windowGeneration,
      requestHash: request.requestHash,
      nonce: randomUUID(),
      expiresAtMs: instant + TTL_MS
    }
    this.database
      .transaction(() => {
        this.database
          .prepare(
            'DELETE FROM task_confirmations WHERE expires_at_ms <= ? AND consumed_at_ms IS NOT NULL'
          )
          .run(instant)
        const count = this.database
          .prepare('SELECT count(*) AS count FROM task_confirmations')
          .get() as { count: number }
        if (count.count >= MAX_CONFIRMATIONS)
          fail('resource_limit', 'Task confirmation capacity reached')
        this.database
          .prepare(
            `INSERT INTO task_confirmations
        (invocation_id,action,task_kind,session_id,generation,revision,provider_id,provider_epoch,
         provider_lease_id,window_id,window_generation,request_hash,nonce_hash,expires_at_ms,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            confirmation.invocationId,
            confirmation.action,
            confirmation.kind,
            request.target.sessionId,
            request.target.generation,
            request.target.revision,
            confirmation.providerId,
            confirmation.providerEpoch,
            confirmation.providerLeaseId,
            confirmation.windowId,
            confirmation.windowGeneration,
            confirmation.requestHash,
            createHash('sha256').update(confirmation.nonce).digest('hex'),
            confirmation.expiresAtMs,
            instant
          )
      })
      .immediate()
    return taskConfirmationIssueResultSchema.parse({ confirmation })
  }

  action(input: unknown, binding: TaskBoundWindow): Promise<Result> {
    const parsed = taskActionParamsSchema.safeParse(input)
    if (!parsed.success) fail('invalid_params', 'Task action parameters are invalid')
    const request = parsed.data
    const next = this.chain.then(() => this.act(request, binding))
    this.chain = next.catch(() => undefined)
    return next
  }

  private async act(request: Action, binding: TaskBoundWindow): Promise<Result> {
    this.checkWindow(binding)
    if (request.mutation.expectedRevision !== request.target.revision)
      fail('stale_revision', 'The exact task target changed')
    const replay = this.database
      .prepare(
        'SELECT action,task_kind,session_id,generation,revision,request_hash,result_json FROM task_action_outcomes WHERE idempotency_key = ?'
      )
      .get(request.mutation.idempotencyKey) as OutcomeRow | undefined
    if (replay) {
      if (
        replay.action !== request.action ||
        replay.task_kind !== 'remoteSession' ||
        replay.session_id !== request.target.sessionId ||
        replay.generation !== request.target.generation ||
        replay.revision !== request.target.revision ||
        replay.request_hash !== request.mutation.requestHash
      )
        fail('idempotency_conflict', 'Task action idempotency key conflicts')
      return taskActionResultSchema.parse(JSON.parse(replay.result_json))
    }
    let invocationId: string = randomUUID()
    if (request.action !== 'detach') {
      if (
        request.confirmation.action !== request.action ||
        request.confirmation.kind !== 'remoteSession' ||
        !sameTarget(request.confirmation.target, request.target) ||
        request.confirmation.requestHash !== request.mutation.requestHash
      )
        fail('invalid_state', 'Task confirmation does not match the exact action')
      invocationId = request.confirmation.invocationId
      const consumed = this.consume(
        request.confirmation,
        request.mutation.idempotencyKey,
        request.mutation.requestHash,
        binding
      )
      if (consumed === 'expired')
        return this.record(
          request,
          invocationId,
          this.resultFor(request.target, 'confirmationExpired')
        )
      if (consumed === 'providerLost')
        return this.record(request, invocationId, this.resultFor(request.target, 'providerLost'))
    }
    let current
    try {
      current = this.exactRemote(request.target)
    } catch (error) {
      if (error instanceof TaskActionError && error.code === 'stale_revision') {
        // A process can stop after the remote catalog committed but before this outcome was
        // recorded. Its durable mutation replay distinguishes that case from a stale target.
        try {
          const params = { remoteSessionId: request.target.sessionId, mutation: request.mutation }
          const prior = await this.state.exclusive(() => {
            this.checkWindow(
              binding,
              request.action !== 'detach' ? request.confirmation.windowId : undefined,
              request.action !== 'detach' ? request.confirmation.windowGeneration : undefined
            )
            return request.action === 'detach'
              ? this.state.detachRemoteSession(params)
              : this.state.closeRemoteSession(params)
          })
          await this.remote.terminate(
            prior.session.remoteSessionId,
            prior.session.attemptGeneration
          )
          return this.record(
            request,
            invocationId,
            taskActionResultSchema.parse({
              target: {
                sessionId: prior.session.remoteSessionId,
                generation: prior.session.attemptGeneration,
                revision: prior.session.revision
              },
              revision: prior.session.revision,
              lifecycle: lifecycle(prior.session.state),
              observation: prior.session.observation,
              outcome: 'accepted'
            })
          )
        } catch (recoveryError) {
          if (
            recoveryError instanceof RemoteCatalogError &&
            recoveryError.code === 'idempotency_conflict'
          )
            fail('idempotency_conflict', 'Task action idempotency key conflicts')
          if (!(
            recoveryError instanceof RemoteCatalogError && recoveryError.code === 'stale_revision'
          ))
            throw recoveryError
          return this.record(request, invocationId, this.resultFor(request.target, 'staleTarget'))
        }
      }
      throw error
    }
    const alreadyTerminal =
      request.action === 'detach' ? current.state === 'detached' : current.state === 'closed'
    if (alreadyTerminal)
      return this.record(request, invocationId, this.resultFor(request.target, 'alreadyConverged'))
    if (request.action === 'detach' && !['connected', 'reconnecting'].includes(current.state))
      fail('invalid_params', 'Remote session cannot be detached from its current state')
    if (request.action !== 'detach' && current.state === 'failed')
      fail('invalid_params', 'Remote session cannot be terminated from its current state')
    let changed
    try {
      changed = await this.state.exclusive(() => {
        this.checkWindow(
          binding,
          request.action !== 'detach' ? request.confirmation.windowId : undefined,
          request.action !== 'detach' ? request.confirmation.windowGeneration : undefined
        )
        const latest = this.state.getRemoteSession(request.target.sessionId).session
        if (
          !sameTarget(
            {
              sessionId: latest.remoteSessionId,
              generation: latest.attemptGeneration,
              revision: latest.revision
            },
            request.target
          )
        )
          fail('stale_revision', 'The exact task target changed')
        const params = { remoteSessionId: request.target.sessionId, mutation: request.mutation }
        return request.action === 'detach'
          ? this.state.detachRemoteSession(params)
          : this.state.closeRemoteSession(params)
      })
    } catch (error) {
      if (
        (error instanceof TaskActionError && error.code === 'stale_revision') ||
        (error instanceof RemoteCatalogError && error.code === 'stale_revision')
      )
        return this.record(request, invocationId, this.resultFor(request.target, 'staleTarget'))
      throw error
    }
    await this.remote.terminate(changed.session.remoteSessionId, changed.session.attemptGeneration)
    const session = changed.session
    return this.record(
      request,
      invocationId,
      taskActionResultSchema.parse({
        target: {
          sessionId: session.remoteSessionId,
          generation: session.attemptGeneration,
          revision: session.revision
        },
        revision: session.revision,
        lifecycle: lifecycle(session.state),
        observation: session.observation,
        outcome: 'accepted'
      })
    )
  }

  private consume(
    confirmation: Confirmation,
    idempotencyKey: string,
    requestHash: string,
    binding: TaskBoundWindow
  ): 'consumed' | 'expired' | 'providerLost' {
    const instant = this.timestamp()
    const row = this.database
      .prepare('SELECT * FROM task_confirmations WHERE invocation_id = ?')
      .get(confirmation.invocationId) as ConfirmationRow | undefined
    if (!row) fail('invalid_state', 'Task confirmation is unavailable')
    if (row.consumed_at_ms !== null && row.consumed_idempotency_key !== idempotencyKey)
      fail('invalid_state', 'Task confirmation is already consumed')
    if (row.consumed_at_ms === null) {
      // Burn even a tampered or expired confirmation, matching Rust's single-use fence.
      const updated = this.database
        .prepare(
          `UPDATE task_confirmations SET consumed_at_ms=?,
        consumed_idempotency_key=? WHERE invocation_id=? AND consumed_at_ms IS NULL`
        )
        .run(instant, idempotencyKey, confirmation.invocationId)
      if (updated.changes !== 1) fail('invalid_state', 'Task confirmation is already consumed')
    }
    if (
      row.action !== confirmation.action ||
      row.task_kind !== confirmation.kind ||
      row.session_id !== confirmation.target.sessionId ||
      row.generation !== confirmation.target.generation ||
      row.revision !== confirmation.target.revision ||
      row.provider_id !== confirmation.providerId ||
      row.provider_epoch !== confirmation.providerEpoch ||
      row.provider_lease_id !== confirmation.providerLeaseId ||
      row.window_id !== confirmation.windowId ||
      row.window_generation !== confirmation.windowGeneration ||
      row.request_hash !== confirmation.requestHash ||
      requestHash !== confirmation.requestHash ||
      row.nonce_hash !== createHash('sha256').update(confirmation.nonce).digest('hex')
    )
      fail('invalid_state', 'Task confirmation does not match the exact action')
    if (row.expires_at_ms <= instant) return 'expired'
    if (
      confirmation.providerId !== this.providerId ||
      confirmation.providerLeaseId !== this.leaseId ||
      confirmation.providerEpoch !== 1 ||
      confirmation.windowId !== binding.windowId ||
      !this.windowCurrent(binding, confirmation.windowGeneration)
    )
      return 'providerLost'
    return 'consumed'
  }

  private exactRemote(target: Target) {
    let session
    try {
      session = this.state.getRemoteSession(target.sessionId).session
    } catch (error) {
      if (error instanceof RemoteCatalogError && error.code === 'session_not_found')
        fail('provider_unavailable', 'The authoritative task owner is unavailable')
      throw error
    }
    if (
      !sameTarget(
        {
          sessionId: session.remoteSessionId,
          generation: session.attemptGeneration,
          revision: session.revision
        },
        target
      )
    )
      fail('stale_revision', 'The exact task target changed')
    return session
  }

  private resultFor(target: Target, outcome: Result['outcome']): Result {
    let session
    try {
      session = this.state.getRemoteSession(target.sessionId).session
    } catch {
      fail('provider_unavailable', 'The authoritative task owner is unavailable')
    }
    return taskActionResultSchema.parse({
      target: {
        sessionId: session.remoteSessionId,
        generation: session.attemptGeneration,
        revision: session.revision
      },
      revision: session.revision,
      lifecycle: lifecycle(session.state),
      observation: session.observation,
      outcome
    })
  }

  private record(request: Action, invocationId: string, result: Result): Result {
    this.database
      .transaction(() => {
        const count = this.database
          .prepare('SELECT count(*) AS count FROM task_action_outcomes')
          .get() as { count: number }
        if (count.count >= MAX_OUTCOMES)
          fail('resource_limit', 'Task action outcome capacity reached')
        this.database
          .prepare(
            `INSERT INTO task_action_outcomes
        (idempotency_key,request_hash,invocation_id,action,task_kind,session_id,generation,
         revision,result_json,completed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            request.mutation.idempotencyKey,
            request.mutation.requestHash,
            invocationId,
            request.action,
            'remoteSession',
            request.target.sessionId,
            request.target.generation,
            request.target.revision,
            JSON.stringify(result),
            this.timestamp()
          )
      })
      .immediate()
    return result
  }

  private checkWindow(binding: TaskBoundWindow, windowId?: string, generation?: number): void {
    if (
      !binding.isCurrent() ||
      (windowId !== undefined && windowId !== binding.windowId) ||
      !this.windowCurrent(binding, generation)
    )
      fail('unauthorized', 'Bound window is unavailable')
  }

  private windowCurrent(binding: TaskBoundWindow, generation?: number): boolean {
    const placement = this.state
      .readSnapshot()
      .windowPlacements.find(
        (window) => window.id === binding.windowId && window.hostingState !== 'closing'
      )
    return (
      !!placement &&
      (generation === undefined || placement.revision === generation) &&
      binding.isCurrent()
    )
  }

  private timestamp(): number {
    const instant = this.now()
    if (!Number.isSafeInteger(instant) || instant < 0 || instant > Number.MAX_SAFE_INTEGER - TTL_MS)
      fail('invalid_state', 'Task action clock is invalid')
    return instant
  }
}
