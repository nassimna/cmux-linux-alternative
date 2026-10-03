import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

import type { BrowserAutomationProviderRequest } from '@agent-workspace/protocol-client'

import { RUST_SCHEMA_V15_SQL } from '../persistence/legacy-schema-v15'
import { BrowserAutomationProviderAuthority } from './provider-authority'
import { BrowserAutomationDurableRecords } from './durable-records'

it('checks canonical create replay and retained tombstones before allocating another session', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_sessions)
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_operations)
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_tombstones)
  const windowId = randomUUID()
  const authority = new BrowserAutomationProviderAuthority((candidate) => candidate === windowId)
  const identity = authority.registerTrustedWindow(windowId, 1)
  const records = new BrowserAutomationDurableRecords(database, authority, Buffer.alloc(32, 7), () => 1_000)
  const callerId = randomUUID()
  const params = { mode: 'ephemeral' as const, profileKey: 'default',
    idempotency: { epoch: randomUUID(), key: randomUUID() }, correlationId: randomUUID() }
  const sessionId = randomUUID()
  records.stageSession({ kind: 'create', identity, target: { windowId, windowGeneration: 1 },
    provision: { automationSessionId: sessionId, generation: 1,
      mode: params.mode, profileKey: params.profileKey, createdAtMs: 1_000, expiresAtMs: 2_000 },
    operationId: randomUUID(), correlationId: params.correlationId, attemptEpoch: 1 },
  { callerId, idempotencyEpoch: params.idempotency.epoch, idempotencyKey: params.idempotency.key })
  expect(records.sessionReplay(params, callerId)).toMatchObject({ state: 'pending', sessionId })
  expect(() => records.sessionReplay({ ...params, profileKey: 'other' }, callerId))
    .toThrow('idempotency_conflict')
  const digest = (database.prepare(`SELECT request_digest FROM browser_automation_sessions
    WHERE automation_session_id = ?`).get(sessionId) as { request_digest: string }).request_digest
  database.prepare('DELETE FROM browser_automation_sessions WHERE automation_session_id = ?').run(sessionId)
  database.prepare(`INSERT INTO browser_automation_tombstones
    (namespace, idempotency_epoch, idempotency_key, request_digest, terminal_code, completed_at_ms)
    VALUES ('sessionCreate', ?, ?, ?, 'destroyed', 1_000)`).run(
    params.idempotency.epoch, params.idempotency.key, digest
  )
  expect(() => records.sessionReplay(params, callerId)).toThrow('idempotency_expired')
  expect(() => records.sessionReplay({ ...params, profileKey: 'other' }, callerId))
    .toThrow('idempotency_conflict')
  authority.dispose()
  database.close()
})

