import { performance } from 'node:perf_hooks'

import type { ApplicationStateStore } from '../persistence/application-state-store'

const LEASE_MS = 15_000

interface Claim { generation: number; expiresAt: number }

/** Private-channel claims for exact Electron window generations. */
export class WindowHostingAuthority {
  private readonly claims = new Map<string, Claim>()
  private readonly highestGeneration = new Map<string, number>()

  public constructor(
    private readonly state: Pick<ApplicationStateStore, 'reconcileWindowHosting'>,
    private readonly now: () => number = () => performance.now()
  ) {
    // The copied durable state has no live Node owner after a process restart.
    this.state.reconcileWindowHosting(new Set())
  }

  public register(windowId: string, generation: number): number {
    this.expire()
    const active = this.claims.get(windowId)
    const highest = this.highestGeneration.get(windowId) ?? 0
    if (generation < highest || (generation === highest && !active)) {
      throw new Error('stale_window_generation')
    }
    const proposed = new Map(this.claims)
    proposed.set(windowId, { generation, expiresAt: this.instant() + LEASE_MS })
    const revision = this.reconcile(proposed)
    this.replaceClaims(proposed)
    this.highestGeneration.set(windowId, Math.max(highest, generation))
    return revision
  }

  public heartbeat(windowId: string, generation: number): number {
    this.expire()
    const active = this.claims.get(windowId)
    if (!active || active.generation !== generation) throw new Error('stale_window_generation')
    const proposed = new Map(this.claims)
    proposed.set(windowId, { generation, expiresAt: this.instant() + LEASE_MS })
    const revision = this.reconcile(proposed)
    this.replaceClaims(proposed)
    return revision
  }

  /** A stale close cannot release a newer renderer generation. */
  public revoke(windowId: string, generation: number): number {
    this.expire()
    const active = this.claims.get(windowId)
    if (!active || active.generation !== generation) {
      return this.state.reconcileWindowHosting(new Set(this.claims.keys()))
    }
    const proposed = new Map(this.claims)
    proposed.delete(windowId)
    const revision = this.reconcile(proposed)
    this.replaceClaims(proposed)
    return revision
  }

  public expire(): void {
    const instant = this.instant()
    const proposed = new Map(this.claims)
    for (const [windowId, claim] of proposed) {
      if (claim.expiresAt <= instant) proposed.delete(windowId)
    }
    if (proposed.size === this.claims.size) return
    this.reconcile(proposed)
    this.replaceClaims(proposed)
  }

  public close(): void {
    this.state.reconcileWindowHosting(new Set())
    this.claims.clear()
  }

  private reconcile(claims: ReadonlyMap<string, Claim>): number {
    return this.state.reconcileWindowHosting(new Set(claims.keys()))
  }

  private replaceClaims(claims: ReadonlyMap<string, Claim>): void {
    this.claims.clear()
    for (const [windowId, claim] of claims) this.claims.set(windowId, claim)
  }

  private instant(): number {
    const value = this.now()
    if (!Number.isFinite(value) || value < 0) throw new Error('hosting_clock_invalid')
    return value
  }
}
