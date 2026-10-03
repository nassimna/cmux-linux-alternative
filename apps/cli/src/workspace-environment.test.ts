import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { workspaceEnvironment } from './workspace-environment'

void test('workspace environment merges dotenv with explicit overrides and leaves command arguments alone', () => {
  const directory = mkdtempSync(join(homedir(), '.cache/ternline-cli-test-'))
  const file = join(directory, 'workspace.env')
  try {
    writeFileSync(file, '# workspace variables\nMODE=file\nMESSAGE="hello world"\nEMPTY=\n')
    assert.deepEqual(
      workspaceEnvironment([
        '--name',
        'Test',
        '--env',
        'MODE=first',
        '--env-file',
        file,
        '--env',
        'MODE=explicit',
        '--env',
        'TOKEN=value=with=equals',
        '--command',
        'env',
        '--env',
        'PROGRAM_ARGUMENT=1'
      ]),
      {
        args: ['--name', 'Test', '--command', 'env', '--env', 'PROGRAM_ARGUMENT=1'],
        environment: {
          MODE: 'explicit',
          MESSAGE: 'hello world',
          EMPTY: '',
          TOKEN: 'value=with=equals'
        }
      }
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

void test('workspace environment rejects invalid names, missing assignments, and repeated files', () => {
  assert.throws(() => workspaceEnvironment(['--env', 'MISSING_EQUALS']), /--env requires KEY=VALUE/)
  assert.throws(() => workspaceEnvironment(['--env', 'BAD-NAME=value']), /valid variable names/)
  assert.throws(
    () => workspaceEnvironment(['--env-file', 'first', '--env-file', 'second']),
    /Unknown or repeated option/
  )
  assert.throws(
    () => workspaceEnvironment(['--env', '--name', 'Workspace']),
    /--env requires a value/
  )
  assert.deepEqual(workspaceEnvironment(['--env', '__proto__=safe']).environment, {
    ['__proto__']: 'safe'
  })
})
