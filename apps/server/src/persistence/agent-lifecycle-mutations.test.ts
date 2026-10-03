import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'

import { AgentLifecycleMutations } from './agent-lifecycle-mutations'
import { NATIVE_SCHEMA_SQL } from './native-schema'
import { codexCheckpoint } from '../agents/codex-checkpoint'

const databases: Database.Database[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture(lifecycle = 'created', hibernationState: string | null = null) {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(NATIVE_SCHEMA_SQL)
  const agentSessionId = randomUUID()
  database.prepare('INSERT INTO agent_catalog_state (singleton, revision) VALUES (1, 0)').run()
  database
    .prepare(
      `INSERT INTO agent_sessions (
      agent_session_id, workspace_id, pane_id, tab_id, adapter_id, adapter_version,
      title, lifecycle, durable_intent, restore_level, hibernation_state,
      revision, attempt_epoch, evidence_epoch, last_verified_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'codex', '0.156.1', 'test session', ?, 'launch', 'unavailable',
      ?, 1, 1, 1, 1, 1, 1)`
    )
    .run(agentSessionId, randomUUID(), randomUUID(), randomUUID(), lifecycle, hibernationState)
  return {
    database,
    request: {
      agentSessionId,
      operation: {
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        sessionRevision: 1,
        attemptEpoch: 1
      }
    }
  }
}

it('marks a sealed resumed session running only after the resume completes', async () => {
  const { database, request } = fixture()
  let live = false
  const resume = vi.fn(async () => {
    live = true
  })
  const mutations = new AgentLifecycleMutations(
    database,
    {
      live: () => live,
      canResume: async () => true,
      resume
    },
    () => 10
  )
  const result = await mutations.restore(request)
  expect(resume).toHaveBeenCalledOnce()
  expect(result).toMatchObject({ outcome: 'resumed', session: { lifecycle: 'running' } })
  expect(database.prepare('SELECT lifecycle FROM agent_sessions').get()).toMatchObject({
    lifecycle: 'running'
  })
})

it('does not mark an exited resumed terminal running', async () => {
  const { database, request } = fixture()
  const mutations = new AgentLifecycleMutations(
    database,
    { live: () => false, canResume: async () => true, resume: async () => undefined },
    () => 10
  )
  await expect(mutations.restore(request)).rejects.toThrow('The resumed terminal is not live')
  expect(database.prepare('SELECT lifecycle FROM agent_sessions').get()).not.toMatchObject({
    lifecycle: 'running'
  })
})

it('tool-resumes a hibernated thread after its short checkpoint consent proof expires', async () => {
  const { database, request } = fixture('hibernated', 'hibernated')
  const checkpoint = codexCheckpoint(request.agentSessionId, 1)
  database
    .prepare(
      `UPDATE agent_sessions SET checkpoint_kind = ?, checkpoint_version = 1,
     checkpoint_digest = ?, checkpoint_verified_at_ms = ?, checkpoint_expires_at_ms = ?`
    )
    .run(checkpoint.kind, checkpoint.digestSha256, checkpoint.createdAtMs, checkpoint.expiresAtMs)
  let live = false
  const mutations = new AgentLifecycleMutations(
    database,
    {
      live: () => live,
      canResume: async () => true,
      resume: async () => {
        live = true
      }
    },
    () => 100_000
  )
  expect(await mutations.restore(request)).toMatchObject({
    outcome: 'resumed',
    session: { lifecycle: 'running' }
  })
  expect(
    database.prepare('SELECT checkpoint_kind, hibernation_state FROM agent_sessions').get()
  ).toMatchObject({ checkpoint_kind: null, hibernation_state: null })
})

it('synchronizes a verified live reattachment and refuses an active hibernation', async () => {
  const { database, request } = fixture()
  const mutations = new AgentLifecycleMutations(
    database,
    {
      live: () => true,
      canResume: async () => false
    },
    () => 10
  )
  expect(await mutations.restore(request)).toMatchObject({
    outcome: 'liveReattached',
    session: { lifecycle: 'running' }
  })

  const pending = fixture('running', 'confirmationRequired')
  const pendingMutations = new AgentLifecycleMutations(
    pending.database,
    {
      live: () => true,
      canResume: async () => false
    },
    () => 10
  )
  await expect(pendingMutations.restore(pending.request)).rejects.toThrow(
    'Agent hibernation is in progress'
  )
})
