import { randomUUID } from 'node:crypto'

import { expect, it } from 'vitest'

import { BrowserAutomationProviderAuthority } from './provider-authority'

it('rotates trusted window generations and interrupts stale provider polls', async () => {
  const windowId = randomUUID()
  let current = true
  const authority = new BrowserAutomationProviderAuthority((candidate) =>
    current && candidate === windowId
  )
  const first = authority.registerTrustedWindow(windowId, 1)
  expect(authority.isCurrent(first, { windowId, windowGeneration: 1 })).toBe(true)
  const waiting = authority.mailbox.poll({ identity: first, timeoutMs: 30_000 })
  const second = authority.registerTrustedWindow(windowId, 2)
  expect(await waiting).toEqual({})
  expect(authority.isCurrent(first)).toBe(false)
  expect(authority.isCurrent(second, { windowId, windowGeneration: 1 })).toBe(false)
  expect(authority.isCurrent(second, { windowId, windowGeneration: 2 })).toBe(true)
  expect(authority.claim({ windowId, windowGeneration: 2 }).identity).toEqual(second)
  expect(() => authority.claim({ windowId, windowGeneration: 1 })).toThrow('provider_unavailable')
  current = false
  expect(authority.isCurrent(second)).toBe(false)
  expect(() => authority.registerTrustedWindow(windowId, 3)).toThrow('provider_unavailable')
  authority.dispose()
})
