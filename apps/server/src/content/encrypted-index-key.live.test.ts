import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import dbus from 'dbus-next'
import { expect, it } from 'vitest'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { startServer } from '../http/server'
import { TerminalService, type PtyAdapter } from '../terminal/terminal-service'
import { EncryptedIndex } from './encrypted-index'
import { loadOrCreateIndexKey } from './encrypted-index-key'
import { EncryptedVaultSearch } from './encrypted-vault-search'
import { FilesService } from './files-service'

const SERVICE = 'org.freedesktop.secrets'
const SECRET = 'org.freedesktop.Secret'

/** Opt-in test against the user's unlocked Secret Service; owns one UUID-scoped item. */
it.skipIf(process.env.RUN_LIVE_SECRET_SERVICE_INDEX !== '1')(
  'uses a fresh Secret Service key for authenticated encrypted search and removes it',
  async () => {
    const parent = mkdtempSync(join(tmpdir(), 'node-live-index-'))
    chmodSync(parent, 0o700)
    const profile = join(parent, 'profile')
    const root = join(parent, 'files')
    mkdirSync(profile, { mode: 0o700 })
    mkdirSync(root, { mode: 0o700 })
    writeFileSync(join(root, 'wanted.txt'), 'violet café')
    const sourceId = randomUUID()
    const state = {
      readSnapshot: () => ({ workspaces: [{ id: sourceId, name: 'Fixture', workingDirectory: root }] }),
      getAgentSession: () => { throw new Error('No agent session') },
      currentIdempotencyEpoch: () => randomUUID(),
      close: () => {}
    } as unknown as ApplicationStateStore
    let itemId: string | undefined
    let running: ReturnType<typeof startServer> | undefined
    let files: FilesService | undefined
    let search: EncryptedVaultSearch | undefined
    const bus = dbus.sessionBus()
    const searchItems = async (id: string): Promise<[string[], string[]]> => {
      const service = (await bus.getProxyObject(SERVICE, '/org/freedesktop/secrets'))
        .getInterface(`${SECRET}.Service`)
      return await service.SearchItems!({
        application: 'cmux-linux-alternative', kind: 'content-index-key-v1', 'key-id': id
      }) as [string[], string[]]
    }
    try {
      const key = await loadOrCreateIndexKey(profile)
      itemId = readFileSync(join(profile, 'content-index-key-id'), 'utf8').trim()
      expect((await searchItems(itemId))[0]).toHaveLength(1)
      let index: EncryptedIndex
      try {
        index = EncryptedIndex.open(profile, key)
      } finally {
        key.fill(0)
      }
      files = new FilesService(state)
      search = new EncryptedVaultSearch(index, files, state)
      const service = new TerminalService({ spawn: () => { throw new Error('Unexpected PTY spawn') } } as PtyAdapter)
      const token = `test-${randomUUID()}`
      running = startServer({ service, token, port: 0, stateStore: state, filesService: files, vaultSearch: search })
      await new Promise<void>((resolve) => running!.server.once('listening', resolve))
      const address = running.server.address() as AddressInfo
      const base = `http://127.0.0.1:${address.port}`
      expect((await fetch(`${base}/v1/search/query`)).status).toBe(401)
      const client = new AgentWorkspaceClient(base, token)
      expect((await client.identify()).capabilities).toContain('search.query')
      const mutation = (expectedRevision: number) => ({ expectedRevision, idempotencyKey: randomUUID(), requestHash: '0'.repeat(64) })
      expect((await client.searchContent({ query: 'violet', limit: 10, cancellationId: randomUUID() })).results).toEqual([])
      await client.setSearchSourcePolicy({ sourceAuthorizationId: sourceId, sourceKind: 'workspaceFile', retentionDays: 30, exclusionIds: [], mutation: mutation(1) })
      await client.rebuildSearchSource({ sourceAuthorizationId: sourceId, cancellationId: randomUUID(), mutation: mutation(2) })
      expect((await client.searchContent({ query: 'violet', limit: 10, cancellationId: randomUUID() })).results[0]?.snippet).toBe('violet café')
      expect(readFileSync(join(profile, 'index/v1/search.sqlite3')).includes(Buffer.from('violet café'))).toBe(false)
      writeFileSync(join(root, 'wanted.txt'), 'changed after indexing')
      expect((await client.searchContent({ query: 'violet', limit: 10, cancellationId: randomUUID() })).results).toEqual([])
      await client.excludeSearchSource({ sourceAuthorizationId: sourceId, mutation: mutation(3) })
    } finally {
      let closeError: unknown
      let verifiedRemoved = false
      try {
        if (running) await running.close()
        else {
          search?.close()
          files?.close()
        }
      } catch (error) {
        closeError = error
      }
      try {
        if (!itemId && existsSync(join(profile, 'content-index-key-id')))
          itemId = readFileSync(join(profile, 'content-index-key-id'), 'utf8').trim()
        if (itemId) {
          const [unlocked, locked] = await searchItems(itemId)
          for (const path of [...unlocked, ...locked]) {
            const item = (await bus.getProxyObject(SERVICE, path)).getInterface(`${SECRET}.Item`)
            const prompt = await item.Delete!() as string
            if (prompt !== '/') throw new Error('Secret Service item deletion prompted')
          }
          const [remainingUnlocked, remainingLocked] = await searchItems(itemId)
          expect([...remainingUnlocked, ...remainingLocked]).toEqual([])
          console.log(`Disposable index key removed and absent: ${itemId}`)
        }
        verifiedRemoved = true
      } finally {
        bus.disconnect()
        if (verifiedRemoved) rmSync(parent, { recursive: true, force: true })
      }
      if (closeError) throw closeError
    }
  },
  30_000
)
