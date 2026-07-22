import { createHash } from 'node:crypto'

import type {
  ActionErrorCode,
  DesktopActionAcknowledgeParams,
  DesktopActionAcknowledgeResult,
  DesktopActionExecutionRequest,
  DesktopActionPollParams,
  DesktopActionPollResult,
  DesktopActionStartClaimParams,
  DesktopActionStartClaimResult,
  DesktopProviderIdentityParams
} from '@agent-workspace/protocol-client'

import { focusProviderWindow } from './provider-window-operations'
import { PROJECT_ACTION_CONFIRMATION_CAPABILITY } from './project-action-confirmation-provider'
import type { WindowRegistry, WindowRegistryEntry } from './window-registry'

export const DESKTOP_WINDOW_FOCUS_ACTION_ID = 'desktop.window.focus'
export const DESKTOP_WINDOW_FOCUS_ACTION_VERSION = 1
export const DESKTOP_WINDOW_FOCUS_CAPABILITY = 'desktop-window-focus-v1'
export const DESKTOP_ACTION_PROVIDER_CAPABILITIES = [
  DESKTOP_WINDOW_FOCUS_CAPABILITY,
  PROJECT_ACTION_CONFIRMATION_CAPABILITY
] as const

const ACTION_POLL_TIMEOUT_MS = 5_000
const MAX_CACHED_ACTION_ATTEMPTS = 1_024
const MAX_ACTION_RESULT_BYTES = 64 * 1024

type TerminalAcknowledgement = Omit<DesktopActionAcknowledgeParams, 'identity'>

interface CachedActionAttempt {
  readonly signature: string
  readonly acknowledgement?: TerminalAcknowledgement
}

export class DesktopActionAcknowledgementCache {
  readonly #attempts = new Map<string, CachedActionAttempt>()
  #providerEpoch: number | undefined

  public constructor(private readonly maximum = MAX_CACHED_ACTION_ATTEMPTS) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65_536) {
      throw new Error('Invalid desktop-action deduplication capacity')
    }
  }

  public useProviderEpoch(providerEpoch: number): void {
    if (providerEpoch === this.#providerEpoch) return
    this.#providerEpoch = providerEpoch
    this.#attempts.clear()
  }

  public get(invocationId: string): CachedActionAttempt | undefined {
    return this.#attempts.get(invocationId)
  }

  public remember(invocationId: string, attempt: CachedActionAttempt): void {
    this.#attempts.set(invocationId, attempt)
    while (this.#attempts.size > this.maximum) {
      const oldest = this.#attempts.keys().next().value
      if (oldest === undefined) break
      this.#attempts.delete(oldest)
    }
  }
}

export interface DesktopActionTransport {
  poll(params: DesktopActionPollParams, signal: AbortSignal): Promise<DesktopActionPollResult>
  claimStart(params: DesktopActionStartClaimParams): Promise<DesktopActionStartClaimResult>
  acknowledge(params: DesktopActionAcknowledgeParams): Promise<DesktopActionAcknowledgeResult>
}

export interface DesktopActionProviderOptions {
  readonly identity: DesktopProviderIdentityParams
  readonly registry: WindowRegistry
  readonly transport: DesktopActionTransport
  readonly acknowledgementCache?: DesktopActionAcknowledgementCache
  readonly now?: () => number
  readonly logError?: (message: string, error?: unknown) => void
  readonly onProviderLost: (reason: string) => void
}

/**
 * Bounded `actions-v1` reverse consumer attached to one existing M3 provider lease.
 * It owns no registration or heartbeat state and never accepts renderer-supplied authority.
 */
export class DesktopActionProvider {
  readonly #cache: DesktopActionAcknowledgementCache
  readonly #identity: DesktopProviderIdentityParams
  #abort: AbortController | undefined
  #polling: Promise<void> | undefined
  #stopped = false

  public constructor(private readonly options: DesktopActionProviderOptions) {
    this.#identity = { ...options.identity }
    this.#cache = options.acknowledgementCache ?? new DesktopActionAcknowledgementCache()
    this.#cache.useProviderEpoch(this.#identity.providerEpoch)
  }

