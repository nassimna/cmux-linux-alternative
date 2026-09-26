import { chmodSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { activeCredentialReference, SecretServiceCredentialProvider } from './credential-secret-service'
import { IsolatedCredentialScope } from './credential-scope'

const targetId = '00000000-0000-4000-8000-000000000001'
const scopeId = '00000000-0000-4000-8000-000000000002'

it('uses Rust v1 only for explicit eligibility and never resurrects it after v2 commit', () => {
  expect(activeCredentialReference(targetId, scopeId).locator).toBe(`v2-${scopeId}-${targetId}`)
  expect(activeCredentialReference(targetId, scopeId, 'v1_eligible').locator).toBe(`v1-${targetId}`)
  expect(activeCredentialReference(targetId, scopeId, 'v2_committed').locator).toBe(
    `v2-${scopeId}-${targetId}`
  )
  expect(() => activeCredentialReference(targetId, scopeId, 'unmarked')).toThrow()
})

it('never probes v1 from an isolated-copy credential provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'node-v1-credential-boundary-'))
  try {
    chmodSync(directory, 0o700)
    const working = join(directory, 'working.sqlite3')
    writeFileSync(working, '', { mode: 0o600 })
    const provider = await SecretServiceCredentialProvider.create(
      join(directory, 'remote-agent-brokers'),
      IsolatedCredentialScope.loadOrCreate(working)
    )
    await expect(provider.hasV1(targetId)).rejects.toMatchObject({ code: 'credential_required' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
