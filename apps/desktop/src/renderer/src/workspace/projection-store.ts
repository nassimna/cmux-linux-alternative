import { create } from 'zustand'

import type {
  AttentionAcknowledgementParams,
  ApplicationSnapshot,
  IdentifyResult,
  LayoutListResult,
  MutationResult,
  NotificationClearParams,
  NotificationListResult,
  NotificationMarkReadParams,
  NotificationMarkUnreadParams,
  NotificationSnapshot,
  SettingsGetResult,
  WorkspaceCardSlotsSnapshot,
  WorkspaceCardSlotV2Kind,
  WorkspaceCardSlotV2Snapshot,
  WorkspaceAttentionSnapshot,
  WorkspaceOrganizationSnapshot
} from '@agent-workspace/protocol-client'

import type { DesktopBridge } from '../../../shared/desktop-bridge'
import { messages, type WorkspaceShutdownReason } from '../messages'

type ProjectionStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ProjectionState {
  acknowledgeAttention(params: AttentionAcknowledgementParams): Promise<void>
  attention: Readonly<Record<string, WorkspaceAttentionSnapshot>>
  cardSlots: Readonly<Record<string, WorkspaceCardSlotsSnapshot>>
  cardSlotsV2: WorkspaceCardSlotsV2Projection
  clearNotifications(params: NotificationClearParams): Promise<void>
  error: string | null
  identity: IdentifyResult | null
  paletteOpen: boolean
  settings: SettingsGetResult | null
  settingsOpen: boolean
  sidebarOpen: boolean
  snapshot: ApplicationSnapshot | null
  status: ProjectionStatus
  applyMutation(result: MutationResult, clearMutationError?: boolean): void
  clearMutationError(): void
  initialize(bridge: DesktopBridge): Promise<void>
  latestUnreadNotification(): Promise<NotificationSnapshot | null>
  loadMoreNotifications(): Promise<void>
  markNotificationRead(params: NotificationMarkReadParams): Promise<void>
  markNotificationUnread(params: NotificationMarkUnreadParams): Promise<void>
  mutationError: string | null
  notifications: NotificationListResult | null
  organization: WorkspaceOrganizationSnapshot | null
  savedLayouts: LayoutListResult | null
  notificationHistoryLoading: boolean
  recentNotificationEvents: NotificationSnapshot[]
  refresh(): Promise<void>
  refreshNotifications(): Promise<void>
  refreshOrganization(): Promise<void>
  refreshSavedLayouts(): Promise<void>
  refreshWorkspaceCardSlots(workspaceId: string, minimumRevision?: number): Promise<void>
  refreshWorkspaceCardSlotV2(
    workspaceId: string,
    kind: WorkspaceCardSlotV2Kind,
    minimumRevision?: number
  ): Promise<void>
  refreshWorkspaceAttention(workspaceId: string, minimumRevision?: number): Promise<void>
  reportMutationError(error: unknown): void
  setPaletteOpen(open: boolean): void
  setSettingsOpen(open: boolean): void
  toggleSidebar(): void
}

let activeBridge: DesktopBridge | undefined
let cleanupSubscriptions: (() => void) | undefined
let generation = 0
let requestSequence = 0
let latestStatusRequest = 0
let shutdownGeneration: number | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let pendingProjectionRevision = 0
let projectionRefreshRetryAttempt = 0
let notificationHistoryLimit = 200
const pendingCardSlotRevisions = new Map<string, number>()
const cardSlotRefreshes = new Map<string, number>()
const cardSlotRetryAttempts = new Map<string, number>()
const cardSlotRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const cardSlotV2Refreshes = new Set<string>()
const cardSlotV2PendingRevisions = new Map<string, number>()
const cardSlotV2RetryAttempts = new Map<string, number>()
const cardSlotV2RetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingAttentionRevisions = new Map<string, number>()
const attentionRefreshes = new Set<string>()
const attentionRetryAttempts = new Map<string, number>()
const attentionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

const NOTIFICATION_PAGE_SIZE = 200
const NOTIFICATION_RETENTION_CAP = 1_000
const RECENT_NOTIFICATION_EVENT_LIMIT = 20
const EVENT_REFRESH_DELAY_MS = 20
const PROJECTION_REFRESH_RETRY_DELAYS_MS = [50, 200, 1_000] as const
const CARD_SLOT_RETRY_DELAYS_MS = [50, 200, 1_000] as const
export const WORKSPACE_CARD_SLOT_V2_KINDS = [
  'agentStatus',
  'progress',
  'pullRequest',
  'metadata',
  'markdown',
  'logTail',
  'task',
  'ssh',
  'media'
] as const satisfies readonly WorkspaceCardSlotV2Kind[]

export type WorkspaceCardSlotsV2Projection = Readonly<
  Record<string, Partial<Record<WorkspaceCardSlotV2Kind, WorkspaceCardSlotV2Snapshot>>>
>

const cardSlotV2Key = (workspaceId: string, kind: WorkspaceCardSlotV2Kind): string =>
  `${workspaceId}:${kind}`

type WorkspaceErrorContext = 'initialize' | 'refresh' | 'mutation'

const TARGET_UNAVAILABLE_CODES = new Set([
  'notification_not_found',
  'pane_not_found',
  'split_not_found',
  'tab_not_found',
  'terminal_not_found',
  'workspace_not_found'
])
const INVALID_REQUEST_CODES = new Set([
  'index_out_of_bounds',
  'invalid_operation',
  'invalid_params',
  'revision_out_of_range',
  'shortcut_conflict',
  'tab_not_terminal'
])
const PERSISTENCE_CODES = new Set([
  'configuration_storage_failure',
  'persistence_consistency_failure',
  'persistence_worker_failed',
  'runtime_contract_failure',
  'runtime_update_failure',
  'runtime_worker_failed',
  'storage_failure'
])
const TERMINAL_CODES = new Set([
  'invalid_terminal_command',
  'terminal_lifecycle_failed',
  'terminal_open_failed',
  'terminal_spawn_failed',
  'terminal_terminate_failed',
  'terminal_worker_failed'
])

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function workspaceErrorMessage(error: unknown, context: WorkspaceErrorContext): string {
  const copy = messages.workspaceProjection.errors
  const code = errorCode(error)
  if (code === 'revision_conflict') return copy.revisionConflict
  if (code === 'service_shutting_down') return copy.shuttingDown('service_shutdown')
  if (code && TARGET_UNAVAILABLE_CODES.has(code)) return copy.targetUnavailable
  if (code && INVALID_REQUEST_CODES.has(code)) return copy.invalidRequest
  if (code && PERSISTENCE_CODES.has(code)) return copy.persistenceFailed
  if (code && TERMINAL_CODES.has(code)) return copy.terminalOperationFailed
  if (context === 'initialize') return copy.initializationFailed
  if (context === 'refresh') return copy.refreshFailed
  return copy.changeFailed
}

