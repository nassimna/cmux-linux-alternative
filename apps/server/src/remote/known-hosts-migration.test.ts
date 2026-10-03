import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { knownHostsLine, parseHostKeyScan } from './host-key-scanner'
import { migrateApprovedKnownHosts } from './known-hosts-migration'
import { readKnownHostExact, writeKnownHostAtomic } from './known-hosts-store'

const TRUSTED_ID = '11111111-1111-4111-8111-111111111111'
const UNTRUSTED_ID = '22222222-2222-4222-8222-222222222222'
const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAICW+rN56TZ4v2OBKfDzkZK+U+rLj4TvipEzv9bJH5qI3'
const approved = parseHostKeyScan(Buffer.from(`[example.com]:2222 ssh-ed25519 ${KEY}\n`), 'example.com', 2222)

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'known-hosts-migration-'))
  const source = join(parent, 'rust')
  const destination = join(parent, 'node')
  await mkdir(source, { mode: 0o700 })
  await mkdir(destination, { mode: 0o700 })
  const sourceRoot = join(source, 'remote-known-hosts')
  await mkdir(sourceRoot, { mode: 0o700 })
  const trustedPath = join(sourceRoot, `${TRUSTED_ID}.known_hosts`)
  const untrustedPath = join(sourceRoot, `${UNTRUSTED_ID}.known_hosts`)
  await writeKnownHostAtomic(trustedPath, approved)
  await writeKnownHostAtomic(untrustedPath, approved)
  return { parent, sourceRoot, trustedPath, destination,
    input: {
      sourceStatePath: join(source, 'state.sqlite3'),
      destinationStatePath: join(destination, 'working.sqlite3'),
      targets: [
        { remoteTargetId: TRUSTED_ID, host: 'example.com', port: 2222, hostKeyState: 'trusted' as const,
          expectedFingerprint: approved.fingerprint },
        { remoteTargetId: UNTRUSTED_ID, host: 'example.com', port: 2222, hostKeyState: 'untrusted' as const }
      ]
    }
  }
}

describe('Rust known-hosts migration', () => {
  it('publishes only exact trusted records and leaves the Rust source untouched', async () => {
    const sample = await fixture()
    try {
      const before = await readFile(sample.trustedPath)
      const result = await migrateApprovedKnownHosts(sample.input)
      expect(result.copied).toBe(1)
      expect(await readdir(result.root)).toEqual([`${TRUSTED_ID}.known_hosts`])
      expect(await readKnownHostExact(join(result.root, `${TRUSTED_ID}.known_hosts`), 'example.com', 2222))
        .toEqual(approved)
      expect(await readFile(sample.trustedPath)).toEqual(before)
      expect((await lstat(result.root)).mode & 0o777).toBe(0o700)
      await expect(migrateApprovedKnownHosts(sample.input)).rejects.toMatchObject({ code: 'destination_conflict' })
    } finally {
      await rm(sample.parent, { recursive: true, force: true })
    }
  })

  it('rejects fingerprint mismatch and unsafe source without publishing a Node root', async () => {
    const sample = await fixture()
    try {
      const destinationRoot = join(sample.destination, 'remote-known-hosts')
      await expect(migrateApprovedKnownHosts({
        ...sample.input,
        targets: [{ ...sample.input.targets[0]!, expectedFingerprint: 'SHA256:wrong' }]
      })).rejects.toMatchObject({ code: 'host_key_mismatch' })
      await expect(lstat(destinationRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await chmod(sample.trustedPath, 0o644)
      await expect(migrateApprovedKnownHosts(sample.input)).rejects.toMatchObject({ code: 'host_key_mismatch' })
      await expect(lstat(destinationRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(sample.trustedPath)
      await symlink(join(sample.sourceRoot, `${UNTRUSTED_ID}.known_hosts`), sample.trustedPath)
      await expect(migrateApprovedKnownHosts(sample.input)).rejects.toMatchObject({ code: 'host_key_mismatch' })
      await expect(lstat(destinationRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(sample.sourceRoot, `${UNTRUSTED_ID}.known_hosts`), 'utf8'))
        .toBe(knownHostsLine(approved))
      await rm(sample.trustedPath)
      await writeKnownHostAtomic(sample.trustedPath, approved)
      await chmod(sample.sourceRoot, 0o750)
      await expect(migrateApprovedKnownHosts(sample.input)).rejects.toMatchObject({ code: 'unsafe_source' })
      await expect(lstat(destinationRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(sample.destination)).toEqual([])
    } finally {
      await rm(sample.parent, { recursive: true, force: true })
    }
  })
})
