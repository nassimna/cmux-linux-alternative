import { randomUUID } from 'node:crypto'
import { Duplex } from 'node:stream'

import { expect, it } from 'vitest'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { WindowOwnerChannel } from './window-owner-channel'

function frame(value: object): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const result = Buffer.allocUnsafe(4 + payload.length)
  result.writeUInt32BE(payload.length, 0)
  payload.copy(result, 4)
  return result
}

class FakePipe extends Duplex {
  public peer?: FakePipe
  public override _read(): void {
    /* The peer pushes framed bytes. */
  }
  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void
  ): void {
    this.peer?.push(chunk)
    done()
  }
  public override _destroy(_error: Error | null, done: (error?: Error | null) => void): void {
    this.push(null)
    done()
  }
}

it('issues and revokes only on the private framed pipe, then fails closed on malformed input', async () => {
  const windowId = randomUUID()
  const serverStream = new FakePipe()
  const mainStream = new FakePipe()
  serverStream.peer = mainStream
  mainStream.peer = serverStream
  const backupProof = {
    liveStatePath: '/tmp/live.sqlite3',
    backupStatePath: '/tmp/backup.sqlite3',
    liveStateIdentity: '1:2',
    backupStateIdentity: '1:3',
    backupSha256: 'a'.repeat(64)
  }
  const state = {
    liveBackupProof: () => backupProof,
    readSnapshot: () => ({
      windowPlacements: [
        {
          id: windowId,
          label: 'Window',
          workspaceIds: [randomUUID()],
          focusedWorkspaceId: randomUUID(),
          hostingState: 'unhosted',
          revision: 1
        }
      ]
    })
  } as unknown as Pick<ApplicationStateStore, 'readSnapshot'>
  const channel = new WindowOwnerChannel(serverStream, state)
  let pending = Buffer.alloc(0)
  const nextResponse = () =>
    new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
      const onData = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        if (pending.length < 4) return
        const length = pending.readUInt32BE(0)
        if (pending.length < length + 4) return
        const payload = pending.subarray(4, length + 4)
        pending = pending.subarray(length + 4)
        mainStream.off('data', onData)
        resolveResponse(JSON.parse(payload.toString('utf8')) as Record<string, unknown>)
      }
      mainStream.on('data', onData)
      mainStream.once('error', rejectResponse)
    })
  try {
    const issueId = randomUUID()
    const issued = nextResponse()
    mainStream.write(frame({ id: issueId, operation: 'issue', windowId }))
    const reply = await issued
    expect(reply).toMatchObject({ id: issueId, ok: true })
    const capability = reply.capability as string
    expect(channel.registry.resolve(capability)?.windowId).toBe(windowId)

    const proofId = randomUUID()
    const proofResponse = nextResponse()
    mainStream.write(frame({ id: proofId, operation: 'liveBackupProof' }))
    expect(await proofResponse).toEqual({ id: proofId, ok: true, proof: backupProof })

    const registerId = randomUUID()
    const registered = nextResponse()
    mainStream.write(
      frame({
        id: registerId,
        operation: 'registerAutomationProvider',
        windowId,
        windowGeneration: 7
      })
    )
    const provider = await registered
    expect(provider).toMatchObject({ id: registerId, ok: true, identity: { providerEpoch: 1 } })
    const identity = provider.identity as {
      providerId: string
      providerEpoch: number
      leaseId: string
    }
    expect(channel.automation.isCurrent(identity, { windowId, windowGeneration: 7 })).toBe(true)
    expect(channel.automation.isCurrent(identity, { windowId, windowGeneration: 8 })).toBe(false)
    expect(
      channel.agentHibernationAuthority.current(identity, { windowId, windowGeneration: 7 })
    ).toBe(true)
    expect(
      channel.agentHibernationAuthority.current(identity, { windowId, windowGeneration: 8 })
    ).toBe(false)

    const revokeAutomation = async (providerIdentity: typeof identity, windowGeneration = 7) => {
      const id = randomUUID()
      const response = nextResponse()
      mainStream.write(
        frame({
          id,
          operation: 'revokeAutomationProvider',
          windowId,
          windowGeneration,
          identity: providerIdentity
        })
      )
      expect(await response).toMatchObject({ id, ok: true })
    }
    await revokeAutomation(identity, 8)
    expect(channel.automation.isCurrent(identity, { windowId, windowGeneration: 7 })).toBe(true)
    const pendingPoll = channel.automation.mailbox.poll({ identity, timeoutMs: 30_000 })
    await revokeAutomation(identity)
    expect(await pendingPoll).toEqual({})
    expect(channel.automation.isCurrent(identity)).toBe(false)
    expect(
      channel.agentHibernationAuthority.current(identity, { windowId, windowGeneration: 7 })
    ).toBe(false)
    expect(channel.registry.resolve(capability)?.windowId).toBe(windowId)

    const replacementId = randomUUID()
    const replacementResponse = nextResponse()
    mainStream.write(
      frame({
        id: replacementId,
        operation: 'registerAutomationProvider',
        windowId,
        windowGeneration: 7
      })
    )
    const replacement = await replacementResponse
    const replacementIdentity = replacement.identity as typeof identity
    expect(
      channel.automation.isCurrent(replacementIdentity, { windowId, windowGeneration: 7 })
    ).toBe(true)
    await revokeAutomation(identity)
    expect(
      channel.automation.isCurrent(replacementIdentity, { windowId, windowGeneration: 7 })
    ).toBe(true)
    expect(channel.registry.resolve(capability)?.windowId).toBe(windowId)

    const revokeId = randomUUID()
    const revoked = nextResponse()
    mainStream.write(frame({ id: revokeId, operation: 'revokeWindow', windowId }))
    expect(await revoked).toMatchObject({ id: revokeId, ok: true })
    expect(channel.registry.resolve(capability)).toBeUndefined()
    expect(channel.automation.isCurrent(replacementIdentity)).toBe(false)
    expect(
      channel.agentHibernationAuthority.current(replacementIdentity, {
        windowId,
        windowGeneration: 7
      })
    ).toBe(false)

    const malformed = Buffer.alloc(4)
    malformed.writeUInt32BE(1_025, 0)
    const closed = new Promise<void>((resolveClosed) => serverStream.once('close', resolveClosed))
    mainStream.write(malformed)
    await closed
    expect(channel.registry.resolve(capability)).toBeUndefined()
  } finally {
    channel.close()
    mainStream.destroy()
  }
})

