import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { verifyIsolatedCopy, verifySourceBoundCopy } from './isolated-copy-ownership'
import { observeSource, type SourceObservation } from './source-observation'

type ArtifactStatus = 'absent' | 'present' | 'unsafe'

export interface CutoverPreflightReport {
  readyForCutover: false
  source: SourceObservation | null
  copyVerified: boolean
  sourceBound: boolean
  externalState: Record<string, ArtifactStatus>
  blockers: string[]
}

function problem(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

async function regularArtifact(path: string): Promise<ArtifactStatus> {
  try {
    const file = await lstat(path)
    return file.isFile() &&
      !file.isSymbolicLink() &&
      file.nlink === 1 &&
      file.uid === process.getuid?.() &&
      (file.mode & 0o077) === 0
      ? 'present'
      : 'unsafe'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unsafe'
  }
}

async function directoryArtifact(path: string): Promise<ArtifactStatus> {
  try {
    const file = await lstat(path)
    return file.isDirectory() &&
      !file.isSymbolicLink() &&
      file.uid === process.getuid?.() &&
      (file.mode & 0o077) === 0
      ? 'present'
      : 'unsafe'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unsafe'
  }
}

async function nestedRegularArtifact(root: string, directories: string[], name: string) {
  let current = root
  for (const part of directories) {
    current = join(current, part)
    const status = await directoryArtifact(current)
    if (status !== 'present') return status
  }
  return regularArtifact(join(current, name))
}

/** An observation only: no service lock or ownership transfer is attempted. */
export async function inspectCutoverPreflight(input: {
  source: string
  backup: string
  working: string
}): Promise<CutoverPreflightReport> {
  const blockers: string[] = []
  const externalState: Record<string, ArtifactStatus> = {}
  const report: CutoverPreflightReport = {
    readyForCutover: false,
    source: null,
    copyVerified: false,
    sourceBound: false,
    externalState,
    blockers
  }
  if (
    process.platform !== 'linux' ||
    !process.getuid ||
    [input.source, input.backup, input.working].some(
      (path) => !isAbsolute(path) || resolve(path) !== path
    )
  ) {
    blockers.push('canonical_linux_paths_required')
    return report
  }

  try {
    report.source = await observeSource(input.source)
    if (report.source.database.snapshotRevision === null) blockers.push('source_snapshot_missing')
    if (report.source.database.legacySnapshotCompatibility)
      blockers.push('legacy_snapshot_needs_normalization')
  } catch (error) {
    blockers.push(`source_observation_failed: ${problem(error)}`)
  }

  try {
    await verifyIsolatedCopy(input.source, input.backup, input.working)
    report.copyVerified = true
  } catch (error) {
    blockers.push(`copy_verification_failed: ${problem(error)}`)
  }
  if (report.copyVerified && report.source) {
    try {
      await verifySourceBoundCopy(input.source, input.backup, input.working, report.source)
      report.sourceBound = true
    } catch (error) {
      blockers.push(`source_binding_failed: ${problem(error)}`)
    }
  }

  const profile = dirname(input.source)
  externalState.rustDesktopConfig = await nestedRegularArtifact(
    dirname(profile),
    ['configuration'],
    'desktop.json'
  )
  externalState.nodeConfig = await regularArtifact(join(profile, 'config.json'))
  externalState.knownHosts = await directoryArtifact(join(profile, 'remote-known-hosts'))
  externalState.searchIndex = await nestedRegularArtifact(
    profile,
    ['index', 'v1'],
    'search.sqlite3'
  )
  externalState.searchKeyLocator = await regularArtifact(join(profile, 'content-index-key-id'))
  for (const [name, status] of Object.entries(externalState)) {
    if (status !== 'absent') blockers.push(`external_${name}_${status}`)
  }
  blockers.push(
    'rust_live_owner_shutdown_and_exclusive_transfer_unverified',
    'secret_service_items_not_inventoried',
    'external_agent_profiles_and_sessions_not_inventoried'
  )
  return report
}
