import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { z } from 'zod'

import { IsolatedCopyLock, verifyIsolatedCopy } from '../persistence/isolated-copy-ownership'
import { inspectLegacyDatabase } from '../persistence/legacy-inspection'
import { LiveOwnerLock } from '../persistence/live-owner-lock'
import { assertInheritedCredentialReadOnly } from './credential-inherited-fd'
import { CredentialReference } from './credential-provider'
import {
  ONLINE_ENROLLMENT_MARKER_EPOCH,
  ONLINE_ENROLLMENT_MARKER_NAMESPACE,
  ONLINE_REPLACEMENT_MARKER_NAMESPACE,
  ONLINE_V1_REPLACEMENT_NAMESPACE
} from './credential-enrollment-marker'
import { LIVE_NEW_ENROLLMENT_NAMESPACE } from './credential-enrollment-marker'
import { probeExactCredentialPresence, SecretServiceCredentialProvider } from './credential-secret-service'
import { IsolatedCredentialScope } from './credential-scope'
import { verifyLiveCredentialStateProof } from './live-credential-utility-policy'
import {
  RemoteCredentialEnrollmentService,
  type ExactCredentialKeyring
} from './remote-credential-enrollment-service'

const MAX_KEY_BYTES = 64 * 1024

/** Private utility request. Key bytes enter only through inherited read-only fd 3. */
export const credentialEnrollmentRequestSchema = z.strictObject({
  version: z.literal(1),
  sourceStatePath: z.string().min(1),
  backupStatePath: z.string().min(1),
  workingStatePath: z.string().min(1),
  targetId: z.uuid(),
  expectedRevision: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER - 1)
})
export type CredentialEnrollmentRequest = z.infer<typeof credentialEnrollmentRequestSchema>

export const onlineCredentialWriteRequestSchema = z.strictObject({
  version: z.literal(2),
  sourceStatePath: z.string().min(1),
  backupStatePath: z.string().min(1),
  workingStatePath: z.string().min(1),
  targetId: z.uuid(),
  enrollmentId: z.uuid(),
  expectedRevision: z.literal(0)
})
export type OnlineCredentialWriteRequest = z.infer<typeof onlineCredentialWriteRequestSchema>

export const onlineCredentialReplaceRequestSchema = onlineCredentialWriteRequestSchema.extend({
  version: z.literal(3),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1)
})
export type OnlineCredentialReplaceRequest = z.infer<typeof onlineCredentialReplaceRequestSchema>

const nativeCredentialRequestSchema = z.strictObject({
  nativeStatePath: z.string().min(1),
  stateIdentity: z.string().regex(/^\d+:\d+$/u),
  targetId: z.uuid(),
  enrollmentId: z.uuid()
})
export const nativeCredentialWriteRequestSchema = nativeCredentialRequestSchema.extend({
  version: z.literal(7),
  expectedRevision: z.literal(0)
})
export const nativeCredentialReplaceRequestSchema = nativeCredentialRequestSchema.extend({
  version: z.literal(8),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1)
})

/** A stopped live owner transfers both flock fences to this single-purpose helper. */
export const liveCredentialV1ReplaceRequestSchema = z.strictObject({
  version: z.literal(4),
  liveStatePath: z.string().min(1),
  backupStatePath: z.string().min(1),
  liveStateIdentity: z.string().regex(/^\d+:\d+$/u),
  backupStateIdentity: z.string().regex(/^\d+:\d+$/u),
  backupSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  targetId: z.uuid(),
  enrollmentId: z.uuid(),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1)
})
export type LiveCredentialV1ReplaceRequest = z.infer<typeof liveCredentialV1ReplaceRequestSchema>

/** The live replacement helper selects the exact credential origin under the owner fence. */
export const liveCredentialReplaceRequestSchema = liveCredentialV1ReplaceRequestSchema.extend({
  version: z.literal(5)
})

export const liveCredentialNewRequestSchema = liveCredentialV1ReplaceRequestSchema.extend({
  version: z.literal(6),
  expectedRevision: z.literal(0)
})

export class CredentialEnrollmentUtilityError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'unsafe_descriptor'
      | 'copy_unavailable'
      | 'native_unavailable'
      | 'owner_busy'
      | 'credential_provider_unavailable'
  ) {
    super('Credential enrollment is unavailable')
    this.name = 'CredentialEnrollmentUtilityError'
  }
}

