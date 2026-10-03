import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import projection from '../../../../packages/protocol-client/fixtures/milestone2-projection.json'

import { ControlClient, decodeControlFrames } from './control-client'

describe('decodeControlFrames', () => {
  it('accepts multiple valid frames whose aggregate callback exceeds one MiB', () => {
    const frame = 'x'.repeat(600 * 1024)

    const decoded = decodeControlFrames(`${frame}\n${frame}\n`)

    expect(decoded.frames).toHaveLength(2)
    expect(decoded.remainder).toBe('')
  })

  it('rejects one unfinished frame above the protocol limit', () => {
    expect(() => decodeControlFrames('x'.repeat(1024 * 1024 + 1))).toThrow(/oversized/)
  })
})

describe.skipIf(process.platform === 'win32')('ControlClient lifecycle and revisions', () => {
  it('renegotiates projected capabilities after binding a child connection', async () => {
    const commands: string[] = []
    let bound = false
    const windowId = '10000000-0000-4000-8000-000000000010'
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const paneId = '10000000-0000-4000-8000-000000000002'
    const fixture = await createFixtureServer((request, socket) => {
      commands.push(request.command)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              application: 'agent-workspace',
              version: '0.1.0',
              protocolVersion: 1,
              capabilities: bound ? ['multi-window-v1'] : ['multi-window-v1', 'saved-layouts-v1']
            }
          })}\n`
        )
      } else if (request.command === 'window.bind') {
        bound = true
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              window: {
                windowId,
                label: 'Secondary',
                workspaceIds: [workspaceId],
                focusedWorkspaceId: workspaceId,
                hostingState: 'hosted',
                defaultTabDestination: { workspaceId, paneId, destinationIndex: 0 },
                revision: 1
              }
            }
          })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.identify()).resolves.toMatchObject({
        capabilities: ['multi-window-v1', 'saved-layouts-v1']
      })
      await client.bindWindow({
        identity: {
          providerId: '20000000-0000-4000-8000-000000000001',
          providerEpoch: 1,
          leaseId: '20000000-0000-4000-8000-000000000002'
        },
        window: { windowId, generation: 3 }
      })
      await expect(client.identify()).resolves.toMatchObject({
        capabilities: ['multi-window-v1']
      })
      expect(commands).toEqual(['system.identify', 'window.bind', 'system.identify'])
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('independently rejects workspace organization calls before an older service sees them', async () => {
    const commands: string[] = []
    const fixture = await createFixtureServer((request, socket) => {
      commands.push(request.command)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              application: 'agent-workspace',
              version: '0.1.0',
              protocolVersion: 1,
              capabilities: ['saved-layouts-v1']
            }
          })}\n`
        )
      } else if (request.command === 'layout.list') {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            revision: 0,
            result: { revision: 0, layouts: [] }
          })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await client.identify()
      const organizationOperations = [
        () => client.getWorkspaceOrganization(),
        () => client.selectWorkspaces({} as never),
        () => client.pinWorkspace({} as never),
        () => client.closeSelectedWorkspaces({} as never),
        () => client.reorderWorkspace({} as never),
        () => client.createGroup({} as never),
        () => client.renameGroup({} as never),
        () => client.deleteGroup({} as never),
        () => client.moveGroup({} as never),
        () => client.assignWorkspaceGroup({} as never),
        () => client.collapseGroup({} as never)
      ]
      for (const operation of organizationOperations) {
        await expect(operation()).rejects.toMatchObject({
          name: 'UnsupportedServiceCapabilityError',
          capability: 'workspace-groups-v1'
        })
      }
      await expect(client.listSavedLayouts()).resolves.toEqual({ revision: 0, layouts: [] })
      expect(commands).toEqual(['system.identify', 'layout.list'])
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('independently rejects saved-layout calls before an older service sees them', async () => {
    const commands: string[] = []
    const fixture = await createFixtureServer((request, socket) => {
      commands.push(request.command)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              application: 'agent-workspace',
              version: '0.1.0',
              protocolVersion: 1,
              capabilities: ['workspace-groups-v1']
            }
          })}\n`
        )
      } else if (request.command === 'workspace.organization.get') {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            revision: 0,
            result: {
              organization: {
                revision: 0,
                selection: ['10000000-0000-4000-8000-000000000001'],
                focusedWorkspaceId: '10000000-0000-4000-8000-000000000001',
                pins: [],
                groups: [],
                assignments: []
              }
            }
          })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      const layoutOperations = [
        () => client.listSavedLayouts(),
        () => client.getSavedLayout({} as never),
        () => client.saveLayout({} as never),
        () => client.deleteLayout({} as never),
        () => client.applyLayout({} as never),
        () => client.exportLayout({} as never),
        () => client.importLayout({} as never)
      ]
      for (const operation of layoutOperations) {
        await expect(operation()).rejects.toMatchObject({
          name: 'UnsupportedServiceCapabilityError',
          capability: 'saved-layouts-v1'
        })
      }
      await expect(client.getWorkspaceOrganization()).resolves.toMatchObject({
        organization: { revision: 0 }
      })
      expect(commands).toEqual(['system.identify', 'workspace.organization.get'])
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('rejects desktop-action reverse calls before an older service sees them', async () => {
    const commands: string[] = []
    const fixture = await createFixtureServer((request, socket) => {
      commands.push(request.command)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['multi-window-v1'] } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      const actionOperations = [
        () => client.pollDesktopAction({} as never),
        () => client.claimDesktopActionStart({} as never),
        () => client.acknowledgeDesktopAction({} as never),
        () => client.pollProjectActionConfirmation({} as never),
        () => client.respondProjectActionConfirmation({} as never)
      ]
      for (const operation of actionOperations) {
        await expect(operation()).rejects.toMatchObject({
          name: 'UnsupportedServiceCapabilityError',
          capability: 'actions-v1'
        })
      }
      expect(commands).toEqual(['system.identify'])
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('routes service shutdown separately from revisioned domain events', async () => {
    const fixture = await createFixtureServer(() => undefined)
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      let domainEvents = 0
      client.onDomainEvent(() => {
        domainEvents += 1
      })
      const shutdown = new Promise<string>((resolve) => {
        client.onServiceEvent((event) => resolve(event.data.reason))
      })

      fixture.latestSocket()?.write(
        `${JSON.stringify({
          event: 'service.shuttingDown',
          data: { reason: 'test shutdown' }
        })}\n`
      )

      await expect(shutdown).resolves.toBe('test shutdown')
      expect(domainEvents).toBe(0)
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('validates window topology and routes ownership events separately', async () => {
    const windowId = '10000000-0000-4000-8000-000000000010'
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const paneId = '10000000-0000-4000-8000-000000000002'
    const epoch = '10000000-0000-4000-8000-000000000020'
    let identifyRequests = 0
    const fixture = await createFixtureServer((request, socket) => {
      if (request.command === 'system.identify') {
        identifyRequests += 1
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['multi-window-v1'] } })}\n`
        )
      } else if (request.command === 'window.list') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { revision: 2, idempotencyEpoch: epoch, focusedWindowId: windowId, windows: [{ windowId, label: 'Main', workspaceIds: [workspaceId], focusedWorkspaceId: workspaceId, hostingState: 'hosted', defaultTabDestination: { workspaceId, paneId, destinationIndex: 1 }, revision: 1 }] } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.listWindows()).resolves.toMatchObject({
        revision: 2,
        focusedWindowId: windowId
      })
      let domainEvents = 0
      client.onDomainEvent(() => {
        domainEvents += 1
      })
      const topology = new Promise<string>((resolve) => {
        client.onMultiWindowEvent((event) => resolve(event.event))
      })
      fixture
        .latestSocket()
        ?.write(
          `${JSON.stringify({ event: 'window.topologyChanged', revision: 3, data: { event: 'window.topologyChanged', revision: 3, idempotencyEpoch: epoch, windowIds: [windowId], reason: 'windowFocused' } })}\n`
        )
      await expect(topology).resolves.toBe('window.topologyChanged')
      expect(domainEvents).toBe(0)
      await client.identify()
      expect(identifyRequests).toBe(2)
      const ownership = new Promise<string>((resolve) => {
        client.onMultiWindowEvent((event) => resolve(event.event))
      })
      const placement = {
        windowId,
        workspaceId,
        paneId,
        index: 0,
        windowRevision: 2
      }
      fixture.latestSocket()?.write(
        `${JSON.stringify({
          event: 'tab.ownershipTransferred',
          revision: 4,
          data: {
            event: 'tab.ownershipTransferred',
            revision: 4,
            transferEpoch: 1,
            tabId: '30000000-0000-4000-8000-000000000001',
            runtimeSessionId: '40000000-0000-4000-8000-000000000001',
            ownershipKind: 'terminal',
            source: placement,
            target: {
              ...placement,
              windowId: '10000000-0000-4000-8000-000000000011',
              windowRevision: 1
            },
            reason: 'tabMoved'
          }
        })}\n`
      )
      await expect(ownership).resolves.toBe('tab.ownershipTransferred')
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('closes the connection when a recognized multi-window event is malformed', async () => {
    let pendingRequest = false
    const fixture = await createFixtureServer((request) => {
      if (request.command === 'system.identify') pendingRequest = true
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      const identify = client.identify()
      await vi.waitFor(() => expect(pendingRequest).toBe(true))

      fixture.latestSocket()?.write(
        `${JSON.stringify({
          event: 'window.topologyChanged',
          revision: 3,
          data: { event: 'window.topologyChanged' }
        })}\n`
      )

      await expect(identify).rejects.toThrow('invalid multi-window event')
      await expect(client.identify()).rejects.toThrow('not connected')
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('preserves domain revisions and requests refresh when an event revision has a gap', async () => {
    const fixture = await createFixtureServer((request, socket) => {
      if (request.command === 'workspace.list') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, revision: 42, result: { snapshot: projection } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await client.listWorkspaces()
      const eventPromise = new Promise<number>((resolve) => {
        client.onDomainEvent((event) => resolve(event.revision))
      })
      const resyncPromise = new Promise<{ expectedRevision: number; receivedRevision: number }>(
        (resolve) => client.onDomainResyncRequired(resolve)
      )
      fixture.latestSocket()?.write(
        `${JSON.stringify({
          event: 'workspace.changed',
          revision: 44,
          data: {
            revision: 44,
            workspaceIds: [],
            paneIds: [],
            tabIds: [],
            commandIds: [],
            reason: 'test gap'
          }
        })}\n`
      )

      await expect(eventPromise).resolves.toBe(44)
      await expect(resyncPromise).resolves.toEqual({ expectedRevision: 43, receivedRevision: 44 })
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('requests strict terminal runtime metadata without exposing a process id', async () => {
    const terminalId = '50000000-0000-4000-8000-000000000001'
    let receivedParams: unknown
    const fixture = await createFixtureServer((request, socket) => {
      if (request.command !== 'terminal.runtimeMetadata') return
      receivedParams = request.params
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: { terminalId, listeningPorts: [3000, 5173] }
        })}\n`
      )
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.getTerminalRuntimeMetadata(terminalId)).resolves.toEqual({
        terminalId,
        listeningPorts: [3000, 5173]
      })
      expect(receivedParams).toEqual({ terminalId })
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('fetches and invalidates only the targeted independent card-slot projection', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const requests: FixtureRequest[] = []
    const fixture = await createFixtureServer((request, socket) => {
      requests.push(request)
      if (request.command !== 'workspace.cardSlots.get') return
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            workspaceId,
            revision: 3,
            agentStatus: { status: 'waiting', label: 'Needs input' },
            progress: { mode: 'indeterminate', label: 'Waiting' }
          }
        })}\n`
      )
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.getWorkspaceCardSlots({ workspaceId })).resolves.toMatchObject({
        workspaceId,
        revision: 3
      })
      const event = new Promise<number>((resolve) => {
        client.onWorkspaceCardSlotsEvent((message) => resolve(message.data.slotRevision))
      })
      fixture.latestSocket()?.write(
        `${JSON.stringify({
          event: 'workspace.cardSlotsChanged',
          data: { workspaceId, slotRevision: 4, reason: 'slotsReplaced' }
        })}\n`
      )
      await expect(event).resolves.toBe(4)
      expect(requests).toHaveLength(1)
      expect(typeof requests[0]?.id).toBe('string')
      expect(requests[0]?.command).toBe('workspace.cardSlots.get')
      expect(requests[0]?.params).toEqual({ workspaceId })
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('preserves the protocol code for an optimistic card-slot revision conflict', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const fixture = await createFixtureServer((request, socket) => {
      if (request.command !== 'workspace.cardSlots.replace') return
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: {
            code: 'revision_conflict',
            message: 'The card slots changed before this replacement',
            details: null
          }
        })}\n`
      )
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(
        client.replaceWorkspaceCardSlots({
          workspaceId,
          expectedRevision: 0,
          agentStatus: { status: 'running', label: null },
          progress: null
        })
      ).rejects.toMatchObject({ code: 'revision_conflict' })
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('sends notification list parameters and validates the revisioned result', async () => {
    let receivedParams: unknown
    const fixture = await createFixtureServer((request, socket) => {
      if (request.command !== 'notification.list') return
      receivedParams = request.params
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          revision: 12,
          result: { revision: 12, notifications: [], total: 0, unreadCount: 0 }
        })}\n`
      )
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.listNotifications({ unreadOnly: true, limit: 25 })).resolves.toEqual({
        revision: 12,
        notifications: [],
        total: 0,
        unreadCount: 0
      })
      expect(receivedParams).toEqual({ unreadOnly: true, limit: 25 })
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('validates milestone 5 configuration and window-state commands independently', async () => {
    const requests: FixtureRequest[] = []
    const fixture = await createFixtureServer((request, socket) => {
      requests.push(request)
      if (request.command === 'configuration.get') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, revision: 4, result: { config: configuration } })}\n`
        )
      } else if (request.command === 'configuration.update') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, revision: 5, result: { config: { ...configuration, revision: 5, updates: { channel: 'beta' } } } })}\n`
        )
      } else if (request.command === 'window.getState') {
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`)
      } else if (request.command === 'window.updateState') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, revision: 1, result: { state: windowState } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.getConfiguration()).resolves.toMatchObject({
        config: { revision: 4 }
      })
      await expect(
        client.updateConfiguration({
          expectedRevision: 4,
          update: { updates: { channel: 'beta' } }
        })
      ).resolves.toMatchObject({ config: { revision: 5, updates: { channel: 'beta' } } })
      await expect(client.getWindowState()).resolves.toEqual({})
      await expect(client.updateWindowState({ state: windowState })).resolves.toEqual({
        state: windowState
      })
      expect(requests.map(({ command }) => command)).toEqual([
        'configuration.get',
        'configuration.update',
        'window.getState',
        'window.updateState'
      ])
      expect(requests[1]?.params).toEqual({
        expectedRevision: 4,
        update: { updates: { channel: 'beta' } }
      })
      expect(requests[3]?.params).toEqual({ state: windowState })
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('routes strict desktop-action polling, start claims, and acknowledgements', async () => {
    const requests: FixtureRequest[] = []
    const identity = {
      providerId: '20000000-0000-4000-8000-000000000001',
      providerEpoch: 3,
      leaseId: '20000000-0000-4000-8000-000000000002'
    }
    const invocationId = '20000000-0000-4000-8000-000000000003'
    const correlationId = '20000000-0000-4000-8000-000000000004'
    const target = {
      windowId: '20000000-0000-4000-8000-000000000005',
      windowGeneration: 6
    }
    const fixture = await createFixtureServer((request, socket) => {
      requests.push(request)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['actions-v1'] } })}\n`
        )
      } else if (request.command === 'desktopAction.poll') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { request: { identity, invocationId, correlationId, attemptEpoch: 1, actionId: 'desktop.window.focus', actionVersion: 1, target, parameters: {}, expiresAtMs: 2_000 } } })}\n`
        )
      } else if (request.command === 'desktopAction.startClaim') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { invocationId, correlationId, attemptEpoch: 1, decision: 'granted', grantedAtMs: 1_000 } })}\n`
        )
      } else if (request.command === 'desktopAction.acknowledge') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { invocation: { invocationId, correlationId, state: 'acknowledged', terminalCode: 'succeeded', result: {}, updatedAtMs: 1_001 } } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.pollDesktopAction({ identity, timeoutMs: 1_000 })).resolves.toMatchObject(
        {
          request: { invocationId, correlationId }
        }
      )
      await expect(
        client.claimDesktopActionStart({
          identity,
          invocationId,
          correlationId,
          attemptEpoch: 1,
          actionId: 'desktop.window.focus',
          actionVersion: 1,
          target
        })
      ).resolves.toMatchObject({ decision: 'granted' })
      await expect(
        client.acknowledgeDesktopAction({
          identity,
          invocationId,
          correlationId,
          attemptEpoch: 1,
          actionId: 'desktop.window.focus',
          actionVersion: 1,
          target,
          status: 'succeeded',
          result: {}
        })
      ).resolves.toMatchObject({ invocation: { state: 'acknowledged' } })

      expect(requests.map(({ command }) => command)).toEqual([
        'system.identify',
        'desktopAction.poll',
        'desktopAction.startClaim',
        'desktopAction.acknowledge'
      ])
      expect(requests.slice(1).map(({ params }) => params)).toEqual([
        { identity, timeoutMs: 1_000 },
        {
          identity,
          invocationId,
          correlationId,
          attemptEpoch: 1,
          actionId: 'desktop.window.focus',
          actionVersion: 1,
          target
        },
        {
          identity,
          invocationId,
          correlationId,
          attemptEpoch: 1,
          actionId: 'desktop.window.focus',
          actionVersion: 1,
          target,
          status: 'succeeded',
          result: {}
        }
      ])
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('routes and strictly validates project-action confirmation polling and responses', async () => {
    const requests: FixtureRequest[] = []
    let malformedPollResult = false
    const identity = {
      providerId: '20000000-0000-4000-8000-000000000001',
      providerEpoch: 3,
      leaseId: '20000000-0000-4000-8000-000000000002'
    }
    const invocationId = '20000000-0000-4000-8000-000000000003'
    const nonce = '20000000-0000-4000-8000-000000000004'
    const target = {
      windowId: '20000000-0000-4000-8000-000000000005',
      windowGeneration: 6
    }
    const challenge = 'a'.repeat(64)
    const confirmationDefinitionSha256 = 'b'.repeat(64)
    const fixture = await createFixtureServer((request, socket) => {
      requests.push(request)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['actions-v1'] } })}\n`
        )
      } else if (request.command === 'projectAction.confirmationPoll') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { challenge: { identity, invocationId, nonce, challenge, target, confirmationDefinitionSha256, actionId: 'project.build', displayTitle: 'Build project', executableClass: 'approvedName', argumentCount: 2, projectLabel: 'Example project', expiresAtMs: 2_000 }, ...(malformedPollResult ? { unexpected: true } : {}) } })}\n`
        )
      } else if (request.command === 'projectAction.confirmationRespond') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { invocationId, decision: 'confirmed', acceptedAtMs: 1_001 } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(
        client.pollProjectActionConfirmation({ identity, timeoutMs: 1_000 })
      ).resolves.toMatchObject({ challenge: { invocationId, nonce } })
      await expect(
        client.respondProjectActionConfirmation({
          identity,
          invocationId,
          nonce,
          challenge,
          target,
          confirmationDefinitionSha256,
          decision: 'confirmed'
        })
      ).resolves.toEqual({ invocationId, decision: 'confirmed', acceptedAtMs: 1_001 })

      expect(requests.map(({ command }) => command)).toEqual([
        'system.identify',
        'projectAction.confirmationPoll',
        'projectAction.confirmationRespond'
      ])
      expect(requests[2]?.params).toEqual({
        identity,
        invocationId,
        nonce,
        challenge,
        target,
        confirmationDefinitionSha256,
        decision: 'confirmed'
      })
      await expect(
        client.respondProjectActionConfirmation({
          identity,
          invocationId,
          nonce,
          challenge: challenge.toUpperCase(),
          target,
          confirmationDefinitionSha256,
          decision: 'confirmed'
        })
      ).rejects.toThrow()
      expect(requests).toHaveLength(3)

      malformedPollResult = true
      await expect(
        client.pollProjectActionConfirmation({ identity, timeoutMs: 1_000 })
      ).rejects.toThrow()
      expect(requests).toHaveLength(4)
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('discovers every action page and preserves one registry identity', async () => {
    const requests: FixtureRequest[] = []
    const epoch = '20000000-0000-4000-8000-000000000010'
    const definition = (actionId: string) => ({
      actionId,
      actionVersion: 1,
      localizedTitleKey: `actions.${actionId.replaceAll('.', '_')}`,
      category: 'workspace',
      owner: 'service',
      parameterSchemaVersion: 1,
      resultSchemaVersion: 1,
      authorizationClass: 'owner',
      interactionClass: 'headless',
      limits: { maxParameterBytes: 1024, maxResultBytes: 1024, timeoutMs: 30_000 }
    })
    const fixture = await createFixtureServer((request, socket) => {
      requests.push(request)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['actions-v1'] } })}\n`
        )
      } else if (request.command === 'action.list') {
        const secondPage = (request.params as { cursor?: string }).cursor === 'next-page'
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { registryRevision: 7, idempotencyEpoch: epoch, definitions: [definition(secondPage ? 'workspace.close' : 'workspace.create')], ...(secondPage ? {} : { nextCursor: 'next-page' }) } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.listAllActions()).resolves.toMatchObject({
        registryRevision: 7,
        idempotencyEpoch: epoch,
        definitions: [{ actionId: 'workspace.create' }, { actionId: 'workspace.close' }]
      })
      expect(requests.map(({ command }) => command)).toEqual([
        'system.identify',
        'action.list',
        'action.list'
      ])
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('rejects cyclic cursors and registries larger than the global bound', async () => {
    const epoch = '20000000-0000-4000-8000-000000000010'
    const definition = (index: number) => ({
      actionId: `workspace.action${index}`,
      actionVersion: 1,
      localizedTitleKey: `actions.workspace_action_${index}`,
      category: 'workspace',
      owner: 'service',
      parameterSchemaVersion: 1,
      resultSchemaVersion: 1,
      authorizationClass: 'owner',
      interactionClass: 'headless',
      limits: { maxParameterBytes: 1024, maxResultBytes: 1024, timeoutMs: 30_000 }
    })
    let mode: 'cycle' | 'oversized' = 'cycle'
    let cyclePage = 0
    const fixture = await createFixtureServer((request, socket) => {
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['actions-v1'] } })}\n`
        )
      } else if (request.command === 'action.list') {
        if (mode === 'cycle') {
          socket.write(
            `${JSON.stringify({ id: request.id, ok: true, result: { registryRevision: 7, idempotencyEpoch: epoch, definitions: [definition(cyclePage)], nextCursor: 'cycle' } })}\n`
          )
          cyclePage += 1
          return
        }
        const rawCursor = (request.params as { cursor?: string }).cursor
        const page = rawCursor === undefined ? 0 : Number(rawCursor.slice(1))
        const start = page * 64
        const count = page === 4 ? 1 : 64
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { registryRevision: 7, idempotencyEpoch: epoch, definitions: Array.from({ length: count }, (_, offset) => definition(start + offset)), ...(page < 4 ? { nextCursor: `p${page + 1}` } : {}) } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.listAllActions()).rejects.toThrow(/pagination cursor/u)
      mode = 'oversized'
      await expect(client.listAllActions()).rejects.toThrow(/256-definition/u)
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('keeps one caller socket alive through pending, terminal event, and exact replay', async () => {
    const invocationId = '20000000-0000-4000-8000-000000000020'
    const correlationId = '20000000-0000-4000-8000-000000000021'
    const epoch = '20000000-0000-4000-8000-000000000022'
    const key = '20000000-0000-4000-8000-000000000023'
    const requests: FixtureRequest[] = []
    let invokes = 0
    const fixture = await createFixtureServer((request, socket) => {
      requests.push(request)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['actions-v1'] } })}\n`
        )
      } else if (request.command === 'action.invoke') {
        invokes += 1
        const terminal = invokes === 2
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { invocation: terminal ? { invocationId, correlationId, state: 'acknowledged', terminalCode: 'succeeded', result: {}, updatedAtMs: 102 } : { invocationId, correlationId, state: 'dispatched', updatedAtMs: 100 } } })}\n`
        )
        if (!terminal) {
          queueMicrotask(() =>
            socket.write(
              `${JSON.stringify({ event: 'action.invocationChanged', data: { event: 'action.invocationChanged', invocationId, correlationId, state: 'acknowledged', updatedAtMs: 102 } })}\n`
            )
          )
        }
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    const params = {
      actionId: 'workspace.create',
      actionVersion: 1,
      parameters: {},
      idempotency: { epoch, key },
      correlationId
    }
    try {
      await client.connect()
      await expect(client.invokeAction(params)).resolves.toMatchObject({
        invocationId,
        state: 'acknowledged',
        result: {}
      })
      expect(requests.filter(({ command }) => command === 'action.invoke')).toHaveLength(2)
      expect(requests.at(-1)?.params).toEqual(params)
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('replays the exact main-owned request when the initial response is lost', async () => {
    const invocationId = '20000000-0000-4000-8000-000000000030'
    const correlationId = '20000000-0000-4000-8000-000000000031'
    const epoch = '20000000-0000-4000-8000-000000000032'
    const key = '20000000-0000-4000-8000-000000000033'
    const requests: FixtureRequest[] = []
    let invokes = 0
    const fixture = await createFixtureServer((request, socket) => {
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['actions-v1'] } })}\n`
        )
      } else if (request.command === 'action.invoke') {
        requests.push(request)
        invokes += 1
        if (invokes === 1) return
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { invocation: { invocationId, correlationId, state: 'acknowledged', terminalCode: 'succeeded', result: {}, updatedAtMs: 102 } } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    const params = {
      actionId: 'workspace.create',
      actionVersion: 1,
      parameters: {},
      idempotency: { epoch, key },
      correlationId
    }
    try {
      await client.connect()
      await expect(client.invokeAction(params)).resolves.toMatchObject({
        invocationId,
        state: 'acknowledged'
      })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.params).toEqual(params)
      expect(requests[1]?.params).toEqual(params)
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('cancels the exact durable invocation after renderer caller loss', async () => {
    const invocationId = '20000000-0000-4000-8000-000000000040'
    const correlationId = '20000000-0000-4000-8000-000000000041'
    const epoch = '20000000-0000-4000-8000-000000000042'
    const key = '20000000-0000-4000-8000-000000000043'
    const requests: FixtureRequest[] = []
    const fixture = await createFixtureServer((request, socket) => {
      requests.push(request)
      if (request.command === 'system.identify') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { application: 'agent-workspace', version: '0.1.0', protocolVersion: 1, capabilities: ['actions-v1'] } })}\n`
        )
      } else if (request.command === 'action.invoke') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { invocation: { invocationId, correlationId, state: 'dispatched', updatedAtMs: 100 } } })}\n`
        )
      } else if (request.command === 'action.cancel') {
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { invocation: { invocationId, correlationId, state: 'canceled', terminalCode: 'canceled', updatedAtMs: 101 } } })}\n`
        )
      }
    })
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    const abortController = new AbortController()
    try {
      await client.connect()
      setTimeout(() => abortController.abort(), 10)
      await expect(
        client.invokeAction(
          {
            actionId: 'workspace.create',
            actionVersion: 1,
            parameters: {},
            idempotency: { epoch, key },
            correlationId
          },
          { signal: abortController.signal }
        )
      ).resolves.toMatchObject({ invocationId, state: 'canceled' })
      expect(requests.find(({ command }) => command === 'action.cancel')?.params).toEqual({
        invocationId,
        correlationId
      })
    } finally {
      client.close()
      await fixture.close()
    }
  })

  it('rejects pending requests on disconnect and can reconnect', async () => {
    let connection = 0
    const fixture = await createFixtureServer(
      (request, socket) => {
        if (connection === 1) {
          socket.destroy()
          return
        }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              application: 'agent-workspace',
              version: '0.1.0',
              protocolVersion: 1,
              capabilities: []
            }
          })}\n`
        )
      },
      () => {
        connection += 1
      }
    )
    const client = new ControlClient(fixture.endpoint, '0123456789abcdef0123456789abcdef')
    try {
      await client.connect()
      await expect(client.identify()).rejects.toThrow(/disconnected/)
      await client.connect()
      await expect(client.identify()).resolves.toMatchObject({ application: 'agent-workspace' })
    } finally {
      client.close()
      await fixture.close()
    }
  })
})

interface FixtureRequest {
  id: string
  command: string
  params?: unknown
}

const configuration = {
  schemaVersion: 1,
  revision: 4,
  appearance: { theme: 'system', density: 'comfortable', fontFamily: 'system-ui' },
  terminal: {
    shellPath: '/bin/sh',
    fontFamily: 'monospace',
    fontSize: 13,
    scrollback: 10_000,
    multilinePasteProtection: true
  },
  browser: { profileName: 'Default', partition: 'default', privacy: 'standard' },
  notifications: { systemEnabled: true, includeBody: false },
  keyboardShortcuts: { overrides: {} },
  agentIntegration: { enabled: true, notificationsEnabled: true, browserEnabled: true },
  updates: { channel: 'stable' },
  logging: { level: 'info' }
} as const

const windowState = {
  revision: 1,
  x: 10,
  y: 20,
  width: 1200,
  height: 800,
  maximized: false,
  fullscreen: false,
  displayId: 'display-1'
}

async function createFixtureServer(
  onRequest: (request: FixtureRequest, socket: Socket) => void,
  onConnection: () => void = () => undefined
): Promise<{ endpoint: string; latestSocket(): Socket | undefined; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'control-client-test-'))
  const endpoint = join(directory, 'control.sock')
  let activeSocket: Socket | undefined
  const server = createServer((socket) => {
    activeSocket = socket
    onConnection()
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const frame = JSON.parse(line) as { auth?: unknown; id?: string; command?: string }
        if (frame.id && frame.command) onRequest(frame as FixtureRequest, socket)
        newline = buffer.indexOf('\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  return {
    endpoint,
    latestSocket: () => activeSocket,
    close: async () => {
      activeSocket?.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { force: true, recursive: true })
    }
  }
}
