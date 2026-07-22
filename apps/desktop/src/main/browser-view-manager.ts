import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  BrowserWindow,
  WebContentsView,
  app,
  dialog,
  session as electronSession,
  shell,
  type DownloadItem,
  type Event,
  type PermissionCheckHandlerHandlerDetails,
  type Session,
  type WebContents,
  type WebPreferences
} from 'electron'

import {
  browserObserveParamsSchema,
  browserPlaceholderMetadataSchema,
  browserSessionStateSchema,
  type ApplicationSnapshot,
  type BrowserObserveParams,
  type BrowserAutomationSessionSnapshot,
  type BrowserAutomationTargetBinding,
  type BrowserSessionState,
  type DomainEventMessage,
  type MutationResult,
  type WorkspaceListResult,
  type WorkspaceSnapshotResult
} from '@agent-workspace/protocol-client'
import { browserMessages } from '../shared/browser-messages'
import {
  createElectronAutomationPage,
  type BrowserAutomationPage
} from './browser-automation-manager'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const PARTITION_PATTERN = /^persist:[A-Za-z0-9._-]+$/u
const MAX_BROWSER_DIMENSION = 32_768
const MAX_BROWSER_POSITION = 1_000_000
const EXTERNAL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,31}:$/u
const BLOCKED_EXTERNAL_SCHEMES = new Set(['about:', 'blob:', 'data:', 'file:', 'javascript:'])

type PermissionRequestHandler = Exclude<Parameters<Session['setPermissionRequestHandler']>[0], null>
type BrowserPermission = Parameters<PermissionRequestHandler>[1]

const PROMPTABLE_PERMISSIONS = new Set<BrowserPermission>([
  'fullscreen',
  'geolocation',
  'media',
  'notifications',
  'pointerLock'
])

export interface BrowserMountParams {
  workspaceId: string
  tabId: string
  browserSessionId: string
  lifecycleId: string
}

