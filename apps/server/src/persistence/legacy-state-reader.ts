import { lstatSync } from 'node:fs'

import Database from 'better-sqlite3'

import {
  durableApplicationStateSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'

import {
  inspectLegacyConnection,
  LegacyDatabaseError,
  parseLegacyRevision
} from './legacy-inspection'

/** A read-only adapter for a schema-v15 Rust database, including its full snapshot payload. */
export class LegacyStateReader {
  private readonly database: Database.Database
  private closed = false

  public constructor(path: string) {
    try {
      const file = lstatSync(path)
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new LegacyDatabaseError(
          'database_unavailable',
          'State database must be a regular file'
        )
      }
    } catch (error) {
      if (error instanceof LegacyDatabaseError) throw error
      throw new LegacyDatabaseError('database_unavailable', 'State database cannot be opened')
    }

    let database: Database.Database
    try {
      database = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 })
    } catch {
      throw new LegacyDatabaseError('database_unavailable', 'State database cannot be opened')
    }
    try {
      const report = inspectLegacyConnection(database)
      if (report.legacySnapshotCompatibility && report.snapshotRevision !== null) {
        throw new LegacyDatabaseError(
          'migration_required',
          'Legacy-compatible snapshot requires normalization before Node can read it'
        )
      }
    } catch (error) {
      database.close()
      throw error
    }
    this.database = database
  }

  public readSnapshot(): DurableApplicationState {
    if (this.closed) throw new Error('State reader is closed')
    return readLegacySnapshotConnection(this.database)
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}

/** Shared read fence for both read-only clients and a future transactional state owner. */
export function readLegacySnapshotConnection(database: Database.Database): DurableApplicationState {
  try {
    const version = database.pragma('user_version', { simple: true }) as number
    if (version !== 15) {
      throw new LegacyDatabaseError(
        version > 15 ? 'future_schema' : 'migration_required',
        'State database schema changed while it was open'
      )
    }
    const stored = database
      .prepare('SELECT revision, json_payload FROM application_snapshot WHERE singleton = 1')
      .get() as { revision: unknown; json_payload: unknown } | undefined
    if (!stored) {
      throw new LegacyDatabaseError('state_uninitialized', 'State snapshot has not been saved')
    }
    const metadata = database
      .prepare('SELECT legacy_snapshot_compatibility FROM migration_metadata WHERE singleton = 1')
      .get() as { legacy_snapshot_compatibility: unknown } | undefined
    if (metadata?.legacy_snapshot_compatibility !== 0) {
      throw new LegacyDatabaseError(
        'migration_required',
        'State snapshot compatibility changed while the reader was open'
      )
    }
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
    const result = durableApplicationStateSchema.safeParse(payload)
    if (!result.success || result.data.revision !== revision) {
      throw new LegacyDatabaseError(
        'invalid_snapshot',
        'State snapshot is invalid or its revision does not match its row'
      )
    }
    return result.data
  } catch (error) {
    if (error instanceof LegacyDatabaseError) throw error
    if (error instanceof Database.SqliteError) {
      throw new LegacyDatabaseError('invalid_schema', 'State database schema could not be read')
    }
    throw error
  }
}
