import {
  attentionAcknowledgementParamsSchema,
  workspaceAttentionSnapshotParamsSchema,
  workspaceAttentionSnapshotSchema,
  workspaceCardSlotV2GetParamsSchema,
  workspaceCardSlotV2ReplaceParamsSchema,
  workspaceCardSlotV2SnapshotSchema,
  workspaceCardSlotsReplaceParamsSchema,
  workspaceCardSlotsSnapshotParamsSchema,
  type AttentionAcknowledgementParams,
  type AttentionAcknowledgementResult,
  type WorkspaceAttentionSnapshot,
  type WorkspaceCardSlotV2Snapshot,
  type WorkspaceCardSlotsSnapshot
} from '@agent-workspace/protocol-client'
import type { DurableApplicationState } from '@agent-workspace/contracts'

const MAX_V2_RESPONSE_BYTES = 16 * 1024
const V2_KINDS: WorkspaceCardSlotV2Snapshot['kind'][] = [
  'agentStatus',
  'progress',
  'pullRequest',
  'metadata',
  'markdown',
  'logTail',
  'task',
  'ssh',
  'media'
]

type V1Replace = Parameters<typeof workspaceCardSlotsReplaceParamsSchema.parse>[0]
type V2Replace = Parameters<typeof workspaceCardSlotV2ReplaceParamsSchema.parse>[0]
type AttentionEvent = {
  event: 'workspace.attentionChanged'
  data: {
    workspaceId: string
    attentionRevision: number
    reason: 'sourcesChanged' | 'resyncRequired'
  }
}
type SlotEvent = {
  event: 'workspace.cardSlotsChanged'
  data: { workspaceId: string; slotRevision: number; reason: 'slotsReplaced' }
}
type SlotV2Event = {
  event: 'workspace.cardSlots.v2Changed'
  data: {
    workspaceId: string
    kind: WorkspaceCardSlotV2Snapshot['kind']
    slotRevision: number
    reason: 'slotReplaced' | 'resyncRequired'
  }
}
export type CardSlotAttentionEvent = AttentionEvent | SlotEvent | SlotV2Event

export class CardSlotAttentionError extends Error {
  constructor(
    public readonly code:
      | 'invalid_params'
      | 'workspace_not_found'
      | 'revision_conflict'
      | 'revision_out_of_range'
      | 'card_slot_too_large'
      | 'notification_not_found'
      | 'attention_target_unavailable'
      | 'attention_target_not_focused'
      | 'attention_already_acknowledged'
      | 'idempotency_conflict'
      | 'runtime_update_failure',
    message: string
  ) {
    super(message)
    this.name = 'CardSlotAttentionError'
  }
}

function fail(code: CardSlotAttentionError['code'], message: string): never {
  throw new CardSlotAttentionError(code, message)
}

function same<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function targetExists(
  state: DurableApplicationState,
  notification: DurableApplicationState['notifications'][number]
): boolean {
  const workspace = state.workspaces.find((item) => item.id === notification.workspaceId)
  if (!workspace) return false
  if (notification.tabId !== null) {
    const tab = workspace.tabs[notification.tabId]
    return !!tab && (notification.paneId === null || notification.paneId === tab.paneId)
  }
  return notification.paneId === null || !!workspace.panes[notification.paneId]
}

