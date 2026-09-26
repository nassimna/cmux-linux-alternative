import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  durableWorkspaceSnapshotSchema,
  type DurableWorkspaceSnapshot
} from '@agent-workspace/contracts'

import { backupLegacyDatabase } from './legacy-backup'
import { ApplicationStateStore } from './application-state-store'
import { inspectLegacyDatabase, RUST_SCHEMA_V15_TABLES } from './legacy-inspection'
import { LegacyStateReader } from './legacy-state-reader'
import { RUST_SCHEMA_V15_SQL } from './legacy-schema-v15'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fixture(): Promise<{ path: string; workspaceId: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-node-storage-test-'))
  directories.push(directory)
  const path = join(directory, 'state.sqlite3')
  const database = new Database(path)
  database.exec(Object.values(RUST_SCHEMA_V15_SQL).join(';'))
  database.exec('PRAGMA user_version = 15')
  database.prepare('INSERT INTO migration_metadata VALUES (1, 15, 15, NULL, 0, ?)').run(Date.now())
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const tabId = randomUUID()
  database.prepare('INSERT INTO application_snapshot VALUES (1, ?, ?, ?)').run(
    '4',
    JSON.stringify({
      revision: 4,
      workspaces: [
        {
          id: workspaceId,
          name: 'fixture',
          description: null,
          color: null,
          workingDirectory: '/tmp',
          layout: { kind: 'leaf', paneId },
          selectedPaneId: paneId,
          panes: { [paneId]: { id: paneId, tabs: [tabId], selectedTabId: tabId, title: null } },
          tabs: {
            [tabId]: {
              id: tabId,
              paneId,
              title: 'shell',
              customTitle: null,
              content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } },
              createdAt: 1
            }
          },
          createdAt: 1,
          updatedAt: 1
        }
      ],
      selectedWorkspaceId: workspaceId,
      workspaceSelection: [workspaceId],
      workspacePins: [],
      workspaceGroups: [],
      workspaceGroupAssignments: {},
      savedLayouts: [],
      legacyOverLimit: null,
      shortcutOverrides: {},
      notifications: [],
      notificationSettings: { systemEnabled: true, includeBody: false },
      recentlyClosed: [],
      windowPlacements: [
        {
          id: workspaceId,
          label: 'Main',
          workspaceIds: [workspaceId],
          focusedWorkspaceId: workspaceId,
          hostingState: 'unhosted',
          revision: 0
        }
      ],
      focusedWindowId: workspaceId,
      focusHistory: { entries: [], cursor: 0 }
    }),
    Date.now()
  )
  database.close()
  await chmod(path, 0o600)
  return { path, workspaceId }
}

function alterSnapshot(path: string, mutate: (payload: DurableWorkspaceSnapshot) => void): void {
  const database = new Database(path)
  try {
    const row = database
      .prepare('SELECT json_payload FROM application_snapshot WHERE singleton = 1')
      .get() as { json_payload: string }
    const decoded: unknown = JSON.parse(row.json_payload)
    const payload = durableWorkspaceSnapshotSchema.parse(decoded)
    mutate(payload)
    database
      .prepare('UPDATE application_snapshot SET json_payload = ? WHERE singleton = 1')
      .run(JSON.stringify(payload))
  } finally {
    database.close()
  }
}

