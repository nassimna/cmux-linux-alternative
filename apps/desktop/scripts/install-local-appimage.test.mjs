import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  escapeDesktopExecArgument,
  installLocalAppImage,
  resolveDataHome
} from './install-local-appimage.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const execFile = promisify(execFileCallback)

test('local package scripts build only a staged x64 AppImage before installing it', async () => {
  const rootPackage = JSON.parse(await readFile(join(repositoryDirectory, 'package.json'), 'utf8'))
  const desktopPackage = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))
  const rootCommand = rootPackage.scripts['package:linux:local']
  const desktopCommand = desktopPackage.scripts['package:linux:local']

  assert.equal(
    rootCommand,
    'pnpm build:service && pnpm --filter @agent-workspace/desktop package:linux:local'
  )
  assert.match(desktopCommand, /electron-builder --linux AppImage --x64 --publish never/u)
  assert.match(desktopCommand, /-c\.directories\.output=\.\.\/\.\.\/target\/local-appimage/u)
  assert.match(desktopCommand, /node scripts\/install-local-appimage\.mjs/u)
  assert.match(
    desktopCommand,
    new RegExp(`agent-workspace-${desktopPackage.version}-x86_64\\.AppImage`, 'u')
  )
  assert.doesNotMatch(desktopCommand, /(?:^|\s)(?:deb|rpm)(?:\s|$)/u)
  assert.doesNotMatch(desktopCommand, /release:(?:checksums|verify)/u)
  assert.match(desktopPackage.scripts.test, /(?:^|&&\s*)pnpm test:local-appimage(?:\s*&&|$)/u)
})

test('installs and atomically updates the AppImage, icon, and desktop entry', async (context) => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = join(directory, 'source with spaces')
    const dataHome = join(directory, 'data with spaces, "quotes, $dollars, `ticks, and \\slashes')
    await writeFileTree(join(sourceDirectory, 'agent-workspace.AppImage'), 'appimage-v1')
    await writeFileTree(join(sourceDirectory, '512x512.png'), 'icon-v1')

    const installed = await installLocalAppImage({
      appImagePath: join(sourceDirectory, 'agent-workspace.AppImage'),
      iconPath: join(sourceDirectory, '512x512.png'),
      dataHome
    })

    assert.equal(await readFile(installed.appImage, 'utf8'), 'appimage-v1')
    assert.equal(await readFile(installed.icon, 'utf8'), 'icon-v1')
    assert.equal((await lstat(installed.appImage)).mode & 0o777, 0o755)
    assert.equal((await lstat(installed.icon)).mode & 0o777, 0o644)
    assert.equal((await lstat(installed.desktopEntry)).mode & 0o777, 0o644)

    const desktopEntry = await readFile(installed.desktopEntry, 'utf8')
    assert.match(desktopEntry, /^\[Desktop Entry\]\nType=Application\n/u)
    assert.match(desktopEntry, /\nIcon=agent-workspace\n/u)
    assert.match(
      desktopEntry,
      new RegExp(`\\nExec=${regexpEscape(escapeDesktopExecArgument(installed.appImage))}\\n`, 'u')
    )
    try {
      await execFile('desktop-file-validate', [installed.desktopEntry])
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        context.diagnostic('desktop-file-validate is unavailable; skipping system parser check')
      } else {
        throw error
      }
    }

    await writeFile(join(sourceDirectory, 'agent-workspace.AppImage'), 'appimage-v2')
    await chmod(installed.appImage, 0o600)
    await installLocalAppImage({
      appImagePath: join(sourceDirectory, 'agent-workspace.AppImage'),
      iconPath: join(sourceDirectory, '512x512.png'),
      dataHome
    })
    assert.equal(await readFile(installed.appImage, 'utf8'), 'appimage-v2')
    assert.equal((await lstat(installed.appImage)).mode & 0o777, 0o755)

    for (const parent of [
      join(dataHome, 'agent-workspace'),
      join(dataHome, 'applications'),
      join(dataHome, 'icons', 'hicolor', '512x512', 'apps')
    ]) {
      assert.equal(
        (await readdir(parent)).some((name) => name.endsWith('.tmp')),
        false
      )
    }
  })
})

test('uses XDG_DATA_HOME and falls back to the user local share directory', () => {
  assert.equal(
    resolveDataHome({
      environment: { XDG_DATA_HOME: '/tmp/custom data' },
      homeDirectory: '/home/a'
    }),
    '/tmp/custom data'
  )
  assert.equal(
    resolveDataHome({ environment: {}, homeDirectory: '/home/example' }),
    '/home/example/.local/share'
  )
  assert.throws(
    () => resolveDataHome({ environment: { XDG_DATA_HOME: 'relative' }, homeDirectory: '/home/a' }),
    /must be an absolute path/u
  )
})

test('escapes reserved Desktop Entry Exec characters and rejects control characters', () => {
  assert.equal(
    escapeDesktopExecArgument('/tmp/a path/with "$money`and\\slashes'),
    '"/tmp/a path/with \\\\"\\\\$money\\\\`and\\\\\\\\slashes"'
  )
  assert.throws(() => escapeDesktopExecArgument('/tmp/line\nbreak'), /control characters/u)
  assert.throws(() => escapeDesktopExecArgument('/tmp/percent%path'), /field-code markers/u)
})

test('rejects unsupported percent paths before installing files', async () => {
  await withTemporaryDirectory(async (directory) => {
    const source = join(directory, 'source.AppImage')
    const icon = join(directory, 'icon.png')
    const dataHome = join(directory, 'percent%data')
    await writeFile(source, 'appimage')
    await writeFile(icon, 'icon')

    await assert.rejects(
      installLocalAppImage({ appImagePath: source, iconPath: icon, dataHome }),
      /field-code markers/u
    )
    await assert.rejects(access(join(dataHome, 'agent-workspace', 'agent-workspace.AppImage')))
  })
})

test('rejects symlinked AppImage input', async () => {
  await withTemporaryDirectory(async (directory) => {
    const source = join(directory, 'source.AppImage')
    const linked = join(directory, 'linked.AppImage')
    const icon = join(directory, 'icon.png')
    await writeFile(source, 'appimage')
    await writeFile(icon, 'icon')
    await symlink(source, linked)

    await assert.rejects(
      installLocalAppImage({
        appImagePath: linked,
        iconPath: icon,
        dataHome: join(directory, 'data')
      }),
      /regular file/u
    )
    await assert.rejects(
      access(join(directory, 'data', 'agent-workspace', 'agent-workspace.AppImage'))
    )
  })
})

async function writeFileTree(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-local-appimage-'))
  try {
    await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function regexpEscape(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
