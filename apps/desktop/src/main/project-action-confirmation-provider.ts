import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'

import type {
  DesktopProviderIdentityParams,
  ProjectActionConfirmationChallenge,
  ProjectActionConfirmationDecision,
  ProjectActionConfirmationPollParams,
  ProjectActionConfirmationPollResult,
  ProjectActionConfirmationRespondParams,
  ProjectActionConfirmationRespondResult
} from '@agent-workspace/protocol-client'

import type { WindowRegistry, WindowRegistryEntry } from './window-registry'

const CONFIRMATION_POLL_TIMEOUT_MS = 5_000
export const PROJECT_ACTION_CONFIRMATION_CAPABILITY = 'project-action-confirmation-v1'
const CONFIRM_BUTTON = 0
const DENY_BUTTON = 1
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface ProjectActionConfirmationTransport {
  poll(
    params: ProjectActionConfirmationPollParams,
    signal: AbortSignal
  ): Promise<ProjectActionConfirmationPollResult>
  respond(
    params: ProjectActionConfirmationRespondParams
  ): Promise<ProjectActionConfirmationRespondResult>
}

type ShowMessageBox = (
  window: BrowserWindow,
  options: MessageBoxOptions
) => Promise<MessageBoxReturnValue>

export interface ProjectActionConfirmationProviderOptions {
  readonly identity: DesktopProviderIdentityParams
  readonly registry: WindowRegistry
  readonly transport: ProjectActionConfirmationTransport
  readonly showMessageBox?: ShowMessageBox
  readonly now?: () => number
  readonly logError?: (message: string, error?: unknown) => void
  readonly onProviderLost: (reason: string) => void
}

/**
 * Trusted native confirmation consumer for service-owned project actions.
 *
 * The provider is intentionally main-process only. Its dialog receives only bounded,
 * content-free display fields from the service challenge and never exposes command text,
 * arguments, paths, hashes, or provider authority to preload or renderer code.
 */
export class ProjectActionConfirmationProvider {
  readonly #identity: DesktopProviderIdentityParams
  readonly #showMessageBox: ShowMessageBox
  #abort: AbortController | undefined
  #polling: Promise<void> | undefined
  #stopped = false

  public constructor(private readonly options: ProjectActionConfirmationProviderOptions) {
    this.#identity = { ...options.identity }
    this.#showMessageBox =
      options.showMessageBox ??
      ((window, dialogOptions) => dialog.showMessageBox(window, dialogOptions))
  }

  public start(): void {
    if (this.#stopped) throw new Error('Project-action confirmation provider is stopped')
    if (this.#polling) return
    this.#abort = new AbortController()
    const polling = this.pollLoop(this.#abort.signal)
    const tracked = polling.finally(() => {
      if (this.#polling === tracked) this.#polling = undefined
    })
    this.#polling = tracked
  }

  public async pause(reason = 'project-action confirmation polling paused'): Promise<void> {
    const polling = this.#polling
    this.#abort?.abort(reason)
    this.#abort = undefined
    await polling?.catch(() => undefined)
    if (this.#polling === polling) this.#polling = undefined
  }

  public async stop(reason = 'project-action confirmation provider stopped'): Promise<void> {
    this.#stopped = true
    await this.pause(reason)
  }

  public get active(): boolean {
    return !this.#stopped
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#stopped) {
      let result: ProjectActionConfirmationPollResult
      try {
        result = await this.options.transport.poll(
          { identity: this.#identity, timeoutMs: CONFIRMATION_POLL_TIMEOUT_MS },
          signal
        )
      } catch (error) {
        if (!signal.aborted) this.providerLost('project-action confirmation poll failed', error)
        return
      }
      if (signal.aborted || !result.challenge) continue
      try {
        await this.handle(result.challenge, signal)
      } catch (error) {
        if (!signal.aborted) this.providerLost('project-action confirmation protocol failed', error)
        return
      }
    }
  }

  private async handle(
    challenge: ProjectActionConfirmationChallenge,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted || this.#stopped) return
    if (!sameIdentity(challenge.identity, this.#identity)) {
      throw new Error('Project-action confirmation identity mismatch')
    }
    const entry = this.exactTarget(challenge)
    const now = this.options.now ?? Date.now
    const remainingMs = challenge.expiresAtMs - now()
    if (remainingMs <= 0) return

    const promptAbort = new AbortController()
    const abortPrompt = (): void => promptAbort.abort(signal.reason)
    signal.addEventListener('abort', abortPrompt, { once: true })
    if (signal.aborted) abortPrompt()
    const expiry = setTimeout(
      () => promptAbort.abort('project-action confirmation expired'),
      Math.min(remainingMs, MAX_TIMER_DELAY_MS)
    )
    let result: MessageBoxReturnValue
    try {
      result = await this.#showMessageBox(
        entry.window,
        promptOptions(challenge, promptAbort.signal)
      )
    } catch (error) {
      if (promptAbort.signal.aborted) return
      throw error
    } finally {
      clearTimeout(expiry)
      signal.removeEventListener('abort', abortPrompt)
    }
    if (
      promptAbort.signal.aborted ||
      signal.aborted ||
      this.#stopped ||
      now() >= challenge.expiresAtMs
    )
      return
    this.exactTarget(challenge, entry)

    const decision: ProjectActionConfirmationDecision =
      result.response === CONFIRM_BUTTON ? 'confirmed' : 'denied'
    const response = await this.options.transport.respond(
      responseFor(challenge, this.#identity, decision)
    )
    if (response.invocationId !== challenge.invocationId || response.decision !== decision) {
      throw new Error('Project-action confirmation response mismatch')
    }
  }

  private exactTarget(
    challenge: ProjectActionConfirmationChallenge,
    expected?: WindowRegistryEntry
  ): WindowRegistryEntry {
    const entry = this.options.registry.get(challenge.target.windowId)
    if (
      !entry ||
      entry !== (expected ?? entry) ||
      entry.generation !== challenge.target.windowGeneration ||
      entry.window.isDestroyed()
    ) {
      throw new Error('Project-action confirmation target generation mismatch')
    }
    return entry
  }

  private providerLost(message: string, error: unknown): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#abort?.abort(message)
    this.options.logError?.(message, error)
    this.options.onProviderLost(message)
  }
}

function promptOptions(
  challenge: ProjectActionConfirmationChallenge,
  signal: AbortSignal
): MessageBoxOptions {
  const executable =
    challenge.executableClass === 'projectRelative'
      ? 'Project-relative executable'
      : 'Approved executable'
  return {
    type: 'warning',
    title: 'Confirm project action',
    message: `Run “${challenge.displayTitle}”?`,
    detail: `Project: ${challenge.projectLabel}\nExecutable: ${executable}\nArguments: ${challenge.argumentCount}`,
    buttons: ['Run action', 'Cancel'],
    defaultId: DENY_BUTTON,
    cancelId: DENY_BUTTON,
    noLink: true,
    signal
  }
}

function responseFor(
  challenge: ProjectActionConfirmationChallenge,
  identity: DesktopProviderIdentityParams,
  decision: ProjectActionConfirmationDecision
): ProjectActionConfirmationRespondParams {
  return {
    identity,
    invocationId: challenge.invocationId,
    nonce: challenge.nonce,
    challenge: challenge.challenge,
    target: { ...challenge.target },
    confirmationDefinitionSha256: challenge.confirmationDefinitionSha256,
    decision
  }
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
