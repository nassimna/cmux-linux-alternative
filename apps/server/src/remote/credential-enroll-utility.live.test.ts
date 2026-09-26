import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { build } from 'esbuild'
import { afterAll, expect, it } from 'vitest'

import { LiveOwnerLock } from '../persistence/live-owner-lock'
import { RUST_SCHEMA_V15_SQL } from '../persistence/legacy-schema-v15'
import { backupLegacyDatabase } from '../persistence/legacy-backup'
import { RemoteCatalog } from '../persistence/remote-catalog'
import { RemoteCredentialEnrollmentService } from './remote-credential-enrollment-service'
import {
  ONLINE_ENROLLMENT_MARKER_EPOCH,
  ONLINE_REPLACEMENT_MARKER_NAMESPACE,
  ONLINE_V1_REPLACEMENT_NAMESPACE,
  LIVE_NEW_ENROLLMENT_NAMESPACE
} from './credential-enrollment-marker'

const directory = await mkdtemp(join(tmpdir(), 'live-credential-child-'))
await chmod(directory, 0o700)
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

const childPath = join(import.meta.dirname, '../../dist', `credential-live-test-${process.pid}.mjs`)
afterAll(async () => { await rm(childPath, { force: true }) })

async function childBundle(): Promise<void> {
  await build({
    stdin: {
      contents: `import { readFileSync, writeFileSync } from 'node:fs';
        import { runLiveCredentialV1Replacement, runLiveCredentialReplacement, runLiveCredentialNew } from './src/remote/credential-enroll-utility.ts';
        const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
        const walletPath = process.argv[4];
        const wallet = walletPath ? JSON.parse(readFileSync(walletPath, 'utf8')) : {};
        const save = () => { if (walletPath) writeFileSync(walletPath, JSON.stringify(wallet)) };
        const keyring = {
          validateInheritedFd: () => {},
          enrollFromInheritedFd: async (id) => { writeFileSync(process.argv[3], id); wallet[id] = 'new'; save() },
          enrollNewFromInheritedFd: async (id) => {
            if (Object.hasOwn(wallet, id)) throw new Error('unsafe new item');
            writeFileSync(process.argv[3], id); wallet[id] = 'new'; save();
          },
          delete: async (id) => { delete wallet[id]; save() },
          has: async (id) => Object.hasOwn(wallet, id),
          backupForReplacement: async (id, backupId) => {
            if (!Object.hasOwn(wallet, id) || Object.hasOwn(wallet, backupId)) throw new Error('unsafe backup');
            wallet[backupId] = wallet[id]; save();
          },
          restoreReplacement: async (id, backupId) => {
            if (!Object.hasOwn(wallet, backupId)) return false;
            wallet[id] = wallet[backupId]; save(); return true;
          }
        };
        (request.version === 6 ? runLiveCredentialNew : request.version === 5 ? runLiveCredentialReplacement : runLiveCredentialV1Replacement)(request, { keyring, probeV1: async () => 'missing' }).then(
          (result) => process.stdout.write(JSON.stringify(result)),
          (error) => { process.stdout.write(JSON.stringify({code: error.code})); process.exitCode = 1 }
        );`,
      resolveDir: import.meta.dirname + '/../..',
      sourcefile: 'credential-live-test-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['better-sqlite3', 'dbus-next', 'ssh2', 'zod'],
    outfile: childPath
  })
}

async function fixture() {
  const liveStatePath = join(directory, `state-${randomUUID()}.sqlite3`)
  const backupStatePath = join(directory, `backup-${randomUUID()}.sqlite3`)
  const database = new Database(liveStatePath)
  database.exec(Object.values(RUST_SCHEMA_V15_SQL).join(';'))
  database.pragma('user_version = 15')
  database.prepare('INSERT INTO migration_metadata VALUES (1, 15, 15, NULL, 0, ?)').run(Date.now())
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const tabId = randomUUID()
  const snapshot = {
    revision: 4,
    workspaces: [{
      id: workspaceId, name: 'fixture', description: null, color: null,
      workingDirectory: '/tmp', layout: { kind: 'leaf', paneId },
      selectedPaneId: paneId,
      panes: { [paneId]: { id: paneId, tabs: [tabId], selectedTabId: tabId, title: null } },
      tabs: { [tabId]: { id: tabId, paneId, title: 'shell', customTitle: null,
        content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } },
        createdAt: 1 } }, createdAt: 1, updatedAt: 1
    }],
    selectedWorkspaceId: workspaceId, workspaceSelection: [workspaceId], workspacePins: [],
    workspaceGroups: [], workspaceGroupAssignments: {}, savedLayouts: [],
    legacyOverLimit: null, shortcutOverrides: {}, notifications: [],
    notificationSettings: { systemEnabled: true, includeBody: false }, recentlyClosed: [],
    windowPlacements: [{ id: workspaceId, label: 'Main', workspaceIds: [workspaceId],
      focusedWorkspaceId: workspaceId, hostingState: 'unhosted', revision: 0 }],
    focusedWindowId: workspaceId, focusHistory: { entries: [], cursor: 0 }
  }
  database.prepare('INSERT INTO application_snapshot VALUES (1, ?, ?, ?)').run(
    '4', JSON.stringify(snapshot), Date.now()
  )
  const targetId = randomUUID()
  new RemoteCatalog(database, () => 42).createTarget({
    remoteTargetId: targetId, label: 'SSH', host: 'example.com', port: 22, user: 'alice',
    mutation: { expectedRevision: 0, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64) }
  })
  database.close()
  await chmod(liveStatePath, 0o600)
  await backupLegacyDatabase(liveStatePath, backupStatePath)
  const backupSha256 = createHash('sha256').update(readFileSync(backupStatePath)).digest('hex')
  const identity = (path: string) => {
    const file = statSync(path)
    return `${file.dev}:${file.ino}`
  }
  const enrollmentId = randomUUID()
  const live = new Database(liveStatePath)
  live.exec(`CREATE TABLE node_live_credential_origins (
    remote_target_id TEXT PRIMARY KEY NOT NULL,
    origin TEXT NOT NULL,
    committed_revision INTEGER
  )`)
  live.prepare('INSERT INTO node_live_credential_origins VALUES (?, ?, NULL)')
    .run(targetId, 'v1_eligible')
  live.prepare('INSERT INTO remote_credential_enrollments VALUES (?,?,?,?)')
    .run(enrollmentId, targetId, 1, 42)
  live.close()
  return {
    liveStatePath,
    targetId,
    enrollmentId,
    request: {
      version: 4,
      liveStatePath,
      backupStatePath,
      liveStateIdentity: identity(liveStatePath),
      backupStateIdentity: identity(backupStatePath),
      backupSha256,
      targetId,
      enrollmentId,
      expectedRevision: 1
    }
  }
}

