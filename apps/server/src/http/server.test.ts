import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

import {
  terminalAttachResultSchema,
  terminalCreateResultSchema,
  terminalErrorSchema,
  terminalEventSchema
} from '@agent-workspace/contracts'
import { TerminalApiClient } from '@agent-workspace/client-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { startServer } from './server'
import { TerminalService, type PtyAdapter, type PtyProcess } from '../terminal/terminal-service'

const TOKEN = 'test-token-0123456789-0123456789-abcdef'

class FakePty implements PtyProcess {
  public readonly pid = 2345
  public readonly writes: Array<string | Buffer> = []
  public readonly sizes: Array<[number, number]> = []
  private listener: (data: Buffer) => void = () => {}
  public onData(listener: (data: Buffer) => void): { dispose(): void } {
    this.listener = listener
    return { dispose: () => (this.listener = () => {}) }
  }
  public onExit(): { dispose(): void } {
    return { dispose: () => {} }
  }
  public write(data: string | Buffer): void {
    this.writes.push(data)
  }
  public resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }
  public kill(): void {}
  public output(data: string): void {
    this.listener(Buffer.from(data))
  }
}

const running: Array<ReturnType<typeof startServer>> = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()))
})

async function fixture() {
  const pty = new FakePty()
  const adapter: PtyAdapter = { spawn: () => Promise.resolve(pty) }
  const service = new TerminalService(adapter)
  const server = startServer({ service, token: TOKEN, port: 0 })
  running.push(server)
  await new Promise<void>((resolve) => server.server.once('listening', resolve))
  const address = server.server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  return { pty, url, auth }
}

describe('Hono terminal API', () => {
  it('rejects unauthenticated access and validates requests before spawning', async () => {
    const { url, auth } = await fixture()
    expect((await fetch(`${url}/v1/system/identify`)).status).toBe(401)
    const unauthenticatedSocket = new WebSocket(
      `${url.replace('http:', 'ws:')}/v1/terminals/00000000-0000-4000-8000-000000000000/events`
    )
    const upgradeStatus = await new Promise<number>((resolve, reject) => {
      unauthenticatedSocket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
        response.resume()
        unauthenticatedSocket.terminate()
      })
      unauthenticatedSocket.once('open', () => reject(new Error('Unauthenticated socket opened')))
      unauthenticatedSocket.once('error', reject)
    })
    expect(upgradeStatus).toBe(401)
    const invalid = await fetch(`${url}/v1/terminals`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ rows: 0, cols: 80 })
    })
    expect(invalid.status).toBe(400)
    expect(terminalErrorSchema.parse(await invalid.json()).error.code).toBe('invalid_params')

    const oversized = await fetch(`${url}/v1/terminals`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ rows: 24, cols: 80, padding: 'x'.repeat(1024 * 1024) })
    })
    expect(oversized.status).toBe(413)
  })

  it('streams an attached snapshot and ordered terminal output', async () => {
    const { url, auth, pty } = await fixture()
    const created = await fetch(`${url}/v1/terminals`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ rows: 24, cols: 80 })
    })
    expect(created.status).toBe(201)
    const { terminal } = terminalCreateResultSchema.parse(await created.json())
    const socket = new WebSocket(
      `${url.replace('http:', 'ws:')}/v1/terminals/${terminal.id}/events`,
      { headers: auth }
    )
    const messages: unknown[] = []
    socket.on('message', (data) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data))
          : data
      messages.push(JSON.parse(bytes.toString('utf8')))
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    pty.output('hello')
    await waitFor(() => messages.length >= 2)
    expect((messages[0] as { event: string }).event).toBe('terminal.attached')
    expect(
      terminalAttachResultSchema.parse((messages[0] as { data: unknown }).data).lastSequence
    ).toBe(0)
    expect(terminalEventSchema.parse(messages[1]).event).toBe('terminal.output')

    const attached = await fetch(`${url}/v1/terminals/${terminal.id}`, { headers: auth })
    expect(terminalAttachResultSchema.parse(await attached.json()).lastSequence).toBe(1)
    socket.close()
  })

  it('serves the shared typed client across the full terminal lifecycle', async () => {
    const { url, pty } = await fixture()
    const client = new TerminalApiClient(url, TOKEN)
    const identity = await client.identify()
    expect(identity.capabilities).toContain('terminal.attach')
    expect(identity.capabilities).toContain('terminal.runtimeMetadata')
    expect(identity.capabilities).not.toContain('state.snapshot')
    expect(identity.capabilities).not.toContain('workspace.select')
    expect(identity.capabilities).not.toContain('workspace.move')
    expect(identity.capabilities).not.toContain('workspace.update')
    await expect(client.stateSnapshot()).rejects.toMatchObject({ status: 404 })
    await expect(
      client.selectWorkspace({
        workspaceId: randomUUID(),
        expectedRevision: 0,
        idempotencyEpoch: randomUUID(),
        idempotencyKey: randomUUID()
      })
    ).rejects.toMatchObject({ status: 404 })

    const { terminal } = await client.create({ rows: 24, cols: 80 })
    await client.send(terminal.id, Buffer.from([0x00, 0xff]))
    await client.resize(terminal.id, 35, 110)
    expect(pty.writes).toEqual([Buffer.from([0x00, 0xff])])
    expect(pty.sizes).toEqual([[110, 35]])
    expect((await client.attach(terminal.id)).terminal.rows).toBe(35)
    expect((await client.runtimeMetadata(terminal.id)).terminalId).toBe(terminal.id)
    await client.close(terminal.id)
    await expect(client.attach(terminal.id)).rejects.toMatchObject({
      status: 404,
      code: 'terminal_not_found'
    })
    await expect(client.runtimeMetadata(terminal.id)).rejects.toMatchObject({
      status: 404,
      code: 'terminal_not_found'
    })
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for terminal event')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
