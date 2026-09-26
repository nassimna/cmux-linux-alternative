import { randomUUID } from 'node:crypto'

import type { DurableApplicationState } from '@agent-workspace/contracts'

import { RecentlyClosedError } from '../domain/recently-closed-mutations'
import type { ApplicationStateStore, TabReopenRequest } from './application-state-store'

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
type Record = DurableApplicationState['recentlyClosed'][number]
type Action = 'reopenTerminal' | 'reopenBrowser'

export interface ClosedItemSnapshot {
  closedItemId: string
  itemKind: 'tab' | 'workspace'
  priorItemId: string
  contentKind: 'terminal' | 'browser'
  title: string
  closedAtMs: number
  restored: false
}

interface Descriptor {
  closedId: string
  revision: number
  action: Action
}

/** Construct only from a server-held, already validated window binding. */
export interface TrustedWindowBinding {
  readonly windowId: string
  isCurrent(): boolean
}

/** The adapter prepares and owns a PTY before commit; a rejected prepare must clean up itself. */
export interface TerminalReopenAdapter {
  prepare(input: {
    workspaceId: string
    paneId: string
    tabId: string
    launch: { cwd: string; rows: number; cols: number }
  }): Promise<{
    terminalId: string
    /** This synchronous mapping step must finish before the durable commit. */
    adopt(): void
    /** Stops the PTY and removes the mapping if prepare/adopt/commit fails. */
    close(): void
  }>
}

function project(record: Record): ClosedItemSnapshot {
  return {
    closedItemId: record.id,
    itemKind: record.itemKind,
    priorItemId: record.priorTabId ?? record.priorWorkspaceId,
    contentKind: record.contentKind,
    title: record.title,
    closedAtMs: record.closedAt,
    restored: false
  }
}

function visible(record: Record, now: number): boolean {
  return Math.max(0, now - record.closedAt) <= RETENTION_MS
}

function owned(state: DurableApplicationState, record: Record, boundWindowId?: string): boolean {
  if (!boundWindowId) return true
  return state.windowPlacements.some(
    (window) => window.id === boundWindowId && window.workspaceIds.includes(record.priorWorkspaceId)
  )
}

/** Rust multi-window reads and global sidebar commands. Use one unbound instance for sidebar
 * descriptors, and separate bound instances for window-scoped multi-window commands. */
export class RecentlyClosedService {
  private readonly descriptors = new Map<string, Descriptor>()

  public constructor(
    private readonly state: ApplicationStateStore,
    private readonly now: () => number = Date.now,
    private readonly terminals?: TerminalReopenAdapter,
    private readonly binding?: TrustedWindowBinding
  ) {}

  /** Give a validated private window capability its own scoped read and reopen view. */
  public forWindow(binding: TrustedWindowBinding): RecentlyClosedService {
    return new RecentlyClosedService(this.state, this.now, this.terminals, binding)
  }

  private boundWindowId(): string | undefined {
    if (this.binding && !this.binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
    return this.binding?.windowId
  }

  public list(): { revision: number; items: ClosedItemSnapshot[] } {
    const boundWindowId = this.boundWindowId()
    const state = this.state.readSnapshot()
    const now = this.now()
    return {
      revision: state.revision,
      items: state.recentlyClosed
        .filter((record) => visible(record, now) && owned(state, record, boundWindowId))
        .map(project)
    }
  }

  public get(closedItemId: string): {
    revision: number
    item: ClosedItemSnapshot
  } {
    const boundWindowId = this.boundWindowId()
    const state = this.state.readSnapshot()
    const record = state.recentlyClosed.find(
      (item) =>
        item.id === closedItemId && visible(item, this.now()) && owned(state, item, boundWindowId)
    )
    if (!record) throw new RecentlyClosedError('source_not_found')
    return { revision: state.revision, item: project(record) }
  }

  /** Global Rust sidebar list: all stored records, including those past the multi-window
   * 30-day visibility window. Expose only through the trusted sidebar capability. */
  public listSidebar(
    input: { limit: number; cursor?: string },
    binding?: TrustedWindowBinding
  ): {
    records: Array<{
      recentlyClosedId: string
      authorizedDescriptorId: string
      action: Action
      label: string
      closedAtMs: number
      revision: number
    }>
    nextCursor?: string
  } {
    this.requireGlobalSidebar()
    if (binding && !binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.cursor !== undefined && !isUuid(input.cursor))
    )
      throw new RecentlyClosedError('policy_denied')
    const state = this.state.readSnapshot()
    const revision = Math.max(1, state.revision)
    const ids = new Set(state.recentlyClosed.map((item) => item.id))
    for (const [id, descriptor] of this.descriptors) {
      if (!ids.has(descriptor.closedId) || descriptor.revision !== revision)
        this.descriptors.delete(id)
    }
    const records = state.recentlyClosed
      .map((record) => {
        const action: Action =
          record.contentKind === 'terminal' ? 'reopenTerminal' : 'reopenBrowser'
        let descriptorId = [...this.descriptors].find(
          ([, descriptor]) =>
            descriptor.closedId === record.id &&
            descriptor.revision === revision &&
            descriptor.action === action
        )?.[0]
        if (!descriptorId) {
          descriptorId = randomUUID()
          this.descriptors.set(descriptorId, { closedId: record.id, revision, action })
        }
        return {
          recentlyClosedId: record.id,
          authorizedDescriptorId: descriptorId,
          action,
          label: record.title,
          closedAtMs: record.closedAt,
          revision
        }
      })
      .sort((a, b) => a.recentlyClosedId.localeCompare(b.recentlyClosedId))
      .filter((record) => input.cursor === undefined || record.recentlyClosedId > input.cursor)
    const page = records.slice(0, input.limit)
    return {
      records: page,
      ...(records.length > input.limit ? { nextCursor: page.at(-1)!.recentlyClosedId } : {})
    }
  }

