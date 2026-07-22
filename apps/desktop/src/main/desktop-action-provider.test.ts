import type {
  DesktopActionAcknowledgeParams,
  DesktopActionAcknowledgeResult,
  DesktopActionExecutionRequest,
  DesktopActionPollResult,
  DesktopActionStartClaimResult,
  DesktopProviderIdentityParams
} from '@agent-workspace/protocol-client'
import { describe, expect, it, vi } from 'vitest'

import {
  DesktopActionAcknowledgementCache,
  DesktopActionProvider,
  type DesktopActionTransport
} from './desktop-action-provider'
import { WindowRegistry, type WindowRegistryBinding } from './window-registry'

const PROVIDER_ID = '10000000-0000-4000-8000-000000000001'
const LEASE_ID = '10000000-0000-4000-8000-000000000002'
const RECOVERED_LEASE_ID = '10000000-0000-4000-8000-000000000003'
const WINDOW_ID = '10000000-0000-4000-8000-000000000004'
const INVOCATION_ID = '10000000-0000-4000-8000-000000000005'
const CORRELATION_ID = '10000000-0000-4000-8000-000000000006'

const identity: DesktopProviderIdentityParams = {
  providerId: PROVIDER_ID,
  providerEpoch: 7,
  leaseId: LEASE_ID
}

function registerTarget(registry: WindowRegistry) {
  const window = {
    webContents: { id: 41, mainFrame: {} },
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn()
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

function requestFor(
  providerIdentity: DesktopProviderIdentityParams = identity,
  overrides: Partial<DesktopActionExecutionRequest> = {}
): DesktopActionExecutionRequest {
  return {
    identity: providerIdentity,
    invocationId: INVOCATION_ID,
    correlationId: CORRELATION_ID,
    attemptEpoch: 1,
    actionId: 'desktop.window.focus',
    actionVersion: 1,
    target: { windowId: WINDOW_ID, windowGeneration: 1 },
    parameters: {},
    expiresAtMs: 2_000,
    ...overrides
  }
}

function granted(request: DesktopActionExecutionRequest): DesktopActionStartClaimResult {
  return {
    invocationId: request.invocationId,
    correlationId: request.correlationId,
    attemptEpoch: request.attemptEpoch,
    decision: 'granted',
    grantedAtMs: 1_000
  }
}

function acknowledgementResult(
  params: DesktopActionAcknowledgeParams
): DesktopActionAcknowledgeResult {
  if (params.status === 'succeeded') {
    return {
      invocation: {
        invocationId: params.invocationId,
        correlationId: params.correlationId,
        state: 'acknowledged',
        terminalCode: 'succeeded',
        result: params.result ?? {},
        updatedAtMs: 1_001
      }
    }
  }
  if (params.status === 'failed') {
    return {
      invocation: {
        invocationId: params.invocationId,
        correlationId: params.correlationId,
        state: 'failed',
        terminalCode: 'failed',
        errorCode: params.errorCode ?? 'execution_failed',
        updatedAtMs: 1_001
      }
    }
  }
  return {
    invocation: {
      invocationId: params.invocationId,
      correlationId: params.correlationId,
      state: 'canceled',
      terminalCode: 'canceled',
      updatedAtMs: 1_001
    }
  }
}

function polling(...results: DesktopActionPollResult[]) {
  const queue = [...results]
  return vi.fn((_params, signal: AbortSignal): Promise<DesktopActionPollResult> => {
    const result = queue.shift()
    if (result) return Promise.resolve(result)
    if (signal.aborted) return Promise.resolve({})
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({}), { once: true })
    })
  })
}

function transportFor(
  request: DesktopActionExecutionRequest,
  overrides: Partial<DesktopActionTransport> = {}
) {
  const transport = {
    poll: polling({ request }),
    claimStart: vi.fn().mockResolvedValue(granted(request)),
    acknowledge: vi.fn((params: DesktopActionAcknowledgeParams) =>
      Promise.resolve(acknowledgementResult(params))
    ),
    ...overrides
  }
  return transport
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((completion) => {
    resolve = completion
  })
  return { promise, resolve }
}

