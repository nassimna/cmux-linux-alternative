import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { layoutRequest, parseLayoutCommand, runLayoutCommand } from './layout-commands'

const epoch = randomUUID()
const layoutId = randomUUID()
const first = randomUUID()
const second = randomUUID()
const key = randomUUID()

function parse(args: string[]) {
  const parsed = parseLayoutCommand(args, '/private/session')
  assert.ok(parsed)
  return parsed
}

test('save preserves workspace order and exact idempotency identity', async () => {
  const command = parse([
    'layout', 'save', '--layout-id', layoutId, '--name', 'Review',
    '--workspace-id', second, '--workspace-id', first,
    '--expected-revision', '12', '--idempotency-key', key
  ])
  const expected = {
    layoutId, name: 'Review', workspaceIds: [second, first],
    expectedRevision: 12, idempotencyEpoch: epoch, idempotencyKey: key
  }
  assert.deepEqual(await layoutRequest(command, epoch), expected)
  const seen: unknown[] = []
  const client = {
    saveLayout: (request: unknown) => {
      seen.push(request)
      return Promise.resolve({ revision: 13 })
    }
  } as unknown as AgentWorkspaceClient
  assert.deepEqual(await runLayoutCommand(client, command, epoch), { revision: 13 })
  assert.deepEqual(seen, [expected])
})

test('delete and apply dispatch to their matching Node methods', async () => {
  for (const [verb, method] of [
    ['delete', 'deleteLayout'], ['apply', 'applyLayout']
  ] as const) {
    const command = parse([
      'layout', verb, '--layout-id', layoutId,
      '--expected-revision', '4', '--idempotency-key', key
    ])
    const seen: unknown[] = []
    const client = { [method]: (request: unknown) => {
      seen.push(request)
      return Promise.resolve({ revision: 5 })
    } } as unknown as AgentWorkspaceClient
    assert.deepEqual(await runLayoutCommand(client, command, epoch), { revision: 5 })
    assert.deepEqual(seen, [{ layoutId, expectedRevision: 4, idempotencyEpoch: epoch, idempotencyKey: key }])
  }
})

test('import reads one validated portable envelope before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-layout-cli-'))
  const path = join(root, 'layout.json')
  const paneId = randomUUID()
  const tabId = randomUUID()
  const envelope = {
    formatVersion: 1,
    name: 'Portable',
    template: { workspaces: [{
      id: first,
      name: 'Workspace',
      description: null,
      color: null,
      workingDirectory: '/tmp',
      layout: { kind: 'leaf', paneId },
      selectedPaneId: paneId,
      panes: { [paneId]: { id: paneId, tabs: [tabId], selectedTabId: tabId, title: null } },
      tabs: { [tabId]: {
        id: tabId,
        paneId,
        title: 'Shell',
        customTitle: null,
        content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } },
        createdAt: 1
      } },
      createdAt: 1,
      updatedAt: 1
    }] }
  }
  try {
    await writeFile(path, JSON.stringify(envelope))
    const command = parse([
      'layout', 'import', '--layout-id', layoutId, '--file', path,
      '--expected-revision', '9', '--idempotency-key', key
    ])
    const seen: unknown[] = []
    const client = {
      importLayout: (request: unknown) => {
        seen.push(request)
        return Promise.resolve({ revision: 10 })
      }
    } as unknown as AgentWorkspaceClient
    assert.deepEqual(await runLayoutCommand(client, command, epoch), { revision: 10 })
    assert.deepEqual(seen, [{
      layoutId, envelope, expectedRevision: 9, idempotencyEpoch: epoch, idempotencyKey: key
    }])
    await writeFile(path, '{')
    await assert.rejects(() => layoutRequest(command, epoch), /UTF-8 JSON envelope/)
    await writeFile(path, 'x'.repeat(256 * 1024 + 1))
    await assert.rejects(() => layoutRequest(command, epoch), /no larger than 256 KiB/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('layout flags reject incomplete and invalid save requests', async () => {
  assert.throws(() => parse(['layout', 'save', '--layout-id', layoutId, '--name', 'x', '--expected-revision', '1']), /--workspace-id is required/)
  assert.throws(() => parse(['layout', 'import', '--layout-id', layoutId, '--expected-revision', '1']), /--file is required/)
  await assert.rejects(() => layoutRequest(parse([
    'layout', 'save', '--layout-id', layoutId, '--name', 'x', '--workspace-id', first,
    '--workspace-id', first, '--expected-revision', '1'
  ]), epoch), /saved-layout workspace IDs must be unique/)
  await assert.rejects(() => layoutRequest(parse([
    'layout', 'delete', '--layout-id', layoutId, '--expected-revision', '1e3'
  ]), epoch), /--expected-revision must be a nonnegative safe integer/)
})