export interface BrowserBoundsParams {
  browserSessionId: string
  lifecycleId: string
  revision: number
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

export interface BrowserSessionParams {
  browserSessionId: string
  lifecycleId: string
}

export interface BrowserViewTransfer {
  readonly source: BrowserViewManager
  readonly target: BrowserViewManager
  readonly mount: BrowserMountParams
}

export interface BrowserViewStatus {
  workspaceId: string
  tabId: string
  browserSessionId: string
  kind: 'crashed' | 'load-failed' | 'responsive' | 'unresponsive'
  errorCode?: number
  description?: string
  url?: string
}

export interface BrowserControl {
  listWorkspaces(): Promise<WorkspaceListResult>
  snapshotWorkspace(params: { workspaceId: string }): Promise<WorkspaceSnapshotResult>
  focusPane(params: { workspaceId: string; paneId: string }): Promise<MutationResult>
  observeBrowser(params: BrowserObserveParams): Promise<MutationResult>
  onDomainEvent(listener: (event: DomainEventMessage) => void): () => void
}

export interface PermissionPromptRequest {
  browserSessionId: string
  origin: string
  permission: BrowserPermission
}

export type PopupDisposition = 'deny' | 'external' | 'same-view'
export type BrowserLiveAction = 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'openDevTools'

export interface BrowserViewManagerDependencies {
  createView(options: { webPreferences: WebPreferences }): WebContentsView
  createAutomationWindow(options: { webPreferences: WebPreferences }): BrowserWindow
  getSession(partition: string): Session
  openExternal(url: string): Promise<void>
  confirmExternal(url: string): Promise<boolean>
  promptPermission(request: PermissionPromptRequest): Promise<boolean>
  popupDisposition(url: URL, currentUrl: URL | undefined): PopupDisposition
  showSaveDialog(
    window: BrowserWindow,
    options: Electron.SaveDialogOptions
  ): Promise<Electron.SaveDialogReturnValue>
  downloadsDirectory: string
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  cancelSchedule(handle: ReturnType<typeof setTimeout>): void
  reportStatus(status: BrowserViewStatus): void
  logError(message: string, error?: unknown): void
  reconcileResources(snapshot: ApplicationSnapshot): void
}

interface BrowserViewEntry {
  workspaceId: string
  paneId: string
  tabId: string
  browserSessionId: string
  lifecycleId: string | undefined
  partition: string
  stateRevision: number
  correlationId: string | null
  view: WebContentsView
  attached: boolean
  destroyed: boolean
  automationBlocked: boolean
  boundsEpoch: number
  boundsRevision: number
  pendingBounds: BrowserBoundsParams | undefined
  boundsSchedule: ReturnType<typeof setTimeout> | undefined
  observationSchedule: ReturnType<typeof setTimeout> | undefined
  observationEpoch: number
  observationInFlight: boolean
  pendingObservation: BrowserObservationSnapshot | undefined
  nextObservationRevision: number
}

interface BrowserObservationSnapshot {
  epoch: number
  lifecycleId: string
  workspaceId: string
  tabId: string
  state: Omit<BrowserSessionState, 'stateRevision'>
}

interface PendingMount {
  token: object
  workspaceId: string
  tabId: string
  lifecycleId: string
}

interface SessionPolicy {
  entries: Set<BrowserViewEntry>
  grants: Set<string>
  privacy: 'standard' | 'strict'
  downloadHandler: (event: Event, item: DownloadItem, contents: WebContents) => void
}

interface LocatedBrowserState {
  workspaceId: string
  paneId: string
  tabId: string
  state: BrowserSessionState
}

interface PaneFocusRequest {
  entry: BrowserViewEntry
  workspaceId: string
  paneId: string
  started: boolean
}

export function createSecureBrowserWebPreferences(remoteSession: Session): WebPreferences {
  return {
    session: remoteSession,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    devTools: true
  }
}

export function createSecureAutomationWebPreferences(remoteSession: Session): WebPreferences {
  return { ...createSecureBrowserWebPreferences(remoteSession), devTools: false }
}

export function parseBrowserMountParams(value: unknown): BrowserMountParams {
  const record = strictRecord(value, ['workspaceId', 'tabId', 'browserSessionId', 'lifecycleId'])
  return {
    workspaceId: parseUuid(record.workspaceId, 'workspace'),
    tabId: parseUuid(record.tabId, 'tab'),
    browserSessionId: parseUuid(record.browserSessionId, 'browser session'),
    lifecycleId: parseUuid(record.lifecycleId, 'browser lifecycle')
  }
}

export function parseBrowserSessionParams(value: unknown): BrowserSessionParams {
  const record = strictRecord(value, ['browserSessionId', 'lifecycleId'])
  return {
    browserSessionId: parseUuid(record.browserSessionId, 'browser session'),
    lifecycleId: parseUuid(record.lifecycleId, 'browser lifecycle')
  }
}

export function parseBrowserBoundsParams(value: unknown): BrowserBoundsParams {
  const record = strictRecord(value, [
    'browserSessionId',
    'lifecycleId',
    'revision',
    'x',
    'y',
    'width',
    'height',
    'visible'
  ])
  if (typeof record.visible !== 'boolean') throw new Error('Invalid browser visibility')
  return {
    browserSessionId: parseUuid(record.browserSessionId, 'browser session'),
    lifecycleId: parseUuid(record.lifecycleId, 'browser lifecycle'),
    revision: parseSafeInteger(record.revision, 0, Number.MAX_SAFE_INTEGER, 'bounds revision'),
    x: parseFiniteNumber(record.x, -MAX_BROWSER_POSITION, MAX_BROWSER_POSITION, 'x coordinate'),
    y: parseFiniteNumber(record.y, -MAX_BROWSER_POSITION, MAX_BROWSER_POSITION, 'y coordinate'),
    width: parseFiniteNumber(record.width, 0, MAX_BROWSER_DIMENSION, 'width'),
    height: parseFiniteNumber(record.height, 0, MAX_BROWSER_DIMENSION, 'height'),
    visible: record.visible
  }
}

export function isSafeRemoteUrl(value: string): boolean {
  return browserPlaceholderMetadataSchema.safeParse({ url: value }).success
}

export function isAppOwnedBrowserPartition(value: string): boolean {
  return value.length <= 128 && PARTITION_PATTERN.test(value)
}

export function sanitizeDownloadFilename(value: string): string {
  const leaf = stripControlCharacters(basename(value.replaceAll('\\', '/')))
    .replace(/[<>:"|?*]/gu, '_')
    .replace(/[. ]+$/u, '')
    .slice(0, 240)
  return leaf === '' || leaf === '.' || leaf === '..'
    ? browserMessages.native.fallbackDownloadFilename
    : leaf
}

export function defaultPopupDisposition(url: URL, currentUrl: URL | undefined): PopupDisposition {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'external'
  return currentUrl?.origin === url.origin ? 'same-view' : 'deny'
}

function navigationPosition(contents: WebContents): {
  activeIndex: number
  entryCount: number
  canBack: boolean
  canForward: boolean
} {
  const activeIndex = contents.navigationHistory.getActiveIndex()
  const entryCount = contents.navigationHistory.getAllEntries().length
  return {
    activeIndex,
    entryCount,
    canBack: activeIndex > 0,
    canForward: activeIndex >= 0 && activeIndex + 1 < entryCount
  }
}

export class BrowserViewManager {
  private readonly entries = new Map<string, BrowserViewEntry>()
  private readonly pendingMounts = new Map<string, PendingMount>()
  private readonly sessionPolicies = new Map<Session, SessionPolicy>()
  private readonly automationPages = new Set<BrowserAutomationPage>()
  private approvedBrowserProfile:
    { partition: string; profileKey: string; privacy: 'standard' | 'strict' } | undefined
  private readonly dependencies: BrowserViewManagerDependencies
  private fullReconciliation: Promise<void> | undefined
  private activeReconciliationRevision = -1
  private coveredReconciliationRevision = -1
  private dirtyReconciliationRevision = -1
  private readonly workspaceSelections = new Map<string, { paneId: string; revision: number }>()
  private readonly pendingPaneFocus = new Map<string, PaneFocusRequest>()
  private paneFocusQueue: Promise<void> = Promise.resolve()
  private nativeFocusedEntry: BrowserViewEntry | undefined
  private disposed = false
  private removeDomainListener: (() => void) | undefined

  public constructor(
    private readonly window: BrowserWindow,
    private readonly control: BrowserControl,
    dependencies: Partial<BrowserViewManagerDependencies> = {}
  ) {
    this.dependencies = { ...defaultDependencies(window), ...dependencies }
    this.window.once('closed', () => this.dispose())
    this.removeDomainListener = this.control.onDomainEvent((event) => this.handleDomainEvent(event))
  }

  public async mount(rawParams: unknown): Promise<void> {
    this.assertActive()
    const params = parseBrowserMountParams(rawParams)
    const token = {}
    this.pendingMounts.set(params.browserSessionId, { token, ...params })

    let snapshot: WorkspaceSnapshotResult
    try {
      snapshot = await this.control.snapshotWorkspace({ workspaceId: params.workspaceId })
    } catch (error) {
      const pending = this.pendingMounts.get(params.browserSessionId)
      if (pending?.token === token) this.pendingMounts.delete(params.browserSessionId)
      throw error
    }
    if (this.disposed || this.pendingMounts.get(params.browserSessionId)?.token !== token) return
    this.pendingMounts.delete(params.browserSessionId)

    const located = findBrowserState(snapshot, params)
    if (!located) {
      throw new Error('The authoritative workspace snapshot does not contain this browser session')
    }
    const state = located.state
    validateAuthoritativeState(state)
    this.assertApprovedBrowserProfile(state.profilePartition)

    const mountedEntry = this.entries.get(params.browserSessionId)
    if (mountedEntry) {
      // A browser tab may be moved to another workspace by the CLI while the native
      // view remains alive. The freshly fetched snapshot is the ownership authority.
      if (
        mountedEntry.lifecycleId !== params.lifecycleId ||
        mountedEntry.workspaceId !== params.workspaceId ||
        mountedEntry.tabId !== params.tabId
      ) {
        this.invalidateObservations(mountedEntry)
      }
      if (mountedEntry.lifecycleId !== params.lifecycleId) {
        this.resetBoundsEpoch(mountedEntry)
        this.hideAndDetach(mountedEntry)
      }
      mountedEntry.workspaceId = params.workspaceId
      mountedEntry.paneId = located.paneId
      mountedEntry.tabId = params.tabId
      mountedEntry.lifecycleId = params.lifecycleId
      this.reconcileState(mountedEntry, state, true)
      this.reconcileWorkspaceSelections(snapshot)
      return
    }

    const remoteSession = this.dependencies.getSession(state.profilePartition)
    const view = this.dependencies.createView({
      webPreferences: createSecureBrowserWebPreferences(remoteSession)
    })
    view.setVisible(false)
    const entry: BrowserViewEntry = {
      ...params,
      paneId: located.paneId,
      partition: state.profilePartition,
      stateRevision: state.stateRevision,
      correlationId: state.correlationId,
      view,
      attached: false,
      destroyed: false,
      automationBlocked: false,
      boundsEpoch: 0,
      boundsRevision: -1,
      pendingBounds: undefined,
      boundsSchedule: undefined,
      observationSchedule: undefined,
      observationEpoch: 0,
      observationInFlight: false,
      pendingObservation: undefined,
      nextObservationRevision: state.stateRevision
    }
    this.entries.set(entry.browserSessionId, entry)
    this.installSessionPolicies(remoteSession).entries.add(entry)
    this.installViewPolicies(entry)
    this.reconcileState(entry, state, true)
    this.reconcileWorkspaceSelections(snapshot)
  }

  public unmount(rawParams: unknown): void {
    const params = parseBrowserSessionParams(rawParams)
    const pending = this.pendingMounts.get(params.browserSessionId)
    if (pending?.lifecycleId === params.lifecycleId) {
      this.pendingMounts.delete(params.browserSessionId)
    }
    const entry = this.entries.get(params.browserSessionId)
    if (entry?.lifecycleId === params.lifecycleId) {
      this.invalidateObservations(entry)
      entry.lifecycleId = undefined
      this.resetBoundsEpoch(entry)
      this.hideAndDetach(entry)
    }
  }

  /** Recreates a transferred browser from the target window's authoritative projection. */
  public async mountTransferred(params: {
    workspaceId: string
    paneId: string
    tabId: string
    browserSessionId: string
    lifecycleId: string
    profilePartition: string
    stateRevision: number
    title: string
    url: string
  }): Promise<void> {
    await this.mount({
      workspaceId: params.workspaceId,
      tabId: params.tabId,
      browserSessionId: params.browserSessionId,
      lifecycleId: params.lifecycleId
    })
    const entry = this.entries.get(params.browserSessionId)
    if (
      !entry ||
      entry.paneId !== params.paneId ||
      entry.partition !== params.profilePartition ||
      entry.stateRevision < params.stateRevision
    ) {
      if (entry) this.destroyEntry(entry)
      throw new Error('The target projection does not match the transferred browser placement')
    }
  }

  /** Provider-only transfer primitive; caller has already authenticated native ownership. */
  public suspendOwnedSession(browserSessionId: string): () => void {
    const entry = this.entries.get(browserSessionId)
    if (!entry) throw new Error('The browser session is not owned by this window')
    const wasAttached = entry.attached
    const wasVisible = entry.view.getVisible()
    const bounds = entry.view.getBounds()
    entry.automationBlocked = true
    this.cancelBoundsSchedule(entry)
    this.hideAndDetach(entry)
    let active = true
    return () => {
      if (!active || entry.destroyed || this.disposed) return
      active = false
      entry.automationBlocked = false
      if (!wasAttached) return
      if (!this.window.isDestroyed()) {
        this.window.contentView.addChildView(entry.view)
        entry.attached = true
        entry.view.setBounds(bounds)
        entry.view.setVisible(wasVisible)
      }
    }
  }

  public destroyOwnedSession(browserSessionId: string): void {
    const entry = this.entries.get(browserSessionId)
    if (entry) this.destroyEntry(entry)
  }

  /**
   * Hides and detaches a session before a replacement native view is created in
   * another window. The returned rollback is valid only until the source entry
   * is destroyed and is used when target creation fails before commit.
   */
  public suspendForTransfer(rawParams: unknown): () => void {
    this.assertActive()
    const params = parseBrowserSessionParams(rawParams)
    const entry = this.entries.get(params.browserSessionId)
    if (!entry || entry.lifecycleId !== params.lifecycleId) {
      throw new Error('Unknown browser session')
    }
    const wasAttached = entry.attached
    const wasVisible = entry.view.getVisible()
    const bounds = entry.view.getBounds()
    entry.automationBlocked = true
    this.cancelBoundsSchedule(entry)
    this.hideAndDetach(entry)
    let finished = false
    return () => {
      if (finished || this.disposed || entry.destroyed) return
      finished = true
      entry.automationBlocked = false
      if (!wasAttached) return
      if (!this.window.isDestroyed()) {
        this.window.contentView.addChildView(entry.view)
        entry.attached = true
        entry.view.setBounds(bounds)
        entry.view.setVisible(wasVisible)
      }
    }
  }

  public setBounds(rawParams: unknown): void {
    let params: BrowserBoundsParams
    try {
      params = parseBrowserBoundsParams(rawParams)
    } catch (error) {
      const browserSessionId = unsafeBrowserSessionId(rawParams)
      const entry = browserSessionId ? this.entries.get(browserSessionId) : undefined
      const lifecycleId = unsafeBrowserLifecycleId(rawParams)
      if (entry && (!lifecycleId || lifecycleId === entry.lifecycleId)) {
        this.resetBoundsEpoch(entry)
        this.hideAndDetach(entry)
      }
      throw error
    }
    const entry = this.entries.get(params.browserSessionId)
    if (!entry || entry.lifecycleId !== params.lifecycleId) return
    if (params.revision <= entry.boundsRevision) throw new Error('Stale browser bounds revision')
    entry.boundsRevision = params.revision
    entry.pendingBounds = params

    if (!params.visible || params.width === 0 || params.height === 0) {
      this.cancelBoundsSchedule(entry)
      entry.pendingBounds = undefined
      this.hideAndDetach(entry)
      return
    }
    if (entry.boundsSchedule) return
    const boundsEpoch = entry.boundsEpoch
    entry.boundsSchedule = this.dependencies.schedule(() => {
      if (entry.boundsEpoch !== boundsEpoch) return
      entry.boundsSchedule = undefined
      const pending = entry.pendingBounds
      entry.pendingBounds = undefined
      if (!pending || entry.destroyed || this.disposed) return
      this.applyBounds(entry, pending)
    }, 16)
  }

  public focus(rawParams: unknown): void {
    const params = parseBrowserSessionParams(rawParams)
    const entry = this.entries.get(params.browserSessionId)
    if (!entry || entry.lifecycleId !== params.lifecycleId) return
    if (!entry.attached || !entry.view.getVisible()) {
      throw new Error('Cannot focus a hidden browser view')
    }
    entry.view.webContents.focus()
  }

  public navigate(browserSessionId: string, url: string): void {
    const entry = this.entries.get(browserSessionId)
    if (!entry || entry.destroyed) return
    if (!isSafeRemoteUrl(url)) throw new Error('The service returned an unsafe browser URL')
    this.loadUrl(entry, url, browserMessages.native.status.navigationFailed)
  }

  public back(browserSessionId: string): void {
    const contents = this.liveContents(browserSessionId)
    if (!contents) return
    const position = navigationPosition(contents)
    if (position.canBack) contents.navigationHistory.goToIndex(position.activeIndex - 1)
  }

  public forward(browserSessionId: string): void {
    const contents = this.liveContents(browserSessionId)
    if (!contents) return
    const position = navigationPosition(contents)
    if (position.canForward) contents.navigationHistory.goToIndex(position.activeIndex + 1)
  }

  public reload(browserSessionId: string): void {
    this.liveContents(browserSessionId)?.reload()
  }

  public stop(browserSessionId: string): void {
    this.liveContents(browserSessionId)?.stop()
  }

  public openDevTools(browserSessionId: string): void {
    this.liveContents(browserSessionId)?.openDevTools({ mode: 'detach' })
  }

  public reconcileMutation(value: MutationResult): void {
    this.reconcileAuthoritativeSnapshot(value.snapshot, false)
    this.dependencies.reconcileResources(value.snapshot)
  }

  public applyCommandMutation(
    value: MutationResult,
    browserSessionId: string,
    action: BrowserLiveAction
  ): void {
    this.reconcileMutation(value)
    const entry = this.entries.get(browserSessionId)
    if (!entry || entry.destroyed) return
    const located = collectBrowserStates(value).find(
      (candidate) => candidate.state.browserSessionId === browserSessionId
    )
    if (!located || located.workspaceId !== entry.workspaceId || located.tabId !== entry.tabId) {
      this.destroyEntry(entry)
      return
    }
    const state = validateAuthoritativeState(located.state)
    switch (action) {
      case 'navigate':
        this.navigate(browserSessionId, state.url)
        break
      case 'back':
        this.back(browserSessionId)
        break
      case 'forward':
        this.forward(browserSessionId)
        break
      case 'reload':
        this.reload(browserSessionId)
        break
      case 'stop':
        this.stop(browserSessionId)
        break
      case 'openDevTools':
        this.openDevTools(browserSessionId)
        break
    }
  }

  public reconcileAuthoritativeSnapshot(value: unknown, applyDesiredLiveState = true): void {
    const workspaces = collectWorkspaceRecords(value)
    const completeApplicationSnapshot = containsCompleteApplicationSnapshot(value)
    if (workspaces.length === 0 && !completeApplicationSnapshot) return
    const representedWorkspaceIds = new Set(
      workspaces.map((workspace) => workspace.id).filter(isString)
    )
    const locatedStates = collectBrowserStates(value)
    const statesById = new Map(
      locatedStates.map((located) => [located.state.browserSessionId, located])
    )
    this.reconcileWorkspaceSelections(value)

    for (const entry of [...this.entries.values()]) {
      const located = statesById.get(entry.browserSessionId)
      if (located && located.tabId === entry.tabId) {
        if (entry.workspaceId !== located.workspaceId) this.invalidateObservations(entry)
        entry.workspaceId = located.workspaceId
        entry.paneId = located.paneId
        this.reconcileState(entry, located.state, applyDesiredLiveState)
        continue
      }
      if (representedWorkspaceIds.has(entry.workspaceId) || completeApplicationSnapshot) {
        this.destroyEntry(entry)
      }
    }

    for (const [browserSessionId, pending] of this.pendingMounts) {
      if (!representedWorkspaceIds.has(pending.workspaceId)) {
        if (completeApplicationSnapshot) {
          this.pendingMounts.delete(browserSessionId)
        }
        continue
      }
      const located = statesById.get(browserSessionId)
      if (
        !located ||
        located.workspaceId !== pending.workspaceId ||
        located.tabId !== pending.tabId
      ) {
        this.pendingMounts.delete(browserSessionId)
      }
    }
  }

  public destroySession(rawParams: unknown): void {
    const record = strictRecord(rawParams, ['browserSessionId'])
    const params = {
      browserSessionId: parseUuid(record.browserSessionId, 'browser session')
    }
    this.pendingMounts.delete(params.browserSessionId)
    const entry = this.entries.get(params.browserSessionId)
    if (entry) this.destroyEntry(entry, false)
  }

  /** Main-only exact attachment. No renderer/preload route reaches this method. */
  public acquireAutomationPage(
    target: BrowserAutomationTargetBinding,
    profileKey?: string
  ): BrowserAutomationPage | undefined {
    const entry = this.entries.get(target.browserSessionId)
    if (
      !entry ||
      (profileKey !== undefined && this.approvedBrowserProfile?.profileKey !== profileKey) ||
      !this.matchesAutomationTarget(entry, target)
    ) {
      return undefined
    }
    return createElectronAutomationPage({
      contents: entry.view.webContents,
      owned: false,
      target,
      revalidate: () => this.matchesAutomationTarget(entry, target)
    })
  }

  public configureBrowserProfile(configuration: {
    partition: string
    privacy: 'standard' | 'strict'
  }): void {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(configuration.partition)) {
      throw new Error('Invalid browser profile partition')
    }
    if (this.entries.size > 0 || this.sessionPolicies.size > 0) {
      throw new Error('Browser profile policy must be configured before native views')
    }
    this.approvedBrowserProfile = {
      partition: `persist:agent-workspace-${configuration.partition}`,
      profileKey: configuration.partition,
      privacy: configuration.privacy
    }
  }

  /**
   * Creates an automation-owned view in a unique nonpersistent partition. The
   * public contract never accepts or returns this partition name.
   */
  public createEphemeralAutomationPage(
    snapshot: BrowserAutomationSessionSnapshot
  ): BrowserAutomationPage {
    this.assertActive()
    const partition = `agent-workspace-automation-${snapshot.automationSessionId}-${snapshot.generation}-${randomUUID()}`
    const remoteSession = this.dependencies.getSession(partition)
    const automationWindow = this.dependencies.createAutomationWindow({
      webPreferences: {
        ...createSecureAutomationWebPreferences(remoteSession),
        backgroundThrottling: false,
        offscreen: true
      }
    })
    const contents = automationWindow.webContents
    const denyPermission: Parameters<Session['setPermissionCheckHandler']>[0] = () => false
    const denyPermissionRequest: Parameters<Session['setPermissionRequestHandler']>[0] = (
      _contents,
      _permission,
      callback
    ) => callback(false)
    const denyDownload = (event: Event): void => event.preventDefault()
    remoteSession.setPermissionCheckHandler(denyPermission)
    remoteSession.setPermissionRequestHandler(denyPermissionRequest)
    remoteSession.on('will-download', denyDownload)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const blockUnsafeNavigation = (event: Event, url: string): void => {
      if (!isSafeRemoteUrl(url)) event.preventDefault()
    }
    const willNavigate = (event: Event & { url: string }): void =>
      blockUnsafeNavigation(event, event.url)
    const willRedirect = (event: Event & { url: string }): void =>
      blockUnsafeNavigation(event, event.url)
    contents.on('will-navigate', willNavigate)
    contents.on('will-frame-navigate', willNavigate)
    contents.on('will-redirect', willRedirect)

    let live = true
    const page: BrowserAutomationPage = createElectronAutomationPage({
      contents,
      owned: true,
      target: snapshot.target,
      revalidate: () => live && !this.disposed && !contents.isDestroyed(),
      prepareCapture: (width, height) => automationWindow.setContentSize(width, height, false),
      destroyOwned: async () => {
        if (!live) return
        live = false
        this.automationPages.delete(page)
        contents.removeListener('will-navigate', willNavigate)
        contents.removeListener('will-frame-navigate', willNavigate)
        contents.removeListener('will-redirect', willRedirect)
        remoteSession.setPermissionCheckHandler(null)
        remoteSession.setPermissionRequestHandler(null)
        remoteSession.removeListener('will-download', denyDownload)
        if (!automationWindow.isDestroyed()) automationWindow.destroy()
        await Promise.allSettled([
          remoteSession.clearStorageData(),
          remoteSession.clearCache(),
          remoteSession.clearAuthCache()
        ])
      }
    })
    this.automationPages.add(page)
    return page
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeDomainListener?.()
    this.removeDomainListener = undefined
    this.pendingMounts.clear()
    this.pendingPaneFocus.clear()
    this.workspaceSelections.clear()
    this.nativeFocusedEntry = undefined
    for (const page of this.automationPages) void page.destroy()
    this.automationPages.clear()
    for (const entry of [...this.entries.values()]) this.destroyEntry(entry, false)
    for (const [remoteSession, policy] of this.sessionPolicies) {
      remoteSession.setPermissionCheckHandler(null)
      remoteSession.setPermissionRequestHandler(null)
      remoteSession.removeListener('will-download', policy.downloadHandler)
    }
    this.sessionPolicies.clear()
  }

  public get size(): number {
    return this.entries.size
  }

  public ownsSession(browserSessionId: string): boolean {
    const entry = this.entries.get(browserSessionId)
    return entry !== undefined && !entry.destroyed
  }

  public get diagnosticCounts(): Readonly<{
    entries: number
    pendingMounts: number
    sessionPolicies: number
    automationPages: number
  }> {
    return {
      entries: this.entries.size,
      pendingMounts: this.pendingMounts.size,
      sessionPolicies: this.sessionPolicies.size,
      automationPages: this.automationPages.size
    }
  }

  private installSessionPolicies(remoteSession: Session): SessionPolicy {
    const existing = this.sessionPolicies.get(remoteSession)
    if (existing) return existing

    const policy: SessionPolicy = {
      entries: new Set(),
      grants: new Set(),
      privacy: this.approvedBrowserProfile?.privacy ?? 'standard',
      downloadHandler: (event, item, contents) =>
        this.handleDownload(event, item, contents, remoteSession)
    }
    this.sessionPolicies.set(remoteSession, policy)

    remoteSession.setPermissionCheckHandler(
      (contents, permission, requestingOrigin, details: PermissionCheckHandlerHandlerDetails) => {
        const entry = contents ? this.entryForContents(remoteSession, contents) : undefined
        const origin = safeOrigin(requestingOrigin)
        return Boolean(
          entry &&
          details.isMainFrame &&
          origin &&
          policy.grants.has(permissionGrantKey(entry.browserSessionId, permission, origin))
        )
      }
    )
    remoteSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const entry = this.entryForContents(remoteSession, contents)
      const origin = safeOrigin(details.requestingUrl)
      if (
        this.disposed ||
        !entry ||
        policy.privacy === 'strict' ||
        !details.isMainFrame ||
        !origin ||
        !PROMPTABLE_PERMISSIONS.has(permission)
      ) {
        callback(false)
        return
      }
      void this.dependencies
        .promptPermission({ browserSessionId: entry.browserSessionId, origin, permission })
        .then((granted) => {
          const allow = granted && !this.disposed && !entry.destroyed
          if (allow) {
            policy.grants.add(permissionGrantKey(entry.browserSessionId, permission, origin))
          }
          callback(allow)
        })
        .catch((error) => {
          this.dependencies.logError(browserMessages.native.status.permissionPromptFailed, error)
          callback(false)
        })
    })
    remoteSession.on('will-download', policy.downloadHandler)
    return policy
  }