function invoke(request: object, walletPath?: string) {
  const requestPath = join(directory, `request-${randomUUID()}.json`)
  const keyPath = join(directory, `key-${randomUUID()}`)
  const writePath = join(directory, `written-${randomUUID()}`)
  writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 })
  writeFileSync(keyPath, 'test key', { mode: 0o600 })
  const fd = openSync(keyPath, 'r')
  try {
    const result = spawnSync(process.execPath,
      [childPath, requestPath, writePath, ...(walletPath ? [walletPath] : [])], {
      stdio: ['ignore', 'pipe', 'pipe', fd],
      timeout: 10_000
    })
    return { result, writePath }
  } finally { closeSync(fd) }
}

it.skipIf(process.platform !== 'linux')('enrolls a new live target only through exact reservation and pinned resume', async () => {
  await childBundle()
  const { request, liveStatePath, enrollmentId: oldIntent } = await fixture()
  const targetId = randomUUID()
  const enrollmentId = randomUUID()
  const walletPath = join(directory, `wallet-${randomUUID()}.json`)
  writeFileSync(walletPath, '{}', { mode: 0o600 })
  const db = new Database(liveStatePath)
  db.prepare('DELETE FROM remote_credential_enrollments WHERE enrollment_id = ?').run(oldIntent)
  db.close()
  const keyring = {
    validateInheritedFd: () => undefined,
    enrollFromInheritedFd: () => Promise.resolve(),
    has: (id: string) => Promise.resolve(Object.hasOwn(
      JSON.parse(readFileSync(walletPath, 'utf8')) as Record<string, string>, id
    )),
    probeRustCredentialForCutover: () => Promise.resolve(false),
    delete: (id: string) => {
      const wallet = JSON.parse(readFileSync(walletPath, 'utf8')) as Record<string, string>
      delete wallet[id]
      writeFileSync(walletPath, JSON.stringify(wallet))
      return Promise.resolve()
    }
  }
  const owner = { assertDatabasePath: () => undefined, assertDatabaseUnchanged: () => undefined }
  const pending = await RemoteCredentialEnrollmentService.create({
    workingStatePath: liveStatePath, keyring, liveMode: true,
    revokeTargetTransports: () => Promise.resolve()
  })
  await pending.beginOnlineNew(targetId, enrollmentId)
  pending.close()
  const v6Request = { ...request, version: 6, targetId, enrollmentId, expectedRevision: 0 }
  const badProof = invoke({ ...v6Request, backupSha256: '0'.repeat(64) }, walletPath)
  expect(JSON.parse(badProof.result.stdout.toString())).toEqual({ code: 'copy_unavailable' })
  expect(JSON.parse(readFileSync(walletPath, 'utf8'))).toEqual({})
  const fence = LiveOwnerLock.acquire(liveStatePath)
  try {
    expect(JSON.parse(invoke(v6Request, walletPath).result.stdout.toString()))
      .toEqual({ code: 'owner_busy' })
  } finally { fence.close() }
  writeFileSync(walletPath, JSON.stringify({ [targetId]: 'preexisting' }))
  const ambiguous = invoke(v6Request, walletPath)
  expect(JSON.parse(ambiguous.result.stdout.toString()))
    .toEqual({ code: 'credential_provider_unavailable' })
  expect(JSON.parse(readFileSync(walletPath, 'utf8'))).toEqual({ [targetId]: 'preexisting' })
  writeFileSync(walletPath, '{}')
  const stored = invoke(v6Request, walletPath)
  expect(stored.result.status).toBe(0)
  expect(JSON.parse(stored.result.stdout.toString())).toEqual({ status: 'stored', targetId, enrollmentId })
  const paused = new Database(liveStatePath, { readonly: true })
  expect(paused.prepare('SELECT 1 FROM remote_targets WHERE remote_target_id = ?').get(targetId))
    .toBeUndefined()
  expect(paused.prepare('SELECT result_json FROM idempotency_results WHERE namespace = ? AND idempotency_key = ?')
    .get(LIVE_NEW_ENROLLMENT_NAMESPACE, enrollmentId)).toEqual({ result_json: '{"status":"stored"}' })
  paused.close()
  const resumed = await RemoteCredentialEnrollmentService.create({
    workingStatePath: liveStatePath, keyring, liveMode: true,
    preserveLiveNew: { targetId, enrollmentId, owner },
    revokeTargetTransports: () => Promise.resolve()
  })
  const create = {
    remoteTargetId: targetId, label: 'new', host: 'example.com', port: 22, user: 'alice',
    mutation: { expectedRevision: 0, idempotencyKey: randomUUID(), requestHash: 'b'.repeat(64) }
  }
  await resumed.commitOnlineNew(enrollmentId, targetId, () => {
    const catalogDb = new Database(liveStatePath)
    try { return Promise.resolve(new RemoteCatalog(catalogDb, () => 42).commitEnrolledTarget(create, enrollmentId)) }
    finally { catalogDb.close() }
  })
  resumed.close()
  const after = new Database(liveStatePath, { readonly: true })
  expect(after.prepare('SELECT revision FROM remote_targets WHERE remote_target_id = ?').get(targetId))
    .toEqual({ revision: 1 })
  expect(after.prepare('SELECT origin,committed_revision FROM node_live_credential_origins WHERE remote_target_id = ?')
    .get(targetId)).toEqual({ origin: 'v2_committed', committed_revision: 1 })
  expect(after.prepare('SELECT 1 FROM remote_credential_enrollments WHERE enrollment_id = ?').get(enrollmentId))
    .toBeUndefined()
  after.close()
})

