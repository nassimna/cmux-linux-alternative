import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'

import Database from 'better-sqlite3'
import {
  attentionAcknowledgementParamsSchema,
  attentionAcknowledgementResultSchema,
  type AttentionAcknowledgementParams,
  type AttentionAcknowledgementResult
} from '@agent-workspace/protocol-client'

import {
  durableApplicationStateSchema,
  notificationPublishParamsSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'
import { readLegacySnapshotConnection } from './legacy-state-reader'
import { CardSlotAttentionError, type CardSlotAttentionService } from '../domain/card-slot-attention'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_SAFE = Number.MAX_SAFE_INTEGER
const RESULT_RETENTION = 256
const TOMBSTONE_CAP = 65_536
const LEGACY_IDEMPOTENCY_EPOCH = '00000000-0000-0000-0000-000000000001'

type DurableNotification = DurableApplicationState['notifications'][number]

export interface NotificationIdentity {
  expectedRevision: number
  idempotencyEpoch: string
  idempotencyKey: string
}
export interface NotificationPageRequest {
  windowId: string
  workspaceId?: string
  unreadOnly?: boolean
  offset?: number
  limit?: number
}
export interface NotificationWriteRequest {
  windowId: string
  notificationId: string
  mutation: NotificationIdentity
}
export interface NotificationPublishRequest {
  windowId: string
  target: { workspaceId: string; paneId?: string; tabId?: string }
  source: DurableNotification['source']
  level: DurableNotification['level']
  title: string
  body?: string
  mutation: NotificationIdentity
}
export interface NotificationClearRequest {
  windowId: string
  scope: { kind: 'notification'; notificationId: string } | { kind: 'read' | 'all' }
  mutation: NotificationIdentity
}
export interface NotificationView {
  id: string
  workspaceId: string
  paneId?: string
  tabId?: string
  source: DurableNotification['source']
  level: DurableNotification['level']
  title: string
  body?: string
  createdAt: number
  readAt?: number
}
export interface NotificationPage {
  revision: number
  notifications: NotificationView[]
  total: number
  unreadCount: number
}
export interface NotificationChange {
  revision: number
  replayed: boolean
  changedIds: string[]
}
export class NotificationMutationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_params'
      | 'target_not_found'
      | 'unauthorized'
      | 'stale_revision'
      | 'idempotency_conflict'
      | 'epoch_expired'
      | 'result_expired'
      | 'resource_limit'
      | 'invalid_state'
      | 'runtime_unavailable',
    message: string
  ) {
    super(message)
    this.name = 'NotificationMutationError'
  }
}

function fail(code: NotificationMutationError['code'], message: string): never {
  throw new NotificationMutationError(code, message)
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}
function safe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function now(): number {
  return Date.now()
}
function view(value: DurableNotification): NotificationView {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    ...(value.paneId === null ? {} : { paneId: value.paneId }),
    ...(value.tabId === null ? {} : { tabId: value.tabId }),
    source: value.source,
    level: value.level,
    title: value.title,
    ...(value.body === null ? {} : { body: value.body }),
    createdAt: value.createdAt,
    ...(value.readAt === null ? {} : { readAt: value.readAt })
  }
}

/** Owner-scoped notification mutations against one isolated Rust schema-v15 working copy. */
export class NotificationMutations {
  private readonly database: Database.Database

