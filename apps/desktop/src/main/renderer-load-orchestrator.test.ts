import { describe, expect, it, vi } from 'vitest'

import { loadRendererForCurrentLifecycle } from './renderer-load-orchestrator'

describe('loadRendererForCurrentLifecycle', () => {
  it('unbinds, binds the ready client, and only then loads during recovery', async () => {
    const order: string[] = []
    const client = { name: 'ready' }

    await loadRendererForCurrentLifecycle(
      {
        getReadyClient: () => client,
        bind: () => {
          order.push('bind')
        },
        unbind: () => {
          order.push('unbind')
        },
        load: () => {
          order.push('load')
        }
      },
      { unbindFirst: true }
    )

    expect(order).toEqual(['unbind', 'bind', 'load'])
  })

  it('binds before an initial ready load without a redundant unbind', async () => {
    const order: string[] = []
    const client = { name: 'ready' }

    await loadRendererForCurrentLifecycle({
      getReadyClient: () => client,
      bind: () => {
        order.push('bind')
      },
      unbind: () => {
        order.push('unbind')
      },
      load: () => {
        order.push('load')
      }
    })

    expect(order).toEqual(['bind', 'load'])
  })

  it('loads only lifecycle IPC when there is no ready client', async () => {
    const bind = vi.fn()
    const order: string[] = []

    await loadRendererForCurrentLifecycle(
      {
        getReadyClient: () => undefined,
        bind,
        unbind: () => {
          order.push('unbind')
        },
        load: () => {
          order.push('load')
        }
      },
      { unbindFirst: true }
    )

    expect(bind).not.toHaveBeenCalled()
    expect(order).toEqual(['unbind', 'load'])
  })

  it('cleans a stale binding and binds the replacement before loading', async () => {
    const order: string[] = []
    const staleClient = { name: 'stale' }
    const currentClient = { name: 'current' }
    const getReadyClient = vi
      .fn<() => typeof staleClient | undefined>()
      .mockReturnValueOnce(staleClient)
      .mockReturnValue(currentClient)

    await loadRendererForCurrentLifecycle({
      getReadyClient,
      bind: (client) => {
        order.push(`bind:${client.name}`)
      },
      unbind: () => {
        order.push('unbind')
      },
      load: () => {
        order.push('load')
      }
    })

    expect(order).toEqual(['bind:stale', 'unbind', 'bind:current', 'load'])
  })

  it.each(['bind', 'load'] as const)('cleans ready IPC when %s fails', async (failure) => {
    const order: string[] = []
    const client = { name: 'ready' }
    const error = new Error(`${failure} failed`)

    await expect(
      loadRendererForCurrentLifecycle({
        getReadyClient: () => client,
        bind: () => {
          order.push('bind')
          if (failure === 'bind') throw error
        },
        unbind: () => {
          order.push('unbind')
        },
        load: () => {
          order.push('load')
          if (failure === 'load') throw error
        }
      })
    ).rejects.toBe(error)

    expect(order).toEqual(failure === 'bind' ? ['bind', 'unbind'] : ['bind', 'load', 'unbind'])
  })
})
