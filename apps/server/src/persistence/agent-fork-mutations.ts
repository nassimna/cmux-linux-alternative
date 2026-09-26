import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  constants
} from 'node:fs'
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { agentSessionForkParamsSchema } from '@agent-workspace/protocol-client'

import { supportsAuditedCodexFork } from '../agents/codex-versions'
import { AgentCatalog } from './agent-catalog'
import { AgentMutationError, type AgentOperationIdentity } from './agent-mutations'

const MAX_SESSIONS = 512
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Session = {
  agent_session_id: string
  workspace_id: string
  pane_id: string
  tab_id: string
  adapter_id: string
  adapter_version: string
  revision: number
  attempt_epoch: number
}
type Operation = {
  agent_session_id: string
  session_revision: number
  attempt_epoch: number
  request_hash: string
  state: string
  terminal_code: string | null
}
type Orphan = {
  destination_agent_session_id: string
  source_agent_session_id: string
  adapter_id: string
  adapter_version: string
  operation_id: string
  request_hash: string
  artifact_kind: string
  artifact_version: number
  artifact_digest: string
  cleanup_state: 'pending' | 'archiveFailed'
  cleanup_attempts: number
  created_at_ms: number
  updated_at_ms: number
}
export interface PreparedAgentFork {
  destinationAgentSessionId: string
  launch(): Promise<void>
  archive(): Promise<void>
  close(): void
}
export interface AgentForkEvidence {
  destinationLive(binding: { workspaceId: string; paneId: string; tabId: string }): boolean
  prepare(
    sourceAgentSessionId: string,
    adapterVersion: string,
    destination: { workspaceId: string; paneId: string; tabId: string }
  ): Promise<PreparedAgentFork>
  archive(destinationAgentSessionId: string, adapterVersion: string): Promise<void>
}

/** The external fork is journaled before the destination is attached to the catalog. */
export class AgentForkMutations {
  private readonly catalog: AgentCatalog
  private readonly recoveryDirectory: string

  constructor(
    private readonly database: Database.Database,
    databasePath: string,
    private readonly evidence: AgentForkEvidence,
    private readonly now: () => number = Date.now
  ) {
    this.catalog = new AgentCatalog(database)
    this.recoveryDirectory = `${databasePath}.agent-fork-recovery`
  }

