import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'

import type { BrowserViewManager } from './browser-view-manager'
import type { WindowStateController } from './window-state-controller'

export interface WindowRegistryBinding {
  readonly browserViews: BrowserViewManager
  readonly stateController: WindowStateController
  dispose(): Promise<void>
}

export interface WindowRegistryEntry {
  readonly windowId: string
  readonly window: BrowserWindow
  readonly generation: number
  readonly binding: WindowRegistryBinding
  readonly terminalAttachments: Set<string>
}

export type WindowRemovalReason = 'closed' | 'renderer-crashed' | 'replaced' | 'shutdown'

export interface RemovedWindow {
  readonly entry: WindowRegistryEntry
  readonly reason: WindowRemovalReason
}

interface SenderBinding {
  readonly entry: WindowRegistryEntry
  readonly contents: WebContents
  readonly generation: number
}

type OwnershipOperation = 'attachOwnership' | 'detachOwnership' | 'recoverOwnership'

interface ResourceTransferEpoch {
  readonly epoch: number
  readonly operation: OwnershipOperation
  readonly windowId: string
  readonly detachedWindowId?: string
}

interface OwnershipTransferBarrier {
  epoch: number | undefined
  readonly sourceWindowId: string
  readonly targetWindowId: string
  readonly promise: Promise<void>
  readonly status: 'pending' | 'resolved' | 'rejected'
  resolve(): void
  reject(error: Error): void
}

interface WindowActivationBarrier {
  readonly generation: number
  readonly promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

const MAX_TRACKED_RESOURCE_TRANSFERS = 4096

/**
 * Main-process ownership index for every privileged renderer resource.
 *
 * A sender is accepted only while its exact WebContents, main frame, and renderer
 * generation are current. This makes stale IPC fail closed after a crash/reload.
 */
export class WindowRegistry {
  readonly #entries = new Map<string, WindowRegistryEntry>()
  readonly #senders = new Map<number, SenderBinding>()
  readonly #windows = new WeakMap<BrowserWindow, WindowRegistryEntry>()
  readonly #resourceTransfers = new Map<string, Promise<unknown>>()
  readonly #resourceTransferEpochs = new Map<string, ResourceTransferEpoch>()
  readonly #ownershipTransferBarriers = new Map<string, OwnershipTransferBarrier>()
  readonly #rendererResourceOwners = new Map<string, string>()
  readonly #windowActivationBarriers = new Map<string, WindowActivationBarrier>()
  #providerEpoch: number | undefined
  #nextGeneration = 0

  public constructor(private readonly invalidateGeneration?: (windowId: string) => void) {}

  public register(
    windowId: string,
    window: BrowserWindow,
    binding: WindowRegistryBinding,
    generation?: number
  ): WindowRegistryEntry {
    if (this.#entries.has(windowId)) throw new Error('Window placement is already hosted')
    if (this.#senders.has(window.webContents.id)) {
      throw new Error('Renderer WebContents is already registered')
    }
    const rendererGeneration = generation ?? this.#nextGeneration + 1
    if (!Number.isSafeInteger(rendererGeneration) || rendererGeneration < 1) {
      throw new Error('Invalid renderer generation')
    }
    this.#nextGeneration = Math.max(this.#nextGeneration, rendererGeneration)
    const entry: WindowRegistryEntry = {
      windowId,
      window,
      generation: rendererGeneration,
      binding,
      terminalAttachments: new Set()
    }
    this.#entries.set(windowId, entry)
    this.#windows.set(window, entry)
    this.#senders.set(window.webContents.id, {
      entry,
      contents: window.webContents,
      generation: entry.generation
    })
    return entry
  }

