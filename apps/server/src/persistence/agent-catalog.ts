import type Database from 'better-sqlite3'

import {
  agentCatalogGetResultSchema,
  agentCatalogListParamsSchema,
  agentCatalogListResultSchema
} from '@agent-workspace/contracts'

type Binding = {
  workspaceId: string
  paneId: string
  tabId: string
  agentSessionId: string
}

type SessionRow = {
  agent_session_id: string
  workspace_id: string
  pane_id: string
  tab_id: string
  adapter_id: string
  adapter_version: string
  title: string
  lifecycle: string
  restore_level: string
  restore_outcome: string | null
  hibernation_state: string | null
  has_terminated_disposition: number
  revision: number
  attempt_epoch: number
  evidence_epoch: number
  last_verified_at_ms: number
  forked_from_agent_session_id: string | null
  fork_artifact_kind: string | null
  fork_artifact_version: number | null
  fork_artifact_digest: string | null
}

type TeamRow = { team_id: string; title: string; revision: number }
type MemberRow = {
  member_id: string
  team_id: string
  role: string
  target_agent_session_id: string
  target_workspace_id: string
  target_pane_id: string
  target_tab_id: string
  parent_member_id: string | null
  revision: number
}
type AttentionRow = {
  agent_session_id: string
  workspace_id: string
  pane_id: string
  tab_id: string
  team_id: string | null
  member_id: string | null
  state: string
  revision: number
}

export class AgentCatalogError extends Error {
  public constructor(
    public readonly code: 'session_unavailable' | 'invalid_catalog',
    message: string
  ) {
    super(message)
    this.name = 'AgentCatalogError'
  }
}

function sessionBinding(row: SessionRow): Binding {
  return {
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    tabId: row.tab_id,
    agentSessionId: row.agent_session_id
  }
}

function memberBinding(row: MemberRow): Binding {
  return {
    workspaceId: row.target_workspace_id,
    paneId: row.target_pane_id,
    tabId: row.target_tab_id,
    agentSessionId: row.target_agent_session_id
  }
}

function attentionBinding(row: AttentionRow): Binding {
  return {
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    tabId: row.tab_id,
    agentSessionId: row.agent_session_id
  }
}

function exactBinding(left: Binding, right: Binding): boolean {
  return (
    left.agentSessionId === right.agentSessionId &&
    left.workspaceId === right.workspaceId &&
    left.paneId === right.paneId &&
    left.tabId === right.tabId
  )
}

/** Read-only schema-v15 projection. No adapter or live-process state is inferred. */
export class AgentCatalog {
  public constructor(private readonly database: Database.Database) {}

  public list(input: unknown) {
    agentCatalogListParamsSchema.parse(input)
    return this.database
      .transaction(() => {
        const revision = this.database
          .prepare('SELECT revision FROM agent_catalog_state WHERE singleton = 1')
          .get() as { revision: number } | undefined
        if (!revision)
          throw new AgentCatalogError('invalid_catalog', 'Agent catalog state is missing')
        const sessions = this.database
          .prepare(
            `
        SELECT agent_session_id, workspace_id, pane_id, tab_id, adapter_id, adapter_version,
          title, lifecycle, restore_level, restore_outcome, hibernation_state,
          EXISTS(SELECT 1 FROM agent_hibernation_dispositions d
            WHERE d.agent_session_id = s.agent_session_id) AS has_terminated_disposition,
          revision, attempt_epoch, evidence_epoch, last_verified_at_ms,
          forked_from_agent_session_id, fork_artifact_kind, fork_artifact_version,
          fork_artifact_digest
        FROM agent_sessions s ORDER BY created_at_ms, agent_session_id
      `
          )
          .all() as SessionRow[]
        const teams = this.database
          .prepare(
            'SELECT team_id, title, revision FROM agent_teams ORDER BY created_at_ms, team_id'
          )
          .all() as TeamRow[]
        const members = this.database
          .prepare(
            `
        SELECT member_id, team_id, role, target_agent_session_id, target_workspace_id,
          target_pane_id, target_tab_id, parent_member_id, revision
        FROM agent_team_members ORDER BY created_at_ms, member_id
      `
          )
          .all() as MemberRow[]
        const attention = this.database
          .prepare(
            `
        SELECT agent_session_id, workspace_id, pane_id, tab_id, team_id, member_id,
          state, revision FROM agent_attention ORDER BY agent_session_id
      `
          )
          .all() as AttentionRow[]
        this.validateBindings(sessions, teams, members, attention)
        const membership = new Map(
          members.map((member) => [member.target_agent_session_id, member])
        )
        return agentCatalogListResultSchema.parse({
          catalogVersion: 1,
          revision: revision.revision,
          sessions: sessions.map((row) => {
            const member = membership.get(row.agent_session_id)
            return {
              catalogVersion: 1,
              binding: sessionBinding(row),
              adapterId: row.adapter_id,
              adapterVersion: row.adapter_version,
              title: row.title,
              lifecycle: row.lifecycle,
              ...(row.has_terminated_disposition &&
              row.lifecycle === 'completed' &&
              row.hibernation_state === 'failed'
                ? { hibernationState: 'terminatedAfterWarning' }
                : row.hibernation_state
                  ? { hibernationState: row.hibernation_state }
                  : {}),
              restore: {
                level: row.restore_level,
                assessedAtMs: row.last_verified_at_ms,
                evidenceEpoch: row.evidence_epoch
              },
              ...(row.restore_outcome ? { lastRestoreOutcome: row.restore_outcome } : {}),
              revision: row.revision,
              attemptEpoch: row.attempt_epoch,
              lastVerifiedAtMs: row.last_verified_at_ms,
              ...(member ? { teamId: member.team_id, memberId: member.member_id } : {}),
              ...(row.forked_from_agent_session_id &&
              row.fork_artifact_kind &&
              row.fork_artifact_version &&
              row.fork_artifact_digest
                ? {
                    forkedFrom: {
                      provenanceVersion: 1,
                      forkedFromAgentSessionId: row.forked_from_agent_session_id,
                      artifact: {
                        version: row.fork_artifact_version,
                        kind: row.fork_artifact_kind,
                        digestSha256: row.fork_artifact_digest
                      }
                    }
                  }
                : {})
            }
          }),
          teams: teams.map((team) => ({
            teamId: team.team_id,
            title: team.title,
            revision: team.revision,
            members: members
              .filter((member) => member.team_id === team.team_id)
              .map((member) => ({
                memberId: member.member_id,
                role: member.role,
                target: memberBinding(member),
                ...(member.parent_member_id ? { parentMemberId: member.parent_member_id } : {}),
                revision: member.revision
              }))
          })),
          attention: attention.map((row) => ({
            target: {
              target: attentionBinding(row),
              ...(row.team_id && row.member_id
                ? { teamId: row.team_id, memberId: row.member_id }
                : {})
            },
            state: row.state,
            revision: row.revision
          }))
        })
      })
      .deferred()
  }