describe('DesktopActionProvider', () => {
  it('obtains an exact start grant before applying the native effect', async () => {
    const registry = new WindowRegistry()
    const target = registerTarget(registry)
    const request = requestFor()
    const claim = deferred<DesktopActionStartClaimResult>()
    const transport = transportFor(request, { claimStart: vi.fn(() => claim.promise) })
    const provider = new DesktopActionProvider({
      identity,
      registry,
      transport,
      onProviderLost: vi.fn(),
      now: () => 1_000
    })

    provider.start()
    await vi.waitFor(() => expect(transport.claimStart).toHaveBeenCalledOnce())
    expect(target.window.focus).not.toHaveBeenCalled()
    claim.resolve(granted(request))
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledOnce())

    expect(transport.claimStart).toHaveBeenCalledWith({
      identity,
      invocationId: INVOCATION_ID,
      correlationId: CORRELATION_ID,
      attemptEpoch: 1,
      actionId: 'desktop.window.focus',
      actionVersion: 1,
      target: { windowId: WINDOW_ID, windowGeneration: 1 }
    })
    expect(target.window.focus).toHaveBeenCalledOnce()
    expect(transport.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ identity, status: 'succeeded', result: {} })
    )
    await provider.stop()
  })

  it.each([
    ['request identity', requestFor({ ...identity, leaseId: RECOVERED_LEASE_ID }), undefined],
    [
      'start grant echo',
      requestFor(),
      {
        ...granted(requestFor()),
        correlationId: '10000000-0000-4000-8000-000000000099'
      }
    ]
  ])('fails closed on a mismatched %s', async (_label, request, claimResult) => {
    const registry = new WindowRegistry()
    const target = registerTarget(registry)
    const onProviderLost = vi.fn()
    const transport = transportFor(request, {
      claimStart: vi.fn().mockResolvedValue(claimResult ?? granted(request))
    })
    const provider = new DesktopActionProvider({
      identity,
      registry,
      transport,
      onProviderLost,
      now: () => 1_000
    })

    provider.start()
    await vi.waitFor(() => expect(onProviderLost).toHaveBeenCalledOnce())

    expect(target.window.focus).not.toHaveBeenCalled()
    expect(transport.acknowledge).not.toHaveBeenCalled()
    await provider.stop()
  })

  it('re-acknowledges an exact duplicate without reclaiming or repeating the effect', async () => {
    const registry = new WindowRegistry()
    const target = registerTarget(registry)
    const request = requestFor()
    const transport = transportFor(request, { poll: polling({ request }, { request }) })
    const provider = new DesktopActionProvider({
      identity,
      registry,
      transport,
      onProviderLost: vi.fn(),
      now: () => 1_000
    })

    provider.start()
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledTimes(2))

    expect(transport.claimStart).toHaveBeenCalledOnce()
    expect(target.window.focus).toHaveBeenCalledOnce()
    await provider.stop()
  })

  it('replays a cached acknowledgement after exact live registration recovery', async () => {
    const registry = new WindowRegistry()
    const target = registerTarget(registry)
    const cache = new DesktopActionAcknowledgementCache()
    const request = requestFor()
    const firstLost = vi.fn()
    const firstTransport = transportFor(request, {
      acknowledge: vi.fn().mockRejectedValue(new Error('response lost'))
    })
    const first = new DesktopActionProvider({
      identity,
      registry,
      transport: firstTransport,
      acknowledgementCache: cache,
      onProviderLost: firstLost,
      now: () => 1_000
    })
    first.start()
    await vi.waitFor(() => expect(firstLost).toHaveBeenCalledOnce())

    const recoveredRequest = requestFor()
    const recoveredTransport = transportFor(recoveredRequest)
    const recovered = new DesktopActionProvider({
      identity,
      registry,
      transport: recoveredTransport,
      acknowledgementCache: cache,
      onProviderLost: vi.fn(),
      now: () => 1_000
    })
    recovered.start()
    await vi.waitFor(() => expect(recoveredTransport.acknowledge).toHaveBeenCalledOnce())

    expect(recoveredTransport.claimStart).not.toHaveBeenCalled()
    expect(target.window.focus).toHaveBeenCalledOnce()
    expect(recoveredTransport.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ identity, status: 'succeeded' })
    )
    await recovered.stop()
  })

  it('rejects a renderer generation changed after the grant and before the effect', async () => {
    const registry = new WindowRegistry()
    const target = registerTarget(registry)
    const request = requestFor()
    const claim = deferred<DesktopActionStartClaimResult>()
    const transport = transportFor(request, { claimStart: vi.fn(() => claim.promise) })
    const provider = new DesktopActionProvider({
      identity,
      registry,
      transport,
      onProviderLost: vi.fn(),
      now: () => 1_000
    })
    provider.start()
    await vi.waitFor(() => expect(transport.claimStart).toHaveBeenCalledOnce())

    registry.refreshRenderer(WINDOW_ID)
    claim.resolve(granted(request))
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledOnce())

    expect(target.window.focus).not.toHaveBeenCalled()
    expect(transport.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'target_stale' })
    )
    await provider.stop()
  })

  it.each(['canceled', 'expired'] as const)(
    'does not execute or acknowledge an already %s invocation',
    async (decision) => {
      const registry = new WindowRegistry()
      const target = registerTarget(registry)
      const request = requestFor()
      const transport = transportFor(request, {
        claimStart: vi.fn().mockResolvedValue({
          invocationId: INVOCATION_ID,
          correlationId: CORRELATION_ID,
          attemptEpoch: 1,
          decision,
          terminalCode: decision
        })
      })
      const provider = new DesktopActionProvider({
        identity,
        registry,
        transport,
        onProviderLost: vi.fn(),
        now: () => 1_000
      })
      provider.start()
      await vi.waitFor(() => expect(transport.claimStart).toHaveBeenCalledOnce())
      await Promise.resolve()

      expect(target.window.focus).not.toHaveBeenCalled()
      expect(transport.acknowledge).not.toHaveBeenCalled()
      await provider.stop()
    }
  )

  it('acknowledges an invocation that expires after its grant as failed', async () => {
    const registry = new WindowRegistry()
    const target = registerTarget(registry)
    const request = requestFor(identity, { expiresAtMs: 999 })
    const transport = transportFor(request)
    const provider = new DesktopActionProvider({
      identity,
      registry,
      transport,
      onProviderLost: vi.fn(),
      now: () => 1_000
    })
    provider.start()
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledOnce())

    expect(target.window.focus).not.toHaveBeenCalled()
    expect(transport.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'expired' })
    )
    await provider.stop()
  })

  it('converts shutdown during a start claim into a terminal cancellation without an effect', async () => {
    const registry = new WindowRegistry()
    const target = registerTarget(registry)
    const request = requestFor()
    const claim = deferred<DesktopActionStartClaimResult>()
    const transport = transportFor(request, { claimStart: vi.fn(() => claim.promise) })
    const provider = new DesktopActionProvider({
      identity,
      registry,
      transport,
      onProviderLost: vi.fn(),
      now: () => 1_000
    })
    provider.start()
    await vi.waitFor(() => expect(transport.claimStart).toHaveBeenCalledOnce())

    const stopping = provider.stop('application shutdown')
    claim.resolve(granted(request))
    await stopping

    expect(target.window.focus).not.toHaveBeenCalled()
    expect(transport.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canceled' })
    )
  })
})
