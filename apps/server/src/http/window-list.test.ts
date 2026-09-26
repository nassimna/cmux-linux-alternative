import { randomUUID } from 'node:crypto'

import type { DurableApplicationState } from '@agent-workspace/contracts'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { expect, it } from 'vitest'

import { TerminalService } from '../terminal/terminal-service'
import { createApp } from './app'
import { WindowBindingRegistry } from './window-binding-registry'

it('projects Rust-compatible topology and resolves only the current private window owner', async () => {
  const epoch = randomUUID()
  const first = randomUUID()
  const second = randomUUID()
  const firstWorkspace = randomUUID()
  const secondWorkspace = randomUUID()
  const firstPane = randomUUID()
  const secondPane = randomUUID()
  const state = {
    revision: 9,
    focusedWindowId: second,
    windowPlacements: [
      {
        id: first,
        label: 'First',
        workspaceIds: [firstWorkspace],
        focusedWorkspaceId: firstWorkspace,
        hostingState: 'hosted',
        revision: 3
      },
      {
        id: second,
        label: 'Second',
        workspaceIds: [secondWorkspace],
        focusedWorkspaceId: secondWorkspace,
        hostingState: 'unhosted',
        revision: 4
      }
    ],
    workspaces: [
      {
        id: firstWorkspace,
        selectedPaneId: firstPane,
        panes: { [firstPane]: { id: firstPane, tabs: [randomUUID(), randomUUID()] } }
      },
      {
        id: secondWorkspace,
        selectedPaneId: secondPane,
        panes: { [secondPane]: { id: secondPane, tabs: [randomUUID()] } }
      }
    ]
  } as unknown as DurableApplicationState
  let geometry:
    | {
        revision: number
        x: number
        y: number
        width: number
        height: number
        maximized: boolean
        fullscreen: boolean
      }
    | undefined
  const store = {
    readSnapshot: () => state,
    currentIdempotencyEpoch: () => epoch,
    getWindowStateFor: (windowId: string) => ({
      windowId,
      ...(geometry ? { state: geometry } : {})
    }),
    updateWindowStateFor: (windowId: string, next: typeof geometry) => {
      geometry = next
      return { windowId, state: geometry }
    },
    focusWindow: (request: { window: { windowId: string } }) => ({
      revision: 10,
      idempotencyEpoch: epoch,
      window: {
        windowId: request.window.windowId,
        label: 'Second',
        workspaceIds: [secondWorkspace],
        focusedWorkspaceId: secondWorkspace,
        hostingState: 'unhosted',
        revision: 4,
        defaultTabDestination: {
          workspaceId: secondWorkspace,
          paneId: secondPane,
          destinationIndex: 1
        }
      },
      replayed: false
    })
  } as unknown as ApplicationStateStore
  const bindings = new WindowBindingRegistry(store)
  const service = new TerminalService({
    spawn: () => Promise.reject(new Error('No terminal expected'))
  })
  const app = createApp(
    service,
    'window-list-test-token-0123456789-abcdef',
    undefined,
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    bindings
  )
  const bearer = { authorization: 'Bearer window-list-test-token-0123456789-abcdef' }

  const list = await app.request('/v1/windows', { headers: bearer })
  expect(list.status).toBe(200)
  expect(await list.json()).toEqual({
    revision: 9,
    idempotencyEpoch: epoch,
    focusedWindowId: second,
    windows: [
      {
        windowId: first,
        label: 'First',
        workspaceIds: [firstWorkspace],
        focusedWorkspaceId: firstWorkspace,
        hostingState: 'hosted',
        revision: 3,
        defaultTabDestination: {
          workspaceId: firstWorkspace,
          paneId: firstPane,
          destinationIndex: 2
        }
      },
      {
        windowId: second,
        label: 'Second',
        workspaceIds: [secondWorkspace],
        focusedWorkspaceId: secondWorkspace,
        hostingState: 'unhosted',
        revision: 4,
        defaultTabDestination: {
          workspaceId: secondWorkspace,
          paneId: secondPane,
          destinationIndex: 1
        }
      }
    ]
  })
  expect((await app.request('/v1/windows/bound', { headers: bearer })).status).toBe(403)
  expect((await app.request('/v1/workspaces/bound', { headers: bearer })).status).toBe(403)
  expect((await app.request('/v1/organization/bound', { headers: bearer })).status).toBe(403)
  const capability = bindings.issueForTrustedOwner(first)
  const bound = await app.request('/v1/windows/bound', {
    headers: { ...bearer, 'x-agent-workspace-window-capability': capability }
  })
  expect(bound.status).toBe(200)
  expect(((await bound.json()) as { window: { windowId: string } }).window.windowId).toBe(first)
  const stateHeaders = {
    ...bearer,
    'content-type': 'application/json',
    'x-agent-workspace-window-capability': capability
  }
  const getState = (windowId: string, headers: Record<string, string> = stateHeaders) =>
    app.request('/v1/windows/state/get', {
      method: 'POST',
      headers,
      body: JSON.stringify({ windowId })
    })
  expect((await getState(first, bearer)).status).toBe(403)
  expect((await getState(second)).status).toBe(403)
  expect(await (await getState(first)).json()).toEqual({ windowId: first })
  const nextGeometry = {
    revision: 1,
    x: -20,
    y: 30,
    width: 1200,
    height: 800,
    maximized: false,
    fullscreen: false
  }
  expect(
    (
      await app.request('/v1/windows/state/update', {
        method: 'POST',
        headers: stateHeaders,
        body: JSON.stringify({ windowId: second, state: nextGeometry })
      })
    ).status
  ).toBe(403)
  expect(
    (
      await app.request('/v1/windows/state/update', {
        method: 'POST',
        headers: stateHeaders,
        body: JSON.stringify({ windowId: first, state: { ...nextGeometry, width: 199 } })
      })
    ).status
  ).toBe(400)
  expect(
    await (
      await app.request('/v1/windows/state/update', {
        method: 'POST',
        headers: stateHeaders,
        body: JSON.stringify({ windowId: first, state: nextGeometry })
      })
    ).json()
  ).toEqual({ windowId: first, state: nextGeometry })
  expect(await (await getState(first)).json()).toEqual({ windowId: first, state: nextGeometry })
  const mutation = {
    mutation: { expectedRevision: 9, idempotencyEpoch: epoch, idempotencyKey: randomUUID() },
    window: { windowId: second, expectedRevision: 4 }
  }
  expect(
    (
      await app.request('/v1/windows/focus', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify(mutation)
      })
    ).status
  ).toBe(403)
  expect(
    (
      await app.request('/v1/windows/focus', {
        method: 'POST',
        headers: {
          ...bearer,
          'content-type': 'application/json',
          'x-agent-workspace-window-capability': capability
        },
        body: JSON.stringify(mutation)
      })
    ).status
  ).toBe(200)
  bindings.revokeWindow(first)
  expect(
    (
      await app.request('/v1/windows/bound', {
        headers: { ...bearer, 'x-agent-workspace-window-capability': capability }
      })
    ).status
  ).toBe(403)
  bindings.dispose()
})
