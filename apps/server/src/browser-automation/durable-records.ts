import { createHash, randomUUID } from 'node:crypto'

import type Database from 'better-sqlite3'
import {
  browserAutomationOperationSnapshotSchema,
  browserAutomationProviderAcknowledgeParamsSchema,
  browserAutomationProviderRequestSchema,
  browserAutomationSessionSnapshotSchema
} from '@agent-workspace/protocol-client'
import type {
  BrowserAutomationOperationResultData,
  BrowserAutomationOperationSnapshot,
  BrowserAutomationOperationInvokeParams,
  BrowserAutomationOperationCancelParams,
  BrowserAutomationProviderAcknowledgeParams,
  BrowserAutomationProviderRequest,
  BrowserAutomationSessionSnapshot,
  BrowserAutomationSessionCreateParams
} from '@agent-workspace/protocol-client'

import type { BrowserAutomationProviderAuthority } from './provider-authority'
import { BrowserAutomationScreenshotHandles, type ScreenshotOwnership } from './screenshot-handles'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CONTENT_TTL_MS = 60_000
const SESSION_TTL_MS = 30 * 60_000
const MAX_EPHEMERAL_RESULTS = 256
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'canceled', 'expired', 'interrupted', 'resultExpired'])

type SessionRow = {
  automation_session_id: string; caller_id: string; profile_key: string; mode: 'attach' | 'ephemeral'
  state: string; generation: number; navigation_epoch: number
  workspace_id: string | null; pane_id: string | null; tab_id: string | null
  browser_session_id: string | null; browser_lifecycle_id: string | null
  provider_id: string; provider_epoch: number; provider_lease_id: string
  window_id: string; window_generation: number
  lifecycle_operation_id: string; lifecycle_correlation_id: string; lifecycle_attempt_epoch: number
  created_at_ms: number; updated_at_ms: number; expires_at_ms: number
  idempotency_epoch: string; idempotency_key: string; request_digest: string
}
type OperationRow = {
  operation_id: string; automation_session_id: string; caller_id: string
  session_generation: number; navigation_epoch: number; attempt_epoch: number
  correlation_id: string; operation_kind: string; state: string
  provider_id: string; provider_epoch: number; provider_lease_id: string
  window_id: string; window_generation: number
  result_kind: string | null; error_code: string | null
  updated_at_ms: number; expires_at_ms: number
  idempotency_epoch: string; idempotency_key: string; request_digest: string
}
type StageOptions = {
  callerId: string
  idempotencyEpoch: string
  idempotencyKey: string
}

/** Durable v15 records. Callers must publish only after staging succeeds. */
export class BrowserAutomationDurableRecords {
  private readonly results = new Map<string, { value: BrowserAutomationOperationResultData; expiresAtMs: number }>()
  public readonly handles: BrowserAutomationScreenshotHandles
  private readonly hasTombstones: boolean

