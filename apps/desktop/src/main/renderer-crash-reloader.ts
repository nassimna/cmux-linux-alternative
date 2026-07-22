import type { BrowserWindow } from 'electron'

/** Reloads the trusted document and permits one bounded sandbox-preload retry. */
export async function reloadRendererAfterCrash(window: BrowserWindow): Promise<void> {
  if (await reloadAndVerify(window).catch(() => false)) return
  if (await reloadAndVerify(window)) return
  throw new Error('Renderer preload bridge is unavailable after retry')
}

async function reloadAndVerify(window: BrowserWindow): Promise<boolean> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      window.webContents.removeListener('did-finish-load', loaded)
      window.webContents.removeListener('did-fail-load', loadFailed)
      window.webContents.removeListener('preload-error', preloadFailed)
    }
    const loaded = (): void => {
      cleanup()
      resolve()
    }
    const loadFailed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string
    ): void => {
      cleanup()
      reject(new Error(`Renderer reload failed (${String(errorCode)}): ${errorDescription}`))
    }
    const preloadFailed = (_event: Electron.Event, _preloadPath: string, error: Error): void => {
      cleanup()
      reject(error)
    }
    window.webContents.once('did-finish-load', loaded)
    window.webContents.once('did-fail-load', loadFailed)
    window.webContents.once('preload-error', preloadFailed)
    window.webContents.reload()
  })
  return hasDesktopBridge(window)
}

function hasDesktopBridge(window: BrowserWindow): Promise<boolean> {
  return window.webContents
    .executeJavaScript('Boolean(globalThis.desktopBridge)')
    .then((value) => value === true)
    .catch(() => false)
}
