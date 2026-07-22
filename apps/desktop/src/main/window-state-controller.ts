import {
  windowStateGetResultSchema,
  windowStateSnapshotSchema,
  type WindowStateSnapshot
} from '@agent-workspace/protocol-client'
import type { Rectangle } from 'electron'

export interface WindowStateClient {
  getWindowState(): Promise<unknown>
  updateWindowState(params: { state: WindowStateSnapshot }): Promise<unknown>
}

export interface PersistedWindow {
  getNormalBounds(): Rectangle
  isMaximized(): boolean
  isFullScreen(): boolean
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

export interface DisplaySnapshot {
  id: number | string
  workArea: Rectangle
}

export interface WindowStateControllerOptions {
  debounceMs?: number
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  cancelSchedule?(handle: ReturnType<typeof setTimeout>): void
  getDisplayMatching(bounds: Rectangle): DisplaySnapshot
}

interface PendingGeometry {
  sequence: number
  state: WindowStateSnapshot
}

interface PersistenceAttempt {
  sequence: number
  state: WindowStateSnapshot
  dirtySequence?: number
  normalizationSequence?: number
}

const WINDOW_EVENTS = [
  'move',
  'resize',
  'maximize',
  'unmaximize',
  'enter-full-screen',
  'leave-full-screen'
] as const

export function visibleSavedWindowState(
  rawState: unknown,
  displays: readonly DisplaySnapshot[]
): WindowStateSnapshot | undefined {
  const parsed = windowStateSnapshotSchema.safeParse(rawState)
  if (!parsed.success) return undefined
  const state = parsed.data as WindowStateSnapshot
  const bounds = { x: state.x, y: state.y, width: state.width, height: state.height }
  const sufficientlyVisible = displays.some(({ workArea }) => {
    const width = Math.max(
      0,
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
        Math.max(bounds.x, workArea.x)
    )
    const height = Math.max(
      0,
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
        Math.max(bounds.y, workArea.y)
    )
    return width >= Math.min(120, bounds.width) && height >= Math.min(80, bounds.height)
  })
  return sufficientlyVisible ? state : undefined
}

export class WindowStateController {
  private client: WindowStateClient | undefined
  private clientGeneration = 0
  private clientReady = false
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextSequence = 0
  private pendingGeometry: PendingGeometry | undefined
  private normalizationPending:
    | (PendingGeometry & {
        generation: number
      })
    | undefined
  private disposed = false
  private persistence: Promise<void> = Promise.resolve()
  private persistenceQueued = false
  private activePersistence:
    | {
        generation: number
        sequence: number
      }
    | undefined
  private readonly listener = (): void => this.schedulePersistence()
  private readonly debounceMs: number
  private readonly schedule: NonNullable<WindowStateControllerOptions['schedule']>
  private readonly cancelSchedule: NonNullable<WindowStateControllerOptions['cancelSchedule']>

  public constructor(
    private readonly window: PersistedWindow,
    private readonly options: WindowStateControllerOptions
  ) {
    this.debounceMs = options.debounceMs ?? 200
    this.schedule = options.schedule
      ? (callback, delayMs) =>
          options.schedule?.(callback, delayMs) ?? setTimeout(callback, delayMs)
      : (callback, delayMs) => setTimeout(callback, delayMs)
    this.cancelSchedule = options.cancelSchedule
      ? (handle) => options.cancelSchedule?.(handle)
      : (handle) => clearTimeout(handle)
    for (const event of WINDOW_EVENTS) window.on(event, this.listener)
  }

  public setClient(client: WindowStateClient, initialState?: WindowStateSnapshot): void {
    const generation = ++this.clientGeneration
    this.client = client
    this.clientReady = true
    this.revision = initialState?.revision ?? 0
    this.normalizationPending =
      initialState && !this.matchesCurrentWindow(initialState)
        ? { ...this.capturePendingGeometry(), generation }
        : undefined
    if (this.hasPendingPersistence(generation)) this.enqueuePersistence()
  }

