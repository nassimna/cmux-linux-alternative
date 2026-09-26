import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { knownHostsLine, parseHostKeyScan } from './host-key-scanner'
import { readKnownHostExact, writeKnownHostAtomic } from './known-hosts-store'

const PUBLIC_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAICW+rN56TZ4v2OBKfDzkZK+U+rLj4TvipEzv9bJH5qI3'
const descriptor = parseHostKeyScan(
  Buffer.from(`[example.com]:2222 ssh-ed25519 ${PUBLIC_KEY}\n`),
  'example.com',
  2222
)

describe('owner-only known-hosts persistence', () => {
  it('atomically replaces exactly one record and rejects a mismatched or unsafe file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-known-hosts-'))
    const path = join(directory, 'target.known_hosts')
    try {
      await writeKnownHostAtomic(path, descriptor)
      expect(await readFile(path, 'utf8')).toBe(knownHostsLine(descriptor))
      expect((await lstat(path)).mode & 0o777).toBe(0o600)
      expect(await readKnownHostExact(path, 'example.com', 2222)).toEqual(descriptor)
      await expect(readKnownHostExact(path, 'other.example', 2222)).rejects.toMatchObject({
        code: 'host_key_mismatch'
      })
      await expect(
        writeKnownHostAtomic(path, { ...descriptor, fingerprint: 'SHA256:wrong' })
      ).rejects.toMatchObject({ code: 'host_key_mismatch' })
      expect(await readFile(path, 'utf8')).toBe(knownHostsLine(descriptor))
      expect(await readdir(directory)).toEqual(['target.known_hosts'])

      await chmod(path, 0o644)
      await expect(readKnownHostExact(path, 'example.com', 2222)).rejects.toMatchObject({
        code: 'unsafe_known_hosts'
      })
      await expect(writeKnownHostAtomic(path, descriptor)).rejects.toMatchObject({
        code: 'unsafe_known_hosts'
      })
      await chmod(path, 0o600)
      await writeKnownHostAtomic(path, descriptor)
      await writeFile(path, `${knownHostsLine(descriptor)}${knownHostsLine(descriptor)}`)
      await expect(readKnownHostExact(path, 'example.com', 2222)).rejects.toMatchObject({
        code: 'host_key_mismatch'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects symlinked and group-accessible parent directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-known-hosts-parent-'))
    const privateDirectory = join(directory, 'private')
    const link = join(directory, 'link')
    try {
      await mkdir(privateDirectory, { mode: 0o700 })
      await symlink(privateDirectory, link)
      await expect(writeKnownHostAtomic(join(link, 'target'), descriptor)).rejects.toMatchObject({
        code: 'unsafe_known_hosts'
      })
      await chmod(privateDirectory, 0o750)
      await expect(
        writeKnownHostAtomic(join(privateDirectory, 'target'), descriptor)
      ).rejects.toMatchObject({ code: 'unsafe_known_hosts' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
