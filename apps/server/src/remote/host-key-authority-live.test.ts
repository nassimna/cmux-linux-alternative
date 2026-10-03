import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { HostKeyAuthority, type HostKeyTarget } from './host-key-authority'
import { parseHostKeyScan } from './host-key-scanner'
import { writeKnownHostAtomic } from './known-hosts-store'

const target: HostKeyTarget = {
  remoteTargetId: '00000000-0000-4000-8000-000000000001',
  host: 'example.com',
  port: 2222,
  hostKeyState: 'trusted',
  revision: 1
}
const descriptor = parseHostKeyScan(
  Buffer.from(
    '[example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICW+rN56TZ4v2OBKfDzkZK+U+rLj4TvipEzv9bJH5qI3\n'
  ),
  target.host,
  target.port
)
const scanner = { scan: async () => descriptor }

it.skipIf(process.platform !== 'linux')(
  'requires the exact live approved key before accepting a trusted target',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-live-host-keys-'))
    const root = join(directory, 'remote-known-hosts')
    const stateDatabasePath = join(directory, 'state.sqlite3')
    try {
      await expect(HostKeyAuthority.openLive(stateDatabasePath, [target], scanner)).rejects.toThrow(
        'missing or unsafe'
      )
      await mkdir(root, { mode: 0o700 })
      await expect(
        HostKeyAuthority.openLive(stateDatabasePath, [target], scanner)
      ).rejects.toThrow()
      const path = join(root, `${target.remoteTargetId}.known_hosts`)
      await writeKnownHostAtomic(path, descriptor)
      await expect(
        HostKeyAuthority.openLive(stateDatabasePath, [target], scanner)
      ).resolves.toBeInstanceOf(HostKeyAuthority)
      await writeFile(path, '[example.com]:2222 ssh-ed25519 invalid\n', { mode: 0o600 })
      await expect(
        HostKeyAuthority.openLive(stateDatabasePath, [target], scanner)
      ).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
