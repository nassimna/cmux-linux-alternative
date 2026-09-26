import { isIP } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  DesktopUpdateChannel,
  DesktopUpdatePackageType,
  DesktopUpdateState
} from '@agent-workspace/contracts/desktop/desktop-bridge'
import { parseDesktopUpdateState } from '@agent-workspace/contracts/desktop/desktop-bridge'
import { desktopMessages } from '@agent-workspace/contracts/desktop/desktop-messages'

const FEED_URL_MAX_LENGTH = 2_048
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

export interface UpdateFeedConfiguration {
  stable: string
  beta: string
}

export interface UpdateInfoLike {
  version: string
}

export interface UpdateProgressLike {
  percent: number
}

export interface ElectronUpdaterAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  channel: string | null
  setFeedURL(options: { provider: 'generic'; url: string; channel: string }): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'checking-for-update', listener: () => void): unknown
  on(
    event: 'update-available' | 'update-not-available' | 'update-downloaded',
    listener: (info: UpdateInfoLike) => void
  ): unknown
  on(event: 'download-progress', listener: (progress: UpdateProgressLike) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
}

interface IntervalHandle {
  unref?(): void
}

export interface UpdateControllerOptions {
  feeds: UpdateFeedConfiguration | null
  isPackaged: boolean
  packageType: DesktopUpdatePackageType | null
  platform: NodeJS.Platform
  updater: ElectronUpdaterAdapter
  // This preparation must be safe to return from: quitAndInstall can fail before Electron emits
  // before-quit, so irreversible application teardown belongs in the before-quit handler.
  beforeInstall(): Promise<void>
  checkIntervalMs?: number
  setInterval?: (callback: () => void, milliseconds: number) => IntervalHandle
  clearInterval?: (handle: IntervalHandle) => void
}

export class UpdateController {
  private channel: DesktopUpdateChannel = 'stable'
  private state: DesktopUpdateState
  private inFlight: Promise<DesktopUpdateState> | null = null
  private pendingChannel: DesktopUpdateChannel | null = null
  private installInProgress = false
  private readonly listeners = new Set<(state: DesktopUpdateState) => void>()
  private interval: IntervalHandle | undefined
  private disposed = false

  private readonly onChecking = (): void => {
    if (this.canOperate()) this.setState(this.baseState('checking'))
  }

  private readonly onAvailable = (info: UpdateInfoLike): void => {
    if (!this.canOperate()) return
    const version = safeVersion(info?.version)
    if (version) this.setState({ ...this.baseState('available'), version })
    else this.setError()
  }

  private readonly onNotAvailable = (): void => {
    if (this.canOperate()) this.setState(this.baseState('up-to-date'))
  }

  private readonly onProgress = (progress: UpdateProgressLike): void => {
    if (this.state.status !== 'downloading') return
    const rawPercent = progress?.percent
    const percent =
      typeof rawPercent === 'number' && Number.isFinite(rawPercent)
        ? Math.max(0, Math.min(100, rawPercent))
        : 0
    this.setState({ ...this.state, progress: percent })
  }

  private readonly onDownloaded = (info: UpdateInfoLike): void => {
    if (!this.canOperate()) return
    const version = safeVersion(info?.version)
    if (version) this.setState({ ...this.baseState('downloaded'), version })
    else this.setError()
  }

  private readonly onError = (): void => this.setError()

  constructor(private readonly options: UpdateControllerOptions) {
    this.state = this.availabilityState()
    options.updater.autoDownload = false
    options.updater.autoInstallOnAppQuit = false
    options.updater.allowDowngrade = false
    options.updater.allowPrerelease = false
    options.updater.on('checking-for-update', this.onChecking)
    options.updater.on('update-available', this.onAvailable)
    options.updater.on('update-not-available', this.onNotAvailable)
    options.updater.on('download-progress', this.onProgress)
    options.updater.on('update-downloaded', this.onDownloaded)
    options.updater.on('error', this.onError)
    if (this.canOperate()) this.configureUpdater()
  }

  getState(): DesktopUpdateState {
    return parseDesktopUpdateState(this.state)
  }