it('reconciles an expired ready session through its provider', async () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_sessions)
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_operations)
  const windowId = randomUUID()
  const target = { windowId, windowGeneration: 1 }
  const authority = new BrowserAutomationProviderAuthority((candidate) => candidate === windowId)
  const identity = authority.registerTrustedWindow(windowId, 1)
  let now = 1_000
  const records = new BrowserAutomationDurableRecords(database, authority, Buffer.alloc(32, 3), () => now)
  const callerId = randomUUID()
  const create: BrowserAutomationProviderRequest = { kind: 'create', identity, target,
    provision: { automationSessionId: randomUUID(), generation: 1, mode: 'ephemeral',
      profileKey: 'default', createdAtMs: now, expiresAtMs: now + 100 },
    operationId: randomUUID(), correlationId: randomUUID(), attemptEpoch: 1 }
  records.stageSession(create, { callerId, idempotencyEpoch: randomUUID(), idempotencyKey: randomUUID() })
  authority.mailbox.publish(create)
  await authority.mailbox.poll({ identity, timeoutMs: 0 })
  const ready = { automationSessionId: create.provision.automationSessionId,
    generation: 1, navigationEpoch: 1, mode: 'ephemeral' as const,
    state: 'ready' as const, profileKey: 'default', createdAtMs: now,
    updatedAtMs: now, expiresAtMs: now + 100,
    target: { workspaceId: randomUUID(), paneId: randomUUID(), tabId: randomUUID(),
      browserSessionId: randomUUID(), browserLifecycleId: randomUUID(), window: target } }
  records.acknowledge({ identity, target, automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: create.operationId, correlationId: create.correlationId,
    attemptEpoch: 1, state: 'succeeded', session: ready })
  now = 1_101
  records.reconcile()
  expect(records.getSessionSnapshot(ready.automationSessionId)?.state).toBe('destroying')
  records.reconcile()
  expect(records.getSessionSnapshot(ready.automationSessionId)?.state).toBe('destroying')
  const destroy = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  if (destroy?.kind !== 'destroy') throw new Error('expired session was not cleaned up')
  records.acknowledge({ identity, target, automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: destroy.operationId, correlationId: destroy.correlationId,
    attemptEpoch: destroy.attemptEpoch, state: 'succeeded' })
  expect(records.getSessionSnapshot(ready.automationSessionId)?.state).toBe('destroyed')
  const nextCreate: BrowserAutomationProviderRequest = { kind: 'create', identity, target,
    provision: { ...create.provision, automationSessionId: randomUUID(),
      createdAtMs: now, expiresAtMs: now + 100 },
    operationId: randomUUID(), correlationId: randomUUID(), attemptEpoch: 1 }
  records.stageSession(nextCreate, { callerId, idempotencyEpoch: randomUUID(), idempotencyKey: randomUUID() })
  authority.mailbox.publish(nextCreate)
  await authority.mailbox.poll({ identity, timeoutMs: 0 })
  const nextReady = { ...ready, automationSessionId: nextCreate.provision.automationSessionId,
    createdAtMs: now, updatedAtMs: now, expiresAtMs: now + 100 }
  records.acknowledge({ identity, target, automationSessionId: nextReady.automationSessionId,
    sessionGeneration: 1, operationId: nextCreate.operationId,
    correlationId: nextCreate.correlationId, attemptEpoch: 1, state: 'succeeded', session: nextReady })
  authority.revokeWindow(windowId)
  records.reconcile()
  expect(records.getSessionSnapshot(nextReady.automationSessionId)?.state).toBe('failed')
  authority.dispose()
  database.close()
})

