import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import Database from 'better-sqlite3'

import type { LiveOwnerLock } from '../persistence/live-owner-lock'
import { CredentialReference } from './credential-provider'
import {
  ONLINE_ENROLLMENT_MARKER_EPOCH,
  ONLINE_ENROLLMENT_MARKER_NAMESPACE,
  ONLINE_REPLACEMENT_MARKER_NAMESPACE,
  ONLINE_REPLACEMENT_CLEANUP_NAMESPACE,
  ONLINE_V1_REPLACEMENT_NAMESPACE
} from './credential-enrollment-marker'
import { LIVE_NEW_ENROLLMENT_NAMESPACE } from './credential-enrollment-marker'
import type { SecretServiceCredentialProvider } from './credential-secret-service'
import { sharedRemoteTargetOperationLock, type RemoteTargetOperationLock } from './remote-target-operation-lock'

const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER

export class RemoteCredentialEnrollmentError extends Error {
  public constructor(public readonly code:
    'invalid_target' | 'stale_revision' | 'enrollment_conflict' | 'cleanup_required' | 'storage_unavailable') {
    super(code.replaceAll('_', ' '))
    this.name = 'RemoteCredentialEnrollmentError'
  }
}

export interface ExactCredentialKeyring {
  validateInheritedFd(fd: number): void
  enrollFromInheritedFd(targetId: string, fd: number): Promise<void>
  enrollNewFromInheritedFd?(targetId: string, fd: number): Promise<void>
  delete(targetId: string): Promise<void>
  has?(targetId: string): Promise<boolean>
  hasV1?(targetId: string): Promise<boolean>
  backupForReplacement?(targetId: string, enrollmentId: string): Promise<void>
  restoreReplacement?(targetId: string, enrollmentId: string): Promise<boolean>
  probeRustCredentialForCutover?(targetId: string): Promise<boolean>
}

interface PendingRow { enrollment_id: string; remote_target_id: string; expected_revision: number }
interface PreservedLiveReplacement {
  targetId: string
  enrollmentId: string
  expectedRevision: number
  owner: Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'>
}
interface PreservedLiveNew {
  targetId: string
  enrollmentId: string
  owner: Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'>
}

/**
 * Coordinates Rust-v15 enrollment intents with an exact target Secret Service item.
 * Call only from a dedicated child utility with the selected key inherited as fd 3.
 */
export class RemoteCredentialEnrollmentService {
  private closed = false

  private constructor(
    private readonly database: Database.Database,
    private readonly keyring: ExactCredentialKeyring,
    private readonly revokeTargetTransports: (targetId: string) => Promise<void>,
    private readonly now: () => number,
    private readonly targetLock: RemoteTargetOperationLock,
    private readonly preservedLiveReplacement?: PreservedLiveReplacement,
    private readonly liveMode = false,
    private readonly preservedLiveNew?: PreservedLiveNew,
    private readonly nativeMode = false
  ) {}

  public static async create(input: {
    workingStatePath: string
    keyring: SecretServiceCredentialProvider | ExactCredentialKeyring
    revokeTargetTransports: (targetId: string) => Promise<void>
    now?: () => number
    targetLock?: RemoteTargetOperationLock
    preserveLiveV1Replacement?: PreservedLiveReplacement
    preserveLiveReplacement?: PreservedLiveReplacement
    preserveLiveNew?: PreservedLiveNew
    liveMode?: boolean
    nativeMode?: boolean
  }): Promise<RemoteCredentialEnrollmentService> {
    await validateWorkingDatabase(input.workingStatePath)
    if (input.nativeMode && input.liveMode)
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    if ((input.preserveLiveV1Replacement && input.preserveLiveReplacement) ||
        (input.preserveLiveNew && (input.preserveLiveReplacement || input.preserveLiveV1Replacement)))
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    const preserved = input.preserveLiveReplacement ?? input.preserveLiveV1Replacement
    preserved?.owner.assertDatabasePath(input.workingStatePath)
    let database: Database.Database | undefined
    try {
      database = new Database(input.workingStatePath, { fileMustExist: true, timeout: 5_000 })
      database.pragma('foreign_keys = ON')
      database.prepare('SELECT enrollment_id FROM remote_credential_enrollments LIMIT 1').get()
    } catch {
      database?.close()
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    }
    const service = new RemoteCredentialEnrollmentService(
      database, input.keyring, input.revokeTargetTransports, input.now ?? Date.now,
      input.targetLock ?? sharedRemoteTargetOperationLock, preserved,
      input.liveMode ?? false, input.preserveLiveNew, input.nativeMode ?? false
    )
    try {
      if (preserved) await service.validatePreservedLiveReplacement(!!input.preserveLiveV1Replacement)
      if (input.preserveLiveNew) await service.validatePreservedLiveNew()
      await service.recoverInterrupted()
      await service.recoverReplacementCleanup()
      return service
    } catch (error) {
      database.close()
      throw error
    }
  }

