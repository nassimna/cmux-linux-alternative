import type Database from 'better-sqlite3'
import {
  codexCheckpoint,
  CODEX_CHECKPOINT_KIND,
  CODEX_CHECKPOINT_LIFETIME_MS,
  type CodexCheckpoint
} from './codex-checkpoint'
import {
  agentHibernationCancelParamsSchema,
  agentHibernationConfirmParamsSchema,
  agentHibernationPreflightParamsSchema
} from '@agent-workspace/protocol-client'

import type { WorkspaceTerminalRuntime } from '../domain/workspace-terminal-runtime'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import {
  AgentHibernationChallenges,
  type AgentHibernationAuthority
} from '../persistence/agent-hibernation-challenges'
import { AgentMutationError, type AgentOperationIdentity } from '../persistence/agent-mutations'

type Session = {
  agent_session_id: string
  workspace_id: string
  pane_id: string
  tab_id: string
  lifecycle: string
  durable_intent: string
  hibernation_state: string | null
  revision: number
  attempt_epoch: number
  last_verified_at_ms: number
  checkpoint_kind: string | null
  checkpoint_version: number | null
  checkpoint_digest: string | null
  checkpoint_verified_at_ms: number | null
  checkpoint_expires_at_ms: number | null
  adapter_id: string
  adapter_version: string
}

type Operation = {
  agent_session_id: string
  session_revision: number
  attempt_epoch: number
  request_hash: string
  state: string
  terminal_code: string | null
}

const transitions: Record<string, readonly string[]> = {
  none: ['requested'],
  requested: ['preflight', 'canceled', 'failed'],
  preflight: ['confirmationRequired', 'canceled', 'failed'],
  confirmationRequired: ['processDispositionPending', 'canceled', 'failed'],
  processDispositionPending: ['hibernated', 'failed', 'interrupted']
}

/** Drives the destructive fallback only. No Node adapter currently proves a resumable checkpoint. */
export class AgentHibernationService {
  private readonly challenges: AgentHibernationChallenges

  constructor(
    private readonly database: Database.Database,
    private readonly state: ApplicationStateStore,
    private readonly runtime: WorkspaceTerminalRuntime,
    private readonly authority: AgentHibernationAuthority,
    private readonly exactTerminal: (session: Session) => string | undefined,
    private readonly verifyCheckpoint: (session: Session) => Promise<CodexCheckpoint | undefined>,
    private readonly now: () => number = Date.now
  ) {
    this.challenges = new AgentHibernationChallenges(database, authority, now)
    // A process restart cannot prove an old operation epoch or recreate its raw challenge nonce.
    this.database
      .transaction(() => {
        const at = this.timestamp()
        this.database
          .prepare(
            `UPDATE agent_operations SET state = 'interrupted',
        terminal_code = 'serviceRestart', updated_at_ms = max(updated_at_ms, ?),
        terminal_at_ms = max(updated_at_ms, ?) WHERE namespace IN
        ('session.hibernatePreflight', 'session.hibernateConfirm', 'session.hibernateCancel')
        AND state = 'pending'`
          )
          .run(at, at)
        this.challenges.invalidateAll()
      })
      .immediate()
  }

