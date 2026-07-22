import { describe, expect, it, vi } from 'vitest'

import { OwnedBinding, WindowCreationCoordinator } from './window-lifecycle-coordinator'

interface TestWindow {
  destroyed: boolean
  id: number
}

describe('WindowCreationCoordinator', () => {
  it('coalesces concurrent requests into one window creation', async () => {
    const state = deferred<string>()
    const fixture = createFixture({ resolveState: () => state.promise })

    const first = fixture.coordinator.ensureWindow()
    const second = fixture.coordinator.ensureWindow()

    expect(second).toBe(first)
    expect(fixture.resolveState).toHaveBeenCalledOnce()
    state.resolve('saved')
    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: 1, destroyed: false },
      { id: 1, destroyed: false }
    ])
    expect(fixture.createWindow).toHaveBeenCalledOnce()
    expect(fixture.createWindow).toHaveBeenCalledWith('saved')
  })

  it('clears a failed attempt so a later request can retry', async () => {
    const fixture = createFixture()
    fixture.createWindow.mockRejectedValueOnce(new Error('load failed'))

    await expect(fixture.coordinator.ensureWindow()).rejects.toThrow('load failed')
    await expect(fixture.coordinator.ensureWindow()).resolves.toEqual({
      id: 1,
      destroyed: false
    })
    expect(fixture.createWindow).toHaveBeenCalledTimes(2)
  })

  it('does not create after graceful quit starts while state is resolving', async () => {
    const state = deferred<string>()
    const fixture = createFixture({ resolveState: () => state.promise })

    const creation = fixture.coordinator.ensureWindow()
    fixture.setQuitting(true)
    state.resolve('saved')

    await expect(creation).resolves.toBeUndefined()
    await expect(fixture.coordinator.ensureWindow()).resolves.toBeUndefined()
    expect(fixture.createWindow).not.toHaveBeenCalled()
  })

  it('discards a late window when graceful quit starts while creation is pending', async () => {
    const created = deferred<TestWindow>()
    const fixture = createFixture()
    fixture.createWindow.mockImplementationOnce(() => created.promise)
    const lateWindow = { id: 1, destroyed: false }

    const creation = fixture.coordinator.ensureWindow()
    await vi.waitFor(() => expect(fixture.createWindow).toHaveBeenCalledOnce())
    fixture.setCurrent(lateWindow)
    fixture.setQuitting(true)
    created.resolve(lateWindow)

    await expect(creation).resolves.toBeUndefined()
    expect(fixture.discardWindow).toHaveBeenCalledOnce()
    expect(fixture.discardWindow).toHaveBeenCalledWith(lateWindow)
    expect(lateWindow.destroyed).toBe(true)
    expect(fixture.currentWindow()).toBeUndefined()
  })

  it('uses a live replacement that appears during state resolution', async () => {
    const state = deferred<string>()
    const fixture = createFixture({ resolveState: () => state.promise })
    const replacement = { id: 42, destroyed: false }

    const creation = fixture.coordinator.ensureWindow()
    fixture.setCurrent(replacement)
    state.resolve('stale')

    await expect(creation).resolves.toBe(replacement)
    expect(fixture.createWindow).not.toHaveBeenCalled()
  })

  it('returns the current replacement instead of a stale creation completion', async () => {
    const created = deferred<TestWindow>()
    const fixture = createFixture()
    fixture.createWindow.mockImplementationOnce(() => created.promise)
    const staleWindow = { id: 1, destroyed: false }
    const replacement = { id: 42, destroyed: false }

    const creation = fixture.coordinator.ensureWindow()
    await vi.waitFor(() => expect(fixture.createWindow).toHaveBeenCalledOnce())
    fixture.setCurrent(replacement)
    created.resolve(staleWindow)

    await expect(creation).resolves.toBe(replacement)
    expect(fixture.discardWindow).toHaveBeenCalledWith(staleWindow)
    expect(staleWindow.destroyed).toBe(true)
  })

  it('creates a replacement after the current window closes', async () => {
    const fixture = createFixture()
    const first = await fixture.coordinator.ensureWindow()
    if (!first) throw new Error('Expected the initial window')
    first.destroyed = true
    fixture.setCurrent(undefined)

    await expect(fixture.coordinator.ensureWindow()).resolves.toEqual({
      id: 2,
      destroyed: false
    })
    expect(fixture.createWindow).toHaveBeenCalledTimes(2)
  })
})

describe('OwnedBinding', () => {
  it('does not let stale-window cleanup dispose a replacement binding', () => {
    const binding = new OwnedBinding<TestWindow>()
    const firstWindow = { id: 1, destroyed: false }
    const secondWindow = { id: 2, destroyed: false }
    const disposeFirst = vi.fn()
    const disposeSecond = vi.fn()

    binding.replace(firstWindow, disposeFirst)
    binding.replace(secondWindow, disposeSecond)
    expect(disposeFirst).toHaveBeenCalledOnce()

    expect(binding.clear(firstWindow)).toBe(false)
    expect(disposeSecond).not.toHaveBeenCalled()
    expect(binding.clear(secondWindow)).toBe(true)
    expect(disposeSecond).toHaveBeenCalledOnce()
  })
})

function createFixture(override: { resolveState?: () => Promise<string> } = {}) {
  let currentWindow: TestWindow | undefined
  let quitting = false
  let nextId = 1
  const resolveState = vi.fn(override.resolveState ?? (() => Promise.resolve('default')))
  const createWindow = vi.fn((state: string) => {
    void state
    const window = { id: nextId++, destroyed: false }
    currentWindow = window
    return Promise.resolve(window)
  })
  const discardWindow = vi.fn((window: TestWindow) => {
    window.destroyed = true
    if (currentWindow === window) currentWindow = undefined
  })
  const coordinator = new WindowCreationCoordinator({
    createWindow,
    discardWindow,
    getCurrentWindow: () => currentWindow,
    isQuitStarted: () => quitting,
    isWindowLive: (window) => !window.destroyed,
    resolveState
  })
  return {
    coordinator,
    createWindow,
    currentWindow: () => currentWindow,
    discardWindow,
    resolveState,
    setCurrent(window: TestWindow | undefined) {
      currentWindow = window
    },
    setQuitting(value: boolean) {
      quitting = value
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
