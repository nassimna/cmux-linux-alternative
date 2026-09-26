/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ApplicationSnapshot,
  DomainEventMessage,
  IdentifyResult,
  NotificationListResult,
  NotificationSnapshot,
  SettingsGetResult,
  WorkspaceAttentionSnapshot,
  WorkspaceCardSlotV2GetParams,
  WorkspaceCardSlotV2Snapshot
} from '@agent-workspace/protocol-client'

import type { DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'

import projection from '../../../../packages/protocol-client/fixtures/milestone2-projection.json'
import settings from '../../../../packages/protocol-client/fixtures/milestone2-settings.json'
import { messages } from '../messages'
import { resetProjectionStoreForTests, useProjectionStore } from './projection-store'

const projectionFixture = projection as ApplicationSnapshot
const settingsFixture = settings as SettingsGetResult
const notificationFixture: NotificationSnapshot = {
  id: '60000000-0000-4000-8000-000000000001',
  workspaceId: projectionFixture.workspaces[0]!.id,
  paneId: projectionFixture.workspaces[0]!.panes[0]!.id,
  tabId: projectionFixture.workspaces[0]!.tabs[0]!.id,
  source: 'agentHook',
  level: 'warning',
  title: 'Agent needs attention',
  body: 'Review the latest output.',
  createdAt: 1200
}
const notificationListFixture: NotificationListResult = {
  revision: 42,
  notifications: [notificationFixture],
  total: 1,
  unreadCount: 1
}

afterEach(() => {
  vi.useRealTimers()
  resetProjectionStoreForTests()
})

describe('projection store', () => {
  it.each([
    ['workspace-groups-v1', 'getWorkspaceOrganization'],
    ['saved-layouts-v1', 'listSavedLayouts']
  ] as const)(
    'renegotiates initialization when a current %s handler reports a capability transition',
    async (capability, operation) => {
      const bridge = createBridge()
      vi.mocked(bridge.identify)
        .mockResolvedValueOnce(identityWith(capability))
        .mockResolvedValue(identityWith())
      if (operation === 'getWorkspaceOrganization') {
        bridge.getWorkspaceOrganization = vi.fn().mockResolvedValue(null)
      } else {
        bridge.listSavedLayouts = vi.fn().mockResolvedValue(null)
      }

      await useProjectionStore.getState().initialize(bridge)

      await vi.waitFor(() => expect(bridge.identify).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(useProjectionStore.getState().status).toBe('ready'))
      expect(useProjectionStore.getState()).toMatchObject({
        identity: { capabilities: [] },
        error: null,
        organization: null,
        savedLayouts: null
      })
      expect(bridge[operation]).toHaveBeenCalledOnce()
    }
  )

  it('renegotiates a full refresh when an organization handler reports a transition', async () => {
    const bridge = createBridge()
    vi.mocked(bridge.identify)
      .mockResolvedValueOnce(identityWith('workspace-groups-v1'))
      .mockResolvedValueOnce(identityWith('workspace-groups-v1'))
      .mockResolvedValue(identityWith())
    bridge.getWorkspaceOrganization = vi
      .fn()
      .mockResolvedValueOnce({ organization: organizationAt(1) })
      .mockResolvedValueOnce(null)

    await useProjectionStore.getState().initialize(bridge)
    await useProjectionStore.getState().refresh()

    await vi.waitFor(() => expect(bridge.identify).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(useProjectionStore.getState().status).toBe('ready'))
    expect(useProjectionStore.getState()).toMatchObject({
      identity: { capabilities: [] },
      error: null,
      organization: null
    })
    expect(bridge.getWorkspaceOrganization).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['workspace-groups-v1', 'getWorkspaceOrganization', 'refreshOrganization'],
    ['saved-layouts-v1', 'listSavedLayouts', 'refreshSavedLayouts']
  ] as const)(
    'renegotiates a specific %s refresh when its current handler reports a transition',
    async (capability, operation, refresh) => {
      const bridge = createBridge()
      vi.mocked(bridge.identify)
        .mockResolvedValueOnce(identityWith(capability))
        .mockResolvedValue(identityWith())
      if (operation === 'getWorkspaceOrganization') {
        bridge.getWorkspaceOrganization = vi
          .fn()
          .mockResolvedValueOnce({ organization: organizationAt(1) })
          .mockResolvedValueOnce(null)
      } else {
        bridge.listSavedLayouts = vi
          .fn()
          .mockResolvedValueOnce({ revision: 1, layouts: [] })
          .mockResolvedValueOnce(null)
      }
      await useProjectionStore.getState().initialize(bridge)

      await useProjectionStore.getState()[refresh]()

      await vi.waitFor(() => expect(bridge.identify).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(useProjectionStore.getState().status).toBe('ready'))
      expect(useProjectionStore.getState()).toMatchObject({
        identity: { capabilities: [] },
        error: null,
        organization: null,
        savedLayouts: null
      })
      expect(bridge[operation]).toHaveBeenCalledTimes(2)
    }
  )

  it('cancels stale capability reads when a desktop binding is reinitialized', async () => {
    const staleWorkspaces = deferred<{ snapshot: ApplicationSnapshot }>()
    const bridge = createBridge()
    vi.mocked(bridge.identify)
      .mockResolvedValueOnce({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['saved-layouts-v1']
      })
      .mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: []
      })
    vi.mocked(bridge.listWorkspaces)
      .mockReturnValueOnce(staleWorkspaces.promise)
      .mockResolvedValue({ snapshot: projectionFixture })
    bridge.listSavedLayouts = vi.fn().mockResolvedValue({ revision: 1, layouts: [] })

    const staleInitialization = useProjectionStore.getState().initialize(bridge)
    await vi.waitFor(() => expect(bridge.identify).toHaveBeenCalledOnce())
    const currentInitialization = useProjectionStore.getState().initialize(bridge)
    await currentInitialization
    staleWorkspaces.resolve({ snapshot: projectionFixture })
    await staleInitialization

    expect(bridge.listSavedLayouts).not.toHaveBeenCalled()
    expect(useProjectionStore.getState().identity?.capabilities).toEqual([])
    expect(useProjectionStore.getState().status).toBe('ready')
  })

  it('re-identifies on topology changes even when the previous identity loses the capability', async () => {
    type Listener = Parameters<NonNullable<DesktopBridge['onMultiWindowEvent']>>[0]
    let listener: Listener | undefined
    const bridge = createBridge()
    vi.mocked(bridge.identify)
      .mockResolvedValueOnce({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['multi-window-v1', 'saved-layouts-v1']
      })
      .mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: []
      })
    bridge.listSavedLayouts = vi.fn().mockResolvedValue({ revision: 1, layouts: [] })
    bridge.onMultiWindowEvent = vi.fn((next: Listener) => {
      listener = next
      return () => undefined
    })

    await useProjectionStore.getState().initialize(bridge)
    expect(useProjectionStore.getState().savedLayouts).toEqual({ revision: 1, layouts: [] })

    listener?.({ event: 'window.topologyChanged' } as never)

    await vi.waitFor(() => expect(bridge.identify).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(useProjectionStore.getState().savedLayouts).toBeNull())
    expect(useProjectionStore.getState().identity?.capabilities).toEqual([])
    expect(bridge.listSavedLayouts).toHaveBeenCalledTimes(1)
  })

  it('makes no v2 calls when card-slots-v2 is absent', async () => {
    const bridge = createBridge()
    bridge.getWorkspaceCardSlotV2 = vi.fn()
    bridge.onWorkspaceCardSlotV2Event = vi.fn(() => () => undefined)

    await useProjectionStore.getState().initialize(bridge)

    expect(bridge.getWorkspaceCardSlotV2).not.toHaveBeenCalled()
    expect(useProjectionStore.getState().cardSlotsV2).toEqual({})
  })

  it('refetches only the invalidated v2 kind and rejects a stale response', async () => {
    type Listener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotV2Event']>>[0]
    let listener: Listener | undefined
    const bridge = createBridge()
    const workspaceId = projectionFixture.workspaces[0]!.id
    vi.mocked(bridge.identify).mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: ['card-slots-v2']
    })
    const getWorkspaceCardSlotV2 = vi.fn(
      ({
        workspaceId: requestedWorkspaceId,
        kind
      }: WorkspaceCardSlotV2GetParams): Promise<WorkspaceCardSlotV2Snapshot> =>
        Promise.resolve({
          workspaceId: requestedWorkspaceId,
          kind,
          slotRevision: 0,
          payload: null
        })
    )
    bridge.getWorkspaceCardSlotV2 = getWorkspaceCardSlotV2
    bridge.onWorkspaceCardSlotV2Event = vi.fn((next: Listener) => {
      listener = next
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    getWorkspaceCardSlotV2.mockClear()
    getWorkspaceCardSlotV2.mockResolvedValue({
      workspaceId,
      kind: 'progress',
      slotRevision: 1,
      payload: {
        kind: 'progress',
        value: { mode: 'determinate', value: 25, label: 'Tests' }
      }
    })

    listener?.({
      event: 'workspace.cardSlots.v2Changed',
      data: { workspaceId, kind: 'progress', slotRevision: 1, reason: 'slotReplaced' }
    })
    await vi.waitFor(() =>
      expect(useProjectionStore.getState().cardSlotsV2[workspaceId]?.progress?.slotRevision).toBe(1)
    )
    expect(getWorkspaceCardSlotV2).toHaveBeenCalledTimes(1)
    expect(getWorkspaceCardSlotV2).toHaveBeenCalledWith({ workspaceId, kind: 'progress' })

    getWorkspaceCardSlotV2.mockResolvedValue({
      workspaceId,
      kind: 'progress',
      slotRevision: 0,
      payload: null
    })
    await useProjectionStore.getState().refreshWorkspaceCardSlotV2(workspaceId, 'progress')
    expect(useProjectionStore.getState().cardSlotsV2[workspaceId]?.progress?.slotRevision).toBe(1)
  })

  it('queues v2 invalidation before identity and never installs the stale initial snapshot', async () => {
    type Listener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotV2Event']>>[0]
    const identity = deferred<IdentifyResult>()
    const staleInitial = deferred<WorkspaceCardSlotV2Snapshot>()
    const latest = deferred<WorkspaceCardSlotV2Snapshot>()
    let listener: Listener | undefined
    let progressRequests = 0
    const bridge = createBridge()
    const workspaceId = projectionFixture.workspaces[0]!.id
    vi.mocked(bridge.identify).mockReturnValue(identity.promise)
    bridge.onWorkspaceCardSlotV2Event = vi.fn((next: Listener) => {
      listener = next
      return () => undefined
    })
    bridge.getWorkspaceCardSlotV2 = vi.fn(
      ({
        workspaceId: requestedWorkspaceId,
        kind
      }: WorkspaceCardSlotV2GetParams): Promise<WorkspaceCardSlotV2Snapshot> => {
        if (kind === 'progress') {
          progressRequests += 1
          return progressRequests === 1 ? staleInitial.promise : latest.promise
        }
        return Promise.resolve({
          workspaceId: requestedWorkspaceId,
          kind,
          slotRevision: 0,
          payload: null
        })
      }
    )

    const initialization = useProjectionStore.getState().initialize(bridge)
    listener?.({
      event: 'workspace.cardSlots.v2Changed',
      data: { workspaceId, kind: 'progress', slotRevision: 2, reason: 'slotReplaced' }
    })
    identity.resolve({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: ['card-slots-v2']
    })
    await vi.waitFor(() => expect(progressRequests).toBe(1))
    staleInitial.resolve({
      workspaceId,
      kind: 'progress',
      slotRevision: 1,
      payload: {
        kind: 'progress',
        value: { mode: 'determinate', value: 10, label: 'Stale' }
      }
    })
    await initialization

    expect(useProjectionStore.getState().cardSlotsV2[workspaceId]?.progress).toBeUndefined()
    expect(progressRequests).toBe(2)

    latest.resolve({
      workspaceId,
      kind: 'progress',
      slotRevision: 2,
      payload: {
        kind: 'progress',
        value: { mode: 'determinate', value: 50, label: 'Latest' }
      }
    })
    await vi.waitFor(() =>
      expect(useProjectionStore.getState().cardSlotsV2[workspaceId]?.progress?.slotRevision).toBe(2)
    )
  })

  it('does not call attention APIs when the service lacks attention-v1', async () => {
    const bridge = createBridge()
    bridge.getWorkspaceAttention = vi.fn()
    bridge.acknowledgeAttention = vi.fn()

    await useProjectionStore.getState().initialize(bridge)

    expect(useProjectionStore.getState().status).toBe('ready')
    expect(bridge.getWorkspaceAttention).not.toHaveBeenCalled()
    expect(bridge.acknowledgeAttention).not.toHaveBeenCalled()
  })

  it('bounds failed attention refetch retries and recovers on a later invalidation', async () => {
    vi.useFakeTimers()
    type AttentionListener = Parameters<NonNullable<DesktopBridge['onWorkspaceAttentionEvent']>>[0]
    let attentionListener: AttentionListener | undefined
    const bridge = createBridge()
    vi.mocked(bridge.identify).mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: ['attention-v1']
    })
    const getWorkspaceAttention = vi.fn((): Promise<WorkspaceAttentionSnapshot> =>
      Promise.reject(new Error('temporary failure'))
    )
    bridge.getWorkspaceAttention = getWorkspaceAttention
    bridge.onWorkspaceAttentionEvent = vi.fn((listener: AttentionListener): (() => void) => {
      attentionListener = listener
      return () => undefined
    })

    await useProjectionStore.getState().initialize(bridge)
    await vi.runAllTimersAsync()
    expect(getWorkspaceAttention.mock.calls.length).toBeLessThanOrEqual(5)

    const workspaceId = projectionFixture.workspaces[0]!.id
    getWorkspaceAttention.mockResolvedValue({
      workspaceId,
      revision: 1,
      state: 'completed',
      reason: 'agentCompleted',
      unreadCount: 0
    })
    attentionListener?.({
      event: 'workspace.attentionChanged',
      data: { workspaceId, attentionRevision: 1, reason: 'sourcesChanged' }
    })
    await vi.waitFor(() =>
      expect(useProjectionStore.getState().attention[workspaceId]?.revision).toBe(1)
    )
  })

  it('never rolls attention backward when an ack or replay resolves after a newer refetch', async () => {
    type AttentionListener = Parameters<NonNullable<DesktopBridge['onWorkspaceAttentionEvent']>>[0]
    let attentionListener: AttentionListener | undefined
    const workspaceId = projectionFixture.workspaces[0]!.id
    const bridge = createBridge()
    vi.mocked(bridge.identify).mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: ['attention-v1']
    })
    bridge.getWorkspaceAttention = vi
      .fn()
      .mockResolvedValueOnce({
        workspaceId,
        revision: 1,
        state: 'informational',
        reason: 'notificationInfo',
        unreadCount: 1,
        notificationId: notificationFixture.id,
        paneId: notificationFixture.paneId,
        tabId: notificationFixture.tabId
      })
      .mockResolvedValue({
        workspaceId,
        revision: 3,
        state: 'urgent',
        reason: 'agentFailed',
        unreadCount: 0
      })
    bridge.onWorkspaceAttentionEvent = vi.fn((listener: AttentionListener): (() => void) => {
      attentionListener = listener
      return () => undefined
    })
    const ack = deferred<Awaited<ReturnType<NonNullable<DesktopBridge['acknowledgeAttention']>>>>()
    bridge.acknowledgeAttention = vi
      .fn()
      .mockReturnValueOnce(ack.promise)
      .mockResolvedValue({
        revision: 2,
        attention: {
          workspaceId,
          revision: 2,
          state: 'none',
          reason: 'none',
          unreadCount: 0
        }
      })

    await useProjectionStore.getState().initialize(bridge)
    const params = {
      notificationId: notificationFixture.id,
      expectedRevision: 1,
      idempotencyKey: '70000000-0000-4000-8000-000000000001',
      mode: 'focused' as const
    }
    const pendingAck = useProjectionStore.getState().acknowledgeAttention(params)
    attentionListener?.({
      event: 'workspace.attentionChanged',
      data: { workspaceId, attentionRevision: 3, reason: 'sourcesChanged' }
    })
    await vi.waitFor(() =>
      expect(useProjectionStore.getState().attention[workspaceId]?.revision).toBe(3)
    )
    ack.resolve({
      revision: 2,
      attention: {
        workspaceId,
        revision: 2,
        state: 'none',
        reason: 'none',
        unreadCount: 0
      }
    })
    await pendingAck
    expect(useProjectionStore.getState().attention[workspaceId]?.revision).toBe(3)

    await useProjectionStore.getState().acknowledgeAttention(params)
    expect(useProjectionStore.getState().attention[workspaceId]?.revision).toBe(3)
  })

  it('boots from authoritative projections and refreshes on invalidation', async () => {
    let domainListener: Parameters<DesktopBridge['onDomainEvent']>[0] | undefined
    const bridge = createBridge()
    vi.mocked(bridge.onDomainEvent).mockImplementation((listener) => {
      domainListener = listener
      return () => undefined
    })

    await useProjectionStore.getState().initialize(bridge)
    expect(useProjectionStore.getState().snapshot?.revision).toBe(42)
    expect(useProjectionStore.getState().settings?.shortcuts).toHaveLength(12)

    domainListener?.(workspaceChangedAt(43))
    await vi.waitFor(() => expect(bridge.listWorkspaces).toHaveBeenCalledTimes(2))
  })

  it('fetches only the affected card-slot projection on targeted invalidation', async () => {
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const bridge = createBridge()
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    const workspaceId = projectionFixture.workspaces[0]!.id
    vi.mocked(bridge.listWorkspaces).mockClear()
    vi.mocked(bridge.getWorkspaceCardSlots!).mockClear()
    vi.mocked(bridge.getWorkspaceCardSlots!).mockResolvedValue({
      workspaceId,
      revision: 1,
      agentStatus: { status: 'running', label: 'Reviewing changes' },
      progress: { mode: 'determinate', value: 40, label: 'Tests' }
    })

    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 1, reason: 'slotsReplaced' }
    })

    await vi.waitFor(() =>
      expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(1)
    )
    expect(bridge.getWorkspaceCardSlots).toHaveBeenCalledWith({ workspaceId })
    expect(bridge.listWorkspaces).not.toHaveBeenCalled()
  })

  it('retains an invalidation until a newly discovered workspace is projected', async () => {
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const bridge = createBridge()
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)

    const workspaceId = '10000000-0000-4000-8000-000000000099'
    const newWorkspace = { ...projectionFixture.workspaces[0]!, id: workspaceId }
    vi.mocked(bridge.listWorkspaces).mockResolvedValue({
      snapshot: {
        ...projectionFixture,
        revision: projectionFixture.revision + 1,
        workspaces: [...projectionFixture.workspaces, newWorkspace]
      }
    })
    vi.mocked(bridge.getWorkspaceCardSlots!).mockImplementation(({ workspaceId: requestedId }) =>
      Promise.resolve({
        workspaceId: requestedId,
        revision: requestedId === workspaceId ? 1 : 0,
        agentStatus: requestedId === workspaceId ? { status: 'running', label: 'Starting' } : null,
        progress: null
      })
    )

    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 1, reason: 'slotsReplaced' }
    })
    await useProjectionStore.getState().refresh()

    await vi.waitFor(() =>
      expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(1)
    )
  })

  it('merges an invalidation that races initialization by slot revision', async () => {
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const initialSlots =
      deferred<Awaited<ReturnType<NonNullable<DesktopBridge['getWorkspaceCardSlots']>>>>()
    const bridge = createBridge()
    const workspaceId = projectionFixture.workspaces[0]!.id
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    vi.mocked(bridge.getWorkspaceCardSlots!)
      .mockImplementationOnce(() => initialSlots.promise)
      .mockResolvedValue({
        workspaceId,
        revision: 2,
        agentStatus: { status: 'running', label: 'Current' },
        progress: null
      })

    const initialization = useProjectionStore.getState().initialize(bridge)
    await vi.waitFor(() => expect(bridge.getWorkspaceCardSlots).toHaveBeenCalledTimes(1))
    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 2, reason: 'slotsReplaced' }
    })
    initialSlots.resolve({
      workspaceId,
      revision: 1,
      agentStatus: { status: 'running', label: 'Stale' },
      progress: null
    })
    await initialization

    await vi.waitFor(() =>
      expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(2)
    )
  })

  it('does not let stale initialization undo a newer workspace projection', async () => {
    vi.useFakeTimers()
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const initialSlots =
      deferred<Awaited<ReturnType<NonNullable<DesktopBridge['getWorkspaceCardSlots']>>>>()
    const eventSlots =
      deferred<Awaited<ReturnType<NonNullable<DesktopBridge['getWorkspaceCardSlots']>>>>()
    const bridge = createBridge()
    const existingWorkspaceId = projectionFixture.workspaces[0]!.id
    const workspaceId = '10000000-0000-4000-8000-000000000099'
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    vi.mocked(bridge.getWorkspaceCardSlots!)
      .mockImplementationOnce(() => initialSlots.promise)
      .mockImplementationOnce(() => eventSlots.promise)
      .mockResolvedValue({
        workspaceId,
        revision: 2,
        agentStatus: { status: 'running', label: 'Still stale' },
        progress: null
      })

    const initialization = useProjectionStore.getState().initialize(bridge)
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.getWorkspaceCardSlots).toHaveBeenCalledTimes(1)
    const currentSnapshot = {
      ...projectionFixture,
      revision: projectionFixture.revision + 2,
      workspaces: [
        ...projectionFixture.workspaces,
        { ...projectionFixture.workspaces[0]!, id: workspaceId }
      ]
    }
    useProjectionStore.setState({
      cardSlots: {
        [existingWorkspaceId]: {
          workspaceId: existingWorkspaceId,
          revision: 0,
          agentStatus: null,
          progress: null
        },
        [workspaceId]: {
          workspaceId,
          revision: 1,
          agentStatus: { status: 'running', label: 'Current workspace' },
          progress: null
        }
      }
    })
    useProjectionStore.getState().applyMutation({
      revision: currentSnapshot.revision,
      snapshot: currentSnapshot
    })
    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 3, reason: 'slotsReplaced' }
    })

    initialSlots.resolve({
      workspaceId: existingWorkspaceId,
      revision: 0,
      agentStatus: null,
      progress: null
    })
    await initialization
    eventSlots.resolve({
      workspaceId,
      revision: 2,
      agentStatus: { status: 'running', label: 'Stale event read' },
      progress: null
    })
    await vi.advanceTimersByTimeAsync(50)

    expect(useProjectionStore.getState().snapshot?.revision).toBe(currentSnapshot.revision)
    expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(1)
    expect(bridge.getWorkspaceCardSlots).toHaveBeenCalledTimes(4)
  })

  it('recovers capability projections after a mutation supersedes initialization', async () => {
    const initialSlots =
      deferred<Awaited<ReturnType<NonNullable<DesktopBridge['getWorkspaceCardSlots']>>>>()
    const bridge = createBridge()
    const workspaceId = projectionFixture.workspaces[0]!.id
    vi.mocked(bridge.identify).mockResolvedValue(identityWith('workspace-groups-v1'))
    vi.mocked(bridge.getWorkspaceCardSlots!).mockImplementationOnce(() => initialSlots.promise)
    bridge.getWorkspaceOrganization = vi.fn().mockResolvedValue({ organization: organizationAt(7) })

    const initialization = useProjectionStore.getState().initialize(bridge)
    await vi.waitFor(() => expect(bridge.getWorkspaceCardSlots).toHaveBeenCalledOnce())

    const currentSnapshot = snapshotAt(projectionFixture.revision + 1)
    useProjectionStore.getState().applyMutation({
      revision: currentSnapshot.revision,
      snapshot: currentSnapshot
    })
    initialSlots.resolve({
      workspaceId,
      revision: 0,
      agentStatus: null,
      progress: null
    })
    await initialization

    await vi.waitFor(() => expect(useProjectionStore.getState().organization?.revision).toBe(7))
    expect(useProjectionStore.getState().snapshot?.revision).toBe(currentSnapshot.revision)
  })

  it('retries a targeted card-slot invalidation after a transient fetch failure', async () => {
    vi.useFakeTimers()
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const bridge = createBridge()
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    const workspaceId = projectionFixture.workspaces[0]!.id
    vi.mocked(bridge.getWorkspaceCardSlots!).mockClear()
    vi.mocked(bridge.getWorkspaceCardSlots!)
      .mockRejectedValueOnce(new Error('temporary transport failure'))
      .mockResolvedValue({
        workspaceId,
        revision: 1,
        agentStatus: { status: 'waiting', label: 'Recovered' },
        progress: null
      })

    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 1, reason: 'slotsReplaced' }
    })
    await vi.advanceTimersByTimeAsync(50)

    expect(bridge.getWorkspaceCardSlots).toHaveBeenCalledTimes(2)
    expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(1)
  })

  it('accepts reset card-slot revisions after service reinitialization', async () => {
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const bridge = createBridge()
    const workspaceId = projectionFixture.workspaces[0]!.id
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    vi.mocked(bridge.getWorkspaceCardSlots!).mockResolvedValue({
      workspaceId,
      revision: 10,
      agentStatus: { status: 'running', label: 'Before restart' },
      progress: null
    })
    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 10, reason: 'slotsReplaced' }
    })
    await vi.waitFor(() =>
      expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(10)
    )

    vi.mocked(bridge.getWorkspaceCardSlots!).mockResolvedValue({
      workspaceId,
      revision: 0,
      agentStatus: null,
      progress: null
    })
    await useProjectionStore.getState().initialize(bridge)

    expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(0)
  })

  it('does not retry a card-slot fetch that completes after its workspace closes', async () => {
    vi.useFakeTimers()
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const slotsRequest =
      deferred<Awaited<ReturnType<NonNullable<DesktopBridge['getWorkspaceCardSlots']>>>>()
    const bridge = createBridge()
    const workspaceId = projectionFixture.workspaces[0]!.id
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    vi.mocked(bridge.getWorkspaceCardSlots!).mockClear()
    vi.mocked(bridge.getWorkspaceCardSlots!).mockReturnValue(slotsRequest.promise)

    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 1, reason: 'slotsReplaced' }
    })
    const closedSnapshot = {
      ...projectionFixture,
      revision: projectionFixture.revision + 1,
      workspaces: projectionFixture.workspaces.filter(({ id }) => id !== workspaceId)
    }
    useProjectionStore.getState().applyMutation({
      revision: closedSnapshot.revision,
      snapshot: closedSnapshot
    })
    slotsRequest.resolve({
      workspaceId,
      revision: 1,
      agentStatus: { status: 'completed', label: null },
      progress: null
    })
    await vi.runAllTimersAsync()

    expect(bridge.getWorkspaceCardSlots).toHaveBeenCalledTimes(1)
    expect(useProjectionStore.getState().cardSlots[workspaceId]).toBeUndefined()
  })

  it('drops a queued invalidation when an authoritative refresh confirms no workspace', async () => {
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const bridge = createBridge()
    const workspaceId = '10000000-0000-4000-8000-000000000099'
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 4, reason: 'slotsReplaced' }
    })
    await useProjectionStore.getState().refresh()

    vi.mocked(bridge.listWorkspaces).mockResolvedValue({
      snapshot: {
        ...projectionFixture,
        revision: projectionFixture.revision + 1,
        workspaces: [
          ...projectionFixture.workspaces,
          { ...projectionFixture.workspaces[0]!, id: workspaceId }
        ]
      }
    })
    vi.mocked(bridge.getWorkspaceCardSlots!).mockImplementation(({ workspaceId: requestedId }) =>
      Promise.resolve({
        workspaceId: requestedId,
        revision: 0,
        agentStatus: null,
        progress: null
      })
    )
    await useProjectionStore.getState().refresh()

    await vi.waitFor(() =>
      expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(0)
    )
  })

  it('does not let a stale workspace list clear a newer queued slot revision', async () => {
    vi.useFakeTimers()
    type CardSlotListener = Parameters<NonNullable<DesktopBridge['onWorkspaceCardSlotsEvent']>>[0]
    let cardSlotListener: CardSlotListener | undefined
    const firstSlotsRequest =
      deferred<Awaited<ReturnType<NonNullable<DesktopBridge['getWorkspaceCardSlots']>>>>()
    const bridge = createBridge()
    const workspaceId = '10000000-0000-4000-8000-000000000099'
    vi.mocked(bridge.onWorkspaceCardSlotsEvent!).mockImplementation((listener) => {
      cardSlotListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    useProjectionStore.setState((state) => ({
      cardSlots: {
        ...state.cardSlots,
        [workspaceId]: {
          workspaceId,
          revision: 0,
          agentStatus: null,
          progress: null
        }
      }
    }))
    const currentSnapshot = {
      ...projectionFixture,
      revision: projectionFixture.revision + 2,
      workspaces: [
        ...projectionFixture.workspaces,
        { ...projectionFixture.workspaces[0]!, id: workspaceId }
      ]
    }
    useProjectionStore.getState().applyMutation({
      revision: currentSnapshot.revision,
      snapshot: currentSnapshot
    })
    vi.mocked(bridge.getWorkspaceCardSlots!).mockClear()
    vi.mocked(bridge.getWorkspaceCardSlots!)
      .mockReturnValueOnce(firstSlotsRequest.promise)
      .mockResolvedValue({
        workspaceId,
        revision: 1,
        agentStatus: { status: 'running', label: 'Still stale' },
        progress: null
      })
    cardSlotListener?.({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId, slotRevision: 2, reason: 'slotsReplaced' }
    })

    vi.mocked(bridge.listWorkspaces).mockResolvedValue({ snapshot: projectionFixture })
    await useProjectionStore.getState().refresh()
    firstSlotsRequest.resolve({
      workspaceId,
      revision: 1,
      agentStatus: { status: 'running', label: 'Stale' },
      progress: null
    })
    await vi.advanceTimersByTimeAsync(50)

    expect(useProjectionStore.getState().snapshot?.revision).toBe(currentSnapshot.revision)
    expect(useProjectionStore.getState().cardSlots[workspaceId]?.revision).toBe(0)
    expect(bridge.getWorkspaceCardSlots).toHaveBeenCalledTimes(2)
  })

  it('clears orphan card slots when a workspace closes', async () => {
    const bridge = createBridge()
    await useProjectionStore.getState().initialize(bridge)
    const removedId = '10000000-0000-4000-8000-000000000099'
    useProjectionStore.setState((state) => ({
      cardSlots: {
        ...state.cardSlots,
        [removedId]: {
          workspaceId: removedId,
          revision: 1,
          agentStatus: { status: 'completed', label: null },
          progress: null
        }
      }
    }))
    expect(useProjectionStore.getState().cardSlots[removedId]).toBeDefined()
    const snapshot = {
      ...projectionFixture,
      revision: 43
    }
    useProjectionStore.getState().applyMutation({ revision: 43, snapshot })
    expect(useProjectionStore.getState().cardSlots[removedId]).toBeUndefined()
  })

  it('coalesces domain event bursts while retaining a bounded created-event feed', async () => {
    vi.useFakeTimers()
    let domainListener: Parameters<DesktopBridge['onDomainEvent']>[0] | undefined
    const bridge = createBridge()
    vi.mocked(bridge.onDomainEvent).mockImplementation((listener) => {
      domainListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)

    for (let index = 1; index <= 25; index += 1) {
      domainListener?.(notificationCreatedAt(index))
    }
    expect(bridge.listWorkspaces).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(20)

    expect(bridge.listWorkspaces).toHaveBeenCalledTimes(2)
    expect(bridge.listNotifications).toHaveBeenCalledTimes(2)
    expect(useProjectionStore.getState().recentNotificationEvents).toHaveLength(20)
    expect(useProjectionStore.getState().recentNotificationEvents[0]?.title).toBe('Notification 25')
  })

  it('retries a structural invalidation until the event revision removes a closed browser', async () => {
    vi.useFakeTimers()
    let domainListener: Parameters<DesktopBridge['onDomainEvent']>[0] | undefined
    const bridge = createBridge()
    vi.mocked(bridge.onDomainEvent).mockImplementation((listener) => {
      domainListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    expect(
      useProjectionStore
        .getState()
        .snapshot?.workspaces.flatMap(({ tabs }) => tabs)
        .filter(({ content }) => content.kind === 'browser')
    ).toHaveLength(1)

    const closedSnapshot: ApplicationSnapshot = {
      ...projectionFixture,
      revision: projectionFixture.revision + 1,
      workspaces: []
    }
    vi.mocked(bridge.listWorkspaces).mockClear()
    vi.mocked(bridge.listWorkspaces)
      .mockRejectedValueOnce(new Error('temporary post-storm transport failure'))
      .mockResolvedValue({ snapshot: closedSnapshot })

    domainListener?.(workspaceChangedAt(closedSnapshot.revision))
    await vi.advanceTimersByTimeAsync(20)
    expect(bridge.listWorkspaces).toHaveBeenCalledOnce()
    expect(useProjectionStore.getState().snapshot?.revision).toBe(projectionFixture.revision)

    await vi.advanceTimersByTimeAsync(50)
    expect(bridge.listWorkspaces).toHaveBeenCalledTimes(2)
    expect(useProjectionStore.getState()).toMatchObject({
      status: 'ready',
      error: null,
      snapshot: { revision: closedSnapshot.revision, workspaces: [] }
    })
  })

  it('cancels pending event refreshes and subscriptions when reinitialized', async () => {
    vi.useFakeTimers()
    let domainListener: Parameters<DesktopBridge['onDomainEvent']>[0] | undefined
    const removeDomainListener = vi.fn()
    const firstBridge = createBridge()
    vi.mocked(firstBridge.onDomainEvent).mockImplementation((listener) => {
      domainListener = listener
      return removeDomainListener
    })
    await useProjectionStore.getState().initialize(firstBridge)
    domainListener?.(workspaceChangedAt(43))

    const secondBridge = createBridge()
    await useProjectionStore.getState().initialize(secondBridge)
    await vi.advanceTimersByTimeAsync(20)

    expect(removeDomainListener).toHaveBeenCalledOnce()
    expect(firstBridge.listWorkspaces).toHaveBeenCalledTimes(1)
    expect(secondBridge.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('keeps notification lists monotonic across late responses', async () => {
    const bridge = createBridge()
    await useProjectionStore.getState().initialize(bridge)
    const stale = deferred<NotificationListResult>()
    vi.mocked(bridge.listNotifications!)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(notificationListAt(46, []))

    const staleRefresh = useProjectionStore.getState().refreshNotifications()
    await useProjectionStore.getState().refreshNotifications()
    stale.resolve(notificationListAt(43, [notificationFixture]))
    await staleRefresh

    expect(useProjectionStore.getState().notifications).toMatchObject({
      revision: 46,
      notifications: []
    })
  })

  it('loads retained history beyond the first 200 records', async () => {
    const history = notificationRange(250)
    const bridge = createBridge()
    vi.mocked(bridge.listNotifications!).mockImplementation((params = {}) => {
      const offset = params.offset ?? 0
      const limit = params.limit ?? 50
      return Promise.resolve({
        revision: 50,
        notifications: history.slice(offset, offset + limit),
        total: history.length,
        unreadCount: history.length
      })
    })

    await useProjectionStore.getState().initialize(bridge)
    expect(useProjectionStore.getState().notifications?.notifications).toHaveLength(200)

    await useProjectionStore.getState().loadMoreNotifications()

    expect(useProjectionStore.getState().notifications).toMatchObject({
      revision: 50,
      total: 250,
      unreadCount: 250
    })
    expect(useProjectionStore.getState().notifications?.notifications).toHaveLength(250)
    expect(bridge.listNotifications).toHaveBeenCalledWith({ offset: 200, limit: 50 })
  })

  it('retries the same history page after a failed load and advances once after recovery', async () => {
    const history = notificationRange(450)
    const bridge = createBridge()
    let rejectNextPage = true
    vi.mocked(bridge.listNotifications!).mockImplementation((params = {}) => {
      const offset = params.offset ?? 0
      const limit = params.limit ?? 50
      if (offset === 200 && rejectNextPage) {
        rejectNextPage = false
        return Promise.reject(new Error('history unavailable'))
      }
      return Promise.resolve({
        revision: 50,
        notifications: history.slice(offset, offset + limit),
        total: history.length,
        unreadCount: history.length
      })
    })

    await useProjectionStore.getState().initialize(bridge)
    expect(useProjectionStore.getState().notifications?.notifications).toHaveLength(200)
    vi.mocked(bridge.listNotifications!).mockClear()

    await expect(useProjectionStore.getState().loadMoreNotifications()).rejects.toThrow(
      'history unavailable'
    )
    useProjectionStore.getState().reportMutationError(new Error('history unavailable'))

    expect(vi.mocked(bridge.listNotifications!).mock.calls).toEqual([
      [{ offset: 0, limit: 200 }],
      [{ offset: 200, limit: 200 }]
    ])
    expect(useProjectionStore.getState()).toMatchObject({
      mutationError: messages.workspaceProjection.errors.changeFailed,
      notificationHistoryLoading: false
    })

    vi.mocked(bridge.listNotifications!).mockClear()
    await useProjectionStore.getState().loadMoreNotifications()

    expect(vi.mocked(bridge.listNotifications!).mock.calls).toEqual([
      [{ offset: 0, limit: 200 }],
      [{ offset: 200, limit: 200 }]
    ])
    expect(useProjectionStore.getState()).toMatchObject({
      mutationError: null,
      notificationHistoryLoading: false
    })
    expect(useProjectionStore.getState().notifications?.notifications.map(({ id }) => id)).toEqual(
      history.slice(0, 400).map(({ id }) => id)
    )

    vi.mocked(bridge.listNotifications!).mockClear()
    await useProjectionStore.getState().loadMoreNotifications()

    expect(vi.mocked(bridge.listNotifications!).mock.calls).toEqual([
      [{ offset: 0, limit: 200 }],
      [{ offset: 200, limit: 200 }],
      [{ offset: 400, limit: 50 }]
    ])
    expect(useProjectionStore.getState().notifications?.notifications).toHaveLength(450)
  })

  it('ignores history from a stale connection without clearing a current mutation error', async () => {
    const history = notificationRange(450)
    const stalePage = deferred<NotificationListResult>()
    const firstBridge = createBridge()
    vi.mocked(firstBridge.listNotifications!).mockImplementation((params = {}) => {
      const offset = params.offset ?? 0
      const limit = params.limit ?? 50
      if (offset === 200) return stalePage.promise
      return Promise.resolve({
        revision: 50,
        notifications: history.slice(offset, offset + limit),
        total: history.length,
        unreadCount: history.length
      })
    })

    await useProjectionStore.getState().initialize(firstBridge)
    const staleLoad = useProjectionStore.getState().loadMoreNotifications()
    await vi.waitFor(() =>
      expect(firstBridge.listNotifications).toHaveBeenCalledWith({ offset: 200, limit: 200 })
    )

    const secondBridge = createBridge()
    vi.mocked(secondBridge.listNotifications!).mockImplementation((params = {}) => {
      const offset = params.offset ?? 0
      const limit = params.limit ?? 50
      return Promise.resolve({
        revision: 51,
        notifications: history.slice(offset, offset + limit),
        total: history.length,
        unreadCount: history.length
      })
    })
    await useProjectionStore.getState().initialize(secondBridge)
    useProjectionStore.getState().reportMutationError(new Error('current connection error'))
    stalePage.resolve({
      revision: 50,
      notifications: history.slice(200, 400),
      total: history.length,
      unreadCount: history.length
    })
    await staleLoad

    expect(useProjectionStore.getState()).toMatchObject({
      mutationError: messages.workspaceProjection.errors.changeFailed,
      notificationHistoryLoading: false
    })
    expect(useProjectionStore.getState().notifications?.notifications).toHaveLength(200)

    vi.mocked(secondBridge.listNotifications!).mockClear()
    await useProjectionStore.getState().loadMoreNotifications()
    expect(vi.mocked(secondBridge.listNotifications!).mock.calls).toEqual([
      [{ offset: 0, limit: 200 }],
      [{ offset: 200, limit: 200 }]
    ])
  })

  it('restarts a paged read when the authoritative revision changes between pages', async () => {
    const history = notificationRange(250)
    const page = (revision: number, offset: number, limit: number): NotificationListResult => ({
      revision,
      notifications: history.slice(offset, offset + limit),
      total: history.length,
      unreadCount: history.length
    })
    const bridge = createBridge()
    vi.mocked(bridge.listNotifications!)
      .mockResolvedValueOnce(page(50, 0, 200))
      .mockResolvedValueOnce(page(50, 0, 200))
      .mockResolvedValueOnce(page(51, 200, 50))
      .mockResolvedValueOnce(page(51, 0, 200))
      .mockResolvedValueOnce(page(51, 200, 50))

    await useProjectionStore.getState().initialize(bridge)
    await useProjectionStore.getState().loadMoreNotifications()

    expect(useProjectionStore.getState().notifications).toMatchObject({
      revision: 51,
      total: 250
    })
    expect(useProjectionStore.getState().notifications?.notifications).toHaveLength(250)
  })

  it('waits for the server mutation and authoritative list before changing notification state', async () => {
    const bridge = createBridge()
    await useProjectionStore.getState().initialize(bridge)
    const mutation = deferred<{ revision: number; snapshot: ApplicationSnapshot }>()
    vi.mocked(bridge.markNotificationRead!).mockReturnValueOnce(mutation.promise)
    vi.mocked(bridge.listNotifications!).mockResolvedValueOnce({
      ...notificationListAt(43, [{ ...notificationFixture, readAt: 1300 }]),
      unreadCount: 0
    })

    const marking = useProjectionStore
      .getState()
      .markNotificationRead({ notificationId: notificationFixture.id })
    expect(useProjectionStore.getState().notifications?.notifications[0]?.readAt).toBeUndefined()

    mutation.resolve({ revision: 43, snapshot: snapshotAt(43) })
    await marking

    expect(bridge.markNotificationRead).toHaveBeenCalledWith({
      notificationId: notificationFixture.id
    })
    expect(useProjectionStore.getState().notifications).toMatchObject({
      revision: 43,
      unreadCount: 0,
      notifications: [{ readAt: 1300 }]
    })
    expect(useProjectionStore.getState().snapshot?.revision).toBe(43)
  })

  it('does not replace a newer mutation projection with a stale refresh', async () => {
    const bridge = createBridge()
    await useProjectionStore.getState().initialize(bridge)
    useProjectionStore.getState().applyMutation({
      revision: 44,
      snapshot: { ...projectionFixture, revision: 44 }
    })

    await useProjectionStore.getState().refresh()
    expect(useProjectionStore.getState().snapshot?.revision).toBe(44)
  })

  it('does not let initialization overwrite a newer refresh', async () => {
    const initialWorkspaces = deferred<{ snapshot: ApplicationSnapshot }>()
    const initialSettings = deferred<SettingsGetResult>()
    const bridge = createBridge()
    vi.mocked(bridge.listWorkspaces)
      .mockReturnValueOnce(initialWorkspaces.promise)
      .mockResolvedValueOnce({ snapshot: snapshotAt(44) })
    vi.mocked(bridge.getSettings)
      .mockReturnValueOnce(initialSettings.promise)
      .mockResolvedValueOnce(settingsAt(45))

    const initialization = useProjectionStore.getState().initialize(bridge)
    await useProjectionStore.getState().refresh()
    initialWorkspaces.resolve({ snapshot: snapshotAt(42) })
    initialSettings.resolve(settingsAt(42))
    await initialization

    expect(useProjectionStore.getState()).toMatchObject({
      status: 'ready',
      snapshot: { revision: 44 },
      settings: { revision: 45 }
    })
  })

  it('does not let a late initialization failure override a newer mutation', async () => {
    const initialWorkspaces = deferred<{ snapshot: ApplicationSnapshot }>()
    const bridge = createBridge()
    vi.mocked(bridge.listWorkspaces).mockReturnValueOnce(initialWorkspaces.promise)

    const initialization = useProjectionStore.getState().initialize(bridge)
    useProjectionStore.getState().applyMutation({ revision: 45, snapshot: snapshotAt(45) })
    initialWorkspaces.reject(new Error('stale initialization failure'))
    await initialization

    expect(useProjectionStore.getState()).toMatchObject({
      status: 'ready',
      error: null,
      snapshot: { revision: 45 }
    })
  })

  it('keeps both projection streams monotonic across out-of-order refreshes', async () => {
    const bridge = createBridge()
    await useProjectionStore.getState().initialize(bridge)
    const olderWorkspaces = deferred<{ snapshot: ApplicationSnapshot }>()
    const olderSettings = deferred<SettingsGetResult>()
    vi.mocked(bridge.listWorkspaces)
      .mockReturnValueOnce(olderWorkspaces.promise)
      .mockResolvedValueOnce({ snapshot: snapshotAt(46) })
    vi.mocked(bridge.getSettings)
      .mockReturnValueOnce(olderSettings.promise)
      .mockResolvedValueOnce(settingsAt(47))

    const olderRefresh = useProjectionStore.getState().refresh()
    await useProjectionStore.getState().refresh()
    olderWorkspaces.resolve({ snapshot: snapshotAt(43) })
    olderSettings.resolve(settingsAt(44))
    await olderRefresh

    expect(useProjectionStore.getState().snapshot?.revision).toBe(46)
    expect(useProjectionStore.getState().settings?.revision).toBe(47)
  })

  it('accepts newer snapshot and settings revisions independently', async () => {
    const bridge = createBridge()
    await useProjectionStore.getState().initialize(bridge)
    vi.mocked(bridge.listWorkspaces).mockResolvedValueOnce({ snapshot: snapshotAt(48) })
    vi.mocked(bridge.getSettings).mockResolvedValueOnce(settingsAt(41))

    await useProjectionStore.getState().refresh()

    expect(useProjectionStore.getState().snapshot?.revision).toBe(48)
    expect(useProjectionStore.getState().settings?.revision).toBe(42)
  })

  it('ignores a stale refresh rejection after a newer request is ready', async () => {
    const bridge = createBridge()
    await useProjectionStore.getState().initialize(bridge)
    const staleWorkspaces = deferred<{ snapshot: ApplicationSnapshot }>()
    vi.mocked(bridge.listWorkspaces)
      .mockReturnValueOnce(staleWorkspaces.promise)
      .mockResolvedValueOnce({ snapshot: snapshotAt(49) })
    vi.mocked(bridge.getSettings)
      .mockResolvedValueOnce(settingsAt(43))
      .mockResolvedValueOnce(settingsAt(49))

    const staleRefresh = useProjectionStore.getState().refresh()
    await useProjectionStore.getState().refresh()
    staleWorkspaces.reject(new Error('stale network failure'))
    await staleRefresh

    expect(useProjectionStore.getState()).toMatchObject({
      status: 'ready',
      error: null,
      snapshot: { revision: 49 },
      settings: { revision: 49 }
    })
  })

  it('keeps shutdown errors terminal while clearing mutation errors on success', async () => {
    let serviceListener: Parameters<DesktopBridge['onServiceEvent']>[0] | undefined
    const bridge = createBridge()
    vi.mocked(bridge.onServiceEvent).mockImplementation((listener) => {
      serviceListener = listener
      return () => undefined
    })
    await useProjectionStore.getState().initialize(bridge)
    useProjectionStore.getState().reportMutationError(new Error('rename failed'))
    serviceListener?.({ data: { reason: 'private maintenance detail' } } as never)
    useProjectionStore.getState().applyMutation({
      revision: 50,
      snapshot: snapshotAt(50)
    })

    expect(useProjectionStore.getState()).toMatchObject({
      status: 'error',
      error: messages.workspaceProjection.errors.shuttingDown(),
      mutationError: null,
      snapshot: { revision: 50 }
    })
  })

  it('maps known service codes and hides unknown initialization and mutation details', async () => {
    const bridge = createBridge()
    vi.mocked(bridge.listWorkspaces).mockRejectedValueOnce(
      Object.assign(new Error('private stale revision detail'), { code: 'revision_conflict' })
    )

    await useProjectionStore.getState().initialize(bridge)
    expect(useProjectionStore.getState().error).toBe(
      messages.workspaceProjection.errors.revisionConflict
    )

    useProjectionStore
      .getState()
      .reportMutationError(new Error('token=private-service-error-detail'))
    expect(useProjectionStore.getState().mutationError).toBe(
      messages.workspaceProjection.errors.changeFailed
    )
  })
})

function snapshotAt(revision: number): ApplicationSnapshot {
  return { ...projectionFixture, revision }
}

function settingsAt(revision: number): SettingsGetResult {
  return { ...settingsFixture, revision }
}

function notificationListAt(
  revision: number,
  notifications: NotificationSnapshot[]
): NotificationListResult {
  return {
    revision,
    notifications,
    total: notifications.length,
    unreadCount: notifications.filter(({ readAt }) => readAt === undefined).length
  }
}

function notificationRange(count: number): NotificationSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    ...notificationFixture,
    id: `notification-${String(index)}`,
    title: `Notification ${String(index)}`,
    createdAt: notificationFixture.createdAt + count - index
  }))
}

function workspaceChangedAt(revision: number): DomainEventMessage {
  return {
    event: 'workspace.changed',
    revision,
    data: {
      revision,
      workspaceIds: [],
      paneIds: [],
      tabIds: [],
      commandIds: [],
      reason: 'test invalidation'
    }
  }
}

function notificationCreatedAt(index: number): DomainEventMessage {
  const suffix = index.toString(16).padStart(12, '0')
  return {
    event: 'notification.created',
    revision: 42 + index,
    data: {
      notification: {
        ...notificationFixture,
        id: `60000000-0000-4000-8000-${suffix}`,
        title: `Notification ${index}`,
        createdAt: notificationFixture.createdAt + index
      }
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function identityWith(...capabilities: string[]): IdentifyResult {
  return {
    application: 'agent-workspace',
    version: '0.1.0',
    protocolVersion: 1,
    capabilities
  }
}

function organizationAt(revision: number) {
  return {
    revision,
    selection: [],
    focusedWorkspaceId: projectionFixture.workspaces[0]!.id,
    pins: [],
    groups: [],
    assignments: []
  }
}

function createBridge(): DesktopBridge {
  const getWorkspaceCardSlots: NonNullable<DesktopBridge['getWorkspaceCardSlots']> = ({
    workspaceId
  }) =>
    Promise.resolve({
      workspaceId,
      revision: 0,
      agentStatus: null,
      progress: null
    })
  return {
    identify: vi.fn().mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: []
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: projectionFixture }),
    snapshotWorkspace: vi.fn(),
    getWorkspaceCardSlots: vi.fn(getWorkspaceCardSlots),
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    selectWorkspace: vi.fn(),
    moveWorkspace: vi.fn(),
    closeWorkspace: vi.fn(),
    splitPane: vi.fn(),
    focusPane: vi.fn(),
    resizePane: vi.fn(),
    closePane: vi.fn(),
    moveTabToPane: vi.fn(),
    openTerminalTab: vi.fn(),
    openBrowserTab: vi.fn(),
    navigateBrowser: vi.fn(),
    browserBack: vi.fn(),
    browserForward: vi.fn(),
    reloadBrowser: vi.fn(),
    stopBrowser: vi.fn(),
    openBrowserDevTools: vi.fn(),
    mountBrowserView: vi.fn(),
    unmountBrowserView: vi.fn(),
    setBrowserBounds: vi.fn(),
    focusBrowserView: vi.fn(),
    selectTab: vi.fn(),
    updateTab: vi.fn(),
    moveTab: vi.fn(),
    closeTab: vi.fn(),
    restartTerminal: vi.fn(),
    listNotifications: vi.fn().mockResolvedValue(notificationListFixture),
    markNotificationRead: vi.fn(),
    markNotificationUnread: vi.fn(),
    clearNotifications: vi.fn(),
    getSettings: vi.fn().mockResolvedValue(settingsFixture),
    updateSettings: vi.fn(),
    resetSettingKey: vi.fn(),
    attachTerminal: vi.fn(),
    detachTerminal: vi.fn(),
    sendTerminalInput: vi.fn(),
    resizeTerminal: vi.fn(),
    checkpointTerminal: vi.fn(),
    openExternal: vi.fn(),
    onTerminalEvent: vi.fn(() => () => undefined),
    onDomainEvent: vi.fn(() => () => undefined),
    onWorkspaceCardSlotsEvent: vi.fn(() => () => undefined),
    onDomainResyncRequired: vi.fn(() => () => undefined),
    onServiceEvent: vi.fn(() => () => undefined)
  }
}