  public clearClient(): void {
    this.clientGeneration += 1
    this.client = undefined
    this.clientReady = false
    this.normalizationPending = undefined
  }

  public async rebase(client: WindowStateClient): Promise<void> {
    const generation = ++this.clientGeneration
    this.client = client
    this.clientReady = false
    this.normalizationPending = undefined
    let result: ReturnType<typeof windowStateGetResultSchema.parse>
    try {
      result = windowStateGetResultSchema.parse(await client.getWindowState())
    } catch (error) {
      if (this.isCurrentClient(client, generation)) {
        this.clientReady = true
        if (this.hasPendingPersistence(generation)) this.enqueuePersistence()
      }
      throw error
    }
    if (!this.isCurrentClient(client, generation)) return
    this.revision = result.state?.revision ?? 0
    this.clientReady = true
    if (this.hasPendingPersistence(generation)) this.enqueuePersistence()
  }

  public async flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer)
      this.timer = undefined
    }
    if (this.hasPendingPersistence(this.clientGeneration)) this.enqueuePersistence()
    await this.persistence
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    for (const event of WINDOW_EVENTS) this.window.removeListener(event, this.listener)
    await this.flush().catch(() => undefined)
  }

  private schedulePersistence(): void {
    if (this.disposed) return
    this.pendingGeometry = this.capturePendingGeometry()
    if (this.timer !== undefined) this.cancelSchedule(this.timer)
    this.timer = this.schedule(() => {
      this.timer = undefined
      this.enqueuePersistence()
    }, this.debounceMs)
  }

  private enqueuePersistence(): void {
    const sequence = this.latestPendingSequence(this.clientGeneration)
    if (
      sequence === undefined ||
      this.persistenceQueued ||
      (this.activePersistence?.generation === this.clientGeneration &&
        sequence <= this.activePersistence.sequence)
    ) {
      return
    }
    this.persistenceQueued = true
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(async () => {
        this.persistenceQueued = false
        await this.persistLatest()
      })
  }

  private async persistLatest(): Promise<void> {
    const client = this.client
    const generation = this.clientGeneration
    if (!client || !this.clientReady || !this.hasPendingPersistence(generation)) return
    let attempt = this.createAttempt(generation, this.revision + 1)
    if (!attempt) return
    this.activePersistence = { generation, sequence: attempt.sequence }
    let succeededForCurrentClient = false
    try {
      const result = windowStateGetResultSchema.parse(
        await client.updateWindowState({ state: attempt.state })
      )
      if (this.isCurrentClient(client, generation)) {
        this.revision = result.state?.revision ?? attempt.state.revision
        this.acknowledgeAttempt(attempt, generation)
        succeededForCurrentClient = true
      } else {
        this.preserveStaleAttempt(attempt)
      }
    } catch (error) {
      if (!this.isCurrentClient(client, generation)) {
        this.preserveStaleAttempt(attempt)
        return
      }
      if (!isRevisionConflict(error)) {
        this.preserveAttempt(attempt)
        throw error
      }
      try {
        const current = windowStateGetResultSchema.parse(await client.getWindowState())
        if (!this.isCurrentClient(client, generation)) {
          this.preserveStaleAttempt(attempt)
          return
        }
        this.revision = current.state?.revision ?? 0
        const latest = this.createAttempt(generation, this.revision + 1)
        if (!latest) return
        attempt = latest
        this.activePersistence = { generation, sequence: latest.sequence }
        const retried = windowStateGetResultSchema.parse(
          await client.updateWindowState({ state: latest.state })
        )
        if (this.isCurrentClient(client, generation)) {
          this.revision = retried.state?.revision ?? latest.state.revision
          this.acknowledgeAttempt(latest, generation)
          succeededForCurrentClient = true
        } else {
          this.preserveStaleAttempt(latest)
        }
      } catch (retryError) {
        if (!this.isCurrentClient(client, generation)) {
          this.preserveStaleAttempt(attempt)
          return
        }
        this.preserveAttempt(attempt)
        throw retryError
      }
    } finally {
      if (
        succeededForCurrentClient &&
        this.isCurrentClient(client, generation) &&
        this.hasPendingPersistence(generation)
      ) {
        this.enqueuePersistence()
      }
      if (
        this.activePersistence?.generation === generation &&
        this.activePersistence.sequence === attempt.sequence
      ) {
        this.activePersistence = undefined
      }
    }
  }

  private isCurrentClient(client: WindowStateClient, generation: number): boolean {
    return this.client === client && this.clientGeneration === generation
  }

  private hasPendingPersistence(generation: number): boolean {
    return (
      this.pendingGeometry !== undefined || this.normalizationPending?.generation === generation
    )
  }

  private latestPendingSequence(generation: number): number | undefined {
    const normalizationSequence =
      this.normalizationPending?.generation === generation
        ? this.normalizationPending.sequence
        : undefined
    if (this.pendingGeometry && normalizationSequence !== undefined) {
      return Math.max(this.pendingGeometry.sequence, normalizationSequence)
    }
    return this.pendingGeometry?.sequence ?? normalizationSequence
  }

  private capturePendingGeometry(): PendingGeometry {
    return { sequence: ++this.nextSequence, state: this.capture(0) }
  }

  private createAttempt(generation: number, revision: number): PersistenceAttempt | undefined {
    const dirty = this.pendingGeometry
    const normalization =
      this.normalizationPending?.generation === generation ? this.normalizationPending : undefined
    if (!dirty && !normalization) return undefined
    const latest =
      dirty && normalization
        ? dirty.sequence > normalization.sequence
          ? dirty
          : normalization
        : (dirty ?? normalization)
    if (!latest) return undefined
    return {
      sequence: latest.sequence,
      state: { ...latest.state, revision },
      ...(dirty ? { dirtySequence: dirty.sequence } : {}),
      ...(normalization ? { normalizationSequence: normalization.sequence } : {})
    }
  }

  private acknowledgeAttempt(attempt: PersistenceAttempt, generation: number): void {
    if (
      attempt.dirtySequence !== undefined &&
      this.pendingGeometry?.sequence === attempt.dirtySequence
    ) {
      this.pendingGeometry = undefined
    }
    if (
      attempt.normalizationSequence !== undefined &&
      this.normalizationPending?.generation === generation &&
      this.normalizationPending.sequence === attempt.normalizationSequence
    ) {
      this.normalizationPending = undefined
    }
  }

  private preserveAttempt(attempt: PersistenceAttempt): void {
    if (!this.pendingGeometry || this.pendingGeometry.sequence < attempt.sequence) {
      this.pendingGeometry = {
        sequence: attempt.sequence,
        state: { ...attempt.state, revision: 0 }
      }
    }
  }

  private preserveStaleAttempt(attempt: PersistenceAttempt): void {
    this.preserveAttempt(attempt)
    if (this.client && this.clientReady) this.enqueuePersistence()
  }

  private matchesCurrentWindow(state: WindowStateSnapshot): boolean {
    const current = this.capture(state.revision)
    return (
      current.x === state.x &&
      current.y === state.y &&
      current.width === state.width &&
      current.height === state.height &&
      current.maximized === state.maximized &&
      current.fullscreen === state.fullscreen &&
      current.displayId === state.displayId
    )
  }

  private capture(revision: number): WindowStateSnapshot {
    const bounds = this.window.getNormalBounds()
    const displayId = String(this.options.getDisplayMatching(bounds).id)
    return windowStateSnapshotSchema.parse({
      revision,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      maximized: this.window.isMaximized(),
      fullscreen: this.window.isFullScreen(),
      displayId
    }) as WindowStateSnapshot
  }
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && /revision|conflict|stale/iu.test(error.message)
}