  public usesTargetLock(lock: RemoteTargetOperationLock): boolean {
    return this.targetLock === lock
  }

  public get supportsReplacement(): boolean {
    return typeof this.keyring.has === 'function' &&
      ((typeof this.keyring.backupForReplacement === 'function' &&
        typeof this.keyring.restoreReplacement === 'function') ||
        typeof this.keyring.hasV1 === 'function')
  }

  /** Reserve a new target before the separate fd-only helper writes its scoped key. */
  public async beginOnlineNew(targetId: string, enrollmentId: string): Promise<string> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    if (!isUuid(enrollmentId)) throw new RemoteCredentialEnrollmentError('invalid_target')
    return this.targetLock.withTarget(exactId, async () => {
      if (this.liveMode) {
        if (!this.hasLiveOriginTable() || this.isTargetIdentity(exactId) ||
            this.isTargetIdentity(enrollmentId) ||
            this.database.prepare('SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?').get(exactId) ||
            this.database.prepare('SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?').get(enrollmentId) ||
            !this.keyring.has || !this.keyring.probeRustCredentialForCutover ||
            await this.keyring.has(exactId) ||
            await this.keyring.probeRustCredentialForCutover(exactId))
          throw new RemoteCredentialEnrollmentError('storage_unavailable')
      }
      const existing = this.database.prepare(
        `SELECT expected_revision FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ?`
      ).get(enrollmentId, exactId) as { expected_revision: number } | undefined
      if (existing?.expected_revision === 0) {
        if (this.liveMode && !this.liveNewMarkerIs(enrollmentId, exactId, 'pending'))
          throw new RemoteCredentialEnrollmentError('enrollment_conflict')
        return enrollmentId
      }
      if (this.nativeMode && (!this.keyring.has || await this.keyring.has(exactId)))
        throw new RemoteCredentialEnrollmentError('storage_unavailable')
      this.reserve(enrollmentId, exactId, 0)
      return enrollmentId
    })
  }

  public async beginOnlineReplacement(
    targetId: string, enrollmentId: string, expectedRevision: number, v1Only = false
  ): Promise<string> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    if (!isUuid(enrollmentId) || !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1 || expectedRevision >= MAX_SAFE_REVISION) {
      throw new RemoteCredentialEnrollmentError('invalid_target')
    }
    return this.targetLock.withTarget(exactId, async () => {
      if (this.isTargetIdentity(enrollmentId))
        throw new RemoteCredentialEnrollmentError('invalid_target')
      const v1Baseline = this.isV1Eligible(exactId)
      if (v1Only && !v1Baseline)
        throw new RemoteCredentialEnrollmentError('stale_revision')
      if (!v1Baseline && this.hasLiveOriginTable() &&
          !this.isV2Committed(exactId, expectedRevision))
        throw new RemoteCredentialEnrollmentError('stale_revision')
      if (v1Baseline ? !this.keyring.hasV1 || !(await this.keyring.hasV1(exactId)) :
          !this.keyring.backupForReplacement || !this.keyring.restoreReplacement ||
          !this.keyring.has || !(await this.keyring.has(exactId)))
        throw new RemoteCredentialEnrollmentError('storage_unavailable')
      const existing = this.database.prepare(
        `SELECT expected_revision FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ?`
      ).get(enrollmentId, exactId) as { expected_revision: number } | undefined
      if (existing?.expected_revision === expectedRevision) return enrollmentId
      this.reserve(enrollmentId, exactId, expectedRevision, v1Baseline)
      return enrollmentId
    })
  }

  public async commitOnlineReplacement<T>(
    enrollmentId: string,
    targetId: string,
    expectedRevision: number,
    readTarget: () => Promise<T>,
    v1Only = false
  ): Promise<T> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    if (!isUuid(enrollmentId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new RemoteCredentialEnrollmentError('invalid_target')
    return this.targetLock.withTarget(exactId, async () => {
      const pending = this.database.prepare(
        `SELECT 1 FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = ?`
      ).get(enrollmentId, exactId, expectedRevision)
      const target = this.database.prepare(
        'SELECT revision FROM remote_targets WHERE remote_target_id = ?'
      ).get(exactId) as { revision: number } | undefined
      if (!pending || target?.revision !== expectedRevision)
        throw new RemoteCredentialEnrollmentError('stale_revision')
      const v1Baseline = this.isV1Pending(enrollmentId, exactId)
      if (v1Only && !v1Baseline)
        throw new RemoteCredentialEnrollmentError('stale_revision')
      const completed = this.database.prepare(
        `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
         AND idempotency_key = ? AND request_hash = ? AND result_json = '{"status":"stored"}'`
      ).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
        enrollmentId, exactId)
      if (!completed) throw new RemoteCredentialEnrollmentError('stale_revision')
      if (!this.keyring.has || !(await this.keyring.has(exactId)))
        throw new RemoteCredentialEnrollmentError('storage_unavailable')
      await this.revokeTargetTransports(exactId).catch(() => {
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      })
      this.commitExact(enrollmentId, exactId, expectedRevision, true)
      if (!v1Baseline) await this.finishReplacementBackup(enrollmentId, exactId)
      return readTarget()
    })
  }

  public async abortOnlineReplacement(
    enrollmentId: string, targetId: string, v1Only = false
  ): Promise<void> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    if (!isUuid(enrollmentId)) throw new RemoteCredentialEnrollmentError('invalid_target')
    await this.targetLock.withTarget(exactId, async () => {
      const pending = this.database.prepare(
        `SELECT expected_revision FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ?`
      ).get(enrollmentId, exactId) as { expected_revision: number } | undefined
      if (!pending || pending.expected_revision < 1 ||
          (v1Only && !this.isV1Pending(enrollmentId, exactId)))
        throw new RemoteCredentialEnrollmentError('stale_revision')
      await this.restorePendingReplacement(enrollmentId, exactId)
    })
  }

  /** The catalog commit must create the target and remove its intent atomically. */
  public async commitOnlineNew<T>(
    enrollmentId: string,
    targetId: string,
    commitCatalog: () => Promise<T>
  ): Promise<T> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    if (!isUuid(enrollmentId)) throw new RemoteCredentialEnrollmentError('invalid_target')
    return this.targetLock.withTarget(exactId, async () => {
      const pending = this.database.prepare(
        `SELECT 1 FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = 0`
      ).get(enrollmentId, exactId)
      if (!pending) throw new RemoteCredentialEnrollmentError('stale_revision')
      const completed = this.database.prepare(
        `SELECT 1 FROM idempotency_results
         WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?
         AND result_json = '{"status":"stored"}'`
      ).get(this.liveMode ? LIVE_NEW_ENROLLMENT_NAMESPACE : ONLINE_ENROLLMENT_MARKER_NAMESPACE,
        ONLINE_ENROLLMENT_MARKER_EPOCH, enrollmentId, exactId)
      if (!completed) throw new RemoteCredentialEnrollmentError('stale_revision')
      if (this.liveMode && (this.isTargetIdentity(exactId) ||
          this.database.prepare('SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?').get(exactId) ||
          !this.keyring.probeRustCredentialForCutover ||
          await this.keyring.probeRustCredentialForCutover(exactId)))
        throw new RemoteCredentialEnrollmentError('storage_unavailable')
      if (!this.keyring.has || !(await this.keyring.has(exactId))) {
        throw new RemoteCredentialEnrollmentError('storage_unavailable')
      }
      return commitCatalog()
    })
  }

  /** New targets have no prior credential to preserve on cancellation. */
  public async abortOnlineNew(enrollmentId: string, targetId: string): Promise<void> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    if (!isUuid(enrollmentId)) throw new RemoteCredentialEnrollmentError('invalid_target')
    const pending = this.database.prepare(
      `SELECT 1 FROM remote_credential_enrollments
       WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = 0`
    ).get(enrollmentId, exactId)
    if (!pending) throw new RemoteCredentialEnrollmentError('stale_revision')
    await this.removeEnrollment(enrollmentId, exactId)
  }

  /** New targets use revision 0 and require commit after their catalog row is created. */
  public async enroll(input: {
    targetId: string
    expectedRevision: number
    credentialFd: number
  }): Promise<{ status: 'stored'; enrollmentId: string }> {
    this.requireOpen()
    const targetId = exactTargetId(input.targetId)
    return this.targetLock.withTarget(targetId, () => this.enrollLocked(input, targetId))
  }

  private async enrollLocked(input: {
    expectedRevision: number
    credentialFd: number
  }, targetId: string): Promise<{ status: 'stored'; enrollmentId: string }> {
    this.requireOpen()
    const expectedRevision = input.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || input.credentialFd !== 3)
      throw new RemoteCredentialEnrollmentError('invalid_target')
    this.keyring.validateInheritedFd(input.credentialFd)
    const enrollmentId = randomUUID()
    this.reserve(enrollmentId, targetId, expectedRevision)
    try {
      if (expectedRevision > 0) await this.revokeTargetTransports(targetId)
      await this.keyring.enrollFromInheritedFd(targetId, input.credentialFd)
      if (expectedRevision > 0) {
        this.commitExact(enrollmentId, targetId, expectedRevision)
        // Catch a launch that crossed the external keyring write and the DB revision fence.
        await this.revokeTargetTransports(targetId)
      }
      return { status: 'stored', enrollmentId }
    } catch (error) {
      await this.compensate(enrollmentId, targetId)
      if (error instanceof RemoteCredentialEnrollmentError) throw error
      throw new RemoteCredentialEnrollmentError('enrollment_conflict')
    }
  }

  /** Complete a new target's pending enrollment after target.create wrote revision 1. */
  public async commit(enrollmentId: string, targetId: string): Promise<{ status: 'stored' }> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    if (!isUuid(enrollmentId)) throw new RemoteCredentialEnrollmentError('invalid_target')
    return this.targetLock.withTarget(exactId, async () => {
      this.requireOpen()
      try {
        this.commitExact(enrollmentId, exactId, 0)
        return { status: 'stored' }
      } catch (error) {
        await this.compensate(enrollmentId, exactId)
        throw error
      }
    })
  }

  /** Remove the exact item while a durable target deletion fence is present. */
  public async removeForPendingDeletion(targetId: string): Promise<{ status: 'removed' }> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    return this.targetLock.withTarget(exactId, async () => {
      this.requireOpen()
      const pending = this.database.prepare(
        'SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?'
      ).get(exactId)
      if (!pending) throw new RemoteCredentialEnrollmentError('stale_revision')
      await this.revokeTargetTransports(exactId).catch(() => {
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      })
      await this.keyring.delete(exactId).catch(() => {
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      })
      return { status: 'removed' }
    })
  }

  /** Abort an enrollment only after exact-item deletion succeeds. */
  public async removeEnrollment(enrollmentId: string, targetId: string): Promise<{ status: 'removed' }> {
    this.requireOpen()
    const exactId = exactTargetId(targetId)
    if (!isUuid(enrollmentId) || !this.pendingIs(enrollmentId, exactId)) {
      throw new RemoteCredentialEnrollmentError('stale_revision')
    }
    return this.targetLock.withTarget(exactId, async () => {
      this.requireOpen()
      if (!this.pendingIs(enrollmentId, exactId)) throw new RemoteCredentialEnrollmentError('stale_revision')
      if (this.liveMode && (this.isTargetIdentity(exactId) ||
          this.database.prepare('SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?').get(exactId) ||
          !this.keyring.probeRustCredentialForCutover ||
          await this.keyring.probeRustCredentialForCutover(exactId)))
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      await this.revokeTargetTransports(exactId).catch(() => {
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      })
      await this.keyring.delete(exactId).catch(() => {
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      })
      this.deletePending(enrollmentId, exactId)
      return { status: 'removed' }
    })
  }

  /** Startup must finish this before any remote session can acquire credentials. */
  public async recoverInterrupted(): Promise<number> {
    this.requireOpen()
    const rows = this.database.prepare(
      'SELECT enrollment_id,remote_target_id,expected_revision FROM remote_credential_enrollments ORDER BY enrollment_id LIMIT 129'
    ).all() as PendingRow[]
    if (rows.length > 128) throw new RemoteCredentialEnrollmentError('storage_unavailable')
    let recovered = 0
    for (const row of rows) {
      const targetId = exactTargetId(row.remote_target_id)
      if (!isUuid(row.enrollment_id)) throw new RemoteCredentialEnrollmentError('storage_unavailable')
      if (this.isPreservedLiveReplacement(row)) continue
      if (this.isPreservedLiveNew(row)) continue
      await this.targetLock.withTarget(targetId, async () => {
        this.requireOpen()
        if (row.expected_revision > 0) {
          await this.restorePendingReplacement(row.enrollment_id, targetId)
          return
        }
        if (this.liveMode && (!this.liveNewMarkerIs(row.enrollment_id, targetId, 'pending') ||
            this.isTargetIdentity(targetId) ||
            this.database.prepare('SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?').get(targetId) ||
            !this.keyring.probeRustCredentialForCutover ||
            await this.keyring.probeRustCredentialForCutover(targetId)))
          throw new RemoteCredentialEnrollmentError('cleanup_required')
        await this.keyring.delete(targetId).catch(() => {
          throw new RemoteCredentialEnrollmentError('cleanup_required')
        })
        this.deletePending(row.enrollment_id, targetId)
      })
      recovered++
    }
    return recovered
  }

  private isPreservedLiveNew(row: PendingRow): boolean {
    const preserved = this.preservedLiveNew
    return !!preserved && row.expected_revision === 0 &&
      row.remote_target_id === preserved.targetId && row.enrollment_id === preserved.enrollmentId
  }

  private async validatePreservedLiveNew(): Promise<void> {
    const preserved = this.preservedLiveNew!
    const targetId = exactTargetId(preserved.targetId)
    if (!this.liveMode || !isUuid(preserved.enrollmentId) ||
        this.isTargetIdentity(targetId) || this.isTargetIdentity(preserved.enrollmentId))
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    preserved.owner.assertDatabaseUnchanged()
    const row = this.database.prepare(
      `SELECT 1 FROM remote_credential_enrollments WHERE enrollment_id = ?
       AND remote_target_id = ? AND expected_revision = 0`
    ).get(preserved.enrollmentId, targetId)
    const origin = this.database.prepare(
      'SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?'
    ).get(targetId)
    if (!row || origin || !this.liveNewMarkerIs(preserved.enrollmentId, targetId, 'stored') ||
        !this.keyring.has || !(await this.keyring.has(targetId)) ||
        !this.keyring.probeRustCredentialForCutover ||
        await this.keyring.probeRustCredentialForCutover(targetId))
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    preserved.owner.assertDatabaseUnchanged()
  }

  private liveNewMarkerIs(enrollmentId: string, targetId: string, status: 'pending' | 'stored'): boolean {
    return Boolean(this.database.prepare(
      `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
       AND idempotency_key = ? AND request_hash = ? AND result_json = ?`
    ).get(LIVE_NEW_ENROLLMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      enrollmentId, targetId, JSON.stringify({ status })))
  }

  private isPreservedLiveReplacement(row: PendingRow): boolean {
    const preserved = this.preservedLiveReplacement
    return !!preserved && row.remote_target_id === preserved.targetId &&
      row.enrollment_id === preserved.enrollmentId &&
      row.expected_revision === preserved.expectedRevision
  }

  private async validatePreservedLiveReplacement(v1Only: boolean): Promise<void> {
    const preserved = this.preservedLiveReplacement!
    const targetId = exactTargetId(preserved.targetId)
    if (!isUuid(preserved.enrollmentId) ||
        !Number.isSafeInteger(preserved.expectedRevision) ||
        preserved.expectedRevision < 1 || preserved.expectedRevision >= MAX_SAFE_REVISION ||
        this.isTargetIdentity(preserved.enrollmentId)) {
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    }
    preserved.owner.assertDatabaseUnchanged()
    const pending = this.database.prepare(
      `SELECT 1 FROM remote_credential_enrollments
       WHERE enrollment_id = ? AND remote_target_id = ? AND expected_revision = ?`
    ).get(preserved.enrollmentId, targetId, preserved.expectedRevision)
    const target = this.database.prepare(
      'SELECT revision FROM remote_targets WHERE remote_target_id = ?'
    ).get(targetId) as { revision: number } | undefined
    const deleting = this.database.prepare(
      'SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?'
    ).get(targetId)
    const v1Pending = this.database.prepare(
      `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
       AND idempotency_key = ? AND request_hash = ? AND result_json = '{"status":"pending"}'`
    ).get(ONLINE_V1_REPLACEMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      preserved.enrollmentId, targetId)
    const stored = this.database.prepare(
      `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
       AND idempotency_key = ? AND request_hash = ? AND result_json = '{"status":"stored"}'`
    ).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      preserved.enrollmentId, targetId)
    const v1Baseline = this.isV1Eligible(targetId)
    const v2Origin = this.database.prepare(
      `SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?
       AND origin = 'v2_committed' AND committed_revision BETWEEN 1 AND ?`
    ).get(targetId, preserved.expectedRevision)
    if (!pending || target?.revision !== preserved.expectedRevision || deleting || !stored ||
        (v1Baseline ? !v1Pending || !this.keyring.hasV1 ||
          !(await this.keyring.hasV1(targetId)) :
          v1Only || !!v1Pending || !v2Origin || !this.keyring.has ||
          !(await this.keyring.has(preserved.enrollmentId))) ||
        !this.keyring.has || !(await this.keyring.has(targetId))) {
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    }
  }

  public async recoverReplacementCleanup(): Promise<number> {
    this.requireOpen()
    const rows = this.database.prepare(
      `SELECT idempotency_key,request_hash FROM idempotency_results
       WHERE namespace = ? AND epoch = ? ORDER BY sequence LIMIT 129`
    ).all(ONLINE_REPLACEMENT_CLEANUP_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH) as
      { idempotency_key: string; request_hash: string }[]
    if (rows.length > 128) throw new RemoteCredentialEnrollmentError('storage_unavailable')
    for (const row of rows) {
      const targetId = exactTargetId(row.request_hash)
      if (!isUuid(row.idempotency_key))
        throw new RemoteCredentialEnrollmentError('storage_unavailable')
      await this.targetLock.withTarget(targetId, () =>
        this.finishReplacementBackup(row.idempotency_key, targetId)
      )
    }
    return rows.length
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private reserve(enrollmentId: string, targetId: string, expectedRevision: number, v1Baseline = false): void {
    const at = this.now()
    if (!Number.isSafeInteger(at) || at < 0) throw new RemoteCredentialEnrollmentError('storage_unavailable')
    try {
      this.database.transaction(() => {
        const target = this.database.prepare(
          'SELECT revision FROM remote_targets WHERE remote_target_id = ?'
        ).get(targetId) as { revision: number } | undefined
        const deleting = this.database.prepare(
          'SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?'
        ).get(targetId)
        const backupCleanup = this.database.prepare(
          `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
           AND request_hash = ? LIMIT 1`
        ).get(ONLINE_REPLACEMENT_CLEANUP_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH, targetId)
        const replacementAlias = this.database.prepare(
          `SELECT 1 FROM remote_credential_enrollments
           WHERE enrollment_id = ? AND remote_target_id <> ? LIMIT 1`
        ).get(targetId, targetId)
        const cleanupAlias = this.database.prepare(
          `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
           AND idempotency_key = ? LIMIT 1`
        ).get(ONLINE_REPLACEMENT_CLEANUP_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH, targetId)
        if (deleting || backupCleanup || replacementAlias || cleanupAlias ||
            (expectedRevision === 0 ? target !== undefined : target?.revision !== expectedRevision)) {
          throw new RemoteCredentialEnrollmentError('stale_revision')
        }
        if (v1Baseline && !this.isV1Eligible(targetId))
          throw new RemoteCredentialEnrollmentError('stale_revision')
        const inserted = this.database.prepare(
          `INSERT OR IGNORE INTO remote_credential_enrollments
           (enrollment_id,remote_target_id,expected_revision,created_at_ms) VALUES (?,?,?,?)`
        ).run(enrollmentId, targetId, expectedRevision, at).changes
        if (inserted !== 1) throw new RemoteCredentialEnrollmentError('enrollment_conflict')
        if (v1Baseline) this.database.prepare(
          `INSERT INTO idempotency_results
           (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
           VALUES (?,?,?,?,?,?)`
        ).run(ONLINE_V1_REPLACEMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
          enrollmentId, targetId, '{"status":"pending"}', at)
        if (this.liveMode && expectedRevision === 0) this.database.prepare(
          `INSERT INTO idempotency_results
           (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
           VALUES (?,?,?,?,?,?)`
        ).run(LIVE_NEW_ENROLLMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
          enrollmentId, targetId, '{"status":"pending"}', at)
      }).immediate()
    } catch (error) {
      if (error instanceof RemoteCredentialEnrollmentError) throw error
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    }
  }

  private commitExact(
    enrollmentId: string, targetId: string, expectedRevision: number, onlineReplacement = false
  ): void {
    try {
      this.database.transaction(() => {
        const pending = this.database.prepare(
          `SELECT expected_revision,created_at_ms FROM remote_credential_enrollments
           WHERE enrollment_id = ? AND remote_target_id = ?`
        ).get(enrollmentId, targetId) as { expected_revision: number; created_at_ms: number } | undefined
        const target = this.database.prepare(
          'SELECT revision FROM remote_targets WHERE remote_target_id = ?'
        ).get(targetId) as { revision: number } | undefined
        const deleting = this.database.prepare(
          'SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ?'
        ).get(targetId)
        if (!pending || pending.expected_revision !== expectedRevision || deleting ||
            target?.revision !== (expectedRevision === 0 ? 1 : expectedRevision)) {
          throw new RemoteCredentialEnrollmentError('stale_revision')
        }
        if (onlineReplacement) {
          const completed = this.database.prepare(
            `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
             AND idempotency_key = ? AND request_hash = ? AND result_json = '{"status":"stored"}'`
          ).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
            enrollmentId, targetId)
          if (!completed) throw new RemoteCredentialEnrollmentError('stale_revision')
          if (this.isV1Pending(enrollmentId, targetId) && !this.isV1Eligible(targetId))
            throw new RemoteCredentialEnrollmentError('stale_revision')
        }
        if (expectedRevision > 0) {
          const exhausted = this.database.prepare(
            `SELECT 1 FROM remote_sessions WHERE remote_target_id = ?
             AND (revision >= ? OR attempt_generation >= ?) LIMIT 1`
          ).get(targetId, MAX_SAFE_REVISION, MAX_SAFE_REVISION)
          if (target.revision >= MAX_SAFE_REVISION || exhausted)
            throw new RemoteCredentialEnrollmentError('stale_revision')
          this.database.prepare(
            `UPDATE remote_targets SET revision = revision + 1, updated_at_ms = ?
             WHERE remote_target_id = ? AND revision = ?`
          ).run(pending.created_at_ms, targetId, expectedRevision)
          this.database.prepare(
            `UPDATE remote_sessions SET state = CASE WHEN state = 'closed' THEN 'closed' ELSE 'failed' END,
             observation = CASE WHEN state = 'closed' THEN observation ELSE 'lost' END,
             attempt_generation = attempt_generation + 1, revision = revision + 1,
             updated_at_ms = ? WHERE remote_target_id = ?`
          ).run(pending.created_at_ms, targetId)
        }
        this.database.prepare(
          'DELETE FROM remote_credential_enrollments WHERE enrollment_id = ? AND remote_target_id = ?'
        ).run(enrollmentId, targetId)
        if (onlineReplacement) {
          if (this.isV1Pending(enrollmentId, targetId)) {
            const marked = this.database.prepare(
              `UPDATE node_live_credential_origins SET origin = 'v2_committed', committed_revision = ?
               WHERE remote_target_id = ? AND origin = 'v1_eligible' AND committed_revision IS NULL`
            ).run(expectedRevision + 1, targetId)
            if (marked.changes !== 1) throw new RemoteCredentialEnrollmentError('stale_revision')
            this.database.prepare(
              `DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ?
               AND idempotency_key = ? AND request_hash = ?`
            ).run(ONLINE_V1_REPLACEMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
              enrollmentId, targetId)
          } else {
            if (this.hasLiveOriginTable()) {
              const marked = this.database.prepare(
                `UPDATE node_live_credential_origins SET committed_revision = ?
                 WHERE remote_target_id = ? AND origin = 'v2_committed'
                   AND committed_revision <= ?`
              ).run(expectedRevision + 1, targetId, expectedRevision)
              if (marked.changes !== 1) throw new RemoteCredentialEnrollmentError('stale_revision')
            }
            this.database.prepare(
              `INSERT INTO idempotency_results
               (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
               VALUES (?,?,?,?,?,?)`
            ).run(ONLINE_REPLACEMENT_CLEANUP_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
              enrollmentId, targetId, '{"status":"pending"}', pending.created_at_ms)
          }
          this.database.prepare(
            `DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ?
             AND idempotency_key = ? AND request_hash = ?`
          ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
            enrollmentId, targetId)
        }
      }).immediate()
    } catch (error) {
      if (error instanceof RemoteCredentialEnrollmentError) throw error
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    }
  }

  private async restorePendingReplacement(enrollmentId: string, targetId: string): Promise<void> {
    if (this.isV1Pending(enrollmentId, targetId)) {
      if (this.isTargetIdentity(enrollmentId))
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      try {
        this.database.exec('BEGIN IMMEDIATE')
        const pending = this.database.prepare(
          `SELECT expected_revision FROM remote_credential_enrollments
           WHERE enrollment_id = ? AND remote_target_id = ?`
        ).get(enrollmentId, targetId) as { expected_revision: number } | undefined
        if (!pending || pending.expected_revision < 1 || !this.isV1Eligible(targetId))
          throw new RemoteCredentialEnrollmentError('cleanup_required')
        await this.keyring.delete(targetId)
        this.database.prepare(
          'DELETE FROM remote_credential_enrollments WHERE enrollment_id = ? AND remote_target_id = ?'
        ).run(enrollmentId, targetId)
        for (const namespace of [ONLINE_V1_REPLACEMENT_NAMESPACE, ONLINE_REPLACEMENT_MARKER_NAMESPACE]) {
          this.database.prepare(
            `DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ?
             AND idempotency_key = ? AND request_hash = ?`
          ).run(namespace, ONLINE_ENROLLMENT_MARKER_EPOCH, enrollmentId, targetId)
        }
        this.database.exec('COMMIT')
        return
      } catch {
        try { this.database.exec('ROLLBACK') } catch { /* Startup remains unavailable. */ }
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      }
    }
    if (!this.keyring.restoreReplacement || !this.keyring.has)
      throw new RemoteCredentialEnrollmentError('cleanup_required')
    let transactionOpen = false
    let cleanupNeeded: boolean
    try {
      this.database.exec('BEGIN IMMEDIATE')
      transactionOpen = true
      if (this.isTargetIdentity(enrollmentId))
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      const pending = this.database.prepare(
        `SELECT expected_revision FROM remote_credential_enrollments
         WHERE enrollment_id = ? AND remote_target_id = ?`
      ).get(enrollmentId, targetId) as { expected_revision: number } | undefined
      if (!pending || pending.expected_revision < 1)
        throw new RemoteCredentialEnrollmentError('stale_revision')
      const marker = this.database.prepare(
        `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
         AND idempotency_key = ? AND request_hash = ?`
      ).get(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
        enrollmentId, targetId)
      const restored = await this.keyring.restoreReplacement(targetId, enrollmentId)
      if (!restored && (marker || !(await this.keyring.has(targetId))))
        throw new RemoteCredentialEnrollmentError('cleanup_required')
      cleanupNeeded = restored
      if (cleanupNeeded) {
        this.database.prepare(
          `INSERT INTO idempotency_results
           (namespace,epoch,idempotency_key,request_hash,result_json,completed_at_ms)
           VALUES (?,?,?,?,?,?)`
        ).run(ONLINE_REPLACEMENT_CLEANUP_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
          enrollmentId, targetId, '{"status":"pending"}', this.now())
      }
      this.database.prepare(
        'DELETE FROM remote_credential_enrollments WHERE enrollment_id = ? AND remote_target_id = ?'
      ).run(enrollmentId, targetId)
      this.database.prepare(
        `DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ?
         AND idempotency_key = ? AND request_hash = ?`
      ).run(ONLINE_REPLACEMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
        enrollmentId, targetId)
      this.database.exec('COMMIT')
      transactionOpen = false
    } catch {
      throw new RemoteCredentialEnrollmentError('cleanup_required')
    } finally {
      if (transactionOpen) {
        try { this.database.exec('ROLLBACK') } catch { /* Startup remains unavailable. */ }
      }
    }
    if (cleanupNeeded) await this.finishReplacementBackup(enrollmentId, targetId)
  }

  private async finishReplacementBackup(enrollmentId: string, targetId: string): Promise<void> {
    if (this.isTargetIdentity(enrollmentId))
      throw new RemoteCredentialEnrollmentError('cleanup_required')
    await this.keyring.delete(enrollmentId).catch(() => {
      throw new RemoteCredentialEnrollmentError('cleanup_required')
    })
    try {
      this.database.prepare(
        `DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ?
         AND idempotency_key = ? AND request_hash = ?`
      ).run(ONLINE_REPLACEMENT_CLEANUP_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
        enrollmentId, targetId)
    } catch {
      throw new RemoteCredentialEnrollmentError('cleanup_required')
    }
  }

  private async compensate(enrollmentId: string, targetId: string): Promise<void> {
    try {
      await this.keyring.delete(targetId)
      this.deletePending(enrollmentId, targetId)
    } catch {
      throw new RemoteCredentialEnrollmentError('cleanup_required')
    }
  }

  private pendingIs(enrollmentId: string, targetId: string): boolean {
    return Boolean(this.database.prepare(
      'SELECT 1 FROM remote_credential_enrollments WHERE enrollment_id = ? AND remote_target_id = ?'
    ).get(enrollmentId, targetId))
  }

  private isV1Eligible(targetId: string): boolean {
    if (!this.hasLiveOriginTable()) return false
    return Boolean(this.database.prepare(
      `SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?
       AND origin = 'v1_eligible' AND committed_revision IS NULL`
    ).get(targetId))
  }

  private hasLiveOriginTable(): boolean {
    return Boolean(this.database.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_live_credential_origins'`
    ).get())
  }

  private isV2Committed(targetId: string, expectedRevision: number): boolean {
    return Boolean(this.database.prepare(
      `SELECT 1 FROM node_live_credential_origins WHERE remote_target_id = ?
       AND origin = 'v2_committed' AND committed_revision BETWEEN 1 AND ?`
    ).get(targetId, expectedRevision))
  }

  private isV1Pending(enrollmentId: string, targetId: string): boolean {
    return Boolean(this.database.prepare(
      `SELECT 1 FROM idempotency_results WHERE namespace = ? AND epoch = ?
       AND idempotency_key = ? AND request_hash = ?`
    ).get(ONLINE_V1_REPLACEMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH,
      enrollmentId, targetId))
  }

  private isTargetIdentity(enrollmentId: string): boolean {
    return Boolean(this.database.prepare(
      `SELECT 1 FROM remote_targets WHERE remote_target_id = ?
       UNION ALL SELECT 1 FROM remote_target_deletions WHERE remote_target_id = ? LIMIT 1`
    ).get(enrollmentId, enrollmentId))
  }

  private deletePending(enrollmentId: string, targetId: string): void {
    this.database.transaction(() => {
      this.database.prepare(
        'DELETE FROM remote_credential_enrollments WHERE enrollment_id = ? AND remote_target_id = ?'
      ).run(enrollmentId, targetId)
      this.database.prepare(
        'DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?'
      ).run(ONLINE_ENROLLMENT_MARKER_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH, enrollmentId, targetId)
      this.database.prepare(
        'DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?'
      ).run(LIVE_NEW_ENROLLMENT_NAMESPACE, ONLINE_ENROLLMENT_MARKER_EPOCH, enrollmentId, targetId)
      for (const namespace of [ONLINE_V1_REPLACEMENT_NAMESPACE, ONLINE_REPLACEMENT_MARKER_NAMESPACE]) {
        this.database.prepare(
          'DELETE FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ? AND request_hash = ?'
        ).run(namespace, ONLINE_ENROLLMENT_MARKER_EPOCH, enrollmentId, targetId)
      }
    }).immediate()
  }

  private requireOpen(): void {
    if (this.closed) throw new RemoteCredentialEnrollmentError('storage_unavailable')
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

function exactTargetId(targetId: string): string {
  const reference = CredentialReference.forTarget(targetId)
  if (reference.targetId !== targetId) throw new RemoteCredentialEnrollmentError('invalid_target')
  return targetId
}

async function validateWorkingDatabase(path: string): Promise<void> {
  if (process.platform !== 'linux' || !process.getuid || !isAbsolute(path) || resolve(path) !== path) {
    throw new RemoteCredentialEnrollmentError('storage_unavailable')
  }
  try {
    const [file, parent] = await Promise.all([lstat(path), lstat(dirname(path))])
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() ||
        file.nlink !== 1 || (file.mode & 0o077) !== 0 ||
        !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() ||
        (parent.mode & 0o077) !== 0 || (await realpath(path)) !== path ||
        (await realpath(dirname(path))) !== dirname(path)) {
      throw new RemoteCredentialEnrollmentError('storage_unavailable')
    }
  } catch {
    throw new RemoteCredentialEnrollmentError('storage_unavailable')
  }
}
