import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import {
  ConfigurationQualificationError,
  qualifyConfigurationBytes
} from './configuration-qualification'

type Qualified = ReturnType<typeof qualifyConfigurationBytes>

type Artifact =
  | { status: 'absent' }
  | {
      status: 'present'
      sha256: string
      revision: number
      schemaVersion: number
      unknownFieldsPresent: boolean
    }

export type LiveRuntimeSettings = {
  notificationSettings: { systemEnabled: boolean; includeBody: boolean }
  shortcutOverrides: Record<string, string | null>
}

export type ReadArtifact = {
  report: Artifact
  identity?: { dev: number; ino: number }
  config?: Qualified['config']
  bytes?: Buffer
}

const MAX_CONFIG_BYTES = 1024 * 1024

function fail(code: 'unsafe_config' | 'config_unavailable'): never {
  throw new ConfigurationQualificationError(code)
}

/** Read a single explicit settings file without following links or changing its permissions. */
export async function readArtifact(path: string, expectedName: string): Promise<ReadArtifact> {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== expectedName)
    fail('unsafe_config')
  const parent = dirname(path)
  let resolved: string
  try {
    resolved = await realpath(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { report: { status: 'absent' } }
    fail('config_unavailable')
  }
  if (parent !== resolved) fail('unsafe_config')
  const parentStat = await lstat(parent)
  if (
    !parentStat.isDirectory() ||
    parentStat.uid !== process.getuid?.() ||
    (parentStat.mode & 0o077) !== 0
  )
    fail('unsafe_config')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { report: { status: 'absent' } }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('unsafe_config')
    fail('config_unavailable')
  }
  try {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1 ||
      before.size > MAX_CONFIG_BYTES
    )
      fail('unsafe_config')
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_CONFIG_BYTES) fail('config_unavailable')
    const bytes = buffer.subarray(0, length)
    const after = await handle.stat()
    const pathStat = await lstat(path)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino ||
      !pathStat.isFile() ||
      bytes.byteLength !== before.size
    )
      fail('config_unavailable')
    const qualified = qualifyConfigurationBytes(bytes)
    return {
      report: {
        status: 'present',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        revision: qualified.config.revision,
        schemaVersion: qualified.config.schemaVersion,
        unknownFieldsPresent: qualified.unknownFieldsPresent
      },
      identity: { dev: before.dev, ino: before.ino },
      config: qualified.config,
      bytes
    }
  } finally {
    await handle.close()
  }
}

function unchanged(first: ReadArtifact, second: ReadArtifact): boolean {
  return (
    JSON.stringify(first.report) === JSON.stringify(second.report) &&
    first.identity?.dev === second.identity?.dev &&
    first.identity?.ino === second.identity?.ino
  )
}

/** A point-in-time, read-only gate; callers still need an exclusive transfer fence. */
export async function preflightLiveSettings(
  rustDesktopPath: string,
  nodeConfigPath: string,
  runtime: LiveRuntimeSettings
): Promise<{
  rustDesktop: Artifact
  nodeConfig: Artifact
  byteIdentical: boolean
  runtimeSettingsMatch: boolean | null
  blockers: string[]
}> {
  if (rustDesktopPath === nodeConfigPath) fail('unsafe_config')
  const source = await readArtifact(rustDesktopPath, 'desktop.json')
  const target = await readArtifact(nodeConfigPath, 'config.json')
  const sourceAgain = await readArtifact(rustDesktopPath, 'desktop.json')
  const targetAgain = await readArtifact(nodeConfigPath, 'config.json')
  if (!unchanged(source, sourceAgain) || !unchanged(target, targetAgain)) fail('config_unavailable')
  if (
    source.identity &&
    target.identity &&
    source.identity.dev === target.identity.dev &&
    source.identity.ino === target.identity.ino
  )
    fail('unsafe_config')

  const byteIdentical =
    source.report.status === 'present' &&
    target.report.status === 'present' &&
    source.report.sha256 === target.report.sha256
  const config = source.config
  const runtimeSettingsMatch = config
    ? config.notifications.systemEnabled === runtime.notificationSettings.systemEnabled &&
      config.notifications.includeBody === runtime.notificationSettings.includeBody &&
      JSON.stringify(Object.entries(config.keyboardShortcuts.overrides).sort()) ===
        JSON.stringify(Object.entries(runtime.shortcutOverrides).sort())
    : null
  const blockers: string[] = []
  if (source.report.status === 'absent')
    blockers.push('rust_desktop_config_absent_requires_explicit_defaults_decision')
  else if (target.report.status === 'absent') blockers.push('node_config_missing')
  else if (!byteIdentical) blockers.push('node_config_differs_from_rust')
  if (source.report.status === 'absent' && target.report.status === 'present')
    blockers.push('node_config_has_no_rust_source')
  if (runtimeSettingsMatch === false) blockers.push('runtime_settings_differ_from_rust')
  return {
    rustDesktop: source.report,
    nodeConfig: target.report,
    byteIdentical,
    runtimeSettingsMatch,
    blockers
  }
}
