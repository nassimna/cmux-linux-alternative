import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'

import {
  LIVE_FEATURES,
  preflightLiveCutover,
  type LiveCutoverPreflightInput,
  type LiveFeaturePolicy
} from './live-cutover-preflight'
import { RUST_SCHEMA_V15_SQL } from './legacy-schema-v15'
import { IsolatedCredentialScope } from '../remote/credential-scope'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'live-external-preflight-'))
  roots.push(root)
  const profile = join(root, 'profile')
  const configuration = join(root, 'configuration')
  await mkdir(profile, { mode: 0o700 })
  await mkdir(configuration, { mode: 0o700 })
  const databasePath = join(profile, 'state.sqlite3')
  const rustDesktopPath = join(configuration, 'desktop.json')
  const db = new Database(databasePath)
  db.exec(Object.values(RUST_SCHEMA_V15_SQL).join(';'))
  db.exec('PRAGMA user_version = 15')
  db.prepare('INSERT INTO migration_metadata VALUES (1, 15, 15, NULL, 0, ?)').run(Date.now())
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const tabId = randomUUID()
  const state = {
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
  }
  db.prepare('INSERT INTO application_snapshot VALUES (1, ?, ?, ?)').run(
    '4',
    JSON.stringify(state),
    Date.now()
  )
  db.close()
  await chmod(databasePath, 0o600)
  const config = '{"schemaVersion":2,"revision":1}'
  await writeFile(rustDesktopPath, config, { mode: 0o600 })
  await writeFile(join(profile, 'config.json'), config, { mode: 0o600 })
  return { profile, databasePath, rustDesktopPath }
}

function input(paths: Awaited<ReturnType<typeof fixture>>): LiveCutoverPreflightInput {
  const features = Object.fromEntries(
    LIVE_FEATURES.map((name) => [name, 'required'])
  ) as LiveFeaturePolicy
  return {
    databasePath: paths.databasePath,
    rustDesktopPath: paths.rustDesktopPath,
    features,
    owner: {
      assertDatabasePath: (path: string) => {
        if (path !== paths.databasePath) throw new Error('wrong owner')
      }
    },
    probeIndexKey: async () => true,
    probeCodex: async () => true,
    probeRemoteCredential: async () => 'present'
  }
}

