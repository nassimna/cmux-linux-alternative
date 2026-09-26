import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'

import {
  assertTabBindingsTransferable,
  assertTabUnbound,
  transferTabBindings
} from './tab-binding-transfer'

const databases: Database.Database[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture() {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(`
    CREATE TABLE agent_sessions (
      agent_session_id TEXT PRIMARY KEY, workspace_id TEXT, pane_id TEXT, tab_id TEXT,
      revision INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE agent_team_members (
      member_id TEXT PRIMARY KEY, team_id TEXT, target_agent_session_id TEXT,
      target_workspace_id TEXT, target_pane_id TEXT, target_tab_id TEXT,
      revision INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE agent_attention (
      agent_session_id TEXT PRIMARY KEY, workspace_id TEXT, pane_id TEXT, tab_id TEXT,
      revision INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE agent_teams (team_id TEXT PRIMARY KEY, revision INTEGER, updated_at_ms INTEGER);
    CREATE TABLE agent_catalog_state (singleton INTEGER PRIMARY KEY, revision INTEGER);
    CREATE TABLE remote_sessions (
      remote_session_id TEXT PRIMARY KEY, workspace_id TEXT, pane_id TEXT, tab_id TEXT,
      revision INTEGER, updated_at_ms INTEGER
    );
    INSERT INTO agent_catalog_state VALUES (1, 4);
    INSERT INTO agent_sessions VALUES ('agent', 'source', 'source-pane', 'tab', 2, 1);
    INSERT INTO agent_team_members VALUES
      ('member', 'team', 'agent', 'source', 'source-pane', 'tab', 3, 1);
    INSERT INTO agent_attention VALUES ('agent', 'source', 'source-pane', 'tab', 2, 1);
    INSERT INTO agent_teams VALUES ('team', 3, 1);
    INSERT INTO remote_sessions VALUES ('remote', 'source', 'source-pane', 'tab', 5, 1);
  `)
  return database
}

const source = { workspaceId: 'source', paneId: 'source-pane', tabId: 'tab' }
const target = { workspaceId: 'target', paneId: 'target-pane' }

it('rebinds agent, team, attention, and remote records in one transaction', () => {
  const database = fixture()
  database.transaction(() => transferTabBindings(database, source, target, 10))()
  const row = (table: string) =>
    database.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>
  expect(row('agent_sessions')).toMatchObject({
    workspace_id: 'target',
    pane_id: 'target-pane',
    revision: 3
  })
  expect(row('agent_team_members')).toMatchObject({
    target_workspace_id: 'target',
    target_pane_id: 'target-pane',
    revision: 4
  })
  expect(row('agent_attention')).toMatchObject({
    workspace_id: 'target',
    pane_id: 'target-pane',
    revision: 3
  })
  expect(row('remote_sessions')).toMatchObject({
    workspace_id: 'target',
    pane_id: 'target-pane',
    revision: 6
  })
  expect(row('agent_teams').revision).toBe(4)
  expect(row('agent_catalog_state').revision).toBe(5)
})

it('rejects mismatched durable bindings without changing the catalog', () => {
  const database = fixture()
  database
    .prepare("UPDATE remote_sessions SET pane_id = 'other' WHERE remote_session_id = 'remote'")
    .run()
  expect(() =>
    database.transaction(() => transferTabBindings(database, source, target, 10))()
  ).toThrow('bound tab placement')
  expect(
    (database.prepare('SELECT workspace_id FROM agent_sessions').get() as { workspace_id: string })
      .workspace_id
  ).toBe('source')
  expect(() => assertTabBindingsTransferable(database, source)).toThrow('bound tab placement')
})

it('keeps bound tabs out of the generic close path', () => {
  const database = fixture()
  expect(() => assertTabUnbound(database, source.tabId)).toThrow(
    'The tab is bound to an agent or remote session'
  )
  expect(() => assertTabUnbound(database, 'ordinary-tab')).not.toThrow()
})
