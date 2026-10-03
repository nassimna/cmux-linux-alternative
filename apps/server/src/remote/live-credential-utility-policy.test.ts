import { createHash } from 'node:crypto'
import { chmod, copyFile, link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { inspectLegacyDatabase } from '../persistence/legacy-inspection'
import { verifyLiveCredentialStateProof } from './live-credential-utility-policy'

vi.mock('../persistence/legacy-inspection', () => ({
  inspectLegacyDatabase: vi.fn(() => ({ snapshotRevision: 3, legacySnapshotCompatibility: false }))
}))

const directories: string[] = []
afterEach(async () => {
  vi.mocked(inspectLegacyDatabase).mockClear()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'live-credential-proof-'))
  directories.push(directory)
  await chmod(directory, 0o700)
  const liveStatePath = join(directory, 'state.sqlite3')
  const backupStatePath = join(directory, 'state-backup.sqlite3')
  await writeFile(liveStatePath, 'live state', { mode: 0o600 })
  await copyFile(liveStatePath, backupStatePath)
  await chmod(backupStatePath, 0o600)
  const identity = (path: string) => {
    const file = statSync(path)
    return `${file.dev}:${file.ino}`
  }
  return {
    directory,
    proof: {
      liveStatePath,
      backupStatePath,
      liveStateIdentity: identity(liveStatePath),
      backupStateIdentity: identity(backupStatePath),
      backupSha256: createHash('sha256').update('live state').digest('hex')
    }
  }
}

it.skipIf(process.platform !== 'linux')('binds a preexisting backup to exact live and backup files', async () => {
  const { proof } = await fixture()
  expect(() => verifyLiveCredentialStateProof(proof)).not.toThrow()
  expect(inspectLegacyDatabase).toHaveBeenCalledWith(proof.backupStatePath)
  expect(() => verifyLiveCredentialStateProof({ ...proof, liveStateIdentity: '1:2' })).toThrow()
  expect(() => verifyLiveCredentialStateProof({ ...proof, backupSha256: '0'.repeat(64) })).toThrow()
})

it.skipIf(process.platform !== 'linux')('rejects replaced, linked, or unnormalized backups', async () => {
  const { proof } = await fixture()
  await rm(proof.backupStatePath)
  await writeFile(proof.backupStatePath, 'live state', { mode: 0o600 })
  expect(() => verifyLiveCredentialStateProof(proof)).toThrow()
  await rm(proof.backupStatePath)
  await link(proof.liveStatePath, proof.backupStatePath)
  expect(() => verifyLiveCredentialStateProof(proof)).toThrow()
  await rm(proof.backupStatePath)
  await copyFile(proof.liveStatePath, proof.backupStatePath)
  await chmod(proof.backupStatePath, 0o600)
  const replacement = statSync(proof.backupStatePath)
  const current = { ...proof, backupStateIdentity: `${replacement.dev}:${replacement.ino}` }
  vi.mocked(inspectLegacyDatabase).mockReturnValueOnce({
    snapshotRevision: null,
    legacySnapshotCompatibility: false
  } as ReturnType<typeof inspectLegacyDatabase>)
  expect(() => verifyLiveCredentialStateProof(current)).toThrow()
})
