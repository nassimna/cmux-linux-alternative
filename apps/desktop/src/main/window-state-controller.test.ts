/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest'

import {
  visibleSavedWindowState,
  WindowStateController,
  type PersistedWindow,
  type WindowStateClient
} from './window-state-controller'

const state = {
  revision: 4,
  x: 100,
  y: 120,
  width: 1000,
  height: 700,
  maximized: false,
  fullscreen: false,
  displayId: '1'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function windowFixture() {
  const listeners = new Map<string, () => void>()
  let bounds = { x: 100, y: 120, width: 1000, height: 700 }
  let maximized = false
  let fullscreen = false
  const window: PersistedWindow = {
    getNormalBounds: () => bounds,
    isMaximized: () => maximized,
    isFullScreen: () => fullscreen,
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    removeListener: vi.fn((event: string) => listeners.delete(event))
  }
  return {
    window,
    emit: (event: string) => listeners.get(event)?.(),
    setBounds: (next: typeof bounds) => {
      bounds = next
    },
    setMaximized: (next: boolean) => {
      maximized = next
    },
    setFullscreen: (next: boolean) => {
      fullscreen = next
    }
  }
}

describe('window state', () => {
  it('accepts sufficiently visible saved bounds and rejects malformed or offscreen bounds', () => {
    const displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]

    expect(visibleSavedWindowState(state, displays)).toEqual(state)
    expect(visibleSavedWindowState({ ...state, x: 3000 }, displays)).toBeUndefined()
    expect(visibleSavedWindowState({ ...state, width: 100 }, displays)).toBeUndefined()
  })

  it('debounces and coalesces event storms into one monotonic persistence update', async () => {
    const fixture = windowFixture()
    let scheduled: (() => void) | undefined
    const updateWindowState = vi.fn(async ({ state: next }) => ({ state: next }))
    const client = {
      getWindowState: vi.fn(),
      updateWindowState
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      debounceMs: 50,
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 7, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })
    controller.setClient(client, state)

    fixture.emit('move')
    fixture.emit('resize')
    fixture.emit('maximize')
    scheduled?.()
    await controller.flush()

    expect(updateWindowState).toHaveBeenCalledTimes(1)
    expect(updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 5, displayId: '7' })
    })
  })

  it('does not persist when the initial state exactly matches the actual window', async () => {
    const fixture = windowFixture()
    const client = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    controller.setClient(client, state)
    await controller.flush()

    expect(client.updateWindowState).not.toHaveBeenCalled()
  })

  it('persists an actual min-width normalization once at the next revision', async () => {
    const fixture = windowFixture()
    fixture.setBounds({ x: 100, y: 120, width: 900, height: 700 })
    const client = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    controller.setClient(client, { ...state, revision: 2, width: 570 })
    await controller.flush()

    expect(client.updateWindowState).toHaveBeenCalledTimes(1)
    expect(client.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 3, width: 900 })
    })
  })

  it('preserves dirty recovery state when initial normalization is also detected', async () => {
    const fixture = windowFixture()
    let scheduled: (() => void) | undefined
    const client = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    fixture.setBounds({ x: 250, y: 180, width: 900, height: 760 })
    fixture.emit('resize')
    expect(scheduled).toBeTypeOf('function')
    controller.setClient(client, { ...state, revision: 8, width: 570 })
    await controller.flush()

    expect(client.updateWindowState).toHaveBeenCalledTimes(1)
    expect(client.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 9, x: 250, y: 180, width: 900, height: 760 })
    })
  })

  it('does not leak stale normalization into a replacement client generation', async () => {
    const fixture = windowFixture()
    const staleClient = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const replacementClient = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    controller.setClient(staleClient, { ...state, width: 570 })
    controller.setClient(replacementClient, { ...state, revision: 10 })
    await controller.flush()

    expect(staleClient.updateWindowState).not.toHaveBeenCalled()
    expect(replacementClient.updateWindowState).not.toHaveBeenCalled()
  })

  it.each([
    {
      difference: 'maximized',
      configure: (fixture: ReturnType<typeof windowFixture>) => fixture.setMaximized(true),
      expected: { maximized: true }
    },
    {
      difference: 'fullscreen',
      configure: (fixture: ReturnType<typeof windowFixture>) => fixture.setFullscreen(true),
      expected: { fullscreen: true }
    },
    {
      difference: 'display identity',
      configure: undefined,
      expected: { displayId: '2' }
    }
  ])(
    'persists an actual $difference difference once',
    async ({ difference, configure, expected }) => {
      const fixture = windowFixture()
      configure?.(fixture)
      const client = {
        getWindowState: vi.fn(),
        updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
      } satisfies WindowStateClient
      const controller = new WindowStateController(fixture.window, {
        getDisplayMatching: () => ({
          id: difference === 'display identity' ? 2 : 1,
          workArea: { x: 0, y: 0, width: 1920, height: 1080 }
        })
      })

      controller.setClient(client, state)
      await controller.flush()

      expect(client.updateWindowState).toHaveBeenCalledTimes(1)
      expect(client.updateWindowState).toHaveBeenCalledWith({
        state: expect.objectContaining({ revision: 5, ...expected })
      })
    }
  )

  it('refetches once on a revision conflict and retries the latest geometry', async () => {
    const fixture = windowFixture()
    let scheduled: (() => void) | undefined
    const updateWindowState = vi
      .fn()
      .mockRejectedValueOnce(new Error('stale window revision'))
      .mockImplementation(async ({ state: next }) => ({ state: next }))
    const getWindowState = vi.fn(async () => {
      fixture.setBounds({ x: 440, y: 330, width: 1200, height: 800 })
      fixture.emit('resize')
      return { state: { ...state, revision: 9 } }
    })
    const client = { getWindowState, updateWindowState } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })
    controller.setClient(client, state)

    fixture.emit('move')
    scheduled?.()
    await controller.flush()

    expect(getWindowState).toHaveBeenCalledTimes(1)
    expect(updateWindowState).toHaveBeenCalledTimes(2)
    expect(updateWindowState).toHaveBeenLastCalledWith({
      state: expect.objectContaining({ revision: 10, x: 440, y: 330, width: 1200, height: 800 })
    })
  })

  it('rebases only the durable revision without moving the visible window and flushes on demand', async () => {
    const fixture = windowFixture()
    const client = {
      getWindowState: vi.fn().mockResolvedValue({ state: { ...state, revision: 20, x: 900 } }),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    let scheduled: (() => void) | undefined
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    await controller.rebase(client)
    fixture.emit('move')
    expect(scheduled).toBeTypeOf('function')
    await controller.flush()

    expect(client.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 21, x: 100 })
    })
  })

  it('persists geometry dirtied while no client is available after a successful rebase', async () => {
    const fixture = windowFixture()
    let scheduled: (() => void) | undefined
    const client = {
      getWindowState: vi.fn().mockResolvedValue({ state: { ...state, revision: 12 } }),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    fixture.setBounds({ x: 250, y: 180, width: 1100, height: 760 })
    fixture.emit('resize')
    scheduled?.()
    await controller.flush()
    expect(client.updateWindowState).not.toHaveBeenCalled()

    await controller.rebase(client)
    await controller.flush()

    expect(client.updateWindowState).toHaveBeenCalledTimes(1)
    expect(client.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 13, x: 250, y: 180, width: 1100, height: 760 })
    })
  })

  it('ignores a delayed stale rebase after a newer generation of the same client is installed', async () => {
    const fixture = windowFixture()
    const staleState = deferred<{ state: typeof state }>()
    const client = {
      getWindowState: vi.fn(() => staleState.promise),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    let scheduled: (() => void) | undefined
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    const staleRebase = controller.rebase(client)
    controller.setClient(client, { ...state, revision: 30 })
    staleState.resolve({ state: { ...state, revision: 99 } })
    await staleRebase

    fixture.emit('move')
    scheduled?.()
    await controller.flush()

    expect(client.updateWindowState).toHaveBeenCalledTimes(1)
    expect(client.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 31 })
    })
  })

  it('does not let a rebase completion reconnect after clearClient', async () => {
    const fixture = windowFixture()
    const rebasedState = deferred<{ state: typeof state }>()
    const staleClient = {
      getWindowState: vi.fn(() => rebasedState.promise),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const replacementClient = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    let scheduled: (() => void) | undefined
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    const staleRebase = controller.rebase(staleClient)
    fixture.setBounds({ x: 360, y: 260, width: 900, height: 640 })
    fixture.emit('resize')
    scheduled?.()
    controller.clearClient()
    rebasedState.resolve({ state: { ...state, revision: 40 } })
    await staleRebase
    await controller.flush()

    expect(staleClient.updateWindowState).not.toHaveBeenCalled()

    controller.setClient(replacementClient, { ...state, revision: 7 })
    await controller.flush()
    expect(replacementClient.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 8, x: 360, y: 260 })
    })
  })

  it('preserves a rejected update for a replacement client rebase', async () => {
    const fixture = windowFixture()
    let scheduled: (() => void) | undefined
    const failedClient = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn().mockRejectedValue(new Error('socket closed'))
    } satisfies WindowStateClient
    const replacementClient = {
      getWindowState: vi.fn().mockResolvedValue({ state: { ...state, revision: 17 } }),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })
    controller.setClient(failedClient, state)

    fixture.setBounds({ x: 510, y: 290, width: 1110, height: 730 })
    fixture.emit('resize')
    scheduled?.()
    await expect(controller.flush()).rejects.toThrow('socket closed')

    controller.clearClient()
    await controller.rebase(replacementClient)
    await controller.flush()

    expect(failedClient.updateWindowState).toHaveBeenCalledTimes(1)
    expect(replacementClient.updateWindowState).toHaveBeenCalledTimes(1)
    expect(replacementClient.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 18, x: 510, y: 290, width: 1110, height: 730 })
    })
  })

  it.each(['resolve', 'reject'] as const)(
    'does not let a stale-generation in-flight %s clear newer geometry',
    async (completion) => {
      const fixture = windowFixture()
      let scheduled: (() => void) | undefined
      const inFlight = deferred<{ state: typeof state }>()
      const staleClient = {
        getWindowState: vi.fn(),
        updateWindowState: vi.fn(() => inFlight.promise)
      } satisfies WindowStateClient
      const replacementClient = {
        getWindowState: vi.fn(),
        updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
      } satisfies WindowStateClient
      const controller = new WindowStateController(fixture.window, {
        schedule: (callback) => {
          scheduled = callback
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
        cancelSchedule: vi.fn(),
        getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
      })
      controller.setClient(staleClient, state)

      fixture.setBounds({ x: 210, y: 220, width: 1010, height: 710 })
      fixture.emit('move')
      scheduled?.()
      const staleFlush = controller.flush()
      await vi.waitFor(() => expect(staleClient.updateWindowState).toHaveBeenCalledTimes(1))

      fixture.setBounds({ x: 620, y: 410, width: 1250, height: 820 })
      fixture.emit('resize')
      controller.setClient(replacementClient, { ...state, revision: 30 })
      if (completion === 'resolve') inFlight.resolve({ state: { ...state, revision: 5 } })
      else inFlight.reject(new Error('old socket closed'))
      await staleFlush
      await controller.flush()

      expect(replacementClient.updateWindowState).toHaveBeenCalledTimes(1)
      expect(replacementClient.updateWindowState).toHaveBeenCalledWith({
        state: expect.objectContaining({ revision: 31, x: 620, y: 410, width: 1250, height: 820 })
      })
    }
  )

  it('preserves pending geometry when a conflict retry fails', async () => {
    const fixture = windowFixture()
    let scheduled: (() => void) | undefined
    const failedClient = {
      getWindowState: vi.fn().mockResolvedValue({ state: { ...state, revision: 14 } }),
      updateWindowState: vi
        .fn()
        .mockRejectedValueOnce(new Error('stale revision'))
        .mockRejectedValueOnce(new Error('socket closed during retry'))
    } satisfies WindowStateClient
    const replacementClient = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })
    controller.setClient(failedClient, state)

    fixture.setBounds({ x: 470, y: 350, width: 1180, height: 780 })
    fixture.emit('move')
    scheduled?.()
    await expect(controller.flush()).rejects.toThrow('socket closed during retry')

    controller.clearClient()
    controller.setClient(replacementClient, { ...state, revision: 20 })
    await controller.flush()

    expect(failedClient.updateWindowState).toHaveBeenCalledTimes(2)
    expect(replacementClient.updateWindowState).toHaveBeenCalledTimes(1)
    expect(replacementClient.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 21, x: 470, y: 350, width: 1180, height: 780 })
    })
  })

  it('retries a failed normalization write through a replacement client', async () => {
    const fixture = windowFixture()
    fixture.setBounds({ x: 100, y: 120, width: 900, height: 700 })
    const failedClient = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn().mockRejectedValue(new Error('service unavailable'))
    } satisfies WindowStateClient
    const replacementClient = {
      getWindowState: vi.fn(),
      updateWindowState: vi.fn(async ({ state: next }) => ({ state: next }))
    } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })

    controller.setClient(failedClient, { ...state, revision: 8, width: 570 })
    await expect(controller.flush()).rejects.toThrow('service unavailable')
    controller.clearClient()
    controller.setClient(replacementClient, { ...state, revision: 22, width: 900 })
    await controller.flush()

    expect(failedClient.updateWindowState).toHaveBeenCalledTimes(1)
    expect(replacementClient.updateWindowState).toHaveBeenCalledTimes(1)
    expect(replacementClient.updateWindowState).toHaveBeenCalledWith({
      state: expect.objectContaining({ revision: 23, width: 900 })
    })
  })

  it('persists newer geometry after an older in-flight update succeeds', async () => {
    const fixture = windowFixture()
    let scheduled: (() => void) | undefined
    const firstUpdate = deferred<{ state: typeof state }>()
    const updateWindowState = vi
      .fn()
      .mockImplementationOnce(() => firstUpdate.promise)
      .mockImplementation(async ({ state: next }) => ({ state: next }))
    const client = { getWindowState: vi.fn(), updateWindowState } satisfies WindowStateClient
    const controller = new WindowStateController(fixture.window, {
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule: vi.fn(),
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    })
    controller.setClient(client, state)

    fixture.setBounds({ x: 230, y: 240, width: 1020, height: 720 })
    fixture.emit('move')
    scheduled?.()
    const firstFlush = controller.flush()
    await vi.waitFor(() => expect(updateWindowState).toHaveBeenCalledTimes(1))

    fixture.setBounds({ x: 680, y: 460, width: 1280, height: 840 })
    fixture.emit('resize')
    firstUpdate.resolve({
      state: { ...state, revision: 5, x: 230, y: 240, width: 1020, height: 720 }
    })
    await firstFlush
    await controller.flush()

    expect(updateWindowState).toHaveBeenCalledTimes(2)
    expect(updateWindowState.mock.calls[0]?.[0]).toEqual({
      state: expect.objectContaining({ revision: 5, x: 230, y: 240, width: 1020, height: 720 })
    })
    expect(updateWindowState.mock.calls[1]?.[0]).toEqual({
      state: expect.objectContaining({ revision: 6, x: 680, y: 460, width: 1280, height: 840 })
    })
  })
})
