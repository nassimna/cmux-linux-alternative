import { lstatSync } from 'node:fs'

import Database from 'better-sqlite3'
import type {
  AgentAttentionSetParams,
  AgentAttentionSetResult
} from '@agent-workspace/protocol-client'

import { readLegacySnapshotConnection } from './legacy-state-reader'

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const HASH = /^[0-9a-f]{64}$/u

type Namespace =
  | 'teamCreate'
  | 'teamUpdate'
  | 'teamDelete'
  | 'memberCreate'
  | 'memberUpdate'
  | 'memberMove'
  | 'memberDelete'
type TerminalCode =
  'applied' | 'staleCatalog' | 'staleTeam' | 'staleMember' | 'resourceLimit' | 'dependencyConflict'

export interface CatalogMutationIdentity {
  idempotencyKey: string
  requestHash: string
  expectedCatalogRevision: number
}
export interface TeamMutationIdentity extends CatalogMutationIdentity {
  expectedTeamRevision: number
}
export interface MemberMutationIdentity extends TeamMutationIdentity {
  expectedMemberRevision: number
}
export interface SessionBinding {
  workspaceId: string
  paneId: string
  tabId: string
  agentSessionId: string
}
export interface TeamCreateRequest {
  teamId: string
  title: string
  mutation: CatalogMutationIdentity
}
export interface TeamUpdateRequest {
  teamId: string
  title: string
  mutation: TeamMutationIdentity
}
export interface TeamDeleteRequest {
  teamId: string
  mutation: TeamMutationIdentity
}
export interface TeamRecord {
  teamId: string
  title: string
  revision: number
}
export interface TeamDeleteRecord {
  teamId: string
  catalogRevision: number
  deletedTeamRevision: number
}
export interface MemberRecord {
  memberId: string
  teamId: string
  role: string
  target: SessionBinding
  parentMemberId?: string
  revision: number
}
export interface MemberDeleteRecord {
  teamId: string
  memberId: string
  catalogRevision: number
  teamRevision: number
  deletedMemberRevision: number
}
export interface MemberCreateRequest {
  teamId: string
  memberId: string
  role: string
  target: SessionBinding
  parentMemberId?: string | undefined
  mutation: TeamMutationIdentity
}
export interface MemberUpdateRequest {
  teamId: string
  memberId: string
  role: string
  parentMemberId?: string | undefined
  mutation: MemberMutationIdentity
}
export interface MemberMoveRequest {
  teamId: string
  memberId: string
  target: SessionBinding
  mutation: MemberMutationIdentity
}
export interface MemberDeleteRequest {
  teamId: string
  memberId: string
  mutation: MemberMutationIdentity
}
export interface AttentionSetRequest {
  target: SessionBinding
  teamId?: string
  memberId?: string
  state: 'informational' | 'completed' | 'waiting' | 'urgent'
  expectedAttentionRevision: number | null
}
export interface AttentionRecord {
  target: SessionBinding
  teamId?: string
  memberId?: string
  state: AttentionSetRequest['state']
  revision: number
}
export type TeamMutationOutcome<T> =
  | { status: 'applied' | 'replay'; value: T }
  | { status: Exclude<TerminalCode, 'applied'> | 'conflict' }

export class AgentTeamMutationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_params'
      | 'runtime_unavailable'
      | 'invalid_state'
      | 'stale_revision'
      | 'session_unavailable'
      | 'idempotency_conflict'
      | 'operation_pending'
      | 'storage_failure',
    message: string
  ) {
    super(message)
    this.name = 'AgentTeamMutationError'
  }
}

type StoredMutation = {
  request_hash: string
  expected_catalog_revision: number
  expected_team_revision: number | null
  expected_member_revision: number | null
  terminal_code: TerminalCode
  result_metadata_json: string | null
}
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

type Fence = {
  namespace: Namespace
  mutation: CatalogMutationIdentity | TeamMutationIdentity | MemberMutationIdentity
}

function fail(code: AgentTeamMutationError['code'], message: string): never {
  throw new AgentTeamMutationError(code, message)
}
function safeRevision(value: unknown, positive = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
}
function validateMutation(
  mutation: CatalogMutationIdentity | TeamMutationIdentity | MemberMutationIdentity,
  team: boolean,
  member = false
): void {
  if (
    !mutation ||
    !UUID.test(mutation.idempotencyKey) ||
    !HASH.test(mutation.requestHash) ||
    !safeRevision(mutation.expectedCatalogRevision) ||
    (team && !safeRevision((mutation as TeamMutationIdentity).expectedTeamRevision, true)) ||
    (member && !safeRevision((mutation as MemberMutationIdentity).expectedMemberRevision, true))
  ) {
    fail('invalid_params', 'Invalid team mutation identity')
  }
}
function validateTeamId(teamId: string): void {
  if (typeof teamId !== 'string' || !UUID.test(teamId)) fail('invalid_params', 'Invalid team ID')
}
function validateTitle(title: string): void {
  if (
    typeof title !== 'string' ||
    !title ||
    title !== title.trim() ||
    [...title].length > 160 ||
    /\p{Cc}/u.test(title)
  )
    fail('invalid_params', 'Invalid team title')
}
function validateMemberId(memberId: string): void {
  if (typeof memberId !== 'string' || !UUID.test(memberId))
    fail('invalid_params', 'Invalid member ID')
}
function validRole(role: string): void {
  if (
    typeof role !== 'string' ||
    !role ||
    role !== role.trim() ||
    [...role].length > 80 ||
    /\p{Cc}/u.test(role)
  )
    fail('invalid_params', 'Invalid member role')
}
function normalizedRole(role: string): string {
  return role.trim().split(/\s+/u).join(' ')
}
function validBinding(binding: SessionBinding): void {
  if (
    !binding ||
    ![binding.workspaceId, binding.paneId, binding.tabId, binding.agentSessionId].every(
      (id) => typeof id === 'string' && UUID.test(id)
    )
  ) {
    fail('invalid_params', 'Invalid agent session binding')
  }
}
function now(): number {
  return Date.now()
}

