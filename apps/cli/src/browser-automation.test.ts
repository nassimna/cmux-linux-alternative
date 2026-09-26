import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { parseBrowserAutomation, runBrowserAutomation } from './browser-automation'

void test('browser automation parses list and JSON commands with their existing arity', () => {
  assert.deepEqual(parseBrowserAutomation(['browser-automation', 'list'], '/private/session'), {
    sessionFile: '/private/session',
    command: 'browser-automation.list'
  })
  assert.equal(parseBrowserAutomation(['browser-automation', 'list', '--extra'], '/private/session'), undefined)
  assert.deepEqual(
    parseBrowserAutomation(['browser-automation', 'execute', '--params-json', '{"x":1}'], '/private/session'),
    { sessionFile: '/private/session', command: 'browser-automation.execute', params: { x: 1 } }
  )
})

void test('browser automation retains JSON option errors before opening a session', () => {
  const parse = (args: string[]) => parseBrowserAutomation(['browser-automation', 'create', ...args], '/private/session')
  assert.throws(() => parse([]), /--params-json is required/)
  assert.throws(() => parse(['--params-json']), /--params-json requires a value/)
  assert.throws(() => parse(['--params-json', '[]']), /Request must be a JSON object/)
  assert.throws(() => parse(['--params-json', '{}', '--params-json', '{}']), /Unknown or repeated option/)
  assert.throws(() => parse(['--params-json', ' '.repeat(64 * 1024 + 1)]), /JSON request is too large/)
})

void test('execute waits for the terminal result and list uses the same client', async () => {
  const calls: unknown[] = []
  const client = {
    invokeBrowserAutomationUntilTerminal: (params: unknown) => {
      calls.push(params)
      return Promise.resolve({ operation: { state: 'completed' } })
    },
    listBrowserAutomationSessions: () => Promise.resolve({ sessions: [] })
  } as unknown as AgentWorkspaceClient
  const execute = parseBrowserAutomation(['browser-automation', 'execute', '--params-json', '{"x":1}'], '/private/session')!
  assert.deepEqual(await runBrowserAutomation(client, execute), { operation: { state: 'completed' } })
  assert.deepEqual(calls, [{ x: 1 }])
  const list = parseBrowserAutomation(['browser-automation', 'list'], '/private/session')!
  assert.deepEqual(await runBrowserAutomation(client, list), { sessions: [] })
})
