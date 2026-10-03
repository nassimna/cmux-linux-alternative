import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { ApplicationStateStore } from '../persistence/application-state-store'
import { TerminalService } from '../terminal/terminal-service'
import { startServer } from './server'

const TOKEN = 'node-target-create-test-token-0123456789'

it('creates targets through the authenticated native API with catalog replay semantics', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.remote-target-create-'))
  await chmod(directory, 0o700)
  try {
    const store = await ApplicationStateStore.openNative(
      join(directory, 'state.sqlite3'),
      join(directory, 'backup.sqlite3'),
      directory
    )
    const service = new TerminalService({
      spawn: () => Promise.reject(new Error('unexpected PTY'))
    })
    const running = startServer({ service, token: TOKEN, port: 0, stateStore: store })
    try {
      await new Promise<void>((resolve) => running.server.once('listening', resolve))
      const address = running.server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${address.port}`
      const client = new AgentWorkspaceClient(baseUrl, TOKEN)
      expect((await client.identify()).capabilities).toContain('remote.target.create')

      const payload = {
        remoteTargetId: randomUUID(),
        label: 'Build host',
        host: 'build.example.com',
        port: 22,
        user: 'builder'
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
      const unauthenticated = await fetch(`${baseUrl}/v1/remote-targets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      })
      expect(unauthenticated.status).toBe(401)
      const invalid = await fetch(`${baseUrl}/v1/remote-targets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, privateKey: 'secret' })
      })
      expect(invalid.status).toBe(400)

      const created = await client.createRemoteTarget(request)
      expect(created.target).toMatchObject({
        ...payload,
        authentication: 'publicKey',
        hostKeyState: 'untrusted',
        revision: 1
      })
      expect(await client.createRemoteTarget(request)).toEqual(created)
      expect(await client.getRemoteTarget(payload.remoteTargetId)).toEqual(created)
      await expect(client.createRemoteTarget({
        ...request,
        mutation: { ...request.mutation, requestHash: 'b'.repeat(64) }
      })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' })
      await expect(client.createRemoteTarget({
        ...request,
        mutation: {
          ...request.mutation,
          idempotencyKey: randomUUID(),
          expectedRevision: 1
        }
      })).rejects.toMatchObject({ status: 409, code: 'stale_revision' })
    } finally {
      await running.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
