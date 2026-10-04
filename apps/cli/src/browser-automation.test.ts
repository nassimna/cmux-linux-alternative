import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ServerError, type AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import {
  parseBrowserAutomation,
  runBrowserAutomation,
  followBrowserDiagnostics
} from './browser-automation'

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
  let navigationEpoch = session.navigationEpoch
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: epoch }),
    listBrowserAutomationSessions: () =>
      Promise.resolve({ sessions: [{ ...session, navigationEpoch }] }),
    invokeBrowserAutomationUntilTerminal: (request: unknown) => {
      requests.push(request)
      return Promise.resolve({
        operation: { state: 'succeeded', navigationEpoch, result: { kind: 'evaluation', value: 2 } }
      })
    }
  } as unknown as AgentWorkspaceClient
  const parsed = parseBrowserAutomation(
    ['browser', 'eval', '--session-id', session.automationSessionId, '--expression', '1+1'],
    '/private/session'
  )!
  assert.deepEqual(await runBrowserAutomation(client, parsed), { kind: 'evaluation', value: 2 })
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
  navigationEpoch = 10
  const verbose = parseBrowserAutomation(
    [
      'browser',
      'eval',
      '--session-id',
      session.automationSessionId,
      '--expression',
      '1+1',
      '--verbose'
    ],
    '/private/session'
  )!
  assert.deepEqual(await runBrowserAutomation(client, verbose), {
    session: { ...session, navigationEpoch: 10 },
    operation: { state: 'succeeded', navigationEpoch: 10, result: { kind: 'evaluation', value: 2 } }
  })
  assert.equal((requests[1] as { navigationEpoch: number }).navigationEpoch, 10)
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
  assert.throws(
    () => parse(['snapshot', '--session-id', session.automationSessionId, '--verbose', 'yes']),
    /--verbose must be true or false/
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

void test('browser operations refresh and retry stale_navigation only once with new identities', async () => {
  for (const transportError of [false, true]) {
    const sessionId = randomUUID()
    const requests: {
      navigationEpoch: number
      operationId: string
      idempotency: { key: string }
    }[] = []
    let lists = 0
    let repeated = false
    const client = {
      identify: () => Promise.resolve({ idempotencyEpoch: randomUUID() }),
      listBrowserAutomationSessions: () =>
        Promise.resolve({
          sessions: [
            {
              automationSessionId: sessionId,
              generation: 1,
              navigationEpoch: ++lists
            }
          ]
        }),
      invokeBrowserAutomationUntilTerminal: (request: (typeof requests)[number]) => {
        requests.push(request)
        if (requests.length % 2 === 1 || repeated) {
          if (transportError) {
            return Promise.reject(new ServerError(409, 'stale_navigation', 'Page navigated'))
          }
          return Promise.resolve({ operation: { state: 'failed', errorCode: 'stale_navigation' } })
        }
        return Promise.resolve({
          operation: { state: 'succeeded', result: { kind: 'evaluation', value: 'ready' } }
        })
      }
    } as unknown as AgentWorkspaceClient
    const parsed = parseBrowserAutomation(
      ['browser', 'eval', '--session-id', sessionId, '--expression', 'document.readyState'],
      '/private/session'
    )!
    assert.deepEqual(await runBrowserAutomation(client, parsed), {
      kind: 'evaluation',
      value: 'ready'
    })
    assert.equal(lists, 2)
    assert.deepEqual(
      requests.map((request) => request.navigationEpoch),
      [1, 2]
    )
    assert.notEqual(requests[0]!.operationId, requests[1]!.operationId)
    assert.notEqual(requests[0]!.idempotency.key, requests[1]!.idempotency.key)
    repeated = true
    await assert.rejects(runBrowserAutomation(client, parsed), /stale_navigation|Page navigated/)
    assert.equal(requests.length, 4)
    assert.equal(lists, 4)
  }
})

void test('browser eval failures include the page error and its stack', async () => {
  const sessionId = randomUUID()
  const pageError = {
    message: 'ReferenceError: nope is not defined',
    stack: 'ReferenceError: nope is not defined\n    at eval (test-page:1)'
  }
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: randomUUID() }),
    listBrowserAutomationSessions: () =>
      Promise.resolve({
        sessions: [
          {
            automationSessionId: sessionId,
            generation: 1,
            navigationEpoch: 0
          }
        ]
      }),
    invokeBrowserAutomationUntilTerminal: () =>
      Promise.resolve({
        operation: { state: 'failed', errorCode: 'evaluation_failed', error: pageError }
      })
  } as unknown as AgentWorkspaceClient
  await assert.rejects(
    runBrowserAutomation(
      client,
      parseBrowserAutomation(
        ['browser', 'eval', '--session-id', sessionId, '--expression', 'nope.x'],
        '/private/session'
      )!
    ),
    {
      message: `Browser operation failed: evaluation_failed\n${pageError.message}\n${pageError.stack}`
    }
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
          navigationEpoch: 0,
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
  let kind = 'screenshot'
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: randomUUID() }),
    listBrowserAutomationSessions: () => Promise.resolve({ sessions: [session] }),
    invokeBrowserAutomationUntilTerminal: () =>
      Promise.resolve({
        operation: { state: 'succeeded', result: { kind, handle } }
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
    assert.deepEqual(await runBrowserAutomation(client, parsed), {
      kind: 'screenshot',
      handle,
      output
    })
    assert.deepEqual(await readFile(output), png)
    assert.equal(released, 1)
    kind = 'recording'
    await runBrowserAutomation(client, parsed)
    assert.equal(released, 2)
    corrupt = true
    await assert.rejects(
      runBrowserAutomation(client, parsed),
      /Browser artifact content does not match/
    )
    assert.equal(released, 3)
    assert.deepEqual(await readFile(output), png)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

void test('agent controls parse semantic targets, waits, diagnostics and recording without JSON plumbing', () => {
  const parse = (tail: string[]) =>
    parseBrowserAutomation(
      ['browser', ...tail, '--session-id', 'session'],
      '/private/session'
    ) as Extract<ReturnType<typeof parseBrowserAutomation>, { command: 'browser.run' }>
  assert.deepEqual(
    parse(['type', '--role', 'textbox', '--name', 'Email', '--text', '', '--clear']).operation,
    { kind: 'typeText', locator: { role: 'textbox', name: 'Email' }, text: '', clear: true }
  )
  assert.deepEqual(parse(['press', '--key', 'a', '--modifiers', 'control,shift']).operation, {
    kind: 'key',
    key: 'a',
    modifiers: ['control', 'shift']
  })
  assert.deepEqual(parse(['press', '--key', 'Enter', '--text-target', 'Submit']).operation, {
    kind: 'keyAt',
    locator: { text: 'Submit' },
    key: 'Enter'
  })
  assert.deepEqual(parse(['wait', '--url', '/done', '--timeout-ms', '1000']).operation, {
    kind: 'wait',
    condition: { kind: 'url', includes: '/done' }
  })
  assert.equal(parse(['wait', '--text', 'Saved', '--timeout-ms', '1000']).timeoutMs, 1000)
  assert.deepEqual(parse(['scroll', '--delta-y', '-600']).operation, {
    kind: 'scroll',
    deltaX: 0,
    deltaY: -600
  })
  assert.deepEqual(parse(['appearance', '--theme', 'dark']).operation, {
    kind: 'appearance',
    colorScheme: 'dark'
  })
  assert.deepEqual(parse(['network', 'list', '--after', '0']).operation, {
    kind: 'networkList',
    after: 0
  })
  assert.deepEqual(parse(['network', 'body', '--request-id', 'request']).operation, {
    kind: 'networkBody',
    requestId: 'request'
  })
  assert.deepEqual(parse(['recording', 'start']).operation, {
    kind: 'recordingStart',
    width: 1280,
    height: 720
  })
  assert.equal(parse(['console', '--follow']).follow, true)
  assert.throws(() => parse(['click', '--selector', 'button', '--role', 'button']), /Choose/)
  assert.throws(() => parse(['press', '--key', 'a', '--modifiers', 'unknown']), /--modifiers/)
  assert.throws(() => parse(['wait', '--text', 'Saved', '--url', '/done']), /exactly one/)
  assert.throws(() => parse(['recording', 'stop']), /--output is required/)
})

void test('attach derives the owning window and delegates exact lifecycle binding to the provider', async () => {
  const tabId = randomUUID()
  const workspaceId = randomUUID()
  const windowId = randomUUID()
  const seen: unknown[] = []
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: randomUUID() }),
    stateSnapshot: () =>
      Promise.resolve({
        snapshot: {
          workspaces: [{ id: workspaceId, tabs: { [tabId]: { content: { kind: 'browser' } } } }],
          windowPlacements: [{ id: windowId, workspaceIds: [workspaceId] }]
        }
      }),
    createBrowserAutomationSession: (params: unknown) => {
      seen.push(params)
      return Promise.resolve({ session: {} })
    }
  } as unknown as AgentWorkspaceClient
  await runBrowserAutomation(
    client,
    parseBrowserAutomation(['browser', 'attach', '--tab-id', tabId], '/private/session')!
  )
  assert.equal((seen[0] as { attachWindowId: string }).attachWindowId, windowId)
  assert.equal((seen[0] as { attachTabId: string }).attachTabId, tabId)
  assert.equal((seen[0] as { mode: string }).mode, 'attach')
})

