import { describe, expect, it, vi } from 'vitest'
import type { DesktopProviderRequest } from '@agent-workspace/protocol-client'

import { recoverProviderOwnership } from './provider-ownership-recovery'
import { WindowRegistry, type WindowRegistryBinding } from './window-registry'

describe('recoverProviderOwnership', () => {
  it('detaches a live terminal source before attaching the exact target and replays idempotently', async () => {
    const order: string[] = []
    const source = terminalBinding('source', order)
    const target = terminalBinding('target', order)
    const registry = registryWith(source, target)
    registry.get('source')!.terminalAttachments.add('runtime-a')
    const request = recoveryRequest('terminal')

    await recoverProviderOwnership(registry, request, new AbortController().signal)
    await recoverProviderOwnership(registry, request, new AbortController().signal)

    expect(order).toEqual(['source:detach', 'target:attach'])
    expect(registry.get('source')!.terminalAttachments.has('runtime-a')).toBe(false)
    expect(registry.get('target')!.terminalAttachments.has('runtime-a')).toBe(true)
  })

  it('adopts a terminal when the exact source resource vanished', async () => {
    const order: string[] = []
    const registry = registryWith(undefined, terminalBinding('target', order))

    await recoverProviderOwnership(
      registry,
      recoveryRequest('terminal'),
      new AbortController().signal
    )

    expect(order).toEqual(['target:attach'])
    expect(registry.get('target')!.terminalAttachments.has('runtime-a')).toBe(true)
  })

  it('does not issue a stale source detach when the exact source entry no longer owns the terminal', async () => {
    const order: string[] = []
    const source = terminalBinding('source', order)
    const registry = registryWith(source, terminalBinding('target', order))

    await recoverProviderOwnership(
      registry,
      recoveryRequest('terminal'),
      new AbortController().signal
    )

    expect(source.client.detachTerminal).not.toHaveBeenCalled()
    expect(order).toEqual(['target:attach'])
  })

  it('rolls a live terminal source back when target attachment fails', async () => {
    const order: string[] = []
    const source = terminalBinding('source', order)
    const target = terminalBinding('target', order, true)
    const registry = registryWith(source, target)
    registry.get('source')!.terminalAttachments.add('runtime-a')

    await expect(
      recoverProviderOwnership(registry, recoveryRequest('terminal'), new AbortController().signal)
    ).rejects.toThrow('target failed')

    expect(order).toEqual(['source:detach', 'target:attach', 'target:detach', 'source:attach'])
    expect(registry.get('source')!.terminalAttachments.has('runtime-a')).toBe(true)
  })

  it('atomically consumes a suspended detach saga and uses its rollback on recovery failure', async () => {
    const order = ['source:detach']
    const source = terminalBinding('source', order)
    const registry = registryWith(source, terminalBinding('target', order, true))
    let suspended: { rollback: () => Promise<void> } | undefined = {
      rollback: () => {
        order.push('source:rollback')
        registry.get('source')!.terminalAttachments.add('runtime-a')
        return Promise.resolve()
      }
    }

    await expect(
      recoverProviderOwnership(
        registry,
        recoveryRequest('terminal'),
        new AbortController().signal,
        {
          takeSuspendedTerminal: () => {
            const taken = suspended
            suspended = undefined
            return taken
          }
        }
      )
    ).rejects.toThrow('target failed')

    expect(order).toEqual(['source:detach', 'target:attach', 'target:detach', 'source:rollback'])
    expect(suspended).toBeUndefined()
    expect(registry.get('source')!.terminalAttachments.has('runtime-a')).toBe(true)
  })

  it('consumes a suspended saga permanently on success so later cleanup cannot duplicate ownership', async () => {
    const order = ['source:detach']
    const registry = registryWith(
      terminalBinding('source', order),
      terminalBinding('target', order)
    )
    const rollback = vi.fn(() => {
      registry.get('source')!.terminalAttachments.add('runtime-a')
      return Promise.resolve()
    })
    let suspended: { rollback: () => Promise<void> } | undefined = { rollback }

    await recoverProviderOwnership(
      registry,
      recoveryRequest('terminal'),
      new AbortController().signal,
      {
        takeSuspendedTerminal: () => {
          const taken = suspended
          suspended = undefined
          return taken
        }
      }
    )

    expect(suspended).toBeUndefined()
    expect(rollback).not.toHaveBeenCalled()
    expect(registry.get('source')!.terminalAttachments.has('runtime-a')).toBe(false)
    expect(registry.get('target')!.terminalAttachments.has('runtime-a')).toBe(true)
  })

  it('rolls back a terminal source when the lease is canceled between detach and attach', async () => {
    const order: string[] = []
    const abort = new AbortController()
    const source = terminalBinding('source', order, false, () => abort.abort())
    const registry = registryWith(source, terminalBinding('target', order))
    registry.get('source')!.terminalAttachments.add('runtime-a')

    await expect(
      recoverProviderOwnership(registry, recoveryRequest('terminal'), abort.signal)
    ).rejects.toThrow('canceled')

    expect(order).toEqual(['source:detach', 'source:attach'])
  })

  it('does not recreate the source when target cleanup is uncertain', async () => {
    const order: string[] = []
    const source = terminalBinding('source', order)
    const target = terminalBinding('target', order, true, () => undefined, true)
    const registry = registryWith(source, target)
    registry.get('source')!.terminalAttachments.add('runtime-a')

    await expect(
      recoverProviderOwnership(registry, recoveryRequest('terminal'), new AbortController().signal)
    ).rejects.toThrow('target failed')

    expect(order).toEqual(['source:detach', 'target:attach', 'target:detach'])
    expect(registry.get('source')!.terminalAttachments.has('runtime-a')).toBe(false)
    expect(registry.get('target')!.terminalAttachments.has('runtime-a')).toBe(true)
  })

  it('moves a browser view source-first and adopts it when the source vanished', async () => {
    const order: string[] = []
    const source = browserBinding('source', order, true)
    const target = browserBinding('target', order, false)
    const registry = registryWith(source, target)

    await recoverProviderOwnership(
      registry,
      recoveryRequest('browser'),
      new AbortController().signal
    )
    expect(order).toEqual(['source:suspend', 'target:mount', 'source:destroy'])

    const vanishedOrder: string[] = []
    const vanishedRegistry = registryWith(undefined, browserBinding('target', vanishedOrder, false))
    await recoverProviderOwnership(
      vanishedRegistry,
      recoveryRequest('browser'),
      new AbortController().signal
    )
    expect(vanishedOrder).toEqual(['target:mount'])
  })

  it('rolls back a browser source after target creation failure', async () => {
    const order: string[] = []
    const source = browserBinding('source', order, true)
    const target = browserBinding('target', order, false, true)
    const registry = registryWith(source, target)

    await expect(
      recoverProviderOwnership(registry, recoveryRequest('browser'), new AbortController().signal)
    ).rejects.toThrow('target failed')
    expect(order).toEqual(['source:suspend', 'target:mount', 'target:destroy', 'source:rollback'])
  })

  it('fails closed for stale source and target generations', async () => {
    const registry = registryWith(terminalBinding('source', []), terminalBinding('target', []))
    const staleSource = {
      ...recoveryRequest('terminal'),
      source: { windowId: 'source', generation: 9 }
    }
    await expect(
      recoverProviderOwnership(registry, staleSource, new AbortController().signal)
    ).rejects.toThrow('source generation is stale')
    const staleTarget = {
      ...recoveryRequest('terminal'),
      target: { windowId: 'target', generation: 9 }
    }
    await expect(
      recoverProviderOwnership(registry, staleTarget, new AbortController().signal)
    ).rejects.toThrow('target generation is stale')
  })
})

