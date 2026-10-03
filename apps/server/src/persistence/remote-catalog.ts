import type Database from 'better-sqlite3'
import {
  ONLINE_ENROLLMENT_MARKER_EPOCH,
  ONLINE_ENROLLMENT_MARKER_NAMESPACE,
  LIVE_NEW_ENROLLMENT_NAMESPACE,
  ONLINE_REPLACEMENT_CLEANUP_NAMESPACE
} from '../remote/credential-enrollment-marker'

import {
  remoteListParamsSchema,
  remoteSessionListResultSchema,
  remoteSessionResultSchema,
  remoteSessionConnectParamsSchema,
  remoteSessionDetachParamsSchema,
  remoteSessionCloseParamsSchema,
  remoteTargetCreateParamsSchema,
  remoteTargetListResultSchema,
  remoteTargetResultSchema,
  type RemoteTargetCreateParams,
  type RemoteSessionConnectParams,
  type RemoteSessionDetachParams,
  type RemoteSessionCloseParams
} from '@agent-workspace/contracts'
import {
  remoteTargetDeleteParamsSchema,
  type RemoteTargetDeleteParams
} from '@agent-workspace/protocol-client'

const LEGACY_EPOCH = '00000000-0000-0000-0000-000000000001'
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const PENDING_OPERATION = '{"remoteOperation":"pending"}'

export interface RemoteOperationMutation {
  idempotencyKey: string
  requestHash: string
  expectedRevision: number
}

export type HostKeyOperation = 'scan' | 'decide' | 'discover'
const ACTIVATION_NAMESPACE = 'remote.session.activate'

function operationNamespace(operation: HostKeyOperation): string {
  return operation === 'discover' ? 'remote.tmux.discover' : `remote.hostKey.${operation}`
}

type TargetRow = {
  remote_target_id: string
  label: string
  host: string
  port: number
  user: string
  host_key_state: string
  known_hosts_version: number
  revision: number
}

type SessionRow = {
  remote_session_id: string
  remote_target_id: string
  workspace_id: string
  pane_id: string
  tab_id: string
  tmux_mode: string | null
  tmux_name: string | null
  state: string
  observation: string
  attempt_generation: number
  reconnect_max_attempts: number
  reconnect_initial_delay_ms: number
  reconnect_max_delay_ms: number
  revision: number
}

const TARGET_COLUMNS =
  'remote_target_id,label,host,port,user,host_key_state,known_hosts_version,revision'
const SESSION_COLUMNS =
  'remote_session_id,remote_target_id,workspace_id,pane_id,tab_id,tmux_mode,tmux_name,state,observation,attempt_generation,reconnect_max_attempts,reconnect_initial_delay_ms,reconnect_max_delay_ms,revision'

export class RemoteCatalogError extends Error {
  public constructor(
    public readonly code:
      | 'target_not_found'
      | 'session_not_found'
      | 'stale_revision'
      | 'idempotency_conflict'
      | 'result_expired'
      | 'resource_limit'
      | 'invalid_state'
      | 'host_key_mismatch'
      | 'scan_unavailable'
      | 'unsafe_known_hosts'
      | 'prompt_capacity',
    message: string
  ) {
    super(message)
    this.name = 'RemoteCatalogError'
  }
}

function targetSnapshot(row: TargetRow) {
  return remoteTargetResultSchema.shape.target.parse({
    remoteTargetId: row.remote_target_id,
    label: row.label,
    host: row.host,
    port: row.port,
    user: row.user,
    authentication: 'publicKey',
    hostKeyState: row.host_key_state,
    knownHostsVersion: row.known_hosts_version,
    revision: row.revision
  })
}

function sessionSnapshot(row: SessionRow) {
  return remoteSessionResultSchema.shape.session.parse({
    remoteSessionId: row.remote_session_id,
    remoteTargetId: row.remote_target_id,
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    tabId: row.tab_id,
    ...(row.tmux_mode && row.tmux_name
      ? { tmux: { mode: row.tmux_mode, sessionName: row.tmux_name } }
      : {}),
    state: row.state,
    observation: row.observation,
    attemptGeneration: row.attempt_generation,
    revision: row.revision,
    reconnect: {
      maxAttempts: row.reconnect_max_attempts,
      initialDelayMs: row.reconnect_initial_delay_ms,
      maxDelayMs: row.reconnect_max_delay_ms
    }
  })
}

/** Schema-v15 remote catalog operations on the same isolated working-copy connection. */
export class RemoteCatalog {
  public constructor(
    private readonly database: Database.Database,
    private readonly now: () => number
  ) {}

  public reconcileAfterRestart(): number {
    const at = this.now()
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Remote restart timestamp is invalid')
    return this.database
      .prepare(
        `UPDATE remote_sessions
         SET state = 'detached', observation = 'unknown',
             attempt_generation = attempt_generation + 1, revision = revision + 1,
             updated_at_ms = ?
         WHERE state IN ('connecting', 'connected', 'reconnecting')
           AND attempt_generation < ? AND revision < ?`
      )
      .run(at, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER).changes
  }

  public listTargets(input: unknown) {
    const { limit, cursor } = remoteListParamsSchema.parse(input)
    const rows = this.database
      .prepare(
        `SELECT ${TARGET_COLUMNS} FROM remote_targets
         WHERE remote_target_id > ? ORDER BY remote_target_id LIMIT ?`
      )
      .all(cursor ?? '', limit + 1) as TargetRow[]
    const nextCursor = rows.length > limit ? rows[limit - 1]!.remote_target_id : undefined
    return remoteTargetListResultSchema.parse({
      targets: rows.slice(0, limit).map(targetSnapshot),
      ...(nextCursor ? { nextCursor } : {})
    })
  }

