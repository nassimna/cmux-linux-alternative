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
    navigate: () => Promise.resolve(),
    waitForLifecycle: () => Promise.resolve(),
    executeClosedScript: () => Promise.resolve(true),
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
