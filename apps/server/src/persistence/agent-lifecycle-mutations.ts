import type Database from 'better-sqlite3'
import {
  agentRestoreAssessParamsSchema,
  agentSessionRestoreParamsSchema
} from '@agent-workspace/protocol-client'

import { AgentCatalog } from './agent-catalog'
import { AgentMutationError, type AgentOperationIdentity } from './agent-mutations'

type Session = {
  agent_session_id: string
  workspace_id: string
  pane_id: string
  tab_id: string
  adapter_id: string
  adapter_version: string
  revision: number
  attempt_epoch: number
  evidence_epoch: number
  last_verified_at_ms: number
  restore_level: string
  lifecycle: string
  hibernation_state: string | null
}

type Operation = {
  agent_session_id: string
  session_revision: number
  attempt_epoch: number
  request_hash: string
  state: string
  terminal_code: string | null
}

export interface AgentLifecycleEvidence {
  live(session: Session): boolean
  canResume(session: Session): Promise<boolean>
  resume?(session: Session): Promise<void>
}

function checkOperation(operation: AgentOperationIdentity): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (
    !uuid.test(operation.idempotencyKey) ||
    !/^[0-9a-f]{64}$/.test(operation.requestHash) ||
    !Number.isSafeInteger(operation.sessionRevision) ||
    operation.sessionRevision < 1 ||
    !Number.isSafeInteger(operation.attemptEpoch) ||
    operation.attemptEpoch < 1
  ) {
    throw new AgentMutationError('invalid_params', 'Invalid agent operation identity')
  }
}

/** Schema-v15 lifecycle mutations. The caller serializes these with workspace mutations. */
export class AgentLifecycleMutations {
  private readonly catalog: AgentCatalog

  constructor(
    private readonly database: Database.Database,
    private readonly evidence: AgentLifecycleEvidence,
    private readonly now: () => number = Date.now
  ) {
    this.catalog = new AgentCatalog(database)
  }

  /** Reassess current evidence; stored restore claims never grant a capability. */
  async assess(input: unknown) {
    const params = agentRestoreAssessParamsSchema.parse(input)
    checkOperation(params.operation)
    const namespace = 'session.restoreAssess'
    const replay = this.readOperation(namespace, params.operation.idempotencyKey)
    if (replay) {
      this.assertReplay(replay, params.agentSessionId, params.operation)
      const session = this.loadSession(params.agentSessionId)
      return { assessment: this.assessment(session) }
    }

    const session = this.loadSession(params.agentSessionId)
    this.assertCurrent(session, params.operation)
    const level = this.evidence.live(session)
      ? 'liveReattach'
      : (await this.evidence.canResume(session))
        ? 'toolResume'
        : 'unavailable'

    return this.database
      .transaction(() => {
        const current = this.loadSession(params.agentSessionId)
        const concurrent = this.readOperation(namespace, params.operation.idempotencyKey)
        if (concurrent) {
          this.assertReplay(concurrent, params.agentSessionId, params.operation)
          return { assessment: this.assessment(current) }
        }
        this.assertCurrent(current, params.operation)
        const at = Math.max(this.now(), current.last_verified_at_ms)
        if (
          !Number.isSafeInteger(at) ||
          current.evidence_epoch >= Number.MAX_SAFE_INTEGER ||
          current.revision >= Number.MAX_SAFE_INTEGER
        ) {
          throw new AgentMutationError('resource_limit', 'Agent evidence limit reached')
        }
        this.database
          .prepare(
            `UPDATE agent_sessions SET restore_level = ?, durable_intent = 'none',
        evidence_epoch = evidence_epoch + 1, revision = revision + 1,
        last_verified_at_ms = ?, updated_at_ms = ? WHERE agent_session_id = ?
        AND revision = ? AND attempt_epoch = ?`
          )
          .run(level, at, at, current.agent_session_id, current.revision, current.attempt_epoch)
        this.bumpCatalogRevision()
        this.finish(namespace, current.agent_session_id, params.operation, 'assessed', at)
        const updated = this.loadSession(params.agentSessionId)
        return { assessment: this.assessment(updated) }
      })
      .immediate()
  }

