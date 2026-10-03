import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { DESKTOP_IPC } from '@agent-workspace/contracts/desktop/desktop-bridge'

import type { MacCliPathInstaller } from './mac-cli-path-installer'
import type { SenderBoundIpcRouter } from './sender-bound-ipc-router'

export function registerMacCliPathHandlers(
  router: Pick<SenderBoundIpcRouter, 'handle'>,
  options: {
    supported: () => boolean
    installer: MacCliPathInstaller
    showMessageBox: (window: BrowserWindow, options: MessageBoxOptions) => Promise<unknown>
  }
): void {
  let busy = false
  const validate = (args: unknown[]) => {
    if (args.length !== 0) throw new Error('Invalid CLI installation request')
    if (!options.supported()) throw new Error('CLI installation requires the packaged Mac app')
  }
  router.handle(DESKTOP_IPC.cliPathInstalled, (_entry, _event, ...args) => {
    validate(args)
    return options.installer.isInstalled()
  })
  for (const action of ['install', 'uninstall'] as const) {
    const channel = action === 'install' ? DESKTOP_IPC.cliPathInstall : DESKTOP_IPC.cliPathUninstall
    router.handle(channel, async (entry, _event, ...args) => {
      validate(args)
      if (busy) throw new Error('Another CLI installation action is in progress')
      busy = true
      try {
        await options.installer[action]()
        await options.showMessageBox(entry.window, {
          type: 'info',
          message: action === 'install' ? 'ternline-cli installed' : 'ternline-cli uninstalled',
          detail:
            action === 'install'
              ? `You can now use ternline-cli in external terminals whose PATH includes /usr/local/bin.\n\n${options.installer.destinationPath} → ${options.installer.sourcePath}`
              : `Removed the Ternline command from ${options.installer.destinationPath}. The bundled CLI remains available inside Ternline.`,
          buttons: ['OK']
        })
      } catch (error) {
        await options.showMessageBox(entry.window, {
          type: 'error',
          message:
            action === 'install'
              ? 'Could not install ternline-cli'
              : 'Could not uninstall ternline-cli',
          detail: error instanceof Error ? error.message : 'The requested action failed.',
          buttons: ['OK']
        })
      } finally {
        busy = false
      }
    })
  }
}
