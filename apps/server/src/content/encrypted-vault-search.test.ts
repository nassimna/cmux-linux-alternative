import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { EncryptedIndex } from './encrypted-index'
import { EncryptedVaultSearch } from './encrypted-vault-search'
import { FilesService } from './files-service'

it('pages past stale matches and reports whether another accessible result exists', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'node-encrypted-search-pages-'))
  chmodSync(parent, 0o700)
  const root = join(parent, 'root')
  mkdirSync(root)
  writeFileSync(join(root, 'first.txt'), 'needle first')
  writeFileSync(join(root, 'second.txt'), 'needle second')
  const source = randomUUID()
  const state = {
    readSnapshot: () => ({ workspaces: [{ id: source, name: 'Fixture', workingDirectory: root }] }),
    getAgentSession: () => { throw new Error('No agent session') }
  } as unknown as ApplicationStateStore
  const files = new FilesService(state)
  const index = EncryptedIndex.open(parent, Buffer.alloc(32, 7))
  const search = new EncryptedVaultSearch(index, files, state)
  try {
    search.policy({ sourceAuthorizationId: source, sourceKind: 'workspaceFile', retentionDays: 30,
      exclusionIds: [], mutation: { expectedRevision: 1 } })
    const descriptor = files.listRoots({ limit: 64 }).roots[0]!
    const entries = files.listDirectory({ directoryDescriptorId: descriptor.directoryDescriptorId,
      generation: descriptor.generation, limit: 100, cancellationId: randomUUID() }).entries
    const documents = entries.map((entry) => files.issueDocument({
      authorizedDescriptorId: entry.entryDescriptorId,
      descriptorGeneration: entry.generation,
      expectedKind: 'plainText'
    }).document)
    const now = Date.now()
    const options = (indexedAtMs: number) => ({ maxBytes: 1024, deadlineMs: Date.now() + 10_000, indexedAtMs })
    index.indexText(source, documents[0]!, 'workspaceFile', 'needle first', options(now - 1))
    index.indexText(source, documents[1]!, 'workspaceFile', 'needle second', options(now - 2))
    for (let number = 0; number < 101; number++) {
      index.indexText(source, { documentId: randomUUID(), identityVersion: 1 }, 'workspaceFile',
        'needle stale', options(now + 1))
    }
    const query = (limit: number) => search.query({ query: 'needle', limit,
      cancellationId: randomUUID(), sourceAuthorizationIds: [source] })
    expect(await query(1)).toMatchObject({
      results: [{ document: documents[0] }], truncated: true
    })
    expect(await query(2)).toMatchObject({ results: [
      { document: documents[0] }, { document: documents[1] }
    ], truncated: false })
    writeFileSync(join(root, 'second.txt'), 'changed')
    expect(await query(1)).toMatchObject({
      results: [{ document: documents[0] }], truncated: false
    })
    await expect(query(0)).rejects.toMatchObject({ code: 'resource_limit' })
  } finally {
    search.close()
    files.close()
    rmSync(parent, { recursive: true, force: true })
  }
})
