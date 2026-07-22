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
    expect(binding.browserViews).toBe(browserViews)
    expect(() => binding.replaceReady({} as never, browserViews as never, vi.fn())).toThrow(
      'already bound'
    )

    await binding.dispose()
    await binding.dispose()
    expect(order).toEqual(['renderer', 'clear-client', 'state'])
    expect(stateController.dispose).toHaveBeenCalledOnce()
  })
})
