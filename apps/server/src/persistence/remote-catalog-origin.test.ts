import { createHash, randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

import { RemoteCatalog, RemoteCatalogError } from './remote-catalog'
import { RUST_SCHEMA_V15_SQL } from './legacy-schema-v15'

it('never reuses a live target ID with inherited credential history', () => {
  const database = new Database(':memory:')
  try {
    database.exec(Object.values(RUST_SCHEMA_V15_SQL).join(';'))
    database.exec(`CREATE TABLE node_live_credential_origins (
      remote_target_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      committed_revision INTEGER
    )`)
    const retiredId = randomUUID()
    database
      .prepare('INSERT INTO node_live_credential_origins VALUES (?, ?, NULL)')
      .run(retiredId, 'v1_eligible')
    const catalog = new RemoteCatalog(database, () => 42)
    const payload = {
      remoteTargetId: retiredId,
      label: 'new target',
      host: 'example.com',
      port: 22,
      user: 'alice'
    }
    const request = {
      ...payload,
      mutation: {
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256')
          .update(JSON.stringify({ namespace: 'remote.target.create', payload }))
          .digest('hex'),
        expectedRevision: 0
      }
    }
    expect(() => catalog.createTarget(request)).toThrowError(RemoteCatalogError)
    expect(
      database.prepare('SELECT 1 FROM remote_targets WHERE remote_target_id = ?').get(retiredId)
    ).toBeUndefined()
    const freshPayload = { ...payload, remoteTargetId: randomUUID() }
    expect(
      catalog.createTarget({
        ...freshPayload,
        mutation: {
          ...request.mutation,
          idempotencyKey: randomUUID(),
          requestHash: createHash('sha256')
            .update(JSON.stringify({ namespace: 'remote.target.create', payload: freshPayload }))
            .digest('hex')
        }
      }).target.revision
    ).toBe(1)
  } finally {
    database.close()
  }
})
