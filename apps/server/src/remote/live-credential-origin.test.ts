import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

import { RUST_SCHEMA_V15_SQL } from '../persistence/legacy-schema-v15'
import { LiveCredentialOriginStore } from './live-credential-origin'

function insertTarget(database: Database.Database, id: string, revision: number): void {
  database
    .prepare(
      `INSERT INTO remote_targets
     (remote_target_id,label,host,port,user,host_key_state,known_hosts_version,
      revision,idempotency_key,request_hash,created_at_ms,updated_at_ms)
     VALUES (?, 'Fixture', 'example.com', 22, 'alice', 'trusted', 1, ?, ?, ?, 1, 1)`
    )
    .run(id, revision, randomUUID(), 'a'.repeat(64))
}

function fixture(): { database: Database.Database; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'credential-origin-'))
  const database = new Database(join(directory, 'state.sqlite3'))
  database.exec(RUST_SCHEMA_V15_SQL.remote_targets)
  database.exec(RUST_SCHEMA_V15_SQL.remote_target_deletions)
  database.pragma('user_version = 15')
  return {
    database,
    close: () => {
      database.close()
      rmSync(directory, { recursive: true })
    }
  }
}

it('persists explicit v1 eligibility and never downgrades a committed v2 target', () => {
  const { database, close } = fixture()
  const id = randomUUID()
  try {
    insertTarget(database, id, 2)
    const first = new LiveCredentialOriginStore(database)
    expect(first.read(id)).toBe('unmarked')
    first.markV1Eligible(id, 2)
    first.markV1Eligible(id, 2)
    expect(new LiveCredentialOriginStore(database).read(id)).toBe('v1_eligible')
    expect(
      first.commitV2(
        id,
        2,
        () =>
          database
            .prepare(
              'UPDATE remote_targets SET revision = 3 WHERE remote_target_id = ? AND revision = 2'
            )
            .run(id).changes
      )
    ).toEqual({ status: 'committed', result: 1 })
    expect(new LiveCredentialOriginStore(database).read(id)).toBe('v2_committed')
    const reopened = new Database(database.name, { readonly: true })
    try {
      expect(
        reopened
          .prepare(
            'SELECT origin,committed_revision FROM node_live_credential_origins WHERE remote_target_id = ?'
          )
          .get(id)
      ).toEqual({ origin: 'v2_committed', committed_revision: 3 })
    } finally {
      reopened.close()
    }
    expect(
      first.commitV2(id, 2, () => {
        throw Error('must not repeat')
      })
    ).toEqual({ status: 'already_committed' })
    expect(() => first.markV1Eligible(id, 3)).toThrow(
      expect.objectContaining({ code: 'v2_committed' })
    )
    database.prepare('DELETE FROM remote_targets WHERE remote_target_id = ?').run(id)
    expect(first.read(id)).toBe('v2_committed')
  } finally {
    close()
  }
})

it('requires a durable deletion fence for the exact live credential origin', () => {
  const { database, close } = fixture()
  const v1 = randomUUID()
  const v2 = randomUUID()
  try {
    insertTarget(database, v1, 1)
    insertTarget(database, v2, 1)
    const origins = new LiveCredentialOriginStore(database)
    origins.markV1Eligible(v1, 1)
    origins.markV1Eligible(v2, 1)
    database.prepare(
      `UPDATE node_live_credential_origins SET origin = 'v2_committed', committed_revision = 1
       WHERE remote_target_id = ?`
    ).run(v2)
    expect(() => origins.readFencedDeletionOrigin(v1)).toThrow()
    for (const id of [v1, v2]) {
      database.prepare(
        `INSERT INTO remote_target_deletions
         (remote_target_id, expected_revision, idempotency_key, request_hash, result_json, created_at_ms)
         VALUES (?, 1, ?, ?, '{}', 1)`
      ).run(id, randomUUID(), 'b'.repeat(64))
    }
    expect(origins.readFencedDeletionOrigin(v1)).toBe('v1_eligible')
    expect(origins.readFencedDeletionOrigin(v2)).toBe('v2_committed')
    expect(() => origins.readFencedDeletionOrigin(randomUUID())).toThrow()
  } finally {
    close()
  }
})

it('fences stale revisions and rolls back both catalog and marker on a failed commit', () => {
  const { database, close } = fixture()
  const id = randomUUID()
  try {
    insertTarget(database, id, 4)
    const store = new LiveCredentialOriginStore(database)
    expect(() => store.markV1Eligible(id, 3)).toThrow(
      expect.objectContaining({ code: 'stale_revision' })
    )
    expect(() =>
      store.commitV2(id, 3, () => {
        throw Error('must not run')
      })
    ).toThrow(expect.objectContaining({ code: 'stale_revision' }))
    expect(() =>
      store.commitV2(id, 4, () => {
        database
          .prepare('UPDATE remote_targets SET revision = 5 WHERE remote_target_id = ?')
          .run(id)
        throw Error('catalog failed')
      })
    ).toThrow('catalog failed')
    expect(store.read(id)).toBe('unmarked')
    expect(
      database.prepare('SELECT revision FROM remote_targets WHERE remote_target_id = ?').get(id)
    ).toEqual({ revision: 4 })
    expect(() => store.commitV2(id, 4, () => undefined)).toThrow(
      expect.objectContaining({ code: 'stale_revision' })
    )
    expect(() =>
      store.commitV2(id, 4, (owned) => {
        owned.prepare('UPDATE remote_targets SET revision = 5 WHERE remote_target_id = ?').run(id)
        return Promise.resolve()
      })
    ).toThrow('must be synchronous')
    expect(
      database.prepare('SELECT revision FROM remote_targets WHERE remote_target_id = ?').get(id)
    ).toEqual({ revision: 4 })
    expect(store.read(id)).toBe('unmarked')
  } finally {
    close()
  }
})

it('commits a new v2 target without v1 eligibility and rejects marker rollback on ID reuse', () => {
  const { database, close } = fixture()
  const id = randomUUID()
  try {
    const store = new LiveCredentialOriginStore(database)
    store.commitV2(id, 0, () => insertTarget(database, id, 1))
    expect(store.read(id)).toBe('v2_committed')
    database.prepare('DELETE FROM remote_targets WHERE remote_target_id = ?').run(id)
    expect(() => store.commitV2(id, 0, () => insertTarget(database, id, 1))).toThrow(
      expect.objectContaining({ code: 'stale_revision' })
    )
    expect(
      database.prepare('SELECT revision FROM remote_targets WHERE remote_target_id = ?').get(id)
    ).toBeUndefined()
    expect(store.read(id)).toBe('v2_committed')
  } finally {
    close()
  }
})