function shutdownReason(reason: string): WorkspaceShutdownReason | undefined {
  return reason === 'service_shutdown' ? reason : undefined
}

function applyProjection(
  state: ProjectionState,
  snapshot: ApplicationSnapshot,
  settings: SettingsGetResult
): Pick<ProjectionState, 'attention' | 'cardSlots' | 'cardSlotsV2' | 'settings'> & {
  snapshot: ApplicationSnapshot
} {
  const acceptedSnapshot =
    state.snapshot && state.snapshot.revision > snapshot.revision ? state.snapshot : snapshot
  return {
    attention: retainWorkspaceAttention(state.attention, acceptedSnapshot),
    cardSlots: retainWorkspaceCardSlots(state.cardSlots, acceptedSnapshot),
    cardSlotsV2: retainWorkspaceCardSlotsV2(state.cardSlotsV2, acceptedSnapshot),
    snapshot: acceptedSnapshot,
    settings:
      state.settings && state.settings.revision > settings.revision ? state.settings : settings
  }
}

function retainWorkspaceCardSlotsV2(
  cardSlots: WorkspaceCardSlotsV2Projection,
  snapshot: ApplicationSnapshot
): WorkspaceCardSlotsV2Projection {
  const workspaceIds = new Set(snapshot.workspaces.map(({ id }) => id))
  return Object.fromEntries(
    Object.entries(cardSlots).filter(([workspaceId]) => workspaceIds.has(workspaceId))
  )
}

function retainWorkspaceAttention(
  attention: Readonly<Record<string, WorkspaceAttentionSnapshot>>,
  snapshot: ApplicationSnapshot
): Readonly<Record<string, WorkspaceAttentionSnapshot>> {
  const workspaceIds = new Set(snapshot.workspaces.map(({ id }) => id))
  return Object.fromEntries(
    Object.entries(attention).filter(([workspaceId]) => workspaceIds.has(workspaceId))
  )
}

function retainWorkspaceCardSlots(
  cardSlots: Readonly<Record<string, WorkspaceCardSlotsSnapshot>>,
  snapshot: ApplicationSnapshot
): Readonly<Record<string, WorkspaceCardSlotsSnapshot>> {
  const workspaceIds = new Set(snapshot.workspaces.map(({ id }) => id))
  return Object.fromEntries(
    Object.entries(cardSlots).filter(([workspaceId]) => workspaceIds.has(workspaceId))
  )
}

function mergeWorkspaceCardSlots(
  current: Readonly<Record<string, WorkspaceCardSlotsSnapshot>>,
  incoming: Readonly<Record<string, WorkspaceCardSlotsSnapshot>>
): Readonly<Record<string, WorkspaceCardSlotsSnapshot>> {
  const merged = { ...current }
  for (const [workspaceId, slots] of Object.entries(incoming)) {
    if (!merged[workspaceId] || merged[workspaceId].revision <= slots.revision) {
      merged[workspaceId] = slots
    }
  }
  return merged
}

function mergeWorkspaceCardSlotsV2(
  current: WorkspaceCardSlotsV2Projection,
  incoming: WorkspaceCardSlotsV2Projection
): WorkspaceCardSlotsV2Projection {
  const merged: Record<
    string,
    Partial<Record<WorkspaceCardSlotV2Kind, WorkspaceCardSlotV2Snapshot>>
  > = Object.fromEntries(
    Object.entries(current).map(([workspaceId, slots]) => [workspaceId, { ...slots }])
  )
  for (const [workspaceId, slots] of Object.entries(incoming)) {
    for (const kind of WORKSPACE_CARD_SLOT_V2_KINDS) {
      const snapshot = slots[kind]
      if (!snapshot) continue
      const required = cardSlotV2PendingRevisions.get(cardSlotV2Key(workspaceId, kind)) ?? 0
      const existing = merged[workspaceId]?.[kind]
      if (
        snapshot.slotRevision < required ||
        (existing && existing.slotRevision > snapshot.slotRevision)
      ) {
        continue
      }
      merged[workspaceId] = { ...merged[workspaceId], [kind]: snapshot }
    }
  }
  return merged
}

function rememberCardSlotRevision(workspaceId: string, minimumRevision: number): void {
  pendingCardSlotRevisions.set(
    workspaceId,
    Math.max(pendingCardSlotRevisions.get(workspaceId) ?? 0, minimumRevision)
  )
}

function clearCardSlotRetry(workspaceId: string): void {
  const timer = cardSlotRetryTimers.get(workspaceId)
  if (timer) clearTimeout(timer)
  cardSlotRetryTimers.delete(workspaceId)
  cardSlotRetryAttempts.delete(workspaceId)
}

function resetCardSlotCoordinationState(): void {
  for (const timer of cardSlotRetryTimers.values()) clearTimeout(timer)
  pendingCardSlotRevisions.clear()
  cardSlotRefreshes.clear()
  cardSlotRetryAttempts.clear()
  cardSlotRetryTimers.clear()
  cardSlotV2Refreshes.clear()
  cardSlotV2PendingRevisions.clear()
  for (const timer of cardSlotV2RetryTimers.values()) clearTimeout(timer)
  cardSlotV2RetryAttempts.clear()
  cardSlotV2RetryTimers.clear()
  pendingAttentionRevisions.clear()
  attentionRefreshes.clear()
  for (const timer of attentionRetryTimers.values()) clearTimeout(timer)
  attentionRetryAttempts.clear()
  attentionRetryTimers.clear()
}

