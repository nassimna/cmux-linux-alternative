import { spawnSync } from 'node:child_process'
import { closeSync, constants, openSync } from 'node:fs'
import { link, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { LiveOwnerLock } from './live-owner-lock'

it.skipIf(process.platform !== 'linux')(
  'holds an exclusive live owner fence until close',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-live-owner-'))
    const database = join(directory, 'workspace.sqlite')
    const lockPath = `${database}.live-owner.lock`
    const transferPath = `${database}.writer-transfer.lock`
    try {
      await writeFile(database, '', { mode: 0o600 })
      const first = LiveOwnerLock.acquire(database)
      try {
        expect(() => first.assertDatabasePath(join(directory, 'other.sqlite'))).toThrow(
          'another database'
        )
        expect(() => first.assertDatabasePath(database)).not.toThrow()
        expect(() => LiveOwnerLock.acquire(database)).toThrow('already owned')
      } finally {
        first.close()
      }
      const second = LiveOwnerLock.acquire(database)
      second.close()
      const transferFd = openSync(transferPath, constants.O_RDWR)
      try {
        expect(
          spawnSync('/usr/bin/flock', ['-n', '-s', '3'], {
            stdio: ['ignore', 'ignore', 'pipe', transferFd]
          }).status
        ).toBe(0)
        expect(() => LiveOwnerLock.acquire(database)).toThrow('already owned')
      } finally {
        closeSync(transferFd)
      }
      const alias = join(directory, 'alias.sqlite')
      await symlink(database, alias)
      expect(() => LiveOwnerLock.acquire(alias)).toThrow('private canonical regular file')
      await rm(alias)
      await link(database, alias)
      expect(() => LiveOwnerLock.acquire(alias)).toThrow('private canonical regular file')
      await rm(alias)
      const third = LiveOwnerLock.acquire(database)
      try {
        await rename(database, alias)
        await writeFile(database, '', { mode: 0o600 })
        expect(() => third.assertDatabaseUnchanged()).toThrow('changed while acquiring')
      } finally {
        third.close()
      }
      await rm(lockPath)
      await symlink(database, lockPath)
      expect(() => LiveOwnerLock.acquire(database)).toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