  private installViewPolicies(entry: BrowserViewEntry): void {
    const contents = entry.view.webContents
    contents.setWindowOpenHandler(({ url }) => {
      this.handlePopup(entry, url)
      return { action: 'deny' }
    })
    const interceptNavigation = (event: Event, url: string, openExternally: boolean): void => {
      if (isSafeRemoteUrl(url)) return
      event.preventDefault()
      if (openExternally) this.handleExternalUrl(url)
    }
    contents.on('will-navigate', (event) => interceptNavigation(event, event.url, true))
    contents.on('will-frame-navigate', (event) => {
      // Electron also emits will-navigate for the main frame. Defer to that event so
      // a single unsafe navigation cannot produce two confirmation prompts.
      if (!event.isMainFrame) interceptNavigation(event, event.url, false)
    })
    contents.on('will-redirect', (event) =>
      interceptNavigation(event, event.url, event.isMainFrame)
    )
    contents.on('focus', () => this.handleNativeFocus(entry))
    contents.on('blur', () => {
      if (this.nativeFocusedEntry === entry) this.nativeFocusedEntry = undefined
    })

    const observe = (): void => this.scheduleObservation(entry)
    contents.on('did-start-loading', observe)
    contents.on('did-stop-loading', observe)
    contents.on('did-navigate', observe)
    contents.on('did-navigate-in-page', observe)
    contents.on('page-title-updated', observe)
    contents.on('devtools-opened', observe)
    contents.on('devtools-closed', observe)
    contents.on('unresponsive', () => {
      this.reportStatus(entry, { kind: 'unresponsive' })
      observe()
    })
    contents.on('responsive', () => {
      this.reportStatus(entry, { kind: 'responsive' })
      observe()
    })
    contents.on('render-process-gone', (_event, details) => {
      this.hideAndDetach(entry)
      this.reportStatus(entry, { kind: 'crashed', description: details.reason })
    })
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        const status: Omit<BrowserViewStatus, 'workspaceId' | 'tabId' | 'browserSessionId'> = {
          kind: 'load-failed',
          errorCode,
          description: errorDescription
        }
        if (isSafeRemoteUrl(validatedUrl)) status.url = validatedUrl
        this.reportStatus(entry, status)
        observe()
      }
    )
  }

  private handlePopup(entry: BrowserViewEntry, rawUrl: string): void {
    const url = safeUrl(rawUrl)
    if (!url || entry.destroyed) return
    const disposition = this.dependencies.popupDisposition(
      url,
      safeUrl(entry.view.webContents.getURL())
    )
    if (disposition === 'same-view' && isSafeRemoteUrl(url.toString())) {
      this.loadUrl(entry, url.toString(), browserMessages.native.status.popupNavigationFailed)
    } else if (disposition === 'external') {
      this.handleExternalUrl(url.toString())
    }
  }

  private handleExternalUrl(rawUrl: string): void {
    const url = safeUrl(rawUrl)
    if (!url || !isSafeExternalUrl(url)) return
    void this.dependencies
      .confirmExternal(url.toString())
      .then(async (confirmed) => {
        if (confirmed && !this.disposed) await this.dependencies.openExternal(url.toString())
      })
      .catch((error) =>
        this.dependencies.logError(browserMessages.native.status.externalProtocolFailed, error)
      )
  }

  private handleDownload(
    event: Event,
    item: DownloadItem,
    contents: WebContents,
    remoteSession: Session
  ): void {
    const entry = this.entryForContents(remoteSession, contents)
    if (!entry || !isSafeRemoteUrl(item.getURL())) {
      event.preventDefault()
      return
    }

    try {
      item.pause()
    } catch (error) {
      safeCancelDownload(item)
      this.dependencies.logError(browserMessages.native.status.downloadPauseFailed, error)
      return
    }
    const filename = sanitizeDownloadFilename(item.getFilename())
    void this.dependencies
      .showSaveDialog(this.window, {
        title: browserMessages.native.saveDownloadTitle,
        defaultPath: join(this.dependencies.downloadsDirectory, filename),
        buttonLabel: browserMessages.native.save
      })
      .then((result) => {
        if (entry.destroyed || result.canceled || !result.filePath) {
          safeCancelDownload(item)
          return
        }
        item.setSavePath(result.filePath)
        item.resume()
      })
      .catch((error) => {
        safeCancelDownload(item)
        this.dependencies.logError(browserMessages.native.status.downloadDialogFailed, error)
      })
  }

  private applyBounds(entry: BrowserViewEntry, params: BrowserBoundsParams): void {
    if (this.window.isDestroyed()) {
      this.hideAndDetach(entry)
      return
    }
    const content = this.window.getContentBounds()
    const left = Math.max(0, Math.min(content.width, params.x))
    const top = Math.max(0, Math.min(content.height, params.y))
    const right = Math.max(left, Math.min(content.width, params.x + params.width))
    const bottom = Math.max(top, Math.min(content.height, params.y + params.height))
    const bounds = {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.max(0, Math.ceil(right) - Math.floor(left)),
      height: Math.max(0, Math.ceil(bottom) - Math.floor(top))
    }
    if (bounds.width === 0 || bounds.height === 0 || !params.visible) {
      this.hideAndDetach(entry)
      return
    }
    entry.view.setVisible(false)
    entry.view.setBounds(bounds)
    if (!entry.attached) {
      this.window.contentView.addChildView(entry.view)
      entry.attached = true
    }
    entry.view.setVisible(true)
  }

  private reconcileState(
    entry: BrowserViewEntry,
    rawState: BrowserSessionState,
    applyDesiredLiveState: boolean
  ): void {
    const state = validateAuthoritativeState(rawState)
    if (state.browserSessionId !== entry.browserSessionId) return
    if (state.stateRevision < entry.stateRevision) return
    if (state.profilePartition !== entry.partition) {
      this.destroyEntry(entry)
      throw new Error('The authoritative browser profile partition changed')
    }

    entry.stateRevision = state.stateRevision
    entry.nextObservationRevision = Math.max(entry.nextObservationRevision, state.stateRevision)
    entry.correlationId = state.correlationId
    if (!applyDesiredLiveState || entry.destroyed) return

    const contents = entry.view.webContents
    if (contents.getURL() !== state.url && !contents.isLoading()) {
      this.loadUrl(entry, state.url, browserMessages.native.status.reconciliationFailed)
    }
    if (state.devToolsOpen && !contents.isDevToolsOpened()) {
      contents.openDevTools({ mode: 'detach' })
    } else if (!state.devToolsOpen && contents.isDevToolsOpened()) {
      contents.closeDevTools()
    }
  }

  private scheduleObservation(entry: BrowserViewEntry): void {
    if (!this.isCurrentEntry(entry) || this.disposed || !entry.lifecycleId) return
    if (entry.observationSchedule) return
    const epoch = entry.observationEpoch
    const lifecycleId = entry.lifecycleId
    entry.observationSchedule = this.dependencies.schedule(() => {
      entry.observationSchedule = undefined
      if (!this.isObservationIdentityCurrent(entry, epoch, lifecycleId)) return
      const contents = entry.view.webContents
      const url = contents.getURL()
      if (!isSafeRemoteUrl(url)) return
      const position = navigationPosition(contents)
      const snapshot: BrowserObservationSnapshot = {
        epoch,
        lifecycleId,
        workspaceId: entry.workspaceId,
        tabId: entry.tabId,
        state: {
          browserSessionId: entry.browserSessionId,
          url,
          navigationTitle: contents.getTitle().slice(0, 256),
          canBack: position.canBack,
          canForward: position.canForward,
          loading: contents.isLoading(),
          devToolsOpen: contents.isDevToolsOpened(),
          profilePartition: entry.partition,
          correlationId: entry.correlationId
        }
      }
      if (entry.observationInFlight) {
        entry.pendingObservation = snapshot
        return
      }
      this.dispatchObservation(entry, snapshot)
    }, 0)
  }

  private dispatchObservation(entry: BrowserViewEntry, snapshot: BrowserObservationSnapshot): void {
    if (entry.observationInFlight || !this.isObservationSnapshotCurrent(entry, snapshot)) return
    entry.observationInFlight = true
    void Promise.resolve()
      .then(() => {
        if (!this.isObservationSnapshotCurrent(entry, snapshot)) return undefined
        const stateRevision = Math.max(entry.stateRevision, entry.nextObservationRevision) + 1
        if (!Number.isSafeInteger(stateRevision)) {
          this.dependencies.logError(browserMessages.native.status.observationRevisionOverflow)
          return undefined
        }
        entry.nextObservationRevision = stateRevision
        const params = browserObserveParamsSchema.parse({
          workspaceId: snapshot.workspaceId,
          tabId: snapshot.tabId,
          state: { ...snapshot.state, stateRevision }
        })
        return this.control.observeBrowser(params)
      })
      .then((result) => {
        if (result && this.isObservationSnapshotCurrent(entry, snapshot)) {
          this.reconcileMutation(result)
        }
      })
      .catch((error) => {
        this.dependencies.logError(browserMessages.native.status.observationUpdateFailed, error)
      })
      .finally(() => {
        entry.observationInFlight = false
        const pending = entry.pendingObservation
        entry.pendingObservation = undefined
        if (pending) this.dispatchObservation(entry, pending)
      })
  }

  private isObservationIdentityCurrent(
    entry: BrowserViewEntry,
    epoch: number,
    lifecycleId: string | undefined
  ): lifecycleId is string {
    return (
      !this.disposed &&
      this.isCurrentEntry(entry) &&
      lifecycleId !== undefined &&
      entry.lifecycleId === lifecycleId &&
      entry.observationEpoch === epoch
    )
  }

  private isObservationSnapshotCurrent(
    entry: BrowserViewEntry,
    snapshot: BrowserObservationSnapshot
  ): boolean {
    return (
      this.isObservationIdentityCurrent(entry, snapshot.epoch, snapshot.lifecycleId) &&
      entry.workspaceId === snapshot.workspaceId &&
      entry.tabId === snapshot.tabId
    )
  }

  private invalidateObservations(entry: BrowserViewEntry): void {
    entry.observationEpoch += 1
    entry.pendingObservation = undefined
    if (entry.observationSchedule) {
      this.dependencies.cancelSchedule(entry.observationSchedule)
      entry.observationSchedule = undefined
    }
  }

  private handleNativeFocus(entry: BrowserViewEntry): void {
    if (!this.isCurrentEntry(entry) || !entry.attached || !entry.view.getVisible()) return
    this.nativeFocusedEntry = entry
    const pending = this.pendingPaneFocus.get(entry.workspaceId)
    if (pending?.entry === entry && pending.paneId === entry.paneId) return
    if (this.workspaceSelections.get(entry.workspaceId)?.paneId === entry.paneId) {
      if (!pending) return
      if (!pending.started) {
        this.pendingPaneFocus.delete(entry.workspaceId)
        return
      }
    }

    const request: PaneFocusRequest = {
      entry,
      workspaceId: entry.workspaceId,
      paneId: entry.paneId,
      started: false
    }
    this.pendingPaneFocus.set(request.workspaceId, request)
    this.paneFocusQueue = this.paneFocusQueue.then(async () => {
      try {
        if (
          this.disposed ||
          this.pendingPaneFocus.get(request.workspaceId) !== request ||
          this.nativeFocusedEntry !== entry ||
          !this.isCurrentEntry(entry) ||
          !entry.lifecycleId ||
          !entry.attached ||
          !entry.view.getVisible() ||
          entry.workspaceId !== request.workspaceId ||
          entry.paneId !== request.paneId ||
          this.workspaceSelections.get(request.workspaceId)?.paneId === request.paneId
        ) {
          return
        }
        request.started = true
        const result = await this.control.focusPane({
          workspaceId: request.workspaceId,
          paneId: request.paneId
        })
        if (!this.disposed) this.reconcileMutation(result)
      } catch (error) {
        if (!this.disposed) {
          this.dependencies.logError(browserMessages.native.status.paneFocusFailed, error)
        }
      } finally {
        if (this.pendingPaneFocus.get(request.workspaceId) === request) {
          this.pendingPaneFocus.delete(request.workspaceId)
        }
      }
    })
  }

  private reconcileWorkspaceSelections(value: unknown): void {
    const revision = snapshotRevision(value)
    if (revision === undefined) return
    const workspaceIds = new Set<string>()
    for (const workspace of collectWorkspaceRecords(value)) {
      if (!isUuid(workspace.id) || !isUuid(workspace.selectedPaneId)) continue
      workspaceIds.add(workspace.id)
      const current = this.workspaceSelections.get(workspace.id)
      if (!current || revision >= current.revision) {
        this.workspaceSelections.set(workspace.id, {
          paneId: workspace.selectedPaneId,
          revision
        })
      }
    }
    if (containsCompleteApplicationSnapshot(value)) {
      for (const workspaceId of this.workspaceSelections.keys()) {
        if (!workspaceIds.has(workspaceId)) this.workspaceSelections.delete(workspaceId)
      }
    }
  }

  private isCurrentEntry(entry: BrowserViewEntry): boolean {
    return !entry.destroyed && this.entries.get(entry.browserSessionId) === entry
  }

  private matchesAutomationTarget(
    entry: BrowserViewEntry,
    target: BrowserAutomationTargetBinding
  ): boolean {
    return (
      !this.disposed &&
      !entry.destroyed &&
      !entry.automationBlocked &&
      this.entries.get(entry.browserSessionId) === entry &&
      entry.workspaceId === target.workspaceId &&
      entry.paneId === target.paneId &&
      entry.tabId === target.tabId &&
      entry.browserSessionId === target.browserSessionId &&
      entry.lifecycleId === target.browserLifecycleId &&
      !entry.view.webContents.isDestroyed()
    )
  }

  private assertApprovedBrowserProfile(partition: string): void {
    if (this.approvedBrowserProfile && partition !== this.approvedBrowserProfile.partition) {
      throw new Error('The browser profile partition is not approved by runtime configuration')
    }
  }

  private handleDomainEvent(event: DomainEventMessage): void {
    if (event.event === 'browser.changed') {
      const entry = this.entries.get(event.data.state.browserSessionId)
      // This event is the authoritative echo of state observed from this native
      // WebContentsView. Advancing the revision baseline is required, but replaying
      // its URL back through loadURL can replace Electron's native history when an
      // older observation arrives after a newer in-page navigation.
      if (entry) this.reconcileState(entry, event.data.state, false)
      return
    }
    if (
      event.event === 'workspace.changed' ||
      event.event === 'pane.layoutChanged' ||
      event.event === 'tab.changed'
    ) {
      this.refreshApplication(event.revision)
    }
  }

  private refreshApplication(revision: number): void {
    if (this.disposed) return
    if (this.fullReconciliation) {
      if (revision > this.activeReconciliationRevision) {
        this.dirtyReconciliationRevision = Math.max(this.dirtyReconciliationRevision, revision)
      }
      return
    }
    if (revision <= this.coveredReconciliationRevision) return
    this.activeReconciliationRevision = revision
    this.dirtyReconciliationRevision = -1
    let coveredRevision = this.coveredReconciliationRevision
    const refresh = Promise.resolve()
      .then(async () => {
        const snapshot = await this.control.listWorkspaces()
        coveredRevision = Math.max(revision, snapshot.snapshot.revision)
        // Mounted native views are already the source of browser navigation state.
        // Structural reconciliation updates ownership/lifecycle without replaying
        // potentially delayed observed URLs into those live views.
        if (!this.disposed) {
          this.reconcileAuthoritativeSnapshot(snapshot, false)
          this.dependencies.reconcileResources(snapshot.snapshot)
        }
      })
      .catch((error) => {
        if (!this.disposed) {
          this.dependencies.logError(
            browserMessages.native.status.applicationReconciliationFailed,
            error
          )
        }
      })
      .finally(() => {
        this.coveredReconciliationRevision = Math.max(
          this.coveredReconciliationRevision,
          coveredRevision
        )
        if (this.fullReconciliation === refresh) this.fullReconciliation = undefined
        this.activeReconciliationRevision = -1
        if (
          !this.disposed &&
          this.dirtyReconciliationRevision > this.coveredReconciliationRevision
        ) {
          this.refreshApplication(this.dirtyReconciliationRevision)
        }
      })
    this.fullReconciliation = refresh
  }

  private loadUrl(entry: BrowserViewEntry, url: string, errorMessage: string): void {
    void entry.view.webContents.loadURL(url).catch((error) => {
      if (!entry.destroyed) this.dependencies.logError(errorMessage, error)
    })
  }

  private liveContents(browserSessionId: string): WebContents | undefined {
    const entry = this.entries.get(browserSessionId)
    return entry && !entry.destroyed ? entry.view.webContents : undefined
  }

  private hideAndDetach(entry: BrowserViewEntry): void {
    if (entry.destroyed) return
    if (this.nativeFocusedEntry === entry) this.nativeFocusedEntry = undefined
    const pendingFocus = this.pendingPaneFocus.get(entry.workspaceId)
    if (pendingFocus?.entry === entry) this.pendingPaneFocus.delete(entry.workspaceId)
    entry.view.setVisible(false)
    if (entry.attached && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(entry.view)
    }
    entry.attached = false
  }

  private destroyEntry(entry: BrowserViewEntry, invalidateMount = true): void {
    if (entry.destroyed) return
    entry.destroyed = true
    if (invalidateMount) this.pendingMounts.delete(entry.browserSessionId)
    this.cancelBoundsSchedule(entry)
    this.invalidateObservations(entry)
    entry.view.setVisible(false)
    if (entry.attached && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(entry.view)
    }
    entry.attached = false
    this.entries.delete(entry.browserSessionId)
    if (this.nativeFocusedEntry === entry) this.nativeFocusedEntry = undefined
    const pendingFocus = this.pendingPaneFocus.get(entry.workspaceId)
    if (pendingFocus?.entry === entry) this.pendingPaneFocus.delete(entry.workspaceId)
    const policy = this.sessionPolicies.get(entry.view.webContents.session)
    policy?.entries.delete(entry)
    if (policy) {
      const grantPrefix = `${entry.browserSessionId}\u0000`
      for (const grant of policy.grants) {
        if (grant.startsWith(grantPrefix)) policy.grants.delete(grant)
      }
      if (policy.entries.size === 0) {
        const remoteSession = entry.view.webContents.session
        remoteSession.setPermissionCheckHandler(null)
        remoteSession.setPermissionRequestHandler(null)
        remoteSession.removeListener('will-download', policy.downloadHandler)
        this.sessionPolicies.delete(remoteSession)
      }
    }
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close({ waitForBeforeUnload: false })
    }
  }

  private cancelBoundsSchedule(entry: BrowserViewEntry): void {
    if (!entry.boundsSchedule) return
    this.dependencies.cancelSchedule(entry.boundsSchedule)
    entry.boundsSchedule = undefined
  }

  private resetBoundsEpoch(entry: BrowserViewEntry): void {
    entry.boundsEpoch += 1
    entry.boundsRevision = -1
    entry.pendingBounds = undefined
    this.cancelBoundsSchedule(entry)
  }

  private entryForContents(
    remoteSession: Session,
    contents: WebContents
  ): BrowserViewEntry | undefined {
    for (const entry of this.sessionPolicies.get(remoteSession)?.entries ?? []) {
      if (!entry.destroyed && entry.view.webContents === contents) return entry
    }
    return undefined
  }

  private reportStatus(
    entry: BrowserViewEntry,
    status: Omit<BrowserViewStatus, 'workspaceId' | 'tabId' | 'browserSessionId'>
  ): void {
    this.dependencies.reportStatus({
      workspaceId: entry.workspaceId,
      tabId: entry.tabId,
      browserSessionId: entry.browserSessionId,
      ...status
    })
  }

  private requireEntry(browserSessionId: string): BrowserViewEntry {
    this.assertActive()
    const entry = this.entries.get(browserSessionId)
    if (!entry || entry.destroyed) throw new Error('Unknown browser session')
    return entry
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('The browser view manager has been disposed')
  }
}

