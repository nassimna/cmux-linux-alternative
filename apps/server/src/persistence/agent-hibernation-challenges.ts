import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

import type Database from 'better-sqlite3'
import {
  agentHibernationConfirmParamsSchema,
  agentHibernationPreflightParamsSchema
} from '@agent-workspace/protocol-client'

import { CODEX_CHECKPOINT_KIND, type CodexCheckpoint } from '../agents/codex-checkpoint'
import { AgentMutationError } from './agent-mutations'

type Provider = { providerId: string; providerEpoch: number; leaseId: string }
type Window = { windowId: string; windowGeneration: number }
type Confirmation = {
  confirmation_id: string
  agent_session_id: string
  session_revision: number
  attempt_epoch: number
  choice: string
  provider_id: string
  provider_epoch: number
  provider_lease_id: string
  window_id: string
  window_generation: number
  nonce_hash: string
  expires_at_ms: number
  consumed_at_ms: number | null
}

export interface AgentHibernationAuthority {
  current(provider: Provider, window: Window): boolean
}

/** Confirmation storage only; process detachment belongs to an exact runtime owner. */
export class AgentHibernationChallenges {
  private readonly nonces = new Map<
    string,
    { agentSessionId: string; nonce: string; expiresAtMs: number }
  >()

  constructor(
    private readonly database: Database.Database,
    private readonly authority: AgentHibernationAuthority,
    private readonly now: () => number = Date.now
  ) {}

