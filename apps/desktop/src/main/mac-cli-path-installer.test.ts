import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MacCliPathInstaller } from './mac-cli-path-installer'

const execute = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ternline-cli-path with 'quotes-"))
  temporaryDirectories.push(directory)
  const sourcePath = join(directory, 'Ternline.app/Contents/Resources/cli/ternline-cli')
  const destinationPath = join(directory, 'usr/local/bin/ternline-cli')
  await mkdir(dirname(sourcePath), { recursive: true })
  await writeFile(sourcePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const runPrivileged = vi.fn<(command: string) => Promise<void>>()
  const installer = new MacCliPathInstaller({ sourcePath, destinationPath, runPrivileged })
  return { directory, sourcePath, destinationPath, runPrivileged, installer }
}

describe.skipIf(process.platform === 'win32')('Mac CLI path installation', () => {
  it('installs an idempotent symlink without authorization or shell profile changes', async () => {
    const { directory, sourcePath, destinationPath, runPrivileged, installer } = await fixture()
    const profile = join(directory, '.zshrc')
    await writeFile(profile, '# Keep my shell settings\n')
    expect(await installer.isInstalled()).toBe(false)
    await installer.install()
    await installer.install()
    expect(await installer.isInstalled()).toBe(true)
    expect(await readlink(destinationPath)).toBe(sourcePath)
    expect(await readFile(profile, 'utf8')).toBe('# Keep my shell settings\n')
    expect(runPrivileged).not.toHaveBeenCalled()
    await installer.uninstall()
    await installer.uninstall()
    expect(await installer.isInstalled()).toBe(false)
    expect(await readFile(sourcePath, 'utf8')).toContain('exit 0')
  })

  it('preserves unrelated commands during installation and uninstallation', async () => {
    const { destinationPath, installer, runPrivileged } = await fixture()
    await mkdir(dirname(destinationPath), { recursive: true })
    await writeFile(destinationPath, 'unrelated command')
    await expect(installer.install()).rejects.toThrow('unrelated or modified command')
    await expect(installer.uninstall()).rejects.toThrow('unrelated or modified command')
    expect(await readFile(destinationPath, 'utf8')).toBe('unrelated command')
    expect(runPrivileged).not.toHaveBeenCalled()
  })

  it('preserves an unrelated dangling symlink', async () => {
    const { destinationPath, installer } = await fixture()
    await mkdir(dirname(destinationPath), { recursive: true })
    await symlink('missing-command', destinationPath)
    await expect(installer.install()).rejects.toThrow('unrelated or modified command')
    expect(await readlink(destinationPath)).toBe('missing-command')
  })

  it('migrates the exact previous package launcher to a symlink', async () => {
    const { destinationPath, sourcePath, installer } = await fixture()
    await mkdir(dirname(destinationPath), { recursive: true })
    await writeFile(
      destinationPath,
      '#!/bin/sh\n# Ternline installer command-line launcher\nexec /Applications/Ternline.app/Contents/Resources/cli/ternline-cli "$@"\n'
    )
    await installer.install()
    expect(await readlink(destinationPath)).toBe(sourcePath)
  })

  it('fails before touching the destination when the bundled CLI is absent', async () => {
    const { sourcePath, destinationPath, installer, runPrivileged } = await fixture()
    await rm(sourcePath)
    await expect(installer.install()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runPrivileged).not.toHaveBeenCalled()
  })

  it('requests authorization only after a write permission failure, with safe quoted paths', async () => {
    const { destinationPath, sourcePath, installer, runPrivileged } = await fixture()
    await mkdir(dirname(destinationPath), { recursive: true })
    await chmod(dirname(destinationPath), 0o500)
    runPrivileged.mockImplementation(async (command) => {
      await chmod(dirname(destinationPath), 0o700)
      await execute('/bin/sh', ['-c', command])
    })
    try {
      await installer.install()
      expect(runPrivileged).toHaveBeenCalledOnce()
      expect(await readlink(destinationPath)).toBe(sourcePath)
      await chmod(dirname(destinationPath), 0o500)
      await installer.uninstall()
      expect(runPrivileged).toHaveBeenCalledTimes(2)
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await chmod(dirname(destinationPath), 0o700)
    }
  })

  it('leaves the command absent when authorization is cancelled', async () => {
    const { destinationPath, installer, runPrivileged } = await fixture()
    await mkdir(dirname(destinationPath), { recursive: true })
    await chmod(dirname(destinationPath), 0o500)
    runPrivileged.mockRejectedValue(new Error('User cancelled'))
    try {
      await expect(installer.install()).rejects.toThrow('User cancelled')
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await chmod(dirname(destinationPath), 0o700)
    }
  })

  it('rechecks ownership after an authorization prompt before replacing a command', async () => {
    const { destinationPath, installer, runPrivileged } = await fixture()
    await mkdir(dirname(destinationPath), { recursive: true })
    await chmod(dirname(destinationPath), 0o500)
    runPrivileged.mockImplementation(async (command) => {
      await chmod(dirname(destinationPath), 0o700)
      await writeFile(destinationPath, 'created while authorization was pending')
      await execute('/bin/sh', ['-c', command])
    })
    try {
      await expect(installer.install()).rejects.toThrow()
      expect(await readFile(destinationPath, 'utf8')).toBe(
        'created while authorization was pending'
      )
    } finally {
      await chmod(dirname(destinationPath), 0o700)
    }
  })
})