void test('diagnostic follow advances its cursor, clears once and stops without duplicate output', async () => {
  const controller = new AbortController()
  const session = { automationSessionId: 'session', generation: 1, navigationEpoch: 3 }
  const operations: Record<string, unknown>[] = []
  const emitted: unknown[] = []
  const client = {
    identify: () => Promise.resolve({ idempotencyEpoch: randomUUID() }),
    listBrowserAutomationSessions: () => Promise.resolve({ sessions: [session] }),
    invokeBrowserAutomationUntilTerminal: (params: { operation: Record<string, unknown> }) => {
      operations.push(params.operation)
      if (operations.length === 2) controller.abort()
      return Promise.resolve({
        operation: {
          state: 'succeeded',
          navigationEpoch: 3,
          result: {
            kind: 'console',
            entries: operations.length === 1 ? [{ sequence: 1 }] : [],
            cursor: 1
          }
        }
      })
    }
  } as unknown as AgentWorkspaceClient
  const parsed = parseBrowserAutomation(
    ['browser', 'console', '--session-id', 'session', '--follow', '--clear'],
    '/private/session'
  ) as Extract<ReturnType<typeof parseBrowserAutomation>, { command: 'browser.run' }>
  await followBrowserDiagnostics(client, parsed, controller.signal, (value) => {
    emitted.push(value)
  })
  assert.deepEqual(operations, [
    { kind: 'console', clear: true },
    { kind: 'console', clear: false, after: 1 }
  ])
  assert.deepEqual(emitted, [{ kind: 'console', entries: [{ sequence: 1 }], cursor: 1 }])
})