it('durably records an exact provider session and operation acknowledgement', async () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_sessions)
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_operations)
  const windowId = randomUUID()
  const target = { windowId, windowGeneration: 4 }
  const authority = new BrowserAutomationProviderAuthority((candidate) => candidate === windowId)
  const identity = authority.registerTrustedWindow(windowId, 4)
  let now = 1_000
  const records = new BrowserAutomationDurableRecords(database, authority, Buffer.alloc(32, 7), () => now)
  const sessionId = randomUUID()
  const lifecycleId = randomUUID()
  const lifecycleCorrelation = randomUUID()
  const create: BrowserAutomationProviderRequest = {
    kind: 'create', identity, target,
    provision: {
      automationSessionId: sessionId, generation: 1, mode: 'ephemeral', profileKey: 'default',
      createdAtMs: now, expiresAtMs: now + 100_000
    },
    operationId: lifecycleId, correlationId: lifecycleCorrelation, attemptEpoch: 1
  }
  const callerId = randomUUID()
  records.stageSession(create, { callerId, idempotencyEpoch: randomUUID(), idempotencyKey: randomUUID() })
  const createPending = authority.mailbox.publish(create)
  await authority.mailbox.poll({ identity, timeoutMs: 0 })
  const binding = {
    workspaceId: randomUUID(), paneId: randomUUID(), tabId: randomUUID(),
    browserSessionId: randomUUID(), browserLifecycleId: randomUUID(), window: target
  }
  const ready = {
    automationSessionId: sessionId, generation: 1, navigationEpoch: 1,
    mode: 'ephemeral' as const, state: 'ready' as const, profileKey: 'default',
    target: binding, createdAtMs: now, updatedAtMs: now + 1, expiresAtMs: now + 100_000
  }
  now += 2
  const createAck = {
    identity, target, automationSessionId: sessionId, sessionGeneration: 1,
    operationId: lifecycleId, correlationId: lifecycleCorrelation, attemptEpoch: 1,
    state: 'succeeded' as const, session: ready
  }
  expect(records.acknowledge(createAck)).toMatchObject({ state: 'succeeded', result: { kind: 'empty' } })
  expect(await createPending.completion).toMatchObject({ kind: 'acknowledge' })
  expect(database.prepare(`SELECT state FROM browser_automation_sessions WHERE automation_session_id = ?`)
    .get(sessionId)).toEqual({ state: 'ready' })

  const operationId = randomUUID()
  const correlationId = randomUUID()
  const execute: BrowserAutomationProviderRequest = {
    kind: 'execute', request: {
      identity, target, session: ready,
      operation: {
        automationSessionId: sessionId, sessionGeneration: 1, navigationEpoch: 1,
        operationId, attemptEpoch: 1, timeoutMs: 10_000,
        operation: { kind: 'query', selector: 'button', limit: 10 },
        idempotency: { epoch: randomUUID(), key: randomUUID() }, correlationId
      }
    }
  }
  records.stageOperation(execute, {
    callerId,
    idempotencyEpoch: execute.request.operation.idempotency.epoch,
    idempotencyKey: execute.request.operation.idempotency.key
  })
  const operationPending = authority.mailbox.publish(execute)
  await authority.mailbox.poll({ identity, timeoutMs: 0 })
  now += 1
  expect(() => records.acknowledge({
    identity, target: { ...target, windowGeneration: 5 }, automationSessionId: sessionId,
    sessionGeneration: 1, operationId, correlationId, attemptEpoch: 1,
    state: 'succeeded', result: { kind: 'query', matches: [] }
  })).toThrow('provider_epoch_mismatch')
  const result = records.acknowledge({
    identity, target, automationSessionId: sessionId, sessionGeneration: 1,
    operationId, correlationId, attemptEpoch: 1,
    state: 'succeeded', result: { kind: 'query', matches: [] }
  })
  expect(result).toMatchObject({ state: 'succeeded', result: { kind: 'query', matches: [] } })
  expect(await operationPending.completion).toMatchObject({ kind: 'acknowledge' })
  expect(database.prepare(`SELECT state, result_kind FROM browser_automation_operations WHERE operation_id = ?`)
    .get(operationId)).toEqual({ state: 'succeeded', result_kind: 'query' })
  const pendingOperationId = randomUUID()
  const pendingIdempotency = { epoch: randomUUID(), key: randomUUID() }
  records.stageOperation({
    ...execute,
    request: {
      ...execute.request,
      operation: {
        ...execute.request.operation,
        operationId: pendingOperationId,
        correlationId: randomUUID(),
        idempotency: pendingIdempotency
      }
    }
  }, { callerId, idempotencyEpoch: pendingIdempotency.epoch,
    idempotencyKey: pendingIdempotency.key })
  const lateOperationId = randomUUID()
  const lateCorrelationId = randomUUID()
  const lateIdempotency = { epoch: randomUUID(), key: randomUUID() }
  const late: BrowserAutomationProviderRequest = { ...execute, request: {
    ...execute.request, operation: { ...execute.request.operation,
      operationId: lateOperationId, correlationId: lateCorrelationId,
      idempotency: lateIdempotency }
  } }
  records.stageOperation(late, { callerId, idempotencyEpoch: lateIdempotency.epoch,
    idempotencyKey: lateIdempotency.key })
  const latePending = authority.mailbox.publish(late)
  await authority.mailbox.poll({ identity, timeoutMs: 0 })
  now += 10_001
  expect(records.acknowledge({ identity, target, automationSessionId: sessionId,
    sessionGeneration: 1, operationId: lateOperationId,
    correlationId: lateCorrelationId, attemptEpoch: 1,
    state: 'succeeded', result: { kind: 'query', matches: [] } }))
    .toMatchObject({ state: 'expired', errorCode: 'timeout' })
  expect(await latePending.completion).toMatchObject({ kind: 'acknowledge' })
  records.recoverAfterRestart()
  expect(database.prepare(`SELECT state, error_code FROM browser_automation_operations WHERE operation_id = ?`)
    .get(pendingOperationId)).toEqual({ state: 'interrupted', error_code: 'interrupted' })
  expect(database.prepare(`SELECT state FROM browser_automation_sessions WHERE automation_session_id = ?`)
    .get(sessionId)).toEqual({ state: 'expired' })
  authority.dispose()
  database.close()
})

