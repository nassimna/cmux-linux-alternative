import { describe, expect, it, vi } from 'vitest'

import { acquireMainWindow } from './main-window-acquisition'
import { WindowCreationEntrypoints } from './window-creation-entrypoints'

interface TestWindow {
  destroyed: boolean
  id: number
}

describe('main window acquisition', () => {
  it('releases partial bindings, clears ownership, and destroys a failed provisional window', async () => {
    let currentWindow: TestWindow | undefined
    const firstCleanup = vi.fn()
    const secondCleanup = vi.fn(() => {
      throw new Error('injected cleanup failure')
    })
    const clear = vi.fn((window: TestWindow) => {
      if (currentWindow === window) currentWindow = undefined
    })
    const provisionalWindow = { id: 1, destroyed: false }

    await expect(
      acquireMainWindow<TestWindow>({
        clear,
        create: () => provisionalWindow,
        destroy: (window) => {
          window.destroyed = true
        },
        initialize: (_window, acquisition) => {
          acquisition.addCleanup(firstCleanup)
          acquisition.addCleanup(secondCleanup)
          throw new Error('injected setup failure')
        },
        isDestroyed: (window) => window.destroyed,
        load: vi.fn(),
        publish: (window) => {
          currentWindow = window
        }
      })
    ).rejects.toThrow('injected setup failure')

    expect(clear).toHaveBeenCalledWith(provisionalWindow)
    expect(secondCleanup).toHaveBeenCalledBefore(firstCleanup)
    expect(firstCleanup).toHaveBeenCalledOnce()
    expect(provisionalWindow.destroyed).toBe(true)
    expect(currentWindow).toBeUndefined()
  })

  it('clears a published load failure so startup recovery can retry successfully', async () => {
    let currentWindow: TestWindow | undefined
    let nextId = 1
    let failLoad = true
    const createWindow = (): Promise<TestWindow> =>
      acquireMainWindow<TestWindow>({
        clear: (window) => {
          if (currentWindow === window) currentWindow = undefined
        },
        create: () => ({ id: nextId++, destroyed: false }),
        destroy: (window) => {
          window.destroyed = true
        },
        initialize: vi.fn(),
        isDestroyed: (window) => window.destroyed,
        load: () => {
          if (failLoad) {
            failLoad = false
            return Promise.reject(new Error('injected load failure'))
          }
          return Promise.resolve()
        },
        publish: (window) => {
          currentWindow = window
        }
      })

    await expect(createWindow()).rejects.toThrow('injected load failure')
    expect(currentWindow).toBeUndefined()

    const quit = vi.fn()
    const entrypoints = new WindowCreationEntrypoints({
      createWindow,
      getLiveWindow: () =>
        currentWindow !== undefined && !currentWindow.destroyed ? currentWindow : undefined,
      hasLiveWindow: () => currentWindow !== undefined && !currentWindow.destroyed,
      isQuitStarted: () => false,
      isWindowLive: (window) => !window.destroyed,
      logError: vi.fn(),
      quit
    })
    await entrypoints.recoverStartup(new Error('initial startup failed'), true)

    expect(currentWindow).toEqual({ id: 2, destroyed: false })
    expect(quit).not.toHaveBeenCalled()
  })
})