/**
 * Recreates browser ownership across windows without ever reparenting a live
 * WebContentsView. Source input is disabled first, the target creates a fresh
 * isolated view from authoritative service state, then the source is destroyed.
 */
export async function transferBrowserView(transfer: BrowserViewTransfer): Promise<void> {
  if (transfer.source === transfer.target) throw new Error('Browser transfer target is unchanged')
  if (transfer.target.ownsSession(transfer.mount.browserSessionId)) {
    throw new Error('Browser transfer target already owns the session')
  }
  const session = {
    browserSessionId: transfer.mount.browserSessionId,
    lifecycleId: transfer.mount.lifecycleId
  }
  const rollback = transfer.source.suspendForTransfer(session)
  try {
    await transfer.target.mount(transfer.mount)
  } catch (error) {
    rollback()
    throw error
  }
  transfer.source.destroySession({ browserSessionId: session.browserSessionId })
}

function defaultDependencies(window: BrowserWindow): BrowserViewManagerDependencies {
  return {
    createView: (options) => new WebContentsView(options),
    createAutomationWindow: ({ webPreferences }) =>
      new BrowserWindow({
        focusable: false,
        frame: false,
        height: 1,
        show: false,
        skipTaskbar: true,
        webPreferences,
        width: 1
      }),
    getSession: (partition) => electronSession.fromPartition(partition),
    openExternal: (url) => shell.openExternal(url),
    confirmExternal: async (url) => {
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: browserMessages.native.externalTitle,
        message: browserMessages.native.externalMessage,
        detail: url,
        buttons: [browserMessages.native.cancel, browserMessages.native.open],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return result.response === 1
    },
    promptPermission: async ({ origin, permission }) => {
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: browserMessages.native.permissionTitle,
        message: browserMessages.native.permissionRequest(origin, permission),
        buttons: [browserMessages.native.deny, browserMessages.native.allow],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return result.response === 1
    },
    popupDisposition: defaultPopupDisposition,
    showSaveDialog: (window, options) => dialog.showSaveDialog(window, options),
    downloadsDirectory: app.getPath('downloads'),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle),
    reportStatus: () => undefined,
    logError: (message, error) => console.error(message, error),
    reconcileResources: () => undefined
  }
}

