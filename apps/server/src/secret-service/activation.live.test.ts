import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { SecretServiceIndexSecretStore } from '../content/encrypted-index-key'
import { CredentialReference } from '../remote/credential-provider'
import { probeExactCredentialPresence } from '../remote/credential-secret-service'

/** Read-only session probe. It never creates, unlocks, or deletes a wallet item. */
it.skipIf(process.env.RUN_LIVE_KDE_SECRET_SERVICE !== '1')(
  'uses the Linux Secret Service for exact missing-item lookups',
  async () => {
    const id = randomUUID()
    const index = await new SecretServiceIndexSecretStore().findExact(id)
    expect(index).toEqual({ unlocked: [], locked: 0 })

    const credential = CredentialReference.forIsolatedTarget(id, randomUUID())
    expect(await probeExactCredentialPresence(credential)).toBe('missing')
  }
)