it('transitions an exact ready session through destroy acknowledgement', async () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_sessions)
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_operations)
  const windowId = randomUUID()
  const target = { windowId, windowGeneration: 2 }
  const authority = new BrowserAutomationProviderAuthority((candidate) => candidate === windowId)
  const identity = authority.registerTrustedWindow(windowId, 2)
  let now = 2_000
  const records = new BrowserAutomationDurableRecords(database, authority, Buffer.alloc(32, 3), () => now)
  const callerId = randomUUID()
  const sessionId = randomUUID()
  const create: BrowserAutomationProviderRequest = {
    kind: 'create', identity, target,
    provision: { automationSessionId: sessionId, generation: 1, mode: 'ephemeral',
      profileKey: 'default', createdAtMs: now, expiresAtMs: now + 100_000 },
    operationId: randomUUID(), correlationId: randomUUID(), attemptEpoch: 1
  }
  records.stageSession(create, { callerId, idempotencyEpoch: randomUUID(), idempotencyKey: randomUUID() })
  authority.mailbox.publish(create)
  await authority.mailbox.poll({ identity, timeoutMs: 0 })
  const ready = {
    automationSessionId: sessionId, generation: 1, navigationEpoch: 1,
    mode: 'ephemeral' as const, state: 'ready' as const, profileKey: 'default',
    target: { workspaceId: randomUUID(), paneId: randomUUID(), tabId: randomUUID(),
      browserSessionId: randomUUID(), browserLifecycleId: randomUUID(), window: target },
    createdAtMs: now, updatedAtMs: now, expiresAtMs: now + 100_000
  }
  records.acknowledge({ identity, target, automationSessionId: sessionId, sessionGeneration: 1,
    operationId: create.operationId, correlationId: create.correlationId, attemptEpoch: 1,
    state: 'succeeded', session: ready })
  now += 1
  const destroy: BrowserAutomationProviderRequest = {
    kind: 'destroy', identity, target, session: ready,
    operationId: randomUUID(), correlationId: randomUUID(), attemptEpoch: 1
  }
  records.stageDestroy(destroy, callerId)
  const pending = authority.mailbox.publish(destroy)
  await authority.mailbox.poll({ identity, timeoutMs: 0 })
  expect(records.acknowledge({ identity, target, automationSessionId: sessionId,
    sessionGeneration: 1, operationId: destroy.operationId,
    correlationId: destroy.correlationId, attemptEpoch: 1, state: 'succeeded' }))
    .toMatchObject({ state: 'succeeded', result: { kind: 'empty' } })
  expect(await pending.completion).toMatchObject({ kind: 'acknowledge' })
  expect(database.prepare(`SELECT state FROM browser_automation_sessions WHERE automation_session_id = ?`)
    .get(sessionId)).toEqual({ state: 'destroyed' })
  authority.dispose()
  database.close()
})