function addTarget(databasePath: string, targetId: string, hostKeyState = 'trusted'): void {
  const db = new Database(databasePath)
  try {
    db.prepare(
      `INSERT INTO remote_targets (
      remote_target_id,label,host,port,user,host_key_state,known_hosts_version,revision,
      idempotency_key,request_hash,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(targetId, 'fixture', 'example.com', 22, 'user', hostKeyState, 1, 1,
      randomUUID(), 'a'.repeat(64), 1, 1)
  } finally {
    db.close()
  }
}

it('reads the normalized Rust snapshot and reports unresolved live dependencies without touching providers', async () => {
  const paths = await fixture()
  const options = input(paths)
  let indexProbes = 0
  options.probeIndexKey = async () => {
    indexProbes++
    return true
  }
  const before = await readFile(paths.databasePath)
  const result = await preflightLiveCutover(options)
  expect(result.snapshotRevision).toBe(4)
  expect(result.readyForExternalDependencies).toBe(false)
  expect(result.blockers).toContain('encrypted_index_or_locator_missing')
  expect(result.blockers).toContain('agent_session_migration_unverified')
  expect(result.blockers).not.toContain('settings_node_config_missing')
  expect(indexProbes).toBe(0)
  expect(await readFile(paths.databasePath)).toEqual(before)
})

it('accepts an absent Node settings target as stageable and rejects omitted features', async () => {
  const paths = await fixture()
  await rm(join(paths.profile, 'config.json'))
  const options = input(paths)
  options.features.remoteSessions = 'omitted'
  const result = await preflightLiveCutover(options)
  expect(result.blockers).toContain('required_feature_remoteSessions_omitted')
  expect(result.blockers).not.toContain('settings_node_config_missing')
})

it('requires ownership and reads a valid uncheckpointed Rust WAL without modifying it', async () => {
  const paths = await fixture()
  const options = input(paths)
  options.owner.assertDatabasePath = () => {
    throw new Error('owner lost')
  }
  await expect(preflightLiveCutover(options)).rejects.toThrow('owner lost')
  options.owner.assertDatabasePath = () => undefined
  const writer = new Database(paths.databasePath)
  try {
    writer.pragma('journal_mode = WAL')
    writer.pragma('wal_autocheckpoint = 0')
    writer
      .prepare('UPDATE migration_metadata SET migrated_at_ms = ? WHERE singleton = 1')
      .run(Date.now() + 1)
    const walBefore = await readFile(`${paths.databasePath}-wal`)
    const result = await preflightLiveCutover(options)
    expect(result.snapshotRevision).toBe(4)
    expect(result.blockers).not.toContain('live_source_changed_during_copy')
    expect(await readFile(`${paths.databasePath}-wal`)).toEqual(walBefore)
  } finally {
    writer.close()
  }
})

it('qualifies exact Rust v1 credentials for trusted and untrusted targets', async () => {
  const paths = await fixture()
  const targetId = randomUUID()
  const untrustedId = randomUUID()
  addTarget(paths.databasePath, targetId)
  addTarget(paths.databasePath, untrustedId, 'untrusted')
  const references: string[] = []
  const options = input(paths)
  options.probeRemoteCredential = async (reference) => {
    references.push(reference.locator)
    return 'present'
  }
  const result = await preflightLiveCutover(options)
  expect(result.trustedRemoteCount).toBe(1)
  expect(result.blockers).toContain(`trusted_remote_host_key_unavailable:${targetId}`)
  expect(result.blockers.some((blocker) => blocker.startsWith('remote_credential_'))).toBe(false)
  expect(references).toEqual(expect.arrayContaining([`v1-${targetId}`, `v1-${untrustedId}`]))
})

it.each(['missing', 'locked', 'duplicate'] as const)(
  'blocks an exact Rust credential reported as %s', async (presence) => {
    const paths = await fixture()
    const targetId = randomUUID()
    addTarget(paths.databasePath, targetId)
    const options = input(paths)
    options.probeRemoteCredential = async () => presence
    const result = await preflightLiveCutover(options)
    expect(result.blockers).toContain(`remote_credential_${presence}:${targetId}`)
  }
)

it('lets a durably fenced target recover after its host key and credential are removed', async () => {
  const paths = await fixture()
  const targetId = randomUUID()
  addTarget(paths.databasePath, targetId)
  const db = new Database(paths.databasePath)
  try {
    db.prepare(
      `INSERT INTO remote_target_deletions
       (remote_target_id,expected_revision,idempotency_key,request_hash,result_json,created_at_ms)
       VALUES (?,1,?,?,?,1)`
    ).run(targetId, randomUUID(), 'b'.repeat(64), '{}')
  } finally {
    db.close()
  }
  const options = input(paths)
  options.probeRemoteCredential = () => Promise.resolve('missing')
  const result = await preflightLiveCutover(options)
  expect(result.blockers).not.toContain(`trusted_remote_host_key_unavailable:${targetId}`)
  expect(result.blockers).not.toContain(`remote_credential_missing:${targetId}`)
})

it('uses the existing v2 scope after a committed marker and blocks a missing scope', async () => {
  const paths = await fixture()
  const targetId = randomUUID()
  addTarget(paths.databasePath, targetId)
  const db = new Database(paths.databasePath)
  db.exec(`CREATE TABLE node_live_credential_origins (
    remote_target_id TEXT PRIMARY KEY, origin TEXT NOT NULL, committed_revision INTEGER
  )`)
  db.prepare('INSERT INTO node_live_credential_origins VALUES (?, ?, ?)')
    .run(targetId, 'v2_committed', 1)
  db.close()
  const options = input(paths)
  const references: string[] = []
  options.probeRemoteCredential = async (reference) => {
    references.push(reference.locator)
    return 'present'
  }
  const withoutScope = await preflightLiveCutover(options)
  expect(withoutScope.blockers).toContain(`remote_credential_reference_unavailable:${targetId}`)
  expect(references).toEqual([])
  const scope = IsolatedCredentialScope.loadOrCreate(paths.databasePath)
  const withScope = await preflightLiveCutover(options)
  expect(withScope.blockers).not.toContain(`remote_credential_reference_unavailable:${targetId}`)
  expect(references).toEqual([`v2-${scope.id}-${targetId}`])
})
