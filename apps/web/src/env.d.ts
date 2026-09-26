/// <reference types="vite/client" />

import type { DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'

declare global {
  interface Window {
    desktopBridge: DesktopBridge
  }
}

export {}
