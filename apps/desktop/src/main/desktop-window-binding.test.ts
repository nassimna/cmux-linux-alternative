import { describe, expect, it, vi } from 'vitest'

import { DesktopWindowBinding } from './desktop-window-binding'

describe('DesktopWindowBinding', () => {
  it('owns one ready generation and disposes renderer resources before bounds state', async () => {
    const order: string[] = []
    const stateController = {
      clearClient: vi.fn(() => order.push('clear-client')),
      dispose: vi.fn(() => {
        order.push('state')
        return Promise.resolve()
      })
    }
    const binding = new DesktopWindowBinding(stateController as never)
    const browserViews = { dispose: vi.fn() }
    expect(() => binding.browserViews).toThrow('not ready')
    binding.replaceReady({} as never, browserViews as never, () => {
      order.push('renderer')
      return Promise.resolve()
    })
    expect(binding.isNodeExclusive).toBe(false)
    expect(binding.browserViews).toBe(browserViews)
    expect(() => binding.replaceReady({} as never, browserViews as never, vi.fn())).toThrow(
      'already bound'
    )

    await binding.dispose()
    await binding.dispose()
    expect(order).toEqual(['renderer', 'clear-client', 'state'])
    expect(stateController.dispose).toHaveBeenCalledOnce()
  })

  it('binds a Node-exclusive renderer without a Rust client and can clear it for a new generation', async () => {
    const stateController = { clearClient: vi.fn(), dispose: vi.fn() }
    const binding = new DesktopWindowBinding(stateController as never)
    const browserViews = { dispose: vi.fn() }
    const dispose = vi.fn().mockResolvedValue(undefined)

    binding.replaceNodeExclusive(browserViews as never, dispose)
    expect(binding.isNodeExclusive).toBe(true)
    expect(binding.browserViews).toBe(browserViews)
    expect(() => binding.client).toThrow('Node-exclusive window has no Rust client')
    expect(() => binding.replaceReady({} as never, browserViews as never, dispose)).toThrow(
      'already bound'
    )
    expect(() => binding.replaceNodeExclusive(browserViews as never, dispose)).toThrow(
      'already bound'
    )

    await binding.clearReady()
    expect(dispose).toHaveBeenCalledOnce()
    expect(stateController.clearClient).toHaveBeenCalledOnce()
    expect(binding.isNodeExclusive).toBe(false)
    expect(() => binding.browserViews).toThrow('not ready')

    const rustClient = {} as never
    binding.replaceReady(rustClient, browserViews as never, dispose)
    expect(binding.client).toBe(rustClient)
    expect(binding.isNodeExclusive).toBe(false)
  })
})