  /** Reserves exact renderer generations before persisted windows publish sequentially. */
  public reserveRendererGenerations(
    windowIds: readonly string[]
  ): readonly { windowId: string; generation: number }[] {
    if (new Set(windowIds).size !== windowIds.length) {
      throw new Error('Cannot reserve duplicate window placements')
    }
    if (windowIds.length > Number.MAX_SAFE_INTEGER - this.#nextGeneration) {
      throw new Error('Renderer generation capacity is exhausted')
    }
    return windowIds.map((windowId) => ({ windowId, generation: ++this.#nextGeneration }))
  }

  public get(windowId: string): WindowRegistryEntry | undefined {
    return this.#entries.get(windowId)
  }

  public findByWindow(window: BrowserWindow): WindowRegistryEntry | undefined {
    // Electron throws when `webContents` is read after the native `closed` event.
    // The acquisition cleanup keeps the placement ID separately, so a destroyed
    // window is never a live sender and can safely fail closed here.
    if (window.isDestroyed()) return undefined
    return this.#senders.get(window.webContents.id)?.entry
  }

  /** Replaces a provisional creation key with the service-issued placement ID. */
  public rekey(currentWindowId: string, serviceWindowId: string): WindowRegistryEntry {
    const entry = this.require(currentWindowId)
    if (currentWindowId === serviceWindowId) return entry
    if (this.#entries.has(serviceWindowId)) throw new Error('Window placement is already hosted')
    this.invalidateGeneration?.(currentWindowId)
    const rekeyed: WindowRegistryEntry = { ...entry, windowId: serviceWindowId }
    this.#entries.delete(currentWindowId)
    this.#entries.set(serviceWindowId, rekeyed)
    this.#windows.set(entry.window, rekeyed)
    const sender = this.#senders.get(entry.window.webContents.id)
    if (sender?.entry === entry) {
      this.#senders.set(entry.window.webContents.id, { ...sender, entry: rekeyed })
    }
    return rekeyed
  }

  public refreshRenderer(windowId: string): WindowRegistryEntry {
    const entry = this.require(windowId)
    if (this.#nextGeneration === Number.MAX_SAFE_INTEGER) {
      throw new Error('Renderer generation capacity is exhausted')
    }
    this.invalidateGeneration?.(windowId)
    const refreshed: WindowRegistryEntry = {
      ...entry,
      generation: ++this.#nextGeneration
    }
    this.#entries.set(windowId, refreshed)
    this.#windows.set(entry.window, refreshed)
    this.#senders.set(entry.window.webContents.id, {
      entry: refreshed,
      contents: entry.window.webContents,
      generation: refreshed.generation
    })
    return refreshed
  }

  public list(): readonly WindowRegistryEntry[] {
    return [...this.#entries.values()]
  }

  /** Blocks renderer initialization until CreateWindow has been acknowledged. */
  public deferWindowActivation(windowId: string, generation: number): void {
    if (this.#windowActivationBarriers.has(windowId)) {
      throw new Error('Window activation is already pending')
    }
    this.#windowActivationBarriers.set(windowId, createWindowActivationBarrier(generation))
  }

  public waitForWindowActivation(entry: WindowRegistryEntry): Promise<void> {
    const barrier = this.#windowActivationBarriers.get(entry.windowId)
    if (!barrier) return Promise.resolve()
    if (barrier.generation !== entry.generation) {
      return Promise.reject(new Error('Window activation generation is stale'))
    }
    return barrier.promise
  }

  public activateWindow(windowId: string, generation: number): void {
    const barrier = this.#windowActivationBarriers.get(windowId)
    if (!barrier) return
    if (barrier.generation !== generation) {
      throw new Error('Window activation generation is stale')
    }
    this.#windowActivationBarriers.delete(windowId)
    barrier.resolve()
  }

  public failWindowActivation(windowId: string, reason: string): void {
    const barrier = this.#windowActivationBarriers.get(windowId)
    if (!barrier) return
    this.#windowActivationBarriers.delete(windowId)
    barrier.reject(new Error(reason))
  }

  public resolveSender(event: IpcMainInvokeEvent): WindowRegistryEntry {
    const sender = this.#senders.get(event.sender.id)
    if (
      !sender ||
      sender.contents !== event.sender ||
      event.senderFrame !== sender.contents.mainFrame ||
      sender.entry.generation !== sender.generation ||
      this.#entries.get(sender.entry.windowId) !== sender.entry ||
      sender.entry.window.isDestroyed()
    ) {
      throw new Error('Unauthorized desktop IPC sender')
    }
    return sender.entry
  }

  public addTerminalAttachment(windowId: string, terminalId: string): void {
    this.require(windowId).terminalAttachments.add(terminalId)
  }

  public removeTerminalAttachment(windowId: string, terminalId: string): void {
    this.require(windowId).terminalAttachments.delete(terminalId)
  }

  /** Remembers the last renderer that successfully acquired a native resource. */
  public recordRendererOwnership(resourceId: string, windowId: string): void {
    if (
      !this.#rendererResourceOwners.has(resourceId) &&
      this.#rendererResourceOwners.size >= MAX_TRACKED_RESOURCE_TRANSFERS
    ) {
      throw new Error('Renderer ownership tracking capacity is exhausted')
    }
    this.#rendererResourceOwners.set(resourceId, windowId)
  }

  /** Removes a tombstone only when an authoritative close still names the expected owner. */
  public forgetRendererOwnership(resourceId: string, windowId?: string): void {
    if (windowId === undefined || this.#rendererResourceOwners.get(resourceId) === windowId) {
      this.#rendererResourceOwners.delete(resourceId)
    }
  }

  /** Deletes only this window's resources absent from its authoritative scoped projection. */
  public reconcileRendererOwnership(windowId: string, liveResourceIds: ReadonlySet<string>): void {
    for (const [resourceId, ownerWindowId] of this.#rendererResourceOwners) {
      if (ownerWindowId === windowId && !liveResourceIds.has(resourceId)) {
        this.#rendererResourceOwners.delete(resourceId)
      }
    }
  }

  public get rendererOwnershipCount(): number {
    return this.#rendererResourceOwners.size
  }

  /** Serializes ownership changes for one terminal or browser session. */
  public transfer<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#resourceTransfers.get(resourceId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.#resourceTransfers.set(resourceId, current)
    return current.finally(() => {
      if (this.#resourceTransfers.get(resourceId) === current)
        this.#resourceTransfers.delete(resourceId)
    })
  }

  /**
   * Runs an authoritative provider ownership transition once. Older epochs and
   * equal-epoch conflicting transitions are acknowledged as no-ops.
   */
  public transferOwnership(
    resourceId: string,
    transferEpoch: number,
    operation: OwnershipOperation,
    windowId: string,
    apply: () => Promise<void>
  ): Promise<boolean> {
    return this.transfer(resourceId, async () => {
      const current = this.#resourceTransferEpochs.get(resourceId)
      const barrier = this.#ownershipTransferBarriers.get(resourceId)
      if (
        barrier &&
        barrier.epoch === undefined &&
        operation === 'detachOwnership' &&
        windowId === barrier.sourceWindowId
      ) {
        barrier.epoch = transferEpoch
      }
      if (barrier?.epoch !== undefined && transferEpoch < barrier.epoch) return false
      if (
        barrier?.epoch !== undefined &&
        transferEpoch === barrier.epoch &&
        operation === 'attachOwnership' &&
        windowId !== barrier.targetWindowId
      ) {
        const error = new Error('Desktop-provider attachment does not match the committed target')
        barrier.reject(error)
        throw error
      }
      if (
        barrier?.epoch !== undefined &&
        transferEpoch === barrier.epoch &&
        operation === 'attachOwnership' &&
        !(
          current?.epoch === transferEpoch &&
          current.operation === 'detachOwnership' &&
          current.windowId === barrier.sourceWindowId
        )
      ) {
        const error = new Error('Desktop-provider attachment preceded its committed detachment')
        barrier.reject(error)
        throw error
      }
      if (
        current &&
        (transferEpoch < current.epoch ||
          (transferEpoch === current.epoch &&
            !(current.operation === 'detachOwnership' && operation === 'attachOwnership') &&
            (current.operation !== operation || current.windowId !== windowId)))
      ) {
        return false
      }
      if (
        current?.epoch === transferEpoch &&
        current.operation === operation &&
        current.windowId === windowId
      ) {
        return false
      }
      if (!current && this.#resourceTransferEpochs.size >= MAX_TRACKED_RESOURCE_TRANSFERS) {
        throw new Error('Desktop-provider transfer tracking capacity is exhausted')
      }
      try {
        await apply()
        this.#resourceTransferEpochs.set(resourceId, {
          epoch: transferEpoch,
          operation,
          windowId,
          ...(operation === 'attachOwnership' &&
          current?.epoch === transferEpoch &&
          current.operation === 'detachOwnership'
            ? { detachedWindowId: current.windowId }
            : {})
        })
        if (operation === 'attachOwnership') {
          this.#settleOwnershipTransfer(resourceId, transferEpoch)
        }
        return true
      } catch (error) {
        this.#failOwnershipTransfer(resourceId, transferEpoch, error)
        throw error
      }
    })
  }

  /** Atomically adopts a stranded resource after a provider lease interruption. */
  public recoverOwnership(
    resourceId: string,
    transferEpoch: number,
    sourceWindowId: string,
    targetWindowId: string,
    apply: () => Promise<void>
  ): Promise<boolean> {
    return this.transfer(resourceId, async () => {
      const current = this.#resourceTransferEpochs.get(resourceId)
      if (current) {
        if (transferEpoch < current.epoch) return false
        if (transferEpoch === current.epoch) {
          const recoverableDetach =
            current.operation === 'detachOwnership' && current.windowId === sourceWindowId
          const exactReplay =
            (current.operation === 'recoverOwnership' || current.operation === 'attachOwnership') &&
            current.windowId === targetWindowId &&
            current.detachedWindowId === sourceWindowId
          if (exactReplay) return false
          if (!recoverableDetach) throw new Error('Conflicting ownership recovery replay')
        }
      }
      if (!current && this.#resourceTransferEpochs.size >= MAX_TRACKED_RESOURCE_TRANSFERS) {
        throw new Error('Desktop-provider transfer tracking capacity is exhausted')
      }
      const barrier = this.#ownershipTransferBarriers.get(resourceId)
      if (barrier && barrier.epoch === undefined) {
        if (
          barrier.sourceWindowId !== sourceWindowId ||
          barrier.targetWindowId !== targetWindowId
        ) {
          const error = new Error('Recovery does not match the provisional ownership transfer')
          barrier.reject(error)
          throw error
        }
        barrier.epoch = transferEpoch
      } else if (barrier?.epoch !== undefined) {
        if (transferEpoch < barrier.epoch) return false
        if (transferEpoch > barrier.epoch) {
          barrier.reject(new Error('Ownership transfer was superseded by recovery'))
          this.#ownershipTransferBarriers.delete(resourceId)
        } else if (
          barrier.sourceWindowId !== sourceWindowId ||
          barrier.targetWindowId !== targetWindowId
        ) {
          const error = new Error('Recovery does not match the committed ownership transfer')
          barrier.reject(error)
          throw error
        }
      }
      try {
        await apply()
        this.#resourceTransferEpochs.set(resourceId, {
          epoch: transferEpoch,
          operation: 'recoverOwnership',
          windowId: targetWindowId,
          detachedWindowId: sourceWindowId
        })
        this.#settleOwnershipTransfer(resourceId, transferEpoch)
        return true
      } catch (error) {
        this.#failOwnershipTransfer(resourceId, transferEpoch, error)
        throw error
      }
    })
  }

  /**
   * Records a committed ownership event before it is exposed to a renderer. The
   * event itself never performs native ownership work; it only creates the gate
   * which the provider attach settles.
   */
  public observeOwnershipTransfer(
    resourceId: string,
    transferEpoch: number,
    sourceWindowId: string,
    targetWindowId: string
  ): void {
    const currentBarrier = this.#ownershipTransferBarriers.get(resourceId)
    if (!currentBarrier && sourceWindowId === targetWindowId) return
    if (currentBarrier) {
      if (currentBarrier.epoch === undefined) {
        if (
          currentBarrier.sourceWindowId === sourceWindowId &&
          currentBarrier.targetWindowId === targetWindowId
        ) {
          currentBarrier.epoch = transferEpoch
          this.#settleOwnershipTransfer(resourceId, transferEpoch)
          return
        }
        currentBarrier.reject(new Error('Provisional ownership transfer was superseded'))
        this.#ownershipTransferBarriers.delete(resourceId)
      } else if (transferEpoch < currentBarrier.epoch) return
      else if (transferEpoch === currentBarrier.epoch) {
        if (
          currentBarrier.sourceWindowId !== sourceWindowId ||
          currentBarrier.targetWindowId !== targetWindowId
        ) {
          throw new Error('Conflicting ownership transfer event')
        }
        return
      } else if (currentBarrier.targetWindowId === targetWindowId) {
        // Hosting-only follow-up events for the same target must not reject the waiter before
        // the original provider detach/attach has created the replacement native resource.
        return
      } else {
        currentBarrier.reject(new Error('Ownership transfer was superseded'))
        this.#ownershipTransferBarriers.delete(resourceId)
      }
    }
    if (this.#ownershipTransferBarriers.size >= MAX_TRACKED_RESOURCE_TRANSFERS) {
      throw new Error('Ownership transfer barrier capacity is exhausted')
    }
    const barrier = createOwnershipTransferBarrier(transferEpoch, sourceWindowId, targetWindowId)
    this.#ownershipTransferBarriers.set(resourceId, barrier)
    const physical = this.#resourceTransferEpochs.get(resourceId)
    if (
      physical?.epoch === transferEpoch &&
      (physical.operation === 'attachOwnership' || physical.operation === 'recoverOwnership') &&
      physical.windowId === targetWindowId &&
      physical.detachedWindowId === sourceWindowId
    ) {
      barrier.resolve()
    } else if (
      physical?.epoch === transferEpoch &&
      (physical.operation === 'attachOwnership' || physical.operation === 'recoverOwnership')
    ) {
      barrier.reject(new Error('Desktop-provider attachment was not ordered after source detach'))
    }
  }

  /** Target renderer acquisition waits here; source detach/unmount never does. */
  public waitForOwnershipTransfer(resourceId: string, windowId: string): Promise<void> {
    let barrier = this.#ownershipTransferBarriers.get(resourceId)
    if (!barrier) {
      const sourceWindowId = this.#rendererResourceOwners.get(resourceId)
      if (!sourceWindowId || sourceWindowId === windowId) return Promise.resolve()
      if (this.#ownershipTransferBarriers.size >= MAX_TRACKED_RESOURCE_TRANSFERS) {
        return Promise.reject(new Error('Ownership transfer barrier capacity is exhausted'))
      }
      barrier = createOwnershipTransferBarrier(undefined, sourceWindowId, windowId)
      this.#ownershipTransferBarriers.set(resourceId, barrier)
      const physical = this.#resourceTransferEpochs.get(resourceId)
      if (
        physical &&
        (physical.operation === 'attachOwnership' || physical.operation === 'recoverOwnership') &&
        physical.windowId === windowId &&
        physical.detachedWindowId === sourceWindowId
      ) {
        barrier.epoch = physical.epoch
        barrier.resolve()
      }
    }
    if (barrier.targetWindowId !== windowId) return Promise.resolve()
    return barrier.promise
  }

  /** Rejects pending renderer acquisition after provider loss without hanging. */
  public failOwnershipTransfers(reason: string): void {
    const error = new Error(reason)
    for (const barrier of this.#ownershipTransferBarriers.values()) barrier.reject(error)
    this.#ownershipTransferBarriers.clear()
  }

  /** Provider epochs define the lifetime of transfer ordering state. */
  public resetProviderEpoch(providerEpoch: number): void {
    if (this.#providerEpoch === providerEpoch) return
    this.failOwnershipTransfers('Desktop-provider epoch changed during ownership transfer')
    this.#providerEpoch = providerEpoch
    this.#resourceTransferEpochs.clear()
  }

  public async remove(
    windowId: string,
    reason: WindowRemovalReason
  ): Promise<RemovedWindow | undefined> {
    const entry = this.#entries.get(windowId)
    if (!entry) return undefined
    this.invalidateGeneration?.(windowId)
    this.failWindowActivation(windowId, 'Window was removed before provider activation')
    this.#entries.delete(windowId)
    if (this.#windows.get(entry.window) === entry) this.#windows.delete(entry.window)
    for (const [contentsId, sender] of this.#senders) {
      if (sender.entry === entry) this.#senders.delete(contentsId)
    }
    await entry.binding.dispose()
    entry.terminalAttachments.clear()
    return { entry, reason }
  }

  /** Removes a native window using destruction-safe identity retained outside WebContents. */
  public removeWindow(
    window: BrowserWindow,
    reason: WindowRemovalReason
  ): Promise<RemovedWindow | undefined> {
    const entry = this.#windows.get(window)
    return entry ? this.remove(entry.windowId, reason) : Promise.resolve(undefined)
  }

  public async dispose(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(ids.map((id) => this.remove(id, 'shutdown')))
    await Promise.allSettled(this.#resourceTransfers.values())
    this.#resourceTransfers.clear()
    this.#resourceTransferEpochs.clear()
    this.#rendererResourceOwners.clear()
    this.failOwnershipTransfers('Window registry was disposed during ownership transfer')
    for (const windowId of this.#windowActivationBarriers.keys()) {
      this.failWindowActivation(windowId, 'Window registry was disposed before activation')
    }
  }

  public get size(): number {
    return this.#entries.size
  }

  public get pendingTransferCount(): number {
    return this.#resourceTransfers.size
  }

  private require(windowId: string): WindowRegistryEntry {
    const entry = this.#entries.get(windowId)
    if (!entry) throw new Error('Unknown window placement')
    return entry
  }

  #settleOwnershipTransfer(resourceId: string, transferEpoch: number): void {
    let barrier = this.#ownershipTransferBarriers.get(resourceId)
    if (!barrier || (barrier.epoch !== undefined && barrier.epoch !== transferEpoch)) return
    const physical = this.#resourceTransferEpochs.get(resourceId)
    if (
      (physical?.operation !== 'attachOwnership' && physical?.operation !== 'recoverOwnership') ||
      physical.windowId !== barrier.targetWindowId ||
      physical.detachedWindowId !== barrier.sourceWindowId
    ) {
      barrier.reject(new Error('Desktop-provider attached ownership to the wrong target'))
      return
    }
    if (barrier.status === 'rejected') {
      barrier = createOwnershipTransferBarrier(
        barrier.epoch,
        barrier.sourceWindowId,
        barrier.targetWindowId
      )
      this.#ownershipTransferBarriers.set(resourceId, barrier)
    }
    barrier.resolve()
  }

  #failOwnershipTransfer(resourceId: string, transferEpoch: number, error: unknown): void {
    const barrier = this.#ownershipTransferBarriers.get(resourceId)
    if (!barrier || barrier.epoch !== transferEpoch) return
    barrier.reject(error instanceof Error ? error : new Error('Desktop-provider transfer failed'))
  }
}

function createOwnershipTransferBarrier(
  epoch: number | undefined,
  sourceWindowId: string,
  targetWindowId: string
): OwnershipTransferBarrier {
  let resolvePromise!: () => void
  let rejectPromise!: (error: Error) => void
  let status: OwnershipTransferBarrier['status'] = 'pending'
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  // A barrier may fail before a target renderer has started waiting. Keep that
  // rejection observable to the eventual waiter without producing a process-level
  // unhandled rejection in the meantime.
  void promise.catch(() => undefined)
  return {
    epoch,
    sourceWindowId,
    targetWindowId,
    promise,
    get status() {
      return status
    },
    resolve: () => {
      if (status !== 'pending') return
      status = 'resolved'
      resolvePromise()
    },
    reject: (error) => {
      if (status !== 'pending') return
      status = 'rejected'
      rejectPromise(error)
    }
  }
}

function createWindowActivationBarrier(generation: number): WindowActivationBarrier {
  let resolvePromise!: () => void
  let rejectPromise!: (error: Error) => void
  let settled = false
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  void promise.catch(() => undefined)
  return {
    generation,
    promise,
    resolve: () => {
      if (settled) return
      settled = true
      resolvePromise()
    },
    reject: (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
  }
}
