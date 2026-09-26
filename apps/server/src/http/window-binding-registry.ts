import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import type { DurableApplicationState } from '@agent-workspace/contracts'

import type { TrustedWindowBinding } from '../persistence/recently-closed-service'

const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const DEFAULT_TTL_MS = 15 * 60 * 1_000
const MAX_CAPABILITIES = 16

interface WindowStateReader {
  readSnapshot(): Pick<DurableApplicationState, 'windowPlacements'>
}

interface CapabilityEntry {
  windowId: string
  expiresAt: number
}

export class WindowBindingError extends Error {
  public constructor(
    public readonly code: 'window_unavailable' | 'capacity_exceeded' | 'registry_closed'
  ) {
    super(code.replaceAll('_', ' '))
    this.name = 'WindowBindingError'
  }
}

/**
 * Process-local window capabilities for a future sender-bound Electron main bridge.
 * `issueForTrustedOwner` must only receive a window ID derived from that bridge's
 * verified IPC sender. The isolated copy can say unhosted even while that sender's
 * Electron window is live; the private channel is the hosting proof. Global bearer clients retain their existing privileges;
 * this registry does not authenticate or bind an IPC sender by itself.
 */
export class WindowBindingRegistry {
  private readonly entries = new Map<string, CapabilityEntry>()
  private readonly byWindow = new Map<string, string>()
  private closed = false

  public constructor(
    private readonly state: WindowStateReader,
    private readonly now: () => number = () => performance.now(),
    private readonly ttlMs: number = DEFAULT_TTL_MS
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_TTL_MS) {
      throw new RangeError('Window capability lifetime is invalid')
    }
  }

  /** Rotates this window's prior capability. Never call with an HTTP-provided ID. */
  public issueForTrustedOwner(windowId: string): string {
    if (this.closed) throw new WindowBindingError('registry_closed')
    if (!this.currentWindow(windowId)) throw new WindowBindingError('window_unavailable')
    const instant = this.instant()
    this.purgeExpired(instant)
    const previous = this.byWindow.get(windowId)
    if (!previous && this.entries.size >= MAX_CAPABILITIES) {
      throw new WindowBindingError('capacity_exceeded')
    }
    if (previous) this.remove(previous)
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const digest = this.digest(token)
    this.entries.set(digest, { windowId, expiresAt: instant + this.ttlMs })
    this.byWindow.set(windowId, digest)
    return token
  }

  /** Resolves only the opaque capability; content commands supply no binding window ID. */
  public resolve(token: string): TrustedWindowBinding | undefined {
    if (this.closed || !TOKEN_PATTERN.test(token)) return undefined
    const digest = this.digest(token)
    if (!this.active(digest)) return undefined
    const windowId = this.entries.get(digest)!.windowId
    return Object.freeze({ windowId, isCurrent: () => this.active(digest) })
  }

  public revoke(token: string): void {
    if (TOKEN_PATTERN.test(token)) this.remove(this.digest(token))
  }

  /** The trusted owner calls this when its window or IPC sender is destroyed. */
  public revokeWindow(windowId: string): void {
    const digest = this.byWindow.get(windowId)
    if (digest) this.remove(digest)
  }

  /** Checks the isolated placement without minting a renderer-facing capability. */
  public hasCurrentWindow(windowId: string): boolean {
    return !this.closed && this.currentWindow(windowId)
  }

  /** A new registry after restart has no old entries. Dispose also invalidates held bindings. */
  public dispose(): void {
    this.closed = true
    this.entries.clear()
    this.byWindow.clear()
  }

  private active(digest: string): boolean {
    const entry = this.entries.get(digest)
    if (!entry) return false
    if (entry.expiresAt <= this.instant() || !this.currentWindow(entry.windowId)) {
      this.remove(digest)
      return false
    }
    return true
  }

  private currentWindow(windowId: string): boolean {
    try {
      return this.state
        .readSnapshot()
        .windowPlacements.some(
          (window) => window.id === windowId && window.hostingState !== 'closing'
        )
    } catch {
      return false
    }
  }

  private instant(): number {
    const instant = this.now()
    if (!Number.isFinite(instant) || instant < 0)
      throw new RangeError('Window capability clock is invalid')
    return instant
  }

  private purgeExpired(instant: number): void {
    for (const [digest, entry] of this.entries) {
      if (entry.expiresAt <= instant || !this.currentWindow(entry.windowId)) this.remove(digest)
    }
  }

  private remove(digest: string): void {
    const entry = this.entries.get(digest)
    if (!entry) return
    this.entries.delete(digest)
    if (this.byWindow.get(entry.windowId) === digest) this.byWindow.delete(entry.windowId)
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }
}
