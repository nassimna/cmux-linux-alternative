import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { parseBrowserAutomation, runBrowserAutomation } from './browser-automation'

void test('browser automation parses list and JSON commands with their existing arity', () => {
  assert.deepEqual(parseBrowserAutomation(['browser-automation', 'list'], '/private/session'), {
    sessionFile: '/private/session',
    command: 'browser-automation.list'
  })
  assert.equal(
    parseBrowserAutomation(['browser-automation', 'list', '--extra'], '/private/session'),
    undefined
  )
  assert.deepEqual(
    parseBrowserAutomation(
      ['browser-automation', 'execute', '--params-json', '{"x":1}'],
      '/private/session'
    ),
    { sessionFile: '/private/session', command: 'browser-automation.execute', params: { x: 1 } }
  )
})

void test('browser automation retains JSON option errors before opening a session', () => {
  const parse = (args: string[]) =>
    parseBrowserAutomation(['browser-automation', 'create', ...args], '/private/session')
  assert.throws(() => parse([]), /--params-json is required/)
  assert.throws(() => parse(['--params-json']), /--params-json requires a value/)
  assert.throws(() => parse(['--params-json', '[]']), /Request must be a JSON object/)
  assert.throws(
    () => parse(['--params-json', '{}', '--params-json', '{}']),
    /Unknown or repeated option/
  )
  assert.throws(
    () => parse(['--params-json', ' '.repeat(64 * 1024 + 1)]),
    /JSON request is too large/
  )
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
  const execute = parseBrowserAutomation(
    ['browser-automation', 'execute', '--params-json', '{"x":1}'],
    '/private/session'
  )!
  assert.deepEqual(await runBrowserAutomation(client, execute), {
    operation: { state: 'completed' }
  })
  assert.deepEqual(calls, [{ x: 1 }])
  const list = parseBrowserAutomation(['browser-automation', 'list'], '/private/session')!
  assert.deepEqual(await runBrowserAutomation(client, list), { sessions: [] })
})

void test('create defaults profile and identities while preserving explicit retry identities', async () => {
  const epoch = randomUUID()
  const suppliedEpoch = randomUUID()
  const key = randomUUID()
  const correlationId = randomUUID()
  const seen: unknown[] = []
  let identifies = 0
  const client = {
    identify: () => {
      identifies += 1
      return Promise.resolve({ idempotencyEpoch: epoch })
    },
    createBrowserAutomationSession: (params: unknown) => {
      seen.push(params)
      return Promise.resolve({})
    }
  } as unknown as AgentWorkspaceClient
  await runBrowserAutomation(
    client,
    parseBrowserAutomation(
      ['browser-automation', 'create', '--params-json', '{"mode":"ephemeral"}'],
      '/private/session'
    )!
  )
  assert.equal((seen[0] as { profileKey: string }).profileKey, 'default')
  assert.equal((seen[0] as { idempotency: { epoch: string } }).idempotency.epoch, epoch)
  const params = {
    mode: 'ephemeral',
    profileKey: 'configured',
    idempotency: { epoch: suppliedEpoch, key },
    correlationId
  }
  await runBrowserAutomation(
    client,
    parseBrowserAutomation(
      ['browser-automation', 'create', '--params-json', JSON.stringify(params)],
      '/private/session'
    )!
  )
  assert.deepEqual(seen[1], params)
  assert.equal(identifies, 1)
})

void test('browser commands construct operations and use the current session epochs', async () => {
  const session = { automationSessionId: randomUUID(), generation: 4, navigationEpoch: 9 }
  const epoch = randomUUID()
  const requests: unknown[] = []
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: epoch }),
    listBrowserAutomationSessions: () => Promise.resolve({ sessions: [session] }),
    invokeBrowserAutomationUntilTerminal: (request: unknown) => {
      requests.push(request)
      return Promise.resolve({
        operation: { state: 'succeeded', result: { kind: 'evaluation', value: 2 } }
      })
    }
  } as unknown as AgentWorkspaceClient
  const parsed = parseBrowserAutomation(
    ['browser', 'eval', '--session-id', session.automationSessionId, '--expression', '1+1'],
    '/private/session'
  )!
  await runBrowserAutomation(client, parsed)
  const request = requests[0] as {
    operation: unknown
    sessionGeneration: number
    navigationEpoch: number
    idempotency: { epoch: string }
  }
  assert.deepEqual(request.operation, { kind: 'evaluate', expression: '1+1' })
  assert.equal(request.sessionGeneration, 4)
  assert.equal(request.navigationEpoch, 9)
  assert.equal(request.idempotency.epoch, epoch)
  const parse = (tail: string[]) => parseBrowserAutomation(['browser', ...tail], '/private/session')
  assert.throws(() => parse(['click', '--selector', '#button']), /--session-id is required/)
  assert.throws(
    () =>
      parse([
        'query',
        '--session-id',
        session.automationSessionId,
        '--selector',
        'body',
        '--limit',
        '101'
      ]),
    /--limit must be an integer/
  )
  assert.throws(
    () => parse(['console', '--session-id', session.automationSessionId, '--clear', 'yes']),
    /--clear must be true or false/
  )
  assert.deepEqual(
    (
      parse([
        'type',
        '--session-id',
        session.automationSessionId,
        '--selector',
        'input',
        '--text',
        ''
      ]) as { operation: unknown }
    ).operation,
    { kind: 'typeText', selector: 'input', text: '' }
  )
})

