import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { preflightLiveSettings, type LiveRuntimeSettings } from './live-settings-preflight'

const directories: string[] = []
const runtime: LiveRuntimeSettings = {
  notificationSettings: { systemEnabled: true, includeBody: false },
  shortcutOverrides: {}
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'live-settings-preflight-'))
  directories.push(root)
  const rustDirectory = join(root, 'configuration')
  const nodeDirectory = join(root, 'node')
  await mkdir(rustDirectory, { mode: 0o700 })
  await mkdir(nodeDirectory, { mode: 0o700 })
  await chmod(rustDirectory, 0o700)
  await chmod(nodeDirectory, 0o700)
  return {
    rustPath: join(rustDirectory, 'desktop.json'),
    nodePath: join(nodeDirectory, 'config.json')
  }
}

describe('live settings preflight', () => {
  it('accepts only separate byte-identical qualified files without modifying them', async () => {
    const { rustPath, nodePath } = await fixture()
    const bytes = '{"schemaVersion":2,"revision":7,"appearance":{"theme":"dark","future":"keep"}}\n'
    await writeFile(rustPath, bytes, { mode: 0o600 })
    await writeFile(nodePath, bytes, { mode: 0o600 })
    const result = await preflightLiveSettings(rustPath, nodePath, runtime)
    expect(result).toMatchObject({
      rustDesktop: { status: 'present', revision: 7, unknownFieldsPresent: true },
      nodeConfig: { status: 'present', revision: 7 },
      byteIdentical: true,
      runtimeSettingsMatch: true,
      blockers: []
    })
    expect(await readFile(rustPath, 'utf8')).toBe(bytes)
    expect(await readFile(nodePath, 'utf8')).toBe(bytes)
  })

  it('blocks missing, divergent, and orphan target files explicitly', async () => {
    const { rustPath, nodePath } = await fixture()
    expect((await preflightLiveSettings(rustPath, nodePath, runtime)).blockers).toEqual([
      'rust_desktop_config_absent_requires_explicit_defaults_decision'
    ])
    await writeFile(rustPath, '{"schemaVersion":2,"appearance":{"theme":"dark"}}', { mode: 0o600 })
    expect((await preflightLiveSettings(rustPath, nodePath, runtime)).blockers).toEqual([
      'node_config_missing'
    ])
    await writeFile(nodePath, '{"schemaVersion":2,"appearance":{"theme":"light"}}', { mode: 0o600 })
    expect((await preflightLiveSettings(rustPath, nodePath, runtime)).blockers).toEqual([
      'node_config_differs_from_rust'
    ])
    await rm(rustPath)
    expect((await preflightLiveSettings(rustPath, nodePath, runtime)).blockers).toEqual([
      'rust_desktop_config_absent_requires_explicit_defaults_decision',
      'node_config_has_no_rust_source'
    ])
  })

  it('blocks a runtime settings mismatch even with identical files', async () => {
    const { rustPath, nodePath } = await fixture()
    const bytes = '{"schemaVersion":2,"notifications":{"systemEnabled":false}}'
    await writeFile(rustPath, bytes, { mode: 0o600 })
    await writeFile(nodePath, bytes, { mode: 0o600 })
    expect((await preflightLiveSettings(rustPath, nodePath, runtime)).blockers).toEqual([
      'runtime_settings_differ_from_rust'
    ])
  })

  it('rejects invalid JSON and unsafe links without writing', async () => {
    const { rustPath, nodePath } = await fixture()
    await writeFile(rustPath, '{"schemaVersion":3}', { mode: 0o600 })
    await expect(preflightLiveSettings(rustPath, nodePath, runtime)).rejects.toMatchObject({
      code: 'invalid_config'
    })
    await rm(rustPath)
    await writeFile(nodePath, '{"schemaVersion":2}', { mode: 0o600 })
    await symlink(nodePath, rustPath)
    await expect(preflightLiveSettings(rustPath, nodePath, runtime)).rejects.toMatchObject({
      code: 'unsafe_config'
    })
    await rm(rustPath)
    await link(nodePath, rustPath)
    await expect(preflightLiveSettings(rustPath, nodePath, runtime)).rejects.toMatchObject({
      code: 'unsafe_config'
    })
  })

  it('rejects group-readable settings and private files in an open directory', async () => {
    const { rustPath, nodePath } = await fixture()
    await writeFile(rustPath, '{"schemaVersion":2}', { mode: 0o600 })
    await chmod(rustPath, 0o640)
    await expect(preflightLiveSettings(rustPath, nodePath, runtime)).rejects.toMatchObject({
      code: 'unsafe_config'
    })
    await chmod(rustPath, 0o600)
    await chmod(dirname(rustPath), 0o755)
    await expect(preflightLiveSettings(rustPath, nodePath, runtime)).rejects.toMatchObject({
      code: 'unsafe_config'
    })
  })
})
