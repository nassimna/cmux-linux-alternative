import { describe, expect, it, vi } from 'vitest'

import { ProviderPollingGate } from './provider-polling-gate'

describe('ProviderPollingGate', () => {
  it('starts polling after an initial single-window binding', () => {
    const gate = new ProviderPollingGate()
    const startPolling = vi.fn()

    gate.bindingReady(startPolling)

    expect(startPolling).toHaveBeenCalledOnce()
  })

  it('keeps member bindings paused until the complete exact binding set is ready', async () => {
    const gate = new ProviderPollingGate()
    const startPolling = vi.fn()

    await gate.bindAll(() => {
      gate.bindingReady(startPolling)
      gate.bindingReady(startPolling)
      expect(startPolling).not.toHaveBeenCalled()
      return Promise.resolve()
    }, startPolling)

    expect(startPolling).toHaveBeenCalledOnce()
  })

  it('does not open polling after a failed binding set', async () => {
    const gate = new ProviderPollingGate()
    const startPolling = vi.fn()

    await expect(
      gate.bindAll(() => Promise.reject(new Error('binding failed')), startPolling)
    ).rejects.toThrow('binding failed')
    expect(startPolling).not.toHaveBeenCalled()
  })
})
