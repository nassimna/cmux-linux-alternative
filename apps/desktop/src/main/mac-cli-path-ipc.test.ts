import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '@agent-workspace/contracts/desktop/desktop-bridge'
import type { WindowRegistryEntry } from './window-registry'
import type { SenderBoundHandler } from './sender-bound-ipc-router'
import { MacCliPathInstaller } from './mac-cli-path-installer'
import { registerMacCliPathHandlers } from './mac-cli-path-ipc'

function fixture(supported = true) {
  const handlers = new Map<string, SenderBoundHandler>()
  const installer = new MacCliPathInstaller({
    sourcePath: '/Applications/Ternline.app/Contents/Resources/cli/ternline-cli'
  })
  const install = vi.spyOn(installer, 'install').mockResolvedValue(undefined)
  const uninstall = vi.spyOn(installer, 'uninstall').mockResolvedValue(undefined)
  vi.spyOn(installer, 'isInstalled').mockResolvedValue(false)
  const showMessageBox = vi.fn().mockResolvedValue({ response: 0 })
  registerMacCliPathHandlers(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    },
    {
      supported: () => supported,
      installer,
      showMessageBox
    }
  )
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)?.({ window: {} } as WindowRegistryEntry, {} as never, ...args)
  return { invoke, install, uninstall, showMessageBox }
}

describe('Mac CLI installation IPC', () => {
  it('only reads state at registration and installs after the explicit action', async () => {
    const { invoke, install, uninstall, showMessageBox } = fixture()
    expect(await invoke(DESKTOP_IPC.cliPathInstalled)).toBe(false)
    expect(install).not.toHaveBeenCalled()
    expect(uninstall).not.toHaveBeenCalled()
    await invoke(DESKTOP_IPC.cliPathInstall)
    expect(install).toHaveBeenCalledOnce()
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'ternline-cli installed' })
    )
    await invoke(DESKTOP_IPC.cliPathUninstall)
    expect(uninstall).toHaveBeenCalledOnce()
  })

  it('rejects renderer-supplied paths and unsupported platforms before touching the filesystem', async () => {
    const { invoke, install } = fixture()
    await expect(invoke(DESKTOP_IPC.cliPathInstall, '/untrusted/path')).rejects.toThrow(
      'Invalid CLI installation request'
    )
    expect(install).not.toHaveBeenCalled()
    const unsupported = fixture(false)
    await expect(unsupported.invoke(DESKTOP_IPC.cliPathInstall)).rejects.toThrow('packaged Mac app')
    expect(unsupported.install).not.toHaveBeenCalled()
  })

  it('reports an installation failure without displaying a success message', async () => {
    const { invoke, install, showMessageBox } = fixture()
    install.mockRejectedValue(new Error('User cancelled'))
    await invoke(DESKTOP_IPC.cliPathInstall)
    expect(showMessageBox).toHaveBeenCalledOnce()
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'error', detail: 'User cancelled' })
    )
  })
})