function assertPrivateKeyDescriptor(fd: number): void {
  try {
    assertInheritedCredentialReadOnly(fd)
    const file = fstatSync(fd)
    if (
      fd !== 3 ||
      !process.getuid ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.uid !== process.getuid() ||
      file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 ||
      file.size < 1 ||
      file.size > MAX_KEY_BYTES
    ) {
      throw new Error('unsafe descriptor')
    }
  } catch {
    throw new CredentialEnrollmentUtilityError('unsafe_descriptor')
  }
}

/** The online helper may share the database only while its native Node owner holds both fences. */
export async function verifyNativeCredentialState(
  request: { nativeStatePath: string; stateIdentity: string }
): Promise<void> {
  const path = request.nativeStatePath
  if (process.platform !== 'linux' || !process.getuid || !isAbsolute(path) || resolve(path) !== path)
    throw new CredentialEnrollmentUtilityError('native_unavailable')
  try {
    const parentPath = dirname(path)
    const [file, parent] = await Promise.all([lstat(path), lstat(parentPath)])
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
        file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600 ||
        `${file.dev}:${file.ino}` !== request.stateIdentity ||
        !parent.isDirectory() || parent.isSymbolicLink() ||
        parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700 ||
        await realpath(path) !== path || await realpath(parentPath) !== parentPath)
      throw new Error('unsafe native state')
    for (const suffix of ['.writer-transfer.lock', '.live-owner.lock']) {
      const lockPath = `${path}${suffix}`
      const lock = await lstat(lockPath)
      if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1 ||
          lock.uid !== process.getuid() || (lock.mode & 0o777) !== 0o600 ||
          await realpath(lockPath) !== lockPath)
        throw new Error('unsafe native owner fence')
      const probe = spawnSync('/usr/bin/flock',
        ['-n', '-E', '75', lockPath, '/usr/bin/true'],
        { stdio: 'ignore', timeout: 5_000 })
      if (probe.status !== 75) throw new Error('native owner is not active')
    }
    const database = new Database(path, { fileMustExist: true, readonly: true })
    try {
      const migration = database.prepare(
        'SELECT source_version, target_version, legacy_snapshot_compatibility FROM migration_metadata WHERE singleton = 1'
      ).get() as {
        source_version: number
        target_version: number
        legacy_snapshot_compatibility: number
      } | undefined
      if (database.pragma('user_version', { simple: true }) !== 15 ||
          migration?.source_version !== 0 || migration.target_version !== 15 ||
          migration.legacy_snapshot_compatibility !== 0)
        throw new Error('state is not native Node schema')
    } finally {
      database.close()
    }
    const after = await lstat(path)
    if (`${after.dev}:${after.ino}` !== request.stateIdentity)
      throw new Error('native state identity changed')
  } catch {
    throw new CredentialEnrollmentUtilityError('native_unavailable')
  }
}

function asOnlineRequest(request: {
  nativeStatePath: string
  targetId: string
  enrollmentId: string
  expectedRevision: number
}, version: 2 | 3) {
  return {
    version,
    sourceStatePath: request.nativeStatePath,
    backupStatePath: request.nativeStatePath,
    workingStatePath: request.nativeStatePath,
    targetId: request.targetId,
    enrollmentId: request.enrollmentId,
    expectedRevision: request.expectedRevision
  }
}

/** Store a native target key using the same pending-intent transaction as the copy helper. */
export async function runNativeCredentialWrite(
  input: unknown,
  options: { credentialFd?: number; keyring?: ExactCredentialKeyring } = {}
): Promise<{ status: 'stored'; targetId: string; enrollmentId: string }> {
  const parsed = nativeCredentialWriteRequestSchema.safeParse(input)
  if (!parsed.success || parsed.data.targetId === parsed.data.enrollmentId)
    throw new CredentialEnrollmentUtilityError('invalid_request')
  const request = parsed.data
  try {
    return await runOnlineCredentialWrite(asOnlineRequest(request, 2), {
      ...options,
      verifyCopy: () => verifyNativeCredentialState(request),
      requireNewCredential: true
    })
  } catch (error) {
    if (error instanceof CredentialEnrollmentUtilityError && error.code === 'copy_unavailable')
      throw new CredentialEnrollmentUtilityError('native_unavailable')
    throw error
  }
}

