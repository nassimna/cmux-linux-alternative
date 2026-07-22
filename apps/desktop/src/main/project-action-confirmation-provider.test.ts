import type {
  DesktopProviderIdentityParams,
  ProjectActionConfirmationChallenge,
  ProjectActionConfirmationPollResult,
  ProjectActionConfirmationRespondParams
} from '@agent-workspace/protocol-client'
import { describe, expect, it, vi } from 'vitest'

import {
  ProjectActionConfirmationProvider,
  type ProjectActionConfirmationTransport
} from './project-action-confirmation-provider'
import { WindowRegistry, type WindowRegistryBinding } from './window-registry'

const identity: DesktopProviderIdentityParams = {
  providerId: '10000000-0000-4000-8000-000000000001',
  providerEpoch: 7,
  leaseId: '10000000-0000-4000-8000-000000000002'
}
const WINDOW_ID = '10000000-0000-4000-8000-000000000003'
const INVOCATION_ID = '10000000-0000-4000-8000-000000000004'
const NONCE = '10000000-0000-4000-8000-000000000005'
const CHALLENGE_SHA256 = 'a'.repeat(64)
const DEFINITION_SHA256 = 'b'.repeat(64)

function registerTarget(registry: WindowRegistry) {
  const window = {
    webContents: { id: 41, mainFrame: {} },
    isDestroyed: vi.fn(() => false)
  }
  const binding = {
    browserViews: { size: 0 },
    stateController: {},
    dispose: vi.fn().mockResolvedValue(undefined)
  }
  const entry = registry.register(
    WINDOW_ID,
    window as unknown as Electron.BrowserWindow,
    binding as unknown as WindowRegistryBinding
  )
  return { entry, window }
}

function challengeFor(
  overrides: Partial<ProjectActionConfirmationChallenge> = {}
): ProjectActionConfirmationChallenge {
  return {
    invocationId: INVOCATION_ID,
    nonce: NONCE,
    challenge: CHALLENGE_SHA256,
    identity,
    target: { windowId: WINDOW_ID, windowGeneration: 1 },
    confirmationDefinitionSha256: DEFINITION_SHA256,
    actionId: 'project.build',
    displayTitle: 'Build project',
    executableClass: 'approvedName',
    argumentCount: 2,
    projectLabel: 'Example project',
    expiresAtMs: 2_000,
    ...overrides
  }
}

function polling(...results: ProjectActionConfirmationPollResult[]) {
  const queue = [...results]
  return vi.fn((_params, signal: AbortSignal): Promise<ProjectActionConfirmationPollResult> => {
    const result = queue.shift()
    if (result) return Promise.resolve(result)
    if (signal.aborted) return Promise.resolve({})
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({}), { once: true })
    })
  })
}