function clearCardSlotV2Retry(key: string): void {
  const timer = cardSlotV2RetryTimers.get(key)
  if (timer) clearTimeout(timer)
  cardSlotV2RetryTimers.delete(key)
  cardSlotV2RetryAttempts.delete(key)
}

function scheduleCardSlotV2Retry(
  workspaceId: string,
  kind: WorkspaceCardSlotV2Kind,
  currentGeneration: number,
  get: () => ProjectionState
): void {
  const key = cardSlotV2Key(workspaceId, kind)
  if (cardSlotV2RetryTimers.has(key)) return
  const attempt = cardSlotV2RetryAttempts.get(key) ?? 0
  const delay = CARD_SLOT_RETRY_DELAYS_MS[attempt]
  if (delay === undefined) return
  cardSlotV2RetryAttempts.set(key, attempt + 1)
  cardSlotV2RetryTimers.set(
    key,
    setTimeout(() => {
      cardSlotV2RetryTimers.delete(key)
      if (currentGeneration !== generation) return
      void get().refreshWorkspaceCardSlotV2(
        workspaceId,
        kind,
        cardSlotV2PendingRevisions.get(key) ?? 0
      )
    }, delay)
  )
}

function discardUnknownPendingCardSlots(snapshot: ApplicationSnapshot): void {
  const workspaceIds = new Set(snapshot.workspaces.map(({ id }) => id))
  for (const workspaceId of pendingCardSlotRevisions.keys()) {
    if (workspaceIds.has(workspaceId)) continue
    pendingCardSlotRevisions.delete(workspaceId)
    clearCardSlotRetry(workspaceId)
  }
}

function discardRemovedCardSlotWorkspaces(
  previous: ApplicationSnapshot | null,
  next: ApplicationSnapshot
): void {
  if (!previous || next.revision < previous.revision) return
  const nextWorkspaceIds = new Set(next.workspaces.map(({ id }) => id))
  for (const { id } of previous.workspaces) {
    if (nextWorkspaceIds.has(id)) continue
    pendingCardSlotRevisions.delete(id)
    clearCardSlotRetry(id)
    pendingAttentionRevisions.delete(id)
    clearAttentionRetry(id)
    for (const kind of WORKSPACE_CARD_SLOT_V2_KINDS) {
      const key = cardSlotV2Key(id, kind)
      cardSlotV2PendingRevisions.delete(key)
      cardSlotV2Refreshes.delete(key)
      clearCardSlotV2Retry(key)
    }
  }
}

function refreshKnownCardSlotsV2(get: () => ProjectionState): void {
  const state = get()
  if (!state.identity?.capabilities.includes('card-slots-v2')) return
  for (const { id } of state.snapshot?.workspaces ?? []) {
    for (const kind of WORKSPACE_CARD_SLOT_V2_KINDS) {
      const key = cardSlotV2Key(id, kind)
      if (!state.cardSlotsV2[id]?.[kind] || cardSlotV2PendingRevisions.has(key)) {
        void state.refreshWorkspaceCardSlotV2(id, kind, cardSlotV2PendingRevisions.get(key) ?? 0)
      }
    }
  }
}

function refreshKnownCardSlots(get: () => ProjectionState): void {
  const state = get()
  for (const { id } of state.snapshot?.workspaces ?? []) {
    if (!(id in state.cardSlots) || pendingCardSlotRevisions.has(id)) {
      void state.refreshWorkspaceCardSlots(id, pendingCardSlotRevisions.get(id) ?? 0)
    }
  }
}

function refreshKnownAttention(get: () => ProjectionState): void {
  const state = get()
  if (!state.identity?.capabilities.includes('attention-v1')) return
  for (const { id } of state.snapshot?.workspaces ?? []) {
    if (!(id in state.attention) || pendingAttentionRevisions.has(id)) {
      void state.refreshWorkspaceAttention(id, pendingAttentionRevisions.get(id) ?? 0)
    }
  }
}

function clearAttentionRetry(workspaceId: string): void {
  const timer = attentionRetryTimers.get(workspaceId)
  if (timer) clearTimeout(timer)
  attentionRetryTimers.delete(workspaceId)
  attentionRetryAttempts.delete(workspaceId)
}

function scheduleAttentionRetry(
  workspaceId: string,
  currentGeneration: number,
  get: () => ProjectionState
): void {
  if (attentionRetryTimers.has(workspaceId)) return
  const attempt = attentionRetryAttempts.get(workspaceId) ?? 0
  const delay = CARD_SLOT_RETRY_DELAYS_MS[attempt]
  if (delay === undefined) return
  attentionRetryAttempts.set(workspaceId, attempt + 1)
  attentionRetryTimers.set(
    workspaceId,
    setTimeout(() => {
      attentionRetryTimers.delete(workspaceId)
      if (currentGeneration !== generation) return
      void get().refreshWorkspaceAttention(
        workspaceId,
        pendingAttentionRevisions.get(workspaceId) ?? 0
      )
    }, delay)
  )
}

function scheduleCardSlotRetry(
  workspaceId: string,
  currentGeneration: number,
  get: () => ProjectionState
): void {
  if (cardSlotRetryTimers.has(workspaceId)) return
  const attempt = cardSlotRetryAttempts.get(workspaceId) ?? 0
  const delay = CARD_SLOT_RETRY_DELAYS_MS[attempt]
  if (delay === undefined) return
  cardSlotRetryAttempts.set(workspaceId, attempt + 1)
  cardSlotRetryTimers.set(
    workspaceId,
    setTimeout(() => {
      cardSlotRetryTimers.delete(workspaceId)
      if (currentGeneration !== generation) return
      void get().refreshWorkspaceCardSlots(
        workspaceId,
        pendingCardSlotRevisions.get(workspaceId) ?? 0
      )
    }, delay)
  )
}

