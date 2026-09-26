import { describe, expect, it } from 'vitest'
import type { DurableApplicationState } from '@agent-workspace/contracts'
import { CardSlotAttentionError, CardSlotAttentionService } from './card-slot-attention'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const paneId = '20000000-0000-4000-8000-000000000002'
const tabId = '30000000-0000-4000-8000-000000000003'
const infoId = '40000000-0000-4000-8000-000000000004'
const errorId = '50000000-0000-4000-8000-000000000005'

function fixture(): DurableApplicationState {
  return {
    revision: 1,
    selectedWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        selectedPaneId: paneId,
        panes: { [paneId]: { id: paneId, selectedTabId: tabId } },
        tabs: { [tabId]: { id: tabId, paneId } }
      }
    ],
    notifications: [
      { id: infoId, workspaceId, paneId, tabId, level: 'info', createdAt: 1, readAt: null },
      { id: errorId, workspaceId, paneId, tabId, level: 'error', createdAt: 2, readAt: null }
    ]
  } as unknown as DurableApplicationState
}

describe('process-local card slots and attention', () => {
  it('uses per-slot CAS, no-op replacements, and bounded reconnect invalidations', () => {
    const state = fixture()
    const service = new CardSlotAttentionService(() => state)
    const events: string[] = []
    service.subscribe((event) => events.push(event.event))
    expect(service.getSlots({ workspaceId }).revision).toBe(0)
    const request = {
      workspaceId,
      expectedRevision: 0,
      agentStatus: { status: 'waiting' as const, label: null },
      progress: null
    }
    expect(service.replaceSlots(request).revision).toBe(1)
    expect(service.replaceSlots({ ...request, expectedRevision: 1 }).revision).toBe(1)
    expect(() => service.replaceSlots(request)).toThrow(CardSlotAttentionError)
    expect(service.getAttention({ workspaceId })).toMatchObject({
      revision: 0,
      state: 'urgent',
      reason: 'notificationError',
      unreadCount: 2,
      notificationId: errorId
    })
    expect(events).toEqual(['workspace.cardSlotsChanged'])
    const resync = service.resyncEvents()
    expect(resync.filter((event) => event.event === 'workspace.cardSlots.v2Changed')).toHaveLength(
      9
    )
    expect(resync).toContainEqual({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 1, reason: 'slotsReplaced' }
    })
  })

  it('keeps notification priority and increments attention only on projection changes', () => {
    const state = fixture()
    const service = new CardSlotAttentionService(() => state)
    expect(service.getAttention({ workspaceId })).toMatchObject({
      revision: 0,
      reason: 'notificationError',
      unreadCount: 2
    })
    state.notifications[1]!.readAt = 3
    state.revision += 1
    expect(service.getAttention({ workspaceId })).toMatchObject({
      revision: 1,
      reason: 'notificationInfo',
      unreadCount: 1,
      notificationId: infoId
    })
    state.revision += 1
    expect(service.getAttention({ workspaceId }).revision).toBe(1)
    service.replaceSlots({
      workspaceId,
      expectedRevision: 0,
      agentStatus: { status: 'failed', label: null },
      progress: null
    })
    expect(service.getAttention({ workspaceId })).toMatchObject({
      revision: 2,
      reason: 'agentFailed',
      unreadCount: 1
    })
  })

  it('accepts a complete v2 replacement through the strict GET lookup', () => {
    const state = fixture()
    const service = new CardSlotAttentionService(() => state)
    const events: string[] = []
    service.subscribe((event) => events.push(event.event))
    const request = {
      workspaceId,
      kind: 'markdown' as const,
      expectedRevision: 0,
      payload: { kind: 'markdown' as const, value: { source: '# Ready' } }
    }
    expect(service.replaceSlotV2(request)).toEqual({
      workspaceId,
      kind: 'markdown',
      slotRevision: 1,
      payload: request.payload
    })
    expect(service.replaceSlotV2({ ...request, expectedRevision: 1 }).slotRevision).toBe(1)
    expect(() => service.replaceSlotV2(request)).toThrowError(
      expect.objectContaining({ code: 'revision_conflict' })
    )
    expect(events).toEqual(['workspace.cardSlots.v2Changed'])
  })

  it('checks exact focus and attention revision for an acknowledgement', () => {
    const state = fixture()
    const service = new CardSlotAttentionService(() => state)
    const params = {
      notificationId: errorId,
      expectedRevision: 0,
      idempotencyKey: '60000000-0000-4000-8000-000000000006',
      mode: 'focused' as const
    }
    expect(service.prepareAcknowledgement(params)).toMatchObject({
      notificationId: errorId,
      workspaceId
    })
    state.workspaces[0]!.selectedPaneId = '70000000-0000-4000-8000-000000000007'
    expect(() => service.prepareAcknowledgement(params)).toThrowError(/focused/)
  })
})
