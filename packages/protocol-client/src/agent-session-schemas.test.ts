import { describe, expect, it } from 'vitest'

import {
  agentAttentionSetParamsSchema,
  agentAttentionSetResultSchema,
  agentCatalogListResultSchema,
  agentHibernationConfirmParamsSchema,
  agentSessionForkParamsSchema,
  agentSessionRestoreParamsSchema,
  agentTeamCreateParamsSchema,
  agentTeamDeleteParamsSchema,
  agentTeamMemberCreateParamsSchema,
  agentTeamMemberMoveParamsSchema,
  agentTeamMemberUpdateParamsSchema,
  agentTeamSnapshotSchema
} from './schemas'

const ID = '10000000-0000-4000-8000-000000000001'
const ID2 = '10000000-0000-4000-8000-000000000002'
const ID3 = '10000000-0000-4000-8000-000000000003'
const operation = {
  idempotencyKey: ID2,
  requestHash: 'a'.repeat(64),
  sessionRevision: 1,
  attemptEpoch: 1
}
const binding = { workspaceId: ID, paneId: ID2, tabId: ID3, agentSessionId: ID }
const placement = { workspaceId: ID, paneId: ID2, tabId: ID3 }
const catalogMutation = {
  idempotencyKey: ID2,
  requestHash: 'b'.repeat(64),
  expectedCatalogRevision: 0
}
const teamMutation = { ...catalogMutation, expectedCatalogRevision: 1, expectedTeamRevision: 1 }
const memberMutation = { ...teamMutation, expectedMemberRevision: 1 }

describe('agent session schemas', () => {
  it('keeps restore level and outcome distinct and rejects null or unknown ambiguity', () => {
    expect(
      agentSessionRestoreParamsSchema.safeParse({ agentSessionId: ID, operation }).success
    ).toBe(true)
    expect(
      agentSessionRestoreParamsSchema.safeParse({ agentSessionId: ID, operation, outcome: null })
        .success
    ).toBe(false)
    expect(
      agentSessionRestoreParamsSchema.safeParse({
        agentSessionId: ID,
        operation: { ...operation, attemptEpoch: Number.MAX_SAFE_INTEGER + 1 }
      }).success
    ).toBe(false)
  })

  it('requires a fresh fork identity and accepts sanitized provenance inputs only', () => {
    expect(
      agentSessionForkParamsSchema.safeParse({
        sourceAgentSessionId: ID,
        destination: { ...placement, agentSessionId: ID },
        title: 'fork',
        operation
      }).success
    ).toBe(false)
    expect(
      agentSessionForkParamsSchema.safeParse({
        sourceAgentSessionId: ID,
        destination: placement,
        title: 'fork',
        operation
      }).success
    ).toBe(true)
    expect(
      agentSessionForkParamsSchema.safeParse({
        sourceAgentSessionId: ID2,
        destination: placement,
        title: 'fork',
        operation,
        transcript: 'private'
      }).success
    ).toBe(false)
  })

  it('rejects cyclic member graphs and duplicate session bindings', () => {
    const member = (
      memberId: string,
      parentMemberId: string | undefined,
      agentSessionId: string
    ) => ({
      memberId,
      role: 'worker',
      target: { ...binding, agentSessionId },
      parentMemberId,
      revision: 1
    })
    expect(
      agentTeamSnapshotSchema.safeParse({
        teamId: ID,
        title: 'team',
        revision: 1,
        members: [member(ID, ID2, ID), member(ID2, ID, ID2)]
      }).success
    ).toBe(false)
    expect(
      agentTeamSnapshotSchema.safeParse({
        teamId: ID,
        title: 'team',
        revision: 1,
        members: [member(ID, undefined, ID3), member(ID2, ID, ID3)]
      }).success
    ).toBe(false)
  })

  it('uses catalog and team revisions instead of fake session attempt identity', () => {
    expect(
      agentTeamCreateParamsSchema.safeParse({
        teamId: ID,
        title: 'team',
        mutation: catalogMutation
      }).success
    ).toBe(true)
    expect(
      agentTeamCreateParamsSchema.safeParse({
        teamId: ID,
        title: 'team',
        mutation: { ...catalogMutation, attemptEpoch: 1 }
      }).success
    ).toBe(false)
    expect(
      agentTeamCreateParamsSchema.safeParse({
        teamId: ID,
        title: 'team',
        mutation: { ...catalogMutation, requestHash: 'B'.repeat(64) }
      }).success
    ).toBe(false)
    expect(
      agentTeamDeleteParamsSchema.safeParse({
        teamId: ID,
        mutation: { ...teamMutation, expectedTeamRevision: 0 }
      }).success
    ).toBe(false)
  })

  it('requires exact team and member mutation authority', () => {
    expect(
      agentTeamMemberCreateParamsSchema.safeParse({
        teamId: ID,
        memberId: ID2,
        role: 'worker',
        target: binding,
        mutation: teamMutation
      }).success
    ).toBe(true)
    expect(
      agentTeamMemberUpdateParamsSchema.safeParse({
        teamId: ID,
        memberId: ID2,
        role: 'worker',
        mutation: memberMutation
      }).success
    ).toBe(true)
    expect(
      agentTeamMemberMoveParamsSchema.safeParse({
        teamId: ID,
        memberId: ID2,
        target: binding,
        mutation: { ...teamMutation, expectedMemberRevision: 0 }
      }).success
    ).toBe(false)
    expect(
      agentTeamMemberMoveParamsSchema.safeParse({
        teamId: ID,
        memberId: ID2,
        target: binding,
        mutation: { ...memberMutation, sessionRevision: 1 }
      }).success
    ).toBe(false)
  })

  it('enforces catalog and hibernation confirmation bounds', () => {
    expect(
      agentCatalogListResultSchema.safeParse({
        catalogVersion: 1,
        revision: 0,
        sessions: Array.from({ length: 513 }, () => ({})),
        teams: [],
        attention: []
      }).success
    ).toBe(false)
    expect(
      agentHibernationConfirmParamsSchema.safeParse({
        agentSessionId: ID,
        confirmationId: ID2,
        choice: 'terminateAfterWarning',
        provider: { providerId: ID3, providerEpoch: 1, leaseId: ID },
        window: { windowId: ID2, windowGeneration: 1 },
        nonce: 'short-lived-nonce',
        expiresAtMs: 10,
        operation
      }).success
    ).toBe(true)
    expect(
      agentHibernationConfirmParamsSchema.safeParse({
        agentSessionId: ID,
        confirmationId: ID2,
        choice: 'terminate',
        provider: { providerId: ID3, providerEpoch: 1, leaseId: ID },
        window: { windowId: ID2, windowGeneration: 1 },
        nonce: 'short-lived-nonce',
        expiresAtMs: 10,
        operation
      }).success
    ).toBe(false)
  })

  it('requires explicit attention CAS and returns the next authoritative revision', () => {
    const first = {
      target: { target: binding },
      state: 'urgent',
      expectedAttentionRevision: null,
      operation
    }
    expect(agentAttentionSetParamsSchema.safeParse(first).success).toBe(true)
    expect(
      agentAttentionSetParamsSchema.safeParse({
        target: { target: binding },
        state: 'urgent',
        operation
      }).success
    ).toBe(false)
    expect(
      agentAttentionSetResultSchema.safeParse({
        target: { target: binding },
        state: 'urgent',
        revision: 1
      }).success
    ).toBe(true)
  })
})
