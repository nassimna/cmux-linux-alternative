import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ControlTokenStore, type TokenCipher } from './control-token-store'

const testCipher: TokenCipher = {
  decrypt: (value) => Buffer.from(value).reverse().toString('utf8'),
  encrypt: (value) => Buffer.from(value).reverse(),
  isSecure: () => true
}

describe('ControlTokenStore', () => {
  it('creates and reuses a 256-bit control token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-token-'))
    const path = join(directory, 'secrets', 'control-token.enc')
    const store = new ControlTokenStore(path, testCipher)

    const first = await store.loadOrCreate()
    const second = await store.loadOrCreate()

    expect(Buffer.from(first, 'base64url')).toHaveLength(32)
    expect(second).toBe(first)
    expect((await readFile(path)).toString()).not.toContain(first)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, 'secrets'))).mode & 0o777).toBe(0o700)
    }
  })

  it('uses an ephemeral token when secure credential storage is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-ephemeral-token-'))
    const path = join(directory, 'control-token.enc')
    const store = new ControlTokenStore(path, {
      ...testCipher,
      isSecure: () => false
    })

    const first = await store.loadOrCreate()
    const second = await store.loadOrCreate()

    expect(Buffer.from(first, 'base64url')).toHaveLength(32)
    expect(second).not.toBe(first)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked credential file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-symlink-token-'))
    const target = join(directory, 'target')
    const path = join(directory, 'control-token.enc')
    await writeFile(target, testCipher.encrypt('0123456789abcdef0123456789abcdef'))
    await symlink(target, path)

    await expect(new ControlTokenStore(path, testCipher).loadOrCreate()).rejects.toThrow(
      'regular file'
    )
  })
})