function findBrowserState(
  snapshot: WorkspaceSnapshotResult,
  params: BrowserMountParams
): LocatedBrowserState | undefined {
  const workspace = snapshot.workspace
  if (workspace.id !== params.workspaceId) return undefined
  const tab = workspace.tabs.find((candidate) => candidate.id === params.tabId)
  if (tab?.content.kind !== 'browser') return undefined
  const pane = workspace.panes.find((candidate) => candidate.id === tab.paneId)
  if (!isUuid(tab.paneId) || !pane?.tabIds.includes(tab.id)) return undefined
  return tab.content.state.browserSessionId === params.browserSessionId
    ? { workspaceId: workspace.id, paneId: tab.paneId, tabId: tab.id, state: tab.content.state }
    : undefined
}

function collectBrowserStates(value: unknown): LocatedBrowserState[] {
  const states: LocatedBrowserState[] = []
  for (const workspace of collectWorkspaceRecords(value)) {
    if (!isUuid(workspace.id)) continue
    const tabs = Array.isArray(workspace.tabs) ? workspace.tabs : []
    const panes = Array.isArray(workspace.panes)
      ? workspace.panes.map(asRecord).filter(isRecord)
      : []
    for (const rawTab of tabs) {
      const tab = asRecord(rawTab)
      const content = asRecord(tab?.content)
      if (!tab || !isUuid(tab.id) || !isUuid(tab.paneId) || content?.kind !== 'browser') continue
      const pane = panes.find(
        (candidate) =>
          candidate.id === tab.paneId &&
          Array.isArray(candidate.tabIds) &&
          candidate.tabIds.includes(tab.id)
      )
      if (!pane) continue
      const parsed = browserSessionStateSchema.safeParse(content.state)
      if (parsed.success) {
        states.push({
          workspaceId: workspace.id,
          paneId: tab.paneId,
          tabId: tab.id,
          state: parsed.data
        })
      }
    }
  }
  return states
}

