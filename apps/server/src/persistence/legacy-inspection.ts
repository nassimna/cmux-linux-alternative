import Database from 'better-sqlite3'
import { z } from 'zod'

import { durableApplicationStateSchema } from '@agent-workspace/contracts'

import { RUST_SCHEMA_V15_SQL } from './legacy-schema-v15'

const RUST_SCHEMA_VERSION = 15
const legacySnapshotEnvelope = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  workspaces: z.array(z.unknown()).min(1)
})

// Content search has its own database and migration gate.
export const RUST_SCHEMA_V15_TABLES = Object.keys(RUST_SCHEMA_V15_SQL)

function normalizedSchema(sql: string): string {
  return sql.replace(/\s/g, '')
}

export class LegacyDatabaseError extends Error {
  public constructor(
    public readonly code:
      | 'database_unavailable'
      | 'migration_required'
      | 'future_schema'
      | 'invalid_schema'
      | 'invalid_snapshot'
      | 'state_uninitialized'
      | 'corrupt_database',
    message: string
  ) {
    super(message)
    this.name = 'LegacyDatabaseError'
  }
}

export interface LegacyDatabaseReport {
  schemaVersion: 15
  tableCount: number
  snapshotRevision: number | null
  workspaceCount: number
  windowStateCount: number
  legacySnapshotCompatibility: boolean
}

/**
 * Read-only preflight for a disposable copy of the Rust state database. It does
 * not grant write readiness: remaining domain payloads still need parity
 * validation before a Node service may own this file.
 */
export function inspectLegacyDatabase(path: string): LegacyDatabaseReport {
  let database: Database.Database
  try {
    database = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 })
  } catch {
    throw new LegacyDatabaseError('database_unavailable', 'State database cannot be opened')
  }

  try {
    return inspectLegacyConnection(database)
  } finally {
    database.close()
  }
}

/** Inspect the same SQLite connection that a caller will continue to read. */
export function inspectLegacyConnection(database: Database.Database): LegacyDatabaseReport {
  try {
    database.pragma('query_only = ON')
    const version = database.pragma('user_version', { simple: true }) as number
    if (version > RUST_SCHEMA_VERSION) {
      throw new LegacyDatabaseError(
        'future_schema',
        'State database schema is newer than supported'
      )
    }
    if (version < RUST_SCHEMA_VERSION) {
      throw new LegacyDatabaseError(
        'migration_required',
        'State database needs a Rust schema migration'
      )
    }

    const check = database.prepare('PRAGMA quick_check(1)').get() as { quick_check?: unknown }
    if (check.quick_check !== 'ok') {
      throw new LegacyDatabaseError(
        'corrupt_database',
        'State database failed SQLite integrity check'
      )
    }

    const tables = new Set(
      (
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
          )
          .all() as Array<{
          name: string
        }>
      ).map(({ name }) => name)
    )
    if (RUST_SCHEMA_V15_TABLES.some((name) => !tables.has(name))) {
      throw new LegacyDatabaseError('invalid_schema', 'State database is missing a required table')
    }

    const definitions = database
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as Array<{ name: string; sql: string }>
    const byName = new Map(definitions.map((entry) => [entry.name, entry.sql]))
    for (const [name, expected] of Object.entries(RUST_SCHEMA_V15_SQL)) {
      const actual = byName.get(name)
      if (actual === undefined || normalizedSchema(actual) !== normalizedSchema(expected)) {
        throw new LegacyDatabaseError(
          'invalid_schema',
          `State database ${name} table definition is incompatible`
        )
      }
    }
    if (database.prepare('PRAGMA foreign_key_check').get() !== undefined) {
      throw new LegacyDatabaseError(
        'corrupt_database',
        'State database has a broken foreign key relationship'
      )
    }

    const migration = database
      .prepare('SELECT legacy_snapshot_compatibility FROM migration_metadata WHERE singleton = 1')
      .get() as { legacy_snapshot_compatibility?: unknown } | undefined
    if (
      migration?.legacy_snapshot_compatibility !== 0 &&
      migration?.legacy_snapshot_compatibility !== 1
    ) {
      throw new LegacyDatabaseError(
        'invalid_schema',
        'State database migration metadata is invalid'
      )
    }

    const stored = database
      .prepare('SELECT revision, json_payload FROM application_snapshot WHERE singleton = 1')
      .get() as { revision: unknown; json_payload: unknown } | undefined
    let snapshotRevision: number | null = null
    let workspaceCount = 0
    if (stored) {
      const revision = parseLegacyRevision(stored.revision)
      if (typeof stored.json_payload !== 'string') {
        throw new LegacyDatabaseError('invalid_snapshot', 'State snapshot payload is invalid')
      }
      let payload: unknown
      try {
        payload = JSON.parse(stored.json_payload)
      } catch {
        throw new LegacyDatabaseError('invalid_snapshot', 'State snapshot is not JSON')
      }
      const snapshot =
        migration.legacy_snapshot_compatibility === 1
          ? legacySnapshotEnvelope.safeParse(payload)
          : durableApplicationStateSchema.safeParse(payload)
      if (!snapshot.success || snapshot.data.revision !== revision) {
        throw new LegacyDatabaseError(
          'invalid_snapshot',
          'State snapshot is invalid or its revision does not match its row'
        )
      }
      snapshotRevision = revision
      workspaceCount = snapshot.data.workspaces.length
    }

    const windowStateCount = (
      database.prepare('SELECT COUNT(*) AS count FROM window_state').get() as {
        count: number
      }
    ).count
    return {
      schemaVersion: RUST_SCHEMA_VERSION,
      tableCount: tables.size,
      snapshotRevision,
      workspaceCount,
      windowStateCount,
      legacySnapshotCompatibility: migration.legacy_snapshot_compatibility === 1
    }
  } catch (error) {
    if (error instanceof LegacyDatabaseError) throw error
    if (
      error instanceof Database.SqliteError &&
      ['SQLITE_NOTADB', 'SQLITE_CORRUPT'].includes(error.code)
    ) {
      throw new LegacyDatabaseError(
        'corrupt_database',
        'State database failed SQLite integrity check'
      )
    }
    throw new LegacyDatabaseError('invalid_schema', 'State database schema could not be read')
  }
}

export function parseLegacyRevision(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new LegacyDatabaseError('invalid_snapshot', 'State snapshot revision is invalid')
  }
  const revision = Number(value)
  if (!Number.isSafeInteger(revision)) {
    throw new LegacyDatabaseError(
      'invalid_snapshot',
      'State snapshot revision exceeds the safe range'
    )
  }
  return revision
}
