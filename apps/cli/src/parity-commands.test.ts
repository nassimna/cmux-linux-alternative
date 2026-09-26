import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { parseParityCommand, parityRequest, runParityCommand } from './parity-commands'

const epoch = randomUUID()
const key = randomUUID()
const workspaceId = randomUUID()
const paneId = randomUUID()
const tabId = randomUUID()

function parse(args: string[]) {
  const parsed = parseParityCommand(args, '/private/session')
  assert.ok(parsed)
  return parsed
}

test('close-selected preserves replacement defaults, revision, key, and command tail', async () => {
  const parsed = parse([
    'workspace',
    'close-selected',
    '--expected-revision',
    '12',
    '--idempotency-key',
    key,
    '--replacement-name',
    'Replacement',
    '--replacement-working-directory',
    '/tmp',
    '--replacement-command',
    'sh',
    '-l'
  ])
  const expected = {
    expectedRevision: 12,
    idempotencyEpoch: epoch,
    idempotencyKey: key,
    replacement: {
      name: 'Replacement',
      workingDirectory: '/tmp',
      initialTerminal: { cwd: '/tmp', rows: 24, cols: 80, command: ['sh', '-l'] }
    }
  }
  assert.deepEqual(parityRequest(parsed, epoch), expected)
  const seen: unknown[] = []
  const client = {
    closeSelectedWorkspaces: (request: unknown) => {
      seen.push(request)
      return Promise.resolve({ revision: 13 })
    }
  } as unknown as AgentWorkspaceClient
  await runParityCommand(client, parsed, epoch)
  assert.deepEqual(seen, [expected])
  assert.equal(
    'replacement' in
      parityRequest(parse(['workspace', 'close-selected', '--expected-revision', '2']), epoch),
    false
  )
})

test('pane split dispatches terminal, browser, and existing tab through validated requests', async () => {
  const base = [
    'pane',
    'split',
    '--workspace-id',
    workspaceId,
    '--target-pane-id',
    paneId,
    '--axis',
    'vertical',
    '--expected-revision',
    '3',
    '--idempotency-key',
    key
  ]
  const cases = [
    { tail: ['terminal', '--cwd', '/tmp', '--command', 'bash', '-l'], kind: 'newTerminal' },
    { tail: ['browser', '--url', 'https://example.com/'], kind: 'newBrowser' },
    { tail: ['existing-tab', '--tab-id', tabId], kind: 'existingTab' }
  ]
  const seen: unknown[] = []
  const client = {
    splitPane: (request: unknown) => {
      seen.push(request)
      return Promise.resolve({ revision: 4 })
    }
  } as unknown as AgentWorkspaceClient
  for (const { tail, kind } of cases) {
    const parsed = parse([...base, ...tail])
    const request = parityRequest(parsed, epoch)
    assert.equal('content' in request ? request.content.kind : undefined, kind)
    await runParityCommand(client, parsed, epoch)
    assert.deepEqual(seen.at(-1), request)
  }
})

test('action invoke uses exact correlation and idempotency fields', async () => {
  const correlationId = randomUUID()
  const parsed = parse([
    'action',
    'invoke',
    '--action-id',
    'workspace.card.pin',
    '--action-version',
    '1',
    '--parameters-json',
    '{}',
    '--idempotency-epoch',
    epoch,
    '--idempotency-key',
    key,
    '--correlation-id',
    correlationId
  ])
  const expected = {
    actionId: 'workspace.card.pin',
    actionVersion: 1,
    parameters: {},
    idempotency: { epoch, key },
    correlationId
  }
  assert.deepEqual(parityRequest(parsed), expected)
  const seen: unknown[] = []
  const client = {
    invokeAction: (request: unknown) => {
      seen.push(request)
      return Promise.resolve({ invocation: { state: 'acknowledged' } })
    }
  } as unknown as AgentWorkspaceClient
  await runParityCommand(client, parsed)
  assert.deepEqual(seen, [expected])
})

test('action cancel passes exact invocation and correlation identifiers', async () => {
  const invocationId = randomUUID()
  const correlationId = randomUUID()
  const parsed = parse([
    'action',
    'cancel',
    '--invocation-id',
    invocationId,
    '--correlation-id',
    correlationId
  ])
  const expected = { invocationId, correlationId }
  assert.deepEqual(parityRequest(parsed), expected)
  const seen: unknown[] = []
  const client = {
    cancelAction: (request: unknown) => {
      seen.push(request)
      return Promise.resolve({ invocation: { state: 'canceled' } })
    }
  } as unknown as AgentWorkspaceClient
  await runParityCommand(client, parsed)
  assert.deepEqual(seen, [expected])
  assert.throws(
    () => parse(['action', 'cancel', '--invocation-id', invocationId]),
    /correlation-id/
  )
  assert.throws(
    () =>
      parityRequest(
        parse(['action', 'cancel', '--invocation-id', 'wrong', '--correlation-id', correlationId])
      ),
    /invalid/i
  )
})

test('rejects incomplete replacement, invalid split, oversized and nonobject action parameters', () => {
  assert.throws(
    () =>
      parse(['workspace', 'close-selected', '--expected-revision', '1', '--replacement-name', 'X']),
    /supplied together/
  )
  assert.throws(
    () =>
      parse([
        'workspace',
        'close-selected',
        '--expected-revision',
        '1',
        '--replacement-rows',
        '24'
      ]),
    /require --replacement-name/
  )
  const base = [
    'pane',
    'split',
    '--workspace-id',
    workspaceId,
    '--target-pane-id',
    paneId,
    '--axis',
    'horizontal',
    '--expected-revision',
    '1',
    'existing-tab',
    '--tab-id',
    tabId
  ]
  assert.throws(
    () => parityRequest(parse([...base.slice(0, 8), '--ratio', '1', ...base.slice(8)]), epoch),
    /--ratio/
  )
  const action = [
    'action',
    'invoke',
    '--action-id',
    'workspace.card.pin',
    '--action-version',
    '1',
    '--idempotency-epoch',
    epoch
  ]
  assert.throws(() => parityRequest(parse([...action, '--parameters-json', '[]'])), /JSON object/)
  assert.throws(
    () => parityRequest(parse([...action, '--parameters-json', 'x'.repeat(64 * 1024 + 1)])),
    /64 KiB/
  )
  assert.throws(() => parse([...action, '--target-window-id', randomUUID()]), /required together/)
})
