import { randomUUID } from 'node:crypto'

import { expect, it } from 'vitest'

import { BrowserAutomationScreenshotHandles } from './screenshot-handles'

it('bounds handle ownership, caller access, and expiry without storing PNG bytes', () => {
  let now = 1_000
  const handles = new BrowserAutomationScreenshotHandles(() => now)
  const callerId = randomUUID()
  const automationSessionId = randomUUID()
  const candidate = (handleId: string) => ({
    callerId, automationSessionId, sessionGeneration: 1, profileKey: 'default',
    identity: { providerId: randomUUID(), providerEpoch: 1, leaseId: randomUUID() },
    target: { windowId: randomUUID(), windowGeneration: 1 },
    handle: { handleId, width: 1, height: 1, byteLength: 3,
      mediaType: 'image/png' as const, sha256: 'a'.repeat(64),
      chunkCount: 1, expiresAtMs: now + 5_000 }
  })
  const first = candidate(randomUUID())
  handles.register(first)
  expect(() => handles.register(first)).toThrow('idempotency_conflict')
  expect(() => handles.get(first.handle.handleId, randomUUID(), automationSessionId, 1))
    .toThrow('policy_denied')
  handles.register(candidate(randomUUID()))
  expect(() => handles.register(candidate(randomUUID()))).toThrow('resource_limit')
  now += 5_000
  expect(() => handles.get(first.handle.handleId, callerId, automationSessionId, 1))
    .toThrow('result_expired')
  handles.clear()
})
