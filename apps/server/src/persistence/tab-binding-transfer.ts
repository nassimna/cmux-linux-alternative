import type Database from 'better-sqlite3'

import { WindowMutationError } from '../domain/window-mutations'

interface TabPlacement {
  workspaceId: string
  paneId: string
  tabId: string
}

interface BindingRow {
  workspace_id: string
  pane_id: string
  tab_id: string
  revision: number
}

const MAX_REVISION = Number.MAX_SAFE_INTEGER

/** Closing a bound tab would leave a live catalog entry pointing at no tab. */
export function assertTabUnbound(database: Database.Database, tabId: string): void {
  const bound = database
    .prepare(
      `SELECT 1 FROM agent_sessions WHERE tab_id = ?
     UNION ALL SELECT 1 FROM remote_sessions WHERE tab_id = ? LIMIT 1`
    )
    .get(tabId, tabId)
  if (bound)
    throw new WindowMutationError('policy_denied', 'The tab is bound to an agent or remote session')
}

function requireExact(rows: readonly BindingRow[], source: TabPlacement): void {
  if (
    rows.some(
      (row) =>
        row.workspace_id !== source.workspaceId ||
        row.pane_id !== source.paneId ||
        row.tab_id !== source.tabId ||
        row.revision >= MAX_REVISION
    )
  )
    throw new WindowMutationError('policy_denied', 'A bound tab placement cannot be transferred')
}

/** Check every catalog record that would follow a durable tab move. */
export function assertTabBindingsTransferable(
  database: Database.Database,
  source: TabPlacement
): void {
  const agents = database
    .prepare('SELECT workspace_id, pane_id, tab_id, revision FROM agent_sessions WHERE tab_id = ?')
    .all(source.tabId) as BindingRow[]
  const remotes = database
    .prepare('SELECT workspace_id, pane_id, tab_id, revision FROM remote_sessions WHERE tab_id = ?')
    .all(source.tabId) as BindingRow[]
  requireExact(agents, source)
  requireExact(remotes, source)
  if (agents.length === 0) return

  const members = database
    .prepare(
      `SELECT target_workspace_id AS workspace_id, target_pane_id AS pane_id,
            target_tab_id AS tab_id, revision
     FROM agent_team_members
     WHERE target_agent_session_id IN (
       SELECT agent_session_id FROM agent_sessions WHERE tab_id = ?
     )`
    )
    .all(source.tabId) as BindingRow[]
  const attention = database
    .prepare(
      `SELECT workspace_id, pane_id, tab_id, revision FROM agent_attention
     WHERE agent_session_id IN (
       SELECT agent_session_id FROM agent_sessions WHERE tab_id = ?
     )`
    )
    .all(source.tabId) as BindingRow[]
  requireExact(members, source)
  requireExact(attention, source)
  const exhaustedTeam = database
    .prepare(
      `SELECT 1 FROM agent_teams WHERE revision >= ? AND team_id IN (
       SELECT team_id FROM agent_team_members WHERE target_agent_session_id IN (
         SELECT agent_session_id FROM agent_sessions WHERE tab_id = ?
       )
     ) LIMIT 1`
    )
    .get(MAX_REVISION, source.tabId)
  const catalog = database
    .prepare('SELECT revision FROM agent_catalog_state WHERE singleton = 1')
    .get() as { revision: number } | undefined
  if (exhaustedTeam || !catalog || catalog.revision >= MAX_REVISION)
    throw new WindowMutationError('resource_limit', 'Agent binding revision cannot advance')
}

/** Caller runs inside the same SQLite transaction as the durable tab snapshot. */
export function transferTabBindings(
  database: Database.Database,
  source: TabPlacement,
  target: Pick<TabPlacement, 'workspaceId' | 'paneId'>,
  now: number
): void {
  assertTabBindingsTransferable(database, source)
  if (source.workspaceId === target.workspaceId && source.paneId === target.paneId) return
  if (!Number.isSafeInteger(now) || now < 0)
    throw new WindowMutationError('policy_denied', 'Tab transfer timestamp is invalid')
  database
    .prepare(
      `UPDATE agent_sessions SET workspace_id = ?, pane_id = ?,
       revision = revision + 1, updated_at_ms = MAX(updated_at_ms, ?)
     WHERE tab_id = ?`
    )
    .run(target.workspaceId, target.paneId, now, source.tabId)
  database
    .prepare(
      `UPDATE remote_sessions SET workspace_id = ?, pane_id = ?,
       revision = revision + 1, updated_at_ms = MAX(updated_at_ms, ?)
     WHERE tab_id = ?`
    )
    .run(target.workspaceId, target.paneId, now, source.tabId)

  const agents = database
    .prepare('SELECT 1 FROM agent_sessions WHERE tab_id = ? LIMIT 1')
    .get(source.tabId)
  if (!agents) return
  database
    .prepare(
      `UPDATE agent_team_members SET target_workspace_id = ?, target_pane_id = ?,
       revision = revision + 1, updated_at_ms = MAX(updated_at_ms, ?)
     WHERE target_agent_session_id IN (
       SELECT agent_session_id FROM agent_sessions WHERE tab_id = ?
     )`
    )
    .run(target.workspaceId, target.paneId, now, source.tabId)
  database
    .prepare(
      `UPDATE agent_attention SET workspace_id = ?, pane_id = ?,
       revision = revision + 1, updated_at_ms = MAX(updated_at_ms, ?)
     WHERE agent_session_id IN (
       SELECT agent_session_id FROM agent_sessions WHERE tab_id = ?
     )`
    )
    .run(target.workspaceId, target.paneId, now, source.tabId)
  database
    .prepare(
      `UPDATE agent_teams SET revision = revision + 1,
       updated_at_ms = MAX(updated_at_ms, ?)
     WHERE team_id IN (
       SELECT team_id FROM agent_team_members WHERE target_agent_session_id IN (
         SELECT agent_session_id FROM agent_sessions WHERE tab_id = ?
       )
     )`
    )
    .run(now, source.tabId)
  database
    .prepare('UPDATE agent_catalog_state SET revision = revision + 1 WHERE singleton = 1')
    .run()
}
