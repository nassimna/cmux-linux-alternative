import { copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import Database from 'better-sqlite3'

import { AgentRegistrationService } from '../agents/agent-registration-service'
import { loadExistingIndexKey } from '../content/encrypted-index-key'
import {
  preflightLiveSettings,
  type LiveRuntimeSettings
} from '../configuration/live-settings-preflight'
import { readKnownHostExact } from '../remote/known-hosts-store'
import { CredentialReference } from '../remote/credential-provider'
import {
  probeExactCredentialPresence,
  type ExactCredentialPresence
} from '../remote/credential-secret-service'
import { IsolatedCredentialScope } from '../remote/credential-scope'
import { LegacyStateReader } from './legacy-state-reader'
import { logicalDatabaseDigest } from './logical-database-digest'
import { observeSource, sameSourceObservation } from './source-observation'

/** A missing entry is a cutover blocker, including entries outside this preflight's scope. */
export const LIVE_FEATURES = [
  'settings',
  'encryptedSearch',
  'remoteSessions',
  'remoteCredentials',
  'codexSessions',
  'browserAutomation',
  'desktopIntegration'
] as const
export type LiveFeature = (typeof LIVE_FEATURES)[number]
export type LiveFeaturePolicy = Partial<Record<LiveFeature, 'required' | 'omitted' | 'unsupported'>>

export interface LiveCutoverPreflightInput {
  databasePath: string
  rustDesktopPath: string
  features: LiveFeaturePolicy
  owner: { assertDatabasePath(path: string): void }
  /** Defaults to the existing, read-only connected default Codex probe. */
  probeCodex?: () => Promise<boolean>
  /** Defaults to the existing-only Secret Service lookup; the key is immediately zeroed. */
  probeIndexKey?: (profile: string) => Promise<boolean>
  /** Exact SearchItems-only probe. Tests may substitute a provider-free inventory. */
  probeRemoteCredential?: (reference: CredentialReference) => Promise<ExactCredentialPresence>
}

export interface LiveCutoverPreflightReport {
  readyForExternalDependencies: boolean
  snapshotRevision: number | null
  runtimeSettings: LiveRuntimeSettings | null
  trustedRemoteCount: number
  blockers: string[]
}

const code = (error: unknown): string =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unavailable'

async function privateArtifact(path: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    const file = await lstat(path)
    return (
      (kind === 'file' ? file.isFile() && file.nlink === 1 : file.isDirectory()) &&
      !file.isSymbolicLink() &&
      file.uid === process.getuid?.() &&
      (file.mode & 0o077) === 0 &&
      (await realpath(path)) === path
    )
  } catch {
    return false
  }
}

/**
 * Run under LiveOwnerLock before ApplicationStateStore.openOwnedDatabase. This
 * reads existing artifacts only; a successful report is not a cutover approval.
 */