it.skipIf(process.platform !== 'linux')('requires the exact v1 pending marker and live owner transfer', async () => {
  await childBundle()
  const { request, liveStatePath, targetId, enrollmentId } = await fixture()
  const before = invoke(request)
  expect(JSON.parse(before.result.stdout.toString())).toEqual({ code: 'invalid_request' })
  expect(before.result.status).toBe(1)

  const db = new Database(liveStatePath)
  db.prepare(`INSERT INTO idempotency_results
    (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
    VALUES (?,?,?,?,?,?)`).run(ONLINE_V1_REPLACEMENT_NAMESPACE,
    ONLINE_ENROLLMENT_MARKER_EPOCH, enrollmentId, targetId, '{"status":"pending"}', 42)
  db.prepare(`UPDATE node_live_credential_origins SET origin = 'v2_committed',
    committed_revision = 2 WHERE remote_target_id = ?`).run(targetId)
  db.close()

  const wrongOrigin = invoke(request)
  expect(JSON.parse(wrongOrigin.result.stdout.toString())).toEqual({ code: 'invalid_request' })
  expect(wrongOrigin.result.status).toBe(1)
  const reset = new Database(liveStatePath)
  reset.prepare(`UPDATE node_live_credential_origins SET origin = 'v1_eligible',
    committed_revision = NULL WHERE remote_target_id = ?`).run(targetId)
  reset.close()

  const owner = LiveOwnerLock.acquire(liveStatePath)
  try {
    const busy = invoke(request)
    expect(JSON.parse(busy.result.stdout.toString())).toEqual({ code: 'owner_busy' })
    expect(busy.result.status).toBe(1)
  } finally { owner.close() }

  const stored = invoke(request)
  expect(stored.result.status).toBe(0)
  expect(JSON.parse(stored.result.stdout.toString())).toEqual({
    status: 'stored', targetId, enrollmentId
  })
  expect(readFileSync(stored.writePath, 'utf8')).toBe(targetId)
  const after = new Database(liveStatePath, { readonly: true })
  try {
    expect(after.prepare('SELECT origin FROM node_live_credential_origins WHERE remote_target_id = ?')
      .get(targetId)).toEqual({ origin: 'v1_eligible' })
    expect(after.prepare(`SELECT result_json FROM idempotency_results WHERE namespace = ?
      AND idempotency_key = ?`).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE, enrollmentId))
      .toEqual({ result_json: '{"status":"stored"}' })
  } finally { after.close() }
})

