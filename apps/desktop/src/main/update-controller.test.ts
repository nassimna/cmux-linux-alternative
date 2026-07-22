import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'
import { desktopMessages } from '../shared/desktop-messages'

import {
  detectLinuxPackageType,
  detectNativeUpdatePackageType,
  parseUpdateFeedConfiguration,
  UpdateController,
  type ElectronUpdaterAdapter,
  type UpdateControllerOptions,
  type UpdateFeedConfiguration
} from './update-controller'

const feeds: UpdateFeedConfiguration = {
  stable: 'https://updates.test.invalid/stable/',
  beta: 'https://updates.test.invalid/beta/'
}

describe('update feed configuration', () => {
  it('requires both distinct trusted HTTPS roots and fixes their trailing slash', () => {
    expect(
      parseUpdateFeedConfiguration({
        AGENT_WORKSPACE_UPDATE_STABLE_URL: 'https://updates.test.invalid/stable',
        AGENT_WORKSPACE_UPDATE_BETA_URL: 'https://updates.test.invalid/beta/'
      })
    ).toEqual(feeds)
    expect(parseUpdateFeedConfiguration({})).toBeNull()
  })

  it.each([
    { AGENT_WORKSPACE_UPDATE_STABLE_URL: feeds.stable },
    {
      AGENT_WORKSPACE_UPDATE_STABLE_URL: feeds.stable,
      AGENT_WORKSPACE_UPDATE_BETA_URL: feeds.stable
    },
    {
      AGENT_WORKSPACE_UPDATE_STABLE_URL: 'http://updates.test.invalid/stable/',
      AGENT_WORKSPACE_UPDATE_BETA_URL: feeds.beta
    },
    {
      AGENT_WORKSPACE_UPDATE_STABLE_URL: 'https://user:token@updates.test.invalid/stable/',
      AGENT_WORKSPACE_UPDATE_BETA_URL: feeds.beta
    },
    {
      AGENT_WORKSPACE_UPDATE_STABLE_URL: 'https://127.0.0.1/stable/',
      AGENT_WORKSPACE_UPDATE_BETA_URL: feeds.beta
    },
    {
      AGENT_WORKSPACE_UPDATE_STABLE_URL: 'https://updates.test.invalid/stable/?token=secret',
      AGENT_WORKSPACE_UPDATE_BETA_URL: feeds.beta
    }
  ])('rejects unsafe or incomplete feed configuration %#', (environment) => {
    expect(() => parseUpdateFeedConfiguration(environment)).toThrow()
  })

  it('permits local HTTP only through the explicit test injection path', () => {
    expect(() =>
      parseUpdateFeedConfiguration({
        AGENT_WORKSPACE_UPDATE_STABLE_URL: 'http://127.0.0.1:4100/stable/',
        AGENT_WORKSPACE_UPDATE_BETA_URL: 'http://127.0.0.1:4100/beta/'
      })
    ).toThrow()
    expect(
      parseUpdateFeedConfiguration(
        {
          AGENT_WORKSPACE_UPDATE_STABLE_URL: 'http://127.0.0.1:4100/stable/',
          AGENT_WORKSPACE_UPDATE_BETA_URL: 'http://127.0.0.1:4100/beta/'
        },
        { allowLocalTestFeeds: true }
      )
    ).toMatchObject({ stable: 'http://127.0.0.1:4100/stable/' })
  })
})

