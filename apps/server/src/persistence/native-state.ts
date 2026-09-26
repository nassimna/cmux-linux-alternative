import { randomUUID } from 'node:crypto'
import { closeSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'
import { durableApplicationStateSchema } from '@agent-workspace/contracts'

import { NATIVE_SCHEMA_SQL } from './native-schema'

/** Publish a fully initialized database atomically; an existing profile is never replaced. */
export function ensureNativeDatabase(
  path: string,
  workingDirectory: string,
  now = Date.now
): boolean {
  const parent = dirname(path)
  const stat = lstatSync(parent)
  if (
    parent !== realpathSync(parent) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error('Native state directory must be private and owned by this user')
  }
  try {
    lstatSync(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const timestamp = now()
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const tabId = randomUUID()
  const snapshot = durableApplicationStateSchema.parse({
    revision: 1,
    workspaces: [
      {
        id: workspaceId,
        name: 'Workspace 1',
        description: null,
        color: null,
        workingDirectory,
        layout: { kind: 'leaf', paneId },
        selectedPaneId: paneId,
        panes: { [paneId]: { id: paneId, tabs: [tabId], selectedTabId: tabId, title: null } },
        tabs: {
          [tabId]: {
            id: tabId,
            paneId,
            title: 'Terminal',
            customTitle: null,
            content: { kind: 'terminal', launch: { cwd: workingDirectory, rows: 24, cols: 80 } },
            createdAt: timestamp
          }
        },
        createdAt: timestamp,
        updatedAt: timestamp
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
    windowPlacements: [
      {
        id: workspaceId,
        label: 'Main',
        workspaceIds: [workspaceId],
        focusedWorkspaceId: workspaceId,
        hostingState: 'unhosted',
        revision: 1
      }
    ],
    focusedWindowId: workspaceId,
    focusHistory: { entries: [], cursor: 0 },
    recentlyClosed: []
  })
  const temporary = join(parent, `.native-state-${randomUUID()}.sqlite`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  closeSync(descriptor)
  try {
    const database = new Database(temporary, { fileMustExist: true })
    try {
      database.transaction(() => {
        database.exec(NATIVE_SCHEMA_SQL)
        database.exec(
          'CREATE TABLE node_native_profile (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))'
        )
        database.pragma('user_version = 15')
        database
          .prepare(
            'INSERT INTO migration_metadata (singleton, source_version, target_version, backup_path, legacy_snapshot_compatibility, migrated_at_ms) VALUES (1, 0, 15, NULL, 0, ?)'
          )
          .run(timestamp)
        database
          .prepare(
            'INSERT INTO application_snapshot (singleton, revision, json_payload, saved_at_ms) VALUES (1, ?, ?, ?)'
          )
          .run(String(snapshot.revision), JSON.stringify(snapshot), timestamp)
        database
          .prepare(
            'INSERT INTO idempotency_epoch (singleton, epoch, issued_at_ms) VALUES (1, ?, ?)'
          )
          .run(randomUUID(), timestamp)
        database
          .prepare('INSERT INTO agent_catalog_state (singleton, revision) VALUES (1, 0)')
          .run()
        database.prepare('INSERT INTO node_native_profile (singleton) VALUES (1)').run()
      })()
    } finally {
      database.close()
    }
    try {
      linkSync(temporary, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    unlinkSync(temporary)
  }
}
