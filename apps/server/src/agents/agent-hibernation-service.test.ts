import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'

import { codexCheckpoint } from './codex-checkpoint'
import { AgentHibernationService } from './agent-hibernation-service'
import type { WorkspaceTerminalRuntime } from '../domain/workspace-terminal-runtime'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { AgentCatalog } from '../persistence/agent-catalog'
import { NATIVE_SCHEMA_SQL } from '../persistence/native-schema'

const databases: Database.Database[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture(
  exactTerminal: () => string | undefined,
  beforeCheckpoint?: () => void,
  checkpointAvailable = true
) {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(NATIVE_SCHEMA_SQL)
  const agentSessionId = randomUUID()
  const provider = { providerId: randomUUID(), providerEpoch: 1, leaseId: randomUUID() }
  const window = { windowId: randomUUID(), windowGeneration: 1 }
  database.prepare('INSERT INTO agent_catalog_state (singleton, revision) VALUES (1, 0)').run()
  database
    .prepare(
      `INSERT INTO agent_sessions (
      agent_session_id, workspace_id, pane_id, tab_id, adapter_id, adapter_version,
      title, lifecycle, durable_intent, restore_level, revision, attempt_epoch,
      evidence_epoch, last_verified_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'codex', '0.156.1', 'test session', 'running', 'none',
      'toolResume', 1, 1, 1, 1, 1, 1)`
    )
    .run(agentSessionId, randomUUID(), randomUUID(), randomUUID())
  let now = 1000
  const detachAgentTerminal = vi.fn().mockResolvedValue({ revision: 2, terminationFailures: [] })
  const service = new AgentHibernationService(
    database,
    {} as ApplicationStateStore,
    { detachAgentTerminal } as unknown as WorkspaceTerminalRuntime,
    { current: () => true },
    exactTerminal,
    async () => {
      beforeCheckpoint?.()
      return checkpointAvailable ? codexCheckpoint(agentSessionId, now) : undefined
    },
    () => now
  )
  return {
    database,
    service,
    detachAgentTerminal,
    agentSessionId,
    provider,
    window,
    setNow: (value: number) => {
      now = value
    },
    preflight: {
      agentSessionId,
      challenge: { choice: 'terminateAfterWarning' as const, provider, window },
      operation: {
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        sessionRevision: 1,
        attemptEpoch: 1
      }
    }
  }
}

it('hibernates only after a fresh verified Codex thread and exact PTY exit', async () => {
  const terminalId = randomUUID()
  const setup = fixture(() => terminalId)
  setup.database
    .prepare(
      `INSERT INTO agent_hibernation_dispositions
     (agent_session_id, confirmation_id, outcome, disposed_at_ms)
     VALUES (?, ?, 'terminatedAfterWarning', 1)`
    )
    .run(setup.agentSessionId, randomUUID())
  const preflight = await setup.service.preflight(setup.preflight)
  expect(preflight).toMatchObject({
    state: 'confirmationRequired',
    checkpoint: { kind: 'codex-thread-v1', sizeBytes: 16 }
  })
  setup.setNow(1010)
  const row = setup.database
    .prepare('SELECT revision, attempt_epoch FROM agent_sessions')
    .get() as {
    revision: number
    attempt_epoch: number
  }
  const result = await setup.service.confirm({
    agentSessionId: setup.agentSessionId,
    confirmationId: preflight.confirmationId,
    choice: 'terminateAfterWarning',
    provider: setup.provider,
    window: setup.window,
    nonce: preflight.challenge.nonce,
    expiresAtMs: preflight.challenge.expiresAtMs,
    operation: {
      idempotencyKey: randomUUID(),
      requestHash: 'b'.repeat(64),
      sessionRevision: row.revision,
      attemptEpoch: row.attempt_epoch
    }
  })
  expect(result).toEqual({ state: 'hibernated' })
  expect(setup.detachAgentTerminal).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ agentSessionId: setup.agentSessionId }),
    terminalId
  )
  expect(
    setup.database
      .prepare('SELECT lifecycle, restore_level, hibernation_state FROM agent_sessions')
      .get()
  ).toMatchObject({
    lifecycle: 'hibernated',
    restore_level: 'toolResume',
    hibernation_state: 'hibernated'
  })
  expect(new AgentCatalog(setup.database).get(setup.agentSessionId).session.hibernationState).toBe(
    'hibernated'
  )
})

