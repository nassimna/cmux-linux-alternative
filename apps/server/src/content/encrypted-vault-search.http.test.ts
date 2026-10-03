import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentWorkspaceClient, createNodeSessionFile } from '@agent-workspace/client-runtime'
import { searchQueryResultSchema } from '@agent-workspace/contracts'
import { expect, it } from 'vitest'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { TerminalService, type PtyAdapter } from '../terminal/terminal-service'
import { startServer } from '../http/server'
import { EncryptedIndex } from './encrypted-index'
import { EncryptedVaultSearch } from './encrypted-vault-search'
import { FilesService } from './files-service'

it('serves authenticated encrypted search and revalidates a changed file', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'node-encrypted-search-http-'))
  chmodSync(parent, 0o700)
  const root = join(parent, 'root')
  mkdirSync(root)
  writeFileSync(join(root, 'wanted.txt'), 'violet café')
  const source = randomUUID()
  const workspace = { id: source, name: 'Fixture', workingDirectory: root }
  const state = {
    readSnapshot: () => ({ workspaces: [workspace] }),
    getAgentSession: () => { throw new Error('No agent session') },
    currentIdempotencyEpoch: () => randomUUID(),
    close: () => {}
  } as unknown as ApplicationStateStore
  const files = new FilesService(state)
  const search = new EncryptedVaultSearch(EncryptedIndex.open(parent, Buffer.alloc(32, 7)), files, state)
  const pty: PtyAdapter = { spawn: () => { throw new Error('Unexpected PTY spawn') } }
  const service = new TerminalService(pty)
  const token = 'test-token-0123456789-0123456789-abcdef'
  const mutation = (expectedRevision: number) => ({ expectedRevision, idempotencyKey: randomUUID(), requestHash: '0'.repeat(64) })
  const running = startServer({ service, token, port: 0, stateStore: state, filesService: files, vaultSearch: search })
  try {
    await new Promise<void>((resolve) => running.server.once('listening', resolve))
    const address = running.server.address() as AddressInfo
    const base = `http://127.0.0.1:${address.port}`
    expect((await fetch(`${base}/v1/search/query`)).status).toBe(401)
    const client = new AgentWorkspaceClient(base, token)
    expect((await client.identify()).capabilities).toContain('search.query')
    expect((await client.searchContent({ query: 'violet', limit: 10, cancellationId: randomUUID() })).results).toEqual([])
    const policy = await client.setSearchSourcePolicy({ sourceAuthorizationId: source, sourceKind: 'workspaceFile', retentionDays: 30, exclusionIds: [], mutation: mutation(1) })
    expect(policy.state).toBe('enabled')
    const rebuilt = await client.rebuildSearchSource({ sourceAuthorizationId: source, cancellationId: randomUUID(), mutation: mutation(2) })
    expect(rebuilt.state).toBe('enabled')
    const result = await client.searchContent({ query: 'violet café', limit: 10, cancellationId: randomUUID() })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.snippet).toBe('violet café')
    if (process.env.RUN_SEARCH_CLI_CONTRACT === '1') {
      const sessionFile = join(parent, 'node-session.json')
      const guard = await createNodeSessionFile(sessionFile, {
        application: 'agent-workspace', apiVersion: 1, baseUrl: `${base}/`, token, sessionId: randomUUID()
      })
      try {
        const cli = fileURLToPath(new URL('../../../cli/dist/bin.mjs', import.meta.url))
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [cli, '--session-file', sessionFile, 'search', 'query', '--params-json',
            JSON.stringify({ query: 'violet café', limit: 10, cancellationId: randomUUID() })], { stdio: ['ignore', 'pipe', 'pipe'] })
          let stdout = '', stderr = ''
          child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data })
          child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data })
          child.once('error', reject)
          child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`CLI exited ${code}: ${stderr}`)))
        })
        expect(searchQueryResultSchema.parse(JSON.parse(output)).results[0]?.snippet).toBe('violet café')
      } finally { await guard.remove() }
    }
    const confirmation = await client.issueSearchExportConfirmation({ sourceAuthorizationId: source })
    const exported = await client.exportSearchSource({ sourceAuthorizationId: source, confirmationId: confirmation.confirmation.confirmationId })
    expect(JSON.parse(exported.artifact.text)).toMatchObject({ documentCount: 1, tokenCount: 2 })
    writeFileSync(join(root, 'wanted.txt'), 'changed after indexing')
    expect((await client.searchContent({ query: 'violet', limit: 10, cancellationId: randomUUID() })).results).toEqual([])
    await client.excludeSearchSource({ sourceAuthorizationId: source, mutation: mutation(3) })
    expect((await client.searchContent({ query: 'violet', limit: 10, cancellationId: randomUUID() })).results).toEqual([])
  } finally { await running.close(); rmSync(parent, { recursive: true, force: true }) }
})