  /** Plain tab.reopen requires a validated caller window binding when one exists. */
  public async reopenTab(input: TabReopenRequest) {
    return this.state.exclusive(() => this.reopenLocked(input))
  }

  /** Sidebar action requires the independently issued descriptor and exact revision. */
  public async reopenFromSidebar(
    input: TabReopenRequest & {
      authorizedDescriptorId: string
      action: Action
      expectedClosedRevision: number
    },
    binding?: TrustedWindowBinding
  ) {
    this.requireGlobalSidebar()
    return this.state.exclusive(() => {
      if (binding && (!binding.isCurrent() || binding.windowId !== input.target.windowId)) {
        throw new RecentlyClosedError('unauthorized')
      }
      if (input.expectedClosedRevision !== input.expectedRevision) {
        throw new RecentlyClosedError('stale_revision')
      }
      const request: TabReopenRequest = {
        closedItemId: input.closedItemId,
        target: input.target,
        expectedRevision: input.expectedRevision,
        idempotencyEpoch: input.idempotencyEpoch,
        idempotencyKey: input.idempotencyKey
      }
      const replay = this.state.findTabReopenReplay(request)
      if (replay) {
        const action: Action =
          replay.ownershipKind === 'terminal' ? 'reopenTerminal' : 'reopenBrowser'
        if (input.action !== action) throw new RecentlyClosedError('stale_revision')
        return replay
      }
      this.validateSidebarDescriptor(input)
      return this.reopenLocked(request, binding)
    })
  }

  private requireGlobalSidebar(): void {
    if (this.binding) throw new RecentlyClosedError('unauthorized')
  }

  private validateSidebarDescriptor(
    input: TabReopenRequest & {
      authorizedDescriptorId: string
      action: Action
      expectedClosedRevision: number
    }
  ): void {
    if (input.expectedClosedRevision !== input.expectedRevision)
      throw new RecentlyClosedError('stale_revision')
    const state = this.state.readSnapshot()
    const record = state.recentlyClosed.find((item) => item.id === input.closedItemId)
    if (!record) throw new RecentlyClosedError('source_not_found')
    const expectedAction: Action =
      record.contentKind === 'terminal' ? 'reopenTerminal' : 'reopenBrowser'
    const descriptor = this.descriptors.get(input.authorizedDescriptorId)
    if (!descriptor) throw new RecentlyClosedError('unauthorized')
    if (
      state.revision !== input.expectedClosedRevision ||
      descriptor.closedId !== record.id ||
      descriptor.revision !== input.expectedClosedRevision ||
      descriptor.action !== input.action ||
      input.action !== expectedAction
    )
      throw new RecentlyClosedError('stale_revision')
  }

  private async reopenLocked(input: TabReopenRequest, binding?: TrustedWindowBinding) {
    const boundWindowId = this.boundWindowId()
    if (binding && (!binding.isCurrent() || binding.windowId !== input.target.windowId)) {
      throw new RecentlyClosedError('unauthorized')
    }
    if (boundWindowId && input.target.windowId !== boundWindowId)
      throw new RecentlyClosedError('unauthorized')
    const ids = { tabId: randomUUID(), browserSessionId: randomUUID() }
    const createdAt = this.now()
    const plan = this.state.preflightTabReopen(input, ids, createdAt)
    if (plan.replay) return plan.replay
    const workspace = plan.candidate.workspaces.find(
      (item) => item.id === input.target.workspaceId
    )!
    const tab = workspace.tabs[ids.tabId]!
    if (tab.content.kind !== 'terminal') {
      if (binding && !binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
      return this.state.commitTabReopen(input, ids, createdAt)
    }
    if (!this.terminals) throw new RecentlyClosedError('runtime_unavailable')
    const prepared = await this.terminals.prepare({
      workspaceId: workspace.id,
      paneId: tab.paneId,
      tabId: tab.id,
      launch: tab.content.launch
    })
    try {
      prepared.adopt()
      const currentBinding = this.boundWindowId()
      if (binding && (!binding.isCurrent() || binding.windowId !== input.target.windowId)) {
        throw new RecentlyClosedError('unauthorized')
      }
      if (currentBinding && currentBinding !== input.target.windowId)
        throw new RecentlyClosedError('unauthorized')
      const result = this.state.commitTabReopen(input, ids, createdAt)
      if (result.replayed) prepared.close()
      return result
    } catch (error) {
      try {
        prepared.close()
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Recently closed terminal rollback failed',
          {
            cause: rollbackError
          }
        )
      }
      throw error
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
}
