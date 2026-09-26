import { lstatSync } from 'node:fs'

import Database from 'better-sqlite3'

import { taskListParamsSchema, taskListResultSchema } from '@agent-workspace/protocol-client'
import { readLegacySnapshotConnection } from '../persistence/legacy-state-reader'
import { AgentCatalog } from '../persistence/agent-catalog'
import { RemoteCatalog } from '../persistence/remote-catalog'

const MAX_REMOTE_SESSIONS = 256
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type Task = (typeof taskListResultSchema)['_output']['tasks'][number]
type Agent = ReturnType<AgentCatalog['list']>['sessions'][number]
type Remote = ReturnType<RemoteCatalog['listSessions']>['sessions'][number]

/** Supplied by the private Electron owner channel, never from task.list request JSON. */
export interface TaskBoundWindow {
  windowId: string
  isCurrent(): boolean
}
export interface TaskProviderAvailability {
  agents: boolean
  remotes: boolean
}
export class TaskCatalogError extends Error {
  constructor(
    public readonly code:
      'invalid_params' | 'unauthorized' | 'cancelled' | 'resource_limit' | 'invalid_state',
    message: string
  ) {
    super(message)
    this.name = 'TaskCatalogError'
  }
}
function fail(code: TaskCatalogError['code'], message: string): never {
  throw new TaskCatalogError(code, message)
}
function agentLifecycle(session: Agent, disposition: string): Task['lifecycle'] {
  switch (session.lifecycle) {
    case 'created':
    case 'launching':
      return 'created'
    case 'running':
    case 'waiting':
    case 'checkpointing':
      return 'running'
    case 'hibernated':
      return 'detached'
    case 'completed':
      if (disposition === 'taskCancelled') return 'cancelled'
      if (disposition === 'taskTerminated' || disposition === 'taskForceTerminated')
        return 'terminated'
      return 'succeeded'
    case 'failed':
    case 'unavailable':
      return 'failed'
  }
}
function remoteLifecycle(session: Remote): Task['lifecycle'] {
  switch (session.state) {
    case 'created':
    case 'trustRequired':
    case 'credentialRequired':
    case 'connecting':
    case 'reconnecting':
      return 'created'
    case 'connected':
      return 'running'
    case 'detached':
      return 'detached'
    case 'failed':
      return 'failed'
    case 'closed':
      return 'terminated'
  }
}
function agentTask(session: Agent, disposition: string): Task {
  return {
    target: {
      sessionId: session.binding.agentSessionId,
      generation: session.attemptEpoch,
      revision: session.revision
    },
    kind: 'agent',
    label: session.title,
    lifecycle: agentLifecycle(session, disposition),
    observation: session.lastVerifiedAtMs > 0 ? 'lastVerified' : 'unknown',
    ownerLabel: 'Agent',
    resourceSummary: null
  }
}
function remoteTask(session: Remote): Task {
  return {
    target: {
      sessionId: session.remoteSessionId,
      generation: session.attemptGeneration,
      revision: session.revision
    },
    kind: 'remoteSession',
    label: 'Remote session',
    lifecycle: remoteLifecycle(session),
    observation: session.observation,
    ownerLabel: 'Remote',
    resourceSummary: null
  }
}

/** Read-only task.list projection; caller supplies a live, server-validated window resolver. */
export class TaskCatalog {
  private readonly database: Database.Database
  private readonly agents: AgentCatalog
  private readonly remotes: RemoteCatalog

  constructor(
    databasePath: string,
    private readonly providers: TaskProviderAvailability
  ) {
    const file = lstatSync(databasePath)
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
      throw new TaskCatalogError('invalid_state', 'Task database must be a private regular file')
    }
    this.database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000
    })
    try {
      this.database.pragma('query_only = ON')
      readLegacySnapshotConnection(this.database)
    } catch (error) {
      this.database.close()
      throw error
    }
    this.agents = new AgentCatalog(this.database)
    this.remotes = new RemoteCatalog(this.database, Date.now)
  }

  close(): void {
    this.database.close()
  }

  list(
    input: unknown,
    binding: TaskBoundWindow,
    signal?: AbortSignal
  ): ReturnType<typeof taskListResultSchema.parse> {
    const parsed = taskListParamsSchema.safeParse(input)
    if (!parsed.success) fail('invalid_params', 'Task list parameters are invalid')
    const params = parsed.data
    const checkCancelled = () => {
      if (signal?.aborted) fail('cancelled', 'The task list was cancelled')
    }
    return this.database
      .transaction(() => {
        checkCancelled()
        if (!binding.isCurrent() || !UUID.test(binding.windowId))
          fail('unauthorized', 'Bound window is unavailable')
        const state = readLegacySnapshotConnection(this.database)
        if (!state.windowPlacements.some((window) => window.id === binding.windowId)) {
          fail('unauthorized', 'Bound window is no longer present')
        }
        // Rust validates the complete agent catalog and pages the full remote catalog even when
        // their providers are unavailable; only presentation of rows is provider-gated.
        const catalog = this.agents.list({ catalogVersion: 1 })
        const dispositions = this.database
          .prepare(
            `SELECT s.agent_session_id, s.durable_intent,
        d.disposition FROM agent_sessions s LEFT JOIN agent_task_dispositions d
        ON d.agent_session_id = s.agent_session_id
          AND d.attempt_epoch = s.attempt_epoch AND d.completed_revision = s.revision`
          )
          .all() as Array<{
          agent_session_id: string
          durable_intent: string
          disposition: string | null
        }>
        const intent = new Map(
          dispositions.map((row) => [row.agent_session_id, row.disposition ?? row.durable_intent])
        )
        const tasks: Task[] = []
        if (this.providers.agents) {
          for (const session of catalog.sessions) {
            checkCancelled()
            const disposition = intent.get(session.binding.agentSessionId)
            if (disposition === undefined)
              fail('invalid_state', 'Agent task disposition is unavailable')
            tasks.push(agentTask(session, disposition))
          }
        }
        let cursor: string | undefined
        let remoteCount = 0
        for (;;) {
          checkCancelled()
          const page = this.remotes.listSessions({ limit: 128, ...(cursor ? { cursor } : {}) })
          remoteCount += page.sessions.length
          if (remoteCount > MAX_REMOTE_SESSIONS)
            fail('resource_limit', 'Task registry exceeds its fixed bound')
          if (this.providers.remotes) {
            for (const session of page.sessions) {
              checkCancelled()
              tasks.push(remoteTask(session))
            }
          }
          if (!page.nextCursor) break
          cursor = page.nextCursor
        }
        tasks.sort((left, right) =>
          left.target.sessionId < right.target.sessionId
            ? -1
            : left.target.sessionId > right.target.sessionId
              ? 1
              : 0
        )
        const filtered = tasks.filter(
          (task) =>
            (params.cursor === undefined || task.target.sessionId > params.cursor) &&
            (params.kind === undefined || task.kind === params.kind) &&
            (params.lifecycle === undefined || task.lifecycle === params.lifecycle)
        )
        const hasMore = filtered.length > params.limit
        const page = filtered.slice(0, params.limit)
        checkCancelled()
        if (!binding.isCurrent()) fail('unauthorized', 'Bound window is unavailable')
        return taskListResultSchema.parse({
          tasks: page,
          nextCursor: hasMore ? page[page.length - 1]!.target.sessionId : null
        })
      })
      .deferred()
  }
}
