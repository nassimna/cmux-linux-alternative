import { describe, expect, it, vi } from 'vitest'

import { recoverNodeWindowHosting } from './node-hosting-recovery'
import { WindowHostingAuthority } from '../../../server/src/http/window-hosting-authority'

describe('Node window hosting recovery', () => {
  it('re-registers hosting before restarting browser automation', async () => {
    const calls: string[] = []
    await recoverNodeWindowHosting({
      isCurrent: () => true,
      stopAutomation: () => {
        calls.push('stop')
      },
      nextGeneration: () => 2,
      registerHosting: () => {
        calls.push('register')
        return Promise.resolve()
      },
      startAutomation: () => {
        calls.push('start')
        return Promise.resolve()
      },
      logError: vi.fn()
    })
    expect(calls).toEqual(['stop', 'register', 'start'])
  })

  it('does not restart automation when the window closes during re-registration', async () => {
    let current = true
    const startAutomation = vi.fn(() => Promise.resolve())
    await recoverNodeWindowHosting({
      isCurrent: () => current,
      stopAutomation: vi.fn(),
      nextGeneration: () => 2,
      registerHosting: () => {
        current = false
        return Promise.resolve()
      },
      startAutomation,
      logError: vi.fn()
    })
    expect(startAutomation).not.toHaveBeenCalled()
  })

  it('leaves recovery retryable after re-registration fails', async () => {
    const registerHosting = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary disconnect'))
      .mockResolvedValue(undefined)
    const startAutomation = vi.fn(() => Promise.resolve())
    const logError = vi.fn()
    const options = {
      isCurrent: () => true,
      stopAutomation: vi.fn(),
      nextGeneration: () => 2,
      registerHosting,
      startAutomation,
      logError
    }
    expect(await recoverNodeWindowHosting(options)).toBe(false)
    expect(logError).toHaveBeenCalledOnce()
    expect(startAutomation).not.toHaveBeenCalled()
    expect(await recoverNodeWindowHosting(options)).toBe(true)
    expect(startAutomation).toHaveBeenCalledOnce()
  })

  it('requests another recovery when automation setup fails after hosting renews', async () => {
    const startAutomation = vi
      .fn()
      .mockRejectedValueOnce(new Error('configuration temporarily unavailable'))
      .mockResolvedValue(undefined)
    const options = {
      isCurrent: () => true,
      stopAutomation: vi.fn(),
      nextGeneration: () => 2,
      registerHosting: vi.fn(() => Promise.resolve()),
      startAutomation,
      logError: vi.fn()
    }
    expect(await recoverNodeWindowHosting(options)).toBe(false)
    expect(await recoverNodeWindowHosting(options)).toBe(true)
    expect(options.registerHosting).toHaveBeenCalledTimes(2)
  })

  it('recovers an expired server lease without reusing its fenced generation', async () => {
    let now = 0
    let hosted = false
    const authority = new WindowHostingAuthority(
      {
        reconcileWindowHosting: (claims) => {
          hosted = claims.has('window')
          return 1
        }
      },
      () => now
    )
    authority.register('window', 1)
    now = 20_000
    authority.expire()
    expect(hosted).toBe(false)
    expect(() => authority.register('window', 1)).toThrow('stale_window_generation')
    const logError = vi.fn()
    await recoverNodeWindowHosting({
      isCurrent: () => true,
      stopAutomation: vi.fn(),
      nextGeneration: () => 2,
      registerHosting: (generation) => {
        authority.register('window', generation)
        return Promise.resolve()
      },
      startAutomation: () => Promise.resolve(),
      logError
    })
    expect(hosted).toBe(true)
    expect(logError).not.toHaveBeenCalled()
    expect(() => authority.heartbeat('window', 1)).toThrow('stale_window_generation')
  })
})
