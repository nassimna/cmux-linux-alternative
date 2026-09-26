import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNodeSessionFile, readNodeSessionFile } from '@agent-workspace/client-runtime'
import { expect, it } from 'vitest'

const record = () => ({
  application: 'agent-workspace' as const,
  apiVersion: 1 as const,
  baseUrl: 'http://127.0.0.1:3774/',
  token: 'private-token-0123456789-0123456789',
  sessionId: randomUUID()
})

it.skipIf(process.platform !== 'linux')(
  'publishes an owner-only record, rejects insecure paths, and preserves a newer session',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-node-session-'))
    const path = join(directory, 'session.json')
    const alias = join(directory, 'session-link.json')
    try {
      const first = record()
      const oldGuard = await createNodeSessionFile(path, first)
      expect(await readNodeSessionFile(path)).toEqual(first)
      expect((await lstat(directory)).mode & 0o077).toBe(0)
      expect((await lstat(path)).mode & 0o077).toBe(0)
      await expect(createNodeSessionFile(path, record())).rejects.toMatchObject({
        code: 'EEXIST'
      })
      await symlink(path, alias)
      await expect(readNodeSessionFile(alias)).rejects.toThrow('private regular file')
      await chmod(path, 0o644)
      await expect(readNodeSessionFile(path)).rejects.toThrow('private regular file')
      await chmod(path, 0o600)
      await chmod(directory, 0o755)
      await expect(readNodeSessionFile(path)).rejects.toThrow('directory must be private')
      await chmod(directory, 0o700)
      await unlink(path)
      const second = record()
      const newGuard = await createNodeSessionFile(path, second)
      await oldGuard.remove()
      expect(await readNodeSessionFile(path)).toEqual(second)
      await newGuard.remove()
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
