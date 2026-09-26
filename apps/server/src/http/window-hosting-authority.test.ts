import { randomUUID } from 'node:crypto'

import { expect, it } from 'vitest'

import { WindowHostingAuthority } from './window-hosting-authority'

it('fences exact generations, refreshes a lease without a revision, and unhosts on expiry', () => {
  const windowId = randomUUID()
  let now = 0
  let revision = 4
  let hosted = false
  const state = {
    reconcileWindowHosting: (claims: ReadonlySet<string>) => {
      const next = claims.has(windowId)
      if (next !== hosted) { hosted = next; revision += 1 }
      return revision
    }
  }
  const authority = new WindowHostingAuthority(state, () => now)
  expect(authority.register(windowId, 2)).toBe(5)
  expect(hosted).toBe(true)
  now = 5_000
  expect(authority.heartbeat(windowId, 2)).toBe(5)
  expect(authority.revoke(windowId, 1)).toBe(5)
  expect(hosted).toBe(true)
  expect(authority.register(windowId, 3)).toBe(5)
  expect(authority.revoke(windowId, 2)).toBe(5)
  now = 20_000
  authority.expire()
  expect(hosted).toBe(false)
  expect(revision).toBe(6)
  expect(() => authority.heartbeat(windowId, 3)).toThrow('stale_window_generation')
  expect(() => authority.register(windowId, 3)).toThrow('stale_window_generation')
  expect(authority.register(windowId, 4)).toBe(7)
  authority.close()
  expect(hosted).toBe(false)
  expect(revision).toBe(8)
})

it('reconciles two independent native window claims without dropping the surviving owner', () => {
  const first = randomUUID()
  const second = randomUUID()
  let hosted = new Set<string>()
  let revision = 0
  const authority = new WindowHostingAuthority({
    reconcileWindowHosting: (claims) => {
      if (claims.size !== hosted.size || [...claims].some((id) => !hosted.has(id))) {
        hosted = new Set(claims)
        revision += 1
      }
      return revision
    }
  })
  authority.register(first, 1)
  authority.register(second, 1)
  expect(hosted).toEqual(new Set([first, second]))
  authority.revoke(first, 1)
  expect(hosted).toEqual(new Set([second]))
  authority.close()
})
