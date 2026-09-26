import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import type { HostKeyAuthority } from '../remote/host-key-authority'
import type { RemoteCredentialEnrollmentService } from '../remote/remote-credential-enrollment-service'
import type { RemoteInteractiveRuntime } from '../remote/remote-interactive-runtime'
import type { RemoteSessionActivationService } from '../remote/remote-session-activation-service'
import { TerminalService } from '../terminal/terminal-service'
import { startServer } from './server'

const token = 'live-v1-replacement-fixture-token-0123456789'
const targetId = '00000000-0000-4000-8000-0000000000f3'

it('advertises only live v1 replacement and passes the v1-only guard to the service', async () => {
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
  const beginOnlineReplacement = vi.fn().mockResolvedValue(randomUUID())
  const replacement = {
    supportsReplacement: true,
    beginOnlineReplacement,
    close: vi.fn()
  } as unknown as RemoteCredentialEnrollmentService
  const running = startServer({
    service,
    token,
    port: 0,
    stateStore,
    remoteInteractive,
    remoteActivation,
    hostKeyAuthority: {} as HostKeyAuthority,
    remoteCredentialV1Replacement: replacement
  })
  try {
    await new Promise<void>((resolve) => running.server.once('listening', resolve))
    const address = running.server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const client = new AgentWorkspaceClient(baseUrl, token)
    const capabilities = (await client.identify()).capabilities
    expect(capabilities).toContain('remote.target.replaceCredential.v1')
    expect(capabilities).not.toContain('remote.target.replaceCredential')
    expect(capabilities).not.toContain('remote.target.enroll')
    expect(capabilities).not.toContain('remote.target.delete')

    const enrollment = await fetch(`${baseUrl}/v1/remote-targets/enrollment/begin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ remoteTargetId: targetId, enrollmentId: randomUUID() })
    })
    expect(enrollment.status).toBe(404)
    const unauthenticated = await fetch(`${baseUrl}/v1/remote-targets/replacement/begin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remoteTargetId: targetId, enrollmentId: randomUUID(), expectedRevision: 1 })
    })
    expect(unauthenticated.status).toBe(401)

    const enrollmentId = randomUUID()
    const response = await client.beginRemoteCredentialReplacement({
      remoteTargetId: targetId, enrollmentId, expectedRevision: 1
    })
    expect(response.remoteTargetId).toBe(targetId)
    expect(beginOnlineReplacement).toHaveBeenCalledWith(targetId, enrollmentId, 1, true)
  } finally {
    await running.close()
  }
})

it('advertises generic live replacement without enabling enrollment or deletion', async () => {
  const service = new TerminalService({ spawn: () => Promise.reject(new Error('unexpected PTY')) })
  const stateStore = {
    currentIdempotencyEpoch: () => randomUUID(), close: () => undefined
  } as unknown as ApplicationStateStore
  const remoteInteractive = {
    uses: (candidate: TerminalService) => candidate === service,
    dispose: () => Promise.resolve()
  } as unknown as RemoteInteractiveRuntime
  const remoteActivation = {
    dispose: () => Promise.resolve()
  } as unknown as RemoteSessionActivationService
  const beginOnlineReplacement = vi.fn().mockResolvedValue(randomUUID())
  const replacement = {
    supportsReplacement: true,
    beginOnlineReplacement,
    close: vi.fn()
  } as unknown as RemoteCredentialEnrollmentService
  const running = startServer({
    service, token, port: 0, stateStore, remoteInteractive, remoteActivation,
    hostKeyAuthority: {} as HostKeyAuthority,
    remoteCredentialLiveReplacement: replacement
  })
  try {
    await new Promise<void>((resolve) => running.server.once('listening', resolve))
    const address = running.server.address() as AddressInfo
    const client = new AgentWorkspaceClient(`http://127.0.0.1:${address.port}`, token)
    const capabilities = (await client.identify()).capabilities
    expect(capabilities).toContain('remote.target.replaceCredential')
    expect(capabilities).not.toContain('remote.target.replaceCredential.v1')
    expect(capabilities).not.toContain('remote.target.enroll')
    expect(capabilities).not.toContain('remote.target.delete')
    const enrollmentId = randomUUID()
    await client.beginRemoteCredentialReplacement({
      remoteTargetId: targetId, enrollmentId, expectedRevision: 1
    })
    expect(beginOnlineReplacement).toHaveBeenCalledWith(targetId, enrollmentId, 1, false)
  } finally {
    await running.close()
  }
})
