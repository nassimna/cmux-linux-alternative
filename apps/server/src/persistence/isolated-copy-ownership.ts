import { createHash } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { z } from 'zod'

import { inspectLegacyDatabase } from './legacy-inspection'
import { logicalDatabaseDigest } from './logical-database-digest'
import { observeSource, sameSourceObservation, type SourceObservation } from './source-observation'

const baseManifestSchema = z.object({
  source: z.string(),
  backup: z.string(),
  working: z.string(),
  backupSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backupIdentity: z.string(),
  workingIdentity: z.string()
})

const manifestSchema = z.discriminatedUnion('version', [
  baseManifestSchema.extend({ version: z.literal(1) }).strict(),
  baseManifestSchema
    .extend({
      version: z.literal(2),
      sourceIdentity: z.string(),
      sourceSnapshotRevision: z.number().int().nonnegative(),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      sourceWalSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
    })
    .strict(),
  baseManifestSchema
    .extend({
      version: z.literal(3),
      sourceIdentity: z.string(),
      sourceSnapshotRevision: z.number().int().nonnegative(),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      sourceWalSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      sourceLogicalSha256: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict()
])

type Manifest = z.infer<typeof manifestSchema>

function identity(path: string): string {
  const file = lstatSync(path)
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    (file.mode & 0o077) !== 0 ||
    file.uid !== process.getuid?.()
  ) {
    throw new Error('Isolated database must be an owner-only regular file')
  }
  return `${file.dev}:${file.ino}`
}

function privateDirectory(path: string): void {
  const parent = lstatSync(dirname(path))
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    parent.uid !== process.getuid?.()
  ) {
    throw new Error('Isolated database directory must be private and owned by this user')
  }
}

async function digest(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const hash = createHash('sha256')
  try {
    for await (const chunk of file.createReadStream({
      autoClose: false
    }) as AsyncIterable<Buffer>) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

function manifestPath(working: string): string {
  return `${working}.copy-manifest.json`
}

export async function recordIsolatedCopy(
  source: string,
  backup: string,
  working: string,
  sourceObservation: SourceObservation
): Promise<void> {
  privateDirectory(backup)
  privateDirectory(working)
  const sourceReal = await realpath(source)
  if (sourceReal !== resolve(source)) throw new Error('Source path must be canonical')
  const backupIdentity = identity(backup)
  const workingIdentity = identity(working)
  const sourceIdentity = identity(source)
  const observed = await observeSource(source)
  if (!sameSourceObservation(sourceObservation, observed)) {
    throw new Error('Source changed while preparing isolated copy')
  }
  if (observed.database.snapshotRevision === null) {
    throw new Error('Source snapshot revision is absent')
  }
  if (logicalDatabaseDigest(backup) !== observed.logicalSha256) {
    throw new Error('Backup contents differ from observed source contents')
  }
  if (
    backupIdentity === workingIdentity ||
    backupIdentity === sourceIdentity ||
    workingIdentity === sourceIdentity
  ) {
    throw new Error('Isolated database files must have distinct identities')
  }
  const manifest: Manifest = {
    version: 3,
    source: sourceReal,
    backup: resolve(backup),
    working: resolve(working),
    backupSha256: await digest(backup),
    backupIdentity,
    workingIdentity,
    sourceIdentity,
    sourceSnapshotRevision: observed.database.snapshotRevision,
    sourceSha256: observed.sha256,
    sourceWalSha256: observed.walSha256,
    sourceLogicalSha256: observed.logicalSha256
  }
  const file = await open(
    manifestPath(working),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await file.writeFile(JSON.stringify(manifest))
    await file.sync()
  } finally {
    await file.close()
  }
  const directory = await open(dirname(working), constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function verifyIsolatedCopy(
  source: string,
  backup: string,
  working: string
): Promise<Manifest> {
  privateDirectory(backup)
  privateDirectory(working)
  const marker = manifestPath(working)
  const markerFile = await lstat(marker)
  if (
    !markerFile.isFile() ||
    markerFile.isSymbolicLink() ||
    (markerFile.mode & 0o077) !== 0 ||
    markerFile.uid !== process.getuid?.() ||
    markerFile.nlink !== 1 ||
    markerFile.size > 4096
  ) {
    throw new Error('Isolated copy manifest is unsafe')
  }
  const markerFd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
  let markerText: string
  try {
    const opened = fstatSync(markerFd)
    if (opened.dev !== markerFile.dev || opened.ino !== markerFile.ino || opened.size > 4096) {
      throw new Error('Isolated copy manifest changed while opening')
    }
    markerText = readFileSync(markerFd, 'utf8')
  } finally {
    closeSync(markerFd)
  }
  const manifest = manifestSchema.parse(JSON.parse(markerText))
  const sourceReal = await realpath(source)
  if (
    sourceReal !== resolve(source) ||
    manifest.source !== sourceReal ||
    manifest.backup !== resolve(backup) ||
    manifest.working !== resolve(working)
  ) {
    throw new Error('Isolated copy paths do not match their manifest')
  }
  if (
    identity(backup) !== manifest.backupIdentity ||
    identity(working) !== manifest.workingIdentity ||
    identity(source) === manifest.backupIdentity ||
    identity(source) === manifest.workingIdentity
  ) {
    throw new Error('Isolated copy file identities changed')
  }
  if ((await digest(backup)) !== manifest.backupSha256) {
    throw new Error('Isolated backup changed after preparation')
  }
  inspectLegacyDatabase(backup)
  inspectLegacyDatabase(working)
  return manifest
}

/** Extra qualification for cutover; old preview copies remain resumable. */
export async function verifySourceBoundCopy(
  source: string,
  backup: string,
  working: string,
  observed?: SourceObservation
): Promise<void> {
  const manifest = await verifyIsolatedCopy(source, backup, working)
  if (manifest.version !== 3) throw new Error('Copy manifest has no full source binding')
  const current = await observeSource(source)
  if (observed && !sameSourceObservation(observed, current)) {
    throw new Error('Source changed during cutover observation')
  }
  if (
    manifest.sourceIdentity !== current.identity ||
    manifest.sourceSnapshotRevision !== current.database.snapshotRevision ||
    manifest.sourceSha256 !== current.sha256 ||
    manifest.sourceWalSha256 !== current.walSha256
  ) {
    throw new Error('Source changed since isolated copy preparation')
  }
  if (
    manifest.sourceLogicalSha256 !== current.logicalSha256 ||
    logicalDatabaseDigest(backup) !== current.logicalSha256
  ) {
    throw new Error('Backup contents differ from bound source contents')
  }
  const backupRevision = inspectLegacyDatabase(backup).snapshotRevision
  if (backupRevision !== manifest.sourceSnapshotRevision) {
    throw new Error('Backup revision differs from bound source revision')
  }
}

export class IsolatedCopyLock {
  private closed = false

  private constructor(
    private readonly path: string,
    private readonly fd: number,
    private readonly device: number,
    private readonly inode: number
  ) {}

  public static acquire(working: string): IsolatedCopyLock {
    privateDirectory(working)
    const path = `${working}.owner.lock`
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, working: resolve(working) }))
      fsyncSync(fd)
      const file = fstatSync(fd)
      return new IsolatedCopyLock(path, fd, file.dev, file.ino)
    } catch (error) {
      closeSync(fd)
      unlinkSync(path)
      throw error
    }
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    try {
      const current = lstatSync(this.path)
      if (current.dev === this.device && current.ino === this.inode) unlinkSync(this.path)
    } finally {
      closeSync(this.fd)
    }
  }
}
