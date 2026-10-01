import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const scripts = join(dirname(fileURLToPath(import.meta.url)), 'mac-pkg')
const execute = promisify(execFile)
const shellTest = (name, action) => test(name, { skip: process.platform === 'win32' }, action)
const run = (script, volume) =>
  execute('/bin/sh', [join(scripts, script), 'Ternline.pkg', '/Applications', volume])

async function withVolume(action) {
  const volume = await mkdtemp(join(tmpdir(), 'ternline-pkg-volume with spaces-'))
  const command = join(volume, 'usr/local/bin/ternline-cli')
  const launcher = join(volume, 'Applications/Ternline.app/Contents/Resources/cli/ternline-cli')
  try {
    await mkdir(dirname(launcher), { recursive: true })
    await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await action({ volume, command, launcher })
  } finally {
    await rm(volume, { recursive: true, force: true })
  }
}

shellTest(
  'installs the external command without editing profiles and permits repeat installation',
  async () => {
    await withVolume(async ({ volume, command }) => {
      const home = join(volume, 'Users/tester')
      await mkdir(home, { recursive: true })
      const profiles = ['.zshenv', '.zshrc', '.bash_profile', '.bashrc'].map((name) =>
        join(home, name)
      )
      for (const profile of profiles) await writeFile(profile, '# Existing shell configuration\n')
      await run('preinstall', volume)
      await run('postinstall', volume)
      const expected = await readFile(join(scripts, 'ternline-cli'), 'utf8')
      assert.equal(await readFile(command, 'utf8'), expected)
      assert.equal((await stat(command)).mode & 0o777, 0o755)
      await run('preinstall', volume)
      await run('postinstall', volume)
      assert.equal(await readFile(command, 'utf8'), expected)
      assert.deepEqual(await readdir(dirname(command)), ['ternline-cli'])
      for (const profile of profiles)
        assert.equal(await readFile(profile, 'utf8'), '# Existing shell configuration\n')
    })
  }
)

shellTest(
  'preserves an unrelated command and detects a conflict introduced after preinstall',
  async () => {
    await withVolume(async ({ volume, command }) => {
      await run('preinstall', volume)
      await mkdir(dirname(command), { recursive: true })
      await writeFile(command, 'unrelated command')
      for (const script of ['preinstall', 'postinstall']) {
        await assert.rejects(run(script, volume), /unrelated or modified command/u)
        assert.equal(await readFile(command, 'utf8'), 'unrelated command')
      }
    })
  }
)

shellTest('preserves a dangling symlink and a modified Ternline launcher', async () => {
  await withVolume(async ({ volume, command }) => {
    await mkdir(dirname(command), { recursive: true })
    await symlink('missing-command', command)
    await assert.rejects(run('preinstall', volume), /unrelated or modified command/u)
    await rm(command)
    const modified = '#!/bin/sh\n# Ternline installer command-line launcher\n# Custom launcher\n'
    await writeFile(command, modified)
    await assert.rejects(run('postinstall', volume), /unrelated or modified command/u)
    assert.equal(await readFile(command, 'utf8'), modified)
  })
})

shellTest('does not install a broken command if the app payload is missing', async () => {
  await withVolume(async ({ volume, command, launcher }) => {
    await rm(launcher)
    await assert.rejects(run('postinstall', volume), /bundled CLI is missing/u)
    await assert.rejects(stat(command), { code: 'ENOENT' })
  })
})