export async function preflightLiveCutover(
  input: LiveCutoverPreflightInput
): Promise<LiveCutoverPreflightReport> {
  const blockers: string[] = []
  const report: LiveCutoverPreflightReport = {
    readyForExternalDependencies: false,
    snapshotRevision: null,
    runtimeSettings: null,
    trustedRemoteCount: 0,
    blockers
  }
  if (
    process.platform !== 'linux' ||
    !process.getuid ||
    !isAbsolute(input.databasePath) ||
    resolve(input.databasePath) !== input.databasePath ||
    !isAbsolute(input.rustDesktopPath) ||
    resolve(input.rustDesktopPath) !== input.rustDesktopPath
  ) {
    blockers.push('canonical_linux_paths_required')
    return report
  }
  input.owner.assertDatabasePath(input.databasePath)
  for (const feature of LIVE_FEATURES) {
    if (input.features[feature] !== 'required')
      blockers.push(`required_feature_${feature}_${input.features[feature] ?? 'missing'}`)
  }
  if (
    Object.keys(input.features).some((feature) => !LIVE_FEATURES.includes(feature as LiveFeature))
  ) {
    blockers.push('unknown_feature_policy')
  }

  const profile = dirname(input.databasePath)
  if (
    !(await privateArtifact(profile, 'directory')) ||
    !(await privateArtifact(input.databasePath, 'file'))
  ) {
    blockers.push('unsafe_live_database_path')
    return report
  }
  // SQLite can create or update shared-memory files even for read-only WAL
  // connections. Read a private temporary copy, never the live connection.
  try {
    await lstat(`${input.databasePath}-shm`)
    if (!(await privateArtifact(`${input.databasePath}-shm`, 'file'))) {
      blockers.push('unsafe_live_sqlite_shm')
      return report
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      blockers.push('live_sqlite_shm_unavailable')
      return report
    }
  }
  let source: Awaited<ReturnType<typeof observeSource>>
  try {
    source = await observeSource(input.databasePath)
  } catch (error) {
    blockers.push(`live_source_${code(error)}`)
    return report
  }
  const temporary = await mkdtemp(join(tmpdir(), 'agent-workspace-live-external-preflight-'))
  const snapshotPath = join(temporary, 'source.sqlite3')
  try {
    await copyFile(input.databasePath, snapshotPath)
    if (source.walSha256 !== null) {
      await copyFile(`${input.databasePath}-wal`, `${snapshotPath}-wal`)
    }
    const copied = await observeSource(input.databasePath)
    if (
      !sameSourceObservation(source, copied) ||
      logicalDatabaseDigest(snapshotPath) !== source.logicalSha256
    ) {
      blockers.push('live_source_changed_during_copy')
      await rm(temporary, { recursive: true, force: true })
      return report
    }
    const reader = new LegacyStateReader(snapshotPath)
    try {
      const snapshot = reader.readSnapshot()
      report.snapshotRevision = snapshot.revision
      report.runtimeSettings = {
        notificationSettings: snapshot.notificationSettings,
        shortcutOverrides: snapshot.shortcutOverrides
      }
    } finally {
      reader.close()
    }
  } catch (error) {
    blockers.push(`normalized_snapshot_${code(error)}`)
    await rm(temporary, { recursive: true, force: true })
    return report
  }
  try {
    input.owner.assertDatabasePath(input.databasePath)

    try {
      const settings = await preflightLiveSettings(
        input.rustDesktopPath,
        join(profile, 'config.json'),
        report.runtimeSettings!
      )
      for (const blocker of settings.blockers) {
        if (!(blocker === 'node_config_missing' && settings.rustDesktop.status === 'present'))
          blockers.push(`settings_${blocker}`)
      }
    } catch (error) {
      blockers.push(`settings_${code(error)}`)
    }

    if (
      (await privateArtifact(join(profile, 'index'), 'directory')) &&
      (await privateArtifact(join(profile, 'index', 'v1'), 'directory')) &&
      (await privateArtifact(join(profile, 'index', 'v1', 'search.sqlite3'), 'file')) &&
      (await privateArtifact(join(profile, 'content-index-key-id'), 'file'))
    ) {
      try {
        const available = input.probeIndexKey
          ? await input.probeIndexKey(profile)
          : await (async () => {
              const key = await loadExistingIndexKey(profile)
              key.fill(0)
              return true
            })()
        if (!available) blockers.push('index_key_unavailable')
      } catch (error) {
        blockers.push(`index_key_${code(error)}`)
      }
    } else {
      blockers.push('encrypted_index_or_locator_missing')
    }

    try {
      const database = new Database(snapshotPath, { readonly: true, fileMustExist: true })
      try {
        database.pragma('query_only = ON')
        const targets = database
          .prepare('SELECT remote_target_id, host, port, host_key_state FROM remote_targets')
          .all() as Array<{
          remote_target_id: string
          host: string
          port: number
          host_key_state: string
        }>
        const hasOrigins = !!database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_live_credential_origins'"
          )
          .get()
        const readOrigin = hasOrigins
          ? database.prepare(
              'SELECT origin FROM node_live_credential_origins WHERE remote_target_id = ?'
            )
          : undefined
        // A fenced deletion may already have removed either external artifact.
        // Startup must let the owner recover that exact durable intent first.
        const pendingDeletions = new Set((database
          .prepare('SELECT remote_target_id FROM remote_target_deletions')
          .all() as Array<{ remote_target_id: string }>).map((row) => row.remote_target_id))
        let isolatedScope: IsolatedCredentialScope | undefined
        if (targets.length > 128) blockers.push('remote_target_limit_exceeded')
        for (const target of targets) {
          const id = target.remote_target_id
          if (pendingDeletions.has(id)) continue
          if (target.host_key_state === 'trusted') {
            report.trustedRemoteCount++
            try {
              await readKnownHostExact(
                join(profile, 'remote-known-hosts', `${id}.known_hosts`),
                target.host,
                target.port
              )
            } catch {
              blockers.push(`trusted_remote_host_key_unavailable:${id}`)
            }
          }
          const origin = (readOrigin?.get(id) as { origin: unknown } | undefined)?.origin
          let reference: CredentialReference
          try {
            if (origin === undefined || origin === 'v1_eligible') {
              reference = CredentialReference.forTarget(id)
            } else if (origin === 'v2_committed') {
              isolatedScope ??= IsolatedCredentialScope.load(input.databasePath)
              reference = CredentialReference.forIsolatedTarget(id, isolatedScope.id)
            } else {
              blockers.push(`remote_credential_origin_invalid:${id}`)
              continue
            }
          } catch {
            blockers.push(`remote_credential_reference_unavailable:${id}`)
            continue
          }
          try {
            input.owner.assertDatabasePath(input.databasePath)
            const presence = await (input.probeRemoteCredential ?? probeExactCredentialPresence)(
              reference
            )
            if (presence === 'missing' || presence === 'locked' || presence === 'duplicate') {
              blockers.push(`remote_credential_${presence}:${id}`)
            } else if (presence !== 'present') {
              blockers.push(`remote_credential_unavailable:${id}`)
            }
          } catch (error) {
            blockers.push(`remote_credential_${code(error)}:${id}`)
          }
        }
      } finally {
        database.close()
      }
    } catch (error) {
      blockers.push(`remote_catalog_${code(error)}`)
    }

    try {
      const connected = input.probeCodex
        ? await input.probeCodex()
        : !!(await AgentRegistrationService.probeConnectedLiveProvider())
      if (!connected) blockers.push('default_codex_profile_unavailable')
    } catch {
      blockers.push('default_codex_profile_unavailable')
    }

    // These require owner-bound runtime and desktop proof, not inference from
    // the presence of a normalized snapshot or a feature-policy declaration.
    blockers.push(
      'agent_session_migration_unverified',
      'browser_automation_parity_unverified',
      'desktop_integration_unverified'
    )
    input.owner.assertDatabasePath(input.databasePath)
    try {
      if (!sameSourceObservation(source, await observeSource(input.databasePath))) {
        blockers.push('live_source_changed_during_preflight')
      }
    } catch {
      blockers.push('live_source_changed_during_preflight')
    }
    report.readyForExternalDependencies = blockers.length === 0
    return report
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
