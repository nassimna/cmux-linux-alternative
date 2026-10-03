// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserHost } from './BrowserHost'
import type { BrowserBridge } from './types'
import { browserMessages } from '@agent-workspace/contracts/desktop/browser-messages'

let resizeCallback: ResizeObserverCallback
let nextFrame = 1
let frames = new Map<number, FrameRequestCallback>()

beforeEach(() => {
  frames = new Map()
  nextFrame = 1
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    }
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BrowserHost', () => {
  it('reacquires a native browser view with a fresh lifecycle after a main-process rebind', async () => {
    let rebind: (() => void) | undefined
    const bridge = createBridge()
    const onBrowserViewsRebind: NonNullable<BrowserBridge['onBrowserViewsRebind']> = (listener) => {
      rebind = listener
      return () => undefined
    }
    bridge.onBrowserViewsRebind = vi.fn(onBrowserViewsRebind)
    renderHost(bridge)
    await settle()
    const firstLifecycle = vi.mocked(bridge.mountBrowserView).mock.calls[0]?.[0].lifecycleId

    rebind?.()
    await settle()

    const secondLifecycle = vi.mocked(bridge.mountBrowserView).mock.calls[1]?.[0].lifecycleId
    expect(bridge.mountBrowserView).toHaveBeenCalledTimes(2)
    expect(secondLifecycle).not.toBe(firstLifecycle)
    expect(bridge.unmountBrowserView).toHaveBeenCalledWith({
      browserSessionId: 'browser-1',
      lifecycleId: firstLifecycle
    })
  })

  it('coalesces resize observations and sends monotonic content-area bounds', async () => {
    const bridge = createBridge()
    renderHost(bridge)
    await settle()
    const host = screen.getByRole('document', { name: 'Browser content' })
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(12, 34, 640, 480))

    resizeCallback([], {} as ResizeObserver)
    resizeCallback([], {} as ResizeObserver)
    expect(frames.size).toBe(1)
    runFrame()
    const lifecycleId = vi.mocked(bridge.mountBrowserView).mock.calls[0]![0].lifecycleId

    expect(bridge.setBrowserBounds).toHaveBeenLastCalledWith({
      browserSessionId: 'browser-1',
      lifecycleId,
      revision: 1,
      x: 12,
      y: 34,
      width: 640,
      height: 480,
      visible: true
    })

    resizeCallback([], {} as ResizeObserver)
    runFrame()
    expect(vi.mocked(bridge.setBrowserBounds).mock.calls.at(-1)?.[0].revision).toBe(2)
  })

  it('hides zero bounds and immediately hides while an overlay is visible', async () => {
    const bridge = createBridge()
    const view = renderHost(bridge)
    await settle()
    const host = screen.getByRole('document', { name: 'Browser content' })
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 0, 200))
    runFrame()
    const lifecycleId = vi.mocked(bridge.mountBrowserView).mock.calls[0]![0].lifecycleId
    expect(bridge.setBrowserBounds).toHaveBeenLastCalledWith({
      browserSessionId: 'browser-1',
      lifecycleId,
      revision: 1,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false
    })

    view.rerender(hostElement(bridge, false))
    expect(frames.size).toBe(0)
    expect(vi.mocked(bridge.setBrowserBounds).mock.calls).toHaveLength(1)
  })

  it('hides before unmounting, cancels stale frames, and does not update after unmount', async () => {
    const events: string[] = []
    const bridge = createBridge(events)
    const view = renderHost(bridge)
    await settle()
    expect(frames.size).toBe(1)

    view.unmount()
    expect(frames.size).toBe(0)
    await settle()
    expect(events).toEqual(['mount', 'bounds:hidden:1', 'unmount'])
    expect(bridge.setBrowserBounds).toHaveBeenCalledBefore(vi.mocked(bridge.unmountBrowserView))
  })

  it('versions deferred cleanup so it cannot tear down a replacement host lifecycle', async () => {
    const oldMount = deferred<void>()
    const bridge = createBridge()
    vi.mocked(bridge.mountBrowserView)
      .mockImplementationOnce(() => oldMount.promise)
      .mockResolvedValue(undefined)
    const view = renderHost(bridge)
    const oldLifecycleId = vi.mocked(bridge.mountBrowserView).mock.calls[0]?.[0].lifecycleId

    view.rerender(hostElement(bridge, true, 'tab-2'))
    await settle()
    const replacementLifecycleId = vi.mocked(bridge.mountBrowserView).mock.calls[1]?.[0].lifecycleId
    expect(replacementLifecycleId).toEqual(expect.any(String))
    expect(replacementLifecycleId).not.toBe(oldLifecycleId)

    oldMount.resolve()
    await settle()
    await settle()
    expect(bridge.unmountBrowserView).toHaveBeenCalledWith({
      browserSessionId: 'browser-1',
      lifecycleId: oldLifecycleId
    })
    expect(bridge.setBrowserBounds).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleId: oldLifecycleId, visible: false })
    )

    view.unmount()
    await settle()
    expect(bridge.unmountBrowserView).toHaveBeenLastCalledWith({
      browserSessionId: 'browser-1',
      lifecycleId: replacementLifecycleId
    })
    expect(bridge.unmountBrowserView).toHaveBeenCalledTimes(2)
  })

  it('focuses the native view on explicit pointer and focus transitions', async () => {
    const bridge = createBridge()
    renderHost(bridge)
    await settle()
    const host = screen.getByRole('document', { name: 'Browser content' })
    fireEvent.pointerDown(host)
    fireEvent.focus(host)
    const lifecycleId = vi.mocked(bridge.mountBrowserView).mock.calls[0]![0].lifecycleId
    expect(bridge.focusBrowserView).toHaveBeenCalledTimes(2)
    expect(bridge.focusBrowserView).toHaveBeenCalledWith({
      browserSessionId: 'browser-1',
      lifecycleId
    })
  })

  it('uses catalog copy for the native content placeholder accessible name', () => {
    const bridge = createBridge()
    render(
      <BrowserHost
        bridge={bridge}
        browserSessionId="browser-1"
        messages={{
          ...browserMessages,
          pane: { ...browserMessages.pane, content: 'Localized browser content' }
        }}
        tabId="tab-1"
        visible
        workspaceId="workspace-1"
      />
    )

    expect(screen.getByRole('document', { name: 'Localized browser content' })).toBeVisible()
  })
})