function recoveryRequest(kind: 'terminal' | 'browser'): DesktopProviderRequest {
  return {
    requestId: 'request-a',
    correlationId: 'correlation-a',
    attemptEpoch: 1,
    operation: 'recoverOwnership',
    source: { windowId: 'source', generation: 1 },
    target: { windowId: 'target', generation: 2 },
    tabId: 'tab-a',
    runtimeSessionId: 'runtime-a',
    transferEpoch: 3,
    workspaceId: 'workspace-a',
    paneId: 'pane-a',
    ownershipKind: kind,
    ...(kind === 'browser'
      ? {
          browser: {
            browserSessionId: 'runtime-a',
            lifecycleId: 'lifecycle-a',
            profilePartition: 'persist:workspace',
            stateRevision: 1,
            title: 'Recovered',
            url: 'https://example.com'
          }
        }
      : {})
  }
}

function registryWith(source: TestBinding | undefined, target: TestBinding): WindowRegistry {
  const registry = new WindowRegistry()
  if (source) registry.register('source', windowFixture(1), source, 1)
  registry.register('target', windowFixture(2), target, 2)
  registry.resetProviderEpoch(7)
  return registry
}

interface TestBinding extends WindowRegistryBinding {
  readonly client: {
    attachTerminal: ReturnType<typeof vi.fn>
    detachTerminal: ReturnType<typeof vi.fn>
  }
}

function terminalBinding(
  name: string,
  order: string[],
  failAttach = false,
  onDetach: () => void = () => undefined,
  failDetach = false
): TestBinding {
  return {
    browserViews: browserManager(name, order, false),
    client: {
      attachTerminal: vi.fn(() => {
        order.push(`${name}:attach`)
        return failAttach ? Promise.reject(new Error('target failed')) : Promise.resolve()
      }),
      detachTerminal: vi.fn(() => {
        order.push(`${name}:detach`)
        onDetach()
        return failDetach ? Promise.reject(new Error('target detach failed')) : Promise.resolve()
      })
    },
    stateController: {} as never,
    dispose: vi.fn().mockResolvedValue(undefined)
  }
}

function browserBinding(
  name: string,
  order: string[],
  owns: boolean,
  failMount = false
): TestBinding {
  return {
    ...terminalBinding(name, order),
    browserViews: browserManager(name, order, owns, failMount)
  }
}

function browserManager(name: string, order: string[], owns: boolean, failMount = false) {
  return {
    ownsSession: vi.fn(() => owns),
    suspendOwnedSession: vi.fn(() => {
      order.push(`${name}:suspend`)
      return () => order.push(`${name}:rollback`)
    }),
    mountTransferred: vi.fn(() => {
      order.push(`${name}:mount`)
      return failMount ? Promise.reject(new Error('target failed')) : Promise.resolve()
    }),
    destroyOwnedSession: vi.fn(() => {
      order.push(`${name}:destroy`)
    })
  } as never
}

function windowFixture(id: number): Electron.BrowserWindow {
  return {
    webContents: { id, mainFrame: {} },
    isDestroyed: () => false
  } as unknown as Electron.BrowserWindow
}
