import { describe, expect, it, vi } from 'vitest'

import { registerWithStableWindowClaims } from './desktop-provider-registration'

describe('desktop provider registration', () => {
  it('retires a registration that captured a stale renderer generation', async () => {
    let generation = 1
    const register = vi.fn(() => {
      const registration = { leaseId: `lease-${String(generation)}` }
      if (generation === 1) generation = 2
      return Promise.resolve(registration)
    })
    const unregister = vi.fn().mockResolvedValue(undefined)

    await expect(
      registerWithStableWindowClaims({
        claims: () => [{ windowId: 'window-a', generation }],
        register,
        unregister
      })
    ).resolves.toEqual({ leaseId: 'lease-2' })

    expect(register).toHaveBeenNthCalledWith(1, [{ windowId: 'window-a', generation: 1 }])
    expect(register).toHaveBeenNthCalledWith(2, [{ windowId: 'window-a', generation: 2 }])
    expect(unregister).toHaveBeenCalledWith({ leaseId: 'lease-1' })
  })

  it('fails after a bounded number of continuously changing captures', async () => {
    let generation = 1
    const unregister = vi.fn().mockResolvedValue(undefined)
    await expect(
      registerWithStableWindowClaims({
        claims: () => [{ windowId: 'window-a', generation }],
        register: vi.fn(() => {
          generation += 1
          return Promise.resolve({ generation })
        }),
        unregister,
        maximumAttempts: 2
      })
    ).rejects.toThrow('generations changed')
    expect(unregister).toHaveBeenCalledTimes(2)
  })
})
