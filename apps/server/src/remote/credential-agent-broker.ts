import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, realpath, rm, rmdir } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import ssh2, { type ParsedKey } from 'ssh2'

import { CredentialError } from './credential-provider'

const { AgentProtocol, utils } = ssh2

const MAX_KEY_BYTES = 64 * 1024
const MAX_AGENT_FRAME = 256 * 1024
const MAX_AGENT_CONNECTION_BYTES = 512 * 1024
const EXTENSION = 27
const AGENT_FAILURE = Buffer.from([0, 0, 0, 1, 5])
const AGENT_SUCCESS = Buffer.from([0, 0, 0, 1, 6])
const SESSION_BIND = 'session-bind@openssh.com'

const revoked = () => new CredentialError('credential_revoked', 'Credential is invalid or revoked')
const unsafe = () =>
  new CredentialError('unsafe_agent_socket', 'Broker directory is not owner-only')

export function parseEd25519Credential(secret: Buffer): ParsedKey {
  if (
    secret.length === 0 ||
    secret.length > MAX_KEY_BYTES ||
    !/^-----BEGIN OPENSSH PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END OPENSSH PRIVATE KEY-----\n?$/.test(
      secret.toString('utf8')
    )
  )
    throw revoked()
  const parsed = utils.parseKey(secret)
  if (
    parsed instanceof Error ||
    Array.isArray(parsed) ||
    parsed.type !== 'ssh-ed25519' ||
    !parsed.isPrivateKey()
  ) {
    throw revoked()
  }
  return parsed
}

async function privateDirectory(path: string): Promise<void> {
  if (process.platform !== 'linux' || !process.getuid || !isAbsolute(path)) throw unsafe()
  try {
    const stat = await lstat(path)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(path)) !== path
    )
      throw unsafe()
  } catch {
    throw unsafe()
  }
}

function validAgentFrame(frame: Buffer): boolean {
  if (frame.length < 5 || frame.length !== frame.readUInt32BE(0) + 4) return false
  if (frame[4] !== 13) return true
  let offset = 5
  for (let field = 0; field < 2; field += 1) {
    if (offset + 4 > frame.length) return false
    const length = frame.readUInt32BE(offset)
    offset += 4
    if (length === 0 || length > MAX_AGENT_FRAME || offset + length > frame.length) return false
    offset += length
  }
  return offset + 4 === frame.length && frame.readUInt32BE(offset) === 0
}

function readString(frame: Buffer, cursor: { offset: number }): Buffer | undefined {
  if (cursor.offset + 4 > frame.length) return undefined
  const length = frame.readUInt32BE(cursor.offset)
  cursor.offset += 4
  if (length > MAX_AGENT_FRAME || cursor.offset + length > frame.length) return undefined
  const value = frame.subarray(cursor.offset, cursor.offset + length)
  cursor.offset += length
  return value
}

function readSessionBind(frame: Buffer, pinnedHostKey: Buffer): Buffer | undefined {
  const cursor = { offset: 5 }
  const extension = readString(frame, cursor)
  const hostKey = readString(frame, cursor)
  const sessionId = readString(frame, cursor)
  const signatureBlob = readString(frame, cursor)
  if (
    !extension?.equals(Buffer.from(SESSION_BIND)) ||
    !hostKey?.equals(pinnedHostKey) ||
    !sessionId || sessionId.length < 16 || sessionId.length > 64 ||
    !signatureBlob || cursor.offset + 1 !== frame.length || frame[cursor.offset] !== 0
  ) return undefined
  const signatureCursor = { offset: 0 }
  const algorithm = readString(signatureBlob, signatureCursor)
  const signature = readString(signatureBlob, signatureCursor)
  if (
    !algorithm?.equals(Buffer.from('ssh-ed25519')) ||
    !signature || signature.length !== 64 || signatureCursor.offset !== signatureBlob.length
  ) return undefined
  const parsed = utils.parseKey(pinnedHostKey)
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.type !== 'ssh-ed25519') return undefined
  return parsed.verify(sessionId, signature) === true ? Buffer.from(sessionId) : undefined
}

function isAuthenticationSignature(data: Buffer, sessionId: Buffer): boolean {
  return data.length > sessionId.length + 5 &&
    data.readUInt32BE(0) === sessionId.length &&
    data.subarray(4, 4 + sessionId.length).equals(sessionId) &&
    data[4 + sessionId.length] === 50 // SSH_MSG_USERAUTH_REQUEST
}

