import { useEffect, useRef, useState } from 'react'

import {
  browserMessages,
  type BrowserMessages
} from '@agent-workspace/contracts/desktop/browser-messages'
import type { BrowserBridge } from './types'

interface BrowserHostProps {
  bridge: BrowserBridge
  browserSessionId: string
  messages?: BrowserMessages
  tabId: string
  visible: boolean
  workspaceId: string
}

interface HostController {
  lifecycleId: string
  hide(): void
  schedule(): void
}

const HIDDEN_BOUNDS = { x: 0, y: 0, width: 0, height: 0, visible: false } as const

export function BrowserHost({
  bridge,
  browserSessionId,
  messages = browserMessages,
  tabId,
  visible,
  workspaceId
}: BrowserHostProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const visibleRef = useRef(visible)
  const controllerRef = useRef<HostController | null>(null)
  const [nativeBindingGeneration, setNativeBindingGeneration] = useState(0)

  useEffect(
    () => bridge.onBrowserViewsRebind?.(() => setNativeBindingGeneration((value) => value + 1)),
    [bridge]
  )

  useEffect(() => {
    const element = hostRef.current
    if (!element || !browserSessionId) return

    const lifecycleId = createLifecycleId()
    let active = true
    let mounted = false
    let revision = 0
    let frame: number | null = null
    let hidden = false

    const sendHidden = (): Promise<void> => {
      if (hidden) return Promise.resolve()
      hidden = true
      return bridge.setBrowserBounds({
        browserSessionId,
        lifecycleId,
        revision: ++revision,
        ...HIDDEN_BOUNDS
      })
    }
    const measure = (): void => {
      frame = null
      if (!active || !mounted) return
      const rect = element.getBoundingClientRect()
      const shell = element.closest<HTMLElement>('.workspace-shell')
      const tools = shell?.querySelector<HTMLElement>(':scope > .right-sidebar')
      const toolsRect =
        tools && getComputedStyle(tools).position === 'absolute'
          ? tools.getBoundingClientRect()
          : undefined
      const width =
        toolsRect &&
        toolsRect.top < rect.bottom &&
        toolsRect.bottom > rect.top &&
        toolsRect.left < rect.right &&
        toolsRect.right > rect.left
          ? Math.max(0, Math.min(rect.width, toolsRect.left - rect.left))
          : rect.width
      if (!visibleRef.current || width <= 0 || rect.height <= 0) {
        void sendHidden().catch(() => undefined)
        return
      }
      hidden = false
      void bridge
        .setBrowserBounds({
          browserSessionId,
          lifecycleId,
          revision: ++revision,
          x: rect.x,
          y: rect.y,
          width,
          height: rect.height,
          visible: true
        })
        .catch(() => undefined)
    }
    const schedule = (): void => {
      if (!active || frame !== null) return
      frame = requestAnimationFrame(measure)
    }
    const hide = (): void => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      if (mounted) void sendHidden().catch(() => undefined)
    }
    controllerRef.current = { lifecycleId, hide, schedule }

    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    const shell = element.closest<HTMLElement>('.workspace-shell')
    const shellObserver = shell ? new MutationObserver(schedule) : undefined
    if (shell && shellObserver) {
      shellObserver.observe(shell, {
        childList: true,
        attributes: true,
        attributeFilter: ['class']
      })
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)

    const mount = Promise.resolve(
      bridge.mountBrowserView({ workspaceId, tabId, browserSessionId, lifecycleId })
    ).then(
      async () => {
        mounted = true
        if (!active || !visibleRef.current) await sendHidden()
        else schedule()
        return true
      },
      () => false
    )

    return () => {
      active = false
      controllerRef.current = null
      observer.disconnect()
      shellObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      const hideBeforeUnmount = mounted
        ? sendHidden()
        : mount.then((wasMounted) => (wasMounted ? sendHidden() : undefined))
      void hideBeforeUnmount
        .catch(() => undefined)
        .then(() => bridge.unmountBrowserView({ browserSessionId, lifecycleId }))
        .catch(() => undefined)
    }
  }, [bridge, browserSessionId, nativeBindingGeneration, tabId, workspaceId])

  useEffect(() => {
    visibleRef.current = visible
    const controller = controllerRef.current
    if (!controller) return
    if (visible) controller.schedule()
    else controller.hide()
  }, [visible])

  const focusBrowser = (): void => {
    const lifecycleId = controllerRef.current?.lifecycleId
    if (visible && lifecycleId) {
      void bridge.focusBrowserView({ browserSessionId, lifecycleId }).catch(() => undefined)
    }
  }

  return (
    <div
      aria-label={messages.pane.content}
      className="browser-host"
      data-browser-session-id={browserSessionId}
      onFocus={focusBrowser}
      onPointerDown={focusBrowser}
      ref={hostRef}
      role="document"
      tabIndex={0}
    />
  )
}

function createLifecycleId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const randomHex = (): string => Math.floor(Math.random() * 16).toString(16)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (value) => {
    const random = Number.parseInt(randomHex(), 16)
    return (value === 'x' ? random : (random & 0x3) | 0x8).toString(16)
  })
}
