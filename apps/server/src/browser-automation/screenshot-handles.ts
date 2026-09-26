import type {
  ActionInvocationTarget,
  BrowserAutomationScreenshotHandle,
  DesktopProviderIdentityParams
} from '@agent-workspace/protocol-client'

const CONTENT_TTL_MS = 60_000
const MAX_SESSION_HANDLES = 2
const MAX_SESSION_BYTES = 32 * 1024 * 1024
const MAX_PROVIDER_HANDLES = 8
const MAX_PROVIDER_BYTES = 64 * 1024 * 1024
const MAX_PROFILE_HANDLES = 16
const MAX_PROFILE_BYTES = 128 * 1024 * 1024

export interface ScreenshotOwnership {
  callerId: string
  automationSessionId: string
  sessionGeneration: number
  profileKey: string
  identity: DesktopProviderIdentityParams
  target: ActionInvocationTarget
  handle: BrowserAutomationScreenshotHandle
}

/** Metadata only. PNG bytes remain in the owning Electron BrowserAutomationManager. */
export class BrowserAutomationScreenshotHandles {
  private readonly handles = new Map<string, ScreenshotOwnership>()

  public constructor(private readonly now: () => number = Date.now) {}

  public validate(candidate: ScreenshotOwnership): void {
    this.prune()
    const now = this.now()
    if (candidate.handle.expiresAtMs <= now ||
        candidate.handle.expiresAtMs > now + CONTENT_TTL_MS ||
        candidate.handle.chunkCount !== Math.ceil(candidate.handle.byteLength / (512 * 1024)))
      throw new Error('invalid_operation')
    if (this.handles.has(candidate.handle.handleId)) throw new Error('idempotency_conflict')
    const values = [...this.handles.values()]
    const session = values.filter((item) => item.automationSessionId === candidate.automationSessionId)
    const provider = values.filter((item) => item.identity.providerId === candidate.identity.providerId)
    const profile = values.filter((item) => item.profileKey === candidate.profileKey)
    const exceeds = (items: ScreenshotOwnership[], count: number, bytes: number) =>
      items.length >= count ||
      items.reduce((sum, item) => sum + item.handle.byteLength, candidate.handle.byteLength) > bytes
    if (exceeds(session, MAX_SESSION_HANDLES, MAX_SESSION_BYTES) ||
        exceeds(provider, MAX_PROVIDER_HANDLES, MAX_PROVIDER_BYTES) ||
        exceeds(profile, MAX_PROFILE_HANDLES, MAX_PROFILE_BYTES))
      throw new Error('resource_limit')
  }

  public register(candidate: ScreenshotOwnership): void {
    this.validate(candidate)
    this.handles.set(candidate.handle.handleId, candidate)
  }

  public get(
    handleId: string,
    callerId: string,
    sessionId: string,
    generation: number
  ): ScreenshotOwnership {
    this.prune()
    const ownership = this.handles.get(handleId)
    if (!ownership) throw new Error('result_expired')
    if (ownership.callerId !== callerId ||
        ownership.automationSessionId !== sessionId ||
        ownership.sessionGeneration !== generation) throw new Error('policy_denied')
    return ownership
  }

  public release(handleId: string): void {
    this.handles.delete(handleId)
  }

  public releaseSession(sessionId: string): void {
    for (const [id, ownership] of this.handles) {
      if (ownership.automationSessionId === sessionId) this.handles.delete(id)
    }
  }

  public clear(): void {
    this.handles.clear()
  }

  public prune(): void {
    const now = this.now()
    for (const [id, ownership] of this.handles) {
      if (ownership.handle.expiresAtMs <= now) this.handles.delete(id)
    }
  }
}
