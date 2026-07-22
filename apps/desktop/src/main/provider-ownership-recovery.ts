import type { DesktopProviderRequest } from '@agent-workspace/protocol-client'

import type { BrowserViewManager } from './browser-view-manager'
import type { ControlClient } from './control-client'
import type { WindowRegistry, WindowRegistryEntry } from './window-registry'

type RecoveryBinding = WindowRegistryEntry['binding'] & {
  readonly browserViews: Pick<
    BrowserViewManager,
    'destroyOwnedSession' | 'mountTransferred' | 'ownsSession' | 'suspendOwnedSession'
  >
  readonly client: Pick<ControlClient, 'attachTerminal' | 'detachTerminal'>
}

export interface OwnershipRecoveryHooks {
  takeSuspendedBrowser?(
    resourceId: string,
    sourceWindowId: string
  ):
    | {
        readonly source: RecoveryBinding['browserViews']
        readonly rollback: () => void
      }
    | undefined
  takeSuspendedTerminal?(
    resourceId: string,
    sourceWindowId: string
  ): { readonly rollback: () => Promise<void> } | undefined
}

/** Executes the lease-recovery ownership primitive under the registry's resource lock. */
export async function recoverProviderOwnership(
  registry: WindowRegistry,
  request: DesktopProviderRequest,
  signal: AbortSignal,
  hooks: OwnershipRecoveryHooks = {}
): Promise<void> {
  const sourceClaim = request.source
  const resourceId = request.runtimeSessionId
  const transferEpoch = request.transferEpoch
  if (
    request.operation !== 'recoverOwnership' ||
    !sourceClaim ||
    !resourceId ||
    transferEpoch === undefined ||
    !request.tabId ||
    !request.workspaceId ||
    !request.paneId ||
    !request.ownershipKind ||
    sourceClaim.windowId === request.target.windowId
  ) {
    throw new Error('Desktop-provider recovery request is invalid')
  }
  assertCurrentTarget(registry, request.target.windowId, request.target.generation)
  assertCurrentSourceGeneration(registry, sourceClaim.windowId, sourceClaim.generation)

  await registry.recoverOwnership(
    resourceId,
    transferEpoch,
    sourceClaim.windowId,
    request.target.windowId,
    async () => {
      assertNotCanceled(signal)
      const target = assertCurrentTarget(
        registry,
        request.target.windowId,
        request.target.generation
      )
      const source = currentSource(registry, sourceClaim.windowId, sourceClaim.generation)
      if (request.ownershipKind === 'browser') {
        const browser = request.browser
        if (!browser || browser.browserSessionId !== resourceId) {
          throw new Error('Desktop-provider browser recovery descriptor is invalid')
        }
        await recoverBrowser(
          registry,
          source,
          target,
          resourceId,
          {
            workspaceId: request.workspaceId!,
            paneId: request.paneId!,
            tabId: request.tabId!,
            browserSessionId: browser.browserSessionId,
            lifecycleId: browser.lifecycleId,
            profilePartition: browser.profilePartition,
            stateRevision: browser.stateRevision,
            title: browser.title,
            url: browser.url
          },
          signal,
          hooks.takeSuspendedBrowser?.(resourceId, sourceClaim.windowId)
        )
      } else {
        await recoverTerminal(
          registry,
          source,
          target,
          resourceId,
          signal,
          hooks.takeSuspendedTerminal?.(resourceId, sourceClaim.windowId)
        )
      }
      assertCurrentTarget(registry, request.target.windowId, request.target.generation)
    }
  )
}

