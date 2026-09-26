import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import Database from 'better-sqlite3'
import { expect, it, vi } from 'vitest'

import { RUST_SCHEMA_V15_SQL } from '../persistence/legacy-schema-v15'
import { TerminalService } from '../terminal/terminal-service'
import { startServer } from '../http/server'
import { BrowserAutomationProviderAuthority } from './provider-authority'
import { BrowserAutomationDurableRecords } from './durable-records'
import type { BrowserAutomationRuntime } from './runtime'

it('exposes caller automation with a runtime while keeping provider HTTP behind an exact private lease', async () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_sessions)
  database.exec(RUST_SCHEMA_V15_SQL.browser_automation_operations)
  const windowId = randomUUID()
  const authority = new BrowserAutomationProviderAuthority((candidate) => candidate === windowId)
  const identity = authority.registerTrustedWindow(windowId, 1)
  const records = new BrowserAutomationDurableRecords(database, authority, Buffer.alloc(32, 8))
  const snapshot = {
    automationSessionId: randomUUID(),
    generation: 1,
    navigationEpoch: 1,
    mode: 'ephemeral' as const,
    state: 'ready' as const,
    profileKey: 'default',
    target: {
      workspaceId: randomUUID(),
      paneId: randomUUID(),
      tabId: randomUUID(),
      browserSessionId: randomUUID(),
      browserLifecycleId: randomUUID(),
      window: { windowId, windowGeneration: 1 }
    },
    createdAtMs: 1,
    updatedAtMs: 1,
    expiresAtMs: 2
  }
  const createSession = vi.fn(async () => snapshot)
  const listSessions = vi.fn(() => [])
  const getSession = vi.fn(() => snapshot)
  const cancelOperation = vi.fn(() => ({
    automationSessionId: randomUUID(),
    sessionGeneration: 1,
    operationId: randomUUID(),
    correlationId: randomUUID(),
    attemptEpoch: 1,
    navigationEpoch: 1,
    state: 'canceled' as const,
    errorCode: 'canceled' as const,
    updatedAtMs: 1
  }))
  const token = 'browser-test-token-0123456789-0123456789'
  const service = new TerminalService({
    spawn: async () => {
      throw new Error('unexpected PTY')
    }
  })
  const running = startServer({
    service,
    token,
    port: 0,
    browserAutomation: {
      authority,
      records,
      runtime: {
        createSession,
        listSessions,
        getSession,
        cancelOperation
      } as unknown as BrowserAutomationRuntime
    }
  })
  try {
    await new Promise<void>((resolve) => running.server.once('listening', resolve))
    const address = running.server.address() as AddressInfo
    const base = `http://127.0.0.1:${address.port}`
    const endpoint = `${base}/v1/browser-automation/provider/poll`
    const body = JSON.stringify({ identity, timeoutMs: 0 })
    expect((await fetch(endpoint, { method: 'POST', body })).status).toBe(401)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const invalid = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ identity: { ...identity, leaseId: randomUUID() }, timeoutMs: 0 })
    })
    expect(invalid.status).toBe(409)
    const valid = await fetch(endpoint, { method: 'POST', headers, body })
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({})
    const handleId = randomUUID()
    const request = {
      kind: 'screenshotRead' as const,
      identity,
      target: { windowId, windowGeneration: 1 },
      requestId: randomUUID(),
      correlationId: randomUUID(),
      params: { automationSessionId: randomUUID(), sessionGeneration: 1, handleId, chunkIndex: 0 }
    }
    const pending = authority.mailbox.publish(request)
    const delivered = await fetch(endpoint, { method: 'POST', headers, body })
    expect(await delivered.json()).toMatchObject({ request: { requestId: request.requestId } })
    const response = {
      identity,
      target: request.target,
      requestId: request.requestId,
      correlationId: request.correlationId,
      outcome: {
        kind: 'screenshotRead',
        result: {
          handleId,
          chunkIndex: 0,
          chunkCount: 1,
          dataBase64: Buffer.from('png').toString('base64'),
          sha256: 'a'.repeat(64),
          expiresAtMs: Date.now() + 10_000
        }
      }
    }
    const transferEndpoint = `${base}/v1/browser-automation/provider/transfer-respond`
    const wrongLease = await fetch(transferEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...response, identity: { ...identity, leaseId: randomUUID() } })
    })
    expect(wrongLease.status).toBe(409)
    const responded = await fetch(transferEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(response)
    })
    expect(responded.status).toBe(200)
    expect(await pending.completion).toMatchObject({ kind: 'transfer' })
    const identify = await fetch(`${base}/v1/system/identify`, { headers })
    const capabilities = ((await identify.json()) as { capabilities: string[] }).capabilities
    expect(capabilities).toContain('browser-automation-v1')
    const createEndpoint = `${base}/v1/browser-automation/sessions`
    const createBody = JSON.stringify({
      mode: 'ephemeral',
      profileKey: 'default',
      idempotency: { epoch: randomUUID(), key: randomUUID() },
      correlationId: randomUUID()
    })
    expect((await fetch(createEndpoint, { method: 'POST', body: createBody })).status).toBe(401)
    expect(createSession).not.toHaveBeenCalled()
    expect(
      (
        await fetch(createEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ mode: 'attach' })
        })
      ).status
    ).toBe(400)
    const created = await fetch(createEndpoint, { method: 'POST', headers, body: createBody })
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ session: { state: 'ready' } })
    expect(createSession).toHaveBeenCalledOnce()
    const listed = await fetch(createEndpoint, { headers })
    expect(await listed.json()).toEqual({ sessions: [] })
    expect(listSessions).toHaveBeenCalledOnce()
    const sessionId = randomUUID()
    const got = await fetch(`${createEndpoint}/get`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ automationSessionId: sessionId, generation: 1 })
    })
    expect(got.status).toBe(200)
    expect(getSession).toHaveBeenCalledWith({ automationSessionId: sessionId, generation: 1 })
    const canceled = await fetch(`${base}/v1/browser-automation/operations/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        automationSessionId: sessionId,
        sessionGeneration: 1,
        operationId: randomUUID(),
        correlationId: randomUUID()
      })
    })
    expect(canceled.status).toBe(200)
    expect(((await canceled.json()) as { operation: { state: string } }).operation.state).toBe(
      'canceled'
    )
  } finally {
    await running.close()
    authority.dispose()
    database.close()
  }
})
