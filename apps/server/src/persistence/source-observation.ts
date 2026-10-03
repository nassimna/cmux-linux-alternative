import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { inspectLegacyDatabase, type LegacyDatabaseReport } from './legacy-inspection'
import { logicalDatabaseDigest } from './logical-database-digest'

export interface SourceObservation {
  path: string
  identity: string
  size: number
  sha256: string
  walSha256: string | null
  logicalSha256: string
  database: LegacyDatabaseReport
}

async function stamp(path: string): Promise<string | null> {
  try {
    const file = await lstat(path, { bigint: true })
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1n ||
      file.uid !== BigInt(process.getuid!()) ||
      (file.mode & 0o077n) !== 0n
    ) {
      throw new Error('source database or WAL is unsafe')
    }
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function digest(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({
      autoClose: false
    }) as AsyncIterable<Buffer>) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** Read-only, race-detecting view of a Rust database and its WAL. */
export async function observeSource(path: string): Promise<SourceObservation> {
  if (process.platform !== 'linux' || !process.getuid || resolve(path) !== path) {
    throw new Error('canonical Linux source path required')
  }
  if ((await realpath(path)) !== path) throw new Error('source path must be canonical')
  const before = await stamp(path)
  if (before === null) throw new Error('source database is absent')
  const walPath = `${path}-wal`
  const walBefore = await stamp(walPath)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-workspace-source-observation-'))
  let database: LegacyDatabaseReport
  let logicalSha256: string
  try {
    const snapshot = join(temporary, 'source.sqlite3')
    await copyFile(path, snapshot)
    if (walBefore !== null) await copyFile(walPath, `${snapshot}-wal`)
    database = inspectLegacyDatabase(snapshot)
    logicalSha256 = logicalDatabaseDigest(snapshot)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  const sha256 = await digest(path)
  const walSha256 = walBefore === null ? null : await digest(walPath)
  if (before !== (await stamp(path)) || walBefore !== (await stamp(walPath))) {
    throw new Error('source changed during observation')
  }
  const file = await lstat(path)
  return {
    path,
    identity: `${file.dev}:${file.ino}`,
    size: file.size,
    sha256,
    walSha256,
    logicalSha256,
    database
  }
}

export function sameSourceObservation(a: SourceObservation, b: SourceObservation): boolean {
  return (
    a.path === b.path &&
    a.identity === b.identity &&
    a.size === b.size &&
    a.sha256 === b.sha256 &&
    a.walSha256 === b.walSha256 &&
    a.logicalSha256 === b.logicalSha256 &&
    a.database.snapshotRevision === b.database.snapshotRevision
  )
}