function snapshotRevision(value: unknown): number | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  if (Number.isSafeInteger(record.revision) && Number(record.revision) >= 0) {
    return Number(record.revision)
  }
  return record.snapshot === undefined ? undefined : snapshotRevision(record.snapshot)
}

function collectWorkspaceRecords(value: unknown): Array<Record<string, unknown>> {
  const record = asRecord(value)
  if (!record) return []
  if (Array.isArray(record.workspaces)) return record.workspaces.map(asRecord).filter(isRecord)
  if (record.workspace) {
    const workspace = asRecord(record.workspace)
    return workspace ? [workspace] : []
  }
  if (record.snapshot) return collectWorkspaceRecords(record.snapshot)
  return 'tabs' in record && 'id' in record ? [record] : []
}

function containsCompleteApplicationSnapshot(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) return false
  if (Array.isArray(record.workspaces)) return true
  return record.snapshot !== undefined && containsCompleteApplicationSnapshot(record.snapshot)
}

function validateAuthoritativeState(value: BrowserSessionState): BrowserSessionState {
  const state = browserSessionStateSchema.parse(value)
  if (!isAppOwnedBrowserPartition(state.profilePartition)) {
    throw new Error('The service returned a non-application browser partition')
  }
  if (!isSafeRemoteUrl(state.url)) throw new Error('The service returned an unsafe browser URL')
  return state
}