  async preflight(input: unknown) {
    const params = agentHibernationPreflightParamsSchema.parse(input)
    // Rust checks the current provider and window lease before replaying a challenge.
    // A retained nonce alone must not outlive its issuing authority.
    if (!this.authority.current(params.challenge.provider, params.challenge.window))
      throw new AgentMutationError('provider_unavailable', 'Hibernation authority is unavailable')
    const namespace = 'session.hibernatePreflight'
    const replay = this.operation(namespace, params.operation.idempotencyKey)
    if (replay) {
      this.assertReplay(replay, params.agentSessionId, params.operation)
      const issued = this.challenges.replay(params.operation.idempotencyKey)
      const challenge = issued.challenge
      if (
        challenge.provider.providerId !== params.challenge.provider.providerId ||
        challenge.provider.providerEpoch !== params.challenge.provider.providerEpoch ||
        challenge.provider.leaseId !== params.challenge.provider.leaseId ||
        challenge.window.windowId !== params.challenge.window.windowId ||
        challenge.window.windowGeneration !== params.challenge.window.windowGeneration
      )
        throw new AgentMutationError(
          'idempotency_conflict',
          'Hibernation challenge identity changed'
        )
      return issued
    }
    const before = this.session(params.agentSessionId)
    this.assertCurrent(before, params.operation)
    if (!['running', 'waiting'].includes(before.lifecycle) || before.hibernation_state)
      throw new AgentMutationError('invalid_state', 'Session cannot begin hibernation')
    const terminalId = this.exactTerminal(before)
    if (!terminalId)
      throw new AgentMutationError('runtime_unavailable', 'The exact terminal binding is not live')
    // A failed thread/read is never a checkpoint; the explicit termination branch remains available.
    const candidate = await this.verifyCheckpoint(before).catch(() => undefined)
    const checkpoint = candidate && this.checkpointFresh(before, candidate) ? candidate : undefined
    return this.database
      .transaction(() => {
        const concurrent = this.operation(namespace, params.operation.idempotencyKey)
        if (concurrent) {
          this.assertReplay(concurrent, params.agentSessionId, params.operation)
          return this.challenges.replay(params.operation.idempotencyKey)
        }
        const session = this.session(params.agentSessionId)
        this.assertCurrent(session, params.operation)
        if (!['running', 'waiting'].includes(session.lifecycle) || session.hibernation_state)
          throw new AgentMutationError('invalid_state', 'Session cannot begin hibernation')
        if (session.checkpoint_kind)
          throw new AgentMutationError(
            'provider_unavailable',
            'Checkpoint disposition is unavailable'
          )
        if (this.exactTerminal(session) !== terminalId)
          throw new AgentMutationError(
            'runtime_unavailable',
            'The exact terminal binding is not live'
          )
        this.start(namespace, session, params.operation)
        this.transition(session, 'requested', 'hibernate')
        this.transition(this.session(params.agentSessionId), 'preflight', 'hibernate')
        if (checkpoint && this.checkpointFresh(session, checkpoint)) {
          const current = this.session(params.agentSessionId)
          const at = this.timestamp(current.last_verified_at_ms)
          const changed = this.database
            .prepare(
              `UPDATE agent_sessions SET lifecycle = 'checkpointing', checkpoint_kind = ?,
             checkpoint_version = 1, checkpoint_digest = ?, checkpoint_verified_at_ms = ?,
             checkpoint_expires_at_ms = ?, last_verified_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1 WHERE agent_session_id = ? AND revision = ?`
            )
            .run(
              checkpoint.kind,
              checkpoint.digestSha256,
              checkpoint.createdAtMs,
              checkpoint.expiresAtMs,
              at,
              at,
              current.agent_session_id,
              current.revision
            )
          if (changed.changes !== 1)
            throw new AgentMutationError('stale_revision', 'Agent checkpoint changed')
          this.bumpCatalog()
        }
        this.transition(this.session(params.agentSessionId), 'confirmationRequired', 'hibernate')
        return this.challenges.issue(params, checkpoint)
      })
      .immediate()
  }

  cancel(input: unknown) {
    const params = agentHibernationCancelParamsSchema.parse(input)
    const namespace = 'session.hibernateCancel'
    const replay = this.operation(namespace, params.operation.idempotencyKey)
    if (replay) {
      this.assertReplay(replay, params.agentSessionId, params.operation)
      return { state: 'canceled' as const }
    }
    this.database
      .transaction(() => {
        const session = this.session(params.agentSessionId)
        this.assertCurrent(session, params.operation)
        this.start(namespace, session, params.operation)
        this.transition(session, 'canceled', 'none')
        this.resetPreparation(this.session(params.agentSessionId))
        this.finish(namespace, params.operation, 'canceled')
      })
      .immediate()
    this.challenges.invalidateSession(params.agentSessionId)
    return { state: 'canceled' as const }
  }

