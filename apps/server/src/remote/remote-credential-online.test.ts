import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { expect, it, vi } from 'vitest'

import { RemoteCatalog } from '../persistence/remote-catalog'
import { RUST_SCHEMA_V15_SQL } from '../persistence/legacy-schema-v15'
import {
  ONLINE_ENROLLMENT_MARKER_EPOCH,
  ONLINE_ENROLLMENT_MARKER_NAMESPACE,
  ONLINE_REPLACEMENT_MARKER_NAMESPACE
} from './credential-enrollment-marker'
import { RemoteCredentialEnrollmentService } from './remote-credential-enrollment-service'
import { LiveCredentialOriginStore } from './live-credential-origin'

it('preserves a marked live v1 item across abort and crash, then commits v2 without fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-v1-replace-'))
  const statePath = join(directory, 'state.sqlite3')
  let db: Database.Database | undefined
  let service: RemoteCredentialEnrollmentService | undefined
  try {
    await chmod(directory, 0o700)
    db = new Database(statePath)
    for (const table of [
      'idempotency_results', 'remote_targets', 'remote_credential_enrollments',
      'remote_target_deletions', 'remote_sessions'
    ] as const) db.exec(RUST_SCHEMA_V15_SQL[table])
    db.pragma('user_version = 15')
    const targetId = randomUUID()
    new RemoteCatalog(db, () => 42).createTarget({
      remoteTargetId: targetId, label: 'SSH', host: 'example.com', port: 22,
      user: 'alice', mutation: {
        expectedRevision: 0, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64)
      }
    })
    const origins = new LiveCredentialOriginStore(db)
    origins.markV1Eligible(targetId, 1)
    db.close()
    db = undefined
    await chmod(statePath, 0o600)
    const v1 = new Map<string, string>([[targetId, 'old']])
    const v2 = new Map<string, string>()
    const deleteV2 = vi.fn((id: string) => { v2.delete(id); return Promise.resolve() })
    const keyring = {
      validateInheritedFd: () => undefined,
      enrollFromInheritedFd: (id: string) => { v2.set(id, 'new'); return Promise.resolve() },
      has: (id: string) => Promise.resolve(v2.has(id)),
      hasV1: (id: string) => Promise.resolve(v1.has(id)),
      delete: deleteV2
    }
    service = await RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath, keyring, revokeTargetTransports: () => Promise.resolve()
    })
    db = new Database(statePath)
    const first = randomUUID()
    await service.beginOnlineReplacement(targetId, first, 1, true)
    v2.set(targetId, 'aborted')
    await service.abortOnlineReplacement(first, targetId, true)
    expect(v1.get(targetId)).toBe('old')
    expect(v2.has(targetId)).toBe(false)
    const interrupted = randomUUID()
    await service.beginOnlineReplacement(targetId, interrupted, 1, true)
    v2.set(targetId, 'interrupted')
    service.close()
    const owner = {
      assertDatabasePath: vi.fn((path: string) => expect(path).toBe(statePath)),
      assertDatabaseUnchanged: vi.fn()
    }
    await expect(RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath, keyring, revokeTargetTransports: () => Promise.resolve(),
      preserveLiveV1Replacement: {
        targetId, enrollmentId: interrupted, expectedRevision: 1, owner
      }
    })).rejects.toMatchObject({ code: 'storage_unavailable' })
    expect(v2.get(targetId)).toBe('interrupted')
    db.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES (?,?,?,?,?,?)`
    ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      interrupted, targetId, '{"status":"stored"}', 43)
    const unrelatedTarget = randomUUID()
    v2.set(unrelatedTarget, 'orphan')
    db.prepare(
      `INSERT INTO remote_credential_enrollments
       (enrollment_id,remote_target_id,expected_revision,created_at_ms) VALUES (?,?,0,43)`
    ).run(randomUUID(), unrelatedTarget)
    service = await RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath, keyring, revokeTargetTransports: () => Promise.resolve(),
      preserveLiveV1Replacement: {
        targetId, enrollmentId: interrupted, expectedRevision: 1, owner
      }
    })
    expect(owner.assertDatabasePath).toHaveBeenCalledWith(statePath)
    expect(owner.assertDatabaseUnchanged).toHaveBeenCalled()
    expect(db.prepare('SELECT count(*) AS count FROM remote_credential_enrollments').get())
      .toEqual({ count: 1 })
    expect(v1.get(targetId)).toBe('old')
    expect(v2.get(targetId)).toBe('interrupted')
    expect(v2.has(unrelatedTarget)).toBe(false)
    service.close()
    service = await RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath, keyring, revokeTargetTransports: () => Promise.resolve()
    })
    expect(v1.get(targetId)).toBe('old')
    expect(v2.has(targetId)).toBe(false)
    expect(deleteV2).toHaveBeenCalledWith(targetId)
    expect(new LiveCredentialOriginStore(db).read(targetId)).toBe('v1_eligible')

    const second = randomUUID()
    await service.beginOnlineReplacement(targetId, second, 1, true)
    v2.set(targetId, 'new')
    db.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES (?,?,?,?,?,?)`
    ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      second, targetId, '{"status":"stored"}', 43)
    await service.commitOnlineReplacement(second, targetId, 1,
      () => Promise.resolve(new RemoteCatalog(db!, () => 42).getTarget(targetId)), true)
    expect(new LiveCredentialOriginStore(db).read(targetId)).toBe('v2_committed')
    expect(v1.get(targetId)).toBe('old')
    expect(v2.get(targetId)).toBe('new')
    expect(new RemoteCatalog(db, () => 42).getTarget(targetId).target.revision).toBe(2)
    service.close()
    service = await RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath, keyring, revokeTargetTransports: () => Promise.resolve()
    })
    expect(v2.get(targetId)).toBe('new')
    expect(v1.get(targetId)).toBe('old')
  } finally {
    service?.close()
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('requires the exact helper completion and a fresh create key before publishing a new target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-enroll-'))
  const statePath = join(directory, 'state.sqlite3')
  let db: Database.Database | undefined
  let service: RemoteCredentialEnrollmentService | undefined
  try {
    await chmod(directory, 0o700)
    db = new Database(statePath)
    for (const table of [
      'idempotency_results', 'remote_targets', 'remote_credential_enrollments',
      'remote_target_deletions'
    ] as const) db.exec(RUST_SCHEMA_V15_SQL[table])
    db.close()
    db = undefined
    await chmod(statePath, 0o600)

    const targetId = randomUUID()
    const enrollmentId = randomUUID()
    const deletedKey = randomUUID()
    const credentialIds = new Set<string>([targetId])
    const remove = vi.fn((id: string) => {
      credentialIds.delete(id)
      return Promise.resolve()
    })
    service = await RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath,
      keyring: {
        validateInheritedFd: () => undefined,
        enrollFromInheritedFd: () => Promise.resolve(),
        delete: remove,
        has: (id) => Promise.resolve(credentialIds.has(id))
      },
      revokeTargetTransports: () => Promise.resolve()
    })
    db = new Database(statePath)
    const catalog = new RemoteCatalog(db, () => 42)
    const request = (idempotencyKey: string) => ({
      remoteTargetId: targetId,
      label: 'Test SSH',
      host: 'example.com',
      port: 22,
      user: 'alice',
      mutation: { expectedRevision: 0, idempotencyKey, requestHash: 'a'.repeat(64) }
    })
    await service.beginOnlineNew(targetId, enrollmentId)
    const commit = (key: string) => service!.commitOnlineNew(
      enrollmentId, targetId, () => Promise.resolve(catalog.commitEnrolledTarget(request(key), enrollmentId))
    )

    await expect(commit(randomUUID())).rejects.toMatchObject({ code: 'stale_revision' })
    expect(db.prepare('SELECT count(*) AS count FROM remote_targets').get()).toEqual({ count: 0 })

    db.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES (?,?,?,?,?,?)`
    ).run(ONLINE_ENROLLMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      enrollmentId, targetId, '{"status":"stored"}', 42)
    db.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES ('remote.target.create',?,?,?,?,?)`
    ).run(ONLINE_ENROLLMENT_MARKER_EPOCH, deletedKey, 'a'.repeat(64),
      JSON.stringify({ target: { remoteTargetId: targetId } }), 41)
    await expect(commit(deletedKey)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(db.prepare('SELECT count(*) AS count FROM remote_targets').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT count(*) AS count FROM remote_credential_enrollments').get())
      .toEqual({ count: 1 })

    const result = await commit(randomUUID())
    expect(result.target).toMatchObject({ remoteTargetId: targetId, revision: 1 })
    expect(db.prepare('SELECT count(*) AS count FROM remote_credential_enrollments').get())
      .toEqual({ count: 0 })
    expect(db.prepare(
      'SELECT count(*) AS count FROM idempotency_results WHERE namespace = ?'
    ).get(ONLINE_ENROLLMENT_MARKER_NAMESPACE)).toEqual({ count: 0 })
    expect(remove).not.toHaveBeenCalled()
  } finally {
    service?.close()
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('fences activation, commits a replacement, and restores the prior key after an interrupted write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-replace-'))
  const statePath = join(directory, 'state.sqlite3')
  let db: Database.Database | undefined
  let service: RemoteCredentialEnrollmentService | undefined
  try {
    await chmod(directory, 0o700)
    db = new Database(statePath)
    for (const table of [
      'idempotency_results', 'remote_targets', 'remote_credential_enrollments',
      'remote_target_deletions', 'remote_sessions'
    ] as const) db.exec(RUST_SCHEMA_V15_SQL[table])
    const targetId = randomUUID()
    const sessionId = randomUUID()
    new RemoteCatalog(db, () => 42).createTarget({ remoteTargetId: targetId, label: 'SSH', host: 'example.com',
      port: 22, user: 'alice', mutation: {
        expectedRevision: 0, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64)
      } })
    db.prepare(
      `INSERT INTO remote_sessions
       (remote_session_id,remote_target_id,workspace_id,pane_id,tab_id,tmux_mode,tmux_name,
        state,observation,attempt_generation,reconnect_max_attempts,reconnect_initial_delay_ms,
        reconnect_max_delay_ms,revision,idempotency_key,request_hash,created_at_ms,updated_at_ms)
       VALUES (?,?,?,?,?,'attach','main','connected','lastVerified',2,3,500,5000,3,?,?,1,1)`
    ).run(sessionId, targetId, randomUUID(), randomUUID(), randomUUID(),
      randomUUID(), 'b'.repeat(64))
    db.close()
    db = undefined
    await chmod(statePath, 0o600)

    const items = new Map<string, string>([[targetId, 'old']])
    let failBackupDeletion = false
    const revoke = vi.fn(() => Promise.resolve())
    const keyring = {
      validateInheritedFd: () => undefined,
      enrollFromInheritedFd: () => Promise.resolve(),
      has: (id: string) => Promise.resolve(items.has(id)),
      delete: (id: string) => {
        if (failBackupDeletion && id !== targetId) {
          failBackupDeletion = false
          return Promise.reject(new Error('keyring temporarily locked'))
        }
        items.delete(id)
        return Promise.resolve()
      },
      backupForReplacement: (id: string, backupId: string) => {
        const old = items.get(id)
        if (!old || items.has(backupId)) return Promise.reject(new Error('unsafe backup'))
        items.set(backupId, old)
        return Promise.resolve()
      },
      restoreReplacement: (id: string, backupId: string) => {
        const old = items.get(backupId)
        if (!old) return Promise.resolve(false)
        items.set(id, old)
        return Promise.resolve(true)
      }
    }
    service = await RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath, keyring, revokeTargetTransports: revoke
    })
    db = new Database(statePath)
    const catalog = new RemoteCatalog(db, () => 42)
    await expect(service.beginOnlineReplacement(targetId, targetId, 1))
      .rejects.toMatchObject({ code: 'invalid_target' })
    const first = randomUUID()
    await service.beginOnlineReplacement(targetId, first, 1)
    await expect(service.commitOnlineReplacement(first, targetId, 1,
      () => Promise.resolve(catalog.getTarget(targetId))))
      .rejects.toMatchObject({ code: 'stale_revision' })
    expect(revoke).not.toHaveBeenCalled()
    expect(() => catalog.beginActivation(sessionId, {
      expectedRevision: 3, idempotencyKey: randomUUID(), requestHash: 'c'.repeat(64)
    })).toThrowError(expect.objectContaining({ code: 'invalid_state' }))
    await keyring.backupForReplacement(targetId, first)
    items.set(targetId, 'new')
    db.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES (?,?,?,?,?,?)`
    ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      first, targetId, '{"status":"stored"}', 42)
    await service.commitOnlineReplacement(first, targetId, 1,
      () => Promise.resolve(catalog.getTarget(targetId)))
    expect(revoke).toHaveBeenCalledWith(targetId)
    expect(items.get(targetId)).toBe('new')
    expect(items.has(first)).toBe(false)
    expect(catalog.getTarget(targetId).target.revision).toBe(2)
    await expect(service.beginOnlineReplacement(targetId, randomUUID(), 2, true))
      .rejects.toMatchObject({ code: 'stale_revision' })
    expect(db.prepare(
      'SELECT state,observation,attempt_generation,revision FROM remote_sessions WHERE remote_session_id = ?'
    ).get(sessionId)).toEqual({
      state: 'failed', observation: 'lost', attempt_generation: 3, revision: 4
    })

    const second = randomUUID()
    await service.beginOnlineReplacement(targetId, second, 2)
    await keyring.backupForReplacement(targetId, second)
    db.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES (?,?,?,?,?,?)`
    ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      second, targetId, '{"status":"backupReady"}', 43)
    items.set(targetId, 'interrupted')
    service.close()
    service = await RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath, keyring, revokeTargetTransports: revoke
    })
    expect(items.get(targetId)).toBe('new')
    expect(items.has(second)).toBe(false)
    expect(catalog.getTarget(targetId).target.revision).toBe(2)
    expect(db.prepare('SELECT count(*) AS count FROM remote_credential_enrollments').get())
      .toEqual({ count: 0 })
    expect(db.prepare(
      'SELECT count(*) AS count FROM idempotency_results WHERE namespace = ?'
    ).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE)).toEqual({ count: 0 })

    const third = randomUUID()
    await service.beginOnlineReplacement(targetId, third, 2)
    await keyring.backupForReplacement(targetId, third)
    items.set(targetId, 'third')
    db.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES (?,?,?,?,?,?)`
    ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      third, targetId, '{"status":"stored"}', 44)
    failBackupDeletion = true
    await expect(service.commitOnlineReplacement(third, targetId, 2,
      () => Promise.resolve(catalog.getTarget(targetId))))
      .rejects.toMatchObject({ code: 'cleanup_required' })
    expect(catalog.getTarget(targetId).target.revision).toBe(3)
    expect(items.has(third)).toBe(true)
    service.close()
    service = await RemoteCredentialEnrollmentService.create({
      workingStatePath: statePath, keyring, revokeTargetTransports: revoke
    })
    expect(items.has(third)).toBe(false)
    expect(items.get(targetId)).toBe('third')
  } finally {
    service?.close()
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