it('releases an expired confirmation without terminating the live PTY, then permits retry', async () => {
  const setup = fixture(() => 'terminal-1')
  const preflight = await setup.service.preflight(setup.preflight)
  setup.setNow(preflight.challenge.expiresAtMs + 1)
  const row = setup.database
    .prepare('SELECT revision, attempt_epoch FROM agent_sessions')
    .get() as {
    revision: number
    attempt_epoch: number
  }
  await expect(
    setup.service.confirm({
      agentSessionId: setup.agentSessionId,
      confirmationId: preflight.confirmationId,
      choice: 'terminateAfterWarning',
      provider: setup.provider,
      window: setup.window,
      nonce: preflight.challenge.nonce,
      expiresAtMs: preflight.challenge.expiresAtMs,
      operation: {
        idempotencyKey: randomUUID(),
        requestHash: 'b'.repeat(64),
        sessionRevision: row.revision,
        attemptEpoch: row.attempt_epoch
      }
    })
  ).rejects.toThrow('Hibernation confirmation expired')
  expect(setup.detachAgentTerminal).not.toHaveBeenCalled()
  const released = setup.database
    .prepare('SELECT lifecycle, hibernation_state, checkpoint_kind, revision FROM agent_sessions')
    .get() as {
    lifecycle: string
    hibernation_state: string | null
    checkpoint_kind: string | null
    revision: number
  }
  expect(released).toMatchObject({
    lifecycle: 'running',
    hibernation_state: null,
    checkpoint_kind: null
  })
  const retry = await setup.service.preflight({
    ...setup.preflight,
    operation: {
      ...setup.preflight.operation,
      idempotencyKey: randomUUID(),
      sessionRevision: released.revision
    }
  })
  expect(retry.state).toBe('confirmationRequired')
})

it('records a second explicit no-checkpoint termination for a restored session', async () => {
  const setup = fixture(() => 'terminal-1', undefined, false)
  const priorConfirmationId = randomUUID()
  setup.database
    .prepare(
      `INSERT INTO agent_hibernation_dispositions
       (agent_session_id, confirmation_id, outcome, disposed_at_ms)
       VALUES (?, ?, 'terminatedAfterWarning', 1)`
    )
    .run(setup.agentSessionId, priorConfirmationId)
  const preflight = await setup.service.preflight(setup.preflight)
  expect(preflight.checkpoint).toBeUndefined()
  const row = setup.database
    .prepare('SELECT revision, attempt_epoch FROM agent_sessions')
    .get() as {
    revision: number
    attempt_epoch: number
  }
  const result = await setup.service.confirm({
    agentSessionId: setup.agentSessionId,
    confirmationId: preflight.confirmationId,
    choice: 'terminateAfterWarning',
    provider: setup.provider,
    window: setup.window,
    nonce: preflight.challenge.nonce,
    expiresAtMs: preflight.challenge.expiresAtMs,
    operation: {
      idempotencyKey: randomUUID(),
      requestHash: 'b'.repeat(64),
      sessionRevision: row.revision,
      attemptEpoch: row.attempt_epoch
    }
  })
  expect(result.state).toBe('terminatedAfterWarning')
  expect(
    setup.database
      .prepare(
        'SELECT confirmation_id FROM agent_hibernation_dispositions WHERE agent_session_id = ?'
      )
      .get(setup.agentSessionId)
  ).toMatchObject({ confirmation_id: preflight.confirmationId })
})

it('rejects a terminal ownership change during checkpoint verification', async () => {
  const firstTerminal = randomUUID()
  let terminal = firstTerminal
  // The injected provider evidence can complete after the terminal owner changes.
  const setup = fixture(
    () => terminal,
    () => {
      terminal = randomUUID()
    }
  )
  await expect(setup.service.preflight(setup.preflight)).rejects.toThrow(
    'The exact terminal binding is not live'
  )
  expect(setup.database.prepare('SELECT lifecycle FROM agent_sessions').get()).toMatchObject({
    lifecycle: 'running'
  })
})