  public get(agentSessionId: string) {
    const catalog = this.list({ catalogVersion: 1 })
    const session = catalog.sessions.find((item) => item.binding.agentSessionId === agentSessionId)
    if (!session)
      throw new AgentCatalogError('session_unavailable', 'The agent session is unavailable')
    return agentCatalogGetResultSchema.parse({ session })
  }

  private validateBindings(
    sessions: SessionRow[],
    teams: TeamRow[],
    members: MemberRow[],
    attention: AttentionRow[]
  ): void {
    if (sessions.length > 512 || teams.length > 64 || attention.length > 512) {
      throw new AgentCatalogError('invalid_catalog', 'Agent catalog exceeds its limits')
    }
    const sessionMap = new Map(sessions.map((row) => [row.agent_session_id, sessionBinding(row)]))
    const teamIds = new Set(teams.map((team) => team.team_id))
    const memberMap = new Map(members.map((row) => [row.member_id, row]))
    const memberSessions = new Set<string>()
    const teamCounts = new Map<string, number>()
    for (const row of members) {
      const target = sessionMap.get(row.target_agent_session_id)
      if (
        !teamIds.has(row.team_id) ||
        !target ||
        !exactBinding(target, memberBinding(row)) ||
        memberSessions.has(row.target_agent_session_id)
      ) {
        throw new AgentCatalogError('invalid_catalog', 'Agent team member binding is invalid')
      }
      memberSessions.add(row.target_agent_session_id)
      const count = (teamCounts.get(row.team_id) ?? 0) + 1
      if (count > 64)
        throw new AgentCatalogError('invalid_catalog', 'Agent team exceeds member limit')
      teamCounts.set(row.team_id, count)
      const seen = new Set<string>()
      let cursor: string | null = row.member_id
      while (cursor) {
        if (seen.has(cursor))
          throw new AgentCatalogError('invalid_catalog', 'Agent team has a cycle')
        seen.add(cursor)
        const current: MemberRow | undefined = memberMap.get(cursor)
        if (!current || current.team_id !== row.team_id) {
          throw new AgentCatalogError('invalid_catalog', 'Agent team parent is invalid')
        }
        cursor = current.parent_member_id
      }
    }
    for (const row of attention) {
      const target = sessionMap.get(row.agent_session_id)
      if (!target || !exactBinding(target, attentionBinding(row))) {
        throw new AgentCatalogError('invalid_catalog', 'Agent attention binding is invalid')
      }
      if ((row.team_id === null) !== (row.member_id === null)) {
        throw new AgentCatalogError('invalid_catalog', 'Agent attention membership is incomplete')
      }
      if (row.member_id) {
        const member = memberMap.get(row.member_id)
        if (
          !member ||
          member.team_id !== row.team_id ||
          !exactBinding(memberBinding(member), attentionBinding(row))
        ) {
          throw new AgentCatalogError('invalid_catalog', 'Agent attention member is invalid')
        }
      }
    }
  }
}