function fold(
  state: DurableApplicationState,
  workspaceId: string,
  slots: WorkspaceCardSlotsSnapshot | undefined
): WorkspaceAttentionSnapshot {
  let unreadCount = 0
  let winner: DurableApplicationState['notifications'][number] | undefined
  for (const notification of state.notifications) {
    if (
      notification.workspaceId !== workspaceId ||
      notification.readAt !== null ||
      !targetExists(state, notification)
    )
      continue
    unreadCount += 1
    const priority = notification.level === 'error' ? 4 : 1
    const previous = winner?.level === 'error' ? 4 : winner ? 1 : 0
    if (
      !winner ||
      priority > previous ||
      (priority === previous &&
        (notification.createdAt > winner.createdAt ||
          (notification.createdAt === winner.createdAt && notification.id > winner.id)))
    )
      winner = notification
  }
  const agent = slots?.agentStatus?.status
  const agentPriority =
    agent === 'failed'
      ? 4
      : agent === 'waiting'
        ? 3
        : agent === 'completed'
          ? 2
          : agent === 'running'
            ? 1
            : 0
  if (winner && (winner.level === 'error' ? 4 : 1) >= agentPriority) {
    const workspace = state.workspaces.find((item) => item.id === workspaceId)!
    const paneId =
      winner.paneId ??
      (winner.tabId === null ? null : (workspace.tabs[winner.tabId]?.paneId ?? null))
    return workspaceAttentionSnapshotSchema.parse({
      workspaceId,
      revision: 0,
      state: winner.level === 'error' ? 'urgent' : 'informational',
      reason:
        winner.level === 'error'
          ? 'notificationError'
          : winner.level === 'warning'
            ? 'notificationWarning'
            : 'notificationInfo',
      unreadCount,
      notificationId: winner.id,
      ...(paneId === null ? {} : { paneId }),
      ...(winner.tabId === null ? {} : { tabId: winner.tabId })
    }) as WorkspaceAttentionSnapshot
  }
  const agentState =
    agent === 'failed'
      ? 'urgent'
      : agent === 'waiting'
        ? 'waiting'
        : agent === 'completed'
          ? 'completed'
          : agent === 'running'
            ? 'informational'
            : 'none'
  const agentReason =
    agent === 'failed'
      ? 'agentFailed'
      : agent === 'waiting'
        ? 'agentWaiting'
        : agent === 'completed'
          ? 'agentCompleted'
          : agent === 'running'
            ? 'agentRunning'
            : 'none'
  return workspaceAttentionSnapshotSchema.parse({
    workspaceId,
    revision: 0,
    state: agentState,
    reason: agentReason,
    unreadCount
  }) as WorkspaceAttentionSnapshot
}

/** Process-local Rust-v15 card slots and attention projections for the Node owner. */
export class CardSlotAttentionService {
  private readonly v1 = new Map<string, WorkspaceCardSlotsSnapshot>()
  private readonly v2 = new Map<string, WorkspaceCardSlotV2Snapshot>()
  private readonly attention = new Map<string, WorkspaceAttentionSnapshot>()
  private readonly listeners = new Set<(event: CardSlotAttentionEvent) => void>()
  private lastApplicationRevision = 0

  constructor(private readonly readState: () => DurableApplicationState) {}

  get installedApplicationRevision(): number {
    return this.lastApplicationRevision
  }

  subscribe(listener: (event: CardSlotAttentionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Complete bounded invalidation set for a reconnecting client. */
  resyncEvents(): CardSlotAttentionEvent[] {
    this.refreshAttention()
    return [
      ...[...this.attention.values()].map((snapshot): SlotEvent => ({
        event: 'workspace.cardSlotsChanged',
        data: {
          workspaceId: snapshot.workspaceId,
          slotRevision: this.v1.get(snapshot.workspaceId)?.revision ?? 0,
          reason: 'slotsReplaced'
        }
      })),
      ...[...this.attention.values()].flatMap((snapshot) =>
        V2_KINDS.map((kind): SlotV2Event => ({
          event: 'workspace.cardSlots.v2Changed',
          data: {
            workspaceId: snapshot.workspaceId,
            kind,
            slotRevision: this.v2.get(`${snapshot.workspaceId}:${kind}`)?.slotRevision ?? 0,
            reason: 'resyncRequired'
          }
        }))
      ),
      ...[...this.attention.values()].map((snapshot): AttentionEvent => ({
        event: 'workspace.attentionChanged',
        data: {
          workspaceId: snapshot.workspaceId,
          attentionRevision: snapshot.revision,
          reason: 'resyncRequired'
        }
      }))
    ]
  }

  private emit(event: CardSlotAttentionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        this.listeners.delete(listener)
      }
    }
  }

  private workspace(state: DurableApplicationState, id: string): void {
    if (!state.workspaces.some((workspace) => workspace.id === id))
      fail('workspace_not_found', 'The requested workspace does not exist')
  }

  private prune(state: DurableApplicationState): void {
    const ids = new Set(state.workspaces.map((workspace) => workspace.id))
    for (const id of this.v1.keys()) if (!ids.has(id)) this.v1.delete(id)
    for (const [key, slot] of this.v2) if (!ids.has(slot.workspaceId)) this.v2.delete(key)
    for (const id of this.attention.keys()) if (!ids.has(id)) this.attention.delete(id)
  }

