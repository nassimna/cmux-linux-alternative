import { lstatSync } from 'node:fs'

import Database from 'better-sqlite3'
import { readLegacySnapshotConnection } from '../persistence/legacy-state-reader'

const SURFACES = [
  'textBox',
  'vault',
  'taskManager',
  'files',
  'markdown',
  'diff',
  'search',
  'recentlyClosed'
] as const
type Surface = (typeof SURFACES)[number]

export interface SidebarPlacement {
  windowId: string
  revision: number
  side: 'left' | 'right'
  width: number
  enabled: Surface[]
  order: Surface[]
  selected: Surface
}

export interface TextBoxDocument {
  textBoxDocumentId: string
  workspaceId: string
  windowId: string
  title: string
  text: string
  contentRevision: number
  createdAtMs: number
  updatedAtMs: number
}

export class ContentCatalogError extends Error {
  constructor(
    public readonly code: 'invalid_params' | 'not_found' | 'corrupt_content',
    message: string
  ) {
    super(message)
    this.name = 'ContentCatalogError'
  }
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const validId = (value: string): boolean => UUID.test(value)
const validPositive = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const corrupt = (): never => {
  throw new ContentCatalogError('corrupt_content', 'Stored content is invalid')
}

type PlacementRow = {
  window_id: string
  revision: number
  side: string
  width: number
  enabled_json: string
  order_json: string
  selected: string
}
type TextBoxRow = {
  text_box_document_id: string
  workspace_id: string
  window_id: string
  title: string
  text_content: string
  content_revision: number
  created_at_ms: number
  updated_at_ms: number
}

function placementFromRow(row: PlacementRow): SidebarPlacement {
  let enabled: unknown
  let order: unknown
  try {
    enabled = JSON.parse(row.enabled_json)
    order = JSON.parse(row.order_json)
  } catch {
    return corrupt()
  }
  const isSurface = (value: unknown): value is Surface =>
    typeof value === 'string' && SURFACES.includes(value as Surface)
  if (
    !validId(row.window_id) ||
    !validPositive(row.revision) ||
    !['left', 'right'].includes(row.side) ||
    !Number.isInteger(row.width) ||
    row.width < 240 ||
    row.width > 720 ||
    !Array.isArray(enabled) ||
    !Array.isArray(order) ||
    !enabled.every(isSurface) ||
    !order.every(isSurface) ||
    order.length !== SURFACES.length ||
    new Set(enabled).size !== enabled.length ||
    new Set(order).size !== SURFACES.length ||
    !SURFACES.every((surface) => order.includes(surface)) ||
    !isSurface(row.selected) ||
    !enabled.includes(row.selected)
  )
    return corrupt()
  return {
    windowId: row.window_id,
    revision: row.revision,
    side: row.side as 'left' | 'right',
    width: row.width,
    enabled,
    order,
    selected: row.selected
  }
}

function textBoxFromRow(row: TextBoxRow): TextBoxDocument {
  if (
    ![row.text_box_document_id, row.workspace_id, row.window_id].every(validId) ||
    row.title.trim().length < 1 ||
    [...row.title].length > 120 ||
    /\p{Cc}/u.test(row.title) ||
    Buffer.byteLength(row.text_content, 'utf8') > 262_144 ||
    !validPositive(row.content_revision) ||
    !Number.isSafeInteger(row.created_at_ms) ||
    row.created_at_ms < 0 ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < row.created_at_ms
  )
    return corrupt()
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

/** Read-only schema-v15 sidebar catalog. Content and ownership share one SQLite read transaction. */
export class ContentCatalog {
  private readonly database: Database.Database

  constructor(databasePath: string) {
    const file = lstatSync(databasePath)
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
      throw new Error('Content database must be a private regular file')
    }
    this.database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000
    })
    try {
      this.database.pragma('query_only = ON')
      if (this.database.pragma('user_version', { simple: true }) !== 15) {
        throw new Error('Content catalog requires Rust schema-v15')
      }
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  listSidebarPlacements(): { placements: SidebarPlacement[] } {
    const rows = this.database
      .prepare(
        'SELECT window_id,revision,side,width,enabled_json,order_json,selected FROM sidebar_placements ORDER BY window_id'
      )
      .all() as PlacementRow[]
    if (rows.length > 16) return corrupt()
    return { placements: rows.map(placementFromRow) }
  }

  getSidebarPlacement(windowId: string): SidebarPlacement {
    if (!validId(windowId)) throw new ContentCatalogError('invalid_params', 'Invalid window ID')
    return this.database.transaction(() => {
      if (
        !readLegacySnapshotConnection(this.database).windowPlacements.some(
          (window) => window.id === windowId
        )
      ) {
        throw new ContentCatalogError('not_found', 'Window not found')
      }
      const row = this.database
        .prepare(
          'SELECT window_id,revision,side,width,enabled_json,order_json,selected FROM sidebar_placements WHERE window_id = ?'
        )
        .get(windowId) as PlacementRow | undefined
      if (!row) throw new ContentCatalogError('not_found', 'Sidebar placement not found')
      return placementFromRow(row)
    })()
  }

  listTextBoxes(params: { limit: number; cursor?: string }): {
    documents: TextBoxDocument[]
    nextCursor: string | null
  } {
    if (
      !Number.isInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > 64 ||
      (params.cursor !== undefined && !validId(params.cursor))
    ) {
      throw new ContentCatalogError('invalid_params', 'Invalid TextBox page')
    }
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          'SELECT text_box_document_id,workspace_id,window_id,title,text_content,content_revision,created_at_ms,updated_at_ms FROM text_box_documents WHERE text_box_document_id > ? ORDER BY text_box_document_id LIMIT ?'
        )
        .all(params.cursor ?? '', params.limit + 1) as TextBoxRow[]
      const hasMore = rows.length > params.limit
      const page = rows.slice(0, params.limit).map(textBoxFromRow)
      const snapshot = readLegacySnapshotConnection(this.database)
      const documents = page.filter((document) =>
        snapshot.windowPlacements.some(
          (window) =>
            window.id === document.windowId && window.workspaceIds.includes(document.workspaceId)
        )
      )
      return { documents, nextCursor: hasMore ? page.at(-1)!.textBoxDocumentId : null }
    })()
  }

  getTextBox(textBoxDocumentId: string): TextBoxDocument {
    if (!validId(textBoxDocumentId))
      throw new ContentCatalogError('invalid_params', 'Invalid TextBox ID')
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          'SELECT text_box_document_id,workspace_id,window_id,title,text_content,content_revision,created_at_ms,updated_at_ms FROM text_box_documents WHERE text_box_document_id = ?'
        )
        .get(textBoxDocumentId) as TextBoxRow | undefined
      if (!row) throw new ContentCatalogError('not_found', 'TextBox not found')
      const document = textBoxFromRow(row)
      const authorized = readLegacySnapshotConnection(this.database).windowPlacements.some(
        (window) =>
          window.id === document.windowId && window.workspaceIds.includes(document.workspaceId)
      )
      if (!authorized) throw new ContentCatalogError('not_found', 'TextBox not found')
      return document
    })()
  }
}
