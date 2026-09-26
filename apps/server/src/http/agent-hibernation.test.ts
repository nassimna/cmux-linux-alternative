import { randomUUID } from 'node:crypto'

import { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { expect, it } from 'vitest'

import { AgentMutationError } from '../persistence/agent-mutations'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import type { AgentRegistrationService } from '../agents/agent-registration-service'
import type { WorkspaceTerminalRuntime } from '../domain/workspace-terminal-runtime'
import { TerminalService, type PtyAdapter } from '../terminal/terminal-service'
import { createApp } from './app'

const token = 'hibernation-http-test-token-0123456789abcdef'

it('exposes hibernation only with private authority and forwards lease rejection', async () => {
  const service = new TerminalService({
    spawn: () => Promise.reject(new Error('unused'))
  } as PtyAdapter)
  const state = { currentIdempotencyEpoch: () => 1 } as unknown as ApplicationStateStore
  const runtime = {
    uses: (candidate: TerminalService) => candidate === service,
    isReady: () => true
  } as WorkspaceTerminalRuntime
  const provider = { providerId: randomUUID(), providerEpoch: 1, leaseId: randomUUID() }
  const window = { windowId: randomUUID(), windowGeneration: 1 }
  const request = {
    agentSessionId: randomUUID(),
    challenge: { choice: 'terminateAfterWarning' as const, provider, window },
    operation: {
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
      sessionRevision: 1,
      attemptEpoch: 1
    }
  }
  const registration = {
    hibernationAvailable: () => false,
    providerProfileQualified: () => false,
    forkAvailable: () => false,
    hibernatePreflight: async () => {
      throw new AgentMutationError('provider_unavailable', 'Hibernation authority is unavailable')
    }
  } as unknown as AgentRegistrationService
  const app = createApp(
    service,
    token,
    undefined,
    state,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    registration
  )
  const endpoint = 'http://localhost/v1/agent-sessions/hibernate/preflight'
  const post = (body: unknown, authorization = `Bearer ${token}`) =>
    app.request(endpoint, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

  expect((await post(request)).status).toBe(404)
  const identify = await app.request('http://localhost/v1/system/identify', {
    headers: { authorization: `Bearer ${token}` }
  })
  expect(((await identify.json()) as { capabilities: string[] }).capabilities).not.toContain(
    'agent.hibernate.preflight'
  )

  registration.hibernationAvailable = () => true
  const enabled = createApp(
    service,
    token,
    undefined,
    state,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    registration
  )
  const enabledIdentify = await enabled.request('http://localhost/v1/system/identify', {
    headers: { authorization: `Bearer ${token}` }
  })
  expect(((await enabledIdentify.json()) as { capabilities: string[] }).capabilities).toEqual(
    expect.arrayContaining([
      'agent.hibernate.preflight',
      'agent.hibernate.cancel',
      'agent.hibernate.confirm'
    ])
  )
  const send = (body: unknown, authorization = `Bearer ${token}`) =>
    enabled.request(endpoint, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  expect((await send(request, 'Bearer wrong')).status).toBe(401)
  expect(
    (await send({ ...request, challenge: { ...request.challenge, provider: {} } })).status
  ).toBe(400)
  const stale = await send(request)
  expect(stale.status).toBe(503)
  expect(await stale.json()).toEqual({
    error: { code: 'provider_unavailable', message: 'Hibernation authority is unavailable' }
  })
  const client = new AgentWorkspaceClient('http://localhost', token, async (input, init) =>
    enabled.request(input, init)
  )
  await expect(client.preflightAgentHibernation(request)).rejects.toMatchObject({
    status: 503,
    code: 'provider_unavailable'
  })
  const confirmationId = randomUUID()
  const prepared = {
    state: 'confirmationRequired' as const,
    confirmationId,
    challenge: {
      ...request.challenge,
      confirmationId,
      nonce: randomUUID(),
      expiresAtMs: Date.now() + 30_000
    }
  }
  registration.hibernatePreflight = async () => prepared
  expect(await client.preflightAgentHibernation(request)).toEqual(prepared)
  registration.hibernateCancel = () => ({ state: 'canceled' })
  expect(
    await client.cancelAgentHibernation({
      agentSessionId: request.agentSessionId,
      operation: request.operation
    })
  ).toEqual({ state: 'canceled' })
  registration.hibernateConfirm = async () => ({ state: 'terminatedAfterWarning' })
  expect(
    await client.confirmAgentHibernation({
      agentSessionId: request.agentSessionId,
      confirmationId: randomUUID(),
      choice: 'terminateAfterWarning',
      provider,
      window,
      nonce: randomUUID(),
      expiresAtMs: Date.now() + 30_000,
      operation: request.operation
    })
  ).toEqual({ state: 'terminatedAfterWarning' })
})