  getSlots(params: { workspaceId: string }): WorkspaceCardSlotsSnapshot {
    const input = workspaceCardSlotsSnapshotParamsSchema.safeParse(params)
    if (!input.success)
      fail('invalid_params', 'The request parameters do not match the command contract')
    const state = this.readState()
    this.prune(state)
    this.workspace(state, input.data.workspaceId)
    return (
      this.v1.get(input.data.workspaceId) ?? {
        workspaceId: input.data.workspaceId,
        revision: 0,
        agentStatus: null,
        progress: null
      }
    )
  }

  replaceSlots(params: V1Replace): WorkspaceCardSlotsSnapshot {
    const input = workspaceCardSlotsReplaceParamsSchema.safeParse(params)
    if (!input.success)
      fail('invalid_params', 'The request parameters do not match the command contract')
    const current = this.getSlots({ workspaceId: input.data.workspaceId })
    if (input.data.expectedRevision !== current.revision)
      fail('revision_conflict', 'The workspace card-slot revision changed before this replacement')
    if (
      same(input.data.agentStatus, current.agentStatus) &&
      same(input.data.progress, current.progress)
    )
      return current
    if (current.revision >= Number.MAX_SAFE_INTEGER)
      fail('revision_out_of_range', 'The workspace card-slot revision cannot be incremented safely')
    const next = {
      workspaceId: input.data.workspaceId,
      revision: current.revision + 1,
      agentStatus: input.data.agentStatus,
      progress: input.data.progress
    }
    this.v1.set(next.workspaceId, next)
    this.emit({
      event: 'workspace.cardSlotsChanged',
      data: { workspaceId: next.workspaceId, slotRevision: next.revision, reason: 'slotsReplaced' }
    })
    this.refreshAttention()
    return next
  }

  getSlotV2(params: {
    workspaceId: string
    kind: WorkspaceCardSlotV2Snapshot['kind']
  }): WorkspaceCardSlotV2Snapshot {
    const input = workspaceCardSlotV2GetParamsSchema.safeParse(params)
    if (!input.success)
      fail('invalid_params', 'The request parameters do not match the command contract')
    const state = this.readState()
    this.prune(state)
    this.workspace(state, input.data.workspaceId)
    return (
      this.v2.get(`${input.data.workspaceId}:${input.data.kind}`) ?? {
        workspaceId: input.data.workspaceId,
        kind: input.data.kind,
        slotRevision: 0,
        payload: null
      }
    )
  }

