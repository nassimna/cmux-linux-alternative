import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import {
  HostKeyScanError,
  knownHostsLine,
  parseHostKeyScan,
  type HostKeyDescriptor
} from './host-key-scanner'

const MAX_RECORD_BYTES = 8 * 1024

export class KnownHostsError extends Error {
  public constructor(
    public readonly code: 'unsafe_known_hosts' | 'host_key_mismatch',
    message: string
  ) {
    super(message)
    this.name = 'KnownHostsError'
  }
}

function unsafeKnownHosts(): KnownHostsError {
  return new KnownHostsError('unsafe_known_hosts', 'Known-hosts file is not owner-only')
}

function ownerUid(): number {
  const uid = process.getuid?.()
  if (uid === undefined) throw unsafeKnownHosts()
  return uid
}

async function privateParent(path: string): Promise<string> {
  if (process.platform !== 'linux' || !isAbsolute(path)) throw unsafeKnownHosts()
  const parent = dirname(path)
  try {
    const metadata = await lstat(parent)
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== ownerUid() ||
      (metadata.mode & 0o077) !== 0 ||
      (await realpath(parent)) !== parent
    ) {
      throw unsafeKnownHosts()
    }
  } catch {
    throw unsafeKnownHosts()
  }
  return parent
}

async function privateFile(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== ownerUid() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw unsafeKnownHosts()
  }
  await privateParent(path)
}

async function privateFileIfPresent(path: string): Promise<void> {
  try {
    await privateFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Create or verify an owner-only directory under an owner-only application directory. */
export async function prepareKnownHostsRoot(path: string): Promise<void> {
  await privateParent(join(dirname(path), '.known-hosts-parent'))
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafeKnownHosts()
  }
  await privateParent(join(path, '.known-hosts-child'))
}

/** Replace one target's known-hosts record and fsync the file and private directory. */
export async function writeKnownHostAtomic(
  path: string,
  descriptor: HostKeyDescriptor
): Promise<void> {
  const parent = await privateParent(path)
  const line = knownHostsLine(descriptor)
  const normalized = parseHostKeyScan(Buffer.from(line), descriptor.canonicalHost, descriptor.port)
  if (normalized.fingerprint !== descriptor.fingerprint) {
    throw new KnownHostsError('host_key_mismatch', 'Known-hosts fingerprint does not match key')
  }
  const temporary = join(parent, `.known-hosts-${randomUUID()}.tmp`)
  let renamed = false
  try {
    await privateFileIfPresent(path)
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await file.writeFile(line)
      await file.sync()
    } finally {
      await file.close()
    }
    await privateParent(path)
    await rename(temporary, path)
    renamed = true
    const directory = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    await privateFile(path)
  } catch (error) {
    if (error instanceof KnownHostsError) throw error
    throw unsafeKnownHosts()
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Remove only the exact validated record from a private known-hosts directory. */
export async function removeKnownHostExact(path: string): Promise<void> {
  const parent = await privateParent(path)
  try {
    await privateFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    await unlink(path)
    const directory = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    throw unsafeKnownHosts()
  }
}

/** Read only an exact, owner-only target record before launching strict-host-key SSH. */
export async function readKnownHostExact(
  path: string,
  canonicalHost: string,
  port: number
): Promise<HostKeyDescriptor> {
  try {
    await privateFile(path)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await file.stat()
      if (
        !metadata.isFile() ||
        metadata.uid !== ownerUid() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw unsafeKnownHosts()
      }
      if (metadata.size > MAX_RECORD_BYTES || metadata.size === 0) {
        throw new KnownHostsError('host_key_mismatch', 'Known-hosts record has an invalid size')
      }
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      return parseHostKeyScan(buffer.subarray(0, length), canonicalHost, port)
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof HostKeyScanError && error.code === 'host_key_mismatch') {
      throw new KnownHostsError('host_key_mismatch', error.message)
    }
    if (error instanceof KnownHostsError) throw error
    throw unsafeKnownHosts()
  }
}
