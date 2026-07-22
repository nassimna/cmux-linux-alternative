import type { BrowserMountParams } from './browser-view-manager'
import { transferBrowserView } from './browser-view-manager'
import type { WindowRegistry, WindowRegistryEntry, WindowRemovalReason } from './window-registry'

export interface BrowserRehomePlan {
  readonly mount: BrowserMountParams
}

export interface WindowRehomePlan {
  /** Omitted when the service committed an explicitly unhosted topology. */
  readonly targetWindowId?: string
  readonly terminalIds: readonly string[]
  readonly browsers: readonly BrowserRehomePlan[]
}

export interface WindowRehomeDependencies {
  resolvePlan(
    source: WindowRegistryEntry,
    survivingWindowIds: readonly string[],
    reason: WindowRemovalReason
  ): Promise<WindowRehomePlan>
  transferTerminal(
    terminalId: string,
    sourceWindowId: string,
    targetWindowId: string
  ): Promise<void>
  markTransferFailed(resourceId: string, reason: string): Promise<void>
}

/** Applies a service-committed loss/rehome plan to Electron-owned resources. */
export class WindowRehomeCoordinator {
  public constructor(
    private readonly registry: WindowRegistry,
    private readonly dependencies: WindowRehomeDependencies
  ) {}

  public async remove(windowId: string, reason: WindowRemovalReason): Promise<void> {
    const source = this.registry.get(windowId)
    if (!source) return
    const survivors = this.registry
      .list()
      .filter((entry) => entry !== source && !entry.window.isDestroyed())
      .map((entry) => entry.windowId)
    const plan = await this.dependencies.resolvePlan(source, survivors, reason)
    const target = plan.targetWindowId ? this.registry.get(plan.targetWindowId) : undefined
    if (plan.targetWindowId && (!target || target === source || target.window.isDestroyed())) {
      const unavailable = new Error('Rehome plan selected an unavailable target window')
      const resourceIds = [
        ...plan.terminalIds,
        ...plan.browsers.map(({ mount }) => mount.browserSessionId)
      ]
      await Promise.allSettled(
        resourceIds.map((resourceId) =>
          this.dependencies.markTransferFailed(resourceId, unavailable.message)
        )
      )
      await this.registry.remove(windowId, reason)
      throw unavailable
    }

    const transfers: Promise<void>[] = []
    if (target) {
      for (const terminalId of plan.terminalIds) {
        transfers.push(
          this.registry.transfer(terminalId, async () => {
            if (!source.terminalAttachments.has(terminalId)) {
              throw new Error('Terminal is not owned by the source window')
            }
            try {
              await this.dependencies.transferTerminal(terminalId, source.windowId, target.windowId)
              source.terminalAttachments.delete(terminalId)
              target.terminalAttachments.add(terminalId)
            } catch (error) {
              await this.dependencies.markTransferFailed(terminalId, errorMessage(error))
              throw error
            }
          })
        )
      }
      for (const browser of plan.browsers) {
        const browserSessionId = browser.mount.browserSessionId
        transfers.push(
          this.registry.transfer(browserSessionId, async () => {
            if (!source.binding.browserViews.ownsSession(browserSessionId)) {
              throw new Error('Browser session is not owned by the source window')
            }
            try {
              await transferBrowserView({
                source: source.binding.browserViews,
                target: target.binding.browserViews,
                mount: browser.mount
              })
            } catch (error) {
              await this.dependencies.markTransferFailed(browserSessionId, errorMessage(error))
              throw error
            }
          })
        )
      }
    }
    const results = await Promise.allSettled(transfers)
    // The topology was already committed before this coordinator was invoked. Native
    // source ownership must therefore be torn down even when one replacement fails;
    // markTransferFailed is the service-owned retry/unhosted reconciliation hook.
    await this.registry.remove(windowId, reason)
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [new Error(errorMessage(result.reason as unknown))] : []
    )
    if (failures.length > 0)
      throw new AggregateError(failures, 'One or more rehome transfers failed')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown transfer failure'
}