async function initialCardSlots(
  bridge: DesktopBridge,
  snapshot: ApplicationSnapshot
): Promise<Readonly<Record<string, WorkspaceCardSlotsSnapshot>>> {
  if (!bridge.getWorkspaceCardSlots) return {}
  const getWorkspaceCardSlots = bridge.getWorkspaceCardSlots.bind(bridge)
  const slots = await Promise.all(
    snapshot.workspaces.map(({ id }) => getWorkspaceCardSlots({ workspaceId: id }))
  )
  return Object.fromEntries(slots.map((slot) => [slot.workspaceId, slot] as const))
}

async function initialCardSlotsV2(
  bridge: DesktopBridge,
  snapshot: ApplicationSnapshot,
  enabled: boolean
): Promise<WorkspaceCardSlotsV2Projection> {
  if (!enabled || !bridge.getWorkspaceCardSlotV2) return {}
  const outcomes = await Promise.allSettled(
    snapshot.workspaces.flatMap(({ id }) =>
      WORKSPACE_CARD_SLOT_V2_KINDS.map((kind) =>
        bridge.getWorkspaceCardSlotV2!({ workspaceId: id, kind })
      )
    )
  )
  const result: Record<
    string,
    Partial<Record<WorkspaceCardSlotV2Kind, WorkspaceCardSlotV2Snapshot>>
  > = {}
  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled') continue
    const value = outcome.value
    result[value.workspaceId] = { ...result[value.workspaceId], [value.kind]: value }
  }
  return result
}

async function initialAttention(
  bridge: DesktopBridge,
  snapshot: ApplicationSnapshot,
  enabled: boolean
): Promise<Readonly<Record<string, WorkspaceAttentionSnapshot>>> {
  if (!enabled || !bridge.getWorkspaceAttention) return {}
  const getWorkspaceAttention = bridge.getWorkspaceAttention.bind(bridge)
  const outcomes = await Promise.allSettled(
    snapshot.workspaces.map(({ id }) => getWorkspaceAttention({ workspaceId: id }))
  )
  const snapshots = outcomes
    .filter(
      (outcome): outcome is PromiseFulfilledResult<WorkspaceAttentionSnapshot> =>
        outcome.status === 'fulfilled'
    )
    .map(({ value }) => value)
  return Object.fromEntries(snapshots.map((value) => [value.workspaceId, value] as const))
}

function currentNotifications(
  state: ProjectionState,
  notifications: NotificationListResult
): NotificationListResult {
  if (!state.notifications) return notifications
  if (state.notifications.revision > notifications.revision) return state.notifications
  if (
    state.notifications.revision === notifications.revision &&
    state.notifications.total === notifications.total &&
    state.notifications.notifications.length > notifications.notifications.length
  ) {
    return state.notifications
  }
  return notifications
}

async function listNotificationHistory(
  bridge: DesktopBridge,
  desiredLimit: number
): Promise<NotificationListResult | null> {
  if (!bridge.listNotifications) return null
  let fallback: NotificationListResult | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const first = await bridge.listNotifications({ offset: 0, limit: NOTIFICATION_PAGE_SIZE })
    fallback = first
    const targetCount = Math.min(first.total, desiredLimit, NOTIFICATION_RETENTION_CAP)
    const notifications = [...first.notifications]
    let consistent = true
    for (
      let offset = notifications.length;
      offset < targetCount;
      offset += NOTIFICATION_PAGE_SIZE
    ) {
      const page = await bridge.listNotifications({
        offset,
        limit: Math.min(NOTIFICATION_PAGE_SIZE, targetCount - offset)
      })
      if (
        page.revision !== first.revision ||
        page.total !== first.total ||
        page.unreadCount !== first.unreadCount
      ) {
        consistent = false
        break
      }
      notifications.push(...page.notifications)
      if (page.notifications.length === 0) break
    }
    if (consistent && notifications.length >= targetCount) {
      return { ...first, notifications: notifications.slice(0, targetCount) }
    }
  }
  return fallback
}