/** Replace only a pending native target key, preserving the online backup and recovery rules. */
export async function runNativeCredentialReplacement(
  input: unknown,
  options: { credentialFd?: number; keyring?: ExactCredentialKeyring } = {}
): Promise<{ status: 'stored'; targetId: string; enrollmentId: string }> {
  const parsed = nativeCredentialReplaceRequestSchema.safeParse(input)
  if (!parsed.success || parsed.data.targetId === parsed.data.enrollmentId)
    throw new CredentialEnrollmentUtilityError('invalid_request')
  const request = parsed.data
  try {
    return await runOnlineCredentialReplacement(asOnlineRequest(request, 3), {
      ...options,
      verifyCopy: () => verifyNativeCredentialState(request)
    })
  } catch (error) {
    if (error instanceof CredentialEnrollmentUtilityError && error.code === 'copy_unavailable')
      throw new CredentialEnrollmentUtilityError('native_unavailable')
    throw error
  }
}

/** Run only while this utility owns the isolated copy lock; no live server transport can survive it. */
export async function runCredentialEnrollment(
  input: unknown,
  options: { credentialFd?: number; keyring?: ExactCredentialKeyring } = {}
): Promise<{ status: 'stored'; targetId: string; revision: number }> {
  const parsed = credentialEnrollmentRequestSchema.safeParse(input)
  if (!parsed.success || process.platform !== 'linux') {
    throw new CredentialEnrollmentUtilityError('invalid_request')
  }
  const request = parsed.data
  if (CredentialReference.forTarget(request.targetId).targetId !== request.targetId) {
    throw new CredentialEnrollmentUtilityError('invalid_request')
  }
  const fd = options.credentialFd ?? 3
  assertPrivateKeyDescriptor(fd)
  if (!options.keyring && !process.env.DBUS_SESSION_BUS_ADDRESS) {
    throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')
  }
  try {
    await verifyIsolatedCopy(
      request.sourceStatePath,
      request.backupStatePath,
      request.workingStatePath
    )
  } catch {
    throw new CredentialEnrollmentUtilityError('copy_unavailable')
  }
  let lock: IsolatedCopyLock
  try {
    lock = IsolatedCopyLock.acquire(request.workingStatePath)
  } catch {
    throw new CredentialEnrollmentUtilityError('owner_busy')
  }
  let enrollment: RemoteCredentialEnrollmentService | undefined
  try {
    try {
      await verifyIsolatedCopy(
        request.sourceStatePath,
        request.backupStatePath,
        request.workingStatePath
      )
    } catch {
      throw new CredentialEnrollmentUtilityError('copy_unavailable')
    }
    const keyring =
      options.keyring ??
      (await SecretServiceCredentialProvider.create(
        join(dirname(request.workingStatePath), 'remote-agent-brokers'),
        IsolatedCredentialScope.load(request.workingStatePath)
      ))
    enrollment = await RemoteCredentialEnrollmentService.create({
      workingStatePath: request.workingStatePath,
      keyring,
      // The exclusive owner lock excludes the Node server and its live transports.
      revokeTargetTransports: () => Promise.resolve()
    })
    await enrollment.enroll({
      targetId: request.targetId,
      expectedRevision: request.expectedRevision,
      credentialFd: fd
    })
    return { status: 'stored', targetId: request.targetId, revision: request.expectedRevision + 1 }
  } finally {
    try {
      enrollment?.close()
    } finally {
      try {
        lock.close()
      } finally {
        try {
          closeSync(fd)
        } catch {
          /* Provider may already have consumed fd 3. */
        }
      }
    }
  }
}

/**
 * The live server owns the copy. A short SQLite write transaction keeps startup
 * recovery from removing the intent while the helper writes the exact v2 item.
 * The key is inherited as fd 3 and never enters a renderer or HTTP request.
 */
