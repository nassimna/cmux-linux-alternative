import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync
} from 'node:fs'
import { isAbsolute, parse, resolve, sep } from 'node:path'

import Database from 'better-sqlite3'
import { decryptIndexValue, encryptIndexValue, keyedIndexHash } from './encrypted-index-crypto'

const DAY = 86_400_000
const MAX_BYTES = 512 * 1024 * 1024
const SCHEMA = [
  'CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=1), sentinel_nonce BLOB NOT NULL, sentinel_ciphertext BLOB NOT NULL)',
  'CREATE TABLE source_authorizations (authorization_id TEXT PRIMARY KEY CHECK(length(authorization_id)=36), excluded INTEGER NOT NULL CHECK(excluded IN (0,1)), consented_at_ms INTEGER NOT NULL CHECK(consented_at_ms>=0), retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 365), ignore_nonce BLOB NOT NULL, ignore_ciphertext BLOB NOT NULL)',
  "CREATE TABLE documents (id INTEGER PRIMARY KEY, authorization_id TEXT NOT NULL REFERENCES source_authorizations(authorization_id) ON DELETE CASCADE, identity_hash BLOB NOT NULL UNIQUE CHECK(length(identity_hash)=32), identity_version INTEGER NOT NULL CHECK(identity_version BETWEEN 1 AND 9007199254740991), document_nonce BLOB NOT NULL, document_ciphertext BLOB NOT NULL, snippet_nonce BLOB NOT NULL, snippet_ciphertext BLOB NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('workspaceFile','agentTranscript')), pinned INTEGER NOT NULL CHECK(pinned IN (0,1)), indexed_at_ms INTEGER NOT NULL)",
  'CREATE TABLE tokens (document_row INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, token_hash BLOB NOT NULL, UNIQUE(document_row,token_hash))'
]
const ARTIFACTS = ['search.sqlite3', 'search.sqlite3-wal', 'search.sqlite3-shm'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class EncryptedIndexError extends Error {
  constructor(
    public readonly code: 'unauthorized' | 'resource_limit' | 'unsafe_database' | 'corrupt_index',
    message: string
  ) {
    super(message)
    this.name = 'EncryptedIndexError'
  }
}
const fail = (code: EncryptedIndexError['code']): never => {
  throw new EncryptedIndexError(code, code)
}
const safeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
const readText = (key: Buffer, nonce: Buffer, ciphertext: Buffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      decryptIndexValue(key, nonce, ciphertext)
    )
  } catch {
    return fail('corrupt_index')
  }
}
function tokenize(text: string): string[] {
  const values: string[] = []
  // Rust splits at every non-alphanumeric scalar and limits before deduplication.
  for (const value of text.split(/[^\p{Alphabetic}\p{Number}]+/u)) {
    if ([...value].length < 2) continue
    values.push(value.toLowerCase())
    if (values.length === 4096) break
  }
  return [...new Set(values)].sort()
}
function child(fd: number, name: string): string {
  return `/proc/self/fd/${fd}/${name}`
}
function safeDirectory(path: string, privateMode: boolean): number {
  if (!isAbsolute(path) || resolve(path) !== path) fail('unsafe_database')
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const part of path.slice(parse(path).root.length).split(sep).filter(Boolean)) {
      const next = openSync(
        child(fd, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
      closeSync(fd)
      fd = next
    }
    const entry = fstatSync(fd)
    if (
      !entry.isDirectory() ||
      entry.uid !== process.getuid?.() ||
      (privateMode && (entry.mode & 0o777) !== 0o700)
    )
      fail('unsafe_database')
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}
function descend(parent: number, name: string, create: boolean): number {
  if (create) {
    try {
      mkdirSync(child(parent, name), { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const fd = openSync(
    child(parent, name),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  )
  const entry = fstatSync(fd)
  if (
    !entry.isDirectory() ||
    entry.uid !== process.getuid?.() ||
    (!create && (entry.mode & 0o777) !== 0o700)
  ) {
    closeSync(fd)
    fail('unsafe_database')
  }
  if (create) fchmodSync(fd, 0o700)
  return fd
}
function exists(path: string): boolean {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    closeSync(fd)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function secureArtifact(path: string, repair = true): void {
  if (!exists(path)) return
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (!repair && (stat.mode & 0o777) !== 0o600)
    )
      fail('unsafe_database')
    if (repair) fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
}
function exactSchema(db: Database.Database): void {
  const actual = db
    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
    .all()
  const expected = [
    ['index', 'sqlite_autoindex_documents_1', 'documents', null],
    ['index', 'sqlite_autoindex_source_authorizations_1', 'source_authorizations', null],
    ['index', 'sqlite_autoindex_tokens_1', 'tokens', null],
    ['index', 'token_lookup', 'tokens', 'CREATE INDEX token_lookup ON tokens(token_hash)'],
    ...SCHEMA.map((sql) => ['table', sql.split(' ')[2], sql.split(' ')[2], sql])
  ].map(([type, name, tbl_name, sql]) => ({ type, name, tbl_name, sql }))
  expected.sort((a, b) => a.type!.localeCompare(b.type!) || a.name!.localeCompare(b.name!))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('unsafe_database')
}

export type IndexDocument = { documentId: string; identityVersion: number }
export type IndexResult = {
  document: IndexDocument
  snippet: string
  sourceKind: 'workspaceFile' | 'agentTranscript'
  sourceAuthorizationId: string
  indexedAtMs: number
}
type SearchCursor = { indexedAtMs: number; rowId: number }

/** Rust schema-v1 compatible encrypted store. Caller owns the 32-byte profile key. */
export class EncryptedIndex {
  private constructor(
    private readonly db: Database.Database,
    private readonly directoryFd: number,
    private readonly key: Buffer
  ) {}

  static open(profile: string, profileKey: Buffer): EncryptedIndex {
    return EncryptedIndex.openOwned(profile, profileKey, true)
  }

  /** Never create index artifacts when attaching to a transferred live profile. */
  static openExisting(profile: string, profileKey: Buffer): EncryptedIndex {
    return EncryptedIndex.openOwned(profile, profileKey, false)
  }

  private static openOwned(profile: string, profileKey: Buffer, create: boolean): EncryptedIndex {
    if (process.platform !== 'linux' || profileKey.length !== 32) fail('unsafe_database')
    const profileFd = safeDirectory(profile, true)
    let directoryFd: number
    try {
      const indexFd = descend(profileFd, 'index', create)
      try {
        directoryFd = descend(indexFd, 'v1', create)
      } finally {
        closeSync(indexFd)
      }
    } finally {
      closeSync(profileFd)
    }
    let db: Database.Database | undefined
    try {
      for (const name of ARTIFACTS) secureArtifact(child(directoryFd, name), create)
      const path = child(directoryFd, ARTIFACTS[0])
      const fresh = !exists(path)
      if (fresh && !create) fail('unsafe_database')
      if (fresh) {
        const fd = openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        )
        closeSync(fd)
      }
      db = new Database(path, { fileMustExist: true, timeout: 5_000 })
      db.pragma('foreign_keys = ON')
      if (fresh) {
        db.pragma('journal_mode = WAL')
        for (const schema of SCHEMA) db.exec(schema)
        db.exec('CREATE INDEX token_lookup ON tokens(token_hash)')
      }
      exactSchema(db)
      const row = db
        .prepare(
          'SELECT sentinel_nonce AS nonce,sentinel_ciphertext AS ciphertext FROM metadata WHERE singleton=1'
        )
        .get() as { nonce: Buffer; ciphertext: Buffer } | undefined
      if (row) {
        if (readText(profileKey, row.nonce, row.ciphertext) !== 'agent-workspace-index-v1')
          fail('corrupt_index')
      } else if (fresh) {
        const encrypted = encryptIndexValue(profileKey, Buffer.from('agent-workspace-index-v1'))
        db.prepare('INSERT INTO metadata VALUES(1,1,?,?)').run(
          encrypted.nonce,
          encrypted.ciphertext
        )
      } else fail('unsafe_database')
      if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('unsafe_database')
      for (const name of ARTIFACTS) secureArtifact(child(directoryFd, name), create)
      const ownedKey = Buffer.from(profileKey)
      return new EncryptedIndex(db, directoryFd, ownedKey)
    } catch (error) {
      db?.close()
      closeSync(directoryFd)
      throw error
    }
  }

  /** Explicit recovery preserves each validated original artifact under one unique suffix. */
  static preserveCorruptAndRebuild(profile: string, key: Buffer): EncryptedIndex {
    const profileFd = safeDirectory(profile, true)
    let directoryFd: number
    try {
      const indexFd = descend(profileFd, 'index', false)
      try {
        directoryFd = descend(indexFd, 'v1', false)
      } finally {
        closeSync(indexFd)
      }
    } finally {
      closeSync(profileFd)
    }
    const suffix = randomUUID()
    try {
      for (const name of ARTIFACTS) {
        const path = child(directoryFd, name)
        if (exists(path)) {
          secureArtifact(path)
          renameSync(path, child(directoryFd, `${name}.corrupt-${suffix}`))
        }
      }
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
    return EncryptedIndex.open(profile, key)
  }

  close(): void {
    this.db.close()
    closeSync(this.directoryFd)
    this.key.fill(0)
  }
  clearRuntimeBoundDocuments(): void {
    this.db.exec('DELETE FROM documents')
  }
  private source(
    id: string,
    active = true
  ): { excluded: number; retention_days: number; ignore_nonce: Buffer; ignore_ciphertext: Buffer } {
    if (!UUID.test(id)) return fail('unauthorized')
    const row = this.db
      .prepare(
        'SELECT excluded,retention_days,ignore_nonce,ignore_ciphertext FROM source_authorizations WHERE authorization_id=?'
      )
      .get(id) as ReturnType<EncryptedIndex['source']> | undefined
    if (!row || (active && row.excluded !== 0)) return fail('unauthorized')
    return row
  }
  private ignore(id: string): string[] {
    const row = this.source(id)
    try {
      const parsed: unknown = JSON.parse(
        readText(this.key, row.ignore_nonce, row.ignore_ciphertext)
      )
      if (
        !Array.isArray(parsed) ||
        parsed.length > 256 ||
        !parsed.every((value) => typeof value === 'string' && UUID.test(value))
      )
        return fail('corrupt_index')
      return parsed as string[]
    } catch {
      return fail('corrupt_index')
    }
  }
  authorizeSourceRead(id: string): void {
    this.ignore(id)
  }
  authorizeSource(id: string, at = Date.now()): void {
    if (!UUID.test(id) || !safeInteger(at)) return fail('unauthorized')
    const encrypted = encryptIndexValue(this.key, Buffer.from('[]'))
    this.db
      .prepare(
        'INSERT INTO source_authorizations(authorization_id,excluded,consented_at_ms,retention_days,ignore_nonce,ignore_ciphertext) VALUES(?,0,?,365,?,?) ON CONFLICT(authorization_id) DO UPDATE SET excluded=0,consented_at_ms=excluded.consented_at_ms'
      )
      .run(id, at, encrypted.nonce, encrypted.ciphertext)
  }
  setSourcePolicy(id: string, days: number, exclusions: string[]): void {
    this.source(id, false)
    if (
      !Number.isInteger(days) ||
      days < 1 ||
      days > 365 ||
      exclusions.length > 256 ||
      exclusions.some((value) => !UUID.test(value))
    )
      return fail('unauthorized')
    const encrypted = encryptIndexValue(this.key, Buffer.from(JSON.stringify(exclusions)))
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE source_authorizations SET retention_days=?,ignore_nonce=?,ignore_ciphertext=? WHERE authorization_id=?'
        )
        .run(days, encrypted.nonce, encrypted.ciphertext, id)
      const remove = this.db.prepare(
        'DELETE FROM documents WHERE authorization_id=? AND identity_hash=?'
      )
      for (const value of exclusions) remove.run(id, keyedIndexHash(this.key, value))
      this.db
        .prepare(
          'DELETE FROM documents WHERE authorization_id=? AND pinned=0 AND indexed_at_ms < ?'
        )
        .run(id, Math.max(0, Date.now() - days * DAY))
    })()
  }
  excludeSource(id: string): void {
    this.source(id, false)
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE source_authorizations SET excluded=1 WHERE authorization_id=?')
        .run(id)
      this.db.prepare('DELETE FROM documents WHERE authorization_id=?').run(id)
    })()
  }
  forgetSource(id: string): void {
    this.db.prepare('DELETE FROM source_authorizations WHERE authorization_id=?').run(id)
  }
  rebuildSource(id: string): void {
    this.source(id, false)
    this.db.prepare('DELETE FROM documents WHERE authorization_id=?').run(id)
  }
  private prune(at: number): void {
    this.db
      .prepare(
        'DELETE FROM documents WHERE pinned=0 AND indexed_at_ms < (? - (SELECT retention_days FROM source_authorizations WHERE authorization_id=documents.authorization_id) * 86400000)'
      )
      .run(at)
  }
  indexText(
    id: string,
    document: IndexDocument,
    kind: IndexResult['sourceKind'],
    text: string,
    options: { maxBytes: number; deadlineMs: number; pinned?: boolean; indexedAtMs?: number }
  ): void {
    const source = this.source(id)
    const at = options.indexedAtMs ?? Date.now()
    if (
      !safeInteger(at) ||
      !safeInteger(document.identityVersion) ||
      document.identityVersion === 0 ||
      !UUID.test(document.documentId)
    )
      return fail('resource_limit')
    if (!options.pinned && at < Math.max(0, Date.now() - source.retention_days * DAY)) return
    if (
      Buffer.byteLength(text) > options.maxBytes ||
      options.maxBytes > 8 * 1024 * 1024 ||
      Date.now() >= options.deadlineMs
    )
      return fail('resource_limit')
    if (this.ignore(id).includes(document.documentId)) return
    const tokens = tokenize(text)
    if (!tokens.length) return
    this.prune(at)
    const docs = (this.db.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }).n
    const count = (this.db.prepare('SELECT count(*) AS n FROM tokens').get() as { n: number }).n
    const hash = keyedIndexHash(this.key, document.documentId)
    const existing = this.db.prepare('SELECT id FROM documents WHERE identity_hash=?').get(hash)
    const bytes = ARTIFACTS.reduce((sum, name) => {
      const path = child(this.directoryFd, name)
      if (!exists(path)) return sum
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        return sum + fstatSync(fd).size
      } finally {
        closeSync(fd)
      }
    }, 0)
    if (
      (!existing && docs >= 100_000) ||
      count + tokens.length > 10_000_000 ||
      bytes >= MAX_BYTES ||
      Date.now() >= options.deadlineMs
    )
      return fail('resource_limit')
    const documentValue = encryptIndexValue(this.key, Buffer.from(document.documentId))
    const snippet = [...text]
      .filter((char) => !/\p{Cc}/u.test(char) || char === '\n' || char === '\t')
      .slice(0, 512)
      .join('')
    const snippetValue = encryptIndexValue(this.key, Buffer.from(snippet))
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM documents WHERE identity_hash=?').run(hash)
      const result = this.db
        .prepare(
          'INSERT INTO documents(authorization_id,identity_hash,identity_version,document_nonce,document_ciphertext,snippet_nonce,snippet_ciphertext,source_kind,pinned,indexed_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          id,
          hash,
          document.identityVersion,
          documentValue.nonce,
          documentValue.ciphertext,
          snippetValue.nonce,
          snippetValue.ciphertext,
          kind,
          Number(Boolean(options.pinned)),
          at
        )
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO tokens(document_row,token_hash) VALUES(?,?)'
      )
      for (const token of tokens) {
        if (Date.now() >= options.deadlineMs) return fail('resource_limit')
        insert.run(result.lastInsertRowid, keyedIndexHash(this.key, token))
      }
    })()
    for (const name of ARTIFACTS) secureArtifact(child(this.directoryFd, name))
  }
  search(query: string, limit: number, sourceAuthorizationIds?: string[]): IndexResult[] {
    return this.searchPage(query, limit, sourceAuthorizationIds).results
  }
  searchPage(
    query: string,
    limit: number,
    sourceAuthorizationIds?: string[],
    cursor?: SearchCursor
  ): { results: IndexResult[]; nextCursor?: SearchCursor } {
    this.prune(Date.now())
    const tokens = tokenize(query)
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !tokens.length ||
      tokens.length > 32 ||
      (cursor !== undefined &&
        (!safeInteger(cursor.indexedAtMs) || !safeInteger(cursor.rowId) || cursor.rowId === 0)) ||
      (sourceAuthorizationIds !== undefined &&
        (sourceAuthorizationIds.length > 640 ||
          sourceAuthorizationIds.some((id) => !UUID.test(id))))
    )
      return fail('resource_limit')
    if (sourceAuthorizationIds?.length === 0) return { results: [] }
    const hashes = tokens.map((token) => keyedIndexHash(this.key, token))
    const sourceFilter = sourceAuthorizationIds
      ? ` AND d.authorization_id IN (${sourceAuthorizationIds.map(() => '?').join(',')})`
      : ''
    const cursorFilter = cursor
      ? ' AND (d.indexed_at_ms < ? OR (d.indexed_at_ms = ? AND d.id < ?))'
      : ''
    const rows = this.db
      .prepare(
        `SELECT d.id,d.authorization_id,d.identity_version,d.document_nonce,d.document_ciphertext,d.snippet_nonce,d.snippet_ciphertext,d.source_kind,d.indexed_at_ms FROM documents d JOIN source_authorizations s ON s.authorization_id=d.authorization_id JOIN tokens t ON t.document_row=d.id WHERE s.excluded=0${sourceFilter}${cursorFilter} AND t.token_hash IN (${hashes.map(() => '?').join(',')}) GROUP BY d.id HAVING count(DISTINCT t.token_hash)=${hashes.length} ORDER BY d.indexed_at_ms DESC,d.id DESC LIMIT ${limit + 1}`
      )
      .all(
        ...(sourceAuthorizationIds ?? []),
        ...(cursor ? [cursor.indexedAtMs, cursor.indexedAtMs, cursor.rowId] : []),
        ...hashes
      ) as Array<{
      id: number
      authorization_id: string
      identity_version: number
      document_nonce: Buffer
      document_ciphertext: Buffer
      snippet_nonce: Buffer
      snippet_ciphertext: Buffer
      source_kind: IndexResult['sourceKind']
      indexed_at_ms: number
    }>
    const page = rows.slice(0, limit)
    const results = page.map((row) => ({
      document: {
        documentId: readText(this.key, row.document_nonce, row.document_ciphertext),
        identityVersion: row.identity_version
      },
      snippet: readText(this.key, row.snippet_nonce, row.snippet_ciphertext),
      sourceKind: row.source_kind,
      sourceAuthorizationId: row.authorization_id,
      indexedAtMs: row.indexed_at_ms
    }))
    const last = page.at(-1)
    return {
      results,
      ...(rows.length > limit && last
        ? { nextCursor: { indexedAtMs: last.indexed_at_ms, rowId: last.id } }
        : {})
    }
  }
  exportSourceSummary(id: string): { schemaVersion: 1; documentCount: number; tokenCount: number } {
    this.authorizeSourceRead(id)
    this.prune(Date.now())
    const documentCount = (
      this.db.prepare('SELECT count(*) AS n FROM documents WHERE authorization_id=?').get(id) as {
        n: number
      }
    ).n
    const tokenCount = (
      this.db
        .prepare(
          'SELECT count(*) AS n FROM tokens t JOIN documents d ON d.id=t.document_row WHERE d.authorization_id=?'
        )
        .get(id) as { n: number }
    ).n
    return { schemaVersion: 1, documentCount, tokenCount }
  }
}