  replaceSlotV2(params: V2Replace): WorkspaceCardSlotV2Snapshot {
    const input = workspaceCardSlotV2ReplaceParamsSchema.safeParse(params)
    if (!input.success)
      fail('invalid_params', 'The request parameters do not match the command contract')
    const current = this.getSlotV2({ workspaceId: input.data.workspaceId, kind: input.data.kind })
    if (
      Buffer.byteLength(JSON.stringify({ ...current, payload: input.data.payload })) >
      MAX_V2_RESPONSE_BYTES
    )
      fail('card_slot_too_large', 'The serialized card-slot response exceeds 16 KiB')
    if (input.data.expectedRevision !== current.slotRevision)
      fail('revision_conflict', 'The workspace card-slot revision changed before this replacement')
    if (same(input.data.payload, current.payload)) return current
    if (current.slotRevision >= Number.MAX_SAFE_INTEGER)
      fail('revision_out_of_range', 'The workspace card-slot revision cannot be incremented safely')
    const next = workspaceCardSlotV2SnapshotSchema.parse({
      workspaceId: input.data.workspaceId,
      kind: input.data.kind,
      slotRevision: current.slotRevision + 1,
      payload: input.data.payload
    })
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_V2_RESPONSE_BYTES)
      fail('card_slot_too_large', 'The serialized card-slot response exceeds 16 KiB')
    this.v2.set(`${next.workspaceId}:${next.kind}`, next)
    this.emit({
      event: 'workspace.cardSlots.v2Changed',
      data: {
        workspaceId: next.workspaceId,
        kind: next.kind,
        slotRevision: next.slotRevision,
        reason: 'slotReplaced'
      }
    })
    return next
  }

  refreshAttention(): void {
    const state = this.readState()
    if (state.revision < this.lastApplicationRevision) return
    this.prune(state)
    const events: AttentionEvent[] = []
    for (const workspace of state.workspaces) {
      const id = workspace.id
      const projected = fold(state, id, this.v1.get(id))
      const previous = this.attention.get(id)
      const next = { ...projected, revision: previous?.revision ?? 0 }
      if (previous && !same({ ...previous, revision: 0 }, projected)) {
        if (previous.revision >= Number.MAX_SAFE_INTEGER)
          fail(
            'revision_out_of_range',
            'The workspace attention revision cannot be incremented safely'
          )
        next.revision += 1
        events.push({
          event: 'workspace.attentionChanged',
          data: { workspaceId: id, attentionRevision: next.revision, reason: 'sourcesChanged' }
        })
      }
      this.attention.set(id, next)
    }
    this.lastApplicationRevision = state.revision
    for (const event of events) this.emit(event)
  }

  getAttention(params: { workspaceId: string }): WorkspaceAttentionSnapshot {
    const input = workspaceAttentionSnapshotParamsSchema.safeParse(params)
    if (!input.success)
      fail('invalid_params', 'The request parameters do not match the command contract')
    this.refreshAttention()
    return (
      this.attention.get(input.data.workspaceId) ??
      fail('workspace_not_found', 'The requested workspace does not exist')
    )
  }

  /** Validate the Rust acknowledgement preconditions before the owner commits a notification read. */
  prepareAcknowledgement(params: AttentionAcknowledgementParams): {
    notificationId: string
    workspaceId: string
    expectedApplicationRevision: number
  } {
    const input = attentionAcknowledgementParamsSchema.safeParse(params)
    if (!input.success)
      fail('invalid_params', 'The request parameters do not match the command contract')
    const state = this.readState()
    this.refreshAttention()
    const notification = state.notifications.find((item) => item.id === input.data.notificationId)
    if (!notification) fail('notification_not_found', 'The acknowledgement target no longer exists')
    const attention = this.getAttention({ workspaceId: notification.workspaceId })
    if (attention.revision !== input.data.expectedRevision)
      fail('revision_conflict', 'The workspace attention revision changed before acknowledgement')
    if (notification.readAt !== null)
      fail('attention_already_acknowledged', 'The notification was already acknowledged')
    if (!targetExists(state, notification))
      fail(
        'attention_target_unavailable',
        'The exact acknowledgement target is no longer available'
      )
    if (input.data.mode === 'focused') {
      const workspace = state.workspaces.find((item) => item.id === notification.workspaceId)!
      const paneId =
        notification.paneId ??
        (notification.tabId === null ? null : (workspace.tabs[notification.tabId]?.paneId ?? null))
      if (
        state.selectedWorkspaceId !== workspace.id ||
        (paneId !== null && workspace.selectedPaneId !== paneId) ||
        (notification.tabId !== null &&
          workspace.panes[paneId!]?.selectedTabId !== notification.tabId)
      )
        fail(
          'attention_target_not_focused',
          'The exact acknowledgement target must be focused first'
        )
    }
    return {
      notificationId: notification.id,
      workspaceId: notification.workspaceId,
      expectedApplicationRevision: state.revision
    }
  }

  /** Recompute after a durable notification commit and return the wire result. */
  completedAcknowledgement(workspaceId: string): AttentionAcknowledgementResult {
    const attention = this.getAttention({ workspaceId })
    return { revision: attention.revision, attention }
  }

  /** Predict the exact attention result for the same SQLite transaction that marks a notification read. */
  projectAcknowledged(
    state: DurableApplicationState,
    workspaceId: string
  ): AttentionAcknowledgementResult {
    const previous = this.getAttention({ workspaceId })
    const projected = fold(state, workspaceId, this.v1.get(workspaceId))
    const changed = !same({ ...previous, revision: 0 }, projected)
    if (changed && previous.revision >= Number.MAX_SAFE_INTEGER)
      fail('revision_out_of_range', 'The workspace attention revision cannot be incremented safely')
    const attention = { ...projected, revision: previous.revision + (changed ? 1 : 0) }
    return { revision: attention.revision, attention }
  }
}