void test('browser open creates a default ephemeral session before navigating', async () => {
  const session = { automationSessionId: randomUUID(), generation: 1, navigationEpoch: 0 }
  const seen: unknown[] = []
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: randomUUID() }),
    createBrowserAutomationSession: (params: unknown) => {
      seen.push(params)
      return Promise.resolve({ session })
    },
    invokeBrowserAutomationUntilTerminal: (params: unknown) => {
      seen.push(params)
      return Promise.resolve({
        operation: {
          state: 'succeeded',
          navigationEpoch: 1,
          result: { kind: 'navigation', navigationEpoch: 1 }
        }
      })
    }
  } as unknown as AgentWorkspaceClient
  const result = await runBrowserAutomation(
    client,
    parseBrowserAutomation(['browser', 'open', '--url', 'https://example.com'], '/private/session')!
  )
  assert.equal((seen[0] as { mode: string }).mode, 'ephemeral')
  assert.equal((seen[0] as { profileKey: string }).profileKey, 'default')
  assert.deepEqual((seen[1] as { operation: unknown }).operation, {
    kind: 'navigate',
    url: 'https://example.com'
  })
  assert.equal(
    (result as { session: typeof session }).session.automationSessionId,
    session.automationSessionId
  )
  assert.equal((result as { session: typeof session }).session.navigationEpoch, 1)
})

void test('failed browser open destroys only its newly created session', async () => {
  const session = { automationSessionId: randomUUID(), generation: 2, navigationEpoch: 0 }
  const destroyed: unknown[] = []
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: randomUUID() }),
    createBrowserAutomationSession: () => Promise.resolve({ session }),
    listBrowserAutomationSessions: () => Promise.resolve({ sessions: [session] }),
    invokeBrowserAutomationUntilTerminal: () =>
      Promise.resolve({ operation: { state: 'failed', errorCode: 'unsafe_url' } }),
    destroyBrowserAutomationSession: (params: unknown) => {
      destroyed.push(params)
      return Promise.resolve({})
    }
  } as unknown as AgentWorkspaceClient
  await assert.rejects(
    runBrowserAutomation(
      client,
      parseBrowserAutomation(['browser', 'open', '--url', 'file:///private'], '/private/session')!
    ),
    /unsafe_url/
  )
  assert.deepEqual(destroyed, [{ automationSessionId: session.automationSessionId, generation: 2 }])
  await assert.rejects(
    runBrowserAutomation(
      client,
      parseBrowserAutomation(
        [
          'browser',
          'open',
          '--session-id',
          session.automationSessionId,
          '--url',
          'file:///private'
        ],
        '/private/session'
      )!
    ),
    /unsafe_url/
  )
  assert.equal(destroyed.length, 1)
})

void test('screenshot output verifies bytes and releases its handle, including on corrupt content', async () => {
  const directory = await mkdtemp(join(homedir(), '.cache/ternline-cli-test-'))
  const output = join(directory, 'screenshot.png')
  const png = Buffer.from('simulated PNG data')
  const handle = {
    handleId: randomUUID(),
    chunkCount: 2,
    byteLength: png.byteLength,
    sha256: createHash('sha256').update(png).digest('hex')
  }
  const session = { automationSessionId: randomUUID(), generation: 1, navigationEpoch: 0 }
  let released = 0
  let corrupt = false
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: randomUUID() }),
    listBrowserAutomationSessions: () => Promise.resolve({ sessions: [session] }),
    invokeBrowserAutomationUntilTerminal: () =>
      Promise.resolve({
        operation: { state: 'succeeded', result: { kind: 'screenshot', handle } }
      }),
    readBrowserAutomationScreenshot: ({ chunkIndex }: { chunkIndex: number }) =>
      Promise.resolve({
        ...handle,
        chunkIndex,
        dataBase64: (corrupt
          ? Buffer.from('corrupt')
          : chunkIndex === 0
            ? png.subarray(0, 5)
            : png.subarray(5)
        ).toString('base64')
      }),
    releaseBrowserAutomationScreenshot: () => {
      released += 1
      return Promise.resolve({ released: true })
    }
  } as unknown as AgentWorkspaceClient
  try {
    const parsed = parseBrowserAutomation(
      ['browser', 'screenshot', '--session-id', session.automationSessionId, '--output', output],
      '/private/session'
    )!
    await runBrowserAutomation(client, parsed)
    assert.deepEqual(await readFile(output), png)
    assert.equal(released, 1)
    corrupt = true
    await assert.rejects(runBrowserAutomation(client, parsed), /Screenshot content does not match/)
    assert.equal(released, 2)
    assert.deepEqual(await readFile(output), png)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
