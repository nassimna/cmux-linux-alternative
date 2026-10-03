import { randomUUID } from 'node:crypto'

import { expect, it } from 'vitest'

import { WindowBindingRegistry } from './window-binding-registry'

it('issues known nonclosing windows through the private owner and fences rotation, removal, expiry, and restart', () => {
  const first = randomUUID()
  const second = randomUUID()
  let now = 100
  let hostingState: 'hosted' | 'unhosted' | 'closing' = 'unhosted'
  const placement = (id: string, state: 'hosted' | 'unhosted' | 'closing') => ({
    id,
    label: 'Window',
    workspaceIds: [randomUUID()],
    focusedWorkspaceId: randomUUID(),
    hostingState: state,
    revision: 1
  })
  const reader = {
    readSnapshot: () => ({
      windowPlacements: [placement(first, hostingState), placement(second, 'unhosted')]
    })
  }
  const registry = new WindowBindingRegistry(reader, () => now, 50)

  const secondToken = registry.issueForTrustedOwner(second)
  expect(registry.resolve(secondToken)?.windowId).toBe(second)
  registry.revokeWindow(second)
  expect(() => registry.issueForTrustedOwner(randomUUID())).toThrowError(
    expect.objectContaining({ code: 'window_unavailable' })
  )
  const oldToken = registry.issueForTrustedOwner(first)
  const oldBinding = registry.resolve(oldToken)!
  expect(oldToken).not.toContain(first)
  expect(oldBinding.windowId).toBe(first)
  const token = registry.issueForTrustedOwner(first)
  expect(oldBinding.isCurrent()).toBe(false)
  expect(registry.resolve(oldToken)).toBeUndefined()
  const binding = registry.resolve(token)!
  expect(binding.isCurrent()).toBe(true)
  hostingState = 'closing'
  expect(binding.isCurrent()).toBe(false)
  expect(registry.resolve(token)).toBeUndefined()

  hostingState = 'unhosted'
  const expiring = registry.issueForTrustedOwner(first)
  now = 150
  expect(registry.resolve(expiring)).toBeUndefined()
  const revoked = registry.issueForTrustedOwner(first)
  registry.revokeWindow(first)
  expect(registry.resolve(revoked)).toBeUndefined()
  const current = registry.issueForTrustedOwner(first)
  registry.dispose()
  expect(registry.resolve(current)).toBeUndefined()
  expect(() => registry.issueForTrustedOwner(first)).toThrowError(
    expect.objectContaining({ code: 'registry_closed' })
  )
  expect(new WindowBindingRegistry(reader, () => now).resolve(current)).toBeUndefined()
})
