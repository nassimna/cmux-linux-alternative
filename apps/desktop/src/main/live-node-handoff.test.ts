import { describe, expect, it, vi } from 'vitest'

import { createLiveNodeHandoff, type LiveNodeHandoffOptions } from './live-node-handoff'

function setup() {
  const node = { id: 'qualified-node' }
  const order: string[] = []
  const options: LiveNodeHandoffOptions<typeof node> = {
    qualify: vi.fn(() => {
      order.push('qualify')
      return Promise.resolve()
    }),
    stopRustForHandoff: vi.fn(() => {
      order.push('stop-rust')
      return Promise.resolve()
    }),
    startNode: vi.fn(() => {
      order.push('start-node')
      return Promise.resolve(node)
    }),
    activateNode: vi.fn(() => {
      order.push('activate-node')
      return Promise.resolve()
    }),
    failClosed: vi.fn(() => {
      order.push('fail-closed')
      return Promise.resolve()
    }),
    recover: vi.fn(() => {
      order.push('recover')
      return Promise.resolve('rust-restored' as const)
    })
  }
  return { node, options, order }
}

describe('createLiveNodeHandoff', () => {
  it('qualifies, stops Rust, starts Node, and activates it in order only once', async () => {
    const { node, options, order } = setup()
    const run = createLiveNodeHandoff(options)
    const first = run()
    expect(run()).toBe(first)
    await expect(first).resolves.toEqual({ status: 'node-active', phase: 'node-activate', node })
    await run()
    expect(order).toEqual(['qualify', 'stop-rust', 'start-node', 'activate-node'])
    expect(options.startNode).toHaveBeenCalledTimes(1)
  })

  it('does not seal Rust when qualification fails', async () => {
    const { options } = setup()
    const cause = new Error('preflight rejected')
    options.qualify = vi.fn(() => Promise.reject(cause))
    await expect(createLiveNodeHandoff(options)()).resolves.toEqual({
      status: 'not-started',
      phase: 'qualification',
      cause
    })
    expect(options.stopRustForHandoff).not.toHaveBeenCalled()
    expect(options.recover).not.toHaveBeenCalled()
  })

  it.each(['rust-stop', 'node-start', 'node-activate'] as const)(
    'fails closed and invokes recovery for %s failure',
    async (phase) => {
      const { node, options, order } = setup()
      const cause = new Error(phase)
      if (phase === 'rust-stop') options.stopRustForHandoff = vi.fn(() => Promise.reject(cause))
      if (phase === 'node-start') options.startNode = vi.fn(() => Promise.reject(cause))
      if (phase === 'node-activate') options.activateNode = vi.fn(() => Promise.reject(cause))
      const result = await createLiveNodeHandoff(options)()
      expect(result).toEqual({ status: 'rust-restored', phase, cause })
      expect(options.recover).toHaveBeenCalledWith({
        phase,
        cause,
        ...(phase === 'node-activate' ? { node } : {})
      })
      expect(order.slice(-2)).toEqual(['fail-closed', 'recover'])
      if (phase === 'rust-stop') expect(options.startNode).not.toHaveBeenCalled()
    }
  )

  it('requires manual recovery when cleanup cannot prove Rust restoration', async () => {
    const { options } = setup()
    options.startNode = vi.fn(() => Promise.reject(new Error('partial Node start')))
    options.recover = vi.fn(() => Promise.resolve('manual-required' as const))
    await expect(createLiveNodeHandoff(options)()).resolves.toMatchObject({
      status: 'recovery-required',
      phase: 'node-start'
    })
  })

  it('does not attempt recovery when fail-closed binding fails', async () => {
    const { options } = setup()
    const failClosedError = new Error('binding still active')
    options.startNode = vi.fn(() => Promise.reject(new Error('Node failed')))
    options.failClosed = vi.fn(() => Promise.reject(failClosedError))
    await expect(createLiveNodeHandoff(options)()).resolves.toMatchObject({
      status: 'recovery-required',
      phase: 'node-start',
      failClosedError
    })
    expect(options.recover).not.toHaveBeenCalled()
  })

  it('reports a recovery error without retrying either owner', async () => {
    const { options } = setup()
    const recoveryError = new Error('Rust restart not proven')
    options.activateNode = vi.fn(() => Promise.reject(new Error('binding failed')))
    options.recover = vi.fn(() => Promise.reject(recoveryError))
    await expect(createLiveNodeHandoff(options)()).resolves.toMatchObject({
      status: 'recovery-required',
      phase: 'node-activate',
      recoveryError
    })
    expect(options.startNode).toHaveBeenCalledTimes(1)
  })
})
