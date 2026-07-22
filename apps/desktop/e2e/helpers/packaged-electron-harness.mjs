import { constants } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

import electronExecutable from 'electron'

export async function createPackagedElectronHarness(profileDirectory, serviceBinary) {
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
  const serviceDirectory = join(resourcesDirectory, 'bin')
  const runtimeDirectory = join(profileDirectory, 'runtime')

  await mkdir(serviceDirectory, { recursive: true })
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await cp(serviceBinary, join(serviceDirectory, basename(serviceBinary)), {
    mode: constants.COPYFILE_FICLONE
  })

  return {
    electronEnvironment: Object.freeze({ ELECTRON_FORCE_IS_PACKAGED: '1' }),
    executablePath,
    runtimeDirectory
  }
}
