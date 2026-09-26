import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'node:test'
import assert from 'node:assert/strict'

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
  const mac = section(configuration, 'mac', 'win')
  assert.match(mac, /icon: build\/icon\.svg/u)
  assert.match(mac, /electronUpdaterCompatibility: ['"]>= 2\.16['"]/u)
  assert.match(mac, /hardenedRuntime: true/u)
  assert.match(mac, /notarize: true/u)
  assert.match(mac, /^\s+- dmg$/mu)
  assert.match(mac, /^\s+- zip$/mu)
  assert.match(mac, /macos-\$\{arch\}/u)
})

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