/** The key and socket live only for one attempt. Closing denies new and in-flight requests. */
export async function createSigningBroker(
  brokerRoot: string,
  targetId: string,
  generation: number,
  secret: Buffer,
  hostPublicKey: string
): Promise<{ socketPath: string; revoke: () => Promise<void> }> {
  await privateDirectory(brokerRoot)
  // Linux limits Unix-domain socket paths to 107 bytes. Keep attempt names short so a
  // normal private profile path still leaves room for the socket itself.
  const attemptRoot = join(brokerRoot, randomBytes(13).toString('hex'))
  const socketPath = join(attemptRoot, 's')
  if (Buffer.byteLength(socketPath) > 107) {
    throw new CredentialError('unsafe_agent_socket', 'Broker socket path exceeds the Linux limit')
  }
  let key: ParsedKey | undefined
  let pinnedHostKey: Buffer
  try {
    key = parseEd25519Credential(secret)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(hostPublicKey)) throw revoked()
    pinnedHostKey = Buffer.from(hostPublicKey, 'base64')
    if (pinnedHostKey.toString('base64') !== hostPublicKey) throw revoked()
    const host = utils.parseKey(pinnedHostKey)
    if (host instanceof Error || Array.isArray(host) || host.type !== 'ssh-ed25519' ||
        !host.getPublicSSH().equals(pinnedHostKey)) throw revoked()
  } finally {
    secret.fill(0)
  }
  await mkdir(attemptRoot, { mode: 0o700 })
  const sockets = new Set<Socket>()
  let active = true
  let server: Server | undefined
  const revoke = async () => {
    if (!active) return
    active = false
    key = undefined
    for (const socket of sockets) socket.destroy()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    await rm(socketPath, { force: true }).catch(() => undefined)
    await rmdir(attemptRoot).catch(() => undefined)
  }
  try {
    server = createServer((socket) => {
      if (!active) {
        socket.destroy()
        return
      }
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const protocol = new AgentProtocol(false)
      let boundSessionId: Buffer | undefined
      let usedForSigning = false
      let received = 0
      let pending = Buffer.alloc(0)
      socket.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (!active || received > MAX_AGENT_CONNECTION_BYTES) {
          socket.destroy()
          return
        }
        // Validate every complete frame before forwarding it to ssh2's parser.
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 4) {
          const length = pending.readUInt32BE(0)
          if (length === 0 || length > MAX_AGENT_FRAME) {
            socket.destroy()
            return
          }
          if (pending.length < length + 4) break
          const frame = pending.subarray(0, length + 4)
          if (!validAgentFrame(frame)) {
            socket.destroy()
            return
          }
          if (frame[4] === EXTENSION) {
            // ssh2's AgentProtocol does not implement OpenSSH's extension message.
            // A connection may bind once, before it has served a signature.
            const sessionId = !boundSessionId && !usedForSigning
              ? readSessionBind(frame, pinnedHostKey)
              : undefined
            if (sessionId) boundSessionId = sessionId
            socket.write(sessionId ? AGENT_SUCCESS : AGENT_FAILURE)
          } else {
            protocol.write(frame)
          }
          pending = pending.subarray(length + 4)
        }
      })
      protocol.on('data', (data: Buffer) => {
        if (active) socket.write(data)
      })
      protocol.on('identities', (request) => {
        const available = key
        if (!active || !available) {
          protocol.failureReply(request)
          return
        }
        const publicKey = utils.parseKey(available.getPublicSSH())
        if (publicKey instanceof Error || Array.isArray(publicKey)) protocol.failureReply(request)
        else protocol.getIdentitiesReply(request, [publicKey])
      })
      protocol.on('sign', (request, requested, data: Buffer, options) => {
        const available = key
        if (
          !active ||
          !available ||
          !Buffer.isBuffer(data) ||
          data.length === 0 ||
          data.length > MAX_AGENT_FRAME ||
          !boundSessionId ||
          !isAuthenticationSignature(data, boundSessionId) ||
          options.hash ||
          requested.type !== 'ssh-ed25519' ||
          !requested.getPublicSSH().equals(available.getPublicSSH())
        ) {
          protocol.failureReply(request)
          return
        }
        try {
          usedForSigning = true
          const signature = available.sign(data)
          if (!active || signature.length !== 64) protocol.failureReply(request)
          else protocol.signReply(request, signature)
        } catch {
          protocol.failureReply(request)
        }
      })
      protocol.on('error', () => socket.destroy())
      socket.on('error', () => socket.destroy())
    })
    await new Promise<void>((resolve, reject) =>
      server!.listen(socketPath, () => resolve()).once('error', reject)
    )
    await chmod(socketPath, 0o600)
    await privateDirectory(brokerRoot)
    await privateDirectory(attemptRoot)
    return { socketPath, revoke }
  } catch (error) {
    await revoke()
    throw error
  }
}

/** Creates an app-owned broker root; its parent must already be owner-only. */
export async function prepareBrokerRoot(path: string): Promise<void> {
  if (!isAbsolute(path)) throw unsafe()
  const parent = path.slice(0, path.lastIndexOf('/')) || '/'
  await privateDirectory(parent)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafe()
  }
  await privateDirectory(path)
}
