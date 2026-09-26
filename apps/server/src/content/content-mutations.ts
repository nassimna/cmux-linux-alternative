import { lstatSync } from 'node:fs'

import Database from 'better-sqlite3'

import { readLegacySnapshotConnection } from '../persistence/legacy-state-reader'
import type { SidebarPlacement, TextBoxDocument } from './content-catalog'

const EPOCH = '00000000-0000-0000-0000-000000000001'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const HASH = /^[0-9a-f]{64}$/u
const SURFACES = [
  'textBox', 'vault', 'taskManager', 'files', 'markdown', 'diff', 'search', 'recentlyClosed'
] as const
const MAX_SAFE = Number.MAX_SAFE_INTEGER

export type ContentMutationCode =
  | 'invalid_params' | 'target_not_found' | 'unauthorized' | 'stale_revision'
  | 'idempotency_conflict' | 'resource_limit' | 'runtime_unavailable'

export class ContentMutationError extends Error {
  constructor(public readonly code: ContentMutationCode, message: string) {
    super(message)
    this.name = 'ContentMutationError'
  }
}

export interface MutationIdentity {
  idempotencyKey: string
  requestHash: string
  expectedRevision: number
}

export interface TextBoxCreate {
  textBoxDocumentId: string
  workspaceId: string
  windowId: string
  title: string
  text: string
  mutation: MutationIdentity
}

export interface TextBoxSave {
  textBoxDocumentId: string
  expectedRevision: number
  title: string
  text: string
  mutation: MutationIdentity
}

export interface TextBoxDelete {
  textBoxDocumentId: string
  expectedRevision: number
  mutation: MutationIdentity
}

export interface ContentMutationOptions {
  /** Optional stricter owner gate; the durable snapshot binding is always required. */
  authorize?: (binding: { windowId: string; workspaceId?: string }) => boolean
}

type DocumentRow = {
  text_box_document_id: string
  workspace_id: string
  window_id: string
  title: string
  text_content: string
  content_revision: number
  created_at_ms: number
  updated_at_ms: number
}

function fail(code: ContentMutationCode, message: string): never {
  throw new ContentMutationError(code, message)
}

function safe(value: unknown, positive = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
}

function mutationValid(mutation: MutationIdentity): void {
  if (!mutation || !UUID.test(mutation.idempotencyKey) || !HASH.test(mutation.requestHash) ||
    !safe(mutation.expectedRevision)) fail('invalid_params', 'Invalid mutation identity')
}

function textValid(title: string, value: string): void {
  if (typeof title !== 'string' || title.trim().length === 0 || [...title].length > 120 ||
    /\p{Cc}/u.test(title) || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 262_144) {
    fail('invalid_params', 'Invalid TextBox content')
  }
}

