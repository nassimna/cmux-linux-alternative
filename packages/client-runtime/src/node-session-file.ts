import { randomUUID } from 'node:crypto'
import { constants, existsSync, realpathSync } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { connect } from 'node:net'

import { nodeSessionRecordSchema, type NodeSessionRecord } from '@agent-workspace/contracts'

const MAX_SESSION_BYTES = 64 * 1024

/** Match the desktop runtime directory without relying on an inherited bearer token. */
export function resolveNodeSessionFile(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.AGENT_WORKSPACE_NODE_SESSION_FILE) {
    return process.env.AGENT_WORKSPACE_NODE_SESSION_FILE
  }
  const desktopSessions =
    process.platform === 'darwin'
      ? [
          join(
            homedir(),
            'Library',
            'Application Support',
            'Agent Workspace',
            'runtime',
            'node-cli-session.json'
          ),
          join(
            homedir(),
            'Library',
            'Application Support',
            'Ternline',
            'runtime',
            'node-cli-session.json'
          )
        ]
      : [
          join(
            process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
            '@agent-workspace',
            'desktop',
            'runtime',
            'node-cli-session.json'
          )
        ]
  const desktopSession = desktopSessions.find((candidate) => existsSync(candidate))
  if (desktopSession) return desktopSession
  let temporaryRoot = tmpdir()
  if (process.platform === 'darwin') {
    try {
      temporaryRoot = realpathSync(temporaryRoot)
    } catch {
      // The normal temporary directory is still the best fallback if it vanishes.
    }
  }
  const root = process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, 'agent-workspace')
    : join(temporaryRoot, `agent-workspace-${process.getuid?.() ?? 'unknown'}`)
  return join(root, 'node-cli-session.json')
}

function requireUnix(): void {
  if (
    (process.platform !== 'linux' && process.platform !== 'darwin') ||
    process.getuid === undefined
  ) {
    throw new Error('Node CLI discovery currently supports Linux and macOS only')
  }
}

async function privateDirectory(path: string): Promise<void> {
  requireUnix()
  const [actual, metadata] = await Promise.all([realpath(path), lstat(path)])
  if (
    actual !== path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid!() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error('Node CLI session directory must be private and owned by this user')
  }
}

function privateFile(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid!() ||
    (Number(metadata.mode) & 0o077) !== 0 ||
    metadata.nlink !== 1 ||
    metadata.size > MAX_SESSION_BYTES
  ) {
    throw new Error('Node CLI session file is not a private regular file')
  }
}

/** Read a bounded owner-only record without following the final symlink. */
export async function readNodeSessionFile(path: string): Promise<NodeSessionRecord> {
  const file = resolve(path)
  await privateDirectory(dirname(file))
  const before = await lstat(file)
  privateFile(before)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    privateFile(current)
    if (before.dev !== current.dev || before.ino !== current.ino) {
      throw new Error('Node CLI session file changed during read')
    }
    const buffer = Buffer.alloc(MAX_SESSION_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > MAX_SESSION_BYTES) throw new Error('Node CLI session file is oversized')
    let value: unknown
    try {
      value = JSON.parse(buffer.toString('utf8', 0, length))
    } catch {
      throw new Error('Node CLI session file is malformed')
    }
    return nodeSessionRecordSchema.parse(value)
  } finally {
    await handle.close()
  }
}

function endpointIsClosed(port: number): Promise<boolean> {
  return new Promise((resolveClosed, rejectClosed) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(1_000)
    socket.once('connect', () => {
      socket.destroy()
      resolveClosed(false)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolveClosed(true)
      else rejectClosed(error)
    })
    socket.once('timeout', () => {
      socket.destroy()
      rejectClosed(new Error('Node CLI session endpoint did not respond'))
    })
  })
}

async function removeStaleSession(file: string): Promise<boolean> {
  const before = await lstat(file)
  privateFile(before)
  const previous = await readNodeSessionFile(file)
  if (!(await endpointIsClosed(Number(new URL(previous.baseUrl).port)))) return false
  const current = await lstat(file)
  if (
    current.dev !== before.dev ||
    current.ino !== before.ino ||
    current.size !== before.size ||
    current.mtimeMs !== before.mtimeMs ||
    (await readNodeSessionFile(file)).sessionId !== previous.sessionId
  ) {
    return false
  }
  await unlink(file)
  return true
}

/** Publish one private discovery record without replacing a reachable service's record. */
export async function createNodeSessionFile(
  path: string,
  value: NodeSessionRecord,
  options: { recoverStale?: boolean } = {}
): Promise<{ remove(): Promise<void> }> {
  const file = resolve(path)
  const parent = dirname(file)
  const record = nodeSessionRecordSchema.parse(value)
  const encoded = Buffer.from(JSON.stringify(record))
  if (encoded.length > MAX_SESSION_BYTES) throw new Error('Node CLI session record is oversized')
  await privateDirectory(parent)

  const temporary = resolve(parent, `.node-cli-session-${randomUUID()}.tmp`)
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  let published = false
  try {
    await handle.writeFile(encoded)
    await handle.sync()
    await handle.close()
    try {
      await link(temporary, file)
    } catch (error) {
      if (
        options.recoverStale !== true ||
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        !(await removeStaleSession(file))
      ) {
        throw error
      }
      await link(temporary, file)
    }
    published = true
    await unlink(temporary)
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    if (published) await unlink(file).catch(() => {})
    throw error
  }
  return {
    async remove() {
      let current: NodeSessionRecord
      try {
        current = await readNodeSessionFile(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (current.sessionId === record.sessionId) await unlink(file)
    }
  }
}
