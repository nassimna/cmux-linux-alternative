import { randomUUID } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import type { RecentlyClosedService } from '../persistence/recently-closed-service'
import { TerminalService } from '../terminal/terminal-service'
import { createApp } from './app'
import { WindowBindingRegistry } from './window-binding-registry'

const token = 'recently-closed-sidebar-test-token-0123456789-abcdef'

it('requires a current private window capability for descriptor list and exact reopen', async () => {
  const windowId = randomUUID()
  const otherWindowId = randomUUID()
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const closedItemId = randomUUID()
  const descriptorId = randomUUID()
  const epoch = randomUUID()
  const state = {
    windowPlacements: [{ id: windowId, hostingState: 'hosted' }]
  }
  const store = {
    readSnapshot: () => state,
    currentIdempotencyEpoch: () => epoch
  } as unknown as ApplicationStateStore
  const bindings = new WindowBindingRegistry(store)
  const service = new TerminalService({ spawn: () => Promise.reject(new Error('No terminal expected')) })
  const runtime = { uses: () => true, isReady: () => true } as never
  const listSidebar = vi.fn(() => ({
    records: [{
      recentlyClosedId: closedItemId,
      authorizedDescriptorId: descriptorId,
      action: 'reopenTerminal' as const,
      label: 'Closed terminal',
      closedAtMs: 42,
      revision: 7
    }]
  }))
  const reopenFromSidebar = vi.fn((_request: unknown, binding: { isCurrent(): boolean }) => {
    expect(binding.isCurrent()).toBe(true)
    return Promise.resolve({
      revision: 8,
      replayed: false,
      idempotencyEpoch: epoch,
      tabId: randomUUID(),
      ownershipKind: 'terminal',
      placement: { windowId, workspaceId, paneId, index: 0, windowRevision: 3 },
      transferEpoch: 8
    })
  })
  const recentlyClosed = { listSidebar, reopenFromSidebar } as unknown as RecentlyClosedService
  const app = createApp(
    service, token, undefined, store, runtime, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, recentlyClosed, undefined, bindings
  )
  const url = '/v1/sidebar/recently-closed'
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const post = (path: string, body: unknown, capability?: string) => app.request(`${url}/${path}`, {
    method: 'POST',
    headers: { ...headers, ...(capability ? { 'x-agent-workspace-window-capability': capability } : {}) },
    body: JSON.stringify(body)
  })

  expect((await post('list', { limit: 100 })).status).toBe(403)
  const capability = bindings.issueForTrustedOwner(windowId)
  const listed = await post('list', { limit: 100 }, capability)
  expect(listed.status).toBe(200)
  expect(await listed.json()).toMatchObject({ records: [{ authorizedDescriptorId: descriptorId }], nextCursor: null })
  expect(listSidebar).toHaveBeenCalledWith({ limit: 100 }, expect.objectContaining({ windowId }))

  const request = {
    recentlyClosedId: closedItemId,
    authorizedDescriptorId: descriptorId,
    action: 'reopenTerminal',
    expectedRevision: 7,
    idempotencyEpoch: epoch,
    target: { windowId, workspaceId, paneId, destinationIndex: 0, expectedWindowRevision: 2 },
    mutation: { idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64), expectedRevision: 7 }
  }
  expect((await post('reopen', request)).status).toBe(403)
  expect((await post('reopen', { ...request, target: { ...request.target, windowId: otherWindowId } }, capability)).status).toBe(403)
  expect((await post('reopen', { ...request, mutation: { ...request.mutation, expectedRevision: 6 } }, capability)).status).toBe(409)
  expect(reopenFromSidebar).not.toHaveBeenCalled()
  const reopened = await post('reopen', request, capability)
  expect(reopened.status).toBe(200)
  expect(reopenFromSidebar).toHaveBeenCalledWith(expect.objectContaining({
    closedItemId,
    authorizedDescriptorId: descriptorId,
    idempotencyKey: request.mutation.idempotencyKey,
    target: request.target
  }), expect.objectContaining({ windowId }))

  bindings.revoke(capability)
  expect((await post('list', { limit: 100 }, capability)).status).toBe(403)
  expect((await post('reopen', request, capability)).status).toBe(403)
})
