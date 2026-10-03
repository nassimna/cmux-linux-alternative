import { expect, it, vi } from 'vitest'

import {
  RemoteSessionActivationService,
  retryAfterTransportExit
} from './remote-session-activation-service'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import type { HostKeyAuthority } from './host-key-authority'
import type { CredentialProvider } from './credential-provider'
import type { RemoteInteractiveRuntime } from './remote-interactive-runtime'

it('keeps the retry budget across short-lived reconnects and resets after a stable connection', () => {
  expect(retryAfterTransportExit(undefined, 1_000, 1_001)).toBe(1)
  expect(retryAfterTransportExit({ attempt: 1 }, 1_000, 1_001)).toBe(2)
  expect(retryAfterTransportExit({ attempt: 2 }, 1_000, 29_999)).toBe(3)
  expect(retryAfterTransportExit({ attempt: 3 }, 1_000, 31_000)).toBe(1)
})

it('keeps a scheduled reconnect when a manual activation has a stale revision', async () => {
  vi.useFakeTimers()
  const session = {
    remoteSessionId: '11111111-1111-4111-8111-111111111111',
    remoteTargetId: '22222222-2222-4222-8222-222222222222',
    state: 'reconnecting',
    attemptGeneration: 2,
    revision: 3,
    reconnect: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 1_000 }
  }
  const state = {
    exclusive: (operation: () => unknown) => Promise.resolve(operation()),
    recordRemoteLocalTransportExit: () => true,
    getRemoteSession: () => ({ session }),
    beginRemoteSessionActivation: () => {
      throw new Error('stale_revision')
    }
  } as unknown as ApplicationStateStore
  const service = new RemoteSessionActivationService(
    state,
    {} as HostKeyAuthority,
    {} as CredentialProvider,
    {} as RemoteInteractiveRuntime
  )
  try {
    await service['recordExitAndSchedule'](session.remoteSessionId, 2, 1)
    expect(vi.getTimerCount()).toBe(1)
    await expect(
      service.activate({
        remoteSessionId: session.remoteSessionId,
        mutation: { expectedRevision: 2, idempotencyKey: 'stale', requestHash: 'stale' }
      })
    ).rejects.toThrow('stale_revision')
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    await service.dispose()
    vi.useRealTimers()
  }
})