  async confirm(input: unknown) {
    const params = agentHibernationConfirmParamsSchema.parse(input)
    const namespace = 'session.hibernateConfirm'
    const replay = this.operation(namespace, params.operation.idempotencyKey)
    if (replay) {
      this.assertReplay(replay, params.agentSessionId, params.operation)
      if (
        replay.terminal_code !== 'terminatedAfterWarning' &&
        replay.terminal_code !== 'hibernated'
      )
        throw new AgentMutationError('invalid_state', 'Confirmation did not complete')
      return { state: replay.terminal_code as 'hibernated' | 'terminatedAfterWarning' }
    }
    if (params.choice !== 'terminateAfterWarning')
      throw new AgentMutationError('invalid_params', 'Use cancel to leave the process running')
    const session = this.session(params.agentSessionId)
    this.assertCurrent(session, params.operation)
    if (session.hibernation_state !== 'confirmationRequired')
      throw new AgentMutationError('invalid_state', 'Hibernation confirmation is unavailable')
    if (params.expiresAtMs <= this.now()) {
      this.releasePreflight(session)
      throw new AgentMutationError('invalid_state', 'Hibernation confirmation expired')
    }
    const checkpoint = this.storedCheckpoint(session)
    if (session.checkpoint_kind && !checkpoint)
      throw new AgentMutationError('invalid_state', 'Verified checkpoint metadata is invalid')
    if (checkpoint) {
      if (!this.checkpointFresh(session, checkpoint)) {
        this.releasePreflight(session)
        throw new AgentMutationError('invalid_state', 'The verified checkpoint expired')
      }
      const latest = await this.verifyCheckpoint(session).catch(() => undefined)
      if (
        !latest ||
        !this.checkpointFresh(session, latest) ||
        latest.digestSha256 !== checkpoint.digestSha256
      ) {
        this.releasePreflight(session)
        throw new AgentMutationError(
          'provider_unavailable',
          'The exact Codex thread is not verified'
        )
      }
      this.assertCurrent(this.session(params.agentSessionId), params.operation)
    }
    // Resolve the exact in-process PTY before consuming the one-use challenge.
    const terminalId = this.exactTerminal(session)
    if (!terminalId)
      throw new AgentMutationError('runtime_unavailable', 'The exact terminal binding is not live')
    this.database
      .transaction(() => {
        this.assertCurrent(this.session(params.agentSessionId), params.operation)
        this.start(namespace, session, params.operation)
        this.challenges.consume(params)
        this.transition(session, 'processDispositionPending', 'hibernate')
      })
      .immediate()
    const pending = this.session(params.agentSessionId)
    let detached: Awaited<ReturnType<WorkspaceTerminalRuntime['detachAgentTerminal']>>
    try {
      detached = await this.runtime.detachAgentTerminal(
        this.state,
        {
          agentSessionId: params.agentSessionId,
          sessionRevision: pending.revision,
          attemptEpoch: pending.attempt_epoch,
          workspaceId: pending.workspace_id,
          paneId: pending.pane_id,
          tabId: pending.tab_id
        },
        terminalId
      )
    } catch {
      this.fail(namespace, params.operation, 'detachFailed')
      throw new AgentMutationError(
        'runtime_unavailable',
        'The exact terminal could not be detached'
      )
    }
    if (detached.terminationFailures.length) {
      this.fail(namespace, params.operation, 'dispositionUnverified')
      throw new AgentMutationError('runtime_unavailable', 'Terminal exit was not verified')
    }
    this.database
      .transaction(() => {
        const current = this.session(params.agentSessionId)
        if (
          current.revision !== pending.revision ||
          current.hibernation_state !== 'processDispositionPending'
        )
          throw new AgentMutationError('stale_revision', 'Hibernation disposition changed')
        const at = this.timestamp(current.last_verified_at_ms)
        const changed = this.database
          .prepare(
            checkpoint
              ? `UPDATE agent_sessions SET lifecycle = 'hibernated', durable_intent = 'hibernate',
               restore_level = 'toolResume', hibernation_state = 'hibernated',
               revision = revision + 1, last_verified_at_ms = ?, updated_at_ms = ?
               WHERE agent_session_id = ? AND revision = ? AND attempt_epoch = ?`
              : `UPDATE agent_sessions SET lifecycle = 'completed',
               durable_intent = 'none', restore_level = 'unavailable', restore_outcome = 'unavailable',
               hibernation_state = 'failed', revision = revision + 1, last_verified_at_ms = ?,
               checkpoint_kind = NULL, checkpoint_version = NULL, checkpoint_digest = NULL,
               checkpoint_verified_at_ms = NULL, checkpoint_expires_at_ms = NULL, updated_at_ms = ?
               WHERE agent_session_id = ? AND revision = ? AND attempt_epoch = ?`
          )
          .run(at, at, params.agentSessionId, current.revision, current.attempt_epoch)
        if (changed.changes !== 1)
          throw new AgentMutationError('stale_revision', 'Hibernation disposition changed')
        if (!checkpoint)
          this.database
            .prepare(
              `INSERT INTO agent_hibernation_dispositions
          (agent_session_id, confirmation_id, outcome, disposed_at_ms)
          VALUES (?, ?, 'terminatedAfterWarning', ?)
          ON CONFLICT(agent_session_id) DO UPDATE SET
          confirmation_id = excluded.confirmation_id,
          disposed_at_ms = excluded.disposed_at_ms`
            )
            .run(params.agentSessionId, params.confirmationId, at)
        this.bumpCatalog()
        this.finish(
          namespace,
          params.operation,
          checkpoint ? 'hibernated' : 'terminatedAfterWarning'
        )
      })
      .immediate()
    return { state: checkpoint ? ('hibernated' as const) : ('terminatedAfterWarning' as const) }
  }