export const useProjectionStore = create<ProjectionState>((set, get) => ({
  acknowledgeAttention: async (params) => {
    const bridge = activeBridge
    if (!get().identity?.capabilities.includes('attention-v1') || !bridge?.acknowledgeAttention)
      throw new Error(messages.workspaceProjection.errors.notificationOperationsUnavailable)
    const currentGeneration = generation
    const result = await bridge.acknowledgeAttention(params)
    if (currentGeneration !== generation || bridge !== activeBridge) return
    set({ mutationError: null })
    await get().refreshWorkspaceAttention(result.attention.workspaceId)
    await get().refreshNotifications()
  },
  attention: {},
  cardSlots: {},
  cardSlotsV2: {},
  clearNotifications: async (params) => {
    const bridge = activeBridge
    if (!bridge) throw new Error(messages.workspaceProjection.errors.serviceNotConnected)
    if (!bridge.clearNotifications)
      throw new Error(messages.workspaceProjection.errors.notificationOperationsUnavailable)
    const result = await bridge.clearNotifications(params)
    get().applyMutation(result)
    await get().refreshNotifications()
  },
  error: null,
  identity: null,
  mutationError: null,
  notificationHistoryLoading: false,
  notifications: null,
  organization: null,
  savedLayouts: null,
  paletteOpen: false,
  recentNotificationEvents: [],
  settings: null,
  settingsOpen: false,
  sidebarOpen: true,
  snapshot: null,
  status: 'idle',
  applyMutation: (result, clearMutationError = true) => {
    const currentSnapshot = get().snapshot
    const projectionIsCurrent =
      currentSnapshot === null || result.snapshot.revision >= currentSnapshot.revision
    if (projectionIsCurrent) latestStatusRequest = ++requestSequence
    discardRemovedCardSlotWorkspaces(currentSnapshot, result.snapshot)
    set((state) => ({
      attention: retainWorkspaceAttention(state.attention, result.snapshot),
      cardSlots: retainWorkspaceCardSlots(state.cardSlots, result.snapshot),
      cardSlotsV2: retainWorkspaceCardSlotsV2(state.cardSlotsV2, result.snapshot),
      snapshot:
        state.snapshot && state.snapshot.revision > result.snapshot.revision
          ? state.snapshot
          : result.snapshot,
      ...(clearMutationError ? { mutationError: null } : {}),
      ...(projectionIsCurrent && shutdownGeneration !== generation
        ? { status: 'ready' as const, error: null }
        : {})
    }))
    refreshKnownCardSlots(get)
    refreshKnownCardSlotsV2(get)
    refreshKnownAttention(get)
    if (get().identity?.capabilities.includes('workspace-groups-v1')) {
      void get().refreshOrganization()
    }
  },
  clearMutationError: () => set({ mutationError: null }),
  initialize: async (bridge) => {
    const currentGeneration = ++generation
    const requestId = ++requestSequence
    latestStatusRequest = requestId
    shutdownGeneration = undefined
    cleanupSubscriptions?.()
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = undefined
    pendingProjectionRevision = 0
    projectionRefreshRetryAttempt = 0
    resetCardSlotCoordinationState()
    notificationHistoryLimit = NOTIFICATION_PAGE_SIZE
    activeBridge = bridge
    set({
      attention: {},
      cardSlots: {},
      cardSlotsV2: {},
      status: 'loading',
      error: null,
      mutationError: null,
      notificationHistoryLoading: false,
      organization: null,
      savedLayouts: null
    })

    const removers = [
      bridge.onDomainEvent((event) => {
        if (currentGeneration !== generation) return
        if (event.event === 'notification.created') {
          const notification = event.data.notification as NotificationSnapshot
          set((state) => ({
            recentNotificationEvents: [
              notification,
              ...state.recentNotificationEvents.filter(({ id }) => id !== notification.id)
            ].slice(0, RECENT_NOTIFICATION_EVENT_LIMIT)
          }))
        }
        scheduleRefresh(currentGeneration, get, event.revision)
      }),
      bridge.onDomainResyncRequired((notice) => {
        if (currentGeneration === generation) {
          scheduleRefresh(currentGeneration, get, notice.receivedRevision)
        }
      }),
      bridge.onServiceEvent((event) => {
        if (currentGeneration !== generation) return
        shutdownGeneration = currentGeneration
        set({
          status: 'error',
          error: messages.workspaceProjection.errors.shuttingDown(shutdownReason(event.data.reason))
        })
      })
    ]
    if (bridge.onWorkspaceCardSlotsEvent) {
      removers.push(
        bridge.onWorkspaceCardSlotsEvent((event) => {
          if (currentGeneration !== generation) return
          rememberCardSlotRevision(event.data.workspaceId, event.data.slotRevision)
          void get().refreshWorkspaceCardSlots(event.data.workspaceId, event.data.slotRevision)
        })
      )
    }
    if (bridge.onWorkspaceCardSlotV2Event) {
      removers.push(
        bridge.onWorkspaceCardSlotV2Event((event) => {
          if (currentGeneration !== generation) return
          const { workspaceId, kind, slotRevision } = event.data
          const key = cardSlotV2Key(workspaceId, kind)
          cardSlotV2PendingRevisions.set(
            key,
            Math.max(cardSlotV2PendingRevisions.get(key) ?? 0, slotRevision)
          )
          clearCardSlotV2Retry(key)
          void get().refreshWorkspaceCardSlotV2(workspaceId, kind, slotRevision)
        })
      )
    }
    if (bridge.onWorkspaceAttentionEvent) {
      removers.push(
        bridge.onWorkspaceAttentionEvent((event) => {
          if (currentGeneration !== generation) return
          if (!get().identity?.capabilities.includes('attention-v1')) return
          const { workspaceId, attentionRevision } = event.data
          clearAttentionRetry(workspaceId)
          pendingAttentionRevisions.set(
            workspaceId,
            Math.max(pendingAttentionRevisions.get(workspaceId) ?? 0, attentionRevision)
          )
          void get().refreshWorkspaceAttention(workspaceId, attentionRevision)
        })
      )
    }
    if (bridge.onMultiWindowEvent) {
      removers.push(
        bridge.onMultiWindowEvent((event) => {
          if (currentGeneration === generation) {
            scheduleRefresh(currentGeneration, get, event.revision)
          }
        })
      )
    }
    cleanupSubscriptions = () => removers.forEach((remove) => remove())

    try {
      const [identity, workspaces, settings, notifications] = await Promise.all([
        bridge.identify(),
        bridge.listWorkspaces(),
        bridge.getSettings(),
        listNotificationHistory(bridge, notificationHistoryLimit)
      ])
      if (staleInitialization(currentGeneration, requestId, get)) return
      const cardSlots = await initialCardSlots(bridge, workspaces.snapshot)
      if (staleInitialization(currentGeneration, requestId, get)) return
      const cardSlotsV2 = await initialCardSlotsV2(
        bridge,
        workspaces.snapshot,
        identity.capabilities.includes('card-slots-v2')
      )
      if (staleInitialization(currentGeneration, requestId, get)) return
      const attention = await initialAttention(
        bridge,
        workspaces.snapshot,
        identity.capabilities.includes('attention-v1')
      )
      if (staleInitialization(currentGeneration, requestId, get)) return
      let organization: WorkspaceOrganizationSnapshot | null = null
      if (identity.capabilities.includes('workspace-groups-v1')) {
        if (!bridge.getWorkspaceOrganization) {
          throw new Error('The workspace organization bridge is unavailable')
        }
        const result = await bridge.getWorkspaceOrganization()
        if (staleInitialization(currentGeneration, requestId, get)) return
        if (result === null) {
          void get().initialize(bridge)
          return
        }
        organization = result.organization
      }
      let savedLayouts: LayoutListResult | null = null
      if (identity.capabilities.includes('saved-layouts-v1')) {
        if (!bridge.listSavedLayouts) throw new Error('The saved-layout bridge is unavailable')
        savedLayouts = await bridge.listSavedLayouts()
        if (staleInitialization(currentGeneration, requestId, get)) return
        if (savedLayouts === null) {
          void get().initialize(bridge)
          return
        }
      }
      const currentSnapshot = get().snapshot
      const projectionIsCurrent =
        currentSnapshot === null || workspaces.snapshot.revision >= currentSnapshot.revision
      discardRemovedCardSlotWorkspaces(currentSnapshot, workspaces.snapshot)
      set((state) => {
        const projection = applyProjection(state, workspaces.snapshot, settings)
        return {
          ...projection,
          attention: retainWorkspaceAttention(
            { ...state.attention, ...attention },
            projection.snapshot
          ),
          cardSlots: retainWorkspaceCardSlots(
            mergeWorkspaceCardSlots(state.cardSlots, cardSlots),
            projection.snapshot
          ),
          cardSlotsV2: retainWorkspaceCardSlotsV2(
            mergeWorkspaceCardSlotsV2(state.cardSlotsV2, cardSlotsV2),
            projection.snapshot
          ),
          ...(notifications ? { notifications: currentNotifications(state, notifications) } : {}),
          identity,
          organization,
          savedLayouts,
          ...(requestId === latestStatusRequest && shutdownGeneration !== currentGeneration
            ? { status: 'ready' as const, error: null }
            : {})
        }
      })
      if (projectionIsCurrent) discardUnknownPendingCardSlots(workspaces.snapshot)
      refreshKnownCardSlots(get)
      refreshKnownCardSlotsV2(get)
      refreshKnownAttention(get)
    } catch (error) {
      if (currentGeneration !== generation || shutdownGeneration === currentGeneration) return
      if (staleInitialization(currentGeneration, requestId, get)) return
      set({
        status: 'error',
        error: workspaceErrorMessage(error, 'initialize')
      })
    }
  },
  latestUnreadNotification: async () => {
    const bridge = activeBridge
    if (!bridge) throw new Error(messages.workspaceProjection.errors.serviceNotConnected)
    if (!bridge.listNotifications)
      throw new Error(messages.workspaceProjection.errors.notificationOperationsUnavailable)
    const currentGeneration = generation
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await bridge.listNotifications({ unreadOnly: true, offset: 0, limit: 1 })
      if (currentGeneration !== generation || bridge !== activeBridge) {
        throw new Error(messages.workspaceProjection.errors.connectionChanged)
      }
      const state = get()
      const currentRevision = Math.max(
        state.snapshot?.revision ?? 0,
        state.notifications?.revision ?? 0
      )
      if (result.revision >= currentRevision) return result.notifications[0] ?? null
    }
    throw new Error(messages.workspaceProjection.errors.latestUnreadUnavailable)
  },
  loadMoreNotifications: async () => {
    const bridge = activeBridge
    const current = get().notifications
    if (!bridge?.listNotifications || !current) return
    if (current.notifications.length >= current.total) return
    const currentGeneration = generation
    const targetHistoryLimit = Math.min(
      NOTIFICATION_RETENTION_CAP,
      Math.max(notificationHistoryLimit, current.notifications.length) + NOTIFICATION_PAGE_SIZE
    )
    set({ notificationHistoryLoading: true })
    try {
      const notifications = await listNotificationHistory(bridge, targetHistoryLimit)
      if (currentGeneration !== generation || !notifications) return
      let accepted = false
      set((state) => {
        const nextNotifications = currentNotifications(state, notifications)
        if (nextNotifications !== notifications) return state
        accepted = true
        return { mutationError: null, notifications: nextNotifications }
      })
      if (accepted) notificationHistoryLimit = targetHistoryLimit
    } finally {
      if (currentGeneration === generation) set({ notificationHistoryLoading: false })
    }
  },
  markNotificationRead: async (params) => {
    const bridge = activeBridge
    if (!bridge) throw new Error(messages.workspaceProjection.errors.serviceNotConnected)
    if (!bridge.markNotificationRead)
      throw new Error(messages.workspaceProjection.errors.notificationOperationsUnavailable)
    const result = await bridge.markNotificationRead(params)
    get().applyMutation(result)
    await get().refreshNotifications()
  },
  markNotificationUnread: async (params) => {
    const bridge = activeBridge
    if (!bridge) throw new Error(messages.workspaceProjection.errors.serviceNotConnected)
    if (!bridge.markNotificationUnread)
      throw new Error(messages.workspaceProjection.errors.notificationOperationsUnavailable)
    const result = await bridge.markNotificationUnread(params)
    get().applyMutation(result)
    await get().refreshNotifications()
  },
  refresh: async () => {
    const bridge = activeBridge
    if (!bridge) return
    const currentGeneration = generation
    const requestId = ++requestSequence
    latestStatusRequest = requestId
    try {
      const identity = await bridge.identify()
      if (currentGeneration !== generation) return
      const organizationEnabled = identity.capabilities.includes('workspace-groups-v1')
      const savedLayoutsEnabled = identity.capabilities.includes('saved-layouts-v1')
      if (organizationEnabled && !bridge.getWorkspaceOrganization) {
        throw new Error('The workspace organization bridge is unavailable')
      }
      if (savedLayoutsEnabled && !bridge.listSavedLayouts) {
        throw new Error('The saved-layout bridge is unavailable')
      }
      const [workspaces, settings, notifications, organizationResult, savedLayouts] =
        await Promise.all([
          bridge.listWorkspaces(),
          bridge.getSettings(),
          listNotificationHistory(bridge, notificationHistoryLimit),
          organizationEnabled ? bridge.getWorkspaceOrganization!() : Promise.resolve(undefined),
          savedLayoutsEnabled ? bridge.listSavedLayouts!() : Promise.resolve(undefined)
        ])
      if (currentGeneration !== generation || requestId !== latestStatusRequest) return
      if (
        (organizationEnabled && organizationResult === null) ||
        (savedLayoutsEnabled && savedLayouts === null)
      ) {
        void get().initialize(bridge)
        return
      }
      const currentSnapshot = get().snapshot
      const projectionIsCurrent =
        currentSnapshot === null || workspaces.snapshot.revision >= currentSnapshot.revision
      discardRemovedCardSlotWorkspaces(get().snapshot, workspaces.snapshot)
      set((state) => ({
        ...applyProjection(state, workspaces.snapshot, settings),
        identity,
        organization: organizationEnabled
          ? organizationResult &&
            (!state.organization ||
              organizationResult.organization.revision >= state.organization.revision)
            ? organizationResult.organization
            : state.organization
          : null,
        savedLayouts: savedLayoutsEnabled
          ? savedLayouts &&
            (!state.savedLayouts || savedLayouts.revision >= state.savedLayouts.revision)
            ? savedLayouts
            : state.savedLayouts
          : null,
        ...(notifications ? { notifications: currentNotifications(state, notifications) } : {}),
        ...(requestId === latestStatusRequest && shutdownGeneration !== currentGeneration
          ? { status: 'ready' as const, error: null }
          : {})
      }))
      if (projectionIsCurrent) discardUnknownPendingCardSlots(workspaces.snapshot)
      refreshKnownCardSlots(get)
      refreshKnownCardSlotsV2(get)
      refreshKnownAttention(get)
    } catch (error) {
      if (
        currentGeneration !== generation ||
        requestId !== latestStatusRequest ||
        shutdownGeneration === currentGeneration
      )
        return
      set({
        status: 'error',
        error: workspaceErrorMessage(error, 'refresh')
      })
    }
  },
  refreshNotifications: async () => {
    const bridge = activeBridge
    if (!bridge?.listNotifications) return
    const currentGeneration = generation
    const notifications = await listNotificationHistory(bridge, notificationHistoryLimit)
    if (currentGeneration !== generation) return
    if (notifications)
      set((state) => ({ notifications: currentNotifications(state, notifications) }))
  },
  refreshOrganization: async () => {
    const bridge = activeBridge
    if (!get().identity?.capabilities.includes('workspace-groups-v1')) return
    if (!bridge?.getWorkspaceOrganization) {
      throw new Error('The workspace organization bridge is unavailable')
    }
    const currentGeneration = generation
    const result = await bridge.getWorkspaceOrganization()
    if (currentGeneration !== generation || bridge !== activeBridge) return
    if (result === null) {
      void get().initialize(bridge)
      return
    }
    set((state) =>
      state.organization && state.organization.revision > result.organization.revision
        ? state
        : { organization: result.organization }
    )
  },
  refreshSavedLayouts: async () => {
    const bridge = activeBridge
    if (!get().identity?.capabilities.includes('saved-layouts-v1')) return
    if (!bridge?.listSavedLayouts) throw new Error('The saved-layout bridge is unavailable')
    const currentGeneration = generation
    const result = await bridge.listSavedLayouts()
    if (currentGeneration !== generation || bridge !== activeBridge) return
    if (result === null) {
      void get().initialize(bridge)
      return
    }
    set((state) =>
      state.savedLayouts && state.savedLayouts.revision > result.revision
        ? state
        : { savedLayouts: result }
    )
  },
  refreshWorkspaceCardSlots: async (workspaceId, minimumRevision = 0) => {
    const bridge = activeBridge
    if (!bridge?.getWorkspaceCardSlots) return
    const currentGeneration = generation
    if (!get().snapshot?.workspaces.some(({ id }) => id === workspaceId)) {
      return
    }
    rememberCardSlotRevision(workspaceId, minimumRevision)
    if (cardSlotRefreshes.has(workspaceId)) return
    cardSlotRefreshes.set(workspaceId, currentGeneration)
    try {
      const slots = await bridge.getWorkspaceCardSlots({ workspaceId })
      if (currentGeneration !== generation || bridge !== activeBridge) return
      const requiredRevision = pendingCardSlotRevisions.get(workspaceId) ?? minimumRevision
      let accepted = false
      let workspacePresent = true
      set((state) => {
        if (!state.snapshot?.workspaces.some(({ id }) => id === workspaceId)) {
          workspacePresent = false
          const cardSlots = { ...state.cardSlots }
          delete cardSlots[workspaceId]
          return { cardSlots }
        }
        const current = state.cardSlots[workspaceId]
        if (slots.revision < requiredRevision || (current && slots.revision < current.revision)) {
          return state
        }
        accepted = true
        return { cardSlots: { ...state.cardSlots, [workspaceId]: slots } }
      })
      if (!workspacePresent) {
        pendingCardSlotRevisions.delete(workspaceId)
        clearCardSlotRetry(workspaceId)
      } else if (accepted) {
        if ((pendingCardSlotRevisions.get(workspaceId) ?? 0) <= slots.revision) {
          pendingCardSlotRevisions.delete(workspaceId)
        }
        clearCardSlotRetry(workspaceId)
      } else {
        scheduleCardSlotRetry(workspaceId, currentGeneration, get)
      }
    } catch {
      if (currentGeneration !== generation || bridge !== activeBridge) return
      if (!get().snapshot?.workspaces.some(({ id }) => id === workspaceId)) {
        pendingCardSlotRevisions.delete(workspaceId)
        clearCardSlotRetry(workspaceId)
        set((state) => {
          const cardSlots = { ...state.cardSlots }
          delete cardSlots[workspaceId]
          return { cardSlots }
        })
      } else {
        scheduleCardSlotRetry(workspaceId, currentGeneration, get)
      }
    } finally {
      if (cardSlotRefreshes.get(workspaceId) === currentGeneration) {
        cardSlotRefreshes.delete(workspaceId)
      }
    }
  },
  refreshWorkspaceCardSlotV2: async (workspaceId, kind, minimumRevision = 0) => {
    const bridge = activeBridge
    if (!get().identity?.capabilities.includes('card-slots-v2') || !bridge?.getWorkspaceCardSlotV2)
      return
    if (!get().snapshot?.workspaces.some(({ id }) => id === workspaceId)) return
    const currentGeneration = generation
    const key = cardSlotV2Key(workspaceId, kind)
    cardSlotV2PendingRevisions.set(
      key,
      Math.max(cardSlotV2PendingRevisions.get(key) ?? 0, minimumRevision)
    )
    if (cardSlotV2Refreshes.has(key)) return
    cardSlotV2Refreshes.add(key)
    try {
      const incoming = await bridge.getWorkspaceCardSlotV2({ workspaceId, kind })
      if (currentGeneration !== generation || bridge !== activeBridge) return
      const required = cardSlotV2PendingRevisions.get(key) ?? minimumRevision
      let accepted = false
      set((state) => {
        if (!state.snapshot?.workspaces.some(({ id }) => id === workspaceId)) {
          const cardSlotsV2 = { ...state.cardSlotsV2 }
          delete cardSlotsV2[workspaceId]
          return { cardSlotsV2 }
        }
        const current = state.cardSlotsV2[workspaceId]?.[kind]
        if (
          incoming.kind !== kind ||
          incoming.workspaceId !== workspaceId ||
          incoming.slotRevision < required ||
          (current && incoming.slotRevision < current.slotRevision)
        ) {
          return state
        }
        accepted = true
        return {
          cardSlotsV2: {
            ...state.cardSlotsV2,
            [workspaceId]: { ...state.cardSlotsV2[workspaceId], [kind]: incoming }
          }
        }
      })
      if (accepted) {
        if ((cardSlotV2PendingRevisions.get(key) ?? 0) <= incoming.slotRevision) {
          cardSlotV2PendingRevisions.delete(key)
        }
        clearCardSlotV2Retry(key)
      } else {
        scheduleCardSlotV2Retry(workspaceId, kind, currentGeneration, get)
      }
    } catch {
      if (currentGeneration === generation && bridge === activeBridge) {
        scheduleCardSlotV2Retry(workspaceId, kind, currentGeneration, get)
      }
    } finally {
      cardSlotV2Refreshes.delete(key)
      if (
        currentGeneration === generation &&
        (cardSlotV2PendingRevisions.get(key) ?? 0) >
          (get().cardSlotsV2[workspaceId]?.[kind]?.slotRevision ?? -1)
      ) {
        scheduleCardSlotV2Retry(workspaceId, kind, currentGeneration, get)
      }
    }
  },
  refreshWorkspaceAttention: async (workspaceId, minimumRevision = 0) => {
    const bridge = activeBridge
    if (
      !get().identity?.capabilities.includes('attention-v1') ||
      !bridge?.getWorkspaceAttention ||
      attentionRefreshes.has(workspaceId)
    )
      return
    const currentGeneration = generation
    if (!get().snapshot?.workspaces.some(({ id }) => id === workspaceId)) return
    pendingAttentionRevisions.set(
      workspaceId,
      Math.max(pendingAttentionRevisions.get(workspaceId) ?? 0, minimumRevision)
    )
    attentionRefreshes.add(workspaceId)
    try {
      const snapshot = await bridge.getWorkspaceAttention({ workspaceId })
      if (currentGeneration !== generation || bridge !== activeBridge) return
      const required = pendingAttentionRevisions.get(workspaceId) ?? minimumRevision
      if (snapshot.revision < required) return
      set((state) => {
        const current = state.attention[workspaceId]
        if (current && current.revision > snapshot.revision) return state
        return { attention: { ...state.attention, [workspaceId]: snapshot } }
      })
      if ((pendingAttentionRevisions.get(workspaceId) ?? 0) <= snapshot.revision) {
        pendingAttentionRevisions.delete(workspaceId)
      }
      clearAttentionRetry(workspaceId)
    } catch {
      scheduleAttentionRetry(workspaceId, currentGeneration, get)
    } finally {
      attentionRefreshes.delete(workspaceId)
      if (
        currentGeneration === generation &&
        (pendingAttentionRevisions.get(workspaceId) ?? 0) >
          (get().attention[workspaceId]?.revision ?? -1)
      ) {
        scheduleAttentionRetry(workspaceId, currentGeneration, get)
      }
    }
  },
  reportMutationError: (error) => set({ mutationError: workspaceErrorMessage(error, 'mutation') }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen }))
}))