it.skipIf(process.platform !== 'linux')('backs up a live v2 item and commits only after exact resume', async () => {
  await childBundle()
  const { request, liveStatePath, targetId, enrollmentId } = await fixture()
  const v2Request = { ...request, version: 5 }
  const walletPath = join(directory, `wallet-${randomUUID()}.json`)
  writeFileSync(walletPath, JSON.stringify({ [targetId]: 'old' }), { mode: 0o600 })
  const database = new Database(liveStatePath)
  database.prepare(`UPDATE node_live_credential_origins SET origin = 'v2_committed',
    committed_revision = 2 WHERE remote_target_id = ?`).run(targetId)
  database.close()

  const futureOrigin = invoke(v2Request, walletPath)
  expect(JSON.parse(futureOrigin.result.stdout.toString())).toEqual({ code: 'invalid_request' })
  const reset = new Database(liveStatePath)
  reset.prepare(`UPDATE node_live_credential_origins SET committed_revision = 1
    WHERE remote_target_id = ?`).run(targetId)
  reset.close()

  const owner = LiveOwnerLock.acquire(liveStatePath)
  try {
    const busy = invoke(v2Request, walletPath)
    expect(JSON.parse(busy.result.stdout.toString())).toEqual({ code: 'owner_busy' })
  } finally { owner.close() }
  const invalidProof = invoke({ ...v2Request, backupSha256: '0'.repeat(64) }, walletPath)
  expect(JSON.parse(invalidProof.result.stdout.toString())).toEqual({ code: 'copy_unavailable' })
  expect(JSON.parse(readFileSync(walletPath, 'utf8'))).toEqual({ [targetId]: 'old' })

  const stored = invoke(v2Request, walletPath)
  expect(stored.result.status).toBe(0)
  expect(JSON.parse(stored.result.stdout.toString())).toEqual({
    status: 'stored', targetId, enrollmentId
  })
  expect(JSON.parse(readFileSync(walletPath, 'utf8'))).toEqual({
    [targetId]: 'new', [enrollmentId]: 'old'
  })
  const keyring = {
    validateInheritedFd: () => undefined,
    enrollFromInheritedFd: () => Promise.resolve(),
    has: (id: string) => Promise.resolve(Object.hasOwn(
      JSON.parse(readFileSync(walletPath, 'utf8')) as Record<string, string>, id
    )),
    delete: (id: string) => {
      const wallet = JSON.parse(readFileSync(walletPath, 'utf8')) as Record<string, string>
      delete wallet[id]
      writeFileSync(walletPath, JSON.stringify(wallet))
      return Promise.resolve()
    },
    backupForReplacement: () => Promise.resolve(),
    restoreReplacement: (id: string, backupId: string) => {
      const wallet = JSON.parse(readFileSync(walletPath, 'utf8')) as Record<string, string>
      if (!(backupId in wallet)) return Promise.resolve(false)
      wallet[id] = wallet[backupId]!
      writeFileSync(walletPath, JSON.stringify(wallet))
      return Promise.resolve(true)
    }
  }
  const evidence = {
    assertDatabasePath: () => undefined,
    assertDatabaseUnchanged: () => undefined
  }
  const preserved = await RemoteCredentialEnrollmentService.create({
    workingStatePath: liveStatePath, keyring, revokeTargetTransports: () => Promise.resolve(),
    preserveLiveReplacement: { targetId, enrollmentId, expectedRevision: 1, owner: evidence }
  })
  await preserved.commitOnlineReplacement(enrollmentId, targetId, 1, () => Promise.resolve({}))
  preserved.close()
  const after = new Database(liveStatePath, { readonly: true })
  try {
    expect(after.prepare('SELECT revision FROM remote_targets WHERE remote_target_id = ?')
      .get(targetId)).toEqual({ revision: 2 })
    expect(after.prepare(`SELECT origin,committed_revision FROM node_live_credential_origins
      WHERE remote_target_id = ?`).get(targetId)).toEqual({
      origin: 'v2_committed', committed_revision: 2
    })
  } finally { after.close() }
  expect(JSON.parse(readFileSync(walletPath, 'utf8'))).toEqual({ [targetId]: 'new' })
})

