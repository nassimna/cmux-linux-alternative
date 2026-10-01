import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { promisify } from 'node:util'

import { createMacCliLauncher } from './mac-cli-launcher.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const readBuilderConfiguration = () =>
  readFile(resolve(desktopDirectory, 'electron-builder.yml'), 'utf8')

test('Linux packages include the staged Node runtime', async () => {
  const configuration = await readBuilderConfiguration()
  const linux = section(configuration, 'linux', 'rpm')
  assert.match(linux, /from: \.\.\/\.\.\/target\/node-linux/u)
  assert.match(linux, /to: node-linux/u)
  assert.doesNotMatch(configuration, /target\/release\/agent-workspace-(?:service|cli)/u)
})

test('the packaged application carries the bundled font license', async () => {
  const configuration = await readBuilderConfiguration()
  assert.match(configuration, /from: node_modules\/@fontsource-variable\/jetbrains-mono\/LICENSE/u)
  assert.match(configuration, /to: licenses\/JetBrainsMono-OFL-1\.1\.txt/u)
})

test('native Linux packages declare the secure custom-action containment prerequisites', async () => {
  const configuration = await readBuilderConfiguration()
  for (const packageSection of [
    section(configuration, 'rpm', 'deb'),
    section(configuration, 'deb', 'mac')
  ]) {
    assert.match(packageSection, /^\s+depends:$/mu)
    assert.match(packageSection, /^\s+- bubblewrap$/mu)
    assert.match(packageSection, /^\s+- systemd$/mu)
  }
})

test('macOS uses the updater-compatible signed distribution targets', async () => {
  const configuration = await readBuilderConfiguration()
  const mac = section(configuration, 'mac', 'pkg')
  assert.match(mac, /icon: build\/icon\.svg/u)
  assert.match(mac, /electronUpdaterCompatibility: ['"]>= 2\.16['"]/u)
  assert.match(mac, /hardenedRuntime: true/u)
  assert.match(mac, /notarize: true/u)
  assert.match(mac, /^\s+- pkg$/mu)
  assert.match(mac, /^\s+- dmg$/mu)
  assert.match(mac, /^\s+- zip$/mu)
  assert.match(mac, /macos-\$\{arch\}/u)
})

test('macOS packages build and include the CLI for both architectures', async () => {
  const configuration = await readBuilderConfiguration()
  const mac = section(configuration, 'mac', 'pkg')
  assert.match(mac, /from: \.\.\/cli\/dist/u)
  assert.match(mac, /to: cli\/dist/u)
  const packageJson = JSON.parse(await readFile(resolve(desktopDirectory, 'package.json'), 'utf8'))
  for (const command of ['package:mac', 'package:mac:dir']) {
    assert.match(packageJson.scripts[command], /^pnpm --workspace-root build:node &&/u)
  }
})

test('the Mac installer fixes the app location and installs into the system domain', async () => {
  const configuration = await readBuilderConfiguration()
  const pkg = section(configuration, 'pkg', 'win')
  assert.match(pkg, /scripts: \.\.\/scripts\/mac-pkg/u)
  assert.match(pkg, /installLocation: \/Applications/u)
  assert.match(pkg, /isRelocatable: false/u)
  assert.match(pkg, /allowAnywhere: false/u)
  assert.match(pkg, /allowCurrentUserHome: false/u)
  assert.match(pkg, /allowRootDirectory: true/u)
  assert.match(pkg, /mustClose:\n\s+- dev\.agentworkspace\.desktop/u)
})

test(
  'the Mac CLI launcher uses the embedded runtime and preserves shell arguments',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'ternline-mac-cli-launcher-'))
    try {
      const contents = resolve(directory, "Ternline with spaces and 'quotes.app", 'Contents')
      const cliDirectory = resolve(contents, 'Resources/cli')
      await mkdir(resolve(contents, 'MacOS'), { recursive: true })
      await mkdir(cliDirectory, { recursive: true })
      const product = "Ternline 'test"
      await writeFile(
        resolve(contents, 'MacOS', product),
        `#!/bin/sh
test "$ELECTRON_RUN_AS_NODE" = 1 || exit 2
test -z "$NODE_OPTIONS$NODE_PATH$ELECTRON_NO_ASAR" || exit 3
printf '%s\\n' "$@"
`,
        { mode: 0o755 }
      )
      const launcher = resolve(cliDirectory, 'ternline-cli')
      await writeFile(launcher, createMacCliLauncher(product), { mode: 0o755 })
      const { stdout } = await promisify(execFileCallback)(
        launcher,
        ['identify', 'a b', '$(false)'],
        {
          env: {
            PATH: '/usr/bin:/bin',
            NODE_OPTIONS: 'untrusted',
            NODE_PATH: 'untrusted',
            ELECTRON_NO_ASAR: '1'
          }
        }
      )
      assert.deepEqual(stdout.trimEnd().split('\n'), [
        resolve(cliDirectory, 'dist/bin.mjs'),
        'identify',
        'a b',
        '$(false)'
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('Windows uses signature-verifying per-user NSIS packages', async () => {
  const configuration = await readBuilderConfiguration()
  const windows = section(configuration, 'win', 'nsis')
  const nsis = section(configuration, 'nsis')
  assert.match(windows, /icon: build\/icon\.svg/u)
  assert.match(windows, /electronUpdaterCompatibility: ['"]>= 2\.16['"]/u)
  assert.match(windows, /verifyUpdateCodeSignature: true/u)
  assert.match(windows, /^\s+- nsis$/mu)
  assert.doesNotMatch(windows, /squirrel/iu)
  assert.match(nsis, /oneClick: false/u)
  assert.match(nsis, /perMachine: false/u)
  assert.match(nsis, /deleteAppDataOnUninstall: false/u)
})

function section(configuration, start, end) {
  const startToken = `${start}:\n`
  const startIndex = configuration.indexOf(startToken)
  assert.notEqual(startIndex, -1, `missing ${start} section`)
  const contentStart = startIndex + startToken.length
  if (end === undefined) return configuration.slice(contentStart)
  const endIndex = configuration.indexOf(`${end}:\n`, contentStart)
  assert.notEqual(endIndex, -1, `missing ${end} section`)
  return configuration.slice(contentStart, endIndex)
}