it('accepts exact-generation hosting claims only on the private owner pipe', async () => {
  const windowId = randomUUID()
  const serverStream = new FakePipe()
  const mainStream = new FakePipe()
  serverStream.peer = mainStream
  mainStream.peer = serverStream
  let revision = 2
  let hostingState: 'hosted' | 'unhosted' = 'unhosted'
  const state = {
    readSnapshot: () => ({ windowPlacements: [{ id: windowId, hostingState }] }),
    reconcileWindowHosting: (claims: ReadonlySet<string>) => {
      const next = claims.has(windowId) ? 'hosted' : 'unhosted'
      if (hostingState !== next) {
        hostingState = next
        revision += 1
      }
      return revision
    }
  } as unknown as Pick<ApplicationStateStore, 'readSnapshot' | 'reconcileWindowHosting'>
  const channel = new WindowOwnerChannel(serverStream, state)
  const request = async (operation: string, windowGeneration: number) => {
    const id = randomUUID()
    const response = new Promise<Record<string, unknown>>((resolve) => {
      mainStream.once('data', (chunk: Buffer) =>
        resolve(JSON.parse(chunk.subarray(4).toString('utf8')) as Record<string, unknown>)
      )
    })
    mainStream.write(frame({ id, operation, windowId, windowGeneration }))
    return response
  }
  try {
    expect(await request('registerHosting', 8)).toMatchObject({ ok: true, revision: 3 })
    expect(hostingState).toBe('hosted')
    expect(await request('heartbeatHosting', 8)).toMatchObject({ ok: true, revision: 3 })
    expect(await request('revokeHosting', 7)).toMatchObject({ ok: true, revision: 3 })
    expect(hostingState).toBe('hosted')
    expect(await request('revokeHosting', 8)).toMatchObject({ ok: true, revision: 4 })
    expect(hostingState).toBe('unhosted')
    expect(await request('registerHosting', 8)).toMatchObject({
      ok: false,
      error: 'stale_window_generation'
    })
    expect(await request('registerHosting', 9)).toMatchObject({ ok: true, revision: 5 })
    channel.close()
    expect(hostingState).toBe('unhosted')
  } finally {
    channel.close()
    mainStream.destroy()
  }
})