  public constructor(
    private readonly database: Database.Database,
    private readonly authority: BrowserAutomationProviderAuthority,
    private readonly digestKey: Buffer,
    private readonly now: () => number = Date.now
  ) {
    if (digestKey.length < 32) throw new Error('Automation digest key is too short')
    this.handles = new BrowserAutomationScreenshotHandles(now)
    this.hasTombstones = Boolean(this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'browser_automation_tombstones'"
    ).get())
  }

  public listSessions(callerId: string): BrowserAutomationSessionSnapshot[] {
    const rows = this.database.prepare(`SELECT automation_session_id FROM browser_automation_sessions
      WHERE caller_id = ? AND state IN ('creating', 'ready', 'destroying')
      ORDER BY sequence LIMIT 16`).all(callerId) as Array<{ automation_session_id: string }>
    return rows.flatMap(({ automation_session_id }) => {
      const snapshot = this.getSessionSnapshot(automation_session_id)
      return snapshot ? [snapshot] : []
    })
  }

  public getOwnedSession(id: string, generation: number, callerId: string): BrowserAutomationSessionSnapshot | undefined {
    const row = this.session(id)
    if (row?.caller_id !== callerId || row.generation !== generation) return undefined
    const snapshot = this.getSessionSnapshot(id)
    if (!snapshot) throw new Error('result_expired')
    return snapshot
  }

  public sessionReplay(params: BrowserAutomationSessionCreateParams, callerId: string):
    { state: 'none' | 'pending' | 'replay'; sessionId?: string; snapshot?: BrowserAutomationSessionSnapshot } {
    const digest = this.sessionDigest(params)
    const row = this.database.prepare(`SELECT * FROM browser_automation_sessions
      WHERE idempotency_epoch = ? AND idempotency_key = ?`).get(
      params.idempotency.epoch, params.idempotency.key
    ) as SessionRow | undefined
    if (row) {
      if (row.caller_id !== callerId || row.request_digest !== digest) throw new Error('idempotency_conflict')
      const snapshot = this.getSessionSnapshot(row.automation_session_id)
      if (row.state === 'creating') return { state: 'pending', sessionId: row.automation_session_id }
      if (row.state !== 'ready') throw new Error('interrupted')
      if (!snapshot) throw new Error('result_expired')
      return { state: 'replay', snapshot }
    }
    this.checkTombstone('sessionCreate', params.idempotency.epoch, params.idempotency.key, digest)
    return { state: 'none' }
  }

  public operationReplay(params: BrowserAutomationOperationInvokeParams, callerId: string):
    { state: 'none' | 'replay'; snapshot?: BrowserAutomationOperationSnapshot } {
    const digest = this.digest('operation', params)
    const row = this.operation(params.operationId) ?? this.database.prepare(`SELECT * FROM browser_automation_operations
      WHERE idempotency_epoch = ? AND idempotency_key = ?`).get(
      params.idempotency.epoch, params.idempotency.key
    ) as OperationRow | undefined
    if (row) {
      if (row.caller_id !== callerId || row.operation_id !== params.operationId ||
          row.automation_session_id !== params.automationSessionId ||
          row.session_generation !== params.sessionGeneration ||
          row.navigation_epoch !== params.navigationEpoch ||
          row.attempt_epoch !== params.attemptEpoch || row.correlation_id !== params.correlationId ||
          row.idempotency_epoch !== params.idempotency.epoch ||
          row.idempotency_key !== params.idempotency.key || row.request_digest !== digest)
        throw new Error('idempotency_conflict')
      return { state: 'replay', snapshot: this.operationSnapshot(row, this.instant()) }
    }
    this.checkTombstone('operation', params.idempotency.epoch, params.idempotency.key, digest)
    return { state: 'none' }
  }

  public cancelOperation(params: BrowserAutomationOperationCancelParams, callerId: string):
    { snapshot: BrowserAutomationOperationSnapshot; canceledNow: boolean;
      identity: { providerId: string; providerEpoch: number; leaseId: string };
      target: { windowId: string; windowGeneration: number } } {
    const row = this.operation(params.operationId)
    if (!row || row.caller_id !== callerId || row.automation_session_id !== params.automationSessionId ||
        row.session_generation !== params.sessionGeneration || row.correlation_id !== params.correlationId)
      throw new Error('invalid_operation')
    const canceledNow = row.state === 'queued' || row.state === 'running'
    if (canceledNow) {
      const instant = this.instant()
      this.database.prepare(`UPDATE browser_automation_operations SET state = 'canceled',
        error_code = 'canceled', updated_at_ms = ?, terminal_at_ms = ?
        WHERE operation_id = ? AND terminal_at_ms IS NULL`).run(instant, instant, row.operation_id)
      this.results.delete(row.operation_id)
    }
    return {
      snapshot: this.operationSnapshot(this.operation(row.operation_id)!, this.instant()),
      canceledNow,
      identity: { providerId: row.provider_id, providerEpoch: row.provider_epoch,
        leaseId: row.provider_lease_id },
      target: { windowId: row.window_id, windowGeneration: row.window_generation }
    }
  }

  /** A new Node owner has no old Electron provider lease or in-memory result bytes. */
  public recoverAfterRestart(): void {
    const instant = this.instant()
    this.database.transaction(() => {
      this.database.prepare(`UPDATE browser_automation_operations
        SET state = 'interrupted', error_code = 'interrupted',
            updated_at_ms = MAX(updated_at_ms, ?), terminal_at_ms = MAX(updated_at_ms, ?)
        WHERE state IN ('queued', 'running')`).run(instant, instant)
      this.database.prepare(`UPDATE browser_automation_sessions
        SET state = CASE WHEN state = 'ready' THEN 'expired' ELSE 'failed' END,
            updated_at_ms = MAX(updated_at_ms, ?), terminal_at_ms = MAX(updated_at_ms, ?)
        WHERE state IN ('creating', 'ready', 'destroying')`).run(instant, instant)
    })()
    this.results.clear()
    this.handles.clear()
  }

  /** Reconcile a bounded page of live records against the private provider lease. */
  public reconcile(): void {
    const instant = this.instant()
    for (const [id, result] of this.results) {
      if (result.expiresAtMs <= instant) this.results.delete(id)
    }
    this.handles.prune()
    const operations = this.database.prepare(`SELECT * FROM browser_automation_operations
      WHERE state IN ('queued', 'running') ORDER BY sequence LIMIT 4096`).all() as OperationRow[]
    for (const row of operations) {
      const identity = { providerId: row.provider_id, providerEpoch: row.provider_epoch,
        leaseId: row.provider_lease_id }
      const target = { windowId: row.window_id, windowGeneration: row.window_generation }
      const expired = row.expires_at_ms <= instant
      if (!expired && this.authority.isCurrent(identity, target) &&
          this.authority.mailbox.has(row.operation_id)) continue
      const updated = Math.max(instant, row.updated_at_ms)
      this.database.prepare(`UPDATE browser_automation_operations SET state = ?, error_code = ?,
        updated_at_ms = ?, terminal_at_ms = ? WHERE operation_id = ? AND state IN ('queued', 'running')`)
        .run(expired ? 'expired' : 'interrupted', expired ? 'timeout' : 'interrupted',
          updated, updated, row.operation_id)
      this.authority.mailbox.cancel(row.operation_id)
      this.results.delete(row.operation_id)
    }
    const sessions = this.database.prepare(`SELECT * FROM browser_automation_sessions
      WHERE state IN ('creating', 'ready', 'destroying') ORDER BY sequence LIMIT 4096`).all() as SessionRow[]
    for (const row of sessions) {
      const identity = { providerId: row.provider_id, providerEpoch: row.provider_epoch,
        leaseId: row.provider_lease_id }
      const target = { windowId: row.window_id, windowGeneration: row.window_generation }
      const active = this.authority.isCurrent(identity, target)
      if (active && (row.state === 'destroying' && this.authority.mailbox.has(row.lifecycle_operation_id) ||
          row.expires_at_ms > instant && (row.state === 'ready' ||
            this.authority.mailbox.has(row.lifecycle_operation_id)))) continue
      this.handles.releaseSession(row.automation_session_id)
      if (active && row.state === 'ready' && row.expires_at_ms <= instant) {
        const snapshot = this.getSessionSnapshot(row.automation_session_id)
        if (snapshot) {
          this.authority.mailbox.cancelSession(row.automation_session_id)
          const request: BrowserAutomationProviderRequest = {
            kind: 'destroy', identity, target, session: snapshot,
            operationId: randomUUID(), correlationId: randomUUID(), attemptEpoch: identity.providerEpoch
          }
          this.stageDestroy(request, row.caller_id)
          try {
            const { completion } = this.authority.mailbox.publish(request)
            void completion.then((result) => {
              if (result.kind === 'interrupted') this.interrupt(request)
            })
            continue
          } catch { this.interrupt(request) }
        }
      }
      const updated = Math.max(instant, row.updated_at_ms)
      this.database.prepare(`UPDATE browser_automation_sessions SET state = ?,
        updated_at_ms = ?, terminal_at_ms = ?
        WHERE automation_session_id = ? AND state IN ('creating', 'ready', 'destroying')`)
        .run(row.state === 'ready' && !active ? 'failed' : row.expires_at_ms <= instant ? 'expired' : 'failed',
          updated, updated, row.automation_session_id)
      this.authority.mailbox.cancel(row.lifecycle_operation_id)
    }
  }

  public getSessionSnapshot(id: string): BrowserAutomationSessionSnapshot | undefined {
    if (!UUID.test(id)) return undefined
    const row = this.session(id)
    if (!row || !row.workspace_id || !row.pane_id || !row.tab_id ||
        !row.browser_session_id || !row.browser_lifecycle_id) return undefined
    return browserAutomationSessionSnapshotSchema.parse({
      automationSessionId: row.automation_session_id,
      generation: row.generation,
      navigationEpoch: row.navigation_epoch,
      mode: row.mode,
      state: row.state,
      profileKey: row.profile_key,
      target: {
        workspaceId: row.workspace_id, paneId: row.pane_id, tabId: row.tab_id,
        browserSessionId: row.browser_session_id, browserLifecycleId: row.browser_lifecycle_id,
        window: { windowId: row.window_id, windowGeneration: row.window_generation }
      },
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      expiresAtMs: row.expires_at_ms
    }) as BrowserAutomationSessionSnapshot
  }

  public getOperationSnapshot(id: string): BrowserAutomationOperationSnapshot | undefined {
    if (!UUID.test(id)) return undefined
    const row = this.operation(id)
    return row ? this.operationSnapshot(row, this.instant()) : undefined
  }

  /** Terminalizes work whose provider request was interrupted before acknowledgement. */
  public interrupt(request: BrowserAutomationProviderRequest): void {
    const instant = this.instant()
    this.database.transaction(() => {
      if (request.kind === 'create' || request.kind === 'destroy') {
        const row = this.session(request.kind === 'create'
          ? request.provision.automationSessionId : request.session.automationSessionId)
        if (!row || row.lifecycle_operation_id !== request.operationId ||
            row.lifecycle_correlation_id !== request.correlationId ||
            !sameFence(row, request.identity, request.target)) return
        this.database.prepare(`UPDATE browser_automation_sessions SET state = ?,
          updated_at_ms = ?, terminal_at_ms = ? WHERE automation_session_id = ?
          AND state IN ('creating', 'destroying')`).run(
          request.kind === 'destroy' ? 'destroyed' : 'failed', instant, instant,
          row.automation_session_id
        )
      } else if (request.kind === 'execute') {
        const operation = request.request.operation
        const row = this.operation(operation.operationId)
        if (!row || row.correlation_id !== operation.correlationId ||
            !sameFence(row, request.request.identity, request.request.target)) return
        this.database.prepare(`UPDATE browser_automation_operations SET state = 'interrupted',
          error_code = 'interrupted', updated_at_ms = ?, terminal_at_ms = ?
          WHERE operation_id = ? AND state IN ('queued', 'running')`).run(
          instant, instant, row.operation_id
        )
      }
    })()
    if (request.kind === 'destroy') this.handles.releaseSession(request.session.automationSessionId)
  }

  public stageSession(input: BrowserAutomationProviderRequest, options: StageOptions): void {
    const request = browserAutomationProviderRequestSchema.parse(input)
    if (request.kind !== 'create') throw new Error('invalid_operation')
    this.validateStage(options)
    if (!this.authority.isCurrent(request.identity, request.target)) throw new Error('provider_epoch_mismatch')
    if (request.provision.requestedTarget &&
        !sameWindow(request.provision.requestedTarget.window, request.target))
      throw new Error('target_stale')
    const instant = this.instant()
    if (request.provision.createdAtMs > instant || request.provision.expiresAtMs <= instant)
      throw new Error('invalid_operation')
    const digest = this.sessionDigest({
      mode: request.provision.mode, profileKey: request.provision.profileKey,
      ...(request.provision.requestedTarget ? { target: request.provision.requestedTarget } : {}),
      idempotency: { epoch: options.idempotencyEpoch, key: options.idempotencyKey },
      correlationId: request.correlationId
    })
    this.database.transaction(() => {
      const existing = this.database.prepare(`SELECT request_digest FROM browser_automation_sessions
        WHERE idempotency_epoch = ? AND idempotency_key = ?`).get(
        options.idempotencyEpoch, options.idempotencyKey
      ) as { request_digest: string } | undefined
      if (existing) {
        if (existing.request_digest !== digest) throw new Error('idempotency_conflict')
        return
      }
      const profileCount = this.database.prepare(`SELECT COUNT(*) AS count FROM browser_automation_sessions
        WHERE profile_key = ? AND state IN ('creating', 'ready', 'destroying')`)
        .get(request.provision.profileKey) as { count: number }
      const providerCount = this.database.prepare(`SELECT COUNT(*) AS count FROM browser_automation_sessions
        WHERE provider_id = ? AND state IN ('creating', 'ready', 'destroying')`)
        .get(request.identity.providerId) as { count: number }
      if (profileCount.count >= 16 || providerCount.count >= 8) throw new Error('session_limit')
      const target = request.provision.requestedTarget
      this.database.prepare(`INSERT INTO browser_automation_sessions
        (automation_session_id, caller_id, profile_key, mode, state, generation, navigation_epoch,
         workspace_id, pane_id, tab_id, browser_session_id, browser_lifecycle_id,
         provider_id, provider_epoch, provider_lease_id, window_id, window_generation,
         lifecycle_operation_id, lifecycle_correlation_id, lifecycle_attempt_epoch,
         idempotency_epoch, idempotency_key, request_digest,
         created_at_ms, updated_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, 'creating', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          request.provision.automationSessionId, options.callerId, request.provision.profileKey,
          request.provision.mode, request.provision.generation,
          target?.workspaceId ?? null, target?.paneId ?? null, target?.tabId ?? null,
          target?.browserSessionId ?? null, target?.browserLifecycleId ?? null,
          request.identity.providerId, request.identity.providerEpoch, request.identity.leaseId,
          request.target.windowId, request.target.windowGeneration,
          request.operationId, request.correlationId, request.attemptEpoch,
          options.idempotencyEpoch, options.idempotencyKey, digest,
          request.provision.createdAtMs, instant, request.provision.expiresAtMs
        )
    })()
  }

  public stageOperation(input: BrowserAutomationProviderRequest, options: StageOptions): void {
    const request = browserAutomationProviderRequestSchema.parse(input)
    if (request.kind !== 'execute') throw new Error('invalid_operation')
    this.validateStage(options)
    const { identity, target, session, operation } = request.request
    if (operation.idempotency.epoch !== options.idempotencyEpoch ||
        operation.idempotency.key !== options.idempotencyKey)
      throw new Error('invalid_operation')
    if (!this.authority.isCurrent(identity, target)) throw new Error('provider_epoch_mismatch')
    const instant = this.instant()
    const digest = this.digest('operation', operation)
    this.database.transaction(() => {
      const existing = this.database.prepare(`SELECT request_digest FROM browser_automation_operations
        WHERE idempotency_epoch = ? AND idempotency_key = ?`).get(
        options.idempotencyEpoch, options.idempotencyKey
      ) as { request_digest: string } | undefined
      if (existing) {
        if (existing.request_digest !== digest) throw new Error('idempotency_conflict')
        return
      }
      const row = this.session(session.automationSessionId)
      if (!row || row.state !== 'ready' || row.caller_id !== options.callerId ||
          session.state !== 'ready' || session.generation !== operation.sessionGeneration ||
          session.navigationEpoch !== operation.navigationEpoch ||
          session.mode !== row.mode || session.profileKey !== row.profile_key ||
          operation.automationSessionId !== session.automationSessionId ||
          row.generation !== operation.sessionGeneration ||
          row.navigation_epoch !== operation.navigationEpoch ||
          !sameFence(row, identity, target)) throw new Error('session_generation_mismatch')
      if (!row.workspace_id || row.workspace_id !== session.target.workspaceId ||
          row.pane_id !== session.target.paneId || row.tab_id !== session.target.tabId ||
          row.browser_session_id !== session.target.browserSessionId ||
          row.browser_lifecycle_id !== session.target.browserLifecycleId ||
          !sameWindow(session.target.window, target)) throw new Error('target_stale')
      const queued = this.database.prepare(`SELECT COUNT(*) AS count FROM browser_automation_operations
        WHERE automation_session_id = ? AND state IN ('queued', 'running')`)
        .get(session.automationSessionId) as { count: number }
      if (queued.count >= 32) throw new Error('automation_backpressure')
      if (operation.timeoutMs > 120_000 || instant + operation.timeoutMs > Number.MAX_SAFE_INTEGER)
        throw new Error('invalid_operation')
      const inputBytes = Buffer.byteLength(JSON.stringify(operation.operation))
      if (inputBytes > 65_536) throw new Error('resource_limit')
      this.database.prepare(`INSERT INTO browser_automation_operations
        (operation_id, automation_session_id, caller_id, session_generation, navigation_epoch,
         attempt_epoch, correlation_id, idempotency_epoch, idempotency_key, request_digest,
         operation_kind, input_bytes, state, provider_id, provider_epoch, provider_lease_id,
         window_id, window_generation, accepted_at_ms, updated_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          operation.operationId, session.automationSessionId, options.callerId,
          operation.sessionGeneration, operation.navigationEpoch, operation.attemptEpoch,
          operation.correlationId, options.idempotencyEpoch, options.idempotencyKey, digest,
          operation.operation.kind, inputBytes,
          identity.providerId, identity.providerEpoch, identity.leaseId,
          target.windowId, target.windowGeneration,
          instant, instant, instant + operation.timeoutMs
        )
      this.database.prepare(`UPDATE browser_automation_sessions SET updated_at_ms = ?,
        expires_at_ms = MAX(expires_at_ms, ?) WHERE automation_session_id = ?`)
        .run(instant, instant + SESSION_TTL_MS, session.automationSessionId)
    })()
  }

  public stageDestroy(input: BrowserAutomationProviderRequest, callerId: string): void {
    const request = browserAutomationProviderRequestSchema.parse(input)
    if (request.kind !== 'destroy' || !UUID.test(callerId)) throw new Error('invalid_operation')
    if (!this.authority.isCurrent(request.identity, request.target)) throw new Error('provider_epoch_mismatch')
    const instant = this.instant()
    this.database.transaction(() => {
      const row = this.session(request.session.automationSessionId)
      if (!row || row.state !== 'ready' || row.caller_id !== callerId ||
          row.generation !== request.session.generation ||
          row.navigation_epoch !== request.session.navigationEpoch ||
          row.mode !== request.session.mode || row.profile_key !== request.session.profileKey ||
          row.workspace_id !== request.session.target.workspaceId ||
          row.pane_id !== request.session.target.paneId || row.tab_id !== request.session.target.tabId ||
          row.browser_session_id !== request.session.target.browserSessionId ||
          row.browser_lifecycle_id !== request.session.target.browserLifecycleId ||
          !sameWindow(request.session.target.window, request.target) ||
          !sameFence(row, request.identity, request.target)) throw new Error('session_generation_mismatch')
      this.database.prepare(`UPDATE browser_automation_sessions SET state = 'destroying',
        lifecycle_operation_id = ?, lifecycle_correlation_id = ?, lifecycle_attempt_epoch = ?,
        updated_at_ms = ? WHERE automation_session_id = ? AND state = 'ready'`).run(
        request.operationId, request.correlationId, request.attemptEpoch,
        instant, row.automation_session_id
      )
      this.database.prepare(`UPDATE browser_automation_operations
        SET state = 'interrupted', error_code = 'interrupted', updated_at_ms = ?, terminal_at_ms = ?
        WHERE automation_session_id = ? AND state IN ('queued', 'running')`).run(
        instant, instant, row.automation_session_id
      )
    })()
    this.handles.releaseSession(request.session.automationSessionId)
  }

  /** Commit an exact provider acknowledgement before releasing its mailbox entry. */
  public acknowledge(input: BrowserAutomationProviderAcknowledgeParams): BrowserAutomationOperationSnapshot {
    const ack = browserAutomationProviderAcknowledgeParamsSchema.parse(input) as BrowserAutomationProviderAcknowledgeParams
    this.authority.mailbox.validateAcknowledge(ack)
    const instant = this.instant()
    let screenshotOwnership: ScreenshotOwnership | undefined
    let acceptedResult = false
    const snapshot = this.database.transaction(() => {
      const session = this.session(ack.automationSessionId)
      if (session?.lifecycle_operation_id === ack.operationId) {
        return this.acknowledgeSession(session, ack, instant)
      }
      const operation = this.operation(ack.operationId)
      if (!operation || operation.automation_session_id !== ack.automationSessionId ||
          operation.session_generation !== ack.sessionGeneration ||
          operation.correlation_id !== ack.correlationId ||
          operation.attempt_epoch !== ack.attemptEpoch ||
          !sameFence(operation, ack.identity, ack.target))
        throw new Error('provider_epoch_mismatch')
      if (TERMINAL_STATES.has(operation.state)) return this.operationSnapshot(operation, instant)
      if (instant >= operation.expires_at_ms) {
        this.database.prepare(`UPDATE browser_automation_operations SET state = 'expired',
          error_code = 'timeout', updated_at_ms = ?, terminal_at_ms = ?
          WHERE operation_id = ? AND terminal_at_ms IS NULL`).run(instant, instant, operation.operation_id)
        return this.operationSnapshot(this.operation(operation.operation_id)!, instant)
      }
      const result = ack.result ?? undefined
      if (ack.state === 'succeeded' && (!result ||
          !resultMatches(operation.operation_kind, result) ||
          (result.kind === 'navigation' && result.navigationEpoch !== operation.navigation_epoch + 1)))
        throw new Error('invalid_operation')
      if (result?.kind === 'screenshot') {
        const session = this.session(operation.automation_session_id)
        if (!session || session.state !== 'ready' || session.generation !== operation.session_generation ||
            !sameFence(session, ack.identity, ack.target)) throw new Error('session_generation_mismatch')
        screenshotOwnership = {
          callerId: operation.caller_id,
          automationSessionId: operation.automation_session_id,
          sessionGeneration: operation.session_generation,
          profileKey: session.profile_key,
          identity: ack.identity,
          target: ack.target,
          handle: result.handle
        }
        this.handles.validate(screenshotOwnership)
      }
      const digest = result ? this.digest('result', result) : null
      const bytes = result ? Buffer.byteLength(JSON.stringify(result)) : null
      this.database.prepare(`UPDATE browser_automation_operations SET state = ?, result_kind = ?,
        result_digest = ?, result_bytes = ?, error_code = ?, updated_at_ms = ?, terminal_at_ms = ?
        WHERE operation_id = ? AND terminal_at_ms IS NULL`).run(
        ack.state, result?.kind ?? null, digest, bytes, ack.errorCode ?? null,
        instant, instant, ack.operationId
      )
      if (result?.kind === 'navigation') {
        const advanced = this.database.prepare(`UPDATE browser_automation_sessions
          SET navigation_epoch = navigation_epoch + 1, updated_at_ms = ?
          WHERE automation_session_id = ? AND generation = ? AND navigation_epoch = ?
          AND state = 'ready'`).run(
          instant, ack.automationSessionId, ack.sessionGeneration, operation.navigation_epoch
        )
        if (advanced.changes !== 1) throw new Error('stale_navigation')
      }
      acceptedResult = result !== undefined
      return this.operationSnapshot(this.operation(ack.operationId)!, instant, result)
    })()
    if (screenshotOwnership) this.handles.register(screenshotOwnership)
    if (acceptedResult && ack.result) {
      for (const [operationId, retained] of this.results) {
        if (retained.expiresAtMs <= instant) this.results.delete(operationId)
      }
      while (this.results.size >= MAX_EPHEMERAL_RESULTS) {
        this.results.delete(this.results.keys().next().value!)
      }
      this.results.set(ack.operationId, { value: ack.result, expiresAtMs: instant + CONTENT_TTL_MS })
    }
    this.authority.mailbox.acknowledge(ack)
    return snapshot
  }

  private acknowledgeSession(row: SessionRow, ack: BrowserAutomationProviderAcknowledgeParams, instant: number): BrowserAutomationOperationSnapshot {
    if (row.generation !== ack.sessionGeneration || row.lifecycle_correlation_id !== ack.correlationId ||
        row.lifecycle_attempt_epoch !== ack.attemptEpoch || !sameFence(row, ack.identity, ack.target) ||
        (row.state !== 'creating' && row.state !== 'destroying')) throw new Error('provider_epoch_mismatch')
    if (row.state === 'destroying') {
      if (ack.session || ack.result) throw new Error('invalid_operation')
      this.database.prepare(`UPDATE browser_automation_sessions SET state = ?,
        updated_at_ms = ?, terminal_at_ms = ? WHERE automation_session_id = ? AND state = 'destroying'`)
        .run(ack.state === 'succeeded' ? 'destroyed' : 'failed', instant, instant, row.automation_session_id)
      return browserAutomationOperationSnapshotSchema.parse({
        automationSessionId: row.automation_session_id,
        sessionGeneration: row.generation,
        operationId: row.lifecycle_operation_id,
        correlationId: row.lifecycle_correlation_id,
        attemptEpoch: row.lifecycle_attempt_epoch,
        navigationEpoch: row.navigation_epoch,
        state: ack.state,
        ...(ack.state === 'succeeded' ? { result: { kind: 'empty' } } : { errorCode: ack.errorCode }),
        updatedAtMs: instant
      }) as BrowserAutomationOperationSnapshot
    }
    if (ack.state === 'succeeded') {
      const result = ack.session
      if (!result || result.mode !== row.mode || result.profileKey !== row.profile_key ||
          result.navigationEpoch !== row.navigation_epoch ||
          !sameWindow(result.target.window, ack.target) ||
          (row.workspace_id !== null &&
            (row.workspace_id !== result.target.workspaceId || row.pane_id !== result.target.paneId ||
             row.tab_id !== result.target.tabId || row.browser_session_id !== result.target.browserSessionId ||
             row.browser_lifecycle_id !== result.target.browserLifecycleId)))
        throw new Error('provider_epoch_mismatch')
      this.database.prepare(`UPDATE browser_automation_sessions SET state = 'ready',
        workspace_id = ?, pane_id = ?, tab_id = ?, browser_session_id = ?, browser_lifecycle_id = ?,
        updated_at_ms = ? WHERE automation_session_id = ? AND state = 'creating'`).run(
        result.target.workspaceId, result.target.paneId, result.target.tabId,
        result.target.browserSessionId, result.target.browserLifecycleId,
        instant, row.automation_session_id
      )
    } else {
      this.database.prepare(`UPDATE browser_automation_sessions SET state = 'failed',
        updated_at_ms = ?, terminal_at_ms = ? WHERE automation_session_id = ? AND state = 'creating'`)
        .run(instant, instant, row.automation_session_id)
    }
    return browserAutomationOperationSnapshotSchema.parse({
      automationSessionId: row.automation_session_id,
      sessionGeneration: row.generation,
      operationId: row.lifecycle_operation_id,
      correlationId: row.lifecycle_correlation_id,
      attemptEpoch: row.lifecycle_attempt_epoch,
      navigationEpoch: row.navigation_epoch,
      state: ack.state,
      ...(ack.state === 'succeeded' ? { result: { kind: 'empty' } } : { errorCode: ack.errorCode }),
      updatedAtMs: instant
    }) as BrowserAutomationOperationSnapshot
  }

  private operationSnapshot(
    row: OperationRow,
    instant: number,
    committedResult?: BrowserAutomationOperationResultData
  ): BrowserAutomationOperationSnapshot {
    const retained = this.results.get(row.operation_id)
    const result = committedResult ?? (retained && retained.expiresAtMs > instant ? retained.value
      : row.state === 'succeeded' && row.result_kind === 'empty' ? { kind: 'empty' as const } : undefined
    )
    const expired = row.state === 'succeeded' && !result
    return browserAutomationOperationSnapshotSchema.parse({
      automationSessionId: row.automation_session_id,
      sessionGeneration: row.session_generation,
      operationId: row.operation_id,
      correlationId: row.correlation_id,
      attemptEpoch: row.attempt_epoch,
      navigationEpoch: row.navigation_epoch,
      state: expired ? 'resultExpired' : row.state,
      ...(result ? { result } : {}),
      ...(expired ? { errorCode: 'result_expired' } : row.error_code ? { errorCode: row.error_code } : {}),
      updatedAtMs: row.updated_at_ms
    }) as BrowserAutomationOperationSnapshot
  }

  private session(id: string): SessionRow | undefined {
    return this.database.prepare('SELECT * FROM browser_automation_sessions WHERE automation_session_id = ?')
      .get(id) as SessionRow | undefined
  }

  private operation(id: string): OperationRow | undefined {
    return this.database.prepare('SELECT * FROM browser_automation_operations WHERE operation_id = ?')
      .get(id) as OperationRow | undefined
  }

  private validateStage(options: StageOptions): void {
    if (![options.callerId, options.idempotencyEpoch, options.idempotencyKey].every((value) => UUID.test(value)))
      throw new Error('invalid_operation')
  }

  private sessionDigest(params: BrowserAutomationSessionCreateParams): string {
    return this.digest('sessionCreate', {
      mode: params.mode, profileKey: params.profileKey, target: params.target ?? null,
      idempotency: params.idempotency, correlationId: params.correlationId
    })
  }

  private checkTombstone(namespace: 'sessionCreate' | 'operation', epoch: string, key: string, digest: string): void {
    if (!this.hasTombstones) return
    const row = this.database.prepare(`SELECT request_digest FROM browser_automation_tombstones
      WHERE namespace = ? AND idempotency_epoch = ? AND idempotency_key = ?`).get(
      namespace, epoch, key
    ) as { request_digest: string } | undefined
    if (row) throw new Error(row.request_digest === digest ? 'idempotency_expired' : 'idempotency_conflict')
  }

  private instant(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - SESSION_TTL_MS)
      throw new Error('automation_clock_unavailable')
    return value
  }

  private digest(namespace: string, value: unknown): string {
    return createHash('sha256').update(this.digestKey).update(namespace).update('\0')
      .update(JSON.stringify(value)).digest('hex')
  }
}

function sameWindow(a: { windowId: string; windowGeneration: number }, b: { windowId: string; windowGeneration: number }): boolean {
  return a.windowId === b.windowId && a.windowGeneration === b.windowGeneration
}

function sameFence(row: SessionRow | OperationRow,
  identity: { providerId: string; providerEpoch: number; leaseId: string },
  target: { windowId: string; windowGeneration: number }): boolean {
  return row.provider_id === identity.providerId && row.provider_epoch === identity.providerEpoch &&
    row.provider_lease_id === identity.leaseId && row.window_id === target.windowId &&
    row.window_generation === target.windowGeneration
}

function resultMatches(kind: string, result: BrowserAutomationOperationResultData): boolean {
  return result.kind === (kind === 'navigate' ? 'navigation' : kind === 'query' ? 'query' : kind === 'screenshot' ? 'screenshot' : 'empty')
}