describe('Rust schema-v15 read-only preflight', () => {
  it('reports bounded metadata without changing the database file', async () => {
    const { path } = await fixture()
    const before = await readFile(path)
    expect(inspectLegacyDatabase(path)).toEqual({
      schemaVersion: 15,
      tableCount: RUST_SCHEMA_V15_TABLES.length,
      snapshotRevision: 4,
      workspaceCount: 1,
      windowStateCount: 0,
      legacySnapshotCompatibility: false
    })
    expect(await readFile(path)).toEqual(before)
  })

  it('accepts an initialized v15 database before its first workspace save', async () => {
    const { path } = await fixture()
    const database = new Database(path)
    database.exec(`
      DELETE FROM application_snapshot;
      UPDATE migration_metadata SET legacy_snapshot_compatibility = 1 WHERE singleton = 1;
    `)
    database
      .prepare('INSERT INTO window_state VALUES (?, ?, ?, ?)')
      .run(randomUUID(), '0', '{}', Date.now())
    database.close()
    expect(inspectLegacyDatabase(path)).toMatchObject({
      snapshotRevision: null,
      workspaceCount: 0,
      windowStateCount: 1,
      legacySnapshotCompatibility: true
    })
    const reader = new LegacyStateReader(path)
    try {
      expect(() => reader.readSnapshot()).toThrowError(
        expect.objectContaining({ code: 'state_uninitialized' })
      )
    } finally {
      reader.close()
    }
  })

  it('preserves Rust window geometry and independent revisions in the Node copy', async () => {
    const { path, workspaceId } = await fixture()
    const previous = {
      revision: 3,
      x: -25,
      y: 40,
      width: 1200,
      height: 800,
      maximized: false,
      fullscreen: false,
      displayIdentifier: 'display-1'
    }
    const source = new Database(path)
    source
      .prepare('INSERT INTO window_state VALUES (?, ?, ?, ?)')
      .run(workspaceId, '3', JSON.stringify(previous), 1)
    source.prepare('INSERT INTO idempotency_epoch VALUES (1, ?, ?)').run(randomUUID(), 1)
    source.close()
    await chmod(path, 0o600)
    const directory = dirname(path)
    const store = await ApplicationStateStore.prepareCopy(
      path,
      join(directory, 'backup.sqlite3'),
      join(directory, 'working.sqlite3'),
      () => 42
    )
    try {
      const current = store.getWindowStateFor(workspaceId)
      expect(current.state).toEqual({
        revision: 3,
        x: -25,
        y: 40,
        width: 1200,
        height: 800,
        maximized: false,
        fullscreen: false,
        displayId: 'display-1'
      })
      expect(store.updateWindowStateFor(workspaceId, current.state!)).toEqual(current)
      expect(() =>
        store.updateWindowStateFor(workspaceId, {
          ...current.state!,
          width: 1400
        })
      ).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
      expect(() =>
        store.updateWindowStateFor(workspaceId, {
          ...current.state!,
          revision: 2
        })
      ).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
      expect(
        store.updateWindowStateFor(workspaceId, {
          ...current.state!,
          revision: 4,
          width: 1400
        }).state.width
      ).toBe(1400)
      expect(store.readSnapshot().revision).toBe(4)
      expect(() => store.getWindowStateFor(randomUUID())).toThrowError(
        expect.objectContaining({ code: 'target_not_found' })
      )
    } finally {
      store.close()
    }
    const copy = new Database(join(directory, 'working.sqlite3'), { readonly: true })
    try {
      const row = copy
        .prepare('SELECT revision, json_payload FROM window_state WHERE window_id = ?')
        .get(workspaceId) as { revision: string; json_payload: string }
      expect(row.revision).toBe('4')
      expect(JSON.parse(row.json_payload)).toMatchObject({
        width: 1400,
        displayIdentifier: 'display-1'
      })
    } finally {
      copy.close()
    }
  })

  it('identifies a legacy-compatible snapshot as needing normalization', async () => {
    const { path } = await fixture()
    const database = new Database(path)
    database
      .prepare(
        'UPDATE migration_metadata SET legacy_snapshot_compatibility = 1 WHERE singleton = 1'
      )
      .run()
    const row = database
      .prepare('SELECT json_payload FROM application_snapshot WHERE singleton = 1')
      .get() as { json_payload: string }
    const oldSnapshot = JSON.parse(row.json_payload) as Record<string, unknown>
    delete oldSnapshot.workspaceGroups
    database
      .prepare('UPDATE application_snapshot SET json_payload = ? WHERE singleton = 1')
      .run(JSON.stringify(oldSnapshot))
    database.close()
    expect(inspectLegacyDatabase(path)).toMatchObject({
      legacySnapshotCompatibility: true,
      snapshotRevision: 4,
      workspaceCount: 1
    })
    const backup = await backupLegacyDatabase(path, join(dirname(path), 'legacy-backup.sqlite3'))
    expect(backup.database.legacySnapshotCompatibility).toBe(true)
    expect(inspectLegacyDatabase(backup.path).snapshotRevision).toBe(4)
    await expect(
      ApplicationStateStore.prepareCopy(
        path,
        join(dirname(path), 'write-backup.sqlite3'),
        join(dirname(path), 'write-working.sqlite3')
      )
    ).rejects.toMatchObject({ code: 'migration_required' })
    expect(await readdir(dirname(path))).not.toContain('write-working.sqlite3')
    expect(() => new LegacyStateReader(path)).toThrowError(
      expect.objectContaining({ code: 'migration_required' })
    )
  })

  it.each([
    [
      'unknown root field',
      (payload: DurableWorkspaceSnapshot) => {
        payload.extra = true
      }
    ],
    [
      'dangling group assignment',
      (payload: DurableWorkspaceSnapshot) => {
        payload.workspaceGroupAssignments = { [payload.selectedWorkspaceId]: randomUUID() }
      }
    ],
    [
      'malformed notification history',
      (payload: DurableWorkspaceSnapshot) => {
        payload.notifications = [
          {
            id: randomUUID(),
            workspaceId: payload.selectedWorkspaceId,
            paneId: null,
            tabId: null,
            source: 'internal',
            level: 'info',
            title: 'Ready',
            body: null,
            createdAt: 4,
            readAt: 3
          }
        ]
      }
    ],
    [
      'false legacy limit counts',
      (payload: DurableWorkspaceSnapshot) => {
        payload.legacyOverLimit = {
          workspaceCount: 2,
          maximumPanesInWorkspace: 1,
          maximumTabsInWorkspace: 1,
          totalPaneCount: 1,
          totalTabCount: 1
        }
      }
    ]
  ])('rejects %s before the Node write boundary', async (_case, mutate) => {
    const { path } = await fixture()
    alterSnapshot(path, mutate)
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'invalid_snapshot' })
    )
  })

  it('rejects a snapshot changed after preflight', async () => {
    const { path } = await fixture()
    const reader = new LegacyStateReader(path)
    try {
      const database = new Database(path)
      database.prepare('UPDATE application_snapshot SET revision = ? WHERE singleton = 1').run('5')
      database.close()
      expect(() => reader.readSnapshot()).toThrowError(
        expect.objectContaining({ code: 'invalid_snapshot' })
      )
    } finally {
      reader.close()
    }
  })

  it('rejects a compatibility change after preflight', async () => {
    const { path } = await fixture()
    const reader = new LegacyStateReader(path)
    try {
      const database = new Database(path)
      database
        .prepare(
          'UPDATE migration_metadata SET legacy_snapshot_compatibility = 1 WHERE singleton = 1'
        )
        .run()
      database.close()
      expect(() => reader.readSnapshot()).toThrowError(
        expect.objectContaining({ code: 'migration_required' })
      )
    } finally {
      reader.close()
    }
  })

  it('rejects a missing feature table before any write path can use the file', async () => {
    const { path } = await fixture()
    const database = new Database(path)
    database.exec('DROP TABLE agent_sessions')
    database.close()
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'invalid_schema' })
    )
  })

  it('rejects a lookalike core table with weaker constraints', async () => {
    const { path } = await fixture()
    const database = new Database(path)
    database.exec(`
      ALTER TABLE window_state RENAME TO old_window_state;
      CREATE TABLE window_state (window_id TEXT PRIMARY KEY, revision TEXT, json_payload TEXT, saved_at_ms INTEGER);
      DROP TABLE old_window_state;
    `)
    database.close()
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'invalid_schema' })
    )
  })

  it('rejects an orphaned feature row', async () => {
    const { path } = await fixture()
    const database = new Database(path)
    database.pragma('foreign_keys = OFF')
    database
      .prepare('INSERT INTO agent_hibernation_challenge_replay VALUES (?, ?)')
      .run(randomUUID(), randomUUID())
    database.close()
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'corrupt_database' })
    )
  })

  it('rejects future schemas and mismatched snapshot revisions', async () => {
    const { path } = await fixture()
    const database = new Database(path)
    database.pragma('user_version = 16')
    database.close()
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'future_schema' })
    )

    const current = new Database(path)
    current.pragma('user_version = 15')
    current.prepare('UPDATE application_snapshot SET revision = ? WHERE singleton = 1').run('5')
    current.close()
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'invalid_snapshot' })
    )
  })

  it.each([
    [
      'layout pane missing',
      (payload: DurableWorkspaceSnapshot) => {
        const layout = payload.workspaces[0]!.layout as { paneId: string }
        layout.paneId = randomUUID()
      }
    ],
    [
      'tab owned by another pane',
      (payload: DurableWorkspaceSnapshot) => {
        const tab = Object.values(payload.workspaces[0]!.tabs)[0]!
        tab.paneId = randomUUID()
      }
    ],
    [
      'duplicate workspace ownership',
      (payload: DurableWorkspaceSnapshot) => {
        payload.windowPlacements[0]!.workspaceIds.push(payload.selectedWorkspaceId)
      }
    ],
    [
      'invalid terminal path',
      (payload: DurableWorkspaceSnapshot) => {
        const tab = Object.values(payload.workspaces[0]!.tabs)[0]!
        if (tab.content.kind !== 'terminal') throw new Error('Expected terminal fixture')
        tab.content.launch.cwd = 'relative'
      }
    ],
    [
      'dangling focus history',
      (payload: DurableWorkspaceSnapshot) => {
        payload.focusHistory = {
          entries: [
            {
              windowId: payload.focusedWindowId,
              workspaceId: payload.selectedWorkspaceId,
              paneId: randomUUID(),
              tabId: randomUUID()
            }
          ],
          cursor: 0
        }
      }
    ]
  ])('rejects %s in a durable snapshot', async (_case, mutate) => {
    const { path } = await fixture()
    alterSnapshot(path, mutate)
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'invalid_snapshot' })
    )
  })

  it('does not create a missing database or accept a corrupt file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-node-storage-test-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite3')
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'database_unavailable' })
    )
    await writeFile(path, 'not a SQLite database')
    expect(() => inspectLegacyDatabase(path)).toThrowError(
      expect.objectContaining({ code: 'corrupt_database' })
    )
  })

  it('creates a private verified backup without touching the source', async () => {
    const { path } = await fixture()
    const destination = join(dirname(path), 'state-backup.sqlite3')
    const before = await readFile(path)
    const report = await backupLegacyDatabase(path, destination)
    expect(report.path).toBe(destination)
    expect(report.database).toEqual(inspectLegacyDatabase(path))
    expect(await readFile(path)).toEqual(before)
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    expect(await readdir(dirname(path))).toEqual(['state-backup.sqlite3', 'state.sqlite3'])
  })

  it('includes committed changes still held in the source WAL', async () => {
    const { path } = await fixture()
    const writer = new Database(path)
    try {
      writer.pragma('journal_mode = WAL')
      writer.prepare('UPDATE migration_metadata SET legacy_snapshot_compatibility = 1').run()
      const backup = await backupLegacyDatabase(path, join(dirname(path), 'wal-backup.sqlite3'))
      expect(backup.database.legacySnapshotCompatibility).toBe(true)
      expect(inspectLegacyDatabase(backup.path).legacySnapshotCompatibility).toBe(true)
    } finally {
      writer.close()
    }
  })

  it('never overwrites an existing backup or follows a database symlink', async () => {
    const { path } = await fixture()
    const destination = join(dirname(path), 'state-backup.sqlite3')
    await writeFile(destination, 'keep this backup')
    await expect(backupLegacyDatabase(path, destination)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(destination, 'utf8')).toBe('keep this backup')
    const alias = join(dirname(path), 'state-alias.sqlite3')
    await symlink(path, alias)
    await expect(
      backupLegacyDatabase(alias, join(dirname(path), 'another.sqlite3'))
    ).rejects.toThrow('regular file')
    expect(await readdir(dirname(path))).toEqual([
      'state-alias.sqlite3',
      'state-backup.sqlite3',
      'state.sqlite3'
    ])
  })

  it('refuses a backup directory visible to other users', async () => {
    const { path } = await fixture()
    const publicDirectory = join(dirname(path), 'public')
    await mkdir(publicDirectory, { mode: 0o755 })
    await expect(
      backupLegacyDatabase(path, join(publicDirectory, 'state-backup.sqlite3'))
    ).rejects.toThrow('private, real directory')
    expect(await readdir(publicDirectory)).toEqual([])
  })
})
