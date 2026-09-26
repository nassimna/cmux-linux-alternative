import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { stageLiveSettings } from './live-settings-stage'
import type { LiveRuntimeSettings } from './live-settings-preflight'

const directories: string[] = []
const runtime: LiveRuntimeSettings = {
  notificationSettings: { systemEnabled: true, includeBody: false },
  shortcutOverrides: {}
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'live-settings-stage-'))
  directories.push(root)
  const rustDirectory = join(root, 'configuration')
  const nodeDirectory = join(root, 'node')
  await mkdir(rustDirectory, { mode: 0o700 })
  await mkdir(nodeDirectory, { mode: 0o700 })
  await chmod(rustDirectory, 0o700)
  await chmod(nodeDirectory, 0o700)
  return {
    rustPath: join(rustDirectory, 'desktop.json'),
    nodePath: join(nodeDirectory, 'config.json'),
    nodeDirectory
  }
}

describe('live settings staging', () => {
  it('publishes the exact qualified Rust bytes once under owner evidence', async () => {
    const { rustPath, nodePath, nodeDirectory } = await fixture()
    const bytes = Buffer.from(
      '{"schemaVersion":2,"revision":7,"appearance":{"theme":"dark","future":"keep"}}\n'
    )
    await writeFile(rustPath, bytes, { mode: 0o600 })
    let assertions = 0
    const result = await stageLiveSettings(rustPath, nodePath, runtime, {
      assertDatabaseUnchanged: () => {
        assertions++
      }
    })
    expect(assertions).toBeGreaterThanOrEqual(3)
    expect(result).toMatchObject({
      byteIdentical: true,
      runtimeSettingsMatch: true,
      blockers: [],
      rustDesktop: { status: 'present', unknownFieldsPresent: true }
    })
    expect(await readFile(nodePath)).toEqual(bytes)
    expect(await readdir(nodeDirectory)).toEqual(['config.json'])
    await expect(
      stageLiveSettings(rustPath, nodePath, runtime, { assertDatabaseUnchanged() {} })
    ).rejects.toThrow('target_exists')
    expect(await readFile(nodePath)).toEqual(bytes)
  })

  it('refuses absent Rust settings and mismatched SQLite settings without creating a file', async () => {
    const { rustPath, nodePath, nodeDirectory } = await fixture()
    const owner = { assertDatabaseUnchanged() {} }
    await expect(stageLiveSettings(rustPath, nodePath, runtime, owner)).rejects.toThrow(
      'rust_desktop_config_absent_requires_explicit_defaults_decision'
    )
    await writeFile(rustPath, '{"schemaVersion":2,"notifications":{"systemEnabled":false}}', {
      mode: 0o600
    })
    await expect(stageLiveSettings(rustPath, nodePath, runtime, owner)).rejects.toThrow(
      'runtime_settings_differ_from_rust'
    )
    expect(await readdir(nodeDirectory)).toEqual([])
  })

  it('refuses unsafe targets and never replaces a target that appears during publication', async () => {
    const { rustPath, nodePath, nodeDirectory } = await fixture()
    await writeFile(rustPath, '{"schemaVersion":2}', { mode: 0o600 })
    await symlink(rustPath, nodePath)
    await expect(
      stageLiveSettings(rustPath, nodePath, runtime, { assertDatabaseUnchanged() {} })
    ).rejects.toMatchObject({ code: 'unsafe_config' })
    await rm(nodePath)

    const competingBytes = Buffer.from('{"schemaVersion":2,"revision":99}')
    let assertions = 0
    await expect(
      stageLiveSettings(rustPath, nodePath, runtime, {
        assertDatabaseUnchanged: () => {
          if (++assertions === 3) writeFileSync(nodePath, competingBytes, { mode: 0o600 })
        }
      })
    ).rejects.toMatchObject({ code: 'config_unavailable' })
    expect(await readFile(nodePath)).toEqual(competingBytes)
    expect(await readdir(nodeDirectory)).toEqual(['config.json'])
  })

  it('stops before writing when live owner evidence rejects', async () => {
    const { rustPath, nodePath, nodeDirectory } = await fixture()
    await writeFile(rustPath, '{"schemaVersion":2}', { mode: 0o600 })
    await expect(
      stageLiveSettings(rustPath, nodePath, runtime, {
        assertDatabaseUnchanged: () => {
          throw new Error('owner lost')
        }
      })
    ).rejects.toThrow('owner lost')
    expect(await readdir(nodeDirectory)).toEqual([])
  })

  it('stops when the Rust settings change during staging', async () => {
    const { rustPath, nodePath, nodeDirectory } = await fixture()
    await writeFile(rustPath, '{"schemaVersion":2,"revision":1}', { mode: 0o600 })
    let assertions = 0
    await expect(
      stageLiveSettings(rustPath, nodePath, runtime, {
        assertDatabaseUnchanged: () => {
          if (++assertions === 2)
            writeFileSync(rustPath, '{"schemaVersion":2,"revision":2}', { mode: 0o600 })
        }
      })
    ).rejects.toMatchObject({ code: 'config_unavailable' })
    expect(await readdir(nodeDirectory)).toEqual([])
  })
})
