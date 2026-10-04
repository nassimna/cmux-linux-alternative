import { describe, expect, it, vi } from 'vitest'

import type {
  BrowserAutomationExecutionRequest,
  BrowserAutomationProviderAcknowledgeParams,
  BrowserAutomationProviderRequest,
  BrowserAutomationSessionSnapshot
} from '@agent-workspace/protocol-client'

import type {
  BrowserAutomationPage,
  BrowserAutomationManagerDependencies
} from './browser-automation-manager'
import { BrowserAutomationManager } from './browser-automation-manager'
import { BrowserAutomationProvider } from './browser-automation-provider'

const ID = '10000000-0000-4000-8000-000000000001'
const ID_2 = '10000000-0000-4000-8000-000000000002'
const ID_3 = '10000000-0000-4000-8000-000000000003'
const identity = { providerId: ID, providerEpoch: 1, leaseId: ID_2 }
const target = { windowId: ID_3, windowGeneration: 1 }
const binding = {
  workspaceId: '10000000-0000-4000-8000-000000000004',
  paneId: '10000000-0000-4000-8000-000000000005',
  tabId: '10000000-0000-4000-8000-000000000006',
  browserSessionId: '10000000-0000-4000-8000-000000000007',
  browserLifecycleId: '10000000-0000-4000-8000-000000000008',
  window: target
}

function page(
  binding: Parameters<BrowserAutomationManagerDependencies['createEphemeralPage']>[0]['target']
): BrowserAutomationPage {
  return {
    opaquePageToken: {},
    owned: true,
    target: binding,
    revalidate: (candidate) => candidate === binding,
    initialize: () => Promise.resolve(),
    inspect: () => Promise.resolve(null),
    stopRecording: () => Promise.resolve({ bytes: Buffer.from('webm'), width: 320, height: 240 }),
    navigate: () => Promise.resolve(),
    waitForLifecycle: () => Promise.resolve(),
    executeClosedScript: () => Promise.resolve(true),
    getURL: () => 'about:blank',
    evaluate: () => Promise.resolve(null),
    readDiagnostics: () => ({ entries: [], cursor: 0, dropped: 0 }),
    dispose: () => undefined,
    insertText: () => Promise.resolve(),
    sendKey: () => undefined,
    capture: () => Promise.resolve(Buffer.from('png')),
    onTopLevelNavigation: () => () => undefined,
    destroy: () => Promise.resolve()
  }
}

function session(): BrowserAutomationSessionSnapshot {
  return {
    automationSessionId: ID,
    generation: 1,
    navigationEpoch: 0,
    mode: 'ephemeral',
    state: 'ready',
    profileKey: 'private',
    target: binding,
    createdAtMs: 1,
    updatedAtMs: 1,
    expiresAtMs: Date.now() + 60_000
  }
}

function execution(): BrowserAutomationExecutionRequest {
  return {
    identity,
    target,
    session: session(),
    operation: {
      automationSessionId: ID,
      sessionGeneration: 1,
      navigationEpoch: 0,
      operationId: ID_2,
      attemptEpoch: 1,
      timeoutMs: 30_000,
      operation: {
        kind: 'wait',
        condition: { kind: 'lifecycle', lifecycle: 'load' }
      },
      idempotency: {
        epoch: '10000000-0000-4000-8000-000000000009',
        key: '10000000-0000-4000-8000-000000000010'
      },
      correlationId: ID_3
    }
  }
}

function managerWithWait(waitForLifecycle: () => Promise<void>): BrowserAutomationManager {
  return new BrowserAutomationManager({
    acquireAttachedPage: () => Promise.resolve(undefined),
    createEphemeralPage: (snapshot) =>
      Promise.resolve({ ...page(snapshot.target), waitForLifecycle }),
    confirmAttachment: () => Promise.resolve(false),
    now: Date.now,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle)
  })
}

function pollRequests(requests: BrowserAutomationProviderRequest[]) {
  let index = 0
  return (_params: unknown, signal: AbortSignal) => {
    const request = requests[index++]
    if (request) return Promise.resolve({ request })
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    })
  }
}

function acknowledgement(params: BrowserAutomationProviderAcknowledgeParams) {
  void params
  return Promise.resolve({
    operation: {
      automationSessionId: ID,
      sessionGeneration: 1,
      operationId: ID_2,
      correlationId: ID_3,
      attemptEpoch: 1,
      navigationEpoch: 0,
      state: 'succeeded' as const,
      result: { kind: 'empty' as const },
      updatedAtMs: Date.now()
    }
  })
}

