import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import type { HostKeyAuthority } from '../remote/host-key-authority'
import type { RemoteInteractiveRuntime } from '../remote/remote-interactive-runtime'
import type { RemoteSessionActivationService } from '../remote/remote-session-activation-service'
import type { RemoteTargetDeletionService } from '../remote/remote-target-deletion-service'
import { TerminalService } from '../terminal/terminal-service'
import { startServer } from './server'

const TOKEN = 'node-target-delete-test-token-0123456789'
const targetId = '00000000-0000-4000-8000-0000000000f3'

it('advertises and routes deletion only with scoped remote transport, behind bearer auth', async () => {
  const service = new TerminalService({ spawn: () => Promise.reject(new Error('unexpected PTY')) })
  const stateStore = {
    currentIdempotencyEpoch: () => randomUUID(),
    close: () => undefined
  } as unknown as ApplicationStateStore
  const remoteInteractive = {
    uses: (candidate: TerminalService) => candidate === service,
    dispose: () => Promise.resolve()
  } as unknown as RemoteInteractiveRuntime
  const remoteActivation = {
    dispose: () => Promise.resolve()
  } as unknown as RemoteSessionActivationService
  const hostKeyAuthority = {} as HostKeyAuthority
  const result = {
    target: {
      remoteTargetId: targetId,
      label: 'Fixture SSH',
      host: 'example.com',
      port: 22,
      user: 'alice',
      authentication: 'publicKey' as const,
      hostKeyState: 'trusted' as const,
      knownHostsVersion: 3,
      revision: 2
    }
  }
  const deleteTarget = vi.fn().mockResolvedValue(result)
  const deletion = { delete: deleteTarget } as unknown as RemoteTargetDeletionService
  const running = startServer({
    service,
    token: TOKEN,
    port: 0,
    stateStore,
    remoteInteractive,
    remoteActivation,
    hostKeyAuthority,
    remoteTargetDeletion: deletion
  })
  try {
    await new Promise<void>((resolve) => running.server.once('listening', resolve))
    const address = running.server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const client = new AgentWorkspaceClient(baseUrl, TOKEN)
    const request = {
      remoteTargetId: targetId,
      mutation: {
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64)
      }
    }
    const capabilities = (await client.identify()).capabilities
    expect(capabilities).toContain('remote.target.delete')
    expect(capabilities).toContain('remote.target.create')
    const bareCreate = await fetch(`${baseUrl}/v1/remote-targets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(bareCreate.status).toBe(400)
    const unauthenticated = await fetch(`${baseUrl}/v1/remote-targets/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request)
    })
    expect(unauthenticated.status).toBe(401)
    expect(await client.deleteRemoteTarget(request)).toEqual(result)
    expect(deleteTarget).toHaveBeenCalledWith(request)
  } finally {
    await running.close()
  }

  const withoutTransport = startServer({
    service: new TerminalService({ spawn: () => Promise.reject(new Error('unexpected PTY')) }),
    token: TOKEN,
    port: 0,
    stateStore
  })
  try {
    await new Promise<void>((resolve) => withoutTransport.server.once('listening', resolve))
    const address = withoutTransport.server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const client = new AgentWorkspaceClient(baseUrl, TOKEN)
    expect((await client.identify()).capabilities).not.toContain('remote.target.delete')
    const unavailable = await fetch(`${baseUrl}/v1/remote-targets/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(unavailable.status).toBe(404)
  } finally {
    await withoutTransport.close()
  }
})
