import type Database from 'better-sqlite3'

export type LiveCredentialOrigin = 'unmarked' | 'v1_eligible' | 'v2_committed'

export class LiveCredentialOriginError extends Error {
  public constructor(public readonly code: 'invalid_target' | 'stale_revision' | 'v2_committed') {
    super(code.replaceAll('_', ' '))
    this.name = 'LiveCredentialOriginError'
  }
}

const MAX_REVISION = Number.MAX_SAFE_INTEGER
const TARGET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function requireTargetId(targetId: string): void {
  if (!TARGET_ID.test(targetId)) throw new LiveCredentialOriginError('invalid_target')
}

function requireRevision(revision: number, minimum: number): void {
  if (!Number.isSafeInteger(revision) || revision < minimum || revision >= MAX_REVISION)
    throw new LiveCredentialOriginError('stale_revision')
}

/**
 * Nonsecret provenance for the live Node owner of a Rust schema-v15 database.
 * The caller must own the SQLite connection and invoke this only after live
 * ownership has transferred. The table deliberately has no foreign key so a
 * v2 tombstone survives target deletion and cannot be downgraded on ID reuse.
 */
export class LiveCredentialOriginStore {
  public constructor(private readonly database: Database.Database) {
    if (database.readonly || database.pragma('user_version', { simple: true }) !== 15)
      throw new Error('Live credential origin requires a writable schema-v15 database')
    database.exec(`CREATE TABLE IF NOT EXISTS node_live_credential_origins (
      remote_target_id TEXT PRIMARY KEY NOT NULL CHECK (length(remote_target_id) = 36),
      origin TEXT NOT NULL CHECK (origin IN ('v1_eligible', 'v2_committed')),
      committed_revision INTEGER CHECK (committed_revision IS NULL OR
        committed_revision BETWEEN 1 AND 9007199254740991),
      CHECK ((origin = 'v1_eligible' AND committed_revision IS NULL) OR
        (origin = 'v2_committed' AND committed_revision IS NOT NULL))
    )`)
  }

  public read(targetId: string): LiveCredentialOrigin {
    requireTargetId(targetId)
    const row = this.database
      .prepare('SELECT origin FROM node_live_credential_origins WHERE remote_target_id = ?')
      .get(targetId) as { origin: Exclude<LiveCredentialOrigin, 'unmarked'> } | undefined
    return row?.origin ?? 'unmarked'
  }

  /** Prove both provenance and a durable deletion fence before touching a live item. */
  public readFencedDeletionOrigin(targetId: string): Exclude<LiveCredentialOrigin, 'unmarked'> {
    requireTargetId(targetId)
    const row = this.database.prepare(
      `SELECT origin FROM node_live_credential_origins
       JOIN remote_target_deletions USING (remote_target_id)
       WHERE remote_target_id = ?`
    ).get(targetId) as { origin: Exclude<LiveCredentialOrigin, 'unmarked'> } | undefined
    if (!row || (row.origin !== 'v1_eligible' && row.origin !== 'v2_committed'))
      throw new LiveCredentialOriginError('invalid_target')
    return row.origin
  }

  /** Explicit pre-cutover inventory. An absent marker never authorizes v1. */
  public markV1Eligible(targetId: string, expectedRevision: number): void {
    requireTargetId(targetId)
    requireRevision(expectedRevision, 1)
    this.database
      .transaction(() => {
        if (this.targetRevision(targetId) !== expectedRevision)
          throw new LiveCredentialOriginError('stale_revision')
        if (this.read(targetId) === 'v2_committed')
          throw new LiveCredentialOriginError('v2_committed')
        this.database
          .prepare(
            `INSERT OR IGNORE INTO node_live_credential_origins
         (remote_target_id, origin) VALUES (?, 'v1_eligible')`
          )
          .run(targetId)
      })
      .immediate()
  }

  /**
   * Run a synchronous catalog mutation and its v2 marker in one IMMEDIATE
   * transaction. The mutation must advance this target from expectedRevision
   * to expectedRevision + 1; zero means a new target is created at revision 1.
   * Secret Service writes and awaits must happen before this call, never inside
   * the transaction. A failed mutation rolls back the marker and catalog row.
   */
  public commitV2<T>(
    targetId: string,
    expectedRevision: number,
    mutateCatalog: (database: Database.Database) => T
  ): { status: 'committed'; result: T } | { status: 'already_committed' } {
    requireTargetId(targetId)
    requireRevision(expectedRevision, 0)
    return this.database
      .transaction(() => {
        const before = this.targetRevision(targetId)
        if (before === expectedRevision + 1) {
          const row = this.database
            .prepare(
              `SELECT committed_revision FROM node_live_credential_origins
           WHERE remote_target_id = ? AND origin = 'v2_committed'`
            )
            .get(targetId) as { committed_revision: number } | undefined
          if (row?.committed_revision === before) return { status: 'already_committed' as const }
        }
        if (before !== (expectedRevision === 0 ? undefined : expectedRevision))
          throw new LiveCredentialOriginError('stale_revision')
        const result = mutateCatalog(this.database)
        if (result && typeof result === 'object' && 'then' in result) {
          throw new Error('Live credential catalog mutation must be synchronous')
        }
        if (this.targetRevision(targetId) !== expectedRevision + 1)
          throw new LiveCredentialOriginError('stale_revision')
        const changed = this.database
          .prepare(
            `INSERT INTO node_live_credential_origins
         (remote_target_id, origin, committed_revision) VALUES (?, 'v2_committed', ?)
         ON CONFLICT(remote_target_id) DO UPDATE SET
           origin = 'v2_committed', committed_revision = excluded.committed_revision
         WHERE node_live_credential_origins.origin = 'v1_eligible'
            OR node_live_credential_origins.committed_revision < excluded.committed_revision`
          )
          .run(targetId, expectedRevision + 1).changes
        if (changed !== 1) throw new LiveCredentialOriginError('stale_revision')
        return { status: 'committed' as const, result }
      })
      .immediate()
  }

  private targetRevision(targetId: string): number | undefined {
    const row = this.database
      .prepare('SELECT revision FROM remote_targets WHERE remote_target_id = ?')
      .get(targetId) as { revision: number } | undefined
    return row?.revision
  }
}
