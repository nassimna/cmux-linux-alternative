import { describe, expect, it, vi } from 'vitest'

import { WindowCreationEntrypoints } from './window-creation-entrypoints'

interface TestWindow {
  destroyed: boolean
  focused: boolean
  minimized: boolean
}

describe('WindowCreationEntrypoints', () => {
  it('consumes a failed startup retry, logs both failures, and quits exactly once', async () => {
    const fixture = createFixture()
    const initialError = new Error('/private/initial-load-detail')
    const retryError = new Error('/private/retry-load-detail')
    fixture.createWindow.mockRejectedValueOnce(retryError)

    await expect(fixture.entrypoints.recoverStartup(initialError, true)).resolves.toBeUndefined()

    expect(fixture.createWindow).toHaveBeenCalledOnce()
    expect(fixture.logError).toHaveBeenNthCalledWith(1, 'Desktop startup failed safely')
    expect(fixture.logError).toHaveBeenNthCalledWith(2, 'Desktop startup recovery failed safely')
    expect(JSON.stringify(fixture.logError.mock.calls)).not.toContain('/private')
    expect(fixture.quit).toHaveBeenCalledOnce()
  })

  it('keeps running when the startup retry creates a live window', async () => {
    const fixture = createFixture()

    await expect(
      fixture.entrypoints.recoverStartup(new Error('initial load failed'), true)
    ).resolves.toBeUndefined()

    expect(fixture.createWindow).toHaveBeenCalledOnce()
    expect(fixture.quit).not.toHaveBeenCalled()
  })

  it.each([
    ['activation', (fixture: Fixture) => fixture.entrypoints.activate()],
    ['second instance', (fixture: Fixture) => fixture.entrypoints.secondInstance(vi.fn())]
  ])('consumes a failed %s request and quits only without a live window', async (_name, run) => {
    const fixture = createFixture()
    fixture.createWindow.mockRejectedValue(new Error('load failed'))

    await expect(run(fixture)).resolves.toBeUndefined()
    expect(fixture.quit).toHaveBeenCalledOnce()

    fixture.quit.mockClear()
    fixture.setCurrent(createWindow())
    await expect(run(fixture)).resolves.toBeUndefined()
    expect(fixture.quit).not.toHaveBeenCalled()
  })

  it('restores and focuses the live window for a successful second-instance request', async () => {
    const fixture = createFixture()
    const window = createWindow({ minimized: true })
    fixture.setCurrent(window)

    await fixture.entrypoints.secondInstance((createdWindow) => {
      if (createdWindow.minimized) createdWindow.minimized = false
      createdWindow.focused = true
    })

    expect(window).toMatchObject({ minimized: false, focused: true, destroyed: false })
    expect(fixture.quit).not.toHaveBeenCalled()
  })

  it('focuses the retained live window when a second instance arrives during cleanup', async () => {
    const fixture = createFixture()
    const window = createWindow({ minimized: true })
    fixture.setCurrent(window)
    fixture.setQuitting(true)

    await fixture.entrypoints.secondInstance((createdWindow) => {
      createdWindow.minimized = false
      createdWindow.focused = true
    })

    expect(window).toMatchObject({ minimized: false, focused: true, destroyed: false })
    expect(fixture.createWindow).not.toHaveBeenCalled()
    expect(fixture.quit).not.toHaveBeenCalled()
  })

  it('suppresses creation and window actions after graceful quit starts', async () => {
    const fixture = createFixture()
    const onWindow = vi.fn()
    fixture.setQuitting(true)

    await fixture.entrypoints.activate()
    await fixture.entrypoints.secondInstance(onWindow)
    await fixture.entrypoints.recoverStartup(new Error('shutdown race'), true)

    expect(fixture.createWindow).not.toHaveBeenCalled()
    expect(onWindow).not.toHaveBeenCalled()
    expect(fixture.quit).not.toHaveBeenCalled()
  })
})

type Fixture = ReturnType<typeof createFixture>

function createFixture() {
  let currentWindow: TestWindow | undefined
  let quitting = false
  const createWindowMock = vi.fn(() => {
    if (!currentWindow || currentWindow.destroyed) currentWindow = createWindow()
    return Promise.resolve(currentWindow)
  })
  const logError = vi.fn()
  const quit = vi.fn()
  const entrypoints = new WindowCreationEntrypoints({
    createWindow: createWindowMock,
    getLiveWindow: () =>
      currentWindow !== undefined && !currentWindow.destroyed ? currentWindow : undefined,
    hasLiveWindow: () => currentWindow !== undefined && !currentWindow.destroyed,
    isQuitStarted: () => quitting,
    isWindowLive: (window) => !window.destroyed,
    logError,
    quit
  })
  return {
    createWindow: createWindowMock,
    entrypoints,
    logError,
    quit,
    setCurrent(window: TestWindow | undefined) {
      currentWindow = window
    },
    setQuitting(value: boolean) {
      quitting = value
    }
  }
}

function createWindow(overrides: Partial<TestWindow> = {}): TestWindow {
  return { destroyed: false, focused: false, minimized: false, ...overrides }
}