/** Exact schema-v15 team writes. Own one private connection to an isolated working copy. */
export class AgentTeamMutations {
  private readonly database: Database.Database

  constructor(databasePath: string) {
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      let file: ReturnType<typeof lstatSync>
      try {
        file = lstatSync(path)
      } catch (error) {
        if (path !== databasePath && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        fail('runtime_unavailable', 'Agent team database is unavailable')
      }
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
        fail('runtime_unavailable', 'Agent team database must be a private regular file')
      }
    }
    this.database = new Database(databasePath, { fileMustExist: true, timeout: 5_000 })
    try {
      this.database.pragma('foreign_keys = ON')
      if (this.database.pragma('user_version', { simple: true }) !== 15) {
        fail('runtime_unavailable', 'Agent team database requires Rust schema-v15')
      }
      readLegacySnapshotConnection(this.database)
      this.database.prepare('SELECT revision FROM agent_catalog_state WHERE singleton = 1').get()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  private catalogRevision(): number {
    const row = this.database
      .prepare('SELECT revision FROM agent_catalog_state WHERE singleton = 1')
      .get() as { revision: number } | undefined
    if (!row || !safeRevision(row.revision))
      fail('invalid_state', 'Agent catalog revision is invalid')
    return row.revision
  }

  private teamRevision(teamId: string): number | undefined {
    const row = this.database
      .prepare('SELECT revision FROM agent_teams WHERE team_id = ?')
      .get(teamId) as { revision: number } | undefined
    if (row && !safeRevision(row.revision, true))
      fail('invalid_state', 'Agent team revision is invalid')
    return row?.revision
  }

  private replay<T>(
    fence: Fence,
    fromRust: (value: unknown) => T
  ): TeamMutationOutcome<T> | undefined {
    const { mutation, namespace } = fence
    const row = this.database
      .prepare(
        `SELECT request_hash, expected_catalog_revision,
      expected_team_revision, expected_member_revision, terminal_code, result_metadata_json
      FROM agent_catalog_mutations WHERE namespace = ? AND idempotency_key = ?`
      )
      .get(namespace, mutation.idempotencyKey) as StoredMutation | undefined
    if (!row) return undefined
    const expectedTeam = 'expectedTeamRevision' in mutation ? mutation.expectedTeamRevision : null
    const expectedMember =
      'expectedMemberRevision' in mutation ? mutation.expectedMemberRevision : null
    if (
      row.request_hash !== mutation.requestHash ||
      row.expected_catalog_revision !== mutation.expectedCatalogRevision ||
      row.expected_team_revision !== expectedTeam ||
      row.expected_member_revision !== expectedMember
    ) {
      return { status: 'conflict' }
    }
    if (row.terminal_code !== 'applied') {
      if (row.result_metadata_json !== null)
        fail('invalid_state', 'Invalid terminal mutation metadata')
      return { status: row.terminal_code }
    }
    if (row.result_metadata_json === null) fail('invalid_state', 'Applied mutation lacks metadata')
    try {
      return { status: 'replay', value: fromRust(JSON.parse(row.result_metadata_json)) }
    } catch {
      fail('invalid_state', 'Stored team mutation result is invalid')
    }
  }

  private record(fence: Fence, code: TerminalCode, value?: object): void {
    const mutation = fence.mutation
    // Rust serializes these records with snake_case field names.
    const json = value === undefined ? null : JSON.stringify(value)
    if (json !== null && Buffer.byteLength(json, 'utf8') > 65_536) {
      fail('invalid_state', 'Team mutation metadata exceeds the Rust bound')
    }
    this.database
      .prepare(
        `INSERT INTO agent_catalog_mutations (
      namespace,idempotency_key,request_hash,expected_catalog_revision,
      expected_team_revision,expected_member_revision,terminal_code,result_metadata_json,completed_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        fence.namespace,
        mutation.idempotencyKey,
        mutation.requestHash,
        mutation.expectedCatalogRevision,
        'expectedTeamRevision' in mutation ? mutation.expectedTeamRevision : null,
        'expectedMemberRevision' in mutation ? mutation.expectedMemberRevision : null,
        code,
        json,
        now()
      )
  }

  private bumpCatalog(): void {
    const changed = this.database
      .prepare(
        `UPDATE agent_catalog_state SET revision = revision + 1
      WHERE singleton = 1 AND revision < ?`
      )
      .run(MAX_SAFE)
    if (changed.changes !== 1) fail('invalid_state', 'Agent catalog revision is exhausted')
  }

  private fromRustTeam(value: unknown): TeamRecord {
    const row = value as { team_id?: unknown; title?: unknown; revision?: unknown }
    if (
      !row ||
      typeof row.team_id !== 'string' ||
      !UUID.test(row.team_id) ||
      typeof row.title !== 'string' ||
      !safeRevision(row.revision, true)
    ) {
      fail('invalid_state', 'Stored team result is invalid')
    }
    return { teamId: row.team_id, title: row.title, revision: row.revision }
  }

  private fromRustDelete(value: unknown): TeamDeleteRecord {
    const row = value as {
      team_id?: unknown
      catalog_revision?: unknown
      deleted_team_revision?: unknown
    }
    if (
      !row ||
      typeof row.team_id !== 'string' ||
      !UUID.test(row.team_id) ||
      !safeRevision(row.catalog_revision, true) ||
      !safeRevision(row.deleted_team_revision, true)
    ) {
      fail('invalid_state', 'Stored team deletion result is invalid')
    }
    return {
      teamId: row.team_id,
      catalogRevision: row.catalog_revision,
      deletedTeamRevision: row.deleted_team_revision
    }
  }

  private memberRow(memberId: string): MemberRow | undefined {
    return this.database
      .prepare(
        `SELECT member_id,team_id,role,target_agent_session_id,
      target_workspace_id,target_pane_id,target_tab_id,parent_member_id,revision
      FROM agent_team_members WHERE member_id = ?`
      )
      .get(memberId) as MemberRow | undefined
  }

  private memberFromRow(row: MemberRow): MemberRecord {
    return {
      memberId: row.member_id,
      teamId: row.team_id,
      role: row.role,
      target: {
        agentSessionId: row.target_agent_session_id,
        workspaceId: row.target_workspace_id,
        paneId: row.target_pane_id,
        tabId: row.target_tab_id
      },
      ...(row.parent_member_id === null ? {} : { parentMemberId: row.parent_member_id }),
      revision: row.revision
    }
  }

  private fromRustMember(value: unknown): MemberRecord {
    const row = value as {
      member_id?: unknown
      team_id?: unknown
      role?: unknown
      target?: unknown
      parent_member_id?: unknown
      revision?: unknown
    }
    const target = row?.target as
      | { workspace_id?: unknown; pane_id?: unknown; tab_id?: unknown; agent_session_id?: unknown }
      | undefined
    if (
      !row ||
      typeof row.member_id !== 'string' ||
      !UUID.test(row.member_id) ||
      typeof row.team_id !== 'string' ||
      !UUID.test(row.team_id) ||
      typeof row.role !== 'string' ||
      !safeRevision(row.revision, true) ||
      (row.parent_member_id !== null &&
        row.parent_member_id !== undefined &&
        (typeof row.parent_member_id !== 'string' || !UUID.test(row.parent_member_id)))
    ) {
      fail('invalid_state', 'Stored member result is invalid')
    }
    const binding = {
      workspaceId: target?.workspace_id,
      paneId: target?.pane_id,
      tabId: target?.tab_id,
      agentSessionId: target?.agent_session_id
    } as SessionBinding
    validBinding(binding)
    return {
      memberId: row.member_id,
      teamId: row.team_id,
      role: row.role,
      target: binding,
      ...(row.parent_member_id ? { parentMemberId: row.parent_member_id } : {}),
      revision: row.revision
    }
  }

  private fromRustMemberDelete(value: unknown): MemberDeleteRecord {
    const row = value as {
      team_id?: unknown
      member_id?: unknown
      catalog_revision?: unknown
      team_revision?: unknown
      deleted_member_revision?: unknown
    }
    if (
      !row ||
      typeof row.team_id !== 'string' ||
      !UUID.test(row.team_id) ||
      typeof row.member_id !== 'string' ||
      !UUID.test(row.member_id) ||
      !safeRevision(row.catalog_revision, true) ||
      !safeRevision(row.team_revision, true) ||
      !safeRevision(row.deleted_member_revision, true)
    ) {
      fail('invalid_state', 'Stored member deletion result is invalid')
    }
    return {
      teamId: row.team_id,
      memberId: row.member_id,
      catalogRevision: row.catalog_revision,
      teamRevision: row.team_revision,
      deletedMemberRevision: row.deleted_member_revision
    }
  }

  private rustMember(value: MemberRecord): object {
    return {
      member_id: value.memberId,
      team_id: value.teamId,
      role: value.role,
      target: this.rustBinding(value.target),
      parent_member_id: value.parentMemberId ?? null,
      revision: value.revision
    }
  }

  private rustBinding(value: SessionBinding): object {
    return {
      workspace_id: value.workspaceId,
      pane_id: value.paneId,
      tab_id: value.tabId,
      agent_session_id: value.agentSessionId
    }
  }

  private bindingIsCurrent(target: SessionBinding): void {
    const row = this.database
      .prepare(
        `SELECT workspace_id,pane_id,tab_id FROM agent_sessions
      WHERE agent_session_id = ?`
      )
      .get(target.agentSessionId) as
      { workspace_id: string; pane_id: string; tab_id: string } | undefined
    if (
      !row ||
      row.workspace_id !== target.workspaceId ||
      row.pane_id !== target.paneId ||
      row.tab_id !== target.tabId
    )
      fail('invalid_params', 'Agent session binding is not exact')
  }

  private parentIsInTeam(teamId: string, parentMemberId: string | undefined): void {
    if (parentMemberId === undefined) return
    validateMemberId(parentMemberId)
    if (this.memberRow(parentMemberId)?.team_id !== teamId) {
      fail('invalid_params', 'Parent member does not belong to the team')
    }
  }

  private memberFence(
    teamId: string,
    memberId: string,
    mutation: MemberMutationIdentity
  ): 'staleCatalog' | 'staleTeam' | 'staleMember' | undefined {
    if (this.catalogRevision() !== mutation.expectedCatalogRevision) return 'staleCatalog'
    if (this.teamRevision(teamId) !== mutation.expectedTeamRevision) return 'staleTeam'
    const member = this.memberRow(memberId)
    if (
      !member ||
      member.team_id !== teamId ||
      member.revision !== mutation.expectedMemberRevision
    ) {
      return 'staleMember'
    }
    return undefined
  }

  private bumpTeam(teamId: string, expected: number): void {
    const changed = this.database
      .prepare(
        `UPDATE agent_teams SET revision = revision + 1,
      updated_at_ms = ? WHERE team_id = ? AND revision = ? AND revision < ?`
      )
      .run(now(), teamId, expected, MAX_SAFE)
    if (changed.changes !== 1) fail('invalid_state', 'Agent team revision changed')
  }

  createTeam(input: TeamCreateRequest): TeamMutationOutcome<TeamRecord> {
    validateTeamId(input.teamId)
    validateTitle(input.title)
    validateMutation(input.mutation, false)
    return this.database
      .transaction(() => {
        const fence: Fence = { namespace: 'teamCreate', mutation: input.mutation }
        const replay = this.replay(fence, (value) => this.fromRustTeam(value))
        if (replay) return replay
        if (this.catalogRevision() !== input.mutation.expectedCatalogRevision) {
          this.record(fence, 'staleCatalog')
          return { status: 'staleCatalog' } as const
        }
        const count = this.database.prepare('SELECT COUNT(*) AS count FROM agent_teams').get() as {
          count: number
        }
        if (count.count >= 64) {
          this.record(fence, 'resourceLimit')
          return { status: 'resourceLimit' } as const
        }
        if (this.teamRevision(input.teamId) !== undefined) {
          fail('invalid_params', 'Agent team ID already exists')
        }
        const timestamp = now()
        this.database
          .prepare(
            `INSERT INTO agent_teams
        (team_id,title,revision,created_at_ms,updated_at_ms) VALUES (?,?,1,?,?)`
          )
          .run(input.teamId, input.title, timestamp, timestamp)
        this.bumpCatalog()
        const team = { teamId: input.teamId, title: input.title, revision: 1 }
        this.record(fence, 'applied', {
          team_id: team.teamId,
          title: team.title,
          revision: team.revision
        })
        return { status: 'applied', value: team } as const
      })
      .immediate()
  }

  updateTeam(input: TeamUpdateRequest): TeamMutationOutcome<TeamRecord> {
    validateTeamId(input.teamId)
    validateTitle(input.title)
    validateMutation(input.mutation, true)
    return this.database
      .transaction(() => {
        const fence: Fence = { namespace: 'teamUpdate', mutation: input.mutation }
        const replay = this.replay(fence, (value) => this.fromRustTeam(value))
        if (replay) return replay
        if (this.catalogRevision() !== input.mutation.expectedCatalogRevision) {
          this.record(fence, 'staleCatalog')
          return { status: 'staleCatalog' } as const
        }
        if (this.teamRevision(input.teamId) !== input.mutation.expectedTeamRevision) {
          this.record(fence, 'staleTeam')
          return { status: 'staleTeam' } as const
        }
        if (input.mutation.expectedTeamRevision === MAX_SAFE) {
          fail('invalid_state', 'Agent team revision is exhausted')
        }
        const timestamp = now()
        const changed = this.database
          .prepare(
            `UPDATE agent_teams SET title = ?, revision = revision + 1,
        updated_at_ms = ? WHERE team_id = ? AND revision = ?`
          )
          .run(input.title, timestamp, input.teamId, input.mutation.expectedTeamRevision)
        if (changed.changes !== 1) fail('invalid_state', 'Agent team revision changed')
        this.bumpCatalog()
        const team = {
          teamId: input.teamId,
          title: input.title,
          revision: input.mutation.expectedTeamRevision + 1
        }
        this.record(fence, 'applied', {
          team_id: team.teamId,
          title: team.title,
          revision: team.revision
        })
        return { status: 'applied', value: team } as const
      })
      .immediate()
  }

  deleteTeam(input: TeamDeleteRequest): TeamMutationOutcome<TeamDeleteRecord> {
    validateTeamId(input.teamId)
    validateMutation(input.mutation, true)
    return this.database
      .transaction(() => {
        const fence: Fence = { namespace: 'teamDelete', mutation: input.mutation }
        const replay = this.replay(fence, (value) => this.fromRustDelete(value))
        if (replay) return replay
        if (this.catalogRevision() !== input.mutation.expectedCatalogRevision) {
          this.record(fence, 'staleCatalog')
          return { status: 'staleCatalog' } as const
        }
        if (this.teamRevision(input.teamId) !== input.mutation.expectedTeamRevision) {
          this.record(fence, 'staleTeam')
          return { status: 'staleTeam' } as const
        }
        if (input.mutation.expectedCatalogRevision === MAX_SAFE) {
          fail('invalid_state', 'Agent catalog revision is exhausted')
        }
        this.database.prepare('DELETE FROM agent_attention WHERE team_id = ?').run(input.teamId)
        this.database
          .prepare('UPDATE agent_team_members SET parent_member_id = NULL WHERE team_id = ?')
          .run(input.teamId)
        this.database.prepare('DELETE FROM agent_team_members WHERE team_id = ?').run(input.teamId)
        const changed = this.database
          .prepare('DELETE FROM agent_teams WHERE team_id = ? AND revision = ?')
          .run(input.teamId, input.mutation.expectedTeamRevision)
        if (changed.changes !== 1) fail('invalid_state', 'Agent team revision changed')
        this.bumpCatalog()
        const value = {
          teamId: input.teamId,
          catalogRevision: input.mutation.expectedCatalogRevision + 1,
          deletedTeamRevision: input.mutation.expectedTeamRevision
        }
        this.record(fence, 'applied', {
          team_id: value.teamId,
          catalog_revision: value.catalogRevision,
          deleted_team_revision: value.deletedTeamRevision
        })
        return { status: 'applied', value } as const
      })
      .immediate()
  }

  createMember(input: MemberCreateRequest): TeamMutationOutcome<MemberRecord> {
    validateTeamId(input.teamId)
    validateMemberId(input.memberId)
    validRole(input.role)
    if (input.role !== normalizedRole(input.role)) {
      fail('invalid_params', 'Member role must be whitespace normalized')
    }
    validBinding(input.target)
    validateMutation(input.mutation, true)
    return this.database
      .transaction(() => {
        const fence: Fence = { namespace: 'memberCreate', mutation: input.mutation }
        const replay = this.replay(fence, (value) => this.fromRustMember(value))
        if (replay) return replay
        if (this.catalogRevision() !== input.mutation.expectedCatalogRevision) {
          this.record(fence, 'staleCatalog')
          return { status: 'staleCatalog' } as const
        }
        if (this.teamRevision(input.teamId) !== input.mutation.expectedTeamRevision) {
          this.record(fence, 'staleTeam')
          return { status: 'staleTeam' } as const
        }
        this.bindingIsCurrent(input.target)
        const count = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM agent_team_members
        WHERE team_id = ?`
          )
          .get(input.teamId) as { count: number }
        if (count.count >= 64) {
          this.record(fence, 'resourceLimit')
          return { status: 'resourceLimit' } as const
        }
        this.parentIsInTeam(input.teamId, input.parentMemberId)
        if (
          this.memberRow(input.memberId) ||
          this.database
            .prepare(
              `SELECT 1 FROM agent_team_members
        WHERE target_agent_session_id = ?`
            )
            .get(input.target.agentSessionId)
        ) {
          fail('invalid_params', 'Member ID or agent session is already assigned')
        }
        if (input.mutation.expectedTeamRevision === MAX_SAFE) {
          fail('invalid_state', 'Agent team revision is exhausted')
        }
        const timestamp = now()
        this.database
          .prepare(
            `INSERT INTO agent_team_members (
        member_id,team_id,role,target_agent_session_id,target_workspace_id,target_pane_id,
        target_tab_id,parent_member_id,revision,created_at_ms,updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,1,?,?)`
          )
          .run(
            input.memberId,
            input.teamId,
            input.role,
            input.target.agentSessionId,
            input.target.workspaceId,
            input.target.paneId,
            input.target.tabId,
            input.parentMemberId ?? null,
            timestamp,
            timestamp
          )
        this.bumpTeam(input.teamId, input.mutation.expectedTeamRevision)
        this.bumpCatalog()
        const value: MemberRecord = {
          memberId: input.memberId,
          teamId: input.teamId,
          role: input.role,
          target: input.target,
          ...(input.parentMemberId === undefined ? {} : { parentMemberId: input.parentMemberId }),
          revision: 1
        }
        this.record(fence, 'applied', this.rustMember(value))
        return { status: 'applied', value } as const
      })
      .immediate()
  }

  updateMember(input: MemberUpdateRequest): TeamMutationOutcome<MemberRecord> {
    validateTeamId(input.teamId)
    validateMemberId(input.memberId)
    validRole(input.role)
    validateMutation(input.mutation, true, true)
    const role = normalizedRole(input.role)
    return this.database
      .transaction(() => {
        const fence: Fence = { namespace: 'memberUpdate', mutation: input.mutation }
        const replay = this.replay(fence, (value) => this.fromRustMember(value))
        if (replay) return replay
        const stale = this.memberFence(input.teamId, input.memberId, input.mutation)
        if (stale) {
          this.record(fence, stale)
          return { status: stale }
        }
        this.parentIsInTeam(input.teamId, input.parentMemberId)
        let parent = input.parentMemberId
        const visited = new Set<string>()
        while (parent !== undefined) {
          if (parent === input.memberId || visited.has(parent)) {
            fail('invalid_params', 'Member parent would create a cycle')
          }
          visited.add(parent)
          const current = this.memberRow(parent)
          parent = current?.parent_member_id ?? undefined
        }
        if (
          input.mutation.expectedMemberRevision === MAX_SAFE ||
          input.mutation.expectedTeamRevision === MAX_SAFE
        ) {
          fail('invalid_state', 'Agent member or team revision is exhausted')
        }
        const previous = this.memberRow(input.memberId)!
        const changed = this.database
          .prepare(
            `UPDATE agent_team_members SET role = ?,
        parent_member_id = ?, revision = revision + 1, updated_at_ms = ?
        WHERE team_id = ? AND member_id = ? AND revision = ?`
          )
          .run(
            role,
            input.parentMemberId ?? null,
            now(),
            input.teamId,
            input.memberId,
            input.mutation.expectedMemberRevision
          )
        if (changed.changes !== 1) fail('invalid_state', 'Agent member revision changed')
        this.bumpTeam(input.teamId, input.mutation.expectedTeamRevision)
        this.bumpCatalog()
        const previousMember = this.memberFromRow(previous)
        const value: MemberRecord = {
          memberId: previousMember.memberId,
          teamId: previousMember.teamId,
          target: previousMember.target,
          role,
          ...(input.parentMemberId === undefined ? {} : { parentMemberId: input.parentMemberId }),
          revision: input.mutation.expectedMemberRevision + 1
        }
        this.record(fence, 'applied', this.rustMember(value))
        return { status: 'applied', value } as const
      })
      .immediate()
  }

  moveMember(input: MemberMoveRequest): TeamMutationOutcome<MemberRecord> {
    validateTeamId(input.teamId)
    validateMemberId(input.memberId)
    validBinding(input.target)
    validateMutation(input.mutation, true, true)
    return this.database
      .transaction(() => {
        const fence: Fence = { namespace: 'memberMove', mutation: input.mutation }
        const replay = this.replay(fence, (value) => this.fromRustMember(value))
        if (replay) return replay
        const stale = this.memberFence(input.teamId, input.memberId, input.mutation)
        if (stale) {
          this.record(fence, stale)
          return { status: stale }
        }
        this.bindingIsCurrent(input.target)
        const previous = this.memberRow(input.memberId)!
        const other = this.database
          .prepare(
            `SELECT member_id FROM agent_team_members
        WHERE target_agent_session_id = ?`
          )
          .get(input.target.agentSessionId) as { member_id: string } | undefined
        if (other && other.member_id !== input.memberId) {
          fail('invalid_params', 'Target session is already assigned to a member')
        }
        const attached = this.database
          .prepare(
            `SELECT revision FROM agent_attention
        WHERE team_id = ? AND member_id = ?`
          )
          .get(input.teamId, input.memberId) as { revision: number } | undefined
        if (
          attached &&
          (!safeRevision(attached.revision, true) || attached.revision === MAX_SAFE)
        ) {
          fail('invalid_state', 'Agent attention revision is exhausted')
        }
        if (
          attached &&
          input.target.agentSessionId !== previous.target_agent_session_id &&
          this.database
            .prepare(`SELECT 1 FROM agent_attention WHERE agent_session_id = ?`)
            .get(input.target.agentSessionId)
        ) {
          fail('invalid_params', 'Target session already has attention')
        }
        if (
          input.mutation.expectedMemberRevision === MAX_SAFE ||
          input.mutation.expectedTeamRevision === MAX_SAFE
        ) {
          fail('invalid_state', 'Agent member or team revision is exhausted')
        }
        const timestamp = now()
        const changed = this.database
          .prepare(
            `UPDATE agent_team_members SET
        target_agent_session_id = ?, target_workspace_id = ?, target_pane_id = ?, target_tab_id = ?,
        revision = revision + 1, updated_at_ms = ?
        WHERE team_id = ? AND member_id = ? AND revision = ?`
          )
          .run(
            input.target.agentSessionId,
            input.target.workspaceId,
            input.target.paneId,
            input.target.tabId,
            timestamp,
            input.teamId,
            input.memberId,
            input.mutation.expectedMemberRevision
          )
        if (changed.changes !== 1) fail('invalid_state', 'Agent member revision changed')
        this.database
          .prepare(
            `UPDATE agent_attention SET agent_session_id = ?, workspace_id = ?,
        pane_id = ?, tab_id = ?, revision = revision + 1, updated_at_ms = ?
        WHERE team_id = ? AND member_id = ?`
          )
          .run(
            input.target.agentSessionId,
            input.target.workspaceId,
            input.target.paneId,
            input.target.tabId,
            timestamp,
            input.teamId,
            input.memberId
          )
        this.bumpTeam(input.teamId, input.mutation.expectedTeamRevision)
        this.bumpCatalog()
        const value: MemberRecord = {
          ...this.memberFromRow(previous),
          target: input.target,
          revision: input.mutation.expectedMemberRevision + 1
        }
        this.record(fence, 'applied', this.rustMember(value))
        return { status: 'applied', value } as const
      })
      .immediate()
  }

  deleteMember(input: MemberDeleteRequest): TeamMutationOutcome<MemberDeleteRecord> {
    validateTeamId(input.teamId)
    validateMemberId(input.memberId)
    validateMutation(input.mutation, true, true)
    return this.database
      .transaction(() => {
        const fence: Fence = { namespace: 'memberDelete', mutation: input.mutation }
        const replay = this.replay(fence, (value) => this.fromRustMemberDelete(value))
        if (replay) return replay
        const stale = this.memberFence(input.teamId, input.memberId, input.mutation)
        if (stale) {
          this.record(fence, stale)
          return { status: stale }
        }
        const children = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM agent_team_members
        WHERE parent_member_id = ?`
          )
          .get(input.memberId) as { count: number }
        if (children.count !== 0) {
          this.record(fence, 'dependencyConflict')
          return { status: 'dependencyConflict' } as const
        }
        if (
          input.mutation.expectedCatalogRevision === MAX_SAFE ||
          input.mutation.expectedTeamRevision === MAX_SAFE
        ) {
          fail('invalid_state', 'Agent catalog or team revision is exhausted')
        }
        this.database.prepare('DELETE FROM agent_attention WHERE member_id = ?').run(input.memberId)
        const changed = this.database
          .prepare(
            `DELETE FROM agent_team_members
        WHERE team_id = ? AND member_id = ? AND revision = ?`
          )
          .run(input.teamId, input.memberId, input.mutation.expectedMemberRevision)
        if (changed.changes !== 1) fail('invalid_state', 'Agent member revision changed')
        this.bumpTeam(input.teamId, input.mutation.expectedTeamRevision)
        this.bumpCatalog()
        const value: MemberDeleteRecord = {
          teamId: input.teamId,
          memberId: input.memberId,
          catalogRevision: input.mutation.expectedCatalogRevision + 1,
          teamRevision: input.mutation.expectedTeamRevision + 1,
          deletedMemberRevision: input.mutation.expectedMemberRevision
        }
        this.record(fence, 'applied', {
          team_id: value.teamId,
          member_id: value.memberId,
          catalog_revision: value.catalogRevision,
          team_revision: value.teamRevision,
          deleted_member_revision: value.deletedMemberRevision
        })
        return { status: 'applied', value } as const
      })
      .immediate()
  }

  /** Rust attention writes use an exact revision fence, without catalog mutation replay. */
  setAttention(input: AttentionSetRequest): AttentionRecord {
    validBinding(input.target)
    if (
      !['informational', 'completed', 'waiting', 'urgent'].includes(input.state) ||
      (input.teamId === undefined) !== (input.memberId === undefined) ||
      (input.teamId !== undefined && !UUID.test(input.teamId)) ||
      (input.memberId !== undefined && !UUID.test(input.memberId)) ||
      (input.expectedAttentionRevision !== null && !safeRevision(input.expectedAttentionRevision))
    ) {
      fail('invalid_params', 'Invalid attention request')
    }
    return this.database
      .transaction(() => {
        this.bindingIsCurrent(input.target)
        if (input.memberId !== undefined) {
          const member = this.memberRow(input.memberId)
          if (
            !member ||
            member.team_id !== input.teamId ||
            member.target_agent_session_id !== input.target.agentSessionId ||
            member.target_workspace_id !== input.target.workspaceId ||
            member.target_pane_id !== input.target.paneId ||
            member.target_tab_id !== input.target.tabId
          ) {
            fail('invalid_params', 'Attention member binding is not exact')
          }
        }
        const current = this.database
          .prepare(
            `SELECT revision FROM agent_attention
        WHERE agent_session_id = ?`
          )
          .get(input.target.agentSessionId) as { revision: number } | undefined
        if ((current?.revision ?? null) !== input.expectedAttentionRevision) {
          fail('stale_revision', 'Agent attention revision changed')
        }
        if (current?.revision === MAX_SAFE)
          fail('invalid_state', 'Agent attention revision is exhausted')
        const revision = (current?.revision ?? 0) + 1
        this.database
          .prepare(
            `INSERT INTO agent_attention (
        agent_session_id,workspace_id,pane_id,tab_id,team_id,member_id,state,revision,updated_at_ms
      ) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_session_id) DO UPDATE SET
        workspace_id=excluded.workspace_id,pane_id=excluded.pane_id,tab_id=excluded.tab_id,
        team_id=excluded.team_id,member_id=excluded.member_id,state=excluded.state,
        revision=excluded.revision,updated_at_ms=excluded.updated_at_ms`
          )
          .run(
            input.target.agentSessionId,
            input.target.workspaceId,
            input.target.paneId,
            input.target.tabId,
            input.teamId ?? null,
            input.memberId ?? null,
            input.state,
            revision,
            now()
          )
        this.bumpCatalog()
        return {
          target: input.target,
          ...(input.teamId === undefined
            ? {}
            : { teamId: input.teamId, memberId: input.memberId! }),
          state: input.state,
          revision
        }
      })
      .immediate()
  }

  /** Commit the attention change and its terminal operation together on the same SQLite owner. */
  setAttentionWithOperation(input: AgentAttentionSetParams): AgentAttentionSetResult {
    const target = input.target.target
    const operation = input.operation
    validBinding(target)
    if (
      !UUID.test(operation.idempotencyKey) ||
      !HASH.test(operation.requestHash) ||
      !safeRevision(operation.sessionRevision, true) ||
      !safeRevision(operation.attemptEpoch, true)
    ) {
      fail('invalid_params', 'Invalid attention operation identity')
    }
    const outcome = this.database
      .transaction(() => {
        const session = this.database
          .prepare(
            `SELECT workspace_id,pane_id,tab_id,revision,attempt_epoch
        FROM agent_sessions WHERE agent_session_id = ?`
          )
          .get(target.agentSessionId) as
          | {
              workspace_id: string
              pane_id: string
              tab_id: string
              revision: number
              attempt_epoch: number
            }
          | undefined
        if (!session) fail('session_unavailable', 'The agent session is unavailable')
        if (
          session.revision !== operation.sessionRevision ||
          session.attempt_epoch !== operation.attemptEpoch
        ) {
          fail('stale_revision', 'The exact catalog or session revision is stale')
        }
        if (
          session.workspace_id !== target.workspaceId ||
          session.pane_id !== target.paneId ||
          session.tab_id !== target.tabId
        ) {
          fail('invalid_state', "The attention target is not the session's exact durable binding")
        }
        const previous = this.database
          .prepare(
            `SELECT agent_session_id,session_revision,attempt_epoch,
        request_hash,state,terminal_code FROM agent_operations
        WHERE namespace = 'attention.set' AND operation_id = ?`
          )
          .get(operation.idempotencyKey) as
          | {
              agent_session_id: string
              session_revision: number
              attempt_epoch: number
              request_hash: string
              state: string
              terminal_code: string | null
            }
          | undefined
        if (previous) {
          if (
            previous.agent_session_id !== target.agentSessionId ||
            previous.session_revision !== operation.sessionRevision ||
            previous.attempt_epoch !== operation.attemptEpoch ||
            previous.request_hash !== operation.requestHash
          ) {
            fail('idempotency_conflict', 'The idempotency key conflicts with another request')
          }
          if (previous.state === 'pending') {
            fail('operation_pending', 'The durable operation is pending and was not redispatched')
          }
          const code = previous.terminal_code
          if (code === 'staleAttentionRevision') return { error: 'stale_revision' } as const
          if (code === 'storageFailure') return { error: 'storage_failure' } as const
          const revision = code?.startsWith('attentionSet:')
            ? Number(code.slice('attentionSet:'.length))
            : NaN
          if (!safeRevision(revision, true) || previous.state !== 'succeeded') {
            fail('invalid_state', 'The attention replay is unavailable')
          }
          return { value: { target: input.target, state: input.state, revision } } as const
        }
        const timestamp = now()
        this.database
          .prepare(
            `INSERT INTO agent_operations (
        operation_id,namespace,agent_session_id,session_revision,attempt_epoch,
        request_hash,state,accepted_at_ms,updated_at_ms
      ) VALUES (?,'attention.set',?,?,?,?,'pending',?,?)`
          )
          .run(
            operation.idempotencyKey,
            target.agentSessionId,
            operation.sessionRevision,
            operation.attemptEpoch,
            operation.requestHash,
            timestamp,
            timestamp
          )
        let result: AttentionRecord
        try {
          result = this.setAttention({
            target,
            ...(input.target.teamId === undefined
              ? {}
              : {
                  teamId: input.target.teamId,
                  memberId: input.target.memberId
                }),
            state: input.state,
            expectedAttentionRevision: input.expectedAttentionRevision
          })
        } catch (error) {
          if (!(error instanceof AgentTeamMutationError)) throw error
          this.database
            .prepare(
              `UPDATE agent_operations SET state='failed',
          terminal_code='staleAttentionRevision',updated_at_ms=?,terminal_at_ms=?
          WHERE namespace='attention.set' AND operation_id=?`
            )
            .run(timestamp, timestamp, operation.idempotencyKey)
          return { error: 'stale_revision' } as const
        }
        this.database
          .prepare(
            `UPDATE agent_operations SET state='succeeded',
        terminal_code=?,updated_at_ms=?,terminal_at_ms=?
        WHERE namespace='attention.set' AND operation_id=?`
          )
          .run(`attentionSet:${result.revision}`, timestamp, timestamp, operation.idempotencyKey)
        return {
          value: { target: input.target, state: input.state, revision: result.revision }
        } as const
      })
      .immediate()
    if ('error' in outcome) {
      if (outcome.error === 'stale_revision') {
        fail('stale_revision', 'The exact catalog or session revision is stale')
      }
      fail('storage_failure', 'The durable attention route could not be updated')
    }
    return outcome.value
  }
}
