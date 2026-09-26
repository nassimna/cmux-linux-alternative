import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ApplicationStateStore } from '../persistence/application-state-store'
import { stageNativeProfileSettings } from './native-profile-settings'

describe('native profile settings migration', () => {
  it('copies qualified legacy settings exactly once and leaves the source untouched', async () => {
    const root = mkdtempSync(join(process.cwd(), '../../target/native-profile-settings-'))
    const stateDirectory = join(root, 'state')
    const configurationDirectory = join(root, 'configuration')
    mkdirSync(stateDirectory, { mode: 0o700 })
    mkdirSync(configurationDirectory, { mode: 0o700 })
    const databasePath = join(stateDirectory, 'workspace.sqlite')
    const sourcePath = join(configurationDirectory, 'desktop.json')
    const targetPath = join(stateDirectory, 'config.json')
    const bytes = Buffer.from('{"schemaVersion":1,"revision":4,"appearance":{"theme":"dark"}}\n')
    writeFileSync(sourcePath, bytes, { mode: 0o600 })
    let state: ApplicationStateStore | undefined
    try {
      state = await ApplicationStateStore.openNative(
        databasePath,
        join(stateDirectory, 'pre-node-migration.sqlite'),
        root
      )
      await stageNativeProfileSettings(databasePath, state)
      expect(readFileSync(targetPath)).toEqual(bytes)
      expect(readFileSync(sourcePath)).toEqual(bytes)
      await stageNativeProfileSettings(databasePath, state)
      expect(readFileSync(targetPath)).toEqual(bytes)
    } finally {
      state?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses legacy settings that disagree with durable runtime settings', async () => {
    const root = mkdtempSync(join(process.cwd(), '../../target/native-profile-settings-'))
    const stateDirectory = join(root, 'state')
    const configurationDirectory = join(root, 'configuration')
    mkdirSync(stateDirectory, { mode: 0o700 })
    mkdirSync(configurationDirectory, { mode: 0o700 })
    const databasePath = join(stateDirectory, 'workspace.sqlite')
    writeFileSync(
      join(configurationDirectory, 'desktop.json'),
      '{"schemaVersion":1,"revision":4,"notifications":{"systemEnabled":false}}\n',
      { mode: 0o600 }
    )
    let state: ApplicationStateStore | undefined
    try {
      state = await ApplicationStateStore.openNative(
        databasePath,
        join(stateDirectory, 'pre-node-migration.sqlite'),
        root
      )
      await expect(stageNativeProfileSettings(databasePath, state)).rejects.toThrow(
        'runtime_settings_differ_from_rust'
      )
      expect(existsSync(join(stateDirectory, 'config.json'))).toBe(false)
    } finally {
      state?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