function transportFor(
  challenge: ProjectActionConfirmationChallenge,
  overrides: Partial<ProjectActionConfirmationTransport> = {}
) {
  return {
    poll: polling({ challenge }),
    respond: vi.fn((params: ProjectActionConfirmationRespondParams) =>
      Promise.resolve({
        invocationId: params.invocationId,
        decision: params.decision,
        acceptedAtMs: 1_001
      })
    ),
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((completion) => {
    resolve = completion
  })
  return { promise, resolve }
}

describe('ProjectActionConfirmationProvider', () => {
  it.each([
    [0, 'confirmed'],
    [1, 'denied']
  ] as const)(
    'echoes the exact challenge with a %s native decision',
    async (response, decision) => {
      const registry = new WindowRegistry()
      const target = registerTarget(registry)
      const challenge = challengeFor()
      const transport = transportFor(challenge)
      const showMessageBox = vi
        .fn<
          (
            window: Electron.BrowserWindow,
            options: Electron.MessageBoxOptions
          ) => Promise<Electron.MessageBoxReturnValue>
        >()
        .mockResolvedValue({ response, checkboxChecked: false })
      const provider = new ProjectActionConfirmationProvider({
        identity,
        registry,
        transport,
        showMessageBox,
        onProviderLost: vi.fn(),
        now: () => 1_000
      })

      provider.start()
      await vi.waitFor(() => expect(transport.respond).toHaveBeenCalledOnce())

      expect(showMessageBox).toHaveBeenCalledWith(
        target.window,
        expect.objectContaining({
          message: 'Run “Build project”?',
          detail: 'Project: Example project\nExecutable: Approved executable\nArguments: 2',
          buttons: ['Run action', 'Cancel'],
          defaultId: 1,
          cancelId: 1
        })
      )
      const displayedOptions = showMessageBox.mock.calls[0]?.[1]
      expect(displayedOptions?.signal).toBeInstanceOf(AbortSignal)
      const displayed = JSON.stringify(displayedOptions)
      expect(displayed).not.toContain(INVOCATION_ID)
      expect(displayed).not.toContain(NONCE)
      expect(displayed).not.toContain(CHALLENGE_SHA256)
      expect(displayed).not.toContain(DEFINITION_SHA256)
      expect(transport.respond).toHaveBeenCalledWith({
        identity,
        invocationId: INVOCATION_ID,
        nonce: NONCE,
        challenge: CHALLENGE_SHA256,
        target: { windowId: WINDOW_ID, windowGeneration: 1 },
        confirmationDefinitionSha256: DEFINITION_SHA256,
        decision
      })
      await provider.stop()
    }
  )

  it.each([
    [
      'identity',
      challengeFor({ identity: { ...identity, providerEpoch: identity.providerEpoch + 1 } })
    ],
    ['window generation', challengeFor({ target: { windowId: WINDOW_ID, windowGeneration: 2 } })]
  ])('fails closed on a mismatched %s', async (_label, challenge) => {
    const registry = new WindowRegistry()
    registerTarget(registry)
    const transport = transportFor(challenge)
    const showMessageBox = vi.fn()
    const onProviderLost = vi.fn()
    const provider = new ProjectActionConfirmationProvider({
      identity,
      registry,
      transport,
      showMessageBox,
      onProviderLost,
      now: () => 1_000
    })

    provider.start()
    await vi.waitFor(() => expect(onProviderLost).toHaveBeenCalledOnce())

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(transport.respond).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('fails closed when the server response does not echo the accepted decision', async () => {
    const registry = new WindowRegistry()
    registerTarget(registry)
    const challenge = challengeFor()
    const transport = transportFor(challenge, {
      respond: vi.fn().mockResolvedValue({
        invocationId: INVOCATION_ID,
        decision: 'denied',
        acceptedAtMs: 1_001
      })
    })
    const onProviderLost = vi.fn()
    const provider = new ProjectActionConfirmationProvider({
      identity,
      registry,
      transport,
      showMessageBox: vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false }),
      onProviderLost,
      now: () => 1_000
    })

    provider.start()
    await vi.waitFor(() => expect(onProviderLost).toHaveBeenCalledOnce())

    expect(transport.respond).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'confirmed' })
    )
    await provider.stop()
  })

  it('does not display or answer an expired challenge', async () => {
    const registry = new WindowRegistry()
    registerTarget(registry)
    const challenge = challengeFor({ expiresAtMs: 999 })
    const transport = transportFor(challenge)
    const showMessageBox = vi.fn()
    const provider = new ProjectActionConfirmationProvider({
      identity,
      registry,
      transport,
      showMessageBox,
      onProviderLost: vi.fn(),
      now: () => 1_000
    })

    provider.start()
    await vi.waitFor(() => expect(transport.poll).toHaveBeenCalledTimes(2))

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(transport.respond).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('rejects a window generation changed while the native prompt is open', async () => {
    const registry = new WindowRegistry()
    registerTarget(registry)
    const challenge = challengeFor()
    const transport = transportFor(challenge)
    const shown = deferred<Electron.MessageBoxReturnValue>()
    const showMessageBox = vi.fn(() => shown.promise)
    const onProviderLost = vi.fn()
    const provider = new ProjectActionConfirmationProvider({
      identity,
      registry,
      transport,
      showMessageBox,
      onProviderLost,
      now: () => 1_000
    })
    provider.start()
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce())

    registry.refreshRenderer(WINDOW_ID)
    shown.resolve({ response: 0, checkboxChecked: false })
    await vi.waitFor(() => expect(onProviderLost).toHaveBeenCalledOnce())

    expect(transport.respond).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('aborts a pending native prompt on stop and ignores its late result', async () => {
    const registry = new WindowRegistry()
    registerTarget(registry)
    const challenge = challengeFor()
    const transport = transportFor(challenge)
    const shown = deferred<Electron.MessageBoxReturnValue>()
    let promptSignal: AbortSignal | undefined
    const showMessageBox = vi.fn((_window, options: Electron.MessageBoxOptions) => {
      promptSignal = options.signal
      options.signal?.addEventListener(
        'abort',
        () => shown.resolve({ response: 1, checkboxChecked: false }),
        { once: true }
      )
      return shown.promise
    })
    const provider = new ProjectActionConfirmationProvider({
      identity,
      registry,
      transport,
      showMessageBox,
      onProviderLost: vi.fn(),
      now: () => 1_000
    })
    provider.start()
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce())

    await provider.stop('provider lease lost')

    expect(promptSignal?.aborted).toBe(true)
    expect(transport.respond).not.toHaveBeenCalled()
  })

  it('reports transport failure as provider loss', async () => {
    const registry = new WindowRegistry()
    registerTarget(registry)
    const onProviderLost = vi.fn()
    const provider = new ProjectActionConfirmationProvider({
      identity,
      registry,
      transport: {
        poll: vi.fn().mockRejectedValue(new Error('connection lost')),
        respond: vi.fn()
      },
      showMessageBox: vi.fn(),
      onProviderLost
    })

    provider.start()
    await vi.waitFor(() => expect(onProviderLost).toHaveBeenCalledOnce())

    expect(provider.active).toBe(false)
    await provider.stop()
  })
})