function scheduleRefresh(
  currentGeneration: number,
  get: () => ProjectionState,
  minimumRevision = 0
): void {
  if (minimumRevision > pendingProjectionRevision) {
    pendingProjectionRevision = minimumRevision
    projectionRefreshRetryAttempt = 0
  }
  scheduleProjectionRefresh(currentGeneration, get, EVENT_REFRESH_DELAY_MS)
}

function scheduleProjectionRefresh(
  currentGeneration: number,
  get: () => ProjectionState,
  delay: number
): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    if (currentGeneration === generation) {
      void refreshPendingProjection(currentGeneration, get)
    }
  }, delay)
}

async function refreshPendingProjection(
  currentGeneration: number,
  get: () => ProjectionState
): Promise<void> {
  await get().refresh()
  if (currentGeneration !== generation || pendingProjectionRevision === 0) return
  if ((get().snapshot?.revision ?? -1) >= pendingProjectionRevision) {
    pendingProjectionRevision = 0
    projectionRefreshRetryAttempt = 0
    return
  }
  const delay = PROJECTION_REFRESH_RETRY_DELAYS_MS[projectionRefreshRetryAttempt]
  if (delay === undefined) return
  projectionRefreshRetryAttempt += 1
  scheduleProjectionRefresh(currentGeneration, get, delay)
}

function staleInitialization(
  currentGeneration: number,
  requestId: number,
  get: () => ProjectionState
): boolean {
  if (currentGeneration !== generation) return true
  if (requestId === latestStatusRequest) return false
  scheduleRefresh(currentGeneration, get)
  return true
}

export function resetProjectionStoreForTests(): void {
  generation += 1
  cleanupSubscriptions?.()
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = undefined
  pendingProjectionRevision = 0
  projectionRefreshRetryAttempt = 0
  resetCardSlotCoordinationState()
  cleanupSubscriptions = undefined
  activeBridge = undefined
  notificationHistoryLimit = NOTIFICATION_PAGE_SIZE
  latestStatusRequest = ++requestSequence
  shutdownGeneration = undefined
  useProjectionStore.setState({
    attention: {},
    cardSlots: {},
    cardSlotsV2: {},
    error: null,
    identity: null,
    mutationError: null,
    notificationHistoryLoading: false,
    notifications: null,
    organization: null,
    savedLayouts: null,
    paletteOpen: false,
    recentNotificationEvents: [],
    settings: null,
    settingsOpen: false,
    sidebarOpen: true,
    snapshot: null,
    status: 'idle'
  })
}
