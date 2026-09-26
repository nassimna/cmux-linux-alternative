import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AgentProtocol } from 'ssh2'
import ssh2 from 'ssh2'
import { describe, expect, it } from 'vitest'

import { CredentialBrokerLease } from './credential-provider'

const run = promisify(execFile)
const targetId = '123e4567-e89b-42d3-a456-426614174000'
const sshString = (value: Buffer | string) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}
const sessionBind = (
  hostKey: Buffer, sessionId: Buffer, signature: Buffer, forwarding = false,
  extension = 'session-bind@openssh.com'
) => {
  const payload = Buffer.concat([
    Buffer.from([27]), sshString(extension), sshString(hostKey),
    sshString(sessionId), sshString(Buffer.concat([sshString('ssh-ed25519'), sshString(signature)])),
    Buffer.from([Number(forwarding)])
  ])
  return Buffer.concat([sshString(payload)])
}
async function exchange(socket: ReturnType<typeof connect>, frame: Buffer): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    socket.once('data', (reply: Buffer) => resolve(reply[4]!))
    socket.once('error', reject)
    socket.write(frame)
  })
}

describe('attempt-scoped signing broker', () => {
  it('opens a broker socket under a realistic long private profile path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmux-broker-'))
    const brokerRoot = join(root, 'a'.repeat(38))
    const keyPath = join(root, 'id_ed25519')
    let lease: CredentialBrokerLease | undefined
    try {
      await mkdir(brokerRoot, { mode: 0o700 })
      expect(Buffer.byteLength(join(brokerRoot, 'a'.repeat(36), 'agent.sock'))).toBeGreaterThan(107)
      await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath])
      const hostPublicKey = (await readFile(`${keyPath}.pub`, 'utf8')).split(' ')[1]!
      lease = await CredentialBrokerLease.fromSigningBroker(
        brokerRoot,
        targetId,
        1,
        await readFile(keyPath),
        hostPublicKey
      )
      const socketPath = await lease.socketFor(targetId, 1)
      expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(107)
      const socket = connect(socketPath)
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.destroy()
    } finally {
      await lease?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serves one Ed25519 identity, signs, then revokes its socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmux-broker-'))
    const brokerRoot = join(root, 'broker')
    const keyPath = join(root, 'id_ed25519')
    await mkdir(brokerRoot, { mode: 0o700 })
    let lease: CredentialBrokerLease | undefined
    try {
      await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath])
      const secret = await readFile(keyPath)
      const parsed = ssh2.utils.parseKey(secret)
      if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid test key')
      const hostKey = parsed.getPublicSSH()
      lease = await CredentialBrokerLease.fromSigningBroker(
        brokerRoot, targetId, 1, secret, hostKey.toString('base64')
      )
      expect(secret.every((byte) => byte === 0)).toBe(true)
      const socket = connect(await lease.socketFor(targetId, 1))
      const sessionId = Buffer.alloc(32, 7)
      const hostSignature = parsed.sign(sessionId)
      if (hostSignature instanceof Error) throw hostSignature
      expect(await exchange(socket, sessionBind(hostKey, sessionId, hostSignature, true))).toBe(5)
      expect(await exchange(socket, sessionBind(
        hostKey, sessionId, hostSignature, false, 'session-bind@openssh.net'
      ))).toBe(5)
      const wrongHostKey = Buffer.from(hostKey)
      wrongHostKey[wrongHostKey.length - 1] = wrongHostKey[wrongHostKey.length - 1]! ^ 1
      expect(await exchange(socket, sessionBind(wrongHostKey, sessionId, hostSignature))).toBe(5)
      expect(await exchange(socket, sessionBind(hostKey, sessionId, Buffer.alloc(64)))).toBe(5)
      expect(await exchange(socket, sessionBind(hostKey, sessionId, hostSignature))).toBe(6)
      expect(await exchange(socket, sessionBind(hostKey, sessionId, hostSignature))).toBe(5)
      const client = new AgentProtocol(true)
      socket.pipe(client).pipe(socket)
      const identities = await new Promise<
        Parameters<Parameters<AgentProtocol['getIdentities']>[0]>[1]
      >((resolve, reject) =>
        client.getIdentities((error, keys) => (error ? reject(error) : resolve(keys)))
      )
      expect(identities).toHaveLength(1)
      const identity = identities?.[0]
      if (!identity) throw new Error('No broker identity')
      await expect(new Promise<Buffer>((resolve, reject) =>
        client.sign(identity, Buffer.concat([
          sshString(Buffer.alloc(32, 8)), Buffer.from([50]), Buffer.from('wrong session')
        ]), (error, result) => error ? reject(error) : resolve(result!))
      )).rejects.toThrow('Agent responded with failure')
      const signature = await new Promise<Buffer>((resolve, reject) =>
        client.sign(identity, Buffer.concat([
          sshString(sessionId), Buffer.from([50]), Buffer.from('attempt challenge')
        ]), (error, result) =>
          error ? reject(error) : resolve(result!)
        )
      )
      expect(signature).toHaveLength(64)
      await lease.close()
      expect(await readdir(brokerRoot)).toEqual([])
      await expect(lease.socketFor(targetId, 1)).rejects.toMatchObject({
        code: 'credential_revoked'
      })
      socket.destroy()
    } finally {
      await lease?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