  private session(id: string): Session {
    const row = this.database
      .prepare('SELECT * FROM agent_sessions WHERE agent_session_id = ?')
      .get(id) as Session | undefined
    if (!row) throw new AgentMutationError('session_unavailable', 'Agent session is unavailable')
    return row
  }

  private checkpointFresh(session: Session, checkpoint: CodexCheckpoint): boolean {
    const at = this.now()
    const expected = codexCheckpoint(session.agent_session_id, checkpoint.createdAtMs)
    return (
      Number.isSafeInteger(at) &&
      checkpoint.kind === expected.kind &&
      checkpoint.digestSha256 === expected.digestSha256 &&
      checkpoint.expiresAtMs === expected.expiresAtMs &&
      checkpoint.createdAtMs <= at &&
      at - checkpoint.createdAtMs <= CODEX_CHECKPOINT_LIFETIME_MS &&
      checkpoint.expiresAtMs > at
    )
  }

  private storedCheckpoint(session: Session): CodexCheckpoint | undefined {
    if (
      session.checkpoint_kind !== CODEX_CHECKPOINT_KIND ||
      session.checkpoint_version !== 1 ||
      !session.checkpoint_digest ||
      session.checkpoint_verified_at_ms === null ||
      session.checkpoint_expires_at_ms === null
    )
      return undefined
    return {
      descriptorVersion: 1,
      kind: CODEX_CHECKPOINT_KIND,
      digestSha256: session.checkpoint_digest,
      sizeBytes: 16,
      createdAtMs: session.checkpoint_verified_at_ms,
      expiresAtMs: session.checkpoint_expires_at_ms
    }
  }

  /** An expired consent/checkpoint leaves the PTY live and permits a fresh preflight. */
  private releasePreflight(session: Session): void {
    this.database
      .transaction(() => {
        const current = this.session(session.agent_session_id)
        if (
          current.revision !== session.revision ||
          current.hibernation_state !== 'confirmationRequired'
        )
          throw new AgentMutationError('stale_revision', 'Hibernation preparation changed')
        this.resetPreparation(current)
      })
      .immediate()
    this.challenges.invalidateSession(session.agent_session_id)
  }

  private resetPreparation(session: Session): void {
    const reset = this.database
      .prepare(
        `UPDATE agent_sessions SET lifecycle = CASE WHEN lifecycle = 'checkpointing'
       THEN 'running' ELSE lifecycle END, durable_intent = 'none', hibernation_state = NULL,
       checkpoint_kind = NULL, checkpoint_version = NULL, checkpoint_digest = NULL,
       checkpoint_verified_at_ms = NULL, checkpoint_expires_at_ms = NULL,
       revision = revision + 1, updated_at_ms = ?
       WHERE agent_session_id = ? AND revision = ?`
      )
      .run(this.timestamp(session.last_verified_at_ms), session.agent_session_id, session.revision)
    if (reset.changes !== 1)
      throw new AgentMutationError('stale_revision', 'Hibernation preparation changed')
    this.bumpCatalog()
  }

  private operation(namespace: string, id: string): Operation | undefined {
    return this.database
      .prepare(
        `SELECT agent_session_id, session_revision, attempt_epoch,
      request_hash, state, terminal_code FROM agent_operations WHERE namespace = ? AND operation_id = ?`
      )
      .get(namespace, id) as Operation | undefined
  }

