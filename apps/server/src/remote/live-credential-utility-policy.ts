import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { inspectLegacyDatabase } from '../persistence/legacy-inspection'

export interface LiveCredentialStateProof {
  liveStatePath: string
  backupStatePath: string
  liveStateIdentity: string
  backupStateIdentity: string
  backupSha256: string
}

function privateFile(path: string): string {
  if (!process.getuid || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw new Error('State path must be absolute and canonical')
  const parentPath = dirname(path)
  const parent = lstatSync(parentPath)
  const file = lstatSync(path)
  if (
    !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700 || realpathSync(parentPath) !== parentPath ||
    !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
    file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600
  ) throw new Error('State file must be private')
  return `${file.dev}:${file.ino}`
}

function exactFileSha256(path: string): string {
  const before = lstatSync(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error('Backup changed while opening')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let count: number
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count))
    const after = lstatSync(path)
    if (
      after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) throw new Error('Backup changed while hashing')
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

/** Verify a previously created, immutable Rust-v15 backup without creating or replacing it. */
export function verifyLiveCredentialStateProof(proof: LiveCredentialStateProof): void {
  const liveIdentity = privateFile(proof.liveStatePath)
  const backupIdentity = privateFile(proof.backupStatePath)
  if (
    proof.liveStatePath === proof.backupStatePath || liveIdentity === backupIdentity ||
    liveIdentity !== proof.liveStateIdentity || backupIdentity !== proof.backupStateIdentity ||
    exactFileSha256(proof.backupStatePath) !== proof.backupSha256
  ) throw new Error('Live state or backup identity differs from handoff proof')
  const report = inspectLegacyDatabase(proof.backupStatePath)
  if (report.snapshotRevision === null || report.legacySnapshotCompatibility)
    throw new Error('Live backup is not a normalized Rust-v15 state')
  if (exactFileSha256(proof.backupStatePath) !== proof.backupSha256 ||
      privateFile(proof.backupStatePath) !== proof.backupStateIdentity)
    throw new Error('Live backup changed during validation')
}
