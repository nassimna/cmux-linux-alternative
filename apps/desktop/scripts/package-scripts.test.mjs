import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('the end-to-end grep option is portable across npm shells', async () => {
  const packageJson = JSON.parse(await readFile(resolve(desktopDirectory, 'package.json'), 'utf8'))
  const command = packageJson.scripts['test:e2e']

  assert.match(
    command,
    /(?:^|\s)--grep-invert="qualifies the packaged release"(?:\s|$)/u,
    'the grep phrase must be double-quoted as one shell argument'
  )
  assert.doesNotMatch(command, /\\ /u, 'backslash-space escaping is not portable to cmd.exe')
})

test('the aggregate desktop test enforces the Electron shutdown helper tests', async () => {
  const packageJson = JSON.parse(await readFile(resolve(desktopDirectory, 'package.json'), 'utf8'))

  assert.equal(
    packageJson.scripts['test:electron-shutdown'],
    'node --test scripts/close-electron-application.test.mjs'
  )
  assert.match(
    packageJson.scripts.test,
    /(?:^|&&\s*)pnpm test:electron-shutdown(?:\s*&&|$)/u,
    'the aggregate test command must execute the fail-closed Electron shutdown tests'
  )
})
