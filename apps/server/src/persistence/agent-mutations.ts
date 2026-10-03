import type Database from 'better-sqlite3'

import { AgentCatalog } from './agent-catalog'

export interface AgentSessionBinding {
  workspaceId: string
  paneId: string
  tabId: string
  agentSessionId: string
}

export interface AgentOperationIdentity {
  idempotencyKey: string
  requestHash: string
  sessionRevision: number
  attemptEpoch: number
}

export interface AgentCatalogRegisterParams {
  catalogVersion: 1
  binding: AgentSessionBinding
  adapterId: string
  adapterVersion: string
  title: string
  operation: AgentOperationIdentity
}

/** The caller must prove an exact live terminal binding and a trusted adapter's resume preparation. */
export interface AgentRegistrationGate {
  prepareRegistration(params: AgentCatalogRegisterParams): Promise<void>
}

export class AgentMutationError extends Error {
  public constructor(
    public readonly code:
      | 'invalid_params'
      | 'runtime_unavailable'
      | 'provider_unavailable'
      | 'stale_revision'
      | 'idempotency_conflict'
      | 'resource_limit'
      | 'invalid_state'
      | 'operation_pending'
      | 'session_unavailable',
    message: string
  ) {
    super(message)
    this.name = 'AgentMutationError'
  }
}

type OperationRow = {
  agent_session_id: string
  session_revision: number
  attempt_epoch: number
  request_hash: string
  state: string
  terminal_code: string | null
}

type SessionRow = {
  workspace_id: string
  pane_id: string
  tab_id: string
  adapter_id: string
  adapter_version: string
  title: string
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digest = /^[0-9a-f]{64}$/
const token = /^[A-Za-z0-9._-]{1,64}$/
const nilUuid = '00000000-0000-0000-0000-000000000000'

function validParams(params: AgentCatalogRegisterParams): boolean {
  const { binding, operation } = params
  return (
    params.catalogVersion === 1 &&
    [
      binding.workspaceId,
      binding.paneId,
      binding.tabId,
      binding.agentSessionId,
      operation.idempotencyKey
    ].every((id) => uuid.test(id) && id !== nilUuid) &&
    digest.test(operation.requestHash) &&
    Number.isSafeInteger(operation.sessionRevision) &&
    Number.isSafeInteger(operation.attemptEpoch) &&
    operation.attemptEpoch > 0 &&
    token.test(params.adapterId) &&
    token.test(params.adapterVersion) &&
    params.title.length > 0 &&
    [...params.title].length <= 160 &&
    params.title === params.title.trim() &&
    ![...params.title].some((character) => {
      const point = character.codePointAt(0)!
      return point < 32 || point === 127
    })
  )
}

/** Durable schema-v15 registration. No adapter operation is inferred from stored metadata. */
export class AgentMutations {
  private readonly catalog: AgentCatalog

  public constructor(
    private readonly database: Database.Database,
    private readonly gate: AgentRegistrationGate
  ) {
    this.catalog = new AgentCatalog(database)
  }

  public async register(input: AgentCatalogRegisterParams) {
    if (!validParams(input))
      throw new AgentMutationError('invalid_params', 'Invalid agent registration')
    if (input.operation.sessionRevision !== 1)
      throw new AgentMutationError('stale_revision', 'The agent session revision is stale')

    // Replays must not call an adapter again, including after a service restart.
    const replay = this.readOperation(input.operation.idempotencyKey)
    if (!replay) {
      if (!this.gate?.prepareRegistration)
        throw new AgentMutationError(
          'runtime_unavailable',
          'Agent registration runtime is unavailable'
        )
      await this.gate.prepareRegistration(input)
    }

    const sessionId = this.database
      .transaction(() => {
        const existing = this.readOperation(input.operation.idempotencyKey)
        if (existing) {
          this.assertReplay(existing, input)
          return existing.agent_session_id
        }
        const count = this.database
          .prepare('SELECT COUNT(*) AS count FROM agent_sessions')
          .get() as {
          count: number
        }
        if (count.count >= 512)
          throw new AgentMutationError('resource_limit', 'Agent session catalog is full')
        if (
          this.database
            .prepare('SELECT 1 FROM agent_sessions WHERE agent_session_id = ?')
            .get(input.binding.agentSessionId)
        ) {
          throw new AgentMutationError('idempotency_conflict', 'Agent session identity is in use')
        }
        const now = Date.now()
        this.database
          .prepare(
            `INSERT INTO agent_sessions (
              agent_session_id, workspace_id, pane_id, tab_id, adapter_id, adapter_version,
              title, lifecycle, durable_intent, restore_level, revision, attempt_epoch,
              evidence_epoch, last_verified_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', 'launch', 'unavailable', 1, ?, 1, ?, ?, ?)`
          )
          .run(
            input.binding.agentSessionId,
            input.binding.workspaceId,
            input.binding.paneId,
            input.binding.tabId,
            input.adapterId,
            input.adapterVersion,
            input.title,
            input.operation.attemptEpoch,
            now,
            now,
            now
          )
        this.database
          .prepare(
            `INSERT INTO agent_operations (
              operation_id, namespace, agent_session_id, session_revision, attempt_epoch,
              request_hash, state, terminal_code, accepted_at_ms, updated_at_ms, terminal_at_ms
            ) VALUES (?, 'catalog.register', ?, 1, ?, ?, 'succeeded', 'registered', ?, ?, ?)`
          )
          .run(
            input.operation.idempotencyKey,
            input.binding.agentSessionId,
            input.operation.attemptEpoch,
            input.operation.requestHash,
            now,
            now,
            now
          )
        const bumped = this.database
          .prepare(
            'UPDATE agent_catalog_state SET revision = revision + 1 WHERE singleton = 1 AND revision < 9007199254740991'
          )
          .run()
        if (bumped.changes !== 1)
          throw new AgentMutationError('invalid_state', 'Agent catalog revision is unavailable')
        return input.binding.agentSessionId
      })
      .immediate()

    return this.catalog.get(sessionId)
  }

  private readOperation(id: string): OperationRow | undefined {
    return this.database
      .prepare(
        `SELECT agent_session_id, session_revision, attempt_epoch, request_hash, state, terminal_code
         FROM agent_operations WHERE namespace = 'catalog.register' AND operation_id = ?`
      )
      .get(id) as OperationRow | undefined
  }

  private assertReplay(existing: OperationRow, input: AgentCatalogRegisterParams): void {
    if (
      existing.agent_session_id !== input.binding.agentSessionId ||
      existing.session_revision !== input.operation.sessionRevision ||
      existing.attempt_epoch !== input.operation.attemptEpoch ||
      existing.request_hash !== input.operation.requestHash ||
      existing.state !== 'succeeded' ||
      existing.terminal_code !== 'registered'
    ) {
      throw new AgentMutationError('idempotency_conflict', 'Agent operation identity is in use')
    }
    const session = this.database
      .prepare(
        `SELECT workspace_id, pane_id, tab_id, adapter_id, adapter_version, title
         FROM agent_sessions WHERE agent_session_id = ?`
      )
      .get(existing.agent_session_id) as SessionRow | undefined
    if (
      !session ||
      session.workspace_id !== input.binding.workspaceId ||
      session.pane_id !== input.binding.paneId ||
      session.tab_id !== input.binding.tabId ||
      session.adapter_id !== input.adapterId ||
      session.adapter_version !== input.adapterVersion ||
      session.title !== input.title
    ) {
      throw new AgentMutationError('idempotency_conflict', 'Agent registration replay differs')
    }
  }
}
