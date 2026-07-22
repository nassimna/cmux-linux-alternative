import type { BrowserWindowConstructorOptions } from 'electron'
import type { WindowStateSnapshot } from '@agent-workspace/protocol-client'

export function createWindowOptions(
  preloadPath: string,
  savedState?: WindowStateSnapshot,
  platform: NodeJS.Platform = process.platform
): BrowserWindowConstructorOptions {
  return {
    width: savedState?.width ?? 1280,
    height: savedState?.height ?? 800,
    ...(savedState ? { x: savedState.x, y: savedState.y } : { center: true }),
    ...(savedState?.fullscreen ? { fullscreen: true } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    ...(platform === 'darwin' ? {} : { autoHideMenuBar: true }),
    backgroundColor: '#111318',
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  }
}