describe('update controller', () => {
  it.each([
    [{ feeds: null }, 'unconfigured'],
    [{ isPackaged: false }, 'development'],
    [{ packageType: null }, 'unsupported'],
    [{ platform: 'darwin' as NodeJS.Platform }, 'unsupported'],
    [{ platform: 'darwin' as NodeJS.Platform, packageType: 'nsis' as const }, 'unsupported'],
    [{ platform: 'win32' as NodeJS.Platform, packageType: 'mac' as const }, 'unsupported']
  ])('gates unavailable environments %#', (override, expected) => {
    const { controller, updater } = createController(override)
    expect(controller.getState().status).toBe(expected)
    expect(updater.setFeedURL).not.toHaveBeenCalled()
  })

  it.each<[NodeJS.Platform, 'mac' | 'nsis']>([
    ['darwin', 'mac'],
    ['win32', 'nsis']
  ])('supports the configured native updater on %s', (platform, packageType) => {
    const { controller, updater } = createController({ platform, packageType })
    expect(controller.getState()).toEqual({ status: 'idle', channel: 'stable', packageType })
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: feeds.stable,
      channel: 'stable'
    })
  })

  it('isolates stable and beta provider roots and reuses only one periodic loop', () => {
    const intervals: Array<{ callback: () => void }> = []
    const clearInterval = vi.fn()
    const { controller, updater } = createController({
      setInterval: (callback) => {
        const handle = { callback, unref: vi.fn() }
        intervals.push(handle)
        return handle
      },
      clearInterval
    })
    expect(updater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: feeds.stable,
      channel: 'stable'
    })

    controller.applyChannel('beta')
    expect(clearInterval).toHaveBeenCalledOnce()
    expect(updater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: feeds.beta,
      channel: 'beta'
    })
    expect(updater.allowPrerelease).toBe(true)
    expect(updater.allowDowngrade).toBe(false)
    expect(intervals).toHaveLength(2)
  })

  it('deduplicates checks, defers channel switches, and never auto-downloads', async () => {
    const check = deferred<void>()
    const { controller, updater } = createController()
    updater.checkForUpdates.mockReturnValue(check.promise)

    const first = controller.check()
    const second = controller.check()
    controller.applyChannel('beta')
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(controller.getState()).toMatchObject({ status: 'checking', channel: 'stable' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    updater.emit('update-not-available', { version: '0.1.0' })
    check.resolve()
    await Promise.all([first, second])
    expect(controller.getState()).toMatchObject({ status: 'idle', channel: 'beta' })
    expect(updater.setFeedURL).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: feeds.beta,
        channel: 'beta'
      })
    )
  })

  it('downloads only after availability and installs only after explicit approval', async () => {
    const approval = deferred<void>()
    const beforeInstall = vi.fn().mockReturnValue(approval.promise)
    const { controller, updater } = createController({ beforeInstall })
    await controller.download()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    updater.emit('update-available', { version: '1.2.3-beta.1' })
    const download = deferred<void>()
    updater.downloadUpdate.mockReturnValue(download.promise)
    const first = controller.download()
    void controller.download()
    updater.emit('download-progress', { percent: 41.6 })
    expect(controller.getState()).toMatchObject({ status: 'downloading', progress: 41.6 })
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    download.resolve()
    await first
    expect(controller.getState()).toMatchObject({ status: 'downloaded', version: '1.2.3-beta.1' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    const install = controller.install()
    void controller.install()
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    approval.resolve()
    await install
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('reports a synchronous quitAndInstall failure after reversible preparation', async () => {
    const beforeInstall = vi.fn().mockResolvedValue(undefined)
    const { controller, updater } = createController({ beforeInstall })
    updater.emit('update-downloaded', { version: '1.2.3' })
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error('installer handoff failed')
    })

    await expect(controller.install()).resolves.toBeUndefined()

    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(controller.getState()).toEqual({
      status: 'error',
      channel: 'stable',
      packageType: 'appimage',
      message: desktopMessages.updater.failure
    })
  })

  it('sanitizes updater errors and disposes listeners and timers', async () => {
    const clearInterval = vi.fn()
    const { controller, updater } = createController({ clearInterval })
    const listener = vi.fn()
    controller.subscribe(listener)
    updater.checkForUpdates.mockRejectedValue(
      new Error('https://token:secret@updates.test.invalid/private\nstack')
    )
    await controller.check()
    expect(controller.getState()).toEqual({
      status: 'error',
      channel: 'stable',
      packageType: 'appimage',
      message: desktopMessages.updater.failure
    })
    expect(JSON.stringify(listener.mock.calls)).not.toContain('secret')

    controller.dispose()
    updater.emit('update-available', { version: '9.9.9' })
    expect(controller.getState().status).toBe('error')
    expect(clearInterval).toHaveBeenCalledOnce()
    expect(updater.listenerCount('update-available')).toBe(0)
  })
})

describe('Linux package detection', () => {
  it('recognizes AppImage and builder package markers without guessing', () => {
    expect(
      detectLinuxPackageType({ appImagePath: '/tmp/app.AppImage', resourcesPath: '/app' })
    ).toBe('appimage')
    expect(
      detectLinuxPackageType({
        resourcesPath: '/app',
        readPackageType: () => 'deb\n'
      })
    ).toBe('deb')
    expect(
      detectLinuxPackageType({
        resourcesPath: '/app',
        readPackageType: () => 'tar.gz'
      })
    ).toBeNull()
    expect(
      detectLinuxPackageType({
        resourcesPath: '/app',
        readPackageType: () => {
          throw new Error('missing')
        }
      })
    ).toBeNull()
  })
})

describe('native update package detection', () => {
  const linuxOptions = { resourcesPath: '/app', readPackageType: () => 'rpm\n' }

  it('maps only configured native installer families', () => {
    expect(detectNativeUpdatePackageType('linux', linuxOptions)).toBe('rpm')
    expect(detectNativeUpdatePackageType('darwin', linuxOptions)).toBe('mac')
    expect(detectNativeUpdatePackageType('win32', linuxOptions)).toBe('nsis')
    expect(detectNativeUpdatePackageType('freebsd', linuxOptions)).toBeNull()
  })
})

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  allowPrerelease = false
  channel: string | null = null
  setFeedURL = vi.fn()
  checkForUpdates = vi.fn().mockResolvedValue(undefined)
  downloadUpdate = vi.fn().mockResolvedValue(undefined)
  quitAndInstall = vi.fn()
}

function createController(override: Partial<UpdateControllerOptions> = {}): {
  controller: UpdateController
  updater: FakeUpdater
} {
  const updater = new FakeUpdater()
  const options: UpdateControllerOptions = {
    feeds,
    isPackaged: true,
    packageType: 'appimage',
    platform: 'linux',
    updater: updater as unknown as ElectronUpdaterAdapter,
    beforeInstall: vi.fn().mockResolvedValue(undefined),
    setInterval: () => ({ unref: vi.fn() }),
    clearInterval: vi.fn(),
    ...override
  }
  return { controller: new UpdateController(options), updater }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}
