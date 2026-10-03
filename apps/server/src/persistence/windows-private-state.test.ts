import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireWindowsPrivateLock,
  assertWindowsPrivatePath,
  createNodeSessionFile,
  createWindowsPrivateFile,
  ensureWindowsPrivateDirectory,
  readNodeSessionFile
} from '@agent-workspace/client-runtime'
import { expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { durableApplicationStateSchema } from '@agent-workspace/contracts'

import { closeTab } from '../domain/workspace-mutations'
import { reopenClosedTab } from '../domain/recently-closed-mutations'
import { DiagnosticService } from '../diagnostics/diagnostic-service'
import { RotatingDiagnosticLog } from '../diagnostics/rotating-log'
import { ApplicationStateStore } from './application-state-store'
import { LiveOwnerLock } from './live-owner-lock'

it.skipIf(process.platform !== 'win32')(
  'keeps diagnostics private without changing the chosen export directory permissions',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workspace-windows-diagnostics-'))
    const logs = join(root, 'logs')
    const before = spawnSync('icacls.exe', [root], { encoding: 'utf8' }).stdout
    try {
      const writer = new RotatingDiagnosticLog(logs)
      writer.writeLine('password=private-test-value')
      writer.close()
      assertWindowsPrivatePath(join(logs, 'diagnostics.jsonl'))
      const service = new DiagnosticService({
        logDirectory: logs,
        application: 'agent-workspace',
        version: '0.2.0-beta.1',
        platform: 'windows',
        recovery: 'healthy',
        configurationSummary: {}
      })
      const destination = join(root, 'diagnostics.json')
      const preview = service.preview()
      service.export(destination, preview)
      assertWindowsPrivatePath(destination)
      expect(await readFile(destination, 'utf8')).not.toContain('private-test-value')
      expect(spawnSync('icacls.exe', [root], { encoding: 'utf8' }).stdout).toBe(before)
      expect(spawnSync('icacls.exe', [destination, '/grant', '*S-1-1-0:(R)']).status).toBe(0)
      expect(() => assertWindowsPrivatePath(destination)).toThrow('owner-only')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'win32')(
  'rejects reparse points and access granted to another user',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workspace-windows-'))
    const state = join(root, 'state')
    const file = join(state, 'workspace.sqlite')
    try {
      ensureWindowsPrivateDirectory(state)
      createWindowsPrivateFile(file)
      assertWindowsPrivatePath(file)
      const alias = join(root, 'state-link')
      await symlink(state, alias, 'junction')
      expect(() => ensureWindowsPrivateDirectory(alias)).toThrow()
      expect(spawnSync('icacls.exe', [file, '/grant', '*S-1-1-0:(R)']).status).toBe(0)
      expect(() => assertWindowsPrivatePath(file)).toThrow('owner-only')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'win32')(
  'retains both fences until the owner process terminates',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workspace-windows-lock-'))
    const state = join(root, 'state')
    ensureWindowsPrivateDirectory(state)
    const owner = join(state, 'workspace.sqlite.live-owner.lock')
    const transfer = join(state, 'workspace.sqlite.writer-transfer.lock')
    const helper = new URL(
      '../../../../packages/client-runtime/src/windows-private-state.ts',
      import.meta.url
    )
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `
    import { acquireWindowsPrivateLock } from ${JSON.stringify(helper.href)};
    const first = acquireWindowsPrivateLock(${JSON.stringify(owner)});
    const second = acquireWindowsPrivateLock(${JSON.stringify(transfer)});
    process.stdout.write('locked');
    setInterval(() => {}, 1000);
  `
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    try {
      const ready: unknown = (await once(child.stdout, 'data'))[0]
      expect((ready as Buffer).toString()).toBe('locked')
      expect(() => acquireWindowsPrivateLock(owner)).toThrow('already owned')
      expect(() => acquireWindowsPrivateLock(transfer)).toThrow('already owned')
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      acquireWindowsPrivateLock(owner).close()
      acquireWindowsPrivateLock(transfer).close()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  15_000
)

it.skipIf(process.platform !== 'win32')(
  'initializes durable state and rejects replacement under ownership',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workspace-windows-state-'))
    const state = join(root, 'state')
    const database = join(state, 'workspace.sqlite')
    let store: ApplicationStateStore | undefined
    try {
      ensureWindowsPrivateDirectory(state)
      store = await ApplicationStateStore.openNative(database, join(state, 'backup.sqlite'), root)
      expect(store.readSnapshot().workspaces).toHaveLength(1)
      const snapshot = store.readSnapshot()
      const workspace = snapshot.workspaces[0]!
      const tabId = Object.keys(workspace.tabs)[0]!
      const terminal = workspace.tabs[tabId]!.content
      if (terminal.kind !== 'terminal') throw new Error('Expected initial terminal')
      terminal.launch.cwd = join(root, 'child', 'nested')
      const closedItemId = 'c3e4b3cd-03bf-4b47-806c-d25b003daec5'
      const closed = closeTab(
        snapshot,
        workspace.id,
        tabId,
        closedItemId,
        'b1e2af72-ac37-471a-8100-12943c80d612',
        Date.now()
      )
      const target = {
        windowId: closed.windowPlacements[0]!.id,
        workspaceId: workspace.id,
        paneId: workspace.selectedPaneId,
        destinationIndex: 1,
        expectedWindowRevision: closed.windowPlacements[0]!.revision
      }
      const restoredTabId = 'b2e2af72-ac37-471a-8100-12943c80d612'
      const restored = reopenClosedTab(
        closed,
        closedItemId,
        target,
        restoredTabId,
        'b3e2af72-ac37-471a-8100-12943c80d612',
        Date.now()
      )
      expect(restored.workspaces[0]!.tabs[restoredTabId]!.content).toEqual(terminal)
      const unsafe = closed.recentlyClosed[0]!.restore
      if (unsafe.kind !== 'terminal') throw new Error('Expected terminal restore')
      unsafe.root_relative_cwd = '..\\escape'
      expect(durableApplicationStateSchema.safeParse(closed).success).toBe(false)
      expect(() =>
        reopenClosedTab(
          closed,
          closedItemId,
          target,
          restoredTabId,
          'b3e2af72-ac37-471a-8100-12943c80d612',
          Date.now()
        )
      ).toThrow('policy denied')
      store.close()
      store = undefined
      const sqlite = new Database(database, { fileMustExist: true })
      try {
        sqlite.pragma('journal_mode = WAL')
        sqlite.exec('CREATE TABLE windows_acl_probe (id INTEGER)')
        for (const path of [database, `${database}-wal`, `${database}-shm`])
          assertWindowsPrivatePath(path)
        sqlite.pragma('journal_mode = DELETE')
        sqlite.exec('BEGIN IMMEDIATE; INSERT INTO windows_acl_probe VALUES (1)')
        assertWindowsPrivatePath(`${database}-journal`)
        sqlite.exec('ROLLBACK')
      } finally {
        sqlite.close()
      }
      const lock = LiveOwnerLock.acquire(database)
      try {
        await rename(database, join(state, 'old.sqlite'))
        createWindowsPrivateFile(database)
        await writeFile(database, '')
        expect(() => lock.assertDatabaseUnchanged()).toThrow('changed while acquiring')
      } finally {
        lock.close()
      }
    } finally {
      store?.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'win32')(
  'publishes a private Windows CLI session and preserves another owner',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workspace-windows-session-'))
    const runtime = join(root, 'runtime')
    const path = join(runtime, 'node-cli-session.json')
    try {
      ensureWindowsPrivateDirectory(runtime)
      const record = {
        application: 'agent-workspace' as const,
        apiVersion: 1 as const,
        baseUrl: 'http://127.0.0.1:3774/',
        token: 'private-token-0123456789-0123456789',
        sessionId: 'a519bbd7-dd74-4234-951c-ef568bffb6e3'
      }
      const guard = await createNodeSessionFile(path, record)
      expect(await readNodeSessionFile(path)).toEqual(record)
      await expect(createNodeSessionFile(path, record)).rejects.toMatchObject({ code: 'EEXIST' })
      await guard.remove()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