  /** Only the already-live terminal branch. Do not advertise general restore from this method. */
  restoreLive(input: unknown) {
    const params = agentSessionRestoreParamsSchema.parse(input)
    checkOperation(params.operation)
    const namespace = 'session.restore'
    return this.database
      .transaction(() => {
        const replay = this.readOperation(namespace, params.operation.idempotencyKey)
        if (replay) {
          this.assertReplay(replay, params.agentSessionId, params.operation)
          if (replay.terminal_code !== 'liveReattached') {
            throw new AgentMutationError(
              'invalid_state',
              'Restore replay is not a live reattachment'
            )
          }
          return { outcome: 'liveReattached' as const, ...this.catalog.get(params.agentSessionId) }
        }
        const session = this.loadSession(params.agentSessionId)
        this.assertCurrent(session, params.operation)
        this.assertNotHibernating(session)
        if (!this.evidence.live(session)) {
          throw new AgentMutationError(
            'runtime_unavailable',
            'The exact terminal binding is not live'
          )
        }
        const at = Math.max(this.now(), session.last_verified_at_ms)
        if (!Number.isSafeInteger(at) || session.revision >= Number.MAX_SAFE_INTEGER) {
          throw new AgentMutationError('resource_limit', 'Agent session revision limit reached')
        }
        this.database
          .prepare(
            `UPDATE agent_sessions SET durable_intent = 'restore', lifecycle = 'running',
        hibernation_state = NULL, checkpoint_kind = NULL, checkpoint_version = NULL,
        checkpoint_digest = NULL, checkpoint_verified_at_ms = NULL,
        checkpoint_expires_at_ms = NULL,
        restore_outcome = 'liveReattached', revision = revision + 1,
        last_verified_at_ms = ?, updated_at_ms = ? WHERE agent_session_id = ?
        AND revision = ? AND attempt_epoch = ?`
          )
          .run(at, at, session.agent_session_id, session.revision, session.attempt_epoch)
        this.bumpCatalogRevision()
        this.finish(namespace, session.agent_session_id, params.operation, 'liveReattached', at)
        return { outcome: 'liveReattached' as const, ...this.catalog.get(params.agentSessionId) }
      })
      .immediate()
  }

