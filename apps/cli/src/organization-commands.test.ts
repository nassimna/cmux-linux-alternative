import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import {
  organizationRequest,
  parseOrganizationCommand,
  runOrganizationCommand
} from './organization-commands'

const epoch = 'b31ab001-5435-4c98-9e7a-18442259e901'
const first = 'a9e87f23-84fd-412c-ab32-6ec11bacaa31'
const second = 'df6df812-d30f-4e8f-9ff9-d8637ecfd751'
const group = '641b0ef7-e547-491e-a7af-ec027a4abc62'
const key = '265f9a77-e32a-487e-adb6-59b9f44bd2d3'

function parse(args: string[]) {
  const parsed = parseOrganizationCommand(args, '/private/session')
  assert.ok(parsed)
  return parsed
}

test('multiselection keeps order and uses exact revision and retry key', async () => {
  const parsed = parse([
    'workspace', 'select-many', '--workspace-id', second, '--workspace-id', first,
    '--focused-workspace-id', first, '--expected-revision', '12', '--idempotency-key', key
  ])
  assert.deepEqual(organizationRequest(parsed, epoch), {
    selection: [second, first], focusedWorkspaceId: first,
    expectedRevision: 12, idempotencyEpoch: epoch, idempotencyKey: key
  })
  const seen: unknown[] = []
  const client = {
    selectWorkspaces: (request: unknown) => { seen.push(request); return Promise.resolve({ revision: 13 }) }
  } as unknown as AgentWorkspaceClient
  assert.deepEqual(await runOrganizationCommand(client, parsed, epoch), { revision: 13 })
  assert.deepEqual(seen, [organizationRequest(parsed, epoch)])
})

test('group assignment omits group ID to unassign and dispatches to Node client', async () => {
  const parsed = parse([
    'group', 'assign', '--workspace-id', first, '--expected-revision', '8', '--idempotency-key', key
  ])
  const seen: unknown[] = []
  const client = {
    assignGroup: (request: unknown) => { seen.push(request); return Promise.resolve({ revision: 9 }) }
  } as unknown as AgentWorkspaceClient
  await runOrganizationCommand(client, parsed, epoch)
  assert.deepEqual(seen, [{
    workspaceId: first, expectedRevision: 8, idempotencyEpoch: epoch, idempotencyKey: key
  }])
})

test('all group verbs dispatch through their matching client operation', async () => {
  const cases = [
    { verb: 'create', options: ['--group-id', group, '--name', 'Build'], method: 'createGroup' },
    { verb: 'rename', options: ['--group-id', group, '--name', 'Review'], method: 'renameGroup' },
    { verb: 'delete', options: ['--group-id', group], method: 'deleteGroup' },
    { verb: 'move', options: ['--group-id', group, '--destination-index', '0'], method: 'moveGroup' },
    { verb: 'assign', options: ['--workspace-id', first, '--group-id', group], method: 'assignGroup' },
    { verb: 'collapse', options: ['--group-id', group, '--collapsed', 'false'], method: 'collapseGroup' }
  ]
  for (const { verb, options, method } of cases) {
    const parsed = parse(['group', verb, ...options, '--expected-revision', '4', '--idempotency-key', key])
    const seen: unknown[] = []
    const client = { [method]: (request: unknown) => {
      seen.push(request)
      return Promise.resolve({ revision: 5 })
    } } as unknown as AgentWorkspaceClient
    assert.deepEqual(await runOrganizationCommand(client, parsed, epoch), { revision: 5 })
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], organizationRequest(parsed, epoch))
  }
})

test('group flags reject invalid booleans and revisions before sending', () => {
  assert.throws(() => parse(['group', 'create', '--group-id', group, '--expected-revision', '1']), /--name is required/)
  assert.throws(() => parse(['workspace', 'select-many', '--focused-workspace-id', first, '--expected-revision', '1']), /--workspace-id is required/)
  assert.throws(() => organizationRequest(parse([
    'group', 'collapse', '--group-id', group, '--collapsed', 'yes', '--expected-revision', '1'
  ]), epoch), /--collapsed must be true or false/)
  assert.throws(() => organizationRequest(parse([
    'group', 'move', '--group-id', group, '--destination-index', '1e3', '--expected-revision', '1'
  ]), epoch), /--destination-index must be a nonnegative safe integer/)
  assert.throws(() => organizationRequest(parse([
    'workspace', 'select-many', '--workspace-id', first, '--workspace-id', first,
    '--focused-workspace-id', first, '--expected-revision', '1'
  ]), epoch), /workspace selection must be unique/)
  assert.throws(() => organizationRequest(parse([
    'group', 'delete', '--group-id', group, '--expected-revision', '-1'
  ]), epoch), /--expected-revision must be a nonnegative safe integer/)
})