it.skipIf(process.platform !== 'linux')('keeps the live v1-to-v2 path available through version 5', async () => {
  await childBundle()
  const { request, liveStatePath, targetId, enrollmentId } = await fixture()
  const database = new Database(liveStatePath)
  database.prepare(`INSERT INTO idempotency_results
    (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
    VALUES (?,?,?,?,?,?)`).run(ONLINE_V1_REPLACEMENT_NAMESPACE,
    ONLINE_ENROLLMENT_MARKER_EPOCH, enrollmentId, targetId, '{"status":"pending"}', 42)
  database.close()
  const stored = invoke({ ...request, version: 5 })
  expect(stored.result.status).toBe(0)
  expect(JSON.parse(stored.result.stdout.toString())).toEqual({
    status: 'stored', targetId, enrollmentId
  })
  const after = new Database(liveStatePath, { readonly: true })
  try {
    expect(after.prepare(`SELECT result_json FROM idempotency_results WHERE namespace = ?
      AND idempotency_key = ?`).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE, enrollmentId))
      .toEqual({ result_json: '{"status":"stored"}' })
  } finally { after.close() }
})

it.skipIf(process.platform !== 'linux')('restores the old live v2 item after an unresumed write', async () => {
  await childBundle()
  const { request, liveStatePath, targetId, enrollmentId } = await fixture()
  const walletPath = join(directory, `wallet-${randomUUID()}.json`)
  writeFileSync(walletPath, JSON.stringify({ [targetId]: 'old' }), { mode: 0o600 })
  const database = new Database(liveStatePath)
  database.prepare(`UPDATE node_live_credential_origins SET origin = 'v2_committed',
    committed_revision = 1 WHERE remote_target_id = ?`).run(targetId)
  database.close()
  expect(invoke({ ...request, version: 5 }, walletPath).result.status).toBe(0)
  const keyring = {
    validateInheritedFd: () => undefined,
    enrollFromInheritedFd: () => Promise.resolve(),
    has: (id: string) => Promise.resolve(Object.hasOwn(
      JSON.parse(readFileSync(walletPath, 'utf8')) as Record<string, string>, id
    )),
    delete: (id: string) => {
      const wallet = JSON.parse(readFileSync(walletPath, 'utf8')) as Record<string, string>
      delete wallet[id]
      writeFileSync(walletPath, JSON.stringify(wallet))
      return Promise.resolve()
    },
    restoreReplacement: (id: string, backupId: string) => {
      const wallet = JSON.parse(readFileSync(walletPath, 'utf8')) as Record<string, string>
      if (!(backupId in wallet)) return Promise.resolve(false)
      wallet[id] = wallet[backupId]!
      writeFileSync(walletPath, JSON.stringify(wallet))
      return Promise.resolve(true)
    }
  }
  const recovered = await RemoteCredentialEnrollmentService.create({
    workingStatePath: liveStatePath, keyring, revokeTargetTransports: () => Promise.resolve()
  })
  recovered.close()
  expect(JSON.parse(readFileSync(walletPath, 'utf8'))).toEqual({ [targetId]: 'old' })
  const after = new Database(liveStatePath, { readonly: true })
  try {
    expect(after.prepare('SELECT 1 FROM remote_credential_enrollments WHERE enrollment_id = ?')
      .get(enrollmentId)).toBeUndefined()
    expect(after.prepare('SELECT revision FROM remote_targets WHERE remote_target_id = ?')
      .get(targetId)).toEqual({ revision: 1 })
  } finally { after.close() }
})