function safeOrigin(value: string): string | undefined {
  const url = safeUrl(value)
  return url && isSafeRemoteUrl(url.toString()) ? url.origin : undefined
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function isSafeExternalUrl(url: URL): boolean {
  return (
    EXTERNAL_SCHEME_PATTERN.test(url.protocol) &&
    !BLOCKED_EXTERNAL_SCHEMES.has(url.protocol) &&
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.username === '' &&
    url.password === '' &&
    !hasControlCharacters(url.toString())
  )
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 0x20 || codePoint === 0x7f
  })
}

function stripControlCharacters(value: string): string {
  return [...value].filter((character) => !hasControlCharacters(character)).join('')
}

function permissionGrantKey(browserSessionId: string, permission: string, origin: string): string {
  return `${browserSessionId}\u0000${permission}\u0000${origin}`
}

function safeCancelDownload(item: DownloadItem): void {
  try {
    item.cancel()
  } catch {
    // The item may already have been destroyed after the async native dialog resolved.
  }
}

function unsafeBrowserSessionId(value: unknown): string | undefined {
  const record = asRecord(value)
  return isUuid(record?.browserSessionId) ? record.browserSessionId : undefined
}

function unsafeBrowserLifecycleId(value: unknown): string | undefined {
  const record = asRecord(value)
  return isUuid(record?.lifecycleId) ? record.lifecycleId : undefined
}

function strictRecord(value: unknown, keys: string[]): Record<string, unknown> {
  const record = asRecord(value)
  if (
    !record ||
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record))
  ) {
    throw new Error('Invalid browser operation payload')
  }
  return record
}

function parseUuid(value: unknown, name: string): string {
  if (!isUuid(value)) throw new Error(`Invalid ${name} identifier`)
  return value
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function parseSafeInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Invalid browser ${name}`)
  }
  return Number(value)
}

function parseFiniteNumber(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid browser ${name}`)
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isRecord(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return value !== undefined
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}