function hostElement(bridge: BrowserBridge, visible = true, tabId = 'tab-1'): React.JSX.Element {
  return (
    <BrowserHost
      bridge={bridge}
      browserSessionId="browser-1"
      tabId={tabId}
      visible={visible}
      workspaceId="workspace-1"
    />
  )
}

function renderHost(bridge: BrowserBridge) {
  return render(hostElement(bridge))
}

async function settle(): Promise<void> {
  await act(async () => Promise.resolve())
}

function runFrame(): void {
  const pending = [...frames.entries()]
  frames.clear()
  for (const [, callback] of pending) callback(0)
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({})
  }
}

function createBridge(events: string[] = []): BrowserBridge {
  const method = () => vi.fn().mockResolvedValue(undefined)
  return {
    mountBrowserView: vi.fn().mockImplementation(() => {
      events.push('mount')
      return Promise.resolve()
    }),
    unmountBrowserView: vi.fn().mockImplementation(() => {
      events.push('unmount')
      return Promise.resolve()
    }),
    setBrowserBounds: vi.fn().mockImplementation((params) => {
      events.push(`bounds:${params.visible ? 'visible' : 'hidden'}:${String(params.revision)}`)
      return Promise.resolve()
    }),
    focusBrowserView: method(),
    navigateBrowser: method(),
    browserBack: method(),
    browserForward: method(),
    reloadBrowser: method(),
    stopBrowser: method(),
    openBrowserDevTools: method(),
    openExternal: method()
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