async function recoverTerminal(
  registry: WindowRegistry,
  source: WindowRegistryEntry | undefined,
  target: WindowRegistryEntry,
  resourceId: string,
  signal: AbortSignal,
  suspended: { readonly rollback: () => Promise<void> } | undefined
): Promise<void> {
  const sourceOwns = source?.terminalAttachments.has(resourceId) === true
  let sourceDetached = suspended !== undefined
  if (!suspended && sourceOwns && source) {
    await binding(source).client.detachTerminal(resourceId)
    source.terminalAttachments.delete(resourceId)
    sourceDetached = true
  }
  const rollback = async (): Promise<void> => {
    if (suspended) {
      await suspended.rollback()
      return
    }
    if (!sourceDetached || !source) return
    const current = registry.get(source.windowId)
    if (current !== source || current.generation !== source.generation) return
    await binding(source).client.attachTerminal(resourceId)
    source.terminalAttachments.add(resourceId)
  }
  let targetAttachAttempted = false
  try {
    assertNotCanceled(signal)
    if (source) assertCurrentSourceGeneration(registry, source.windowId, source.generation)
    targetAttachAttempted = true
    await binding(target).client.attachTerminal(resourceId)
    assertNotCanceled(signal)
    assertExactEntry(registry, target)
    for (const entry of registry.list()) entry.terminalAttachments.delete(resourceId)
    target.terminalAttachments.add(resourceId)
  } catch (error) {
    let targetCleared = !targetAttachAttempted
    if (targetAttachAttempted) {
      try {
        await binding(target).client.detachTerminal(resourceId)
        targetCleared = true
        target.terminalAttachments.delete(resourceId)
      } catch {
        targetCleared = false
        target.terminalAttachments.add(resourceId)
      }
    }
    // Never recreate the source if target cleanup is uncertain; that would permit dual attachment.
    if (targetCleared) await rollback().catch(() => undefined)
    throw error
  }
}

async function recoverBrowser(
  registry: WindowRegistry,
  source: WindowRegistryEntry | undefined,
  target: WindowRegistryEntry,
  resourceId: string,
  mount: Parameters<BrowserViewManager['mountTransferred']>[0],
  signal: AbortSignal,
  suspended:
    { readonly source: RecoveryBinding['browserViews']; readonly rollback: () => void } | undefined
): Promise<void> {
  let sourceManager: RecoveryBinding['browserViews'] | undefined
  try {
    sourceManager = source ? binding(source).browserViews : undefined
  } catch {
    sourceManager = undefined
  }
  if (suspended) sourceManager = suspended.source
  const sourceOwns = sourceManager?.ownsSession(resourceId) === true
  const rollback =
    suspended?.rollback ?? (sourceOwns ? sourceManager!.suspendOwnedSession(resourceId) : undefined)
  let targetManager: RecoveryBinding['browserViews'] | undefined
  try {
    assertNotCanceled(signal)
    if (source) assertCurrentSourceGeneration(registry, source.windowId, source.generation)
    targetManager = binding(target).browserViews
    await targetManager.mountTransferred(mount)
    assertNotCanceled(signal)
    assertExactEntry(registry, target)
    sourceManager?.destroyOwnedSession(resourceId)
  } catch (error) {
    targetManager?.destroyOwnedSession(resourceId)
    rollback?.()
    throw error
  }
}

function binding(entry: WindowRegistryEntry): RecoveryBinding {
  return entry.binding as RecoveryBinding
}

function assertCurrentTarget(
  registry: WindowRegistry,
  windowId: string,
  generation: number
): WindowRegistryEntry {
  const entry = registry.get(windowId)
  if (!entry || entry.generation !== generation) {
    throw new Error('Desktop-provider recovery target generation is stale')
  }
  return entry
}

function assertExactEntry(registry: WindowRegistry, expected: WindowRegistryEntry): void {
  const current = registry.get(expected.windowId)
  if (current !== expected || current.generation !== expected.generation) {
    throw new Error('Desktop-provider recovery target generation is stale')
  }
}

function assertCurrentSourceGeneration(
  registry: WindowRegistry,
  windowId: string,
  generation: number
): void {
  const entry = registry.get(windowId)
  if (entry && entry.generation !== generation) {
    throw new Error('Desktop-provider recovery source generation is stale')
  }
}

function currentSource(
  registry: WindowRegistry,
  windowId: string,
  generation: number
): WindowRegistryEntry | undefined {
  assertCurrentSourceGeneration(registry, windowId, generation)
  return registry.get(windowId)
}

function assertNotCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Desktop-provider recovery was canceled')
}
