import { createHash, randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

import { RUST_SCHEMA_V15_SQL } from '../persistence/legacy-schema-v15'
import { BrowserAutomationProviderAuthority } from './provider-authority'
import { BrowserAutomationDurableRecords } from './durable-records'
import { BrowserAutomationRuntime } from './runtime'

it('publishes create, execute, and destroy through an exact private provider lease', async () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_sessions)
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_operations)
  const windowId = randomUUID()
  const target = { windowId, windowGeneration: 3 }
  const authority = new BrowserAutomationProviderAuthority((candidate) => candidate === windowId)
  const identity = authority.registerTrustedWindow(windowId, 3)
  const epoch = randomUUID()
  const records = new BrowserAutomationDurableRecords(database, authority, Buffer.alloc(32, 9), () => 1_000)
  const runtime = new BrowserAutomationRuntime(authority, records, randomUUID(), () => epoch, () => 1_000)

  const createParams = { mode: 'ephemeral' as const, profileKey: 'default',
    idempotency: { epoch, key: randomUUID() }, correlationId: randomUUID() }
  const creating = runtime.createSession(createParams)
  const pendingReplay = runtime.createSession(createParams)
  const create = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  expect(create?.kind).toBe('create')
  if (create?.kind !== 'create') throw new Error('create was not published')
  const ready = {
    automationSessionId: create.provision.automationSessionId, generation: 1,
    navigationEpoch: 1, mode: 'ephemeral' as const, state: 'ready' as const,
    profileKey: 'default', createdAtMs: 1_000, updatedAtMs: 1_000, expiresAtMs: create.provision.expiresAtMs,
    target: { workspaceId: randomUUID(), paneId: randomUUID(), tabId: randomUUID(),
      browserSessionId: randomUUID(), browserLifecycleId: randomUUID(), window: target }
  }
  records.acknowledge({ identity, target, automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: create.operationId,
    correlationId: create.correlationId, attemptEpoch: 1, state: 'succeeded', session: ready })
  expect(await creating).toMatchObject({ state: 'ready', target: ready.target })
  expect(await pendingReplay).toMatchObject({ automationSessionId: ready.automationSessionId })
  expect(await runtime.createSession(createParams)).toMatchObject({ automationSessionId: ready.automationSessionId })
  await expect(runtime.createSession({ ...createParams, profileKey: 'other' }))
    .rejects.toThrow('idempotency_conflict')
  const listed = runtime.listSessions()
  expect(listed).toHaveLength(1)
  expect(runtime.getSession({ automationSessionId: ready.automationSessionId, generation: 1 }))
    .toMatchObject({ state: 'ready' })
  const otherCaller = new BrowserAutomationRuntime(authority, records, randomUUID(), () => epoch, () => 1_000)
  expect(otherCaller.listSessions()).toEqual([])
  expect(() => otherCaller.getSession({ automationSessionId: ready.automationSessionId, generation: 1 }))
    .toThrow('session_not_found')

  const invoking = runtime.invoke({ automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, navigationEpoch: 1, operationId: randomUUID(), attemptEpoch: 1,
    timeoutMs: 10_000, operation: { kind: 'query', selector: 'button', limit: 10 },
    idempotency: { epoch, key: randomUUID() }, correlationId: randomUUID() })
  const execute = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  expect(execute?.kind).toBe('execute')
  if (execute?.kind !== 'execute') throw new Error('execute was not published')
  records.acknowledge({ identity, target, automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: execute.request.operation.operationId,
    correlationId: execute.request.operation.correlationId, attemptEpoch: 1,
    state: 'succeeded', result: { kind: 'query', matches: [] } })
  expect(await invoking).toMatchObject({ state: 'queued' })
  expect(records.getOperationSnapshot(execute.request.operation.operationId))
    .toMatchObject({ state: 'succeeded', result: { kind: 'query', matches: [] } })

  const navigateParams = { automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, navigationEpoch: 1, operationId: randomUUID(), attemptEpoch: 1,
    timeoutMs: 10_000, operation: { kind: 'navigate' as const, url: 'https://example.com/' },
    idempotency: { epoch, key: randomUUID() }, correlationId: randomUUID() }
  expect(await runtime.invoke(navigateParams)).toMatchObject({ state: 'queued' })
  const navigation = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  if (navigation?.kind !== 'execute') throw new Error('navigation was not published')
  records.acknowledge({ identity, target, automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: navigateParams.operationId,
    correlationId: navigateParams.correlationId, attemptEpoch: 1,
    state: 'succeeded', result: { kind: 'navigation', navigationEpoch: 2 } })
  expect(await runtime.invoke(navigateParams)).toMatchObject({ state: 'succeeded',
    result: { kind: 'navigation', navigationEpoch: 2 } })
  await expect(runtime.invoke({ ...navigateParams, operationId: randomUUID() }))
    .rejects.toThrow('idempotency_conflict')
  expect(runtime.getSession({ automationSessionId: ready.automationSessionId, generation: 1 })
    .navigationEpoch).toBe(2)

  const bytes = Buffer.from('png')
  const handleId = randomUUID()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const screenshot = runtime.invoke({ automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, navigationEpoch: 2, operationId: randomUUID(), attemptEpoch: 1,
    timeoutMs: 10_000, operation: { kind: 'screenshot', width: 1, height: 1 },
    idempotency: { epoch, key: randomUUID() }, correlationId: randomUUID() })
  const capture = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  if (capture?.kind !== 'execute') throw new Error('screenshot was not published')
  records.acknowledge({ identity, target, automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: capture.request.operation.operationId,
    correlationId: capture.request.operation.correlationId, attemptEpoch: 1,
    state: 'succeeded', result: { kind: 'screenshot', handle: {
      handleId, width: 1, height: 1, byteLength: bytes.length, mediaType: 'image/png',
      sha256, chunkCount: 1, expiresAtMs: 5_000
    } } })
  expect(await screenshot).toMatchObject({ state: 'queued' })
  expect(records.getOperationSnapshot(capture.request.operation.operationId))
    .toMatchObject({ result: { kind: 'screenshot', handle: { handleId } } })
  expect(() => records.handles.get(handleId, randomUUID(), ready.automationSessionId, 1))
    .toThrow('policy_denied')

  const reading = runtime.readScreenshot({ automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, handleId, chunkIndex: 0 })
  const readRequest = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  if (readRequest?.kind !== 'screenshotRead') throw new Error('read was not published')
  authority.mailbox.respondTransfer({ identity, target, requestId: readRequest.requestId,
    correlationId: readRequest.correlationId, outcome: { kind: 'screenshotRead', result: {
      handleId, chunkIndex: 0, chunkCount: 1, dataBase64: bytes.toString('base64'),
      sha256, expiresAtMs: 5_000
    } } })
  expect(await reading).toMatchObject({ dataBase64: bytes.toString('base64') })

  const caller = new AbortController()
  const abandoned = runtime.readScreenshot({ automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, handleId, chunkIndex: 0 }, caller.signal)
  const abandonedRequest = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  if (abandonedRequest?.kind !== 'screenshotRead') throw new Error('read was not published')
  caller.abort()
  await expect(abandoned).rejects.toThrow('timeout')
  expect(authority.mailbox.has(abandonedRequest.requestId)).toBe(false)
  expect(() => authority.mailbox.respondTransfer({ identity, target,
    requestId: abandonedRequest.requestId, correlationId: abandonedRequest.correlationId,
    outcome: { kind: 'error', errorCode: 'interrupted' } })).toThrow()

  const releasing = runtime.releaseScreenshot({ automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, handleId })
  const releaseRequest = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  if (releaseRequest?.kind !== 'screenshotRelease') throw new Error('release was not published')
  authority.mailbox.respondTransfer({ identity, target, requestId: releaseRequest.requestId,
    correlationId: releaseRequest.correlationId,
    outcome: { kind: 'screenshotRelease', released: true } })
  expect(await releasing).toEqual({ released: true })
  await expect(runtime.readScreenshot({ automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, handleId, chunkIndex: 0 })).rejects.toThrow('result_expired')

  const inFlightCancel = { automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: randomUUID(), correlationId: randomUUID() }
  const inFlightRequest = { ...inFlightCancel, navigationEpoch: 2, attemptEpoch: 1,
    timeoutMs: 10_000, operation: { kind: 'wait' as const,
      condition: { kind: 'lifecycle' as const, lifecycle: 'load' as const } },
    idempotency: { epoch, key: randomUUID() } }
  expect(await runtime.invoke(inFlightRequest)).toMatchObject({ state: 'queued' })
  expect((await authority.mailbox.poll({ identity, timeoutMs: 0 })).request?.kind).toBe('execute')
  expect(runtime.cancelOperation(inFlightCancel)).toMatchObject({ state: 'canceled' })
  expect((await authority.mailbox.poll({ identity, timeoutMs: 0 })).request?.kind).toBe('cancel')
  expect(records.acknowledge({ identity, target, automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: inFlightCancel.operationId,
    correlationId: inFlightCancel.correlationId, attemptEpoch: 1,
    state: 'canceled', errorCode: 'canceled' })).toMatchObject({ state: 'canceled' })
  expect(await runtime.invoke(inFlightRequest)).toMatchObject({ state: 'canceled' })

  const cancelParams = { automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: randomUUID(), correlationId: randomUUID() }
  const cancellable = { ...cancelParams, navigationEpoch: 2, attemptEpoch: 1,
    timeoutMs: 10_000, operation: { kind: 'wait' as const,
      condition: { kind: 'lifecycle' as const, lifecycle: 'load' as const } },
    idempotency: { epoch, key: randomUUID() } }
  expect(await runtime.invoke(cancellable)).toMatchObject({ state: 'queued' })
  expect(() => otherCaller.cancelOperation(cancelParams)).toThrow('invalid_operation')
  expect(runtime.cancelOperation(cancelParams)).toMatchObject({ state: 'canceled', errorCode: 'canceled' })
  expect(runtime.cancelOperation(cancelParams)).toMatchObject({ state: 'canceled' })
  expect(await runtime.invoke(cancellable)).toMatchObject({ state: 'canceled' })
  expect((await authority.mailbox.poll({ identity, timeoutMs: 0 })).request?.kind).toBe('cancel')

  const destroying = runtime.destroySession({ automationSessionId: ready.automationSessionId, generation: 1 })
  const destroy = (await authority.mailbox.poll({ identity, timeoutMs: 0 })).request
  expect(destroy?.kind).toBe('destroy')
  if (destroy?.kind !== 'destroy') throw new Error('destroy was not published')
  records.acknowledge({ identity, target, automationSessionId: ready.automationSessionId,
    sessionGeneration: 1, operationId: destroy.operationId,
    correlationId: destroy.correlationId, attemptEpoch: destroy.attemptEpoch, state: 'succeeded' })
  expect(await destroying).toMatchObject({ state: 'destroyed' })

  authority.dispose()
  database.close()
})