function documentFromRow(row: DocumentRow): TextBoxDocument {
  return {
    textBoxDocumentId: row.text_box_document_id,
    workspaceId: row.workspace_id,
    windowId: row.window_id,
    title: row.title,
    text: row.text_content,
    contentRevision: row.content_revision,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
}

function now(): number {
  return Date.now()
}

/** Schema-v15 sidebar writes bound to the durable window snapshot. */
export class ContentMutations {
  private readonly database: Database.Database
  private readonly authorize: ContentMutationOptions['authorize']

  constructor(databasePath: string, options: ContentMutationOptions = {}) {
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      let file: ReturnType<typeof lstatSync>
      try { file = lstatSync(path) } catch (error) {
        if (path !== databasePath && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        fail('runtime_unavailable', 'Content database is unavailable')
      }
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
        fail('runtime_unavailable', 'Content database must be a private regular file')
      }
    }
    this.database = new Database(databasePath, { fileMustExist: true, timeout: 5_000 })
    this.authorize = options.authorize
    try {
      if (this.database.pragma('user_version', { simple: true }) !== 15) {
        fail('runtime_unavailable', 'Content database requires Rust schema-v15')
      }
      // The snapshot is the durable binding; current ownership is checked again per write.
      readLegacySnapshotConnection(this.database)
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void { this.database.close() }

  private owned(windowId: string, workspaceId?: string): void {
    const snapshot = readLegacySnapshotConnection(this.database)
    const present = snapshot.windowPlacements.some((window) =>
      window.id === windowId && (workspaceId === undefined || window.workspaceIds.includes(workspaceId)))
    if (!present) {
      fail(workspaceId === undefined ? 'target_not_found' : 'unauthorized', 'Window ownership changed')
    }
    if (this.authorize && !this.authorize(workspaceId === undefined ? { windowId } : { windowId, workspaceId })) {
      fail('unauthorized', 'Window ownership is not authorized')
    }
  }

  private replay<T>(namespace: string, mutation: MutationIdentity): T | undefined {
    const row = this.database.prepare(
      'SELECT request_hash, result_json FROM idempotency_results WHERE namespace=? AND epoch=? AND idempotency_key=?'
    ).get(namespace, EPOCH, mutation.idempotencyKey) as
      | { request_hash: string; result_json: string | null } | undefined
    if (!row) return undefined
    if (row.request_hash !== mutation.requestHash || row.result_json === null) {
      fail('idempotency_conflict', 'Idempotency key conflicts with a prior request')
    }
    try { return JSON.parse(row.result_json) as T } catch {
      fail('runtime_unavailable', 'Stored mutation result is invalid')
    }
  }

  private result(namespace: string, mutation: MutationIdentity, value: unknown, timestamp: number): void {
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json, 'utf8') > 262_144) fail('resource_limit', 'Mutation result is too large')
    this.database.prepare(
      'INSERT INTO idempotency_results(namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms) VALUES(?,?,?,?,?,?)'
    ).run(namespace, EPOCH, mutation.idempotencyKey, mutation.requestHash, json, timestamp)
  }

  private row(id: string): DocumentRow | undefined {
    return this.database.prepare(
      'SELECT text_box_document_id,workspace_id,window_id,title,text_content,content_revision,created_at_ms,updated_at_ms FROM text_box_documents WHERE text_box_document_id=?'
    ).get(id) as DocumentRow | undefined
  }

  saveSidebarPlacement(params: { placement: SidebarPlacement; mutation: MutationIdentity }): SidebarPlacement {
    const { placement, mutation } = params
    mutationValid(mutation)
    if (!placement || !UUID.test(placement.windowId) || !safe(placement.revision, true) ||
      placement.revision !== mutation.expectedRevision + 1 ||
      !['left', 'right'].includes(placement.side) || !Number.isInteger(placement.width) ||
      placement.width < 240 || placement.width > 720 ||
      !Array.isArray(placement.enabled) || !Array.isArray(placement.order) ||
      placement.order.length !== SURFACES.length ||
      new Set(placement.order).size !== SURFACES.length ||
      new Set(placement.enabled).size !== placement.enabled.length ||
      !placement.order.every((value) => SURFACES.includes(value)) ||
      !placement.enabled.every((value) => SURFACES.includes(value)) ||
      !SURFACES.every((value) => placement.order.includes(value)) ||
      !placement.enabled.includes(placement.selected)) fail('invalid_params', 'Invalid sidebar placement')
    return this.database.transaction(() => {
      this.owned(placement.windowId)
      const replay = this.replay<SidebarPlacement>('sidebar.placement.save', mutation)
      if (replay !== undefined) {
        if (replay.windowId !== placement.windowId) fail('idempotency_conflict', 'Mutation target changed')
        return replay
      }
      const current = this.database.prepare('SELECT revision FROM sidebar_placements WHERE window_id=?')
        .get(placement.windowId) as { revision: number } | undefined
      if (current && current.revision !== mutation.expectedRevision) fail('stale_revision', 'The durable revision changed')
      if (!current && mutation.expectedRevision !== 0) fail('target_not_found', 'Sidebar placement not found')
      if (!current) {
        const count = this.database.prepare('SELECT count(*) AS count FROM sidebar_placements').get() as { count: number }
        if (count.count >= 16) fail('resource_limit', 'The durable catalog reached its bound')
      }
      const timestamp = now()
      this.database.prepare(
        'INSERT INTO sidebar_placements(window_id,revision,side,width,enabled_json,order_json,selected,updated_at_ms) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(window_id) DO UPDATE SET revision=excluded.revision,side=excluded.side,width=excluded.width,enabled_json=excluded.enabled_json,order_json=excluded.order_json,selected=excluded.selected,updated_at_ms=excluded.updated_at_ms'
      ).run(placement.windowId, placement.revision, placement.side, placement.width,
        JSON.stringify(placement.enabled), JSON.stringify(placement.order), placement.selected, timestamp)
      this.result('sidebar.placement.save', mutation, placement, timestamp)
      return placement
    }).immediate()
  }

  createTextBox(params: TextBoxCreate): TextBoxDocument {
    mutationValid(params.mutation)
    if (![params.textBoxDocumentId, params.workspaceId, params.windowId].every((id) => typeof id === 'string' && UUID.test(id))) {
      fail('invalid_params', 'Invalid TextBox identity')
    }
    textValid(params.title, params.text)
    if (params.mutation.expectedRevision !== 0) fail('stale_revision', 'The durable revision changed')
    return this.database.transaction(() => {
      this.owned(params.windowId, params.workspaceId)
      const replay = this.replay<TextBoxDocument>('textbox.create', params.mutation)
      if (replay !== undefined) {
        if (replay.textBoxDocumentId !== params.textBoxDocumentId ||
          replay.workspaceId !== params.workspaceId || replay.windowId !== params.windowId) {
          fail('idempotency_conflict', 'Mutation target changed')
        }
        return replay
      }
      if (this.row(params.textBoxDocumentId)) fail('idempotency_conflict', 'TextBox identity already exists')
      const count = this.database.prepare('SELECT count(*) AS count FROM text_box_documents').get() as { count: number }
      if (count.count >= 64) fail('resource_limit', 'The durable catalog reached its bound')
      const timestamp = now()
      const document: TextBoxDocument = {
        textBoxDocumentId: params.textBoxDocumentId, workspaceId: params.workspaceId,
        windowId: params.windowId, title: params.title, text: params.text,
        contentRevision: 1, createdAtMs: timestamp, updatedAtMs: timestamp
      }
      this.database.prepare(
        'INSERT INTO text_box_documents(text_box_document_id,workspace_id,window_id,title,text_content,content_revision,idempotency_key,request_hash,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,1,?,?,?,?)'
      ).run(document.textBoxDocumentId, document.workspaceId, document.windowId, document.title,
        document.text, params.mutation.idempotencyKey, params.mutation.requestHash, timestamp, timestamp)
      this.result('textbox.create', params.mutation, document, timestamp)
      return document
    }).immediate()
  }

  saveTextBox(params: TextBoxSave): TextBoxDocument {
    mutationValid(params.mutation)
    if (!UUID.test(params.textBoxDocumentId) || !safe(params.expectedRevision, true)) fail('invalid_params', 'Invalid TextBox identity')
    textValid(params.title, params.text)
    if (params.expectedRevision !== params.mutation.expectedRevision) fail('stale_revision', 'The durable revision changed')
    return this.database.transaction(() => {
      const current = this.row(params.textBoxDocumentId)
      if (!current) fail('target_not_found', 'TextBox not found')
      this.owned(current.window_id, current.workspace_id)
      const replay = this.replay<TextBoxDocument>('textbox.save', params.mutation)
      if (replay !== undefined) {
        if (replay.textBoxDocumentId !== params.textBoxDocumentId) fail('idempotency_conflict', 'Mutation target changed')
        return replay
      }
      if (current.content_revision !== params.expectedRevision || current.content_revision === MAX_SAFE) {
        fail('stale_revision', 'The durable revision changed')
      }
      const timestamp = Math.max(now(), current.created_at_ms)
      const document: TextBoxDocument = {
        ...documentFromRow(current), title: params.title, text: params.text,
        contentRevision: current.content_revision + 1, updatedAtMs: timestamp
      }
      this.database.prepare(
        'UPDATE text_box_documents SET title=?,text_content=?,content_revision=?,updated_at_ms=? WHERE text_box_document_id=? AND content_revision=?'
      ).run(document.title, document.text, document.contentRevision, timestamp,
        document.textBoxDocumentId, params.expectedRevision)
      this.result('textbox.save', params.mutation, document, timestamp)
      return document
    }).immediate()
  }

  deleteTextBox(params: TextBoxDelete): TextBoxDocument {
    mutationValid(params.mutation)
    if (!UUID.test(params.textBoxDocumentId) || !safe(params.expectedRevision, true)) fail('invalid_params', 'Invalid TextBox identity')
    if (params.expectedRevision !== params.mutation.expectedRevision) fail('stale_revision', 'The durable revision changed')
    return this.database.transaction(() => {
      const current = this.row(params.textBoxDocumentId)
      // A deleted document can only be replayed after its saved binding is checked.
      const replay = this.replay<TextBoxDocument>('textbox.delete', params.mutation)
      if (!current && replay === undefined) fail('target_not_found', 'TextBox not found')
      const binding = current ? documentFromRow(current) : replay!
      if (binding.textBoxDocumentId !== params.textBoxDocumentId) {
        fail('idempotency_conflict', 'Idempotency key conflicts with a prior request')
      }
      if (current && replay && (replay.windowId !== current.window_id || replay.workspaceId !== current.workspace_id)) {
        fail('idempotency_conflict', 'Mutation target changed')
      }
      this.owned(binding.windowId, binding.workspaceId)
      if (replay !== undefined) return replay
      if (current!.content_revision !== params.expectedRevision) fail('stale_revision', 'The durable revision changed')
      const document = documentFromRow(current!)
      this.database.prepare('DELETE FROM text_box_documents WHERE text_box_document_id=? AND content_revision=?')
        .run(params.textBoxDocumentId, params.expectedRevision)
      this.result('textbox.delete', params.mutation, document, now())
      return document
    }).immediate()
  }
}