  private assertCurrent(session: Session, operation: AgentOperationIdentity): void {
    if (
      session.revision !== operation.sessionRevision ||
      session.attempt_epoch !== operation.attemptEpoch
    )
      throw new AgentMutationError(
        'stale_revision',
        'Agent session revision or attempt epoch is stale'
      )
  }

  private assertReplay(row: Operation, id: string, operation: AgentOperationIdentity): void {
    if (
      row.agent_session_id !== id ||
      row.session_revision !== operation.sessionRevision ||
      row.attempt_epoch !== operation.attemptEpoch ||
      row.request_hash !== operation.requestHash
    )
      throw new AgentMutationError('idempotency_conflict', 'Agent operation identity is in use')
    if (row.state === 'pending')
      throw new AgentMutationError('operation_pending', 'Agent operation is pending')
    if (row.state !== 'succeeded')
      throw new AgentMutationError('invalid_state', 'Agent operation did not succeed')
  }

  private start(namespace: string, session: Session, operation: AgentOperationIdentity): void {
    const at = this.timestamp()
    this.database
      .prepare(
        `INSERT INTO agent_operations (operation_id, namespace, agent_session_id,
      session_revision, attempt_epoch, request_hash, state, accepted_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        operation.idempotencyKey,
        namespace,
        session.agent_session_id,
        operation.sessionRevision,
        operation.attemptEpoch,
        operation.requestHash,
        at,
        at
      )
  }

  private transition(session: Session, next: string, intent: 'hibernate' | 'none'): void {
    if (!transitions[session.hibernation_state ?? 'none']?.includes(next))
      throw new AgentMutationError('invalid_state', 'Invalid hibernation transition')
    if (session.revision >= Number.MAX_SAFE_INTEGER)
      throw new AgentMutationError('resource_limit', 'Agent session revision limit reached')
    const at = this.timestamp(session.last_verified_at_ms)
    const changed = this.database
      .prepare(
        `UPDATE agent_sessions SET hibernation_state = ?,
      durable_intent = ?, revision = revision + 1, updated_at_ms = ?
      WHERE agent_session_id = ? AND revision = ? AND attempt_epoch = ?`
      )
      .run(next, intent, at, session.agent_session_id, session.revision, session.attempt_epoch)
    if (changed.changes !== 1)
      throw new AgentMutationError('stale_revision', 'Agent session changed')
    this.bumpCatalog()
  }

  private finish(namespace: string, operation: AgentOperationIdentity, code: string): void {
    const at = this.timestamp()
    const changed = this.database
      .prepare(
        `UPDATE agent_operations SET state = 'succeeded', terminal_code = ?,
      updated_at_ms = max(updated_at_ms, ?), terminal_at_ms = max(updated_at_ms, ?)
      WHERE namespace = ? AND operation_id = ? AND state = 'pending'`
      )
      .run(code, at, at, namespace, operation.idempotencyKey)
    if (changed.changes !== 1)
      throw new AgentMutationError('invalid_state', 'Agent operation is no longer pending')
  }

  private fail(namespace: string, operation: AgentOperationIdentity, code: string): void {
    this.database
      .transaction(() => {
        const session = this.session(
          this.operation(namespace, operation.idempotencyKey)!.agent_session_id
        )
        if (session.hibernation_state === 'processDispositionPending')
          this.transition(session, 'failed', 'hibernate')
        const at = this.timestamp()
        this.database
          .prepare(
            `UPDATE agent_operations SET state = 'failed', terminal_code = ?,
        updated_at_ms = ?, terminal_at_ms = ? WHERE namespace = ? AND operation_id = ? AND state = 'pending'`
          )
          .run(code, at, at, namespace, operation.idempotencyKey)
      })
      .immediate()
  }

  private bumpCatalog(): void {
    const result = this.database
      .prepare(
        `UPDATE agent_catalog_state SET revision = revision + 1
      WHERE singleton = 1 AND revision < 9007199254740991`
      )
      .run()
    if (result.changes !== 1)
      throw new AgentMutationError('resource_limit', 'Agent catalog revision limit reached')
  }

  private timestamp(floor = 0): number {
    const at = Math.max(this.now(), floor)
    if (!Number.isSafeInteger(at) || at < 0)
      throw new AgentMutationError('resource_limit', 'Hibernation clock is unavailable')
    return at
  }
}
