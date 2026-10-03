import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isolatedIndexProfile } from './encrypted-index-profile'

it('denies a copied state file beside the Rust profile index and symlink aliases before key access', () => {
  const parent = mkdtempSync(join(tmpdir(), 'node-index-profile-'))
  chmodSync(parent, 0o700)
  const sourceProfile = join(parent, 'source')
  const workingProfile = join(parent, 'working')
  mkdirSync(sourceProfile, { mode: 0o700 })
  mkdirSync(workingProfile, { mode: 0o700 })
  symlinkSync(sourceProfile, join(parent, 'source-alias'))
  try {
    expect(() =>
      isolatedIndexProfile(
        join(sourceProfile, 'state.sqlite3'),
        join(sourceProfile, 'working.sqlite3')
      )
    ).toThrow()
    expect(() =>
      isolatedIndexProfile(
        join(sourceProfile, 'state.sqlite3'),
        join(parent, 'source-alias', 'working.sqlite3')
      )
    ).toThrow()
    expect(
      isolatedIndexProfile(
        join(sourceProfile, 'state.sqlite3'),
        join(workingProfile, 'state.sqlite3')
      )
    ).toBe(workingProfile)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
