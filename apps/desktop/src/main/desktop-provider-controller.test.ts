import { describe, expect, it, vi } from 'vitest'

import {
  DesktopProviderAcknowledgementCache,
  DesktopProviderController
} from './desktop-provider-controller'
import { ProviderRecoveryCoordinator } from './provider-recovery-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => (resolve = complete))
  return { promise, resolve }
}

describe('DesktopProviderController', () => {
  it('registers, heartbeats, polls, and acknowledges one request', async () => {
    const poll = vi.fn()
    poll
      .mockResolvedValueOnce({ requestId: 'request-a' })
      .mockImplementation(
        (_leaseId: string, signal: AbortSignal) =>
          new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
      )
    let heartbeat!: () => void
    const transport = {
      register: vi.fn().mockResolvedValue({ leaseId: 'lease-a', heartbeatIntervalMs: 100 }),
      heartbeat: vi.fn().mockResolvedValue(undefined),
      unregister: vi.fn().mockResolvedValue(undefined),
      poll,
      acknowledge: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined)
    }
    const controller = new DesktopProviderController({
      transport,
      execute: vi.fn().mockResolvedValue({ requestId: 'request-a', status: 'ok' }),
      schedule: (callback) => {
        heartbeat = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      logError: vi.fn()
    })

    await controller.start()
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledOnce())
    await controller.heartbeatNow()
    expect(transport.heartbeat).toHaveBeenCalledWith('lease-a')
    heartbeat()
    await vi.waitFor(() => expect(transport.heartbeat).toHaveBeenCalledWith('lease-a'))
    await controller.stop()
    expect(transport.unregister).toHaveBeenCalledWith('lease-a')
    expect(controller.activeRequestCount).toBe(0)
  })

  it('cancels in-flight execution and never acknowledges after disconnect', async () => {
    const execution = deferred<{ requestId: string }>()
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ requestId: 'request-a' })
      .mockImplementation(
        (_leaseId: string, signal: AbortSignal) =>
          new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
      )
    const transport = {
      register: vi.fn().mockResolvedValue({ leaseId: 'lease-a', heartbeatIntervalMs: 100 }),
      heartbeat: vi.fn(),
      unregister: vi.fn().mockResolvedValue(undefined),
      poll,
      acknowledge: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined)
    }
    const controller = new DesktopProviderController({
      transport,
      execute: vi.fn(() => execution.promise),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn(),
      logError: vi.fn()
    })
    await controller.start()
    await vi.waitFor(() => expect(controller.activeRequestCount).toBe(1))
    const stopping = controller.stop('window closed')
    execution.resolve({ requestId: 'request-a' })
    await stopping

    expect(transport.cancel).toHaveBeenCalledWith('lease-a', 'request-a', 'window closed')
    expect(transport.acknowledge).not.toHaveBeenCalled()
  })

  it('replays the exact acknowledgement for duplicate delivery without executing twice', async () => {
    const requests = [{ requestId: 'request-a' }, { requestId: 'request-a' }]
    const transport = {
      register: vi.fn().mockResolvedValue({ leaseId: 'lease-a', heartbeatIntervalMs: 100 }),
      heartbeat: vi.fn(),
      unregister: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn((_leaseId: string, signal: AbortSignal) => {
        const request = requests.shift()
        return request
          ? Promise.resolve(request)
          : new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
      }),
      acknowledge: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined)
    }
    const execute = vi.fn().mockResolvedValue({ requestId: 'request-a' })
    const controller = new DesktopProviderController({
      transport,
      execute,
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn(),
      logError: vi.fn()
    })
    await controller.start()
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledTimes(2))
    await controller.stop()
    expect(execute).toHaveBeenCalledOnce()
    expect(transport.acknowledge.mock.calls[1]).toEqual(transport.acknowledge.mock.calls[0])
    expect(transport.cancel).not.toHaveBeenCalled()
  })

  it('acknowledges execution failures and replays the exact failed acknowledgement', async () => {
    const requests = [{ requestId: 'request-a' }, { requestId: 'request-a' }]
    const transport = {
      register: vi.fn().mockResolvedValue({ leaseId: 'lease-a', heartbeatIntervalMs: 100 }),
      heartbeat: vi.fn(),
      unregister: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn((_leaseId: string, signal: AbortSignal) => {
        const request = requests.shift()
        return request
          ? Promise.resolve(request)
          : new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
      }),
      acknowledge: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined)
    }
    const execute = vi.fn().mockRejectedValue(new Error('native window failed'))
    const controller = new DesktopProviderController({
      transport,
      execute,
      executionFailed: (request: { requestId: string }) => ({
        requestId: request.requestId,
        status: 'failed',
        errorCode: 'desktop_action_failed'
      }),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn(),
      logError: vi.fn()
    })

    await controller.start()
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledTimes(2))
    await controller.stop()

    expect(execute).toHaveBeenCalledOnce()
    expect(transport.cancel).not.toHaveBeenCalled()
    expect(transport.acknowledge.mock.calls[1]).toEqual(transport.acknowledge.mock.calls[0])
  })

  it('replays a cached acknowledgement after replacement following a lost same-epoch ack', async () => {
    const requests = [{ requestId: 'request-a' }, { requestId: 'request-a' }]
    const transport = {
      register: vi
        .fn()
        .mockResolvedValueOnce({
          leaseId: 'lease-a',
          heartbeatIntervalMs: 100,
          providerEpoch: 7
        })
        .mockResolvedValueOnce({
          leaseId: 'lease-b',
          heartbeatIntervalMs: 100,
          providerEpoch: 7
        }),
      heartbeat: vi.fn(),
      unregister: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn((_leaseId: string, signal: AbortSignal) => {
        const request = requests.shift()
        return request
          ? Promise.resolve(request)
          : new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
      }),
      acknowledge: vi
        .fn()
        .mockRejectedValueOnce(new Error('response lost'))
        .mockResolvedValueOnce(undefined),
      cancel: vi.fn().mockResolvedValue(undefined)
    }
    const execute = vi.fn().mockResolvedValue({ requestId: 'request-a', status: 'succeeded' })
    const acknowledgementCache = new DesktopProviderAcknowledgementCache<{
      requestId: string
      status: string
    }>()
    const acknowledged = vi.fn()
    const createController = () =>
      new DesktopProviderController({
        transport,
        execute,
        acknowledgementCache,
        acknowledged,
        schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
        cancelSchedule: vi.fn(),
        logError: vi.fn()
      })

    const first = createController()
    await first.start()
    await vi.waitFor(() => expect(first.active).toBe(false))
    const replacement = createController()
    await replacement.start()
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledTimes(2))
    await replacement.stop()
    expect(execute).toHaveBeenCalledOnce()
    expect(transport.acknowledge.mock.calls[1]?.[1]).toEqual(
      transport.acknowledge.mock.calls[0]?.[1]
    )
    expect(acknowledged).toHaveBeenCalledOnce()
  })

  it('shares one registration across concurrent start calls', async () => {
    const registration = deferred<{
      leaseId: string
      heartbeatIntervalMs: number
      providerEpoch: number
    }>()
    const transport = {
      register: vi.fn(() => registration.promise),
      heartbeat: vi.fn(),
      unregister: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn(
        (_leaseId: string, signal: AbortSignal) =>
          new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
      ),
      acknowledge: vi.fn(),
      cancel: vi.fn()
    }
    const controller = new DesktopProviderController({
      transport,
      execute: vi.fn(),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn(),
      logError: vi.fn()
    })

    const first = controller.start()
    const second = controller.start()
    expect(transport.register).toHaveBeenCalledOnce()
    registration.resolve({ leaseId: 'lease-a', heartbeatIntervalMs: 100, providerEpoch: 2 })
    await Promise.all([first, second])
    expect(transport.register).toHaveBeenCalledOnce()
    await controller.stop()
  })

  it('defers provider polling until exact native-window bindings are ready', async () => {
    const poll = vi.fn(
      (_leaseId: string, signal: AbortSignal) =>
        new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
    )
    const controller = new DesktopProviderController({
      transport: {
        register: vi.fn().mockResolvedValue({ leaseId: 'lease-a', heartbeatIntervalMs: 100 }),
        heartbeat: vi.fn().mockResolvedValue(undefined),
        unregister: vi.fn().mockResolvedValue(undefined),
        poll,
        acknowledge: vi.fn(),
        cancel: vi.fn()
      },
      execute: vi.fn(),
      deferPolling: true,
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn(),
      logError: vi.fn()
    })

    await controller.start()
    expect(controller.active).toBe(true)
    expect(poll).not.toHaveBeenCalled()
    controller.startPolling()
    controller.startPolling()
    expect(poll).toHaveBeenCalledOnce()
    await controller.stop()
  })

  it('pauses and resumes polling without surrendering the provider lease', async () => {
    const poll = vi.fn(
      (_leaseId: string, signal: AbortSignal) =>
        new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
    )
    const unregister = vi.fn().mockResolvedValue(undefined)
    const controller = new DesktopProviderController({
      transport: {
        register: vi.fn().mockResolvedValue({ leaseId: 'lease-a', heartbeatIntervalMs: 100 }),
        heartbeat: vi.fn().mockResolvedValue(undefined),
        unregister,
        poll,
        acknowledge: vi.fn(),
        cancel: vi.fn()
      },
      execute: vi.fn(),
      deferPolling: true,
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn(),
      logError: vi.fn()
    })

    await controller.start()
    controller.startPolling()
    expect(poll).toHaveBeenCalledOnce()

    await controller.pausePolling('renderer generation changed')
    expect(unregister).not.toHaveBeenCalled()

    controller.startPolling()
    expect(poll).toHaveBeenCalledTimes(2)
    await controller.stop()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('does not deadlock when heartbeat loss schedules recovery behind the binding operation', async () => {
    let serialized: Promise<void> = Promise.resolve()
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = serialized.then(operation)
      serialized = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
    let recovered = false
    const recovery = new ProviderRecoveryCoordinator<string>({
      delaysMs: [0],
      recover: () =>
        serialize(() => {
          recovered = true
          return Promise.resolve(true)
        }),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    const transport = {
      register: vi.fn().mockResolvedValue({ leaseId: 'lease-a', heartbeatIntervalMs: 100 }),
      heartbeat: vi.fn().mockRejectedValue(new Error('lease lost')),
      unregister: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn(
        (_leaseId: string, signal: AbortSignal) =>
          new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
      ),
      acknowledge: vi.fn(),
      cancel: vi.fn()
    }
    const controller = new DesktopProviderController({
      transport,
      execute: vi.fn(),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn(),
      logError: vi.fn(),
      onLeaseLost: () => recovery.request('current-generation')
    })

    await controller.start()
    await expect(serialize(() => controller.heartbeatNow())).rejects.toThrow('lease lost')
    await vi.waitFor(() => expect(recovered).toBe(true))
  })

  it('unregisters after poll, acknowledgement, and cancellation transport failures', async () => {
    for (const failure of ['poll', 'acknowledge', 'cancel'] as const) {
      const transport = {
        register: vi
          .fn()
          .mockResolvedValue({ leaseId: `lease-${failure}`, heartbeatIntervalMs: 100 }),
        heartbeat: vi.fn(),
        unregister: vi.fn().mockResolvedValue(undefined),
        poll: vi.fn(),
        acknowledge: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined)
      }
      if (failure === 'poll') transport.poll.mockRejectedValueOnce(new Error('poll failed'))
      else transport.poll.mockResolvedValueOnce({ requestId: 'request-a' })
      if (failure === 'acknowledge') {
        transport.acknowledge.mockRejectedValueOnce(new Error('ack failed'))
      }
      if (failure === 'cancel') transport.cancel.mockRejectedValueOnce(new Error('cancel failed'))
      const onLeaseLost = vi.fn()
      const controller = new DesktopProviderController({
        transport,
        execute:
          failure === 'cancel'
            ? vi.fn().mockRejectedValue(new Error('execution failed'))
            : vi.fn().mockResolvedValue({ requestId: 'request-a' }),
        schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
        cancelSchedule: vi.fn(),
        logError: vi.fn(),
        onLeaseLost
      })
      await controller.start()
      await vi.waitFor(() => expect(transport.unregister).toHaveBeenCalledOnce())
      expect(controller.active).toBe(false)
      await vi.waitFor(() => expect(onLeaseLost).toHaveBeenCalledOnce())
    }
  })

  it('bounds deduplication and resets it for a new lease epoch', async () => {
    const queue = [
      { requestId: 'request-a' },
      { requestId: 'request-b' },
      { requestId: 'request-c' },
      { requestId: 'request-a' }
    ]
    const transport = {
      register: vi
        .fn()
        .mockResolvedValueOnce({ leaseId: 'lease-a', heartbeatIntervalMs: 100 })
        .mockResolvedValueOnce({ leaseId: 'lease-b', heartbeatIntervalMs: 100 }),
      heartbeat: vi.fn(),
      unregister: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn((_leaseId: string, signal: AbortSignal) => {
        const request = queue.shift()
        return request
          ? Promise.resolve(request)
          : new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)))
      }),
      acknowledge: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined)
    }
    const execute = vi.fn((request: { requestId: string }) => Promise.resolve(request))
    const controller = new DesktopProviderController({
      transport,
      execute,
      maxSeenRequests: 2,
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelSchedule: vi.fn(),
      logError: vi.fn()
    })
    await controller.start()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(4))
    await controller.stop()
    queue.push({ requestId: 'request-b' })
    await controller.start()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(5))
    await controller.stop()
    expect(transport.cancel).not.toHaveBeenCalledWith(
      expect.anything(),
      'request-b',
      'duplicate request'
    )
  })
})