  applyChannel(channel: DesktopUpdateChannel): DesktopUpdateState {
    if (this.disposed || this.channel === channel) return this.getState()
    if (this.inFlight) {
      this.pendingChannel = channel
      return this.getState()
    }
    this.channel = channel
    this.pendingChannel = null
    this.stopPeriodicChecks()
    this.state = this.availabilityState()
    if (this.canOperate()) this.configureUpdater()
    this.emit()
    return this.getState()
  }

  check(): Promise<DesktopUpdateState> {
    if (!this.canOperate()) return Promise.resolve(this.getState())
    if (this.inFlight) return this.inFlight
    if (
      this.state.status === 'available' ||
      this.state.status === 'downloading' ||
      this.state.status === 'downloaded'
    ) {
      return Promise.resolve(this.getState())
    }
    const channel = this.channel
    this.setState(this.baseState('checking'))
    return this.run(async () => {
      await this.options.updater.checkForUpdates()
      if (this.channel === channel && this.state.status === 'checking') {
        this.setState(this.baseState('up-to-date'))
      }
      return this.getState()
    })
  }

  download(): Promise<DesktopUpdateState> {
    if (!this.canOperate() || this.state.status !== 'available') {
      return Promise.resolve(this.getState())
    }
    if (this.inFlight) return this.inFlight
    const version = this.state.version
    const channel = this.channel
    this.setState({ ...this.baseState('downloading'), version, progress: 0 })
    return this.run(async () => {
      await this.options.updater.downloadUpdate()
      if (this.channel === channel && this.state.status === 'downloading') {
        this.setState({ ...this.baseState('downloaded'), version })
      }
      return this.getState()
    })
  }

  async install(): Promise<void> {
    if (
      !this.canOperate() ||
      this.inFlight ||
      this.installInProgress ||
      this.state.status !== 'downloaded'
    ) {
      return
    }
    this.installInProgress = true
    try {
      await this.options.beforeInstall()
      this.options.updater.quitAndInstall(false, true)
    } catch {
      this.setError()
    } finally {
      this.installInProgress = false
    }
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopPeriodicChecks()
    this.listeners.clear()
    this.options.updater.removeListener('checking-for-update', this.onChecking)
    this.options.updater.removeListener('update-available', this.onAvailable)
    this.options.updater.removeListener('update-not-available', this.onNotAvailable)
    this.options.updater.removeListener('download-progress', this.onProgress)
    this.options.updater.removeListener('update-downloaded', this.onDownloaded)
    this.options.updater.removeListener('error', this.onError)
  }

  private run(operation: () => Promise<DesktopUpdateState>): Promise<DesktopUpdateState> {
    const result = operation()
      .catch(() => {
        this.setError()
        return this.getState()
      })
      .finally(() => {
        if (this.inFlight === result) {
          this.inFlight = null
          const pendingChannel = this.pendingChannel
          if (pendingChannel) this.applyChannel(pendingChannel)
        }
      })
    this.inFlight = result
    return result
  }

  private availabilityState(): DesktopUpdateState {
    if (!this.options.isPackaged) return { status: 'development', channel: this.channel }
    if (!isUpdatePackageSupported(this.options.platform, this.options.packageType)) {
      return { status: 'unsupported', channel: this.channel }
    }
    if (!this.options.feeds) return { status: 'unconfigured', channel: this.channel }
    return this.baseState('idle')
  }

  private canOperate(): boolean {
    return (
      !this.disposed &&
      this.state.status !== 'unconfigured' &&
      this.state.status !== 'development' &&
      this.state.status !== 'unsupported'
    )
  }

  private baseState<
    TStatus extends 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded'
  >(
    status: TStatus
  ): {
    status: TStatus
    channel: DesktopUpdateChannel
    packageType: DesktopUpdatePackageType
  } {
    const packageType = this.options.packageType
    if (!packageType) throw new Error('Updater package type is unavailable')
    return { status, channel: this.channel, packageType }
  }

