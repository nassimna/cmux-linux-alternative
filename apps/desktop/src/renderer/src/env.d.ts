/// <reference types="vite/client" />

import type { DesktopBridge } from '../../shared/desktop-bridge'

declare global {
  interface Window {
    desktopBridge: DesktopBridge
  }
}

export {}
