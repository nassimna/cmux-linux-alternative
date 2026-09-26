import { constants } from 'node:fs'
import { cp, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

import electronExecutable from 'electron'

export async function createPackagedElectronHarness(profileDirectory) {
  const sourceDistribution =
    process.platform === 'darwin'
      ? resolve(dirname(electronExecutable), '../..')
      : dirname(electronExecutable)
  const harnessDistribution = join(profileDirectory, basename(sourceDistribution))

  await cp(sourceDistribution, harnessDistribution, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE
  })

  const executablePath =
    process.platform === 'darwin'
      ? join(harnessDistribution, 'Contents', 'MacOS', basename(electronExecutable))
      : join(harnessDistribution, basename(electronExecutable))
  const resourcesDirectory =
    process.platform === 'darwin'
      ? join(harnessDistribution, 'Contents', 'Resources')
      : join(harnessDistribution, 'resources')
  const nodeRuntimeSource = resolve(dirname(import.meta.dirname), '../../../target/node-linux')
  const nodeRuntimeDirectory = join(resourcesDirectory, 'node-linux')
  const runtimeDirectory = join(profileDirectory, 'runtime')

  if (!(await stat(join(nodeRuntimeSource, 'manifest.json')).catch(() => null))) {
    throw new Error('The Linux Node runtime is not staged. Run pnpm stage:node:linux first.')
  }
  await cp(nodeRuntimeSource, nodeRuntimeDirectory, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE
  })
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })

  return {
    electronEnvironment: Object.freeze({ ELECTRON_FORCE_IS_PACKAGED: '1' }),
    executablePath,
    runtimeDirectory,
    serverPath: join(nodeRuntimeDirectory, 'server', 'dist', 'bin.mjs')
  }
}
