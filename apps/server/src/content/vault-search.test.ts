import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { FilesService } from './files-service'
import { VaultSearch } from './vault-search'

it('indexes only consented workspace text and revokes results on file changes and exclusion', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'node-vault-search-'))
  const root = join(parent, 'root')
  mkdirSync(root)
  writeFileSync(join(root, 'wanted.txt'), 'violet search phrase')
  writeFileSync(join(root, '.secret'), 'violet hidden')
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'package.txt'), 'violet dependency')
  symlinkSync('/etc/passwd', join(root, 'outside.txt'))
  const workspace = { id: randomUUID(), name: 'Fixture', workingDirectory: root }
  const files = new FilesService({ readSnapshot: () => ({ workspaces: [workspace] }) } as unknown as ApplicationStateStore)
  const vault = new VaultSearch(files)
  const query = () => vault.query({ query: 'violet', limit: 100, cancellationId: randomUUID() })
  try {
    expect((await query()).results).toEqual([])
    expect(() => vault.policy({ sourceAuthorizationId: workspace.id, sourceKind: 'agentTranscript',
      retentionDays: 30, exclusionIds: [], mutation: { expectedRevision: 1 } })).toThrowError(
      expect.objectContaining({ code: 'unauthorized' }))
    const enabled = vault.policy({ sourceAuthorizationId: workspace.id, sourceKind: 'workspaceFile',
      retentionDays: 30, exclusionIds: [], mutation: { expectedRevision: 1 } })
    expect(enabled.revision).toBe(2)
    expect((await query()).results).toEqual([])
    const rebuilt = await vault.rebuild({ sourceAuthorizationId: workspace.id,
      cancellationId: randomUUID(), mutation: { expectedRevision: 2 } })
    expect(rebuilt).toMatchObject({ state: 'enabled', revision: 3 })
    const matches = (await query()).results
    expect(matches).toHaveLength(1)
    expect(matches[0]!.snippet).toContain('violet search phrase')
    const confirmation = vault.issueExport({ sourceAuthorizationId: workspace.id }).confirmation
    const exported = vault.export({ sourceAuthorizationId: workspace.id, confirmationId: confirmation.confirmationId })
    expect(JSON.parse(exported.artifact.text)).toMatchObject({ sourceAuthorizationId: workspace.id, documentCount: 1 })
    expect(() => vault.export({ sourceAuthorizationId: workspace.id,
      confirmationId: confirmation.confirmationId })).toThrowError(expect.objectContaining({ code: 'unauthorized' }))
    expect(vault.cancel({ cancellationId: randomUUID() })).toEqual({ cancelled: false })
    writeFileSync(join(root, 'wanted.txt'), 'changed after indexing')
    expect((await query()).results).toEqual([])
    vault.exclude({ sourceAuthorizationId: workspace.id, mutation: { expectedRevision: 3 } })
    expect((await query()).results).toEqual([])
    await expect(vault.rebuild({ sourceAuthorizationId: workspace.id,
      cancellationId: randomUUID(), mutation: { expectedRevision: 4 } })).rejects.toThrowError(
      expect.objectContaining({ code: 'unauthorized' }))
  } finally {
    vault.close()
    files.close()
    rmSync(parent, { recursive: true, force: true })
  }
})