  private configureUpdater(): void {
    const feeds = this.options.feeds
    if (!feeds) return
    this.options.updater.channel = this.channel
    this.options.updater.allowPrerelease = this.channel === 'beta'
    this.options.updater.allowDowngrade = false
    this.options.updater.setFeedURL({
      provider: 'generic',
      url: feeds[this.channel],
      channel: this.channel
    })
    const setIntervalFn = this.options.setInterval ?? ((callback, ms) => setInterval(callback, ms))
    this.interval = setIntervalFn(() => {
      if (
        this.state.status === 'idle' ||
        this.state.status === 'up-to-date' ||
        this.state.status === 'error'
      ) {
        void this.check()
      }
    }, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
    this.interval.unref?.()
  }

  private stopPeriodicChecks(): void {
    if (!this.interval) return
    const clear =
      this.options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout))
    clear(this.interval)
    this.interval = undefined
  }

  private setError(): void {
    if (!this.canOperate()) return
    this.setState({
      ...this.baseState('idle'),
      status: 'error',
      message: desktopMessages.updater.failure
    })
  }

  private setState(state: DesktopUpdateState): void {
    if (this.disposed) return
    this.state = parseDesktopUpdateState(state)
    this.emit()
  }

  private emit(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}

export function parseUpdateFeedConfiguration(
  env: NodeJS.ProcessEnv,
  options: { allowLocalTestFeeds?: boolean } = {}
): UpdateFeedConfiguration | null {
  const stable = env.AGENT_WORKSPACE_UPDATE_STABLE_URL
  const beta = env.AGENT_WORKSPACE_UPDATE_BETA_URL
  if (stable === undefined && beta === undefined) return null
  if (stable === undefined || beta === undefined) {
    throw new Error('Both update feed roots must be configured')
  }
  const parsed = {
    stable: parseFeedUrl(stable, options.allowLocalTestFeeds === true),
    beta: parseFeedUrl(beta, options.allowLocalTestFeeds === true)
  }
  if (parsed.stable === parsed.beta) throw new Error('Update feed roots must be separate')
  return parsed
}

function parseFeedUrl(value: string, allowLocalTestFeeds: boolean): string {
  if (value !== value.trim() || value.length < 1 || value.length > FEED_URL_MAX_LENGTH) {
    throw new Error('Invalid update feed URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid update feed URL')
  }
  const localTestFeed =
    allowLocalTestFeeds &&
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  if (url.protocol !== 'https:' && !localTestFeed) throw new Error('Invalid update feed URL')
  if (url.username || url.password || url.hash || url.search)
    throw new Error('Invalid update feed URL')
  if (
    !localTestFeed &&
    (isIP(url.hostname) !== 0 ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost'))
  ) {
    throw new Error('Invalid update feed URL')
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`
  return url.toString()
}

export function detectLinuxPackageType(options: {
  appImagePath?: string
  resourcesPath: string
  readPackageType?: (path: string) => string
}): DesktopUpdatePackageType | null {
  if (options.appImagePath?.trim()) return 'appimage'
  let packageType: string
  try {
    packageType = (options.readPackageType ?? ((path) => readFileSync(path, 'utf8')))(
      join(options.resourcesPath, 'package-type')
    ).trim()
  } catch {
    return null
  }
  return packageType === 'deb' || packageType === 'rpm' ? packageType : null
}

export function detectNativeUpdatePackageType(
  platform: NodeJS.Platform,
  linuxOptions: Parameters<typeof detectLinuxPackageType>[0]
): DesktopUpdatePackageType | null {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'nsis'
  if (platform === 'linux') return detectLinuxPackageType(linuxOptions)
  return null
}

function isUpdatePackageSupported(
  platform: NodeJS.Platform,
  packageType: DesktopUpdatePackageType | null
): packageType is DesktopUpdatePackageType {
  if (platform === 'linux') {
    return packageType === 'appimage' || packageType === 'deb' || packageType === 'rpm'
  }
  if (platform === 'darwin') return packageType === 'mac'
  if (platform === 'win32') return packageType === 'nsis'
  return false
}

function safeVersion(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(value)
  ) {
    return null
  }
  return value
}
