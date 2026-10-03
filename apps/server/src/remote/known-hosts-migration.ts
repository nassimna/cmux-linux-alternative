import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  readKnownHostExact,
  prepareKnownHostsRoot,
  writeKnownHostAtomic
} from './known-hosts-store'

const TARGET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export interface LegacyKnownHostTarget {
  remoteTargetId: string
  host: string
  port: number
  hostKeyState: 'untrusted' | 'trusted' | 'changed' | 'revoked'
  /** Optional independent approval fingerprint when the caller has retained it. */
  expectedFingerprint?: string
}

export class KnownHostsMigrationError extends Error {
  public constructor(
    public readonly code:
      | 'unsafe_source'
      | 'unsafe_destination'
      | 'destination_conflict'
      | 'host_key_mismatch'
      | 'invalid_target'
  ) {
    super(code.replaceAll('_', ' '))
    this.name = 'KnownHostsMigrationError'
  }
}

async function privateDirectory(
  path: string,
  code: 'unsafe_source' | 'unsafe_destination'
): Promise<void> {
  if (
    process.platform !== 'linux' ||
    !process.getuid ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    throw new KnownHostsMigrationError(code)
  }
  try {
    const stat = await lstat(path)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(path)) !== path
    ) {
      throw new KnownHostsMigrationError(code)
    }
  } catch {
    throw new KnownHostsMigrationError(code)
  }
}

async function destinationAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new KnownHostsMigrationError('unsafe_destination')
  }
  throw new KnownHostsMigrationError('destination_conflict')
}

/**
 * Read Rust's exact approved records without modifying the Rust profile.
 * The Node root is published only after every trusted record has been checked.
 * Call before HostKeyAuthority.create, while the destination root is absent.
 */
export async function migrateApprovedKnownHosts(input: {
  sourceStatePath: string
  destinationStatePath: string
  targets: readonly LegacyKnownHostTarget[]
}): Promise<{ copied: number; root: string }> {
  const sourceRoot = join(dirname(input.sourceStatePath), 'remote-known-hosts')
  const destinationRoot = join(dirname(input.destinationStatePath), 'remote-known-hosts')
  if (
    sourceRoot === destinationRoot ||
    !isAbsolute(sourceRoot) ||
    !isAbsolute(destinationRoot) ||
    resolve(sourceRoot) !== sourceRoot ||
    resolve(destinationRoot) !== destinationRoot
  ) {
    throw new KnownHostsMigrationError('unsafe_destination')
  }
  await privateDirectory(dirname(destinationRoot), 'unsafe_destination')
  await destinationAbsent(destinationRoot)
  const trusted = input.targets.filter((target) => target.hostKeyState === 'trusted')
  const ids = new Set<string>()
  for (const target of input.targets) {
    if (
      !TARGET_ID.test(target.remoteTargetId) ||
      ids.has(target.remoteTargetId) ||
      !['trusted', 'untrusted', 'changed', 'revoked'].includes(target.hostKeyState)
    ) {
      throw new KnownHostsMigrationError('invalid_target')
    }
    ids.add(target.remoteTargetId)
  }
  if (trusted.length > 0) await privateDirectory(sourceRoot, 'unsafe_source')
  const stageRoot = join(dirname(destinationRoot), `.remote-known-hosts-${randomUUID()}.tmp`)
  let published = false
  try {
    await prepareKnownHostsRoot(stageRoot)
    for (const target of trusted) {
      const filename = `${target.remoteTargetId}.known_hosts`
      let approved
      try {
        approved = await readKnownHostExact(join(sourceRoot, filename), target.host, target.port)
      } catch {
        throw new KnownHostsMigrationError('host_key_mismatch')
      }
      if (target.expectedFingerprint && approved.fingerprint !== target.expectedFingerprint) {
        throw new KnownHostsMigrationError('host_key_mismatch')
      }
      await writeKnownHostAtomic(join(stageRoot, filename), approved)
      const copied = await readKnownHostExact(join(stageRoot, filename), target.host, target.port)
      if (copied.fingerprint !== approved.fingerprint || copied.publicKey !== approved.publicKey) {
        throw new KnownHostsMigrationError('host_key_mismatch')
      }
    }
    if (trusted.length > 0) await privateDirectory(sourceRoot, 'unsafe_source')
    await privateDirectory(dirname(destinationRoot), 'unsafe_destination')
    await destinationAbsent(destinationRoot)
    await rename(stageRoot, destinationRoot)
    published = true
    const directory = await open(
      dirname(destinationRoot),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return { copied: trusted.length, root: destinationRoot }
  } catch (error) {
    if (error instanceof KnownHostsMigrationError) throw error
    throw new KnownHostsMigrationError('unsafe_destination')
  } finally {
    if (!published) await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}
