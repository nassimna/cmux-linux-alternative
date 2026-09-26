import { randomUUID } from 'node:crypto'

import type {
  ActionInvocationTarget,
  DesktopProviderIdentityParams
} from '@agent-workspace/protocol-client'

import { BrowserAutomationProviderMailbox } from './provider-mailbox'

type Lease = {
  identity: DesktopProviderIdentityParams
  target: ActionInvocationTarget
}

/**
 * Provider identities originate only on the inherited Electron main pipe. A bearer
 * HTTP client cannot register a provider or choose its window generation.
 */
export class BrowserAutomationProviderAuthority {
  private readonly leases = new Map<string, Lease>()
  private readonly epochs = new Map<string, number>()
  private closed = false
  public readonly mailbox = new BrowserAutomationProviderMailbox((identity, target) =>
    this.isCurrent(identity, target)
  )

  public constructor(private readonly isWindowCurrent: (windowId: string) => boolean) {}

  /** Call only for a window and generation checked by Electron main. */
  public registerTrustedWindow(
    windowId: string,
    windowGeneration: number
  ): DesktopProviderIdentityParams {
    if (this.closed || !this.isWindowCurrent(windowId)) throw new Error('provider_unavailable')
    if (!Number.isSafeInteger(windowGeneration) || windowGeneration < 1)
      throw new Error('invalid_window_generation')
    this.revokeWindow(windowId)
    const providerEpoch = (this.epochs.get(windowId) ?? 0) + 1
    if (!Number.isSafeInteger(providerEpoch)) throw new Error('provider_epoch_exhausted')
    this.epochs.set(windowId, providerEpoch)
    const identity = {
      providerId: randomUUID(),
      providerEpoch,
      leaseId: randomUUID()
    }
    this.leases.set(windowId, {
      identity,
      target: { windowId, windowGeneration }
    })
    return identity
  }

  public isCurrent(
    identity: DesktopProviderIdentityParams,
    target?: ActionInvocationTarget
  ): boolean {
    if (this.closed) return false
    for (const [windowId, lease] of this.leases) {
      if (lease.identity.providerId !== identity.providerId) continue
      if (!this.isWindowCurrent(windowId)) {
        this.revokeWindow(windowId)
        return false
      }
      return (
        lease.identity.providerEpoch === identity.providerEpoch &&
        lease.identity.leaseId === identity.leaseId &&
        (!target ||
          (lease.target.windowId === target.windowId &&
            lease.target.windowGeneration === target.windowGeneration))
      )
    }
    return false
  }

  /** Selects a current private-pipe claim; ambiguity is never resolved by window order. */
  public claim(requested?: ActionInvocationTarget): Lease {
    const candidates = [...this.leases.values()].filter(
      ({ identity, target }) =>
        this.isCurrent(identity, target) &&
        (!requested ||
          (requested.windowId === target.windowId &&
            requested.windowGeneration === target.windowGeneration))
    )
    if (candidates.length !== 1)
      throw new Error(candidates.length === 0 ? 'provider_unavailable' : 'provider_ineligible')
    return candidates[0]!
  }

  public revokeWindow(windowId: string): void {
    const lease = this.leases.get(windowId)
    if (!lease) return
    this.leases.delete(windowId)
    this.mailbox.revokeProvider(lease.identity.providerId)
  }

  /** A delayed loss notification must not revoke a replacement provider. */
  public revokeIfCurrent(
    target: ActionInvocationTarget,
    identity: DesktopProviderIdentityParams
  ): void {
    const lease = this.leases.get(target.windowId)
    if (
      !lease ||
      lease.target.windowGeneration !== target.windowGeneration ||
      lease.identity.providerId !== identity.providerId ||
      lease.identity.providerEpoch !== identity.providerEpoch ||
      lease.identity.leaseId !== identity.leaseId
    )
      return
    this.revokeWindow(target.windowId)
  }

  public dispose(): void {
    if (this.closed) return
    this.closed = true
    this.leases.clear()
    this.epochs.clear()
    this.mailbox.dispose()
  }
}
