import { randomUUID } from 'node:crypto'

import { expect, it } from 'vitest'

import { AgentWorkspaceClient } from '@agent-workspace/client-runtime'

it('reads a terminal browser operation by replaying the exact caller request', async () => {
  const params = {
    automationSessionId: randomUUID(), sessionGeneration: 1, navigationEpoch: 1,
    operationId: randomUUID(), attemptEpoch: 1, timeoutMs: 1_000,
    operation: { kind: 'query' as const, selector: 'button', limit: 1 },
    idempotency: { epoch: randomUUID(), key: randomUUID() }, correlationId: randomUUID()
  }
  const bodies: unknown[] = []
  const fetcher = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)))
    const state = bodies.length === 1 ? 'queued' : 'succeeded'
    return new Response(JSON.stringify({ operation: {
      automationSessionId: params.automationSessionId, sessionGeneration: 1,
      operationId: params.operationId, correlationId: params.correlationId,
      attemptEpoch: 1, navigationEpoch: 1, state,
      ...(state === 'succeeded' ? { result: { kind: 'query', matches: [] } } : {}),
      updatedAtMs: 1
    } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new AgentWorkspaceClient('http://127.0.0.1:1', 'private-test-token', fetcher as typeof fetch)
  await expect(client.invokeBrowserAutomationUntilTerminal(params))
    .resolves.toMatchObject({ operation: { state: 'succeeded', result: { kind: 'query' } } })
  expect(bodies).toEqual([params, params])
})
