import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'

import Database from 'better-sqlite3'

import {
  COMMAND_CATALOG,
  durableApplicationStateSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'
import { readLegacySnapshotConnection } from './legacy-state-reader'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_SAFE = Number.MAX_SAFE_INTEGER
const RESULT_RETENTION = 256
const TOMBSTONE_CAP = 65_536
const COMMAND_IDS = new Set<string>(COMMAND_CATALOG.map(([id]) => id))
const SHORTCUT_KEYS = new Set([
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Minus',
  'Equal',
  'Backquote'
])

type NotificationSettings = DurableApplicationState['notificationSettings']
type Overrides = DurableApplicationState['shortcutOverrides']
export type ShortcutPlatform = 'mac' | 'nonMac'

export interface SettingsMutationIdentity {
  expectedRevision: number
  idempotencyEpoch: string
  idempotencyKey: string
}
export interface SettingsUpdateRequest {
  windowId: string
  update: {
    shortcutOverrides?: Array<{ commandId: string; shortcut: string | null }>
    notifications?: NotificationSettings
  }
  mutation: SettingsMutationIdentity
}
export interface SettingsResetKeyRequest {
  windowId: string
  commandId: string
  mutation: SettingsMutationIdentity
}
export interface SettingsMutationResult {
  revision: number
  replayed: boolean
}
export class SettingsMutationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_params'
      | 'unauthorized'
      | 'stale_revision'
      | 'idempotency_conflict'
      | 'epoch_expired'
      | 'result_expired'
      | 'resource_limit'
      | 'invalid_state'
      | 'shortcut_conflict'
      | 'runtime_unavailable',
    message: string
  ) {
    super(message)
    this.name = 'SettingsMutationError'
  }
}

function fail(code: SettingsMutationError['code'], message: string): never {
  throw new SettingsMutationError(code, message)
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}
function safe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function canonicalShortcut(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128 || value !== value.trim()) return false
  const parts = value.split('+')
  if (parts.length < 2) return false
  const order = ['Primary', 'Secondary', 'Control', 'Shift']
  const modifiers = parts.slice(0, -1)
  if (
    modifiers.some(
      (part, index) =>
        !order.includes(part) ||
        (index > 0 && order.indexOf(part) <= order.indexOf(modifiers[index - 1]!))
    )
  )
    return false
  const key = parts.at(-1) ?? ''
  return /^[A-Z0-9]$/u.test(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key) || SHORTCUT_KEYS.has(key)
}
function physicalShortcut(value: string, platform: ShortcutPlatform): string {
  const tokens = value
    .split('+')
    .map((part) =>
      part === 'Primary'
        ? platform === 'mac'
          ? 'META'
          : 'CONTROL'
        : part === 'Control'
          ? 'CONTROL'
          : part === 'Secondary'
            ? 'ALT'
            : part === 'Shift'
              ? 'SHIFT'
              : part.toUpperCase()
    )
  return [...new Set(tokens)].sort().join('+')
}
export function validateEffectiveShortcuts(overrides: Overrides, platform: ShortcutPlatform): void {
  const effective = new Map<string, string>(COMMAND_CATALOG)
  for (const [commandId, value] of Object.entries(overrides)) {
    if (
      !/^[A-Za-z0-9._-]{1,128}$/u.test(commandId) ||
      (value !== null && !canonicalShortcut(value))
    ) {
      fail('invalid_state', 'Stored shortcut override is invalid')
    }
    if (value === null) effective.delete(commandId)
    else effective.set(commandId, value)
  }
  const used = new Map<string, string>()
  for (const [commandId, shortcut] of effective) {
    const physical = physicalShortcut(shortcut, platform)
    const first = used.get(physical)
    if (first !== undefined && first !== commandId) {
      fail('shortcut_conflict', `Shortcut conflicts between ${first} and ${commandId}`)
    }
    used.set(physical, commandId)
  }
}
function validateUpdate(update: SettingsUpdateRequest['update']): void {
  if (
    !update ||
    (update.shortcutOverrides === undefined && update.notifications === undefined) ||
    Object.keys(update).some((key) => !['shortcutOverrides', 'notifications'].includes(key))
  ) {
    fail('invalid_params', 'Settings update is invalid')
  }
  if (update.shortcutOverrides !== undefined) {
    if (!Array.isArray(update.shortcutOverrides))
      fail('invalid_params', 'Shortcut overrides are invalid')
    const seen = new Set<string>()
    for (const item of update.shortcutOverrides) {
      if (
        !item ||
        !COMMAND_IDS.has(item.commandId) ||
        seen.has(item.commandId) ||
        (item.shortcut !== null && !canonicalShortcut(item.shortcut)) ||
        Object.keys(item).some((key) => !['commandId', 'shortcut'].includes(key))
      ) {
        fail('invalid_params', 'Shortcut override is invalid or repeated')
      }
      seen.add(item.commandId)
    }
  }
  if (
    update.notifications !== undefined &&
    (!update.notifications ||
      typeof update.notifications.systemEnabled !== 'boolean' ||
      typeof update.notifications.includeBody !== 'boolean' ||
      Object.keys(update.notifications).some(
        (key) => !['systemEnabled', 'includeBody'].includes(key)
      ))
  ) {
    fail('invalid_params', 'Notification settings are invalid')
  }
}

/** Snapshot-backed settings updates on one isolated Rust schema-v15 working copy. */
export class SettingsMutations {
  private readonly database: Database.Database