export async function runOnlineCredentialWrite(
  input: unknown,
  options: {
    credentialFd?: number
    keyring?: ExactCredentialKeyring
    verifyCopy?: (source: string, backup: string, working: string) => Promise<unknown>
    requireNewCredential?: boolean
  } = {}
): Promise<{ status: 'stored'; targetId: string; enrollmentId: string }> {
  const parsed = onlineCredentialWriteRequestSchema.safeParse(input)
  if (!parsed.success || process.platform !== 'linux') {
    throw new CredentialEnrollmentUtilityError('invalid_request')
  }
  const request = parsed.data
  if (CredentialReference.forTarget(request.targetId).targetId !== request.targetId) {
    throw new CredentialEnrollmentUtilityError('invalid_request')
  }
  const fd = options.credentialFd ?? 3
  assertPrivateKeyDescriptor(fd)
  if (!options.keyring && !process.env.DBUS_SESSION_BUS_ADDRESS) {
    throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')
  }
  try {
    await (options.verifyCopy ?? verifyIsolatedCopy)(
      request.sourceStatePath,
      request.backupStatePath,
      request.workingStatePath
    )
  } catch {
    throw new CredentialEnrollmentUtilityError('copy_unavailable')
  }
  let database: Database.Database | undefined
  let transactionOpen = false
  try {
    database = new Database(request.workingStatePath, { fileMustExist: true, timeout: 30_000 })
    database.pragma('foreign_keys = ON')
    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    const pending = database.prepare(
      `SELECT expected_revision FROM remote_credential_enrollments
       WHERE enrollment_id = ? AND remote_target_id = ?`
    ).get(request.enrollmentId, request.targetId) as { expected_revision: number } | undefined
    const target = database.prepare(
      'SELECT 1 FROM remote_targets WHERE remote_target_id = ?'
    ).get(request.targetId)
    if (!pending || pending.expected_revision !== 0 || target) {
      throw new CredentialEnrollmentUtilityError('invalid_request')
    }
    const completed = database.prepare(
      'SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ?'
    ).get(ONLINE_ENROLLMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH, request.enrollmentId)
    if (completed) throw new CredentialEnrollmentUtilityError('invalid_request')
    const keyring = options.keyring ?? await SecretServiceCredentialProvider.create(
      join(dirname(request.workingStatePath), 'remote-agent-brokers'),
      IsolatedCredentialScope.load(request.workingStatePath)
    )
    keyring.validateInheritedFd(fd)
    if (options.requireNewCredential) {
      if (!keyring.has || !keyring.enrollNewFromInheritedFd ||
          await keyring.has(request.targetId))
        throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')
      await keyring.enrollNewFromInheritedFd(request.targetId, fd)
    } else {
      await keyring.enrollFromInheritedFd(request.targetId, fd)
    }
    database.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES (?,?,?,?,?,?)`
    ).run(
      ONLINE_ENROLLMENT_MARKER_NAMESPACE,
      ONLINE_ENROLLMENT_MARKER_EPOCH,
      request.enrollmentId,
      request.targetId,
      '{"status":"stored"}',
      Date.now()
    )
    database.exec('COMMIT')
    transactionOpen = false
    return {
      status: 'stored',
      targetId: request.targetId,
      enrollmentId: request.enrollmentId
    }
  } finally {
    if (transactionOpen) {
      try { database?.exec('ROLLBACK') } catch { /* The process may already be closing. */ }
    }
    database?.close()
    try { closeSync(fd) } catch { /* The provider may already have consumed fd 3. */ }
  }
}

/**
 * Backs up the exact old v2 item before replacing it. The durable backup-ready
 * marker survives a crash after the new key is written but before completion.
 */
export async function runOnlineCredentialReplacement(
  input: unknown,
  options: {
    credentialFd?: number
    keyring?: ExactCredentialKeyring
    verifyCopy?: (source: string, backup: string, working: string) => Promise<unknown>
  } = {}
): Promise<{ status: 'stored'; targetId: string; enrollmentId: string }> {
  const parsed = onlineCredentialReplaceRequestSchema.safeParse(input)
  if (!parsed.success || process.platform !== 'linux')
    throw new CredentialEnrollmentUtilityError('invalid_request')
  const request = parsed.data
  if (CredentialReference.forTarget(request.targetId).targetId !== request.targetId)
    throw new CredentialEnrollmentUtilityError('invalid_request')
  const fd = options.credentialFd ?? 3
  assertPrivateKeyDescriptor(fd)
  if (!options.keyring && !process.env.DBUS_SESSION_BUS_ADDRESS)
    throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')
  try {
    await (options.verifyCopy ?? verifyIsolatedCopy)(
      request.sourceStatePath, request.backupStatePath, request.workingStatePath
    )
  } catch {
    throw new CredentialEnrollmentUtilityError('copy_unavailable')
  }
  let database: Database.Database | undefined
  let transactionOpen = false
  try {
    database = new Database(request.workingStatePath, { fileMustExist: true, timeout: 30_000 })
    database.pragma('foreign_keys = ON')
    const keyring = options.keyring ?? await SecretServiceCredentialProvider.create(
      join(dirname(request.workingStatePath), 'remote-agent-brokers'),
      IsolatedCredentialScope.load(request.workingStatePath)
    )
    const aliasInUse = database.prepare(
      `SELECT 1 FROM remote_targets WHERE remote_target_id = ?
       UNION ALL SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ? LIMIT 1`
    ).get(request.enrollmentId, request.enrollmentId)
    if (aliasInUse) throw new CredentialEnrollmentUtilityError('invalid_request')
    keyring.validateInheritedFd(fd)
    const validatePending = () => {
      const pending = database!.prepare(
        `SELECT 1 FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = ?`
      ).get(request.enrollmentId, request.targetId, request.expectedRevision)
      const target = database!.prepare(
        'SELECT revision FROM remote_targets WHERE remote_target_id = ?'
      ).get(request.targetId) as { revision: number } | undefined
      const deleting = database!.prepare(
        'SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?'
      ).get(request.targetId)
      if (!pending || target?.revision !== request.expectedRevision || deleting)
        throw new CredentialEnrollmentUtilityError('invalid_request')
    }
    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    validatePending()
    const v1Baseline = Boolean(database.prepare(
      `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
       AND idempotency_key = ? AND request_hash = ? AND result_json = '{"status":"pending"}'`
    ).get(ONLINE_V1_REPLACEMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      request.enrollmentId, request.targetId))
    if (v1Baseline) {
      const origin = database.prepare(
        `SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?
         AND origin = 'v1_eligible' AND committed_revision IS NULL`
      ).get(request.targetId)
      if (!origin) throw new CredentialEnrollmentUtilityError('invalid_request')
    } else if (!keyring.backupForReplacement) {
      throw new CredentialEnrollmentUtilityError('invalid_request')
    }
    const prior = database.prepare(
      'SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ?'
    ).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH, request.enrollmentId)
    if (prior) throw new CredentialEnrollmentUtilityError('invalid_request')
    if (!v1Baseline) {
      await keyring.backupForReplacement!(request.targetId, request.enrollmentId)
      database.prepare(
      `INSERT INTO idempotency_results
       (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
       VALUES (?,?,?,?,?,?)`
      ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
        request.enrollmentId, request.targetId, '{"status":"backupReady"}', Date.now())
    }
    database.exec('COMMIT')
    transactionOpen = false

    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    validatePending()
    await keyring.enrollFromInheritedFd(request.targetId, fd)
    if (v1Baseline) {
      database.prepare(
        `INSERT INTO idempotency_results
         (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
         VALUES (?,?,?,?,?,?)`
      ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
        request.enrollmentId, request.targetId, '{"status":"stored"}', Date.now())
    } else {
      const completed = database.prepare(
        `UPDATE idempotency_results SET result_json = ?, completed_at_ms = ?
         WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?
         AND result_json = '{"status":"backupReady"}'`
      ).run('{"status":"stored"}', Date.now(), ONLINE_REPLACEMENT_MARKER_NAMESPACE,
        ONLINE_ENROLLMENT_MARKER_EPOCH, request.enrollmentId, request.targetId)
      if (completed.changes !== 1) throw new CredentialEnrollmentUtilityError('invalid_request')
    }
    database.exec('COMMIT')
    transactionOpen = false
    return { status: 'stored', targetId: request.targetId, enrollmentId: request.enrollmentId }
  } finally {
    if (transactionOpen) {
      try { database?.exec('ROLLBACK') } catch { /* The process may already be closing. */ }
    }
    database?.close()
    try { closeSync(fd) } catch { /* The provider may already have consumed fd 3. */ }
  }
}

/** Write a v2-scoped item only for an explicit, still-pending live v1 replacement. */
export async function runLiveCredentialV1Replacement(
  input: unknown,
  options: { credentialFd?: number; keyring?: ExactCredentialKeyring } = {}
): Promise<{ status: 'stored'; targetId: string; enrollmentId: string }> {
  return runLiveCredentialReplacementInternal(input, options, true)
}

/** Replace a marked live v1 or v2 credential while the Node writer is stopped. */
export async function runLiveCredentialReplacement(
  input: unknown,
  options: { credentialFd?: number; keyring?: ExactCredentialKeyring } = {}
): Promise<{ status: 'stored'; targetId: string; enrollmentId: string }> {
  return runLiveCredentialReplacementInternal(input, options, false)
}

/** Store one new live v2 key under both owner fences; catalog publication follows resume. */
export async function runLiveCredentialNew(
  input: unknown,
  options: { credentialFd?: number; keyring?: ExactCredentialKeyring; probeV1?: () => Promise<string> } = {}
): Promise<{ status: 'stored'; targetId: string; enrollmentId: string }> {
  const parsed = liveCredentialNewRequestSchema.safeParse(input)
  if (!parsed.success || process.platform !== 'linux')
    throw new CredentialEnrollmentUtilityError('invalid_request')
  const request = parsed.data
  if (request.targetId === request.enrollmentId ||
      CredentialReference.forTarget(request.targetId).targetId !== request.targetId)
    throw new CredentialEnrollmentUtilityError('invalid_request')
  const fd = options.credentialFd ?? 3
  assertPrivateKeyDescriptor(fd)
  if (!options.keyring && !process.env.DBUS_SESSION_BUS_ADDRESS)
    throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')
  try { verifyLiveCredentialStateProof(request) } catch {
    throw new CredentialEnrollmentUtilityError('copy_unavailable')
  }
  let owner: LiveOwnerLock
  try { owner = LiveOwnerLock.acquire(request.liveStatePath) } catch {
    throw new CredentialEnrollmentUtilityError('owner_busy')
  }
  let database: Database.Database | undefined
  let transactionOpen = false
  try {
    try {
      owner.assertDatabasePath(request.liveStatePath)
      verifyLiveCredentialStateProof(request)
      const report = inspectLegacyDatabase(request.liveStatePath)
      if (report.snapshotRevision === null || report.legacySnapshotCompatibility)
        throw new Error('Live state is not normalized')
    } catch { throw new CredentialEnrollmentUtilityError('copy_unavailable') }
    database = new Database(request.liveStatePath, { fileMustExist: true, timeout: 5_000 })
    owner.assertDatabaseUnchanged()
    database.pragma('foreign_keys = ON')
    if (database.pragma('user_version', { simple: true }) !== 15)
      throw new CredentialEnrollmentUtilityError('invalid_request')
    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    const pending = database.prepare(
      `SELECT 1 FROM remote_credential_enrollments
       WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = 0`
    ).get(request.enrollmentId, request.targetId)
    const marker = database.prepare(
      `SELECT result_json FROM idempotency_results WHERE namespace = ? AND epoch = ?
       AND idempotency_key = ? AND request_hash = ?`
    ).get(LIVE_NEW_ENROLLMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      request.enrollmentId, request.targetId) as { result_json: string } | undefined
    const history = database.prepare(
      `SELECT 1 FROM remote_targets WHERE remote_target_id = ?
       UNION ALL SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?
       UNION ALL SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ? LIMIT 1`
    ).get(request.targetId, request.targetId, request.targetId)
    const alias = database.prepare(
      `SELECT 1 FROM remote_targets WHERE remote_target_id = ?
       UNION ALL SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?
       UNION ALL SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ? LIMIT 1`
    ).get(request.enrollmentId, request.enrollmentId, request.enrollmentId)
    if (!pending || marker?.result_json !== '{"status":"pending"}' || history || alias)
      throw new CredentialEnrollmentUtilityError('invalid_request')
    const keyring = options.keyring ?? await SecretServiceCredentialProvider.create(
      join(dirname(request.liveStatePath), 'remote-agent-brokers'),
      IsolatedCredentialScope.load(request.liveStatePath)
    )
    if (!keyring.has || !keyring.enrollNewFromInheritedFd || await keyring.has(request.targetId))
      throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')
    const v1Presence = options.probeV1
      ? await options.probeV1()
      : await probeExactCredentialPresence(CredentialReference.forTarget(request.targetId))
    if (v1Presence !== 'missing')
      throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')
    keyring.validateInheritedFd(fd)
    await keyring.enrollNewFromInheritedFd(request.targetId, fd)
    const changed = database.prepare(
      `UPDATE idempotency_results SET result_json = ?, completed_at_ms = ?
       WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?
       AND result_json = '{"status":"pending"}'`
    ).run('{"status":"stored"}', Date.now(), LIVE_NEW_ENROLLMENT_NAMESPACE,
      ONLINE_ENROLLMENT_MARKER_EPOCH, request.enrollmentId, request.targetId)
    if (changed.changes !== 1) throw new CredentialEnrollmentUtilityError('invalid_request')
    database.exec('COMMIT')
    transactionOpen = false
    return { status: 'stored', targetId: request.targetId, enrollmentId: request.enrollmentId }
  } finally {
    if (transactionOpen) try { database?.exec('ROLLBACK') } catch { /* Recovery retains intent. */ }
    try { database?.close() } finally {
      try { owner.close() } finally {
        try { closeSync(fd) } catch { /* Key provider may consume fd. */ }
      }
    }
  }
}

async function runLiveCredentialReplacementInternal(
  input: unknown,
  options: { credentialFd?: number; keyring?: ExactCredentialKeyring },
  v1Only: boolean
): Promise<{ status: 'stored'; targetId: string; enrollmentId: string }> {
  const parsed = (v1Only ? liveCredentialV1ReplaceRequestSchema :
    liveCredentialReplaceRequestSchema).safeParse(input)
  if (!parsed.success || process.platform !== 'linux')
    throw new CredentialEnrollmentUtilityError('invalid_request')
  const request = parsed.data
  if (CredentialReference.forTarget(request.targetId).targetId !== request.targetId)
    throw new CredentialEnrollmentUtilityError('invalid_request')
  const fd = options.credentialFd ?? 3
  assertPrivateKeyDescriptor(fd)
  if (!options.keyring && !process.env.DBUS_SESSION_BUS_ADDRESS)
    throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')

  // The backup must already exist before this helper acquires ownership.
  try {
    verifyLiveCredentialStateProof(request)
  } catch {
    throw new CredentialEnrollmentUtilityError('copy_unavailable')
  }
  let owner: LiveOwnerLock
  try {
    owner = LiveOwnerLock.acquire(request.liveStatePath)
  } catch {
    throw new CredentialEnrollmentUtilityError('owner_busy')
  }
  let database: Database.Database | undefined
  let transactionOpen = false
  try {
    try {
      owner.assertDatabasePath(request.liveStatePath)
      verifyLiveCredentialStateProof(request)
      const live = inspectLegacyDatabase(request.liveStatePath)
      if (live.snapshotRevision === null || live.legacySnapshotCompatibility)
        throw new Error('Live state is not normalized')
    } catch {
      throw new CredentialEnrollmentUtilityError('copy_unavailable')
    }
    database = new Database(request.liveStatePath, { fileMustExist: true, timeout: 5_000 })
    owner.assertDatabaseUnchanged()
    database.pragma('foreign_keys = ON')
    if (database.pragma('user_version', { simple: true }) !== 15)
      throw new CredentialEnrollmentUtilityError('invalid_request')
    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    const pending = database.prepare(
      `SELECT 1 FROM remote_credential_enrollments
       WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = ?`
    ).get(request.enrollmentId, request.targetId, request.expectedRevision)
    const target = database.prepare(
      'SELECT revision FROM remote_targets WHERE remote_target_id = ?'
    ).get(request.targetId) as { revision: number } | undefined
    const deleting = database.prepare(
      'SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?'
    ).get(request.targetId)
    const v1Pending = database.prepare(
      `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
       AND idempotency_key = ? AND request_hash = ? AND result_json = '{"status":"pending"}'`
    ).get(ONLINE_V1_REPLACEMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      request.enrollmentId, request.targetId)
    const origin = database.prepare(
      'SELECT origin,committed_revision FROM node_live_credential_origins WHERE remote_target_id = ?'
    ).get(request.targetId) as { origin: string; committed_revision: number | null } | undefined
    const v1Baseline = origin?.origin === 'v1_eligible' && origin.committed_revision === null
    const prior = database.prepare(
      'SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ?'
    ).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      request.enrollmentId)
    const aliasInUse = database.prepare(
      `SELECT 1 FROM remote_targets WHERE remote_target_id = ?
       UNION ALL SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ? LIMIT 1`
    ).get(request.enrollmentId, request.enrollmentId)
    if (!pending || target?.revision !== request.expectedRevision || deleting ||
        prior || aliasInUse ||
        (v1Baseline ? !v1Pending : v1Only || !!v1Pending ||
          origin?.origin !== 'v2_committed' || origin.committed_revision === null ||
          !Number.isSafeInteger(origin.committed_revision) ||
          origin.committed_revision < 1 || origin.committed_revision > request.expectedRevision))
      throw new CredentialEnrollmentUtilityError('invalid_request')
    const keyring = options.keyring ?? await SecretServiceCredentialProvider.create(
      join(dirname(request.liveStatePath), 'remote-agent-brokers'),
      IsolatedCredentialScope.load(request.liveStatePath)
    )
    keyring.validateInheritedFd(fd)
    if (!v1Baseline) {
      if (!keyring.backupForReplacement || !keyring.restoreReplacement || !keyring.has ||
          !(await keyring.has(request.targetId)))
        throw new CredentialEnrollmentUtilityError('credential_provider_unavailable')
      await keyring.backupForReplacement(request.targetId, request.enrollmentId)
      database.prepare(
        `INSERT INTO idempotency_results
         (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
         VALUES (?,?,?,?,?,?)`
      ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
        request.enrollmentId, request.targetId, '{"status":"backupReady"}', Date.now())
      database.exec('COMMIT')
      transactionOpen = false
      database.exec('BEGIN IMMEDIATE')
      transactionOpen = true
      const stillPending = database.prepare(
        `SELECT 1 FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = ?`
      ).get(request.enrollmentId, request.targetId, request.expectedRevision)
      const stillTarget = database.prepare(
        'SELECT revision FROM remote_targets WHERE remote_target_id = ?'
      ).get(request.targetId) as { revision: number } | undefined
      const stillOrigin = database.prepare(
        `SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?
         AND origin = 'v2_committed' AND committed_revision BETWEEN 1 AND ?`
      ).get(request.targetId, request.expectedRevision)
      const stillDeleting = database.prepare(
        'SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?'
      ).get(request.targetId)
      if (!stillPending || stillTarget?.revision !== request.expectedRevision ||
          !stillOrigin || stillDeleting)
        throw new CredentialEnrollmentUtilityError('invalid_request')
    }
    await keyring.enrollFromInheritedFd(request.targetId, fd)
    if (v1Baseline) {
      database.prepare(
        `INSERT INTO idempotency_results
         (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
         VALUES (?,?,?,?,?,?)`
      ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
        request.enrollmentId, request.targetId, '{"status":"stored"}', Date.now())
    } else {
      const changed = database.prepare(
        `UPDATE idempotency_results SET result_json = ?, completed_at_ms = ?
         WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?
         AND result_json = '{"status":"backupReady"}'`
      ).run('{"status":"stored"}', Date.now(), ONLINE_REPLACEMENT_MARKER_NAMESPACE,
        ONLINE_ENROLLMENT_MARKER_EPOCH, request.enrollmentId, request.targetId)
      if (changed.changes !== 1) throw new CredentialEnrollmentUtilityError('invalid_request')
    }
    database.exec('COMMIT')
    transactionOpen = false
    return { status: 'stored', targetId: request.targetId, enrollmentId: request.enrollmentId }
  } finally {
    if (transactionOpen) {
      try { database?.exec('ROLLBACK') } catch { /* The process may already be closing. */ }
    }
    try { database?.close() } finally {
      try { owner.close() } finally {
        try { closeSync(fd) } catch { /* The provider may already have consumed fd 3. */ }
      }
    }
  }
}