  public getTarget(targetId: string) {
    const row = this.database
      .prepare(`SELECT ${TARGET_COLUMNS} FROM remote_targets WHERE remote_target_id = ?`)
      .get(targetId) as TargetRow | undefined
    if (!row) throw new RemoteCatalogError('target_not_found', 'Remote target does not exist')
    return remoteTargetResultSchema.parse({ target: targetSnapshot(row) })
  }

  public listSessions(input: unknown) {
    const { limit, cursor } = remoteListParamsSchema.parse(input)
    const rows = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM remote_sessions
         WHERE remote_session_id > ? ORDER BY remote_session_id LIMIT ?`
      )
      .all(cursor ?? '', limit + 1) as SessionRow[]
    const nextCursor = rows.length > limit ? rows[limit - 1]!.remote_session_id : undefined
    return remoteSessionListResultSchema.parse({
      sessions: rows.slice(0, limit).map(sessionSnapshot),
      ...(nextCursor ? { nextCursor } : {})
    })
  }

  public getSession(sessionId: string) {
    const row = this.database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM remote_sessions WHERE remote_session_id = ?`)
      .get(sessionId) as SessionRow | undefined
    if (!row) throw new RemoteCatalogError('session_not_found', 'Remote session does not exist')
    return remoteSessionResultSchema.parse({ session: sessionSnapshot(row) })
  }

  public createTarget(input: RemoteTargetCreateParams) {
    const request = remoteTargetCreateParamsSchema.parse(input)
    const { mutation } = request
    if (mutation.expectedRevision !== 0) {
      throw new RemoteCatalogError('stale_revision', 'Remote target revision changed')
    }
    const at = this.now()
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Remote target timestamp is invalid')
    return this.database
      .transaction(() => {
        const previous = this.database
          .prepare(
            `SELECT request_hash, result_json FROM idempotency_results
           WHERE namespace = 'remote.target.create' AND epoch = ? AND idempotency_key = ?`
          )
          .get(LEGACY_EPOCH, mutation.idempotencyKey) as
          { request_hash: string; result_json: string | null } | undefined
        if (previous) {
          if (previous.request_hash !== mutation.requestHash) {
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another request'
            )
          }
          if (previous.result_json === null) {
            throw new RemoteCatalogError('result_expired', 'Remote target result has expired')
          }
          const value = remoteTargetResultSchema.parse(JSON.parse(previous.result_json))
          if (value.target.remoteTargetId !== request.remoteTargetId) {
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another target'
            )
          }
          return value
        }
        const count = this.database
          .prepare('SELECT count(*) AS count FROM remote_targets')
          .get() as {
          count: number
        }
        if (count.count >= 128) {
          throw new RemoteCatalogError('resource_limit', 'Remote target limit reached')
        }
        const identity = this.database
          .prepare(
            `SELECT 1 FROM remote_targets WHERE remote_target_id = ?
           UNION ALL SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ? LIMIT 1`
          )
          .get(request.remoteTargetId, request.remoteTargetId)
        if (identity || this.hasLiveCredentialHistory(request.remoteTargetId)) {
          throw new RemoteCatalogError('invalid_state', 'Remote target ID is in use')
        }
        const replacementAlias = this.database
          .prepare(
            `SELECT 1 FROM remote_credential_enrollments
           WHERE enrollment_id = ? AND remote_target_id <> ? LIMIT 1`
          )
          .get(request.remoteTargetId, request.remoteTargetId)
        const cleanupAlias = this.database
          .prepare(
            `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
           AND idempotency_key = ? LIMIT 1`
          )
          .get(
            ONLINE_REPLACEMENT_CLEANUP_NAMESPACE,
            ONLINE_ENROLLMENT_MARKER_EPOCH,
            request.remoteTargetId
          )
        if (replacementAlias || cleanupAlias)
          throw new RemoteCatalogError(
            'invalid_state',
            'Remote target ID is reserved for credential cleanup'
          )
        this.database
          .prepare(
            `INSERT INTO remote_targets
           (remote_target_id, label, host, port, user, host_key_state, known_hosts_version,
            revision, idempotency_key, request_hash, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 'untrusted', 1, 1, ?, ?, ?, ?)`
          )
          .run(
            request.remoteTargetId,
            request.label,
            request.host,
            request.port,
            request.user,
            mutation.idempotencyKey,
            mutation.requestHash,
            at,
            at
          )
        const result = remoteTargetResultSchema.parse({
          target: {
            remoteTargetId: request.remoteTargetId,
            label: request.label,
            host: request.host,
            port: request.port,
            user: request.user,
            authentication: 'publicKey',
            hostKeyState: 'untrusted',
            knownHostsVersion: 1,
            revision: 1
          }
        })
        this.database
          .prepare(
            `INSERT INTO idempotency_results
           (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms)
           VALUES ('remote.target.create', ?, ?, ?, ?, ?)`
          )
          .run(
            LEGACY_EPOCH,
            mutation.idempotencyKey,
            mutation.requestHash,
            JSON.stringify(result),
            at
          )
        return result
      })
      .immediate()
  }

  /** Publish a new target only after its v2 key was stored; both DB writes commit together. */
  public commitEnrolledTarget(input: RemoteTargetCreateParams, enrollmentId: string) {
    const request = remoteTargetCreateParamsSchema.parse(input)
    if (request.mutation.expectedRevision !== 0) {
      throw new RemoteCatalogError('stale_revision', 'New remote target revision must be zero')
    }
    return this.database
      .transaction(() => {
        const pending = this.database
          .prepare(
            `SELECT 1 FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = 0`
          )
          .get(enrollmentId, request.remoteTargetId)
        if (!pending) {
          throw new RemoteCatalogError('invalid_state', 'Remote credential enrollment is absent')
        }
        const liveOriginTable = Boolean(
          this.database
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_live_credential_origins'"
            )
            .get()
        )
        const liveMarker = Boolean(
          this.database
            .prepare(
              `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
           AND idempotency_key = ? AND request_hash = ?`
            )
            .get(
              LIVE_NEW_ENROLLMENT_NAMESPACE,
              ONLINE_ENROLLMENT_MARKER_EPOCH,
              enrollmentId,
              request.remoteTargetId
            )
        )
        const markerNamespace = liveMarker
          ? LIVE_NEW_ENROLLMENT_NAMESPACE
          : ONLINE_ENROLLMENT_MARKER_NAMESPACE
        if (
          liveMarker &&
          (!liveOriginTable ||
            this.hasLiveCredentialHistory(request.remoteTargetId) ||
            this.database
              .prepare(
                `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
               AND idempotency_key = ?`
              )
              .get(
                ONLINE_ENROLLMENT_MARKER_NAMESPACE,
                ONLINE_ENROLLMENT_MARKER_EPOCH,
                enrollmentId
              ))
        ) {
          throw new RemoteCatalogError(
            'invalid_state',
            'Remote target identity has credential history'
          )
        }
        const completed = this.database
          .prepare(
            `SELECT 1 FROM idempotency_results
         WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?
         AND result_json = '{"status":"stored"}'`
          )
          .get(
            markerNamespace,
            ONLINE_ENROLLMENT_MARKER_EPOCH,
            enrollmentId,
            request.remoteTargetId
          )
        if (!completed) {
          throw new RemoteCatalogError(
            'invalid_state',
            'Remote credential helper has not completed'
          )
        }
        const priorCreate = this.database
          .prepare(
            `SELECT 1 FROM idempotency_results WHERE namespace = 'remote.target.create'
         AND epoch = ? AND idempotency_key = ?`
          )
          .get(LEGACY_EPOCH, request.mutation.idempotencyKey)
        if (priorCreate) {
          throw new RemoteCatalogError(
            'idempotency_conflict',
            'Remote target create key was already used'
          )
        }
        const result = this.createTarget(request)
        const inserted = this.database
          .prepare('SELECT revision FROM remote_targets WHERE remote_target_id = ?')
          .get(request.remoteTargetId) as { revision: number } | undefined
        if (result.target.remoteTargetId !== request.remoteTargetId || inserted?.revision !== 1) {
          throw new RemoteCatalogError(
            'invalid_state',
            'Remote target enrollment did not create a target'
          )
        }
        if (liveMarker) {
          const origin = this.database
            .prepare(
              `INSERT INTO node_live_credential_origins
             (remote_target_id,origin,committed_revision) VALUES (?,'v2_committed',1)`
            )
            .run(request.remoteTargetId)
          if (origin.changes !== 1)
            throw new RemoteCatalogError(
              'invalid_state',
              'Live credential origin was not published'
            )
        }
        const removed = this.database
          .prepare(
            'DELETE FROM remote_credential_enrollments WHERE enrollment_id = ? AND remote_target_id = ?'
          )
          .run(enrollmentId, request.remoteTargetId)
        if (removed.changes !== 1) {
          throw new RemoteCatalogError('invalid_state', 'Remote credential enrollment changed')
        }
        this.database
          .prepare(
            'DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?'
          )
          .run(
            markerNamespace,
            ONLINE_ENROLLMENT_MARKER_EPOCH,
            enrollmentId,
            request.remoteTargetId
          )
        return result
      })
      .immediate()
  }

  /** Fence the exact target and its sessions before any external SSH artifact is removed. */
  public beginTargetDeletion(input: RemoteTargetDeleteParams) {
    const request = remoteTargetDeleteParamsSchema.parse(input)
    const { mutation, remoteTargetId } = request
    const at = this.timestamp()
    return this.database
      .transaction(() => {
        const previous = this.database
          .prepare(
            `SELECT request_hash,result_json FROM idempotency_results
         WHERE namespace = 'remote.target.delete' AND epoch = ? AND idempotency_key = ?`
          )
          .get(LEGACY_EPOCH, mutation.idempotencyKey) as
          { request_hash: string; result_json: string | null } | undefined
        if (previous) {
          if (previous.request_hash !== mutation.requestHash) {
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another request'
            )
          }
          if (previous.result_json === null) {
            throw new RemoteCatalogError('result_expired', 'Remote target result has expired')
          }
          const value = remoteTargetResultSchema.parse(JSON.parse(previous.result_json))
          if (
            value.target.remoteTargetId !== remoteTargetId ||
            value.target.revision !== mutation.expectedRevision
          ) {
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another target or revision'
            )
          }
          return {
            replay: true as const,
            value
          }
        }
        const pending = this.database
          .prepare(
            `SELECT expected_revision,idempotency_key,request_hash,result_json FROM remote_target_deletions
         WHERE remote_target_id = ?`
          )
          .get(remoteTargetId) as
          | {
              expected_revision: number
              idempotency_key: string
              request_hash: string
              result_json: string
            }
          | undefined
        if (pending) {
          if (
            pending.expected_revision !== mutation.expectedRevision ||
            pending.idempotency_key !== mutation.idempotencyKey ||
            pending.request_hash !== mutation.requestHash
          ) {
            throw new RemoteCatalogError('invalid_state', 'Remote target deletion is pending')
          }
          return {
            replay: false as const,
            value: remoteTargetResultSchema.parse(JSON.parse(pending.result_json))
          }
        }
        const row = this.database
          .prepare(`SELECT ${TARGET_COLUMNS} FROM remote_targets WHERE remote_target_id = ?`)
          .get(remoteTargetId) as TargetRow | undefined
        if (!row) throw new RemoteCatalogError('target_not_found', 'Remote target does not exist')
        if (row.revision !== mutation.expectedRevision) {
          throw new RemoteCatalogError('stale_revision', 'Remote target revision changed')
        }
        const enrollment = this.database
          .prepare('SELECT 1 FROM remote_credential_enrollments WHERE remote_target_id = ?')
          .get(remoteTargetId)
        if (enrollment) {
          throw new RemoteCatalogError('invalid_state', 'Remote credential enrollment is pending')
        }
        const backupCleanup = this.database
          .prepare(
            `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
           AND request_hash = ? LIMIT 1`
          )
          .get(ONLINE_REPLACEMENT_CLEANUP_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH, remoteTargetId)
        if (backupCleanup)
          throw new RemoteCatalogError(
            'invalid_state',
            'Remote credential backup cleanup is pending'
          )
        const value = remoteTargetResultSchema.parse({ target: targetSnapshot(row) })
        this.database
          .prepare(
            `INSERT INTO remote_target_deletions
         (remote_target_id,expected_revision,idempotency_key,request_hash,result_json,created_at_ms)
         VALUES (?,?,?,?,?,?)`
          )
          .run(
            remoteTargetId,
            mutation.expectedRevision,
            mutation.idempotencyKey,
            mutation.requestHash,
            this.serializeResult(value),
            at
          )
        this.database
          .prepare(
            `UPDATE remote_sessions SET state = 'closed', observation = 'lost',
         revision = revision + 1, updated_at_ms = ?
         WHERE remote_target_id = ? AND state != 'closed' AND revision < ?`
          )
          .run(at, remoteTargetId, MAX_SAFE_INTEGER)
        return { replay: false as const, value }
      })
      .immediate()
  }

  /** Complete only after transport, known-host, and exact keyring cleanup succeeded. */
  public finishTargetDeletion(input: RemoteTargetDeleteParams) {
    const request = remoteTargetDeleteParamsSchema.parse(input)
    const { mutation, remoteTargetId } = request
    const at = this.timestamp()
    return this.database
      .transaction(() => {
        const previous = this.database
          .prepare(
            `SELECT request_hash,result_json FROM idempotency_results
         WHERE namespace = 'remote.target.delete' AND epoch = ? AND idempotency_key = ?`
          )
          .get(LEGACY_EPOCH, mutation.idempotencyKey) as
          { request_hash: string; result_json: string | null } | undefined
        if (previous) {
          if (previous.request_hash !== mutation.requestHash) {
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another request'
            )
          }
          if (previous.result_json === null) {
            throw new RemoteCatalogError('result_expired', 'Remote target result has expired')
          }
          const value = remoteTargetResultSchema.parse(JSON.parse(previous.result_json))
          if (
            value.target.remoteTargetId !== remoteTargetId ||
            value.target.revision !== mutation.expectedRevision
          ) {
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another target or revision'
            )
          }
          return value
        }
        const pending = this.database
          .prepare(
            `SELECT expected_revision,idempotency_key,request_hash,result_json FROM remote_target_deletions
         WHERE remote_target_id = ?`
          )
          .get(remoteTargetId) as
          | {
              expected_revision: number
              idempotency_key: string
              request_hash: string
              result_json: string
            }
          | undefined
        if (!pending)
          throw new RemoteCatalogError('target_not_found', 'Remote target deletion is absent')
        if (
          pending.expected_revision !== mutation.expectedRevision ||
          pending.idempotency_key !== mutation.idempotencyKey ||
          pending.request_hash !== mutation.requestHash
        ) {
          throw new RemoteCatalogError(
            'idempotency_conflict',
            'Remote target deletion identity changed'
          )
        }
        const enrollment = this.database
          .prepare('SELECT 1 FROM remote_credential_enrollments WHERE remote_target_id = ?')
          .get(remoteTargetId)
        if (enrollment) {
          throw new RemoteCatalogError('invalid_state', 'Remote credential enrollment is pending')
        }
        const value = remoteTargetResultSchema.parse(JSON.parse(pending.result_json))
        this.database
          .prepare('DELETE FROM remote_sessions WHERE remote_target_id = ?')
          .run(remoteTargetId)
        this.database
          .prepare('DELETE FROM remote_target_deletions WHERE remote_target_id = ?')
          .run(remoteTargetId)
        const removed = this.database
          .prepare('DELETE FROM remote_targets WHERE remote_target_id = ?')
          .run(remoteTargetId)
        if (removed.changes !== 1) {
          throw new RemoteCatalogError('target_not_found', 'Remote target does not exist')
        }
        this.database
          .prepare(
            `INSERT INTO idempotency_results
         (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
         VALUES ('remote.target.delete',?,?,?,?,?)`
          )
          .run(
            LEGACY_EPOCH,
            mutation.idempotencyKey,
            mutation.requestHash,
            this.serializeResult(value),
            at
          )
        return value
      })
      .immediate()
  }

  public sessionsForTargetDeletion(
    targetId: string
  ): { remoteSessionId: string; attemptGeneration: number }[] {
    const rows = this.database
      .prepare(
        'SELECT remote_session_id,attempt_generation FROM remote_sessions WHERE remote_target_id = ?'
      )
      .all(targetId) as { remote_session_id: string; attempt_generation: number }[]
    return rows.map((row) => ({
      remoteSessionId: row.remote_session_id,
      attemptGeneration: row.attempt_generation
    }))
  }

  public pendingTargetDeletions(): RemoteTargetDeleteParams[] {
    const rows = this.database
      .prepare(
        `SELECT remote_target_id,expected_revision,idempotency_key,request_hash
       FROM remote_target_deletions ORDER BY created_at_ms,remote_target_id LIMIT 129`
      )
      .all() as {
      remote_target_id: string
      expected_revision: number
      idempotency_key: string
      request_hash: string
    }[]
    if (rows.length > 128) {
      throw new RemoteCatalogError('resource_limit', 'Pending remote target deletion limit reached')
    }
    return rows.map((row) =>
      remoteTargetDeleteParamsSchema.parse({
        remoteTargetId: row.remote_target_id,
        mutation: {
          expectedRevision: row.expected_revision,
          idempotencyKey: row.idempotency_key,
          requestHash: row.request_hash
        }
      })
    )
  }

  /** Reserve a durable remote session without claiming that SSH has connected. */
  public getPrepareReplay(mutation: RemoteOperationMutation) {
    const previous = this.database
      .prepare(
        `SELECT request_hash, result_json FROM idempotency_results
         WHERE namespace = 'remote.session.prepare' AND epoch = ? AND idempotency_key = ?`
      )
      .get(LEGACY_EPOCH, mutation.idempotencyKey) as
      { request_hash: string; result_json: string | null } | undefined
    if (!previous) return null
    if (previous.request_hash !== mutation.requestHash) {
      throw new RemoteCatalogError('idempotency_conflict', 'Idempotency key has another request')
    }
    if (previous.result_json === null) {
      throw new RemoteCatalogError('result_expired', 'Remote session result has expired')
    }
    return remoteSessionResultSchema.parse(JSON.parse(previous.result_json))
  }

  public prepareSession(input: RemoteSessionConnectParams) {
    const request = remoteSessionConnectParamsSchema.parse(input)
    if (request.mutation.expectedRevision !== 0) {
      throw new RemoteCatalogError('stale_revision', 'Remote session revision changed')
    }
    const tmux = request.tmux
    if (!tmux) {
      throw new RemoteCatalogError('invalid_state', 'A tmux attach or create operation is required')
    }
    const at = this.now()
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Remote session timestamp is invalid')
    return this.database
      .transaction(() => {
        const replay = this.getPrepareReplay(request.mutation)
        if (replay) return replay
        const count = this.database
          .prepare('SELECT count(*) AS count FROM remote_sessions')
          .get() as { count: number }
        if (count.count >= 256) {
          throw new RemoteCatalogError('resource_limit', 'Remote session limit reached')
        }
        const target = this.database
          .prepare(`SELECT ${TARGET_COLUMNS} FROM remote_targets WHERE remote_target_id = ?`)
          .get(request.remoteTargetId) as TargetRow | undefined
        if (!target)
          throw new RemoteCatalogError('target_not_found', 'Remote target does not exist')
        const deletion = this.database
          .prepare('SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?')
          .get(request.remoteTargetId)
        if (deletion)
          throw new RemoteCatalogError('invalid_state', 'Remote target deletion is pending')
        const existing = this.database
          .prepare('SELECT 1 FROM remote_sessions WHERE remote_session_id = ?')
          .get(request.remoteSessionId)
        if (existing) throw new RemoteCatalogError('invalid_state', 'Remote session ID is in use')
        const state = target.host_key_state === 'trusted' ? 'credentialRequired' : 'trustRequired'
        this.database
          .prepare(
            `INSERT INTO remote_sessions
             (remote_session_id, remote_target_id, workspace_id, pane_id, tab_id, tmux_mode,
              tmux_name, state, observation, attempt_generation, reconnect_max_attempts,
              reconnect_initial_delay_ms, reconnect_max_delay_ms, revision, idempotency_key,
              request_hash, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 1, ?, ?, ?, 1, ?, ?, ?, ?)`
          )
          .run(
            request.remoteSessionId,
            request.remoteTargetId,
            request.workspaceId,
            request.paneId,
            request.tabId,
            tmux.mode,
            tmux.sessionName,
            state,
            request.reconnect.maxAttempts,
            request.reconnect.initialDelayMs,
            request.reconnect.maxDelayMs,
            request.mutation.idempotencyKey,
            request.mutation.requestHash,
            at,
            at
          )
        const result = this.getSession(request.remoteSessionId)
        this.database
          .prepare(
            `INSERT INTO idempotency_results
             (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms)
             VALUES ('remote.session.prepare', ?, ?, ?, ?, ?)`
          )
          .run(
            LEGACY_EPOCH,
            request.mutation.idempotencyKey,
            request.mutation.requestHash,
            JSON.stringify(result),
            at
          )
        return result
      })
      .immediate()
  }

  public detachSession(input: RemoteSessionDetachParams) {
    const request = remoteSessionDetachParamsSchema.parse(input)
    return this.mutateSessionLifecycle('remote.session.detach', request, 'detached')
  }

  public closeSession(input: RemoteSessionCloseParams) {
    const request = remoteSessionCloseParamsSchema.parse(input)
    return this.mutateSessionLifecycle('remote.session.close', request, 'closed')
  }

  /** Reserve one durable attempt before any credential lookup or SSH side effect. */
  public beginActivation(sessionId: string, mutation: RemoteOperationMutation) {
    const at = this.timestamp()
    return this.database
      .transaction(() => {
        const previous = this.database
          .prepare(
            `SELECT request_hash,result_json FROM idempotency_results
         WHERE namespace = ? AND epoch = ? AND idempotency_key = ?`
          )
          .get(ACTIVATION_NAMESPACE, LEGACY_EPOCH, mutation.idempotencyKey) as
          { request_hash: string; result_json: string | null } | undefined
        if (previous) {
          if (previous.request_hash !== mutation.requestHash)
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another request'
            )
          if (!previous.result_json || previous.result_json === PENDING_OPERATION)
            throw new RemoteCatalogError('result_expired', 'Remote attempt result is unavailable')
          return { replay: true as const, value: JSON.parse(previous.result_json) as unknown }
        }
        const row = this.database
          .prepare(`SELECT ${SESSION_COLUMNS} FROM remote_sessions WHERE remote_session_id = ?`)
          .get(sessionId) as SessionRow | undefined
        if (!row) throw new RemoteCatalogError('session_not_found', 'Remote session does not exist')
        if (row.revision !== mutation.expectedRevision || row.revision >= MAX_SAFE_INTEGER)
          throw new RemoteCatalogError('stale_revision', 'Remote session revision changed')
        if (
          !['trustRequired', 'credentialRequired', 'detached', 'reconnecting'].includes(
            row.state
          ) ||
          !row.tmux_mode ||
          !row.tmux_name
        )
          throw new RemoteCatalogError(
            'invalid_state',
            'Remote session cannot start an SSH attempt'
          )
        const target = this.database
          .prepare(`SELECT ${TARGET_COLUMNS} FROM remote_targets WHERE remote_target_id = ?`)
          .get(row.remote_target_id) as TargetRow | undefined
        if (!target)
          throw new RemoteCatalogError('target_not_found', 'Remote target does not exist')
        if (target.host_key_state !== 'trusted')
          throw new RemoteCatalogError('invalid_state', 'Exact host-key trust is required')
        if (
          this.database
            .prepare('SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?')
            .get(row.remote_target_id)
        )
          throw new RemoteCatalogError('invalid_state', 'Remote target deletion is pending')
        if (
          this.database
            .prepare('SELECT 1 FROM remote_credential_enrollments WHERE remote_target_id = ?')
            .get(row.remote_target_id)
        )
          throw new RemoteCatalogError('invalid_state', 'Remote credential enrollment is pending')
        const generation =
          row.attempt_generation +
          (row.state === 'detached' || row.state === 'reconnecting' ? 1 : 0)
        if (!Number.isSafeInteger(generation) || generation < 1)
          throw new RemoteCatalogError('stale_revision', 'Remote attempt generation exhausted')
        const changed = this.database
          .prepare(
            `UPDATE remote_sessions SET state = ?, observation = 'unknown',
         attempt_generation = ?, revision = revision + 1, updated_at_ms = ?
         WHERE remote_session_id = ? AND revision = ? AND attempt_generation = ? AND state = ?`
          )
          .run(
            row.state === 'reconnecting' ? 'reconnecting' : 'connecting',
            generation,
            at,
            sessionId,
            row.revision,
            row.attempt_generation,
            row.state
          ).changes
        if (changed !== 1) throw new RemoteCatalogError('stale_revision', 'Remote session changed')
        this.database
          .prepare(
            `INSERT INTO idempotency_results
         (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
         VALUES (?,?,?,?,?,?)`
          )
          .run(
            ACTIVATION_NAMESPACE,
            LEGACY_EPOCH,
            mutation.idempotencyKey,
            mutation.requestHash,
            PENDING_OPERATION,
            at
          )
        return {
          replay: false as const,
          session: this.getSession(sessionId).session,
          target: targetSnapshot(target)
        }
      })
      .immediate()
  }

  /** Complete only the reserved generation; store the exact replay result. */
  public completeActivation(
    sessionId: string,
    generation: number,
    connectingRevision: number,
    mutation: RemoteOperationMutation,
    outcome: 'connected' | 'failed' | 'reconnecting',
    targetId: string,
    targetRevision: number,
    knownHostsVersion: number,
    errorCode?: string
  ) {
    const at = this.timestamp()
    return this.database
      .transaction(() => {
        const changed = this.database
          .prepare(
            `UPDATE remote_sessions SET state = ?, observation = ?,
         tmux_mode = CASE WHEN ? = 'connected' AND tmux_mode = 'create'
                          THEN 'attach' ELSE tmux_mode END,
         revision = revision + 1,
         updated_at_ms = ? WHERE remote_session_id = ? AND state IN ('connecting','reconnecting')
         AND revision = ? AND attempt_generation = ?
         AND (? = 'failed' OR EXISTS (
           SELECT 1 FROM remote_targets WHERE remote_target_id = ?
           AND revision = ? AND known_hosts_version = ? AND host_key_state = 'trusted'
         ))`
          )
          .run(
            outcome,
            outcome === 'connected' ? 'lastVerified' : 'unknown',
            outcome,
            at,
            sessionId,
            connectingRevision,
            generation,
            outcome,
            targetId,
            targetRevision,
            knownHostsVersion
          ).changes
        if (changed !== 1) return { applied: false as const }
        const value =
          outcome === 'connected'
            ? this.getSession(sessionId)
            : {
                remoteError: {
                  code: errorCode ?? 'transport_unavailable',
                  message: (errorCode ?? 'transport_unavailable').replaceAll('_', ' ')
                }
              }
        const completed = this.database
          .prepare(
            `UPDATE idempotency_results SET result_json = ?, completed_at_ms = ?
         WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?
         AND result_json = ?`
          )
          .run(
            this.serializeResult(value),
            at,
            ACTIVATION_NAMESPACE,
            LEGACY_EPOCH,
            mutation.idempotencyKey,
            mutation.requestHash,
            PENDING_OPERATION
          ).changes
        if (completed !== 1)
          throw new RemoteCatalogError('stale_revision', 'Remote attempt reservation changed')
        return { applied: true as const, value }
      })
      .immediate()
  }

  /** A local SSH exit does not prove that the remote tmux session was lost. */
  public recordLocalTransportExit(sessionId: string, generation: number): boolean {
    const at = this.timestamp()
    return (
      this.database
        .prepare(
          `UPDATE remote_sessions SET
       state = CASE WHEN state = 'connected' AND reconnect_max_attempts > 0 THEN 'reconnecting'
                    WHEN state = 'connected' THEN 'detached' ELSE 'failed' END,
       observation = CASE WHEN state = 'connected' THEN 'lastVerified' ELSE 'unknown' END,
       revision = revision + 1, updated_at_ms = ?
       WHERE remote_session_id = ? AND attempt_generation = ?
       AND state IN ('connecting','connected','reconnecting') AND revision < ?`
        )
        .run(at, sessionId, generation, MAX_SAFE_INTEGER).changes === 1
    )
  }

  public markTargetHostKeyChanged(targetId: string, expectedRevision: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE remote_targets SET host_key_state = 'changed', revision = revision + 1,
       updated_at_ms = ? WHERE remote_target_id = ? AND revision = ?
       AND host_key_state = 'trusted' AND revision < ?`
        )
        .run(this.timestamp(), targetId, expectedRevision, MAX_SAFE_INTEGER).changes === 1
    )
  }

  public failReconnectIfCurrent(sessionId: string, generation: number, revision: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE remote_sessions SET state = 'failed', observation = 'unknown',
       revision = revision + 1, updated_at_ms = ? WHERE remote_session_id = ?
       AND state = 'reconnecting' AND attempt_generation = ? AND revision = ?`
        )
        .run(this.timestamp(), sessionId, generation, revision).changes === 1
    )
  }

  private mutateSessionLifecycle(
    namespace: 'remote.session.detach' | 'remote.session.close',
    request: RemoteSessionDetachParams,
    nextState: 'detached' | 'closed'
  ) {
    const at = this.timestamp()
    return this.database
      .transaction(() => {
        const { mutation } = request
        const previous = this.database
          .prepare(
            `SELECT request_hash, result_json FROM idempotency_results
         WHERE namespace = ? AND epoch = ? AND idempotency_key = ?`
          )
          .get(namespace, LEGACY_EPOCH, mutation.idempotencyKey) as
          { request_hash: string; result_json: string | null } | undefined
        if (previous) {
          if (previous.request_hash !== mutation.requestHash) {
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another request'
            )
          }
          if (previous.result_json === null) {
            throw new RemoteCatalogError('result_expired', 'Remote session result has expired')
          }
          return remoteSessionResultSchema.parse(JSON.parse(previous.result_json))
        }
        const row = this.database
          .prepare(`SELECT ${SESSION_COLUMNS} FROM remote_sessions WHERE remote_session_id = ?`)
          .get(request.remoteSessionId) as SessionRow | undefined
        if (!row) throw new RemoteCatalogError('session_not_found', 'Remote session does not exist')
        const deletion = this.database
          .prepare('SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?')
          .get(row.remote_target_id)
        if (deletion) {
          throw new RemoteCatalogError('invalid_state', 'Remote target deletion is pending')
        }
        if (row.revision !== mutation.expectedRevision || row.revision >= MAX_SAFE_INTEGER) {
          throw new RemoteCatalogError('stale_revision', 'Remote session revision changed')
        }
        const allowed =
          nextState === 'detached'
            ? row.state === 'connected' || row.state === 'reconnecting'
            : row.state !== 'closed'
        if (!allowed) {
          throw new RemoteCatalogError('invalid_state', 'Remote session transition is invalid')
        }
        const updated = this.database
          .prepare(
            `UPDATE remote_sessions SET state = ?, observation = 'unknown', revision = revision + 1,
         updated_at_ms = ? WHERE remote_session_id = ? AND revision = ?`
          )
          .run(nextState, at, request.remoteSessionId, row.revision)
        if (updated.changes !== 1) {
          throw new RemoteCatalogError('stale_revision', 'Remote session revision changed')
        }
        const result = this.getSession(request.remoteSessionId)
        this.database
          .prepare(
            `INSERT INTO idempotency_results
         (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            namespace,
            LEGACY_EPOCH,
            mutation.idempotencyKey,
            mutation.requestHash,
            this.serializeResult(result),
            at
          )
        return result
      })
      .immediate()
  }

  public reserveHostKeyOperation(
    operation: HostKeyOperation,
    id: string,
    mutation: RemoteOperationMutation
  ): { replay: true; value: unknown } | { replay: false } {
    const namespace = operationNamespace(operation)
    const table = operation === 'decide' ? 'remote_targets' : 'remote_sessions'
    const column = operation === 'decide' ? 'remote_target_id' : 'remote_session_id'
    const at = this.timestamp()
    return this.database
      .transaction(() => {
        const previous = this.database
          .prepare(
            `SELECT request_hash, result_json FROM idempotency_results
             WHERE namespace = ? AND epoch = ? AND idempotency_key = ?`
          )
          .get(namespace, LEGACY_EPOCH, mutation.idempotencyKey) as
          { request_hash: string; result_json: string | null } | undefined
        if (previous) {
          if (previous.request_hash !== mutation.requestHash) {
            throw new RemoteCatalogError(
              'idempotency_conflict',
              'Idempotency key has another request'
            )
          }
          if (previous.result_json === null || previous.result_json === PENDING_OPERATION) {
            throw new RemoteCatalogError('result_expired', 'Remote operation result is unavailable')
          }
          return { replay: true as const, value: JSON.parse(previous.result_json) as unknown }
        }
        const row = this.database
          .prepare(`SELECT revision FROM ${table} WHERE ${column} = ?`)
          .get(id) as { revision: number } | undefined
        if (!row) {
          throw new RemoteCatalogError(
            operation === 'decide' ? 'target_not_found' : 'session_not_found',
            'Remote operation target does not exist'
          )
        }
        const deletion =
          operation === 'decide'
            ? this.database
                .prepare('SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?')
                .get(id)
            : this.database
                .prepare(
                  `SELECT 1 FROM remote_target_deletions WHERE remote_target_id =
                 (SELECT remote_target_id FROM remote_sessions WHERE remote_session_id = ?)`
                )
                .get(id)
        if (deletion) {
          throw new RemoteCatalogError('invalid_state', 'Remote target deletion is pending')
        }
        if (row.revision !== mutation.expectedRevision) {
          throw new RemoteCatalogError('stale_revision', 'Remote operation revision changed')
        }
        this.database
          .prepare(
            `INSERT INTO idempotency_results
             (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            namespace,
            LEGACY_EPOCH,
            mutation.idempotencyKey,
            mutation.requestHash,
            PENDING_OPERATION,
            at
          )
        return { replay: false as const }
      })
      .immediate()
  }

  public completeHostKeyOperation(
    operation: HostKeyOperation,
    mutation: RemoteOperationMutation,
    result: unknown
  ): void {
    const serialized = this.serializeResult(result)
    const changed = this.database
      .prepare(
        `UPDATE idempotency_results SET result_json = ?, completed_at_ms = ?
         WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?
           AND result_json = ?`
      )
      .run(
        serialized,
        this.timestamp(),
        operationNamespace(operation),
        LEGACY_EPOCH,
        mutation.idempotencyKey,
        mutation.requestHash,
        PENDING_OPERATION
      ).changes
    if (changed !== 1) {
      throw new RemoteCatalogError('stale_revision', 'Remote operation reservation changed')
    }
  }

  public commitHostKeyDecision(
    targetId: string,
    mutation: RemoteOperationMutation,
    decision: 'reject' | 'trust',
    result: unknown
  ): void {
    const serialized = this.serializeResult(result)
    const at = this.timestamp()
    this.database
      .transaction(() => {
        const changed = this.database
          .prepare(
            `UPDATE remote_targets SET
               host_key_state = CASE WHEN ? = 'trust' THEN 'trusted' ELSE host_key_state END,
               known_hosts_version = known_hosts_version + CASE WHEN ? = 'trust' THEN 1 ELSE 0 END,
               revision = revision + 1, updated_at_ms = ?
             WHERE remote_target_id = ? AND revision = ?
               AND revision < ? AND (? = 'reject' OR known_hosts_version < ?)`
          )
          .run(
            decision,
            decision,
            at,
            targetId,
            mutation.expectedRevision,
            MAX_SAFE_INTEGER,
            decision,
            MAX_SAFE_INTEGER
          ).changes
        if (changed !== 1) {
          throw new RemoteCatalogError('stale_revision', 'Remote target revision changed')
        }
        const completed = this.database
          .prepare(
            `UPDATE idempotency_results SET result_json = ?, completed_at_ms = ?
             WHERE namespace = 'remote.hostKey.decide' AND epoch = ? AND idempotency_key = ?
               AND request_hash = ? AND result_json = ?`
          )
          .run(
            serialized,
            at,
            LEGACY_EPOCH,
            mutation.idempotencyKey,
            mutation.requestHash,
            PENDING_OPERATION
          ).changes
        if (completed !== 1) {
          throw new RemoteCatalogError('stale_revision', 'Remote trust reservation changed')
        }
      })
      .immediate()
  }

  private serializeResult(result: unknown): string {
    const serialized = JSON.stringify(result)
    if (!serialized || Buffer.byteLength(serialized) > 64 * 1024) {
      throw new RemoteCatalogError('invalid_state', 'Remote operation result is invalid')
    }
    return serialized
  }

  /** A deleted live target must never reuse an inherited Rust credential locator. */
  private hasLiveCredentialHistory(targetId: string): boolean {
    const table = this.database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_live_credential_origins'"
      )
      .get()
    if (!table) return false
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?')
        .get(targetId)
    )
  }

  private timestamp(): number {
    const at = this.now()
    if (!Number.isSafeInteger(at) || at < 0)
      throw new Error('Remote operation timestamp is invalid')
    return at
  }
}