  async fork(input: unknown) {
    const params = agentSessionForkParamsSchema.parse(input)
    this.checkOperation(params.operation)
    const prior = this.operation(params.operation.idempotencyKey)
    if (prior) return this.replay(prior, params.sourceAgentSessionId, params.operation)
    const source = this.session(params.sourceAgentSessionId)
    this.current(source, params.operation)
    if (source.adapter_id !== 'codex' || !supportsAuditedCodexFork(source.adapter_version))
      throw new AgentMutationError('provider_unavailable', 'Fork requires an audited Codex adapter')
    if (
      source.workspace_id === params.destination.workspaceId &&
      source.pane_id === params.destination.paneId &&
      source.tab_id === params.destination.tabId
    )
      throw new AgentMutationError('invalid_params', 'Fork destination must be another terminal')
    if (!this.evidence.destinationLive(params.destination))
      throw new AgentMutationError(
        'runtime_unavailable',
        'Fork destination terminal is unavailable'
      )
    this.database
      .transaction(() => {
        const current = this.session(source.agent_session_id)
        this.current(current, params.operation)
        const count = this.database
          .prepare('SELECT COUNT(*) AS count FROM agent_sessions')
          .get() as { count: number }
        if (count.count >= MAX_SESSIONS)
          throw new AgentMutationError('resource_limit', 'Agent catalog is full')
        if (this.operation(params.operation.idempotencyKey))
          throw new AgentMutationError('operation_pending', 'Fork operation is pending')
        const at = this.now()
        this.database
          .prepare(
            `INSERT INTO agent_operations (operation_id, namespace, agent_session_id,
        session_revision, attempt_epoch, request_hash, state, accepted_at_ms, updated_at_ms)
        VALUES (?, 'session.fork', ?, ?, ?, ?, 'pending', ?, ?)`
          )
          .run(
            params.operation.idempotencyKey,
            source.agent_session_id,
            source.revision,
            source.attempt_epoch,
            params.operation.requestHash,
            at,
            at
          )
      })
      .immediate()

    let prepared: PreparedAgentFork | undefined
    let orphan: Orphan | undefined
    try {
      prepared = await this.evidence.prepare(
        source.agent_session_id,
        source.adapter_version,
        params.destination
      )
      if (
        !UUID.test(prepared.destinationAgentSessionId) ||
        prepared.destinationAgentSessionId === source.agent_session_id
      )
        throw new AgentMutationError(
          'provider_unavailable',
          'Fork returned an invalid thread identity'
        )
      const at = this.now()
      const digest = createHash('sha256')
        .update('codex-thread-v1\0')
        .update(Buffer.from(prepared.destinationAgentSessionId.replaceAll('-', ''), 'hex'))
        .digest('hex')
      orphan = {
        destination_agent_session_id: prepared.destinationAgentSessionId,
        source_agent_session_id: source.agent_session_id,
        adapter_id: source.adapter_id,
        adapter_version: source.adapter_version,
        operation_id: params.operation.idempotencyKey,
        request_hash: params.operation.requestHash,
        artifact_kind: 'codex-thread-v1',
        artifact_version: 1,
        artifact_digest: digest,
        cleanup_state: 'pending',
        cleanup_attempts: 0,
        created_at_ms: at,
        updated_at_ms: at
      }
      this.writeRecovery(orphan)
      this.recordOrphan(orphan)
      this.removeRecovery(orphan.destination_agent_session_id)
      this.database
        .transaction(() => {
          const current = this.session(source.agent_session_id)
          this.current(current, params.operation)
          const operation = this.operation(params.operation.idempotencyKey)
          if (!operation || operation.state !== 'pending')
            throw new AgentMutationError('invalid_state', 'Fork operation was interrupted')
          if (
            this.database
              .prepare('SELECT 1 FROM agent_sessions WHERE agent_session_id = ?')
              .get(orphan!.destination_agent_session_id)
          )
            throw new AgentMutationError(
              'idempotency_conflict',
              'Fork destination identity is in use'
            )
          const time = this.now()
          this.database
            .prepare(
              `INSERT INTO agent_sessions (agent_session_id, workspace_id, pane_id,
          tab_id, adapter_id, adapter_version, title, lifecycle, durable_intent, restore_level,
          revision, attempt_epoch, evidence_epoch, last_verified_at_ms,
          forked_from_agent_session_id, fork_artifact_kind, fork_artifact_version,
          fork_artifact_digest, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, 'codex', ?, ?, 'created', 'fork', 'unavailable',
          1, ?, 1, ?, ?, ?, 1, ?, ?, ?)`
            )
            .run(
              orphan!.destination_agent_session_id,
              params.destination.workspaceId,
              params.destination.paneId,
              params.destination.tabId,
              source.adapter_version,
              params.title,
              params.operation.attemptEpoch,
              time,
              source.agent_session_id,
              orphan!.artifact_kind,
              orphan!.artifact_digest,
              time,
              time
            )
          this.database
            .prepare(
              `INSERT INTO agent_operations (operation_id, namespace, agent_session_id,
          session_revision, attempt_epoch, request_hash, state, terminal_code, accepted_at_ms,
          updated_at_ms, terminal_at_ms) VALUES (?, 'catalog.register', ?, 1, ?, ?,
          'succeeded', 'registered', ?, ?, ?)`
            )
            .run(
              params.operation.idempotencyKey,
              orphan!.destination_agent_session_id,
              params.operation.attemptEpoch,
              params.operation.requestHash,
              time,
              time,
              time
            )
          this.database
            .prepare(
              `UPDATE agent_operations SET state = 'succeeded', terminal_code = 'forkCreated',
          updated_at_ms = ?, terminal_at_ms = ? WHERE namespace = 'session.fork' AND operation_id = ?
          AND state = 'pending'`
            )
            .run(time, time, params.operation.idempotencyKey)
          this.database
            .prepare('DELETE FROM agent_fork_orphans WHERE destination_agent_session_id = ?')
            .run(orphan!.destination_agent_session_id)
          this.bumpCatalog()
        })
        .immediate()
      try {
        await prepared.launch()
      } catch {
        const at = this.now()
        this.database
          .transaction(() => {
            this.database
              .prepare(
                `UPDATE agent_sessions SET lifecycle = 'failed',
            durable_intent = 'fork', revision = revision + 1, updated_at_ms = ?
            WHERE agent_session_id = ?`
              )
              .run(at, orphan!.destination_agent_session_id)
            this.bumpCatalog()
          })
          .immediate()
        throw new AgentMutationError(
          'runtime_unavailable',
          'Forked thread exists but terminal launch failed'
        )
      }
      return this.catalog.get(orphan.destination_agent_session_id)
    } catch (error) {
      const destinationAttached =
        orphan &&
        this.database
          .prepare('SELECT 1 FROM agent_sessions WHERE agent_session_id = ?')
          .get(orphan.destination_agent_session_id)
      if (orphan && !destinationAttached) {
        try {
          await prepared?.archive()
          this.clearOrphan(orphan.destination_agent_session_id)
          this.finishFailed(params.operation, 'forkCompensated')
        } catch {
          if (
            this.database
              .prepare('SELECT 1 FROM agent_fork_orphans WHERE destination_agent_session_id = ?')
              .get(orphan.destination_agent_session_id)
          )
            this.markArchiveFailed(orphan.destination_agent_session_id)
          else if (!existsSync(this.recoveryPath(orphan.destination_agent_session_id)))
            this.writeRecovery(orphan)
          this.finishFailed(params.operation, 'forkCompensationFailed')
        }
      } else if (!orphan) {
        this.finishFailed(params.operation, 'adapterRejected')
      }
      throw error
    } finally {
      prepared?.close()
    }
  }