function attachmentRequest(): Extract<BrowserAutomationProviderRequest, { kind: 'create' }> {
  return {
    kind: 'create',
    identity,
    target,
    provision: {
      automationSessionId: ID,
      generation: 1,
      mode: 'attach',
      profileKey: 'private',
      requestedTabId: binding.tabId,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000
    },
    operationId: ID_2,
    correlationId: ID_3,
    attemptEpoch: 4
  }
}

describe('BrowserAutomationProvider', () => {
  it('acknowledges lifecycle requests with exact service IDs and main-owned ephemeral binding', async () => {
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: () => Promise.resolve(undefined),
      createEphemeralPage: (snapshot) => Promise.resolve(page(snapshot.target)),
      confirmAttachment: () => Promise.resolve(false),
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    const acknowledge = vi.fn((params: BrowserAutomationProviderAcknowledgeParams) => {
      void params
      return Promise.resolve({
        operation: {
          automationSessionId: ID,
          sessionGeneration: 1,
          operationId: ID_2,
          correlationId: ID_3,
          attemptEpoch: 1,
          navigationEpoch: 0,
          state: 'succeeded' as const,
          result: { kind: 'empty' as const },
          updatedAtMs: Date.now()
        }
      })
    })
    let polls = 0
    const provider = new BrowserAutomationProvider({
      identity,
      transport: {
        poll: (_params, signal) => {
          polls += 1
          if (polls === 1) {
            return Promise.resolve({
              request: {
                kind: 'create' as const,
                identity,
                target,
                provision: {
                  automationSessionId: ID,
                  generation: 1,
                  mode: 'ephemeral' as const,
                  profileKey: 'private',
                  createdAtMs: Date.now(),
                  expiresAtMs: Date.now() + 60_000
                },
                operationId: ID_2,
                correlationId: ID_3,
                attemptEpoch: 4
              }
            })
          }
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
          })
        },
        acknowledge,
        respondTransfer: () => Promise.resolve()
      },
      resolveManager: (windowId, generation) =>
        windowId === target.windowId && generation === target.windowGeneration
          ? manager
          : undefined,
      managers: () => [manager],
      onProviderLost: vi.fn()
    })
    provider.start()
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce())
    const acknowledged = acknowledge.mock.calls[0]![0]
    expect(acknowledged).toMatchObject({
      automationSessionId: ID,
      sessionGeneration: 1,
      operationId: ID_2,
      correlationId: ID_3,
      attemptEpoch: 4,
      state: 'succeeded'
    })
    expect(acknowledged.session?.target.window).toEqual(target)
    expect(acknowledged.session?.target.browserSessionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(manager.diagnosticCounts.sessions).toBe(1)
    await provider.stop()
    expect(manager.diagnosticCounts.sessions).toBe(0)
  })

  it.each([true, false])(
    'settles an attachment after the approval decision is %s',
    async (allowed) => {
      let decide!: (allowed: boolean) => void
      const confirmAttachment = vi.fn<BrowserAutomationManagerDependencies['confirmAttachment']>(
        () =>
          new Promise<boolean>((resolve) => {
            decide = resolve
          })
      )
      const acquireAttachedPage = vi.fn((target: typeof binding) =>
        Promise.resolve({ ...page(target), owned: false })
      )
      const manager = new BrowserAutomationManager({
        acquireAttachedPage,
        createEphemeralPage: () => Promise.reject(new Error('not used')),
        resolveAttachment: () => binding,
        confirmAttachment,
        now: Date.now,
        schedule: (callback, delayMs) => setTimeout(callback, delayMs),
        cancelSchedule: (handle) => clearTimeout(handle)
      })
      const acknowledge = vi.fn(acknowledgement)
      const onProviderLost = vi.fn()
      const provider = new BrowserAutomationProvider({
        identity,
        transport: {
          poll: pollRequests([attachmentRequest()]),
          acknowledge,
          respondTransfer: () => Promise.resolve()
        },
        resolveManager: () => manager,
        managers: () => [manager],
        onProviderLost
      })
      provider.start()
      await vi.waitFor(() => expect(confirmAttachment).toHaveBeenCalledOnce())
      expect(acknowledge).not.toHaveBeenCalled()
      expect(acquireAttachedPage).not.toHaveBeenCalled()
      decide(allowed)
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce())
      expect(acknowledge.mock.calls[0]![0]).toMatchObject({
        automationSessionId: ID,
        sessionGeneration: 1,
        operationId: ID_2,
        correlationId: ID_3,
        attemptEpoch: 4,
        ...(allowed
          ? { state: 'succeeded', session: { mode: 'attach', target: binding, navigationEpoch: 1 } }
          : { state: 'failed', errorCode: 'approval_denied' })
      })
      expect(manager.diagnosticCounts.sessions).toBe(allowed ? 1 : 0)
      expect(onProviderLost).not.toHaveBeenCalled()
      await provider.stop()
    }
  )

  it('acknowledges a tab invalidated during attachment initialization instead of waiting for timeout', async () => {
    let live = true
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: (target) =>
        Promise.resolve({
          ...page(target),
          owned: false,
          revalidate: () => live,
          initialize: () => {
            live = false
            return Promise.resolve()
          }
        }),
      createEphemeralPage: () => Promise.reject(new Error('not used')),
      resolveAttachment: () => binding,
      confirmAttachment: () => Promise.resolve(true),
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    const acknowledge = vi.fn(acknowledgement)
    const onProviderLost = vi.fn()
    const provider = new BrowserAutomationProvider({
      identity,
      transport: {
        poll: pollRequests([attachmentRequest()]),
        acknowledge,
        respondTransfer: () => Promise.resolve()
      },
      resolveManager: () => manager,
      managers: () => [manager],
      onProviderLost
    })
    provider.start()
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce())
    expect(acknowledge.mock.calls[0]![0]).toMatchObject({
      operationId: ID_2,
      state: 'failed',
      errorCode: 'target_stale'
    })
    expect(manager.diagnosticCounts.sessions).toBe(0)
    expect(onProviderLost).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('stopping the provider cancels a pending approval and fences a late Allow', async () => {
    let allow!: (allowed: boolean) => void
    const confirmAttachment = vi.fn<BrowserAutomationManagerDependencies['confirmAttachment']>(
      () =>
        new Promise<boolean>((resolve) => {
          allow = resolve
        })
    )
    const acquireAttachedPage = vi.fn((target: typeof binding) =>
      Promise.resolve({ ...page(target), owned: false })
    )
    const manager = new BrowserAutomationManager({
      acquireAttachedPage,
      createEphemeralPage: () => Promise.reject(new Error('not used')),
      resolveAttachment: () => binding,
      confirmAttachment,
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    const acknowledge = vi.fn(acknowledgement)
    const provider = new BrowserAutomationProvider({
      identity,
      transport: {
        poll: pollRequests([attachmentRequest()]),
        acknowledge,
        respondTransfer: () => Promise.resolve()
      },
      resolveManager: () => manager,
      managers: () => [manager],
      onProviderLost: vi.fn()
    })
    provider.start()
    await vi.waitFor(() => expect(confirmAttachment).toHaveBeenCalledOnce())
    await provider.stop()
    const signal = confirmAttachment.mock.calls[0]![1]
    expect(signal.aborted).toBe(true)
    allow(true)
    await Promise.resolve()
    expect(acquireAttachedPage).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
    expect(manager.diagnosticCounts.sessions).toBe(0)
  })

  it('publishes current navigation epochs under the provider identity', async () => {
    let navigate!: () => void
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: () => Promise.resolve(undefined),
      createEphemeralPage: (snapshot) =>
        Promise.resolve({
          ...page(snapshot.target),
          onTopLevelNavigation: (listener) => {
            navigate = listener
            return () => undefined
          }
        }),
      confirmAttachment: () => Promise.resolve(false),
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    await manager.createSession(session())
    navigate()
    const poll = vi.fn(pollRequests([]))
    const provider = new BrowserAutomationProvider({
      identity,
      transport: { poll, acknowledge: acknowledgement, respondTransfer: () => Promise.resolve() },
      resolveManager: () => manager,
      managers: () => [manager],
      onProviderLost: vi.fn()
    })
    provider.start()
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce())
    expect(poll.mock.calls[0]![0]).toMatchObject({
      identity,
      navigationUpdates: [{ automationSessionId: ID, sessionGeneration: 1, navigationEpoch: 1 }]
    })
    await provider.stop()
  })

  it('continues polling so a cancel request aborts a long operation', async () => {
    const manager = managerWithWait(() => new Promise(() => undefined))
    await manager.createSession(session())
    const acknowledge = vi.fn(acknowledgement)
    const provider = new BrowserAutomationProvider({
      identity,
      transport: {
        poll: pollRequests([
          { kind: 'execute', request: execution() },
          {
            kind: 'cancel',
            identity,
            target,
            automationSessionId: ID,
            sessionGeneration: 1,
            operationId: ID_2,
            correlationId: ID_3
          }
        ]),
        acknowledge,
        respondTransfer: () => Promise.resolve()
      },
      resolveManager: () => manager,
      managers: () => [manager],
      onProviderLost: vi.fn()
    })
    provider.start()
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce())
    expect(acknowledge.mock.calls[0]![0].state).toBe('canceled')
    await provider.stop()
  })

  it('acknowledges a stale attached tab without losing the provider', async () => {
    let live = true
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: (target) =>
        Promise.resolve({
          ...page(target),
          owned: false,
          revalidate: () => live
        }),
      createEphemeralPage: () => Promise.reject(new Error('not used')),
      confirmAttachment: () => Promise.resolve(true),
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    await manager.createSession({ ...session(), mode: 'attach' })
    live = false
    const acknowledge = vi.fn(acknowledgement)
    const onProviderLost = vi.fn()
    const provider = new BrowserAutomationProvider({
      identity,
      transport: {
        poll: pollRequests([
          {
            kind: 'execute',
            request: {
              ...execution(),
              session: { ...session(), mode: 'attach' }
            }
          }
        ]),
        acknowledge,
        respondTransfer: () => Promise.resolve()
      },
      resolveManager: () => manager,
      managers: () => [manager],
      onProviderLost
    })
    provider.start()
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce())
    expect(acknowledge.mock.calls[0]![0]).toMatchObject({
      operationId: ID_2,
      state: 'failed',
      errorCode: 'target_stale'
    })
    expect(onProviderLost).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('destroys a session while its operation is still running', async () => {
    const manager = managerWithWait(() => new Promise(() => undefined))
    await manager.createSession(session())
    const acknowledge = vi.fn(acknowledgement)
    const snapshot = session()
    const provider = new BrowserAutomationProvider({
      identity,
      transport: {
        poll: pollRequests([
          { kind: 'execute', request: execution() },
          {
            kind: 'destroy',
            identity,
            target,
            session: snapshot,
            operationId: '10000000-0000-4000-8000-000000000011',
            correlationId: ID_3,
            attemptEpoch: 2
          }
        ]),
        acknowledge,
        respondTransfer: () => Promise.resolve()
      },
      resolveManager: () => manager,
      managers: () => [manager],
      onProviderLost: vi.fn()
    })
    provider.start()
    await vi.waitFor(() => expect(manager.diagnosticCounts.sessions).toBe(0))
    await vi.waitFor(() =>
      expect(acknowledge.mock.calls.some(([params]) => params.operationId.endsWith('11'))).toBe(
        true
      )
    )
    await provider.stop()
  })

  it('stop aborts and waits for in-flight work before returning', async () => {
    const manager = managerWithWait(() => new Promise(() => undefined))
    await manager.createSession(session())
    const provider = new BrowserAutomationProvider({
      identity,
      transport: {
        poll: pollRequests([{ kind: 'execute', request: execution() }]),
        acknowledge: acknowledgement,
        respondTransfer: () => Promise.resolve()
      },
      resolveManager: () => manager,
      managers: () => [manager],
      onProviderLost: vi.fn()
    })
    provider.start()
    await vi.waitFor(() => expect(manager.diagnosticCounts.pending).toBe(1))
    await provider.stop()
    expect(manager.diagnosticCounts).toEqual({ sessions: 0, pending: 0, screenshots: 0 })
  })

  it('reports concurrent protocol failures exactly once', async () => {
    const manager = managerWithWait(() => Promise.resolve())
    const onProviderLost = vi.fn()
    const wrongIdentity = { ...identity, providerEpoch: 2 }
    const invalid = {
      kind: 'cancel' as const,
      identity: wrongIdentity,
      target,
      automationSessionId: ID,
      sessionGeneration: 1,
      operationId: ID_2,
      correlationId: ID_3
    }
    const provider = new BrowserAutomationProvider({
      identity,
      transport: {
        poll: pollRequests([invalid, invalid]),
        acknowledge: acknowledgement,
        respondTransfer: () => Promise.resolve()
      },
      resolveManager: () => manager,
      managers: () => [manager],
      onProviderLost
    })
    provider.start()
    await vi.waitFor(() => expect(onProviderLost).toHaveBeenCalledOnce())
    await provider.stop()
    expect(onProviderLost).toHaveBeenCalledOnce()
  })
})
