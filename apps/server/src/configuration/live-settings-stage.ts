import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ConfigurationQualificationError } from './configuration-qualification'
import {
  preflightLiveSettings,
  readArtifact,
  type LiveRuntimeSettings
} from './live-settings-preflight'

type LiveOwnerEvidence = { assertDatabaseUnchanged(): void }
type Preflight = Awaited<ReturnType<typeof preflightLiveSettings>>

function unavailable(): never {
  throw new ConfigurationQualificationError('config_unavailable')
}

function requireStageable(report: Preflight): void {
  if (
    report.rustDesktop.status !== 'present' ||
    report.nodeConfig.status !== 'absent' ||
    report.runtimeSettingsMatch !== true ||
    report.blockers.length !== 1 ||
    report.blockers[0] !== 'node_config_missing'
  ) {
    throw new Error(
      `Live settings are not stageable: ${report.blockers.join(', ') || 'target_exists'}`
    )
  }
}

/** Create the first Node settings file from the exact Rust bytes under the live writer fence. */
export async function stageLiveSettings(
  rustDesktopPath: string,
  nodeConfigPath: string,
  runtime: LiveRuntimeSettings,
  owner: LiveOwnerEvidence
): Promise<Preflight> {
  owner.assertDatabaseUnchanged()
  const before = await preflightLiveSettings(rustDesktopPath, nodeConfigPath, runtime)
  requireStageable(before)

  const source = await readArtifact(rustDesktopPath, 'desktop.json')
  if (
    before.rustDesktop.status !== 'present' ||
    source.report.status !== 'present' ||
    source.report.sha256 !== before.rustDesktop.sha256 ||
    !source.bytes
  )
    unavailable()

  const directoryPath = dirname(nodeConfigPath)
  const directory = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  )
  const temporary = join(directoryPath, `.config.json.${randomUUID()}.tmp`)
  try {
    const directoryStat = await directory.stat()
    const namedDirectory = await lstat(directoryPath)
    if (
      !directoryStat.isDirectory() ||
      directoryStat.dev !== namedDirectory.dev ||
      directoryStat.ino !== namedDirectory.ino ||
      directoryStat.uid !== process.getuid?.() ||
      (directoryStat.mode & 0o077) !== 0 ||
      (await realpath(directoryPath)) !== directoryPath
    ) {
      throw new ConfigurationQualificationError('unsafe_config')
    }

    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    let stagedIdentity: { dev: number; ino: number }
    try {
      await file.writeFile(source.bytes)
      await file.sync()
      const staged = await file.stat()
      if (
        !staged.isFile() ||
        staged.uid !== process.getuid?.() ||
        (staged.mode & 0o777) !== 0o600 ||
        staged.nlink !== 1 ||
        staged.size !== source.bytes.byteLength
      )
        throw new ConfigurationQualificationError('unsafe_config')
      stagedIdentity = { dev: staged.dev, ino: staged.ino }
    } finally {
      await file.close()
    }

    owner.assertDatabaseUnchanged()
    const current = await preflightLiveSettings(rustDesktopPath, nodeConfigPath, runtime)
    requireStageable(current)
    if (
      current.rustDesktop.status !== 'present' ||
      current.rustDesktop.sha256 !== source.report.sha256
    )
      unavailable()
    const currentSource = await readArtifact(rustDesktopPath, 'desktop.json')
    if (
      currentSource.identity?.dev !== source.identity?.dev ||
      currentSource.identity?.ino !== source.identity?.ino
    )
      unavailable()
    const namedBeforeCommit = await lstat(directoryPath)
    if (namedBeforeCommit.dev !== directoryStat.dev || namedBeforeCommit.ino !== directoryStat.ino)
      unavailable()
    const stagedBeforeCommit = await lstat(temporary)
    if (
      !stagedBeforeCommit.isFile() ||
      stagedBeforeCommit.dev !== stagedIdentity.dev ||
      stagedBeforeCommit.ino !== stagedIdentity.ino ||
      stagedBeforeCommit.nlink !== 1 ||
      stagedBeforeCommit.size !== source.bytes.byteLength
    )
      unavailable()
    owner.assertDatabaseUnchanged()
    // A hard link publishes the fully synced bytes and fails if config.json appeared.
    // Rename would replace an existing target after the last absence check.
    try {
      await link(temporary, nodeConfigPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') unavailable()
      throw error
    }
    await rm(temporary)
    await directory.sync()
    owner.assertDatabaseUnchanged()
    const after = await preflightLiveSettings(rustDesktopPath, nodeConfigPath, runtime)
    if (!after.byteIdentical || after.runtimeSettingsMatch !== true || after.blockers.length > 0)
      unavailable()
    // Detect a same-content replacement of the Rust file during publication.
    const finalSource = await readArtifact(rustDesktopPath, 'desktop.json')
    if (
      finalSource.identity?.dev !== source.identity?.dev ||
      finalSource.identity?.ino !== source.identity?.ino
    )
      unavailable()
    return after
  } finally {
    await rm(temporary, { force: true })
    await directory.close()
  }
}
