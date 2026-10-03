import type { BrowserBackParams, BrowserSessionState } from '@agent-workspace/protocol-client'
import type { DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'

export type { BrowserSessionState }

export type BrowserBridge = Pick<
  DesktopBridge,
  | 'mountBrowserView'
  | 'unmountBrowserView'
  | 'setBrowserBounds'
  | 'focusBrowserView'
  | 'navigateBrowser'
  | 'browserBack'
  | 'browserForward'
  | 'reloadBrowser'
  | 'stopBrowser'
  | 'openBrowserDevTools'
  | 'openExternal'
  | 'onBrowserViewsRebind'
>

export function browserBridge(value: DesktopBridge): BrowserBridge {
  return value
}

export function browserCommandParams(state: BrowserSessionState): BrowserBackParams {
  return {
    browserSessionId: state.browserSessionId,
    expectedStateRevision: state.stateRevision,
    correlationId: createCorrelationId()
  }
}

function createCorrelationId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const randomHex = (): string => Math.floor(Math.random() * 16).toString(16)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (value) => {
    const random = Number.parseInt(randomHex(), 16)
    return (value === 'x' ? random : (random & 0x3) | 0x8).toString(16)
  })
}
