import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

import { RUST_SCHEMA_V15_SQL } from './legacy-schema-v15'
import { RemoteCatalog } from './remote-catalog'

it('reconnects a successfully created tmux session by attaching, while failed creates stay create', () => {
  const database = new Database(':memory:')
  for (const table of [
    'idempotency_results',
    'remote_targets',
    'remote_credential_enrollments',
    'remote_target_deletions',
    'remote_sessions'
  ] as const) database.exec(RUST_SCHEMA_V15_SQL[table])
  const targetId = randomUUID()
  const sessionId = randomUUID()
  const failedId = randomUUID()
  const catalog = new RemoteCatalog(database, () => 42)
  const mutation = (expectedRevision: number) => ({
    expectedRevision,
    idempotencyKey: randomUUID(),
    requestHash: 'a'.repeat(64)
  })
  try {
    database.prepare(
      `INSERT INTO remote_targets
       (remote_target_id,label,host,port,user,host_key_state,known_hosts_version,
        revision,idempotency_key,request_hash,created_at_ms,updated_at_ms)
       VALUES (?,'Test','example.com',22,'alice','trusted',1,1,?,?,1,1)`
    ).run(targetId, randomUUID(), 'b'.repeat(64))
    for (const id of [sessionId, failedId]) {
      database.prepare(
        `INSERT INTO remote_sessions
         (remote_session_id,remote_target_id,workspace_id,pane_id,tab_id,tmux_mode,tmux_name,
          state,observation,attempt_generation,reconnect_max_attempts,reconnect_initial_delay_ms,
          reconnect_max_delay_ms,revision,idempotency_key,request_hash,created_at_ms,updated_at_ms)
         VALUES (?,?,?,?,?,'create','main','credentialRequired','unknown',1,3,500,5000,1,?,?,1,1)`
      ).run(id, targetId, randomUUID(), randomUUID(), randomUUID(), randomUUID(), 'c'.repeat(64))
    }
    const first = mutation(1)
    const reserved = catalog.beginActivation(sessionId, first)
    expect(reserved.replay).toBe(false)
    if (reserved.replay) throw new Error('Unexpected replay')
    expect(reserved.session.tmux?.mode).toBe('create')
    const completed = catalog.completeActivation(
      sessionId, reserved.session.attemptGeneration, reserved.session.revision, first,
      'connected', targetId, 1, 1
    )
    expect(completed.applied).toBe(true)
    expect(catalog.getSession(sessionId).session.tmux?.mode).toBe('attach')
    const detached = catalog.detachSession({ remoteSessionId: sessionId, mutation: mutation(3) })
    expect(detached.session.tmux?.mode).toBe('attach')
    const reconnect = catalog.beginActivation(sessionId, mutation(detached.session.revision))
    expect(reconnect.replay).toBe(false)
    if (!reconnect.replay) expect(reconnect.session.tmux?.mode).toBe('attach')

    const failed = mutation(1)
    const failedReservation = catalog.beginActivation(failedId, failed)
    if (failedReservation.replay) throw new Error('Unexpected replay')
    catalog.completeActivation(
      failedId, failedReservation.session.attemptGeneration, failedReservation.session.revision,
      failed, 'failed', targetId, 1, 1, 'transport_unavailable'
    )
    expect(catalog.getSession(failedId).session.tmux?.mode).toBe('create')
  } finally {
    database.close()
  }
})
