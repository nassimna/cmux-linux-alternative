import { describe, expect, it, vi } from 'vitest'

import {
  desktopProviderHeartbeatParamsSchema,
  desktopProviderRegisterParamsSchema
} from '@agent-workspace/protocol-client'

import { DesktopProviderClaims, type DesktopProviderWindowClaim } from './desktop-provider-claims'
import { ProviderPollingGate } from './provider-polling-gate'

const WINDOW_A = '70000000-0000-4000-8000-000000000001'
const WINDOW_B = '70000000-0000-4000-8000-000000000002'
const PROVIDER_ID = '71000000-0000-4000-8000-000000000001'
const LEASE_ID = '72000000-0000-4000-8000-000000000001'
const INSTANCE_ID = '73000000-0000-4000-8000-000000000001'

describe('DesktopProviderClaims', () => {
  it('sends both persisted claims and holds polling through sequential native restore', async () => {
    const claims = new DesktopProviderClaims()
    const pollingGate = new ProviderPollingGate()
    const startPolling = vi.fn()
    const planned: readonly DesktopProviderWindowClaim[] = [
      { windowId: WINDOW_A, generation: 1 },
      { windowId: WINDOW_B, generation: 2 }
    ]
    const finishRestore = claims.stage(planned)
    const registeredWindows: Array<readonly DesktopProviderWindowClaim[]> = []
    const heartbeatWindows: Array<readonly DesktopProviderWindowClaim[]> = []
    const register = vi.fn((windows: readonly DesktopProviderWindowClaim[]) => {
      desktopProviderRegisterParamsSchema.parse({
        bootstrapProof: 'a'.repeat(32),
        instanceId: INSTANCE_ID,
        capabilities: ['window-host-v1', 'tab-transfer-v1', 'browser-transfer-v1'],
        windows
      })
      registeredWindows.push([...windows])
    })
    const heartbeat = vi.fn((windows: readonly DesktopProviderWindowClaim[]) => {
      desktopProviderHeartbeatParamsSchema.parse({
        providerId: PROVIDER_ID,
        providerEpoch: 1,
        leaseId: LEASE_ID,
        windows
      })
      heartbeatWindows.push([...windows])
    })

    await pollingGate.bindAll(() => {
      register(claims.snapshot([{ windowId: WINDOW_A, generation: 1 }]))
      heartbeat(claims.snapshot([{ windowId: WINDOW_A, generation: 1 }]))
      pollingGate.bindingReady(startPolling)
      expect(startPolling).not.toHaveBeenCalled()

      heartbeat(claims.snapshot(planned))
      pollingGate.bindingReady(startPolling)
      expect(startPolling).not.toHaveBeenCalled()
      finishRestore()
      heartbeat(claims.snapshot(planned))
      return Promise.resolve()
    }, startPolling)

    expect(registeredWindows).toEqual([planned])
    expect(heartbeatWindows).toEqual([planned, planned, planned])
    expect(startPolling).toHaveBeenCalledOnce()
    expect(claims.snapshot(planned)).toEqual(planned)
  })

  it('withdraws a failed staged placement and heartbeats before polling opens', async () => {
    const claims = new DesktopProviderClaims()
    const pollingGate = new ProviderPollingGate()
    const order: string[] = []
    const live = [{ windowId: WINDOW_A, generation: 1 }] as const
    const finishRestore = claims.stage([...live, { windowId: WINDOW_B, generation: 2 }])

    await pollingGate.bindAll(
      () => {
        expect(claims.snapshot(live)).toHaveLength(2)
        finishRestore()
        expect(claims.snapshot(live)).toEqual(live)
        order.push('heartbeat-reduced-claims')
        return Promise.resolve()
      },
      () => order.push('polling-started')
    )

    expect(order).toEqual(['heartbeat-reduced-claims', 'polling-started'])
  })

  it('drops an uncreated staged placement only after restoration finishes', () => {
    const claims = new DesktopProviderClaims()
    const finishRestore = claims.stage([
      { windowId: WINDOW_A, generation: 1 },
      { windowId: WINDOW_B, generation: 2 }
    ])

    finishRestore()

    expect(claims.snapshot([{ windowId: WINDOW_A, generation: 1 }])).toEqual([
      { windowId: WINDOW_A, generation: 1 }
    ])
  })
})