  /** Import recovery files before retrying cleanup. Unresolved identities remain durable. */
  async recoverOrphans(): Promise<number> {
    this.importRecovery()
    const rows = this.database
      .prepare(
        'SELECT * FROM agent_fork_orphans ORDER BY created_at_ms, destination_agent_session_id'
      )
      .all() as Orphan[]
    for (const orphan of rows) {
      if (
        this.database
          .prepare('SELECT 1 FROM agent_sessions WHERE agent_session_id = ?')
          .get(orphan.destination_agent_session_id)
      ) {
        this.clearOrphan(orphan.destination_agent_session_id)
        continue
      }
      try {
        await this.evidence.archive(orphan.destination_agent_session_id, orphan.adapter_version)
        this.clearOrphan(orphan.destination_agent_session_id)
      } catch {
        this.markArchiveFailed(orphan.destination_agent_session_id)
      }
    }
    return rows.length
  }

  hasUnresolvedOrphans(): boolean {
    return !!this.database.prepare('SELECT 1 FROM agent_fork_orphans LIMIT 1').get()
  }

  private session(id: string): Session {
    const row = this.database
      .prepare(
        `SELECT agent_session_id, workspace_id, pane_id, tab_id,
      adapter_id, adapter_version, revision, attempt_epoch FROM agent_sessions WHERE agent_session_id = ?`
      )
      .get(id) as Session | undefined
    if (!row) throw new AgentMutationError('session_unavailable', 'Agent session is unavailable')
    return row
  }
  private operation(id: string): Operation | undefined {
    return this.database
      .prepare(
        `SELECT agent_session_id, session_revision, attempt_epoch, request_hash,
      state, terminal_code FROM agent_operations WHERE namespace = 'session.fork' AND operation_id = ?`
      )
      .get(id) as Operation | undefined
  }
  private replay(row: Operation, source: string, identity: AgentOperationIdentity) {
    if (
      row.agent_session_id !== source ||
      row.session_revision !== identity.sessionRevision ||
      row.attempt_epoch !== identity.attemptEpoch ||
      row.request_hash !== identity.requestHash
    )
      throw new AgentMutationError('idempotency_conflict', 'Fork operation identity is in use')
    if (row.state === 'pending')
      throw new AgentMutationError('operation_pending', 'Fork operation is pending')
    if (row.state !== 'succeeded' || row.terminal_code !== 'forkCreated')
      throw new AgentMutationError('invalid_state', 'Fork operation did not succeed')
    const destination = this.database
      .prepare(
        `SELECT agent_session_id, lifecycle FROM agent_sessions
      WHERE agent_session_id = (SELECT agent_session_id FROM agent_operations
      WHERE namespace = 'catalog.register' AND operation_id = ?)`
      )
      .get(identity.idempotencyKey) as { agent_session_id: string; lifecycle: string } | undefined
    if (!destination || destination.lifecycle === 'failed')
      throw new AgentMutationError('runtime_unavailable', 'Fork destination is unavailable')
    return this.catalog.get(destination.agent_session_id)
  }
  private current(session: Session, identity: AgentOperationIdentity): void {
    if (
      session.revision !== identity.sessionRevision ||
      session.attempt_epoch !== identity.attemptEpoch
    )
      throw new AgentMutationError('stale_revision', 'Fork source revision or attempt is stale')
  }
  private checkOperation(identity: AgentOperationIdentity): void {
    if (
      !UUID.test(identity.idempotencyKey) ||
      !/^[0-9a-f]{64}$/.test(identity.requestHash) ||
      !Number.isSafeInteger(identity.sessionRevision) ||
      identity.sessionRevision < 1 ||
      !Number.isSafeInteger(identity.attemptEpoch) ||
      identity.attemptEpoch < 1
    )
      throw new AgentMutationError('invalid_params', 'Invalid fork operation identity')
  }
  private bumpCatalog(): void {
    const result = this.database
      .prepare(
        'UPDATE agent_catalog_state SET revision = revision + 1 WHERE singleton = 1 AND revision < 9007199254740991'
      )
      .run()
    if (result.changes !== 1)
      throw new AgentMutationError('resource_limit', 'Agent catalog revision limit reached')
  }
  private finishFailed(identity: AgentOperationIdentity, code: string): void {
    const at = this.now()
    this.database
      .prepare(
        `UPDATE agent_operations SET state = 'failed', terminal_code = ?,
      updated_at_ms = max(updated_at_ms, ?), terminal_at_ms = max(updated_at_ms, ?)
      WHERE namespace = 'session.fork' AND operation_id = ? AND request_hash = ? AND state = 'pending'`
      )
      .run(code, at, at, identity.idempotencyKey, identity.requestHash)
  }
  private recordOrphan(orphan: Orphan): void {
    this.validateOrphan(orphan)
    this.database
      .prepare(
        `INSERT INTO agent_fork_orphans (destination_agent_session_id,
      source_agent_session_id, adapter_id, adapter_version, operation_id, request_hash,
      artifact_kind, artifact_version, artifact_digest, cleanup_state, cleanup_attempts,
      created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
      )
      .run(
        orphan.destination_agent_session_id,
        orphan.source_agent_session_id,
        orphan.adapter_id,
        orphan.adapter_version,
        orphan.operation_id,
        orphan.request_hash,
        orphan.artifact_kind,
        orphan.artifact_version,
        orphan.artifact_digest,
        orphan.created_at_ms,
        orphan.updated_at_ms
      )
  }
  private clearOrphan(id: string): void {
    this.database
      .prepare('DELETE FROM agent_fork_orphans WHERE destination_agent_session_id = ?')
      .run(id)
    this.removeRecovery(id)
  }
  private markArchiveFailed(id: string): void {
    this.database
      .prepare(
        `UPDATE agent_fork_orphans SET cleanup_state = 'archiveFailed',
      cleanup_attempts = cleanup_attempts + 1, updated_at_ms = ?
      WHERE destination_agent_session_id = ?`
      )
      .run(this.now(), id)
  }
  private recoveryPath(id: string): string {
    return join(this.recoveryDirectory, `${id.replaceAll('-', '')}.json`)
  }
  private ensureRecoveryDirectory(): void {
    if (!existsSync(this.recoveryDirectory)) mkdirSync(this.recoveryDirectory, { mode: 0o700 })
    const stat = lstatSync(this.recoveryDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new AgentMutationError('runtime_unavailable', 'Fork recovery directory is insecure')
  }
  private writeRecovery(orphan: Orphan): void {
    this.validateOrphan(orphan)
    this.ensureRecoveryDirectory()
    const target = this.recoveryPath(orphan.destination_agent_session_id)
    if (existsSync(target))
      throw new AgentMutationError('idempotency_conflict', 'Fork recovery identity is in use')
    const temporary = join(this.recoveryDirectory, `${randomUUID()}.tmp`)
    const file = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      writeFileSync(file, JSON.stringify(orphan))
      fsyncSync(file)
    } catch (error) {
      closeSync(file)
      unlinkSync(temporary)
      throw error
    }
    closeSync(file)
    renameSync(temporary, target)
    const directory = openSync(this.recoveryDirectory, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }
  private removeRecovery(id: string): void {
    const target = this.recoveryPath(id)
    if (!existsSync(target)) return
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new AgentMutationError('runtime_unavailable', 'Fork recovery record is insecure')
    unlinkSync(target)
    const directory = openSync(this.recoveryDirectory, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }
  private importRecovery(): void {
    if (!existsSync(this.recoveryDirectory)) return
    this.ensureRecoveryDirectory()
    const names = readdirSync(this.recoveryDirectory)
    if (names.length > MAX_SESSIONS)
      throw new AgentMutationError('resource_limit', 'Fork recovery limit reached')
    for (const name of names.filter((entry) => /^[0-9a-f-]{36}\.tmp$/.test(entry))) {
      const temporary = join(this.recoveryDirectory, name)
      const stat = lstatSync(temporary)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 16_384
      )
        throw new AgentMutationError(
          'runtime_unavailable',
          'Fork recovery temporary entry is insecure'
        )
      const orphan = JSON.parse(readFileSync(temporary, 'utf8')) as Orphan
      this.validateOrphan(orphan)
      const target = this.recoveryPath(orphan.destination_agent_session_id)
      if (existsSync(target))
        throw new AgentMutationError('idempotency_conflict', 'Fork recovery identity is duplicated')
      renameSync(temporary, target)
      const directory = openSync(this.recoveryDirectory, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    }
    for (const name of readdirSync(this.recoveryDirectory)) {
      if (!/^[0-9a-f]{32}\.json$/.test(name))
        throw new AgentMutationError('runtime_unavailable', 'Fork recovery entry is invalid')
      const file = join(this.recoveryDirectory, name)
      const stat = lstatSync(file)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 16_384
      )
        throw new AgentMutationError('runtime_unavailable', 'Fork recovery entry is insecure')
      const orphan = JSON.parse(readFileSync(file, 'utf8')) as Orphan
      this.validateOrphan(orphan)
      if (
        this.recoveryPath(orphan.destination_agent_session_id) !== file ||
        !this.database
          .prepare('SELECT 1 FROM agent_sessions WHERE agent_session_id = ?')
          .get(orphan.source_agent_session_id)
      )
        throw new AgentMutationError('runtime_unavailable', 'Fork recovery identity is invalid')
      if (
        !this.database
          .prepare('SELECT 1 FROM agent_fork_orphans WHERE destination_agent_session_id = ?')
          .get(orphan.destination_agent_session_id)
      )
        this.recordOrphan(orphan)
      this.removeRecovery(orphan.destination_agent_session_id)
    }
  }

  private validateOrphan(orphan: Orphan): void {
    const digest = UUID.test(orphan.destination_agent_session_id)
      ? createHash('sha256')
          .update('codex-thread-v1\0')
          .update(Buffer.from(orphan.destination_agent_session_id.replaceAll('-', ''), 'hex'))
          .digest('hex')
      : ''
    if (
      !UUID.test(orphan.destination_agent_session_id) ||
      !UUID.test(orphan.source_agent_session_id) ||
      orphan.destination_agent_session_id === orphan.source_agent_session_id ||
      !UUID.test(orphan.operation_id) ||
      !/^[0-9a-f]{64}$/.test(orphan.request_hash) ||
      orphan.adapter_id !== 'codex' ||
      !supportsAuditedCodexFork(orphan.adapter_version) ||
      orphan.artifact_kind !== 'codex-thread-v1' ||
      orphan.artifact_version !== 1 ||
      orphan.artifact_digest !== digest ||
      orphan.cleanup_state !== 'pending' ||
      orphan.cleanup_attempts !== 0 ||
      !Number.isSafeInteger(orphan.created_at_ms) ||
      orphan.created_at_ms < 0 ||
      !Number.isSafeInteger(orphan.updated_at_ms) ||
      orphan.updated_at_ms < orphan.created_at_ms
    )
      throw new AgentMutationError('runtime_unavailable', 'Fork recovery record is invalid')
  }
}