  constructor(
    databasePath: string,
    private readonly platform: ShortcutPlatform
  ) {
    if (platform !== 'mac' && platform !== 'nonMac')
      fail('invalid_params', 'Shortcut platform is invalid')
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      let file: ReturnType<typeof lstatSync>
      try {
        file = lstatSync(path)
      } catch (error) {
        if (path !== databasePath && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        fail('runtime_unavailable', 'Settings database is unavailable')
      }
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
        fail('runtime_unavailable', 'Settings database must be a private regular file')
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

  update(input: SettingsUpdateRequest): SettingsMutationResult {
    if (!input || !validId(input.windowId)) fail('invalid_params', 'Window ID is invalid')
    validateUpdate(input.update)
    return this.commit(
      'node.settings.update',
      input.windowId,
      input.mutation,
      input.update,
      (state) => {
        const shortcuts: Overrides = { ...state.shortcutOverrides }
        for (const item of input.update.shortcutOverrides ?? []) {
          shortcuts[item.commandId] = item.shortcut
        }
        const notifications = input.update.notifications ?? state.notificationSettings
        const shortcutsChanged =
          Object.keys(shortcuts).length !== Object.keys(state.shortcutOverrides).length ||
          Object.entries(shortcuts).some(
            ([key, value]) =>
              !Object.hasOwn(state.shortcutOverrides, key) || state.shortcutOverrides[key] !== value
          )
        const notificationsChanged =
          notifications.systemEnabled !== state.notificationSettings.systemEnabled ||
          notifications.includeBody !== state.notificationSettings.includeBody
        if (!shortcutsChanged && !notificationsChanged)
          fail('invalid_state', 'Settings are unchanged')
        validateEffectiveShortcuts(shortcuts, this.platform)
        return { ...state, shortcutOverrides: shortcuts, notificationSettings: notifications }
      }
    )
  }

  resetKey(input: SettingsResetKeyRequest): SettingsMutationResult {
    if (!input || !validId(input.windowId) || !COMMAND_IDS.has(input.commandId)) {
      fail('invalid_params', 'Settings reset key is invalid')
    }
    return this.commit(
      'node.settings.resetKey',
      input.windowId,
      input.mutation,
      { commandId: input.commandId },
      (state) => {
        if (!Object.hasOwn(state.shortcutOverrides, input.commandId)) {
          fail('invalid_state', 'Shortcut is already at its default')
        }
        const shortcuts: Overrides = { ...state.shortcutOverrides }
        delete shortcuts[input.commandId]
        validateEffectiveShortcuts(shortcuts, this.platform)
        return { ...state, shortcutOverrides: shortcuts }
      }
    )
  }

  private commit(
    namespace: string,
    windowId: string,
    mutation: SettingsMutationIdentity,
    payload: object,
    change: (state: DurableApplicationState) => DurableApplicationState
  ): SettingsMutationResult {
    if (
      !mutation ||
      !safe(mutation.expectedRevision) ||
      !validId(mutation.idempotencyEpoch) ||
      !validId(mutation.idempotencyKey)
    )
      fail('invalid_params', 'Mutation identity is invalid')
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          expectedRevision: mutation.expectedRevision,
          payload: { windowId, ...payload }
        })
      )
      .digest('hex')
    return this.database
      .transaction(() => {
        const epoch = this.database
          .prepare('SELECT epoch FROM idempotency_epoch WHERE singleton = 1')
          .get() as { epoch: string } | undefined
        if (!epoch || mutation.idempotencyEpoch !== epoch.epoch) {
          fail('epoch_expired', 'Idempotency epoch changed')
        }
        const state = readLegacySnapshotConnection(this.database)
        if (!state.windowPlacements.some((placement) => placement.id === windowId)) {
          fail('unauthorized', 'Window placement is unavailable')
        }
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
          let result: SettingsMutationResult
          try {
            result = JSON.parse(stored.result_json) as SettingsMutationResult
          } catch {
            fail('invalid_state', 'Stored settings result is invalid')
          }
          if (!result || !safe(result.revision) || typeof result.replayed !== 'boolean') {
            fail('invalid_state', 'Stored settings result is invalid')
          }
          return { revision: result.revision, replayed: true }
        }
        const count = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM idempotency_results
        WHERE namespace = ? AND epoch = ?`
          )
          .get(namespace, mutation.idempotencyEpoch) as { count: number }
        if (count.count >= TOMBSTONE_CAP)
          fail('resource_limit', 'Settings mutation capacity reached')
        if (state.revision !== mutation.expectedRevision)
          fail('stale_revision', 'Application revision changed')
        if (state.revision === MAX_SAFE) fail('resource_limit', 'Application revision exhausted')
        const next = durableApplicationStateSchema.parse({
          ...change(state),
          revision: state.revision + 1
        })
        const changed = this.database
          .prepare(
            `UPDATE application_snapshot SET revision = ?,
        json_payload = ?, saved_at_ms = ? WHERE singleton = 1 AND revision = ?`
          )
          .run(String(next.revision), JSON.stringify(next), Date.now(), String(state.revision))
        if (changed.changes !== 1)
          fail('stale_revision', 'Application revision changed during write')
        const result: SettingsMutationResult = { revision: next.revision, replayed: false }
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
            JSON.stringify(result),
            Date.now()
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
  }
}