  issue(input: unknown, checkpoint?: CodexCheckpoint) {
    const params = agentHibernationPreflightParamsSchema.parse(input)
    const { provider, window } = params.challenge
    if (!this.authority.current(provider, window))
      throw new AgentMutationError('provider_unavailable', 'Hibernation authority is unavailable')
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 30_000)
      throw new AgentMutationError('resource_limit', 'Hibernation clock is unavailable')
    const confirmationId = randomUUID()
    const nonce = randomUUID()
    const expiresAtMs = now + 30_000
    const hash = createHash('sha256').update(nonce).digest('hex')
    this.database
      .transaction(() => {
        const session = this.database
          .prepare(
            `SELECT revision, attempt_epoch, hibernation_state
        FROM agent_sessions WHERE agent_session_id = ?`
          )
          .get(params.agentSessionId) as
          { revision: number; attempt_epoch: number; hibernation_state: string | null } | undefined
        if (!session)
          throw new AgentMutationError('session_unavailable', 'Agent session is unavailable')
        if (session.hibernation_state !== 'confirmationRequired')
          throw new AgentMutationError('invalid_state', 'Hibernation preflight is incomplete')
        const operation = this.database
          .prepare(
            `SELECT agent_session_id, session_revision, attempt_epoch,
        request_hash, state FROM agent_operations WHERE namespace = 'session.hibernatePreflight'
        AND operation_id = ?`
          )
          .get(params.operation.idempotencyKey) as
          | {
              agent_session_id: string
              session_revision: number
              attempt_epoch: number
              request_hash: string
              state: string
            }
          | undefined
        if (
          !operation ||
          operation.state !== 'pending' ||
          operation.agent_session_id !== params.agentSessionId ||
          operation.session_revision !== params.operation.sessionRevision ||
          operation.attempt_epoch !== params.operation.attemptEpoch ||
          operation.request_hash !== params.operation.requestHash ||
          session.revision < operation.session_revision ||
          session.attempt_epoch !== operation.attempt_epoch
        )
          throw new AgentMutationError(
            'invalid_state',
            'Exact hibernation preflight is unavailable'
          )
        this.database
          .prepare(
            `INSERT INTO agent_hibernation_confirmations (
        confirmation_id, agent_session_id, session_revision, attempt_epoch, choice,
        provider_id, provider_epoch, provider_lease_id, window_id, window_generation,
        nonce_hash, expires_at_ms) VALUES (?, ?, ?, ?, 'terminateAfterWarning', ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            confirmationId,
            params.agentSessionId,
            session.revision,
            session.attempt_epoch,
            provider.providerId,
            provider.providerEpoch,
            provider.leaseId,
            window.windowId,
            window.windowGeneration,
            hash,
            expiresAtMs
          )
        this.database
          .prepare(
            `INSERT INTO agent_hibernation_challenge_replay (operation_id, confirmation_id)
        VALUES (?, ?)`
          )
          .run(params.operation.idempotencyKey, confirmationId)
        this.database
          .prepare(
            `UPDATE agent_operations SET state = 'succeeded', terminal_code = 'preflightComplete',
        updated_at_ms = ?, terminal_at_ms = ? WHERE namespace = 'session.hibernatePreflight'
        AND operation_id = ? AND state = 'pending'`
          )
          .run(now, now, params.operation.idempotencyKey)
      })
      .immediate()
    for (const [id, retained] of this.nonces) {
      if (retained.agentSessionId === params.agentSessionId || retained.expiresAtMs <= now)
        this.nonces.delete(id)
    }
    this.nonces.set(confirmationId, { agentSessionId: params.agentSessionId, nonce, expiresAtMs })
    return {
      state: 'confirmationRequired' as const,
      confirmationId,
      ...(checkpoint ? { checkpoint } : {}),
      challenge: {
        confirmationId,
        choice: 'terminateAfterWarning' as const,
        provider,
        window,
        nonce,
        expiresAtMs
      }
    }
  }

  replay(preflightOperationId: string) {
    const row = this.database
      .prepare(
        `SELECT c.* FROM agent_hibernation_challenge_replay r
      JOIN agent_hibernation_confirmations c ON c.confirmation_id = r.confirmation_id
      WHERE r.operation_id = ?`
      )
      .get(preflightOperationId) as Confirmation | undefined
    const retained = row && this.nonces.get(row.confirmation_id)
    if (
      !row ||
      row.consumed_at_ms !== null ||
      row.expires_at_ms <= this.now() ||
      !retained ||
      retained.expiresAtMs !== row.expires_at_ms
    )
      throw new AgentMutationError('invalid_state', 'Hibernation challenge is unavailable')
    const session = this.database
      .prepare(
        `SELECT checkpoint_kind, checkpoint_version, checkpoint_digest,
       checkpoint_verified_at_ms, checkpoint_expires_at_ms FROM agent_sessions
       WHERE agent_session_id = ?`
      )
      .get(row.agent_session_id) as
      | {
          checkpoint_kind: string | null
          checkpoint_version: number | null
          checkpoint_digest: string | null
          checkpoint_verified_at_ms: number | null
          checkpoint_expires_at_ms: number | null
        }
      | undefined
    const checkpoint =
      session?.checkpoint_kind === CODEX_CHECKPOINT_KIND &&
      session.checkpoint_version === 1 &&
      session.checkpoint_digest &&
      session.checkpoint_verified_at_ms !== null &&
      session.checkpoint_expires_at_ms !== null
        ? {
            descriptorVersion: 1 as const,
            kind: CODEX_CHECKPOINT_KIND,
            digestSha256: session.checkpoint_digest,
            sizeBytes: 16 as const,
            createdAtMs: session.checkpoint_verified_at_ms,
            expiresAtMs: session.checkpoint_expires_at_ms
          }
        : undefined
    return {
      state: 'confirmationRequired' as const,
      confirmationId: row.confirmation_id,
      ...(checkpoint ? { checkpoint } : {}),
      challenge: {
        confirmationId: row.confirmation_id,
        choice: 'terminateAfterWarning' as const,
        provider: {
          providerId: row.provider_id,
          providerEpoch: row.provider_epoch,
          leaseId: row.provider_lease_id
        },
        window: { windowId: row.window_id, windowGeneration: row.window_generation },
        nonce: retained.nonce,
        expiresAtMs: row.expires_at_ms
      }
    }
  }

  /** Consumes a challenge; it does not terminate or detach the terminal. */
  consume(input: unknown): void {
    const params = agentHibernationConfirmParamsSchema.parse(input)
    if (
      params.choice !== 'terminateAfterWarning' ||
      !this.authority.current(params.provider, params.window)
    )
      throw new AgentMutationError('provider_unavailable', 'Hibernation authority is unavailable')
    const now = this.now()
    if (params.expiresAtMs <= now || params.expiresAtMs > now + 30_000)
      throw new AgentMutationError('invalid_state', 'Hibernation challenge expired')
    const hash = Buffer.from(createHash('sha256').update(params.nonce).digest('hex'), 'hex')
    const retained = this.nonces.get(params.confirmationId)
    if (
      !retained ||
      retained.agentSessionId !== params.agentSessionId ||
      retained.expiresAtMs !== params.expiresAtMs ||
      retained.nonce !== params.nonce
    )
      throw new AgentMutationError('invalid_state', 'Hibernation challenge was invalidated')
    this.database
      .transaction(() => {
        const row = this.database
          .prepare(
            `SELECT * FROM agent_hibernation_confirmations
        WHERE confirmation_id = ?`
          )
          .get(params.confirmationId) as Confirmation | undefined
        const session = this.database
          .prepare(
            `SELECT revision, attempt_epoch FROM agent_sessions
        WHERE agent_session_id = ?`
          )
          .get(params.agentSessionId) as { revision: number; attempt_epoch: number } | undefined
        const storedHash = row && Buffer.from(row.nonce_hash, 'hex')
        if (
          !row ||
          !session ||
          row.consumed_at_ms !== null ||
          row.expires_at_ms <= now ||
          row.agent_session_id !== params.agentSessionId ||
          row.session_revision !== session.revision ||
          row.attempt_epoch !== session.attempt_epoch ||
          row.session_revision !== params.operation.sessionRevision ||
          row.attempt_epoch !== params.operation.attemptEpoch ||
          row.choice !== params.choice ||
          row.provider_id !== params.provider.providerId ||
          row.provider_epoch !== params.provider.providerEpoch ||
          row.provider_lease_id !== params.provider.leaseId ||
          row.window_id !== params.window.windowId ||
          row.window_generation !== params.window.windowGeneration ||
          row.expires_at_ms !== params.expiresAtMs ||
          !storedHash ||
          storedHash.length !== hash.length ||
          !timingSafeEqual(storedHash, hash)
        )
          throw new AgentMutationError('invalid_state', 'Hibernation challenge is unavailable')
        const changed = this.database
          .prepare(
            `UPDATE agent_hibernation_confirmations SET consumed_at_ms = ?
        WHERE confirmation_id = ? AND consumed_at_ms IS NULL`
          )
          .run(now, params.confirmationId)
        if (changed.changes !== 1)
          throw new AgentMutationError('invalid_state', 'Hibernation challenge was consumed')
      })
      .immediate()
    this.nonces.delete(params.confirmationId)
  }

  invalidateAll(): number {
    this.nonces.clear()
    return this.database
      .prepare(
        `UPDATE agent_hibernation_confirmations SET consumed_at_ms = ?
      WHERE consumed_at_ms IS NULL`
      )
      .run(this.now()).changes
  }

  invalidateSession(agentSessionId: string): number {
    for (const [id, retained] of this.nonces) {
      if (retained.agentSessionId === agentSessionId) this.nonces.delete(id)
    }
    return this.database
      .prepare(
        `UPDATE agent_hibernation_confirmations SET consumed_at_ms = ?
        WHERE agent_session_id = ? AND consumed_at_ms IS NULL`
      )
      .run(this.now(), agentSessionId).changes
  }
}
