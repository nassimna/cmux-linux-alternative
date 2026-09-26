import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { expect, it, vi } from 'vitest'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { RemoteCatalog } from '../persistence/remote-catalog'
import { RUST_SCHEMA_V15_SQL } from '../persistence/legacy-schema-v15'
import { CredentialError } from './credential-provider'
import { RemoteTargetDeletionService } from './remote-target-deletion-service'
import { sharedRemoteTargetOperationLock } from './remote-target-operation-lock'

const targetId = '00000000-0000-4000-8000-0000000000f3'
const sessionId = '00000000-0000-4000-8000-0000000000f4'

it('keeps a durable target fence after cleanup fails, resumes exactly, then replays', async () => {
  const db = new Database(':memory:')
  for (const table of [
    'idempotency_results',
    'remote_targets',
    'remote_credential_enrollments',
    'remote_sessions',
    'remote_target_deletions'
  ] as const)
    db.exec(RUST_SCHEMA_V15_SQL[table])
  db.pragma('foreign_keys = ON')
  try {
    db.exec(`CREATE TABLE node_live_credential_origins (
      remote_target_id TEXT PRIMARY KEY, origin TEXT NOT NULL, committed_revision INTEGER
    )`)
    db.prepare(
      `INSERT INTO remote_targets
       (remote_target_id,label,host,port,user,host_key_state,known_hosts_version,
        revision,idempotency_key,request_hash,created_at_ms,updated_at_ms)
       VALUES (?,?,?,22,?,'trusted',3,2,?,?,1,1)`
    ).run(targetId, 'Fixture SSH', 'example.com', 'alice', randomUUID(), 'a'.repeat(64))
    db.prepare('INSERT INTO node_live_credential_origins VALUES (?, ?, NULL)').run(
      targetId,
      'v1_eligible'
    )
    db.prepare(
      `INSERT INTO remote_sessions
       (remote_session_id,remote_target_id,workspace_id,pane_id,tab_id,tmux_mode,tmux_name,
        state,observation,attempt_generation,reconnect_max_attempts,reconnect_initial_delay_ms,
        reconnect_max_delay_ms,revision,idempotency_key,request_hash,created_at_ms,updated_at_ms)
       VALUES (?,?,?,?,?,'attach','main','connected','lastVerified',2,3,500,5000,3,?,?,1,1)`
    ).run(
      sessionId,
      targetId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      'b'.repeat(64)
    )

    const catalog = new RemoteCatalog(db, () => 42)
    const state = {
      exclusive: <T>(work: () => T): Promise<T> => Promise.resolve(work()),
      beginRemoteTargetDeletion: (request: Parameters<RemoteCatalog['beginTargetDeletion']>[0]) =>
        catalog.beginTargetDeletion(request),
      finishRemoteTargetDeletion: (request: Parameters<RemoteCatalog['finishTargetDeletion']>[0]) =>
        catalog.finishTargetDeletion(request),
      remoteSessionsForTargetDeletion: (id: string) => catalog.sessionsForTargetDeletion(id),
      pendingRemoteTargetDeletions: () => catalog.pendingTargetDeletions()
    } as unknown as ApplicationStateStore
    const terminate = vi.fn().mockResolvedValue(undefined)
    const removeTarget = vi.fn().mockResolvedValue(undefined)
    const removeCredential = vi
      .fn()
      .mockRejectedValueOnce(new Error('keyring locked'))
      .mockResolvedValue(undefined)
    const service = new RemoteTargetDeletionService(
      state,
      { terminate },
      { removeTarget },
      { deleteFencedTarget: removeCredential }
    )
    const request = {
      remoteTargetId: targetId,
      mutation: {
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        requestHash: 'c'.repeat(64)
      }
    }

    let releaseActivation!: () => void
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve
    })
    const inFlightActivation = sharedRemoteTargetOperationLock.withTarget(
      targetId,
      () => activationGate
    )
    const deleting = service.delete(request)
    await Promise.resolve()
    expect(db.prepare('SELECT count(*) AS count FROM remote_target_deletions').get()).toEqual({
      count: 0
    })
    releaseActivation()
    await inFlightActivation
    await expect(deleting).rejects.toThrow('keyring locked')
    expect(db.prepare('SELECT state,observation,revision FROM remote_sessions').get()).toEqual({
      state: 'closed',
      observation: 'lost',
      revision: 4
    })
    expect(db.prepare('SELECT count(*) AS count FROM remote_target_deletions').get()).toEqual({
      count: 1
    })
    expect(catalog.pendingTargetDeletions()).toEqual([request])
    const changedRevision = {
      ...request,
      mutation: { ...request.mutation, expectedRevision: 3 }
    }
    await expect(service.delete(changedRevision)).rejects.toMatchObject({ code: 'invalid_state' })
    expect(() => catalog.finishTargetDeletion(changedRevision)).toThrowError(
      expect.objectContaining({ code: 'idempotency_conflict' })
    )
    expect(removeCredential).toHaveBeenCalledTimes(1)
    expect(() =>
      catalog.reserveHostKeyOperation('decide', targetId, {
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
        requestHash: 'e'.repeat(64)
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_state' }))
    await expect(service.recoverPending()).resolves.toBe(1)
    expect(db.prepare('SELECT count(*) AS count FROM remote_targets').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT count(*) AS count FROM remote_sessions').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT count(*) AS count FROM remote_target_deletions').get()).toEqual({
      count: 0
    })
    expect(
      db
        .prepare('SELECT origin FROM node_live_credential_origins WHERE remote_target_id = ?')
        .get(targetId)
    ).toEqual({ origin: 'v1_eligible' })
    expect(() =>
      catalog.createTarget({
        remoteTargetId: targetId,
        label: 'Reused identity',
        host: 'example.com',
        port: 22,
        user: 'alice',
        mutation: { expectedRevision: 0, idempotencyKey: randomUUID(), requestHash: 'f'.repeat(64) }
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_state' }))
    await expect(service.delete(request)).resolves.toMatchObject({
      target: { remoteTargetId: targetId }
    })
    await expect(service.delete(changedRevision)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(terminate).toHaveBeenCalledTimes(2)
    expect(terminate).toHaveBeenCalledWith(sessionId, 2)
    expect(removeTarget).toHaveBeenCalledTimes(2)
    expect(removeCredential).toHaveBeenCalledTimes(2)
    await expect(
      service.delete({
        ...request,
        mutation: { ...request.mutation, requestHash: 'd'.repeat(64) }
      })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      service.delete({ ...request, remoteTargetId: randomUUID() })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  } finally {
    db.close()
  }
})

it.each([
  ['locked', 'credential_required'],
  ['duplicate', 'credential_revoked']
] as const)('retains the target and intent when the wallet is %s', async (_, code) => {
  const db = new Database(':memory:')
  for (const table of [
    'idempotency_results',
    'remote_targets',
    'remote_credential_enrollments',
    'remote_sessions',
    'remote_target_deletions'
  ] as const)
    db.exec(RUST_SCHEMA_V15_SQL[table])
  try {
    db.prepare(
      `INSERT INTO remote_targets
       (remote_target_id,label,host,port,user,host_key_state,known_hosts_version,
        revision,idempotency_key,request_hash,created_at_ms,updated_at_ms)
       VALUES (?,?,?,22,?,'trusted',3,2,?,?,1,1)`
    ).run(targetId, 'Fixture SSH', 'example.com', 'alice', randomUUID(), 'a'.repeat(64))
    const catalog = new RemoteCatalog(db, () => 42)
    const state = {
      exclusive: <T>(work: () => T): Promise<T> => Promise.resolve(work()),
      beginRemoteTargetDeletion: (request: Parameters<RemoteCatalog['beginTargetDeletion']>[0]) =>
        catalog.beginTargetDeletion(request),
      finishRemoteTargetDeletion: (request: Parameters<RemoteCatalog['finishTargetDeletion']>[0]) =>
        catalog.finishTargetDeletion(request),
      remoteSessionsForTargetDeletion: (id: string) => catalog.sessionsForTargetDeletion(id),
      pendingRemoteTargetDeletions: () => catalog.pendingTargetDeletions()
    } as unknown as ApplicationStateStore
    const request = {
      remoteTargetId: targetId,
      mutation: { expectedRevision: 2, idempotencyKey: randomUUID(), requestHash: 'c'.repeat(64) }
    }
    const service = new RemoteTargetDeletionService(
      state,
      { terminate: vi.fn() },
      { removeTarget: vi.fn() },
      {
        deleteFencedTarget: () => Promise.reject(new CredentialError(code, code))
      }
    )
    await expect(service.delete(request)).rejects.toMatchObject({ code })
    expect(catalog.getTarget(targetId).target.revision).toBe(2)
    expect(catalog.pendingTargetDeletions()).toEqual([request])
  } finally {
    db.close()
  }
})
