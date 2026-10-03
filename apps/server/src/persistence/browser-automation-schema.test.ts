import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

import { migrateBrowserAutomationSchema } from './browser-automation-schema'
import { RUST_SCHEMA_V15_SQL } from './legacy-schema-v15'
import { NATIVE_SCHEMA_SQL } from './native-schema'

function insertSession(database: Database.Database): string {
  const id = randomUUID()
  database
    .prepare(
      `INSERT INTO browser_automation_sessions (
    automation_session_id, caller_id, profile_key, mode, state, generation, navigation_epoch,
    lifecycle_operation_id, lifecycle_correlation_id, lifecycle_attempt_epoch,
    idempotency_epoch, idempotency_key, request_digest, created_at_ms, updated_at_ms, expires_at_ms
  ) VALUES (?, ?, 'default', 'ephemeral', 'ready', 1, 1, ?, ?, 1, ?, ?, ?, 100, 100, 200)`
    )
    .run(id, randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64))
  return id
}

function insertOperation(
  database: Database.Database,
  sessionId: string,
  operation: string,
  result: string
): string {
  const id = randomUUID()
  database
    .prepare(
      `INSERT INTO browser_automation_operations (
    operation_id, automation_session_id, caller_id, session_generation, navigation_epoch, attempt_epoch,
    correlation_id, idempotency_epoch, idempotency_key, request_digest, operation_kind, input_bytes, state,
    provider_id, provider_epoch, provider_lease_id, window_id, window_generation,
    result_kind, result_digest, result_bytes, accepted_at_ms, updated_at_ms, expires_at_ms, terminal_at_ms
  ) VALUES (?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, 0, 'succeeded', ?, 1, ?, ?, 1, ?, ?, 16, 100, 120, 200, 120)`
    )
    .run(
      id,
      sessionId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      'b'.repeat(64),
      operation,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      result,
      'c'.repeat(64)
    )
  return id
}

function expectNewKinds(database: Database.Database, sessionId: string): void {
  for (const [operation, result] of [
    ['evaluate', 'evaluation'],
    ['console', 'console'],
    ['errors', 'errors']
  ]) {
    insertOperation(database, sessionId, operation!, result!)
  }
  expect(() => insertOperation(database, sessionId, 'unsupported', 'empty')).toThrow(
    'CHECK constraint failed'
  )
  expect(() => insertOperation(database, sessionId, 'evaluate', 'unsupported')).toThrow(
    'CHECK constraint failed'
  )
  expect(() => insertOperation(database, randomUUID(), 'evaluate', 'evaluation')).toThrow(
    'FOREIGN KEY constraint failed'
  )
}

it('creates fresh native operation tables with evaluation and diagnostics constraints', () => {
  const database = new Database(':memory:')
  try {
    database.pragma('foreign_keys = ON')
    database.exec(NATIVE_SCHEMA_SQL)
    migrateBrowserAutomationSchema(database)
    expectNewKinds(database, insertSession(database))
  } finally {
    database.close()
  }
})

it('migrates populated version-15 operation tables without losing rows, sequence, indexes or constraints', () => {
  const database = new Database(':memory:')
  try {
    database.pragma('foreign_keys = ON')
    database.exec(RUST_SCHEMA_V15_SQL.browser_automation_sessions)
    database.exec(RUST_SCHEMA_V15_SQL.browser_automation_operations)
    database.exec('CREATE INDEX retained_browser_state ON browser_automation_operations(state)')
    database.exec(`CREATE TABLE retained_browser_audit (operation_id TEXT);
      CREATE TRIGGER retained_browser_update AFTER UPDATE ON browser_automation_operations
      BEGIN INSERT INTO retained_browser_audit VALUES (NEW.operation_id); END;`)
    const sessionId = insertSession(database)
    const operationId = insertOperation(database, sessionId, 'screenshot', 'screenshot')
    const before = database.prepare('SELECT * FROM browser_automation_operations').all()
    database
      .prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'browser_automation_operations'")
      .run()
    migrateBrowserAutomationSchema(database)
    migrateBrowserAutomationSchema(database)
    expect(database.prepare('SELECT * FROM browser_automation_operations').all()).toEqual(before)
    const nextId = insertOperation(database, sessionId, 'evaluate', 'evaluation')
    expect(
      database
        .prepare('SELECT sequence FROM browser_automation_operations WHERE operation_id = ?')
        .get(nextId)
    ).toEqual({ sequence: 100 })
    database
      .prepare('UPDATE browser_automation_operations SET input_bytes = 1 WHERE operation_id = ?')
      .run(operationId)
    expect(database.prepare('SELECT * FROM retained_browser_audit').all()).toEqual([
      { operation_id: operationId }
    ])
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'retained_browser_state'"
        )
        .get()
    ).toEqual({ name: 'retained_browser_state' })
    expect(() =>
      database.prepare('UPDATE browser_automation_operations SET attempt_epoch = 0').run()
    ).toThrow('CHECK constraint failed')
    expectNewKinds(database, sessionId)
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    database.close()
  }
})
