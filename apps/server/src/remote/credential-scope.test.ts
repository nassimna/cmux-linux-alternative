import { chmodSync, writeFileSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { CredentialReference } from './credential-provider'
import { IsolatedCredentialScope } from './credential-scope'

const TARGET_ID = '123e4567-e89b-42d3-a456-426614174000'

it('keeps copied target credentials separate from the Rust item and other working copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'node-remote-scope-'))
  try {
    chmodSync(directory, 0o700)
    const first = join(directory, 'first.sqlite3')
    const second = join(directory, 'second.sqlite3')
    writeFileSync(first, '', { mode: 0o600 })
    writeFileSync(second, '', { mode: 0o600 })
    expect(() => IsolatedCredentialScope.load(first)).toThrow()
    const firstScope = IsolatedCredentialScope.loadOrCreate(first)
    const secondScope = IsolatedCredentialScope.loadOrCreate(second)
    expect(IsolatedCredentialScope.load(first).id).toBe(firstScope.id)
    const rustLocator = CredentialReference.forTarget(TARGET_ID).locator
    const firstLocator = CredentialReference.forIsolatedTarget(TARGET_ID, firstScope.id).locator
    const secondLocator = CredentialReference.forIsolatedTarget(TARGET_ID, secondScope.id).locator
    expect(rustLocator).toBe(`v1-${TARGET_ID}`)
    expect(firstLocator).toBe(`v2-${firstScope.id}-${TARGET_ID}`)
    expect(firstLocator).not.toBe(rustLocator)
    expect(secondLocator).not.toBe(firstLocator)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects a copied scope file after its working database is replaced', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'node-remote-scope-replace-'))
  try {
    chmodSync(directory, 0o700)
    const working = join(directory, 'working.sqlite3')
    writeFileSync(working, '', { mode: 0o600 })
    IsolatedCredentialScope.loadOrCreate(working)
    await rename(working, join(directory, 'old.sqlite3'))
    writeFileSync(working, '', { mode: 0o600 })
    expect(() => IsolatedCredentialScope.load(working)).toThrow()
    expect(() => IsolatedCredentialScope.loadOrCreate(working)).toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