  public start(): void {
    if (this.#stopped) throw new Error('Desktop-action provider is stopped')
    if (this.#polling) return
    this.#abort = new AbortController()
    const polling = this.pollLoop(this.#abort.signal)
    const tracked = polling.finally(() => {
      if (this.#polling === tracked) this.#polling = undefined
    })
    this.#polling = tracked
  }

  public async pause(reason = 'desktop-action polling paused'): Promise<void> {
    const polling = this.#polling
    this.#abort?.abort(reason)
    this.#abort = undefined
    await polling?.catch(() => undefined)
    if (this.#polling === polling) this.#polling = undefined
  }

  public async stop(reason = 'desktop-action provider stopped'): Promise<void> {
    this.#stopped = true
    await this.pause(reason)
  }

  public get active(): boolean {
    return !this.#stopped
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#stopped) {
      let result: DesktopActionPollResult
      try {
        result = await this.options.transport.poll(
          { identity: this.#identity, timeoutMs: ACTION_POLL_TIMEOUT_MS },
          signal
        )
      } catch (error) {
        if (!signal.aborted) this.providerLost('desktop-action poll failed', error)
        return
      }
      if (signal.aborted || !result.request) continue
      try {
        await this.handle(result.request, signal)
      } catch (error) {
        this.providerLost('desktop-action protocol failed', error)
        return
      }
    }
  }

  private async handle(request: DesktopActionExecutionRequest, signal: AbortSignal): Promise<void> {
    if (!sameIdentity(request.identity, this.#identity)) {
      throw new Error('Desktop-action request identity mismatch')
    }
    const signature = requestSignature(request)
    const cached = this.#cache.get(request.invocationId)
    if (cached) {
      if (cached.signature !== signature) {
        throw new Error('Desktop-action duplicate payload mismatch')
      }
      if (cached.acknowledgement) await this.acknowledge(cached.acknowledgement)
      return
    }

    const claim = await this.options.transport.claimStart({
      identity: this.#identity,
      invocationId: request.invocationId,
      correlationId: request.correlationId,
      attemptEpoch: request.attemptEpoch,
      actionId: request.actionId,
      actionVersion: request.actionVersion,
      target: request.target
    })
    assertMatchingClaim(request, claim)
    if (claim.decision !== 'granted') {
      this.#cache.remember(request.invocationId, { signature })
      return
    }

    const acknowledgement = this.executeGranted(request, signal)
    assertBoundedResult(acknowledgement)
    this.#cache.remember(request.invocationId, { signature, acknowledgement })
    await this.acknowledge(acknowledgement)
  }

  private executeGranted(
    request: DesktopActionExecutionRequest,
    signal: AbortSignal
  ): TerminalAcknowledgement {
    const base = acknowledgementBase(request)
    if (signal.aborted) return { ...base, status: 'canceled' }
    if (request.expiresAtMs <= (this.options.now ?? Date.now)()) {
      return failed(base, 'expired')
    }
    if (request.actionId !== DESKTOP_WINDOW_FOCUS_ACTION_ID) {
      return failed(base, 'action_not_found')
    }
    if (request.actionVersion !== DESKTOP_WINDOW_FOCUS_ACTION_VERSION) {
      return failed(base, 'action_version_mismatch')
    }
    if (!isStrictEmptyObject(request.parameters)) return failed(base, 'invalid_parameters')

    const entry = this.options.registry.get(request.target.windowId)
    if (!entry || entry.window.isDestroyed()) return failed(base, 'target_not_found')
    if (entry.generation !== request.target.windowGeneration) return failed(base, 'target_stale')
    if (!this.isExactTarget(entry, request)) return failed(base, 'target_stale')
    try {
      focusProviderWindow(entry)
      return { ...base, status: 'succeeded', result: {} }
    } catch {
      return failed(base, 'execution_failed')
    }
  }

  private isExactTarget(
    entry: WindowRegistryEntry,
    request: DesktopActionExecutionRequest
  ): boolean {
    return (
      this.options.registry.get(entry.windowId) === entry &&
      entry.windowId === request.target.windowId &&
      entry.generation === request.target.windowGeneration &&
      !entry.window.isDestroyed()
    )
  }

  private async acknowledge(acknowledgement: TerminalAcknowledgement): Promise<void> {
    const result = await this.options.transport.acknowledge({
      ...acknowledgement,
      identity: this.#identity
    })
    assertMatchingAcknowledgement(acknowledgement, result)
  }

  private providerLost(message: string, error: unknown): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#abort?.abort(message)
    this.options.logError?.(message, error)
    this.options.onProviderLost(message)
  }
}

function acknowledgementBase(
  request: DesktopActionExecutionRequest
): Omit<TerminalAcknowledgement, 'status'> {
  return {
    invocationId: request.invocationId,
    correlationId: request.correlationId,
    attemptEpoch: request.attemptEpoch,
    actionId: request.actionId,
    actionVersion: request.actionVersion,
    target: request.target
  }
}

function failed(
  base: Omit<TerminalAcknowledgement, 'status'>,
  errorCode: ActionErrorCode
): TerminalAcknowledgement {
  return { ...base, status: 'failed', errorCode }
}

function sameIdentity(
  left: DesktopProviderIdentityParams,
  right: DesktopProviderIdentityParams
): boolean {
  return (
    left.providerId === right.providerId &&
    left.providerEpoch === right.providerEpoch &&
    left.leaseId === right.leaseId
  )
}

function requestSignature(request: DesktopActionExecutionRequest): string {
  const exactAttempt = {
    invocationId: request.invocationId,
    correlationId: request.correlationId,
    attemptEpoch: request.attemptEpoch,
    actionId: request.actionId,
    actionVersion: request.actionVersion,
    target: request.target,
    parameters: request.parameters,
    expiresAtMs: request.expiresAtMs
  }
  return createHash('sha256').update(canonicalJson(exactAttempt)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Desktop-action payload is not JSON')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

function isStrictEmptyObject(value: unknown): value is Record<string, never> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

function assertMatchingClaim(
  request: DesktopActionExecutionRequest,
  claim: DesktopActionStartClaimResult
): void {
  if (
    claim.invocationId !== request.invocationId ||
    claim.correlationId !== request.correlationId ||
    claim.attemptEpoch !== request.attemptEpoch
  ) {
    throw new Error('Desktop-action start grant mismatch')
  }
}

function assertBoundedResult(acknowledgement: TerminalAcknowledgement): void {
  if (
    Buffer.byteLength(JSON.stringify(acknowledgement.result ?? null), 'utf8') >
    MAX_ACTION_RESULT_BYTES
  ) {
    throw new Error('Desktop-action result exceeds its bound')
  }
}

function assertMatchingAcknowledgement(
  acknowledgement: TerminalAcknowledgement,
  result: DesktopActionAcknowledgeResult
): void {
  const invocation = result.invocation
  const expectedState =
    acknowledgement.status === 'succeeded'
      ? 'acknowledged'
      : acknowledgement.status === 'failed'
        ? 'failed'
        : 'canceled'
  if (
    invocation.invocationId !== acknowledgement.invocationId ||
    invocation.correlationId !== acknowledgement.correlationId ||
    invocation.state !== expectedState ||
    (acknowledgement.status === 'failed' && invocation.errorCode !== acknowledgement.errorCode)
  ) {
    throw new Error('Desktop-action terminal acknowledgement mismatch')
  }
}