  /** Persist the attempt fence before dispatch. A pending attempt is never dispatched twice. */
  async restore(input: unknown) {
    const params = agentSessionRestoreParamsSchema.parse(input)
    checkOperation(params.operation)
    const namespace = 'session.restore'
    const replay = this.readOperation(namespace, params.operation.idempotencyKey)
    if (replay) return this.restoreReplay(replay, params.agentSessionId, params.operation)
    const session = this.loadSession(params.agentSessionId)
    this.assertCurrent(session, params.operation)
    this.assertNotHibernating(session)
    if (this.evidence.live(session)) return this.restoreLive(params)
    if (!this.evidence.resume || !(await this.evidence.canResume(session))) {
      throw new AgentMutationError(
        'provider_unavailable',
        'No trusted adapter can restore this session'
      )
    }
    const attempt = this.database
      .transaction(() => {
        const concurrent = this.readOperation(namespace, params.operation.idempotencyKey)
        if (concurrent)
          return this.restoreReplay(concurrent, params.agentSessionId, params.operation)
        const current = this.loadSession(params.agentSessionId)
        this.assertCurrent(current, params.operation)
        this.assertNotHibernating(current)
        if (
          current.revision >= Number.MAX_SAFE_INTEGER - 1 ||
          current.attempt_epoch >= Number.MAX_SAFE_INTEGER
        ) {
          throw new AgentMutationError('resource_limit', 'Agent restore attempt limit reached')
        }
        const pending = this.database
          .prepare(
            "SELECT 1 FROM agent_operations WHERE namespace = 'session.restore' AND agent_session_id = ? AND state = 'pending'"
          )
          .get(current.agent_session_id)
        if (pending) throw new AgentMutationError('operation_pending', 'Another restore is pending')
        const at = Math.max(this.now(), current.last_verified_at_ms)
        this.database
          .prepare(
            `UPDATE agent_sessions SET durable_intent = 'restore',
        lifecycle = CASE WHEN lifecycle = 'hibernated' THEN 'launching' ELSE lifecycle END,
        hibernation_state = CASE WHEN lifecycle = 'hibernated' THEN NULL ELSE hibernation_state END,
        checkpoint_kind = CASE WHEN lifecycle = 'hibernated' THEN NULL ELSE checkpoint_kind END,
        checkpoint_version = CASE WHEN lifecycle = 'hibernated' THEN NULL ELSE checkpoint_version END,
        checkpoint_digest = CASE WHEN lifecycle = 'hibernated' THEN NULL ELSE checkpoint_digest END,
        checkpoint_verified_at_ms = CASE WHEN lifecycle = 'hibernated' THEN NULL ELSE checkpoint_verified_at_ms END,
        checkpoint_expires_at_ms = CASE WHEN lifecycle = 'hibernated' THEN NULL ELSE checkpoint_expires_at_ms END,
        revision = revision + 1, attempt_epoch = attempt_epoch + 1, updated_at_ms = ?
        WHERE agent_session_id = ? AND revision = ? AND attempt_epoch = ?`
          )
          .run(at, current.agent_session_id, current.revision, current.attempt_epoch)
        this.database
          .prepare(
            `INSERT INTO agent_operations (operation_id, namespace, agent_session_id,
        session_revision, attempt_epoch, request_hash, state, accepted_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
          )
          .run(
            params.operation.idempotencyKey,
            namespace,
            current.agent_session_id,
            current.revision,
            current.attempt_epoch,
            params.operation.requestHash,
            at,
            at
          )
        this.bumpCatalogRevision()
        return this.loadSession(params.agentSessionId)
      })
      .immediate()
    if ('outcome' in attempt) return attempt
    try {
      await this.evidence.resume(attempt)
      if (!this.evidence.live(attempt)) {
        throw new AgentMutationError('runtime_unavailable', 'The resumed terminal is not live')
      }
    } catch (error) {
      this.finishFailed(params.operation, 'adapterRejected')
      throw error
    }
    return this.database
      .transaction(() => {
        const operation = this.readOperation(namespace, params.operation.idempotencyKey)
        if (!operation || operation.state !== 'pending') {
          throw new AgentMutationError('invalid_state', 'Restore attempt was interrupted')
        }
        const current = this.loadSession(params.agentSessionId)
        this.assertCurrent(current, {
          ...params.operation,
          sessionRevision: attempt.revision,
          attemptEpoch: attempt.attempt_epoch
        })
        const at = Math.max(this.now(), current.last_verified_at_ms)
        this.database
          .prepare(
            `UPDATE agent_sessions SET lifecycle = 'running', hibernation_state = NULL,
        checkpoint_kind = NULL, checkpoint_version = NULL, checkpoint_digest = NULL,
        checkpoint_verified_at_ms = NULL, checkpoint_expires_at_ms = NULL,
        restore_outcome = 'resumed', revision = revision + 1,
        last_verified_at_ms = ?, updated_at_ms = ? WHERE agent_session_id = ? AND revision = ? AND attempt_epoch = ?`
          )
          .run(at, at, current.agent_session_id, current.revision, current.attempt_epoch)
        this.database
          .prepare(
            `UPDATE agent_operations SET state = 'succeeded', terminal_code = 'resumed',
        updated_at_ms = ?, terminal_at_ms = ? WHERE namespace = ? AND operation_id = ? AND state = 'pending'`
          )
          .run(at, at, namespace, params.operation.idempotencyKey)
        this.bumpCatalogRevision()
        return { outcome: 'resumed' as const, ...this.catalog.get(params.agentSessionId) }
      })
      .immediate()
  }

  /** Startup recovery: a new process cannot prove an old attempt's PTY epoch. */
  interruptPendingRestores(): number {
    const at = this.now()
    return this.database
      .prepare(
        `UPDATE agent_operations SET state = 'interrupted', terminal_code = 'serviceRestart',
      updated_at_ms = max(updated_at_ms, ?), terminal_at_ms = max(updated_at_ms, ?)
      WHERE namespace = 'session.restore' AND state = 'pending'`
      )
      .run(at, at).changes
  }

  private restoreReplay(row: Operation, id: string, operation: AgentOperationIdentity) {
    this.assertReplay(row, id, operation)
    if (row.terminal_code !== 'liveReattached' && row.terminal_code !== 'resumed') {
      throw new AgentMutationError('invalid_state', 'Restore replay outcome is unavailable')
    }
    return { outcome: row.terminal_code, ...this.catalog.get(id) }
  }

  private finishFailed(operation: AgentOperationIdentity, code: string): void {
    const at = this.now()
    this.database
      .prepare(
        `UPDATE agent_operations SET state = 'failed', terminal_code = ?, updated_at_ms = max(updated_at_ms, ?),
      terminal_at_ms = max(updated_at_ms, ?) WHERE namespace = 'session.restore'
      AND operation_id = ? AND request_hash = ? AND state = 'pending'`
      )
      .run(code, at, at, operation.idempotencyKey, operation.requestHash)
  }

  private loadSession(id: string): Session {
    const session = this.database
      .prepare(
        `SELECT agent_session_id, workspace_id, pane_id, tab_id,
      adapter_id, adapter_version, revision, attempt_epoch, evidence_epoch,
      last_verified_at_ms, restore_level, lifecycle, hibernation_state
      FROM agent_sessions WHERE agent_session_id = ?`
      )
      .get(id) as Session | undefined
    if (!session)
      throw new AgentMutationError('session_unavailable', 'Agent session is unavailable')
    return session
  }

  private readOperation(namespace: string, id: string): Operation | undefined {
    return this.database
      .prepare(
        `SELECT agent_session_id, session_revision, attempt_epoch,
      request_hash, state, terminal_code FROM agent_operations WHERE namespace = ?
      AND operation_id = ?`
      )
      .get(namespace, id) as Operation | undefined
  }

  private assertReplay(row: Operation, id: string, operation: AgentOperationIdentity): void {
    if (
      row.agent_session_id !== id ||
      row.session_revision !== operation.sessionRevision ||
      row.attempt_epoch !== operation.attemptEpoch ||
      row.request_hash !== operation.requestHash
    ) {
      throw new AgentMutationError('idempotency_conflict', 'Agent operation identity is in use')
    }
    if (row.state === 'pending') {
      throw new AgentMutationError('operation_pending', 'Agent operation is pending')
    }
    if (row.state !== 'succeeded') {
      throw new AgentMutationError('invalid_state', 'Agent operation did not succeed')
    }
  }

  private assertCurrent(session: Session, operation: AgentOperationIdentity): void {
    if (
      session.revision !== operation.sessionRevision ||
      session.attempt_epoch !== operation.attemptEpoch
    ) {
      throw new AgentMutationError(
        'stale_revision',
        'Agent session revision or attempt epoch is stale'
      )
    }
  }

  private assertNotHibernating(session: Session): void {
    if (
      session.hibernation_state &&
      !['canceled', 'failed', 'interrupted', 'hibernated'].includes(session.hibernation_state)
    )
      throw new AgentMutationError('invalid_state', 'Agent hibernation is in progress')
  }

  private finish(
    namespace: string,
    id: string,
    operation: AgentOperationIdentity,
    code: string,
    at: number
  ): void {
    this.database
      .prepare(
        `INSERT INTO agent_operations (operation_id, namespace, agent_session_id,
      session_revision, attempt_epoch, request_hash, state, terminal_code,
      accepted_at_ms, updated_at_ms, terminal_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`
      )
      .run(
        operation.idempotencyKey,
        namespace,
        id,
        operation.sessionRevision,
        operation.attemptEpoch,
        operation.requestHash,
        code,
        at,
        at,
        at
      )
  }

  private bumpCatalogRevision(): void {
    const result = this.database
      .prepare(
        `UPDATE agent_catalog_state SET revision = revision + 1
      WHERE singleton = 1 AND revision < 9007199254740991`
      )
      .run()
    if (result.changes !== 1) {
      throw new AgentMutationError('resource_limit', 'Agent catalog revision limit reached')
    }
  }

  private assessment(session: Session) {
    return {
      level: session.restore_level,
      assessedAtMs: session.last_verified_at_ms,
      evidenceEpoch: session.evidence_epoch
    }
  }
}