it.skipIf(process.platform !== 'linux')('keeps a backup-ready live v2 intent fenced until recovery can restore', async () => {
  const { liveStatePath, targetId, enrollmentId } = await fixture()
  const database = new Database(liveStatePath)
  database.prepare(`UPDATE node_live_credential_origins SET origin = 'v2_committed',
    committed_revision = 1 WHERE remote_target_id = ?`).run(targetId)
  database.prepare(`INSERT INTO idempotency_results
    (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
    VALUES (?,?,?,?,?,?)`).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE,
    ONLINE_ENROLLMENT_MARKER_EPOCH, enrollmentId, targetId, '{"status":"backupReady"}', 42)
  database.close()
  const wallet = new Map<string, string>([[targetId, 'old']])
  const keyring = {
    validateInheritedFd: () => undefined,
    enrollFromInheritedFd: () => Promise.resolve(),
    has: (id: string) => Promise.resolve(wallet.has(id)),
    delete: (id: string) => { wallet.delete(id); return Promise.resolve() },
    restoreReplacement: (id: string, backupId: string) => {
      const prior = wallet.get(backupId)
      if (!prior) return Promise.resolve(false)
      wallet.set(id, prior)
      return Promise.resolve(true)
    }
  }
  await expect(RemoteCredentialEnrollmentService.create({
    workingStatePath: liveStatePath, keyring, revokeTargetTransports: () => Promise.resolve()
  })).rejects.toMatchObject({ code: 'cleanup_required' })
  const fenced = new Database(liveStatePath, { readonly: true })
  try {
    expect(fenced.prepare('SELECT 1 FROM remote_credential_enrollments WHERE enrollment_id = ?')
      .get(enrollmentId)).toBeDefined()
  } finally { fenced.close() }
  wallet.set(enrollmentId, 'old')
  wallet.set(targetId, 'new')
  const recovered = await RemoteCredentialEnrollmentService.create({
    workingStatePath: liveStatePath, keyring, revokeTargetTransports: () => Promise.resolve()
  })
  recovered.close()
  expect([...wallet]).toEqual([[targetId, 'old']])
  const after = new Database(liveStatePath, { readonly: true })
  try {
    expect(after.prepare('SELECT 1 FROM remote_credential_enrollments WHERE enrollment_id = ?')
      .get(enrollmentId)).toBeUndefined()
  } finally { after.close() }
})
