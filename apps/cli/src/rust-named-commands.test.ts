import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import {
  parseRustNamedCommand,
  runRustNamedCommand,
  rustNamedNeedsWindowCapability
} from './rust-named-commands'

function parse(args: string[]) {
  const parsed = parseRustNamedCommand(args, '/private/session')
  assert.ok(parsed)
  return parsed
}

void test('Rust agent team command validates the DTO before dispatch', async () => {
  const request = {
    teamId: randomUUID(),
    title: 'Review team',
    mutation: {
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
      expectedCatalogRevision: 2
    }
  }
  const seen: unknown[] = []
  const client = {
    createAgentTeam: (value: unknown) => {
      seen.push(value)
      return Promise.resolve({})
    }
  } as unknown as AgentWorkspaceClient
  const command = parse(['agent', 'team-create', '--params-json', JSON.stringify(request)])
  assert.equal(command.capability, 'agent.team.create')
  await runRustNamedCommand(client, command)
  assert.deepEqual(seen, [request])
  assert.throws(() =>
    runRustNamedCommand(client, { ...command, params: { ...request, sshOption: 'unsafe' } })
  )
  assert.equal(seen.length, 1)
})

void test('Rust remote target creation rejects extra SSH options', async () => {
  const request = {
    remoteTargetId: randomUUID(),
    label: 'Development',
    host: 'example.test',
    port: 22,
    user: 'nassim',
    mutation: {
      idempotencyKey: randomUUID(),
      requestHash: 'b'.repeat(64),
      expectedRevision: 0
    }
  }
  const seen: unknown[] = []
  const client = {
    createRemoteTarget: (value: unknown) => {
      seen.push(value)
      return Promise.resolve({})
    }
  } as unknown as AgentWorkspaceClient
  const command = parse(['remote', 'target-create', '--params-json', JSON.stringify(request)])
  await runRustNamedCommand(client, command)
  assert.deepEqual(seen, [request])
  assert.throws(() =>
    runRustNamedCommand(client, { ...command, params: { ...request, sshOption: 'ProxyCommand=x' } })
  )
  assert.equal(seen.length, 1)
})

void test('Rust hibernation cancel uses the operation identity contract', async () => {
  const request = {
    agentSessionId: randomUUID(),
    operation: {
      idempotencyKey: randomUUID(),
      requestHash: 'c'.repeat(64),
      sessionRevision: 1,
      attemptEpoch: 1
    }
  }
  const seen: unknown[] = []
  const client = {
    cancelAgentHibernation: (value: unknown) => {
      seen.push(value)
      return Promise.resolve({ state: 'canceled' })
    }
  } as unknown as AgentWorkspaceClient
  const command = parse(['agent', 'hibernate-cancel', '--params-json', JSON.stringify(request)])
  assert.equal(command.capability, 'agent.hibernate.cancel')
  await runRustNamedCommand(client, command)
  assert.deepEqual(seen, [request])
})

void test('named sidebar restore requires the private window capability', () => {
  const command = parse(['sidebar', 'recently-closed-list', '--params-json', '{"limit":10}'])
  assert.equal(rustNamedNeedsWindowCapability(command.capability), true)
  assert.throws(() => runRustNamedCommand({} as AgentWorkspaceClient, command), /Window capability/)
  assert.throws(() => parse(['agent', 'team-create', '--ssh-option', 'x']))
})