  constructor(databasePath: string, private readonly afterChange?: () => void) {
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      let file: ReturnType<typeof lstatSync>
      try {
        file = lstatSync(path)
      } catch (error) {
        if (path !== databasePath && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        fail('runtime_unavailable', 'Notification database is unavailable')
      }
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
        fail('runtime_unavailable', 'Notification database must be a private regular file')
      }
    }
    this.database = new Database(databasePath, { fileMustExist: true, timeout: 5_000 })
    try {
      readLegacySnapshotConnection(this.database)
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  /** Rust attention-v1 idempotency namespace, committed with the v15 snapshot. */
  acknowledgeAttention(
    params: AttentionAcknowledgementParams,
    attention: CardSlotAttentionService
  ): AttentionAcknowledgementResult {
    const input = attentionAcknowledgementParamsSchema.parse(params)
    // Rust serializes this struct in declaration order and stores the JSON itself as request_hash.
    const requestJson = JSON.stringify({
      notificationId: input.notificationId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      mode: input.mode
    })
    const result = this.database.transaction(() => {
      const stored = this.database.prepare(
        `SELECT request_hash,result_json FROM idempotency_results
         WHERE namespace='attention-v1' AND epoch=? AND idempotency_key=?`
      ).get(LEGACY_IDEMPOTENCY_EPOCH, input.idempotencyKey) as
        { request_hash: string; result_json: string | null } | undefined
      if (stored) {
        if (stored.request_hash !== requestJson || stored.result_json === null) {
          throw new CardSlotAttentionError('idempotency_conflict', 'The idempotency key was already used for another acknowledgement')
        }
        return attentionAcknowledgementResultSchema.parse(JSON.parse(stored.result_json)) as AttentionAcknowledgementResult
      }
      const state = readLegacySnapshotConnection(this.database)
      const prepared = attention.prepareAcknowledgement(input)
      if (state.revision !== prepared.expectedApplicationRevision) {
        throw new CardSlotAttentionError('revision_conflict', 'The application revision changed before acknowledgement')
      }
      if (state.revision >= MAX_SAFE) {
        throw new CardSlotAttentionError('revision_out_of_range', 'The application revision cannot be incremented safely')
      }
      const notification = state.notifications.find((item) => item.id === input.notificationId)!
      const next = durableApplicationStateSchema.parse({
        ...state,
        revision: state.revision + 1,
        notifications: state.notifications.map((item) => item.id === notification.id
          ? { ...item, readAt: Math.max(Date.now(), item.createdAt) }
          : item)
      })
      const projected = attention.projectAcknowledged(next, prepared.workspaceId)
      const updated = this.database.prepare(
        `UPDATE application_snapshot SET revision=?,json_payload=?,saved_at_ms=?
         WHERE singleton=1 AND revision=?`
      ).run(String(next.revision), JSON.stringify(next), Date.now(), String(state.revision))
      if (updated.changes !== 1) {
        throw new CardSlotAttentionError('revision_conflict', 'The application revision changed before acknowledgement')
      }
      this.database.prepare(
        `INSERT INTO idempotency_results
         (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
         VALUES ('attention-v1',?,?,?,?,?)`
      ).run(LEGACY_IDEMPOTENCY_EPOCH, input.idempotencyKey, requestJson, JSON.stringify(projected), Date.now())
      this.database.prepare(
        `UPDATE idempotency_results SET result_json=NULL
         WHERE namespace='attention-v1' AND epoch=? AND sequence NOT IN (
           SELECT sequence FROM idempotency_results WHERE namespace='attention-v1' AND epoch=?
           AND result_json IS NOT NULL ORDER BY sequence DESC LIMIT 4096
         )`
      ).run(LEGACY_IDEMPOTENCY_EPOCH, LEGACY_IDEMPOTENCY_EPOCH)
      return projected
    }).immediate()
    attention.refreshAttention()
    return result
  }

  private owned(state: DurableApplicationState, windowId: string): Set<string> {
    if (!validId(windowId)) fail('invalid_params', 'Window ID is invalid')
    const placement = state.windowPlacements.find((value) => value.id === windowId)
    if (!placement) fail('unauthorized', 'Window placement is unavailable')
    return new Set(placement.workspaceIds)
  }

  list(input: NotificationPageRequest): NotificationPage {
    if (
      !input ||
      !validId(input.windowId) ||
      (input.workspaceId !== undefined && !validId(input.workspaceId)) ||
      (input.unreadOnly !== undefined && typeof input.unreadOnly !== 'boolean') ||
      !safe(input.offset ?? 0) ||
      !safe(input.limit ?? 50) ||
      (input.limit ?? 50) < 1 ||
      (input.limit ?? 50) > 200
    ) {
      fail('invalid_params', 'Notification page is invalid')
    }
    return this.database
      .transaction(() => {
        const state = readLegacySnapshotConnection(this.database)
        const owned = this.owned(state, input.windowId)
        const matching = state.notifications.filter(
          (item) =>
            owned.has(item.workspaceId) &&
            (input.workspaceId === undefined || item.workspaceId === input.workspaceId) &&
            (!input.unreadOnly || item.readAt === null)
        )
        matching.sort(
          (left, right) =>
            right.createdAt - left.createdAt ||
            (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)
        )
        return {
          revision: state.revision,
          notifications: matching
            .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50))
            .map(view),
          total: matching.length,
          unreadCount: matching.filter((item) => item.readAt === null).length
        }
      })
      .deferred()
  }

  markRead(input: NotificationWriteRequest): NotificationChange {
    this.validateWrite(input)
    return this.commit(
      'node.notification.markRead',
      input.mutation,
      { windowId: input.windowId, notificationId: input.notificationId },
      (state, owned) => {
        const notification = this.requireOwnedNotification(state, owned, input.notificationId)
        if (notification.readAt !== null) fail('invalid_state', 'Notification is already read')
        return {
          notifications: state.notifications.map((item) =>
            item.id === notification.id
              ? { ...item, readAt: Math.max(now(), item.createdAt) }
              : item
          ),
          changedIds: [notification.id],
          workspaceIds: [notification.workspaceId]
        }
      },
      input.windowId
    )
  }

  publish(input: NotificationPublishRequest): NotificationChange {
    if (!input || !validId(input.windowId)) fail('invalid_params', 'Window ID is invalid')
    const parsed = notificationPublishParamsSchema.safeParse({
      target: input.target,
      source: input.source,
      level: input.level,
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body })
    })
    if (!parsed.success) fail('invalid_params', 'Notification is invalid')
    return this.commit('node.notification.publish', input.mutation,
      { windowId: input.windowId, notification: parsed.data },
      (state, owned) => {
        const { target } = parsed.data
        if (!owned.has(target.workspaceId)) {
          fail('unauthorized', 'Notification target is outside the window')
        }
        const workspace = state.workspaces.find((item) => item.id === target.workspaceId)
        if (!workspace || (target.paneId !== undefined && !workspace.panes[target.paneId])) {
          fail('target_not_found', 'Notification target is unavailable')
        }
        const tab = target.tabId === undefined ? undefined : workspace.tabs[target.tabId]
        if (target.tabId !== undefined && (!tab ||
          (target.paneId !== undefined && tab.paneId !== target.paneId))) {
          fail('target_not_found', 'Notification tab binding is unavailable')
        }
        const timestamp = now()
        if (!safe(timestamp)) fail('invalid_state', 'Notification timestamp is invalid')
        const notification: DurableNotification = {
          id: randomUUID(),
          workspaceId: target.workspaceId,
          paneId: target.paneId ?? null,
          tabId: target.tabId ?? null,
          source: parsed.data.source,
          level: parsed.data.level,
          title: parsed.data.title,
          body: parsed.data.body ?? null,
          createdAt: timestamp,
          readAt: null
        }
        const notifications = [...state.notifications, notification]
        while (notifications.length > 1_000) {
          let oldest = 0
          for (let index = 1; index < notifications.length; index += 1) {
            const current = notifications[index]!
            const candidate = notifications[oldest]!
            if (current.createdAt < candidate.createdAt ||
              (current.createdAt === candidate.createdAt && current.id < candidate.id)) {
              oldest = index
            }
          }
          notifications.splice(oldest, 1)
        }
        return { notifications, changedIds: [notification.id], workspaceIds: [target.workspaceId] }
      }, input.windowId)
  }

  markUnread(input: NotificationWriteRequest): NotificationChange {
    this.validateWrite(input)
    return this.commit(
      'node.notification.markUnread',
      input.mutation,
      { windowId: input.windowId, notificationId: input.notificationId },
      (state, owned) => {
        const notification = this.requireOwnedNotification(state, owned, input.notificationId)
        if (notification.readAt === null) fail('invalid_state', 'Notification is already unread')
        return {
          notifications: state.notifications.map((item) =>
            item.id === notification.id ? { ...item, readAt: null } : item
          ),
          changedIds: [notification.id],
          workspaceIds: [notification.workspaceId]
        }
      },
      input.windowId
    )
  }

  clear(input: NotificationClearRequest): NotificationChange {
    if (
      !input ||
      !validId(input.windowId) ||
      !input.scope ||
      !['notification', 'read', 'all'].includes(input.scope.kind) ||
      (input.scope.kind === 'notification' && !validId(input.scope.notificationId))
    ) {
      fail('invalid_params', 'Notification clear scope is invalid')
    }
    return this.commit(
      'node.notification.clear',
      input.mutation,
      { windowId: input.windowId, scope: input.scope },
      (state, owned) => {
        if (input.scope.kind === 'notification') {
          const notification = this.requireOwnedNotification(
            state,
            owned,
            input.scope.notificationId
          )
          return {
            notifications: state.notifications.filter((item) => item.id !== notification.id),
            changedIds: [notification.id],
            workspaceIds: [notification.workspaceId]
          }
        }
        const removed = state.notifications.filter(
          (item) =>
            owned.has(item.workspaceId) && (input.scope.kind === 'all' || item.readAt !== null)
        )
        if (removed.length === 0) fail('invalid_state', 'No notifications match the clear scope')
        const ids = new Set(removed.map((item) => item.id))
        return {
          notifications: state.notifications.filter((item) => !ids.has(item.id)),
          changedIds: removed.map((item) => item.id),
          workspaceIds: [...new Set(removed.map((item) => item.workspaceId))]
        }
      },
      input.windowId
    )
  }

  private validateWrite(input: NotificationWriteRequest): void {
    if (!input || !validId(input.windowId) || !validId(input.notificationId)) {
      fail('invalid_params', 'Notification identity is invalid')
    }
  }

  private requireOwnedNotification(
    state: DurableApplicationState,
    owned: Set<string>,
    id: string
  ): DurableNotification {
    const notification = state.notifications.find((item) => item.id === id)
    if (!notification) fail('target_not_found', 'Notification not found')
    if (!owned.has(notification.workspaceId))
      fail('unauthorized', 'Notification is outside the window')
    return notification
  }

  private validateMutation(mutation: NotificationIdentity): void {
    if (
      !mutation ||
      !safe(mutation.expectedRevision) ||
      !validId(mutation.idempotencyEpoch) ||
      !validId(mutation.idempotencyKey)
    )
      fail('invalid_params', 'Mutation identity is invalid')
  }

  private commit(
    namespace: string,
    mutation: NotificationIdentity,
    payload: object,
    mutate: (
      state: DurableApplicationState,
      owned: Set<string>
    ) => { notifications: DurableNotification[]; changedIds: string[]; workspaceIds: string[] },
    windowId: string
  ): NotificationChange {
    this.validateMutation(mutation)
    const hash = createHash('sha256')
      .update(JSON.stringify({ expectedRevision: mutation.expectedRevision, payload }))
      .digest('hex')
    const result = this.database
      .transaction(() => {
        const epoch = this.database
          .prepare('SELECT epoch FROM idempotency_epoch WHERE singleton = 1')
          .get() as { epoch: string } | undefined
        if (!epoch || mutation.idempotencyEpoch !== epoch.epoch) {
          fail('epoch_expired', 'Idempotency epoch changed')
        }
        const state = readLegacySnapshotConnection(this.database)
        const owned = this.owned(state, windowId)
        const stored = this.database
          .prepare(
            `SELECT request_hash,result_json FROM idempotency_results
        WHERE namespace = ? AND epoch = ? AND idempotency_key = ?`
          )
          .get(namespace, mutation.idempotencyEpoch, mutation.idempotencyKey) as
          { request_hash: string; result_json: string | null } | undefined
        if (stored) {
          if (stored.request_hash !== hash) fail('idempotency_conflict', 'Mutation key was reused')
          if (stored.result_json === null) fail('result_expired', 'Mutation result expired')
          let recorded: { result: NotificationChange; workspaceIds: string[] }
          try {
            recorded = JSON.parse(stored.result_json) as typeof recorded
          } catch {
            fail('invalid_state', 'Stored notification result is invalid')
          }
          if (
            !recorded ||
            !Array.isArray(recorded.workspaceIds) ||
            !recorded.workspaceIds.every((id) => validId(id) && owned.has(id)) ||
            !recorded.result ||
            !safe(recorded.result.revision) ||
            !Array.isArray(recorded.result.changedIds)
          ) {
            fail('unauthorized', 'Notification ownership changed')
          }
          return { ...recorded.result, replayed: true }
        }
        const capacity = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM idempotency_results
        WHERE namespace = ? AND epoch = ?`
          )
          .get(namespace, mutation.idempotencyEpoch) as { count: number }
        if (capacity.count >= TOMBSTONE_CAP)
          fail('resource_limit', 'Notification mutation capacity reached')
        if (state.revision !== mutation.expectedRevision)
          fail('stale_revision', 'Application revision changed')
        if (state.revision === MAX_SAFE) fail('resource_limit', 'Application revision exhausted')
        const changed = mutate(state, owned)
        const next = durableApplicationStateSchema.parse({
          ...state,
          revision: state.revision + 1,
          notifications: changed.notifications
        })
        const updated = this.database
          .prepare(
            `UPDATE application_snapshot SET revision = ?,
        json_payload = ?, saved_at_ms = ? WHERE singleton = 1 AND revision = ?`
          )
          .run(String(next.revision), JSON.stringify(next), now(), String(state.revision))
        if (updated.changes !== 1)
          fail('stale_revision', 'Application revision changed during write')
        const result: NotificationChange = {
          revision: next.revision,
          replayed: false,
          changedIds: changed.changedIds
        }
        this.database
          .prepare(
            `INSERT INTO idempotency_results
        (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
        VALUES (?,?,?,?,?,?)`
          )
          .run(
            namespace,
            mutation.idempotencyEpoch,
            mutation.idempotencyKey,
            hash,
            JSON.stringify({ result, workspaceIds: changed.workspaceIds }),
            now()
          )
        this.database
          .prepare(
            `UPDATE idempotency_results SET result_json = NULL
        WHERE namespace = ? AND epoch = ? AND sequence NOT IN (
          SELECT sequence FROM idempotency_results WHERE namespace = ? AND epoch = ?
          AND result_json IS NOT NULL ORDER BY completed_at_ms DESC, sequence DESC LIMIT ?
        )`
          )
          .run(
            namespace,
            mutation.idempotencyEpoch,
            namespace,
            mutation.idempotencyEpoch,
            RESULT_RETENTION
          )
        return result
      })
      .immediate()
    this.afterChange?.()
    return result
  }
}
