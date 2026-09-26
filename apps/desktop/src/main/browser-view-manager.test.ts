import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  showSaveDialog: vi.fn(),
  openExternal: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  dialog: {
    showMessageBox: electron.showMessageBox,
    showSaveDialog: electron.showSaveDialog
  },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: electron.openExternal }
}))

import type {
  BrowserObserveParams,
  BrowserSessionState,
  DomainEventMessage,
  MutationResult,
  WorkspaceListResult,
  WorkspaceSnapshotResult
} from '@agent-workspace/protocol-client'

import {
  BrowserViewManager,
  createNodeBrowserControl,
  createSecureBrowserWebPreferences,
  isAppOwnedBrowserPartition,
  transferBrowserView,
  type BrowserControl,
  type BrowserViewManagerDependencies,
  type PermissionPromptRequest
} from './browser-view-manager'
import { browserMessages } from '@agent-workspace/contracts/desktop/browser-messages'

const WORKSPACE_A = '10000000-0000-4000-8000-000000000001'
const WORKSPACE_B = '10000000-0000-4000-8000-000000000002'
const PANE_A = '11000000-0000-4000-8000-000000000001'
const PANE_B = '11000000-0000-4000-8000-000000000002'
const TAB_ID = '20000000-0000-4000-8000-000000000001'
const TAB_ID_B = '20000000-0000-4000-8000-000000000002'
const SESSION_ID = '30000000-0000-4000-8000-000000000001'
const SESSION_ID_B = '30000000-0000-4000-8000-000000000002'
const LIFECYCLE_ID = '70000000-0000-4000-8000-000000000001'
const LIFECYCLE_ID_B = '70000000-0000-4000-8000-000000000004'
const REPLACEMENT_LIFECYCLE_ID = '70000000-0000-4000-8000-000000000002'
const INVALID_LIFECYCLE_ID = '70000000-0000-4000-8000-000000000003'

type PermissionCheckHandler = Exclude<
  Parameters<Electron.Session['setPermissionCheckHandler']>[0],
  null
>
type PermissionRequestHandler = Exclude<
  Parameters<Electron.Session['setPermissionRequestHandler']>[0],
  null
>

class FakeSession extends EventEmitter {
  public permissionCheck: PermissionCheckHandler | null = null
  public permissionRequest: PermissionRequestHandler | null = null
  public readonly clearStorageData = vi.fn(() => Promise.resolve())
  public readonly clearCache = vi.fn(() => Promise.resolve())
  public readonly clearAuthCache = vi.fn(() => Promise.resolve())

  public setPermissionCheckHandler(handler: PermissionCheckHandler | null): void {
    this.permissionCheck = handler
  }

  public setPermissionRequestHandler(handler: PermissionRequestHandler | null): void {
    this.permissionRequest = handler
  }
}

class FakeWebContents extends EventEmitter {
  public readonly close = vi.fn(() => {
    this.destroyed = true
  })
  public readonly focus = vi.fn()
  public readonly openDevTools = vi.fn(() => {
    this.devToolsOpen = true
  })
  public readonly closeDevTools = vi.fn(() => {
    this.devToolsOpen = false
  })
  public readonly reload = vi.fn()
  public readonly stop = vi.fn()
  public readonly startPainting = vi.fn()
  public readonly invalidate = vi.fn()
  public readonly loadURL = vi.fn((url: string) => {
    this.url = url
    return Promise.resolve()
  })
  public readonly capturePage = vi.fn((rectangle: Electron.Rectangle) =>
    Promise.resolve({
      getSize: () => ({ width: rectangle.width, height: rectangle.height }),
      toPNG: () => Buffer.from('png')
    })
  )
  public readonly navigationHistory = {
    canGoBack: vi.fn(() => this.canBack),
    canGoForward: vi.fn(() => this.canForward),
    goBack: vi.fn(),
    goForward: vi.fn(),
    goToIndex: vi.fn(),
    getActiveIndex: vi.fn(() => (this.canBack ? 1 : 0)),
    getAllEntries: vi.fn((): Electron.NavigationEntry[] =>
      Array.from(
        { length: this.canForward ? (this.canBack ? 3 : 2) : this.canBack ? 2 : 1 },
        (_, index) => ({ url: this.url || 'https://example.test/', title: `Page ${index}` })
      )
    ),
    restore: vi.fn(async ({ entries, index }: Electron.RestoreOptions) => {
      this.url = entries[index ?? entries.length - 1]?.url ?? ''
    })
  }
  public popupHandler: ((details: { url: string }) => { action: string }) | undefined
  public url = ''
  public title = ''
  public loading = false
  public devToolsOpen = false
  public canBack = false
  public canForward = false
  private destroyed = false

  public constructor(public readonly session: FakeSession) {
    super()
  }

  public setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.popupHandler = handler
  }

  public getURL(): string {
    return this.url
  }

  public getTitle(): string {
    return this.title
  }

  public isLoading(): boolean {
    return this.loading
  }

  public isDevToolsOpened(): boolean {
    return this.devToolsOpen
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeView {
  public readonly webContents: FakeWebContents
  public readonly setBounds = vi.fn()
  public readonly setVisible = vi.fn((visible: boolean) => {
    this.visible = visible
  })
  private visible = false
  private bounds = { x: 0, y: 0, width: 0, height: 0 }

  public constructor(remoteSession: FakeSession) {
    this.webContents = new FakeWebContents(remoteSession)
  }

  public getVisible(): boolean {
    return this.visible
  }

  public getBounds(): Electron.Rectangle {
    return this.bounds
  }
}

class FakeAutomationWindow {
  public readonly webContents: FakeWebContents
  public readonly setContentSize = vi.fn()
  public readonly destroy = vi.fn(() => {
    this.destroyed = true
    this.webContents.close()
  })
  private destroyed = false

  public constructor(remoteSession: FakeSession) {
    this.webContents = new FakeWebContents(remoteSession)
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeWindow extends EventEmitter {
  public destroyed = false
  public readonly contentView = {
    addChildView: vi.fn(),
    removeChildView: vi.fn()
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }

  public getContentBounds(): Electron.Rectangle {
    return { x: 40, y: 50, width: 800, height: 600 }
  }
}

class FakeControl implements BrowserControl {
  public readonly listWorkspaces = vi.fn<() => Promise<WorkspaceListResult>>()
  public readonly snapshotWorkspace =
    vi.fn<(params: { workspaceId: string }) => Promise<WorkspaceSnapshotResult>>()
  public readonly focusPane =
    vi.fn<(params: { workspaceId: string; paneId: string }) => Promise<MutationResult>>()
  public readonly observeBrowser =
    vi.fn<(params: BrowserObserveParams) => Promise<MutationResult>>()
  private readonly listeners = new Set<(event: DomainEventMessage) => void>()

  public onDomainEvent(listener: (event: DomainEventMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public emit(event: DomainEventMessage): void {
    for (const listener of this.listeners) listener(event)
  }
}

interface Harness {
  control: FakeControl
  manager: BrowserViewManager
  remoteSession: FakeSession
  views: FakeView[]
  window: FakeWindow
  confirmExternal: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
  promptPermission: ReturnType<typeof vi.fn>
  showSaveDialog: ReturnType<typeof vi.fn>
}

function browserState(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    browserSessionId: SESSION_ID,
    url: 'https://example.test/',
    navigationTitle: 'Example',
    canBack: false,
    canForward: false,
    loading: false,
    devToolsOpen: false,
    profilePartition: 'persist:agent-workspace-default',
    stateRevision: 5,
    correlationId: 'browser:test',
    ...overrides
  }
}

function workspaceResult(
  workspaceId: string,
  state: BrowserSessionState | null = browserState(),
  tabId = TAB_ID,
  paneId = PANE_A
): WorkspaceSnapshotResult {
  return {
    revision: state?.stateRevision ?? 6,
    workspace: {
      id: workspaceId,
      selectedPaneId: paneId,
      panes: state ? [{ id: paneId, tabIds: [tabId], selectedTabId: tabId }] : [],
      tabs: state ? [{ id: tabId, paneId, content: { kind: 'browser', state } }] : []
    }
  } as WorkspaceSnapshotResult
}

function mutationResult(workspaceId: string, state: BrowserSessionState | null): MutationResult {
  return {
    revision: state?.stateRevision ?? 7,
    snapshot: {
      revision: state?.stateRevision ?? 7,
      selectedWorkspaceId: workspaceId,
      workspaces: [workspaceResult(workspaceId, state).workspace]
    }
  } as MutationResult
}

function workspaceListResult(
  workspaces: WorkspaceSnapshotResult['workspace'][],
  revision = 8
): WorkspaceListResult {
  return {
    snapshot: {
      revision,
      selectedWorkspaceId: workspaces[0]?.id ?? WORKSPACE_A,
      workspaces
    }
  } as WorkspaceListResult
}

function twoBrowserWorkspaceResult(selectedPaneId = PANE_A, revision = 6): WorkspaceSnapshotResult {
  const stateA = browserState({ stateRevision: revision })
  const stateB = browserState({
    browserSessionId: SESSION_ID_B,
    url: 'https://second.example.test/',
    stateRevision: revision
  })
  return {
    revision,
    workspace: {
      id: WORKSPACE_A,
      selectedPaneId,
      panes: [
        { id: PANE_A, tabIds: [TAB_ID], selectedTabId: TAB_ID },
        { id: PANE_B, tabIds: [TAB_ID_B], selectedTabId: TAB_ID_B }
      ],
      tabs: [
        { id: TAB_ID, paneId: PANE_A, content: { kind: 'browser', state: stateA } },
        { id: TAB_ID_B, paneId: PANE_B, content: { kind: 'browser', state: stateB } }
      ]
    }
  } as WorkspaceSnapshotResult
}

function twoBrowserMutation(selectedPaneId: string, revision: number): MutationResult {
  const workspace = twoBrowserWorkspaceResult(selectedPaneId, revision).workspace
  return {
    revision,
    snapshot: {
      revision,
      selectedWorkspaceId: WORKSPACE_A,
      workspaces: [workspace]
    }
  } as MutationResult
}

function createHarness(
  state = browserState(),
  dependencyOverrides: Partial<BrowserViewManagerDependencies> = {}
): Harness {
  const remoteSession = new FakeSession()
  const views: FakeView[] = []
  const control = new FakeControl()
  control.snapshotWorkspace.mockResolvedValue(workspaceResult(WORKSPACE_A, state))
  control.listWorkspaces.mockResolvedValue(
    workspaceListResult([workspaceResult(WORKSPACE_A, state).workspace])
  )
  control.observeBrowser.mockImplementation((params) =>
    Promise.resolve(mutationResult(WORKSPACE_A, params.state))
  )
  control.focusPane.mockImplementation(() => Promise.resolve(mutationResult(WORKSPACE_A, state)))
  const window = new FakeWindow()
  const promptPermission = vi.fn<(request: PermissionPromptRequest) => Promise<boolean>>()
  promptPermission.mockResolvedValue(false)
  const confirmExternal = vi.fn<(url: string) => Promise<boolean>>()
  confirmExternal.mockResolvedValue(false)
  const openExternal = vi.fn<(url: string) => Promise<void>>()
  openExternal.mockResolvedValue()
  const showSaveDialog = vi.fn()
  showSaveDialog.mockResolvedValue({ canceled: true })
  const dependencies: Partial<BrowserViewManagerDependencies> = {
    createView: ({ webPreferences }) => {
      const view = new FakeView(webPreferences.session as unknown as FakeSession)
      views.push(view)
      return view as unknown as Electron.WebContentsView
    },
    getSession: () => remoteSession as unknown as Electron.Session,
    promptPermission,
    confirmExternal,
    openExternal,
    showSaveDialog,
    downloadsDirectory: '/downloads',
    reportStatus: vi.fn(),
    logError: vi.fn(),
    ...dependencyOverrides
  }
  const manager = new BrowserViewManager(
    window as unknown as Electron.BrowserWindow,
    control,
    dependencies
  )
  return {
    control,
    manager,
    remoteSession,
    views,
    window,
    promptPermission,
    confirmExternal,
    openExternal,
    showSaveDialog
  }
}

async function mount(harness: Harness, workspaceId = WORKSPACE_A): Promise<FakeView> {
  await harness.manager.mount({
    workspaceId,
    tabId: TAB_ID,
    browserSessionId: SESSION_ID,
    lifecycleId: LIFECYCLE_ID
  })
  return harness.views[0]!
}

async function mountSecond(harness: Harness): Promise<FakeView> {
  await harness.manager.mount({
    workspaceId: WORKSPACE_A,
    tabId: TAB_ID_B,
    browserSessionId: SESSION_ID_B,
    lifecycleId: LIFECYCLE_ID_B
  })
  return harness.views[1]!
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

function structuralEvent(
  event: 'tab.changed' | 'workspace.changed',
  revision: number
): DomainEventMessage {
  return {
    event,
    revision,
    data: {
      revision,
      workspaceIds: [],
      paneIds: [],
      tabIds: [],
      commandIds: [],
      reason: 'test'
    }
  }
}

describe('BrowserViewManager', () => {
  it('derives native browser mount state from the Node workspace projection', async () => {
    const nodeSnapshot = workspaceListResult([workspaceResult(WORKSPACE_A).workspace], 11)
    const listWorkspaces = vi.fn().mockResolvedValue(nodeSnapshot)
    const focusPane = vi.fn().mockResolvedValue(mutationResult(WORKSPACE_A, browserState()))
    const observeBrowser = vi.fn().mockResolvedValue(mutationResult(WORKSPACE_A, browserState()))
    const control = createNodeBrowserControl({ listWorkspaces, focusPane, observeBrowser })

    await expect(control.snapshotWorkspace({ workspaceId: WORKSPACE_B })).rejects.toThrow(
      /does not contain this workspace/u
    )
    await expect(control.snapshotWorkspace({ workspaceId: WORKSPACE_A })).resolves.toEqual({
      revision: 11,
      workspace: nodeSnapshot.snapshot.workspaces[0]
    })
    expect(listWorkspaces).toHaveBeenCalledTimes(2)
    await expect(control.observeBrowser({} as BrowserObserveParams)).resolves.toMatchObject({
      revision: 5
    })
    expect(observeBrowser).toHaveBeenCalledOnce()
  })

  it('creates hostile-page automation views without Node, preload, devtools, permissions, or persistence', async () => {
    const partitions: string[] = []
    const preferences: Electron.WebPreferences[] = []
    let automationWindow: FakeAutomationWindow | undefined
    const remoteSession = new FakeSession()
    const harness = createHarness(browserState(), {
      getSession: (partition) => {
        partitions.push(partition)
        return remoteSession as unknown as Electron.Session
      },
      createAutomationWindow: ({ webPreferences }) => {
        preferences.push(webPreferences)
        automationWindow = new FakeAutomationWindow(remoteSession)
        let dimensions = { width: 1, height: 1 }
        automationWindow.setContentSize.mockImplementation((width: number, height: number) => {
          dimensions = { width, height }
        })
        automationWindow.webContents.invalidate.mockImplementation(() => {
          if (automationWindow?.webContents.getURL() !== 'about:blank') return
          automationWindow.webContents.emit(
            'paint',
            {},
            { x: 0, y: 0, ...dimensions },
            {
              getSize: () => dimensions,
              toPNG: () => Buffer.from('png')
            }
          )
        })
        return automationWindow as unknown as Electron.BrowserWindow
      }
    })
    const page = await harness.manager.createEphemeralAutomationPage({
      automationSessionId: '10000000-0000-4000-8000-000000000099',
      generation: 1,
      navigationEpoch: 0,
      mode: 'ephemeral',
      state: 'ready',
      profileKey: 'private',
      target: {
        workspaceId: WORKSPACE_A,
        paneId: PANE_A,
        tabId: TAB_ID,
        browserSessionId: SESSION_ID,
        browserLifecycleId: LIFECYCLE_ID,
        window: { windowId: WORKSPACE_B, windowGeneration: 1 }
      },
      createdAtMs: 1,
      updatedAtMs: 1,
      expiresAtMs: Date.now() + 60_000
    })
    expect(partitions[0]).toMatch(/^agent-workspace-automation-/u)
    expect(partitions[0]).not.toContain('persist:')
    expect(preferences[0]).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      devTools: false
    })
    expect('preload' in preferences[0]!).toBe(false)
    expect(preferences[0]).toMatchObject({ backgroundThrottling: false, offscreen: true })
    expect(remoteSession.permissionCheck?.(null, 'media', '', {} as never)).toBe(false)
    expect(automationWindow?.webContents.loadURL).toHaveBeenCalledWith('about:blank')
    await expect(page.capture(320, 240)).resolves.toEqual(Buffer.from('png'))
    expect(automationWindow?.setContentSize).toHaveBeenCalledWith(320, 240, false)
    expect(automationWindow?.webContents.capturePage).not.toHaveBeenCalled()
    expect(automationWindow?.webContents.invalidate).toHaveBeenCalledOnce()
    await page.destroy()
    expect(automationWindow?.destroy).toHaveBeenCalledOnce()
    expect(remoteSession.clearStorageData).toHaveBeenCalledOnce()
    expect(remoteSession.clearCache).toHaveBeenCalledOnce()
    expect(remoteSession.clearAuthCache).toHaveBeenCalledOnce()
    expect(harness.manager.diagnosticCounts.automationPages).toBe(0)
  })

  it('invalidates an attached automation page while native ownership is transferring', async () => {
    const harness = createHarness()
    await harness.manager.mount({
      workspaceId: WORKSPACE_A,
      tabId: TAB_ID,
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID
    })
    const target = {
      workspaceId: WORKSPACE_A,
      paneId: PANE_A,
      tabId: TAB_ID,
      browserSessionId: SESSION_ID,
      browserLifecycleId: LIFECYCLE_ID,
      window: { windowId: WORKSPACE_B, windowGeneration: 1 }
    }
    const page = harness.manager.acquireAutomationPage(target)
    expect(page?.revalidate(target)).toBe(true)
    const rollback = harness.manager.suspendForTransfer({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID
    })
    expect(page?.revalidate(target)).toBe(false)
    rollback()
    expect(page?.revalidate(target)).toBe(true)
  })

  it('applies the approved strict profile policy before view creation', async () => {
    const harness = createHarness()
    harness.manager.configureBrowserProfile({ partition: 'default', privacy: 'strict' })
    await harness.manager.mount({
      workspaceId: WORKSPACE_A,
      tabId: TAB_ID,
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID
    })
    const callback = vi.fn()
    harness.remoteSession.permissionRequest?.(
      harness.views[0]!.webContents as unknown as Electron.WebContents,
      'media',
      callback,
      { isMainFrame: true, requestingUrl: 'https://example.test/' }
    )
    expect(callback).toHaveBeenCalledWith(false)
    expect(harness.promptPermission).not.toHaveBeenCalled()

    const mismatch = createHarness()
    mismatch.manager.configureBrowserProfile({ partition: 'other', privacy: 'standard' })
    await expect(
      mismatch.manager.mount({
        workspaceId: WORKSPACE_A,
        tabId: TAB_ID,
        browserSessionId: SESSION_ID,
        lifecycleId: LIFECYCLE_ID
      })
    ).rejects.toThrow('not approved')
  })
  it('forwards complete mutation projections for authoritative ownership cleanup', () => {
    const reconcileResources = vi.fn()
    const harness = createHarness(browserState(), { reconcileResources })
    const mutation = mutationResult(WORKSPACE_A, browserState())

    harness.manager.reconcileMutation(mutation)

    expect(reconcileResources).toHaveBeenCalledWith(mutation.snapshot)
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses locked-down WebContents preferences and accepts only persistent protocol partitions', () => {
    const remoteSession = {} as Electron.Session
    expect(createSecureBrowserWebPreferences(remoteSession)).toMatchObject({
      session: remoteSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    })
    expect(createSecureBrowserWebPreferences(remoteSession)).not.toHaveProperty('preload')
    expect(isAppOwnedBrowserPartition('persist:agent-workspace-default')).toBe(true)
    expect(isAppOwnedBrowserPartition('persist:Profile_1.test')).toBe(true)
    expect(isAppOwnedBrowserPartition('temporary')).toBe(false)
    expect(isAppOwnedBrowserPartition('persist:../unsafe')).toBe(false)
  })

  it('mounts only an exact authoritative workspace/tab/session and derives URL and partition from it', async () => {
    const harness = createHarness()
    harness.control.snapshotWorkspace.mockResolvedValueOnce(workspaceResult(WORKSPACE_A, null))

    await expect(mount(harness)).rejects.toThrow(/authoritative workspace snapshot/)
    expect(harness.views).toHaveLength(0)

    harness.control.snapshotWorkspace.mockResolvedValueOnce(workspaceResult(WORKSPACE_A))
    const view = await mount(harness)
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://example.test/')
    expect(harness.control.snapshotWorkspace).toHaveBeenLastCalledWith({ workspaceId: WORKSPACE_A })
  })

  it('recreates cross-window browser ownership after hiding the source view', async () => {
    const source = createHarness()
    const target = createHarness()
    const sourceView = await mount(source)
    source.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 1,
      x: 1,
      y: 2,
      width: 300,
      height: 200,
      visible: true
    })
    await vi.runAllTimersAsync()
    expect(sourceView.getVisible()).toBe(true)

    await transferBrowserView({
      source: source.manager,
      target: target.manager,
      mount: {
        workspaceId: WORKSPACE_A,
        tabId: TAB_ID,
        browserSessionId: SESSION_ID,
        lifecycleId: LIFECYCLE_ID
      }
    })

    expect(sourceView.setVisible).toHaveBeenCalledWith(false)
    expect(sourceView.webContents.close).toHaveBeenCalledOnce()
    expect(target.views).toHaveLength(1)
    expect(target.views[0]).not.toBe(sourceView)
    expect(target.views[0]?.getVisible()).toBe(false)
    expect(source.manager.size).toBe(0)
    expect(target.manager.size).toBe(1)
  })

  it('stages a trusted transfer from a verified global snapshot while target reads remain scoped', async () => {
    const source = createHarness()
    const target = createHarness()
    await mount(source)
    target.control.snapshotWorkspace.mockRejectedValue(new Error('workspace not yet bound'))

    const [descriptor] = source.manager.ownedTransferDescriptors()
    expect(descriptor).toBeDefined()
    await target.manager.mountTransferred(descriptor!, workspaceResult(WORKSPACE_A))

    expect(target.control.snapshotWorkspace).not.toHaveBeenCalled()
    expect(target.manager.ownsSession(SESSION_ID)).toBe(true)
    expect(target.views[0]?.getVisible()).toBe(false)
    await vi.runAllTimersAsync()
    expect(target.control.observeBrowser).not.toHaveBeenCalled()
    target.manager.activateTransferredSession(SESSION_ID)
    await vi.runAllTimersAsync()
    expect(target.control.observeBrowser).toHaveBeenCalledOnce()
  })

  it('restores bounded native back/forward history and Chromium page state before activation', async () => {
    const source = createHarness()
    const target = createHarness()
    const sourceView = await mount(source)
    const history = [
      { url: 'https://example.test/first', title: 'First', pageState: 'c3RhdGU=' },
      { url: 'https://example.test/second', title: 'Second', pageState: 'c2Nyb2xs' },
      { url: 'https://example.test/third', title: 'Third' }
    ]
    sourceView.webContents.navigationHistory.getAllEntries.mockReturnValue(history)
    sourceView.webContents.navigationHistory.getActiveIndex.mockReturnValue(1)
    const [descriptor] = source.manager.ownedTransferDescriptors()
    expect(descriptor?.history).toEqual({ entries: history, index: 1 })

    await target.manager.mountTransferred(descriptor!, workspaceResult(WORKSPACE_A))

    expect(target.views[0]?.webContents.navigationHistory.restore).toHaveBeenCalledWith({
      entries: history,
      index: 1
    })
    expect(target.views[0]?.webContents.loadURL).not.toHaveBeenCalled()
    expect(target.control.observeBrowser).not.toHaveBeenCalled()
    target.manager.activateTransferredSession(SESSION_ID)
    await vi.runAllTimersAsync()
    expect(target.control.observeBrowser).toHaveBeenCalledOnce()
  })

  it('rejects unsafe source history and destroys a target whose history restore fails', async () => {
    const source = createHarness()
    let targetView: FakeView | undefined
    const target = createHarness(browserState(), {
      createView: ({ webPreferences }) => {
        targetView = new FakeView(webPreferences.session as unknown as FakeSession)
        targetView.webContents.navigationHistory.restore.mockRejectedValueOnce(
          new Error('load failed')
        )
        return targetView as unknown as Electron.WebContentsView
      }
    })
    const sourceView = await mount(source)
    sourceView.webContents.navigationHistory.getAllEntries.mockReturnValue([
      { url: 'file:///secret', title: 'Private' }
    ])
    expect(() => source.manager.ownedTransferDescriptors()).toThrow('cannot be transferred')

    sourceView.webContents.navigationHistory.getAllEntries.mockReturnValue([
      { url: 'https://example.test/', title: 'Page', pageState: 'c3RhdGU=' }
    ])
    const [descriptor] = source.manager.ownedTransferDescriptors()
    await expect(
      target.manager.mountTransferred(descriptor!, workspaceResult(WORKSPACE_A))
    ).rejects.toThrow('could not be restored')
    expect(target.manager.ownsSession(SESSION_ID)).toBe(false)
    expect(targetView?.webContents.close).toHaveBeenCalledOnce()
    expect(sourceView.webContents.close).not.toHaveBeenCalled()
  })

  it('keeps a suspended source detached when its renderer sends late bounds', async () => {
    const source = createHarness()
    const view = await mount(source)
    source.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 3,
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      visible: true
    })
    await vi.runAllTimersAsync()
    const attachments = source.window.contentView.addChildView.mock.calls.length
    const resume = source.manager.suspendOwnedSession(SESSION_ID)
    source.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 4,
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      visible: true
    })
    await vi.runAllTimersAsync()
    expect(source.window.contentView.addChildView).toHaveBeenCalledTimes(attachments)
    resume()
    expect(source.window.contentView.addChildView).toHaveBeenLastCalledWith(view)
    expect(source.manager.ownsSession(SESSION_ID)).toBe(true)
  })

  it('provides a transfer lifecycle for a browser whose renderer has unmounted', async () => {
    const source = createHarness()
    await mount(source)
    source.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: LIFECYCLE_ID })
    const [descriptor] = source.manager.ownedTransferDescriptors()
    expect(descriptor?.browserSessionId).toBe(SESSION_ID)
    expect(descriptor?.lifecycleId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(descriptor?.lifecycleId).not.toBe(LIFECYCLE_ID)
  })

  it('restores source browser ownership when target recreation fails', async () => {
    const source = createHarness()
    const target = createHarness()
    const sourceView = await mount(source)
    source.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 1,
      x: 1,
      y: 2,
      width: 300,
      height: 200,
      visible: true
    })
    await vi.runAllTimersAsync()
    target.control.snapshotWorkspace.mockRejectedValueOnce(new Error('target unavailable'))

    await expect(
      transferBrowserView({
        source: source.manager,
        target: target.manager,
        mount: {
          workspaceId: WORKSPACE_A,
          tabId: TAB_ID,
          browserSessionId: SESSION_ID,
          lifecycleId: LIFECYCLE_ID
        }
      })
    ).rejects.toThrow('target unavailable')

    expect(source.window.contentView.addChildView).toHaveBeenCalledWith(sourceView)
    expect(sourceView.getVisible()).toBe(true)
    expect(sourceView.webContents.close).not.toHaveBeenCalled()
    expect(source.manager.size).toBe(1)
    expect(target.manager.size).toBe(0)
  })

  it('keeps browser views in two visible panes attached simultaneously', async () => {
    const harness = createHarness()
    harness.control.snapshotWorkspace.mockResolvedValue(twoBrowserWorkspaceResult())
    const first = await mount(harness)
    const second = await mountSecond(harness)

    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 1,
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      visible: true
    })
    harness.manager.setBounds({
      browserSessionId: SESSION_ID_B,
      lifecycleId: LIFECYCLE_ID_B,
      revision: 1,
      x: 300,
      y: 0,
      width: 300,
      height: 200,
      visible: true
    })
    await vi.advanceTimersByTimeAsync(16)

    expect(first.getVisible()).toBe(true)
    expect(second.getVisible()).toBe(true)
    expect(harness.window.contentView.addChildView).toHaveBeenCalledTimes(2)
    expect(harness.window.contentView.removeChildView).not.toHaveBeenCalled()
  })

  it('synchronizes native browser focus to authoritative pane ownership with dedupe', async () => {
    const harness = createHarness()
    harness.control.snapshotWorkspace.mockResolvedValue(twoBrowserWorkspaceResult(PANE_A, 6))
    let revision = 6
    harness.control.focusPane.mockImplementation(({ paneId }) =>
      Promise.resolve(twoBrowserMutation(paneId, ++revision))
    )
    await mount(harness)
    const second = await mountSecond(harness)
    harness.manager.setBounds({
      browserSessionId: SESSION_ID_B,
      lifecycleId: LIFECYCLE_ID_B,
      revision: 1,
      x: 300,
      y: 0,
      width: 300,
      height: 200,
      visible: true
    })
    await vi.advanceTimersByTimeAsync(16)

    second.webContents.emit('focus')
    second.webContents.emit('focus')
    await flushPromises()
    expect(harness.control.focusPane).toHaveBeenCalledTimes(1)
    expect(harness.control.focusPane).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_A,
      paneId: PANE_B
    })

    second.webContents.emit('focus')
    await flushPromises()
    expect(harness.control.focusPane).toHaveBeenCalledTimes(1)

    harness.manager.reconcileAuthoritativeSnapshot(twoBrowserWorkspaceResult(PANE_A, ++revision))
    second.webContents.emit('focus')
    await flushPromises()
    expect(harness.control.focusPane).toHaveBeenCalledTimes(2)
  })

  it('does not synchronize focus from hidden, destroyed, or stale native entries', async () => {
    const harness = createHarness()
    harness.control.snapshotWorkspace.mockResolvedValue(twoBrowserWorkspaceResult())
    await mount(harness)
    const second = await mountSecond(harness)

    second.webContents.emit('focus')
    await flushPromises()
    expect(harness.control.focusPane).not.toHaveBeenCalled()

    harness.manager.setBounds({
      browserSessionId: SESSION_ID_B,
      lifecycleId: LIFECYCLE_ID_B,
      revision: 1,
      x: 300,
      y: 0,
      width: 300,
      height: 200,
      visible: true
    })
    await vi.advanceTimersByTimeAsync(16)
    second.webContents.emit('focus')
    harness.manager.unmount({
      browserSessionId: SESSION_ID_B,
      lifecycleId: LIFECYCLE_ID_B
    })
    await flushPromises()
    expect(harness.control.focusPane).not.toHaveBeenCalled()

    harness.manager.destroySession({ browserSessionId: SESSION_ID_B })
    second.webContents.emit('focus')
    await flushPromises()
    expect(harness.control.focusPane).not.toHaveBeenCalled()
  })

  it('clears a focus request invalidated by blur so a later native refocus can retry', async () => {
    const harness = createHarness()
    harness.control.snapshotWorkspace.mockResolvedValue(twoBrowserWorkspaceResult())
    harness.control.focusPane.mockResolvedValue(twoBrowserMutation(PANE_B, 7))
    await mount(harness)
    const second = await mountSecond(harness)
    harness.manager.setBounds({
      browserSessionId: SESSION_ID_B,
      lifecycleId: LIFECYCLE_ID_B,
      revision: 1,
      x: 300,
      y: 0,
      width: 300,
      height: 200,
      visible: true
    })
    await vi.advanceTimersByTimeAsync(16)

    second.webContents.emit('focus')
    second.webContents.emit('blur')
    await flushPromises()
    expect(harness.control.focusPane).not.toHaveBeenCalled()

    second.webContents.emit('focus')
    await flushPromises()
    expect(harness.control.focusPane).toHaveBeenCalledOnce()
    expect(harness.control.focusPane).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      paneId: PANE_B
    })
  })

  it('coalesces fractional bounds, rejects stale revisions, and hides before inactive or invalid bounds', async () => {
    const harness = createHarness()
    const view = await mount(harness)

    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 1,
      x: 1.2,
      y: 2.2,
      width: 10.1,
      height: 10.1,
      visible: true
    })
    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 2,
      x: 10.4,
      y: 20.6,
      width: 100.2,
      height: 50.2,
      visible: true
    })
    expect(view.setBounds).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(16)
    expect(view.setBounds).toHaveBeenCalledTimes(1)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 101, height: 51 })
    expect(harness.window.contentView.addChildView).toHaveBeenCalledTimes(1)

    expect(() =>
      harness.manager.setBounds({
        browserSessionId: SESSION_ID,
        lifecycleId: LIFECYCLE_ID,
        revision: 2,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        visible: true
      })
    ).toThrow(/Stale/)
    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 3,
      x: 0,
      y: 0,
      width: 0,
      height: 1,
      visible: true
    })
    expect(harness.window.contentView.removeChildView).toHaveBeenCalledTimes(1)
    expect(() =>
      harness.manager.setBounds({
        browserSessionId: SESSION_ID,
        lifecycleId: LIFECYCLE_ID,
        revision: 4,
        x: Number.NaN,
        y: 0,
        width: 1,
        height: 1,
        visible: true
      })
    ).toThrow(/coordinate/)
    expect(view.getVisible()).toBe(false)
  })

  it('invalidates queued bounds before failing closed on malformed geometry', async () => {
    const scheduled: Array<() => void> = []
    const cancelSchedule = vi.fn()
    const harness = createHarness(browserState(), {
      schedule: (callback) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule
    })
    const view = await mount(harness)
    const visibleBounds = {
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 1,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      visible: true
    }

    harness.manager.setBounds(visibleBounds)
    const staleCallback = scheduled.shift()!
    expect(() =>
      harness.manager.setBounds({ ...visibleBounds, revision: 2, x: Number.NaN })
    ).toThrow(/coordinate/)
    expect(cancelSchedule).toHaveBeenCalledTimes(1)
    expect(view.getVisible()).toBe(false)

    staleCallback()
    expect(view.setBounds).not.toHaveBeenCalled()
    expect(harness.window.contentView.addChildView).not.toHaveBeenCalled()

    harness.manager.setBounds(visibleBounds)
    scheduled.shift()?.()
    expect(view.getVisible()).toBe(true)
    expect(harness.window.contentView.addChildView).toHaveBeenCalledTimes(1)
  })

  it('ignores deferred teardown from an older lifecycle after replacement mount starts', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 1,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      visible: true
    })
    await vi.advanceTimersByTimeAsync(16)

    const replacementSnapshot = deferred<WorkspaceSnapshotResult>()
    harness.control.snapshotWorkspace.mockImplementationOnce(() => replacementSnapshot.promise)
    const replacementMount = harness.manager.mount({
      workspaceId: WORKSPACE_A,
      tabId: TAB_ID,
      browserSessionId: SESSION_ID,
      lifecycleId: REPLACEMENT_LIFECYCLE_ID
    })
    expect(view.getVisible()).toBe(true)

    harness.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: LIFECYCLE_ID })
    expect(view.getVisible()).toBe(false)
    replacementSnapshot.resolve(workspaceResult(WORKSPACE_A))
    await replacementMount
    expect(view.getVisible()).toBe(false)
    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: REPLACEMENT_LIFECYCLE_ID,
      revision: 1,
      x: 50,
      y: 60,
      width: 200,
      height: 150,
      visible: true
    })
    await vi.advanceTimersByTimeAsync(16)
    expect(view.getVisible()).toBe(true)

    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 2,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false
    })
    harness.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: LIFECYCLE_ID })
    expect(view.getVisible()).toBe(true)

    harness.manager.unmount({
      browserSessionId: SESSION_ID,
      lifecycleId: REPLACEMENT_LIFECYCLE_ID
    })
    expect(view.getVisible()).toBe(false)
    expect(harness.window.contentView.removeChildView).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid replacement token without letting old teardown cancel its mount', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 1,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      visible: true
    })
    await vi.advanceTimersByTimeAsync(16)
    harness.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: INVALID_LIFECYCLE_ID })
    expect(view.getVisible()).toBe(true)

    const replacementSnapshot = deferred<WorkspaceSnapshotResult>()
    harness.control.snapshotWorkspace.mockImplementationOnce(() => replacementSnapshot.promise)
    const replacementMount = harness.manager.mount({
      workspaceId: WORKSPACE_B,
      tabId: TAB_ID,
      browserSessionId: SESSION_ID,
      lifecycleId: REPLACEMENT_LIFECYCLE_ID
    })
    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 2,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false
    })
    harness.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: LIFECYCLE_ID })
    expect(view.getVisible()).toBe(false)

    replacementSnapshot.reject(new Error('snapshot rejected'))
    await expect(replacementMount).rejects.toThrow(/snapshot rejected/)
    expect(view.getVisible()).toBe(false)
  })

  it('reuses the view across mount/unmount loops and closes it exactly once after an external tab close', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    harness.manager.setBounds({
      browserSessionId: SESSION_ID,
      lifecycleId: LIFECYCLE_ID,
      revision: 1,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      visible: true
    })
    await vi.advanceTimersByTimeAsync(16)

    harness.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: LIFECYCLE_ID })
    expect(view.webContents.close).not.toHaveBeenCalled()
    await mount(harness)
    expect(harness.views).toHaveLength(1)

    harness.control.listWorkspaces.mockResolvedValueOnce(workspaceListResult([]))
    harness.control.emit(structuralEvent('tab.changed', 9))
    harness.control.emit(structuralEvent('workspace.changed', 9))
    await flushPromises()
    expect(harness.control.listWorkspaces).toHaveBeenCalledTimes(1)
    expect(harness.manager.size).toBe(0)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    harness.manager.dispose()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('reconciles bounded renderer ownership after an authoritative domain refresh', async () => {
    const reconcileResources = vi.fn()
    const harness = createHarness(browserState(), { reconcileResources })
    const refreshed = workspaceListResult([], 9)
    harness.control.listWorkspaces.mockResolvedValueOnce(refreshed)

    harness.control.emit(structuralEvent('tab.changed', 9))
    await vi.waitFor(() => expect(reconcileResources).toHaveBeenCalledWith(refreshed.snapshot))
  })

  it('starts a fresh bounds epoch on every remount and ignores callbacks from an earlier epoch', async () => {
    const scheduled: Array<() => void> = []
    const cancelSchedule = vi.fn()
    const harness = createHarness(browserState(), {
      schedule: (callback) => {
        scheduled.push(callback)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      cancelSchedule
    })
    const view = await mount(harness)
    const setVisibleBounds = (revision: number): void => {
      harness.manager.setBounds({
        browserSessionId: SESSION_ID,
        lifecycleId: LIFECYCLE_ID,
        revision,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        visible: true
      })
    }

    setVisibleBounds(1)
    scheduled.shift()?.()
    expect(view.getVisible()).toBe(true)
    expect(harness.window.contentView.addChildView).toHaveBeenCalledTimes(1)

    setVisibleBounds(2)
    const staleCallback = scheduled.shift()!
    harness.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: LIFECYCLE_ID })
    expect(cancelSchedule).toHaveBeenCalledTimes(1)
    expect(view.getVisible()).toBe(false)

    await mount(harness)
    setVisibleBounds(1)
    const remountCallback = scheduled.shift()!
    staleCallback()
    expect(view.getVisible()).toBe(false)
    remountCallback()
    expect(view.getVisible()).toBe(true)
    expect(harness.window.contentView.addChildView).toHaveBeenCalledTimes(2)

    harness.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: LIFECYCLE_ID })
    await mount(harness)
    expect(() => setVisibleBounds(1)).not.toThrow()
    scheduled.shift()?.()
    expect(view.getVisible()).toBe(true)
    expect(harness.window.contentView.addChildView).toHaveBeenCalledTimes(3)
    expect(harness.views).toEqual([view])
    expect(view.webContents.getURL()).toBe('https://example.test/')
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('cleans pending mount tokens and empty session policies across high-cardinality churn', async () => {
    const sessions = new Map<string, FakeSession>()
    const harness = createHarness(browserState(), {
      getSession: (partition) => {
        const remoteSession = sessions.get(partition) ?? new FakeSession()
        sessions.set(partition, remoteSession)
        return remoteSession as unknown as Electron.Session
      }
    })
    const pendingResolutions: Array<(snapshot: WorkspaceSnapshotResult) => void> = []
    harness.control.snapshotWorkspace.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingResolutions.push(resolve)
        })
    )
    const pendingMounts: Promise<void>[] = []

    for (let index = 1; index <= 20; index += 1) {
      const browserSessionId = `30000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
      const lifecycleId = `70000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
      pendingMounts.push(
        harness.manager.mount({
          workspaceId: WORKSPACE_A,
          tabId: TAB_ID,
          browserSessionId,
          lifecycleId
        })
      )
      harness.manager.unmount({ browserSessionId, lifecycleId })
    }
    expect(harness.manager.diagnosticCounts).toEqual({
      entries: 0,
      pendingMounts: 0,
      sessionPolicies: 0,
      automationPages: 0
    })
    for (const resolve of pendingResolutions) resolve(workspaceResult(WORKSPACE_A))
    await Promise.all(pendingMounts)
    expect(harness.manager.diagnosticCounts).toEqual({
      entries: 0,
      pendingMounts: 0,
      sessionPolicies: 0,
      automationPages: 0
    })

    harness.control.snapshotWorkspace.mockImplementation(({ workspaceId }) => {
      const index = Number(workspaceId.slice(-12))
      const browserSessionId = `30000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
      const tabId = `20000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
      return Promise.resolve(
        workspaceResult(
          workspaceId,
          browserState({
            browserSessionId,
            profilePartition: `persist:churn-${index}`
          }),
          tabId
        )
      )
    })

    for (let index = 1; index <= 20; index += 1) {
      const suffix = index.toString().padStart(12, '0')
      const workspaceId = `10000000-0000-4000-8000-${suffix}`
      const tabId = `20000000-0000-4000-8000-${suffix}`
      const browserSessionId = `30000000-0000-4000-8000-${suffix}`
      const lifecycleId = `70000000-0000-4000-8000-${suffix}`
      await harness.manager.mount({ workspaceId, tabId, browserSessionId, lifecycleId })
      expect(harness.manager.diagnosticCounts).toEqual({
        entries: 1,
        pendingMounts: 0,
        sessionPolicies: 1,
        automationPages: 0
      })
      const remoteSession = sessions.get(`persist:churn-${index}`)!
      expect(remoteSession.permissionCheck).toBeTypeOf('function')
      expect(remoteSession.permissionRequest).toBeTypeOf('function')
      expect(remoteSession.listenerCount('will-download')).toBe(1)

      harness.manager.destroySession({ browserSessionId })
      expect(harness.manager.diagnosticCounts).toEqual({
        entries: 0,
        pendingMounts: 0,
        sessionPolicies: 0,
        automationPages: 0
      })
      expect(remoteSession.permissionCheck).toBeNull()
      expect(remoteSession.permissionRequest).toBeNull()
      expect(remoteSession.listenerCount('will-download')).toBe(0)
    }

    const reusedSessionId = '30000000-0000-4000-8000-000000000001'
    await harness.manager.mount({
      workspaceId: '10000000-0000-4000-8000-000000000001',
      tabId: '20000000-0000-4000-8000-000000000001',
      browserSessionId: reusedSessionId,
      lifecycleId: LIFECYCLE_ID
    })
    const reusedSession = sessions.get('persist:churn-1')!
    expect(reusedSession.permissionCheck).toBeTypeOf('function')
    expect(reusedSession.permissionRequest).toBeTypeOf('function')
    expect(reusedSession.listenerCount('will-download')).toBe(1)
    harness.manager.destroySession({ browserSessionId: reusedSessionId })
    expect(reusedSession.listenerCount('will-download')).toBe(0)
  })

  it('updates verified ownership when the same browser tab moves across workspaces', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    harness.control.snapshotWorkspace.mockResolvedValueOnce(workspaceResult(WORKSPACE_B))

    await expect(mount(harness, WORKSPACE_B)).resolves.toBe(view)
    expect(harness.views).toHaveLength(1)
    expect(view.webContents.close).not.toHaveBeenCalled()

    harness.manager.reconcileAuthoritativeSnapshot(workspaceResult(WORKSPACE_A, null))
    expect(harness.manager.size).toBe(1)
  })

  it('pairs permission request and check handlers with default deny and explicit per-origin grants', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    const permissionContents = view.webContents as unknown as Electron.WebContents
    const details = { requestingUrl: 'https://example.test/page', isMainFrame: true }
    const checkDetails = { isMainFrame: true }

    expect(
      harness.remoteSession.permissionCheck?.(
        permissionContents,
        'geolocation',
        'https://example.test/page',
        checkDetails
      )
    ).toBe(false)
    const denied = vi.fn()
    harness.remoteSession.permissionRequest?.(permissionContents, 'geolocation', denied, details)
    await flushPromises()
    expect(denied).toHaveBeenCalledWith(false)

    harness.promptPermission.mockResolvedValueOnce(true)
    const granted = vi.fn()
    harness.remoteSession.permissionRequest?.(permissionContents, 'geolocation', granted, details)
    await flushPromises()
    expect(granted).toHaveBeenCalledWith(true)
    expect(
      harness.remoteSession.permissionCheck?.(
        permissionContents,
        'geolocation',
        'https://example.test/other',
        checkDetails
      )
    ).toBe(true)
    expect(
      harness.remoteSession.permissionCheck?.(
        permissionContents,
        'geolocation',
        'https://other.test/',
        checkDetails
      )
    ).toBe(false)
  })

  it('denies popups and intercepts unsafe navigation and redirect protocols', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    view.webContents.url = 'https://example.test/current'

    expect(view.webContents.popupHandler?.({ url: 'https://example.test/next' })).toEqual({
      action: 'deny'
    })
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://example.test/next')
    view.webContents.popupHandler?.({ url: 'https://other.test/' })
    expect(view.webContents.loadURL).not.toHaveBeenCalledWith('https://other.test/')

    harness.confirmExternal.mockResolvedValueOnce(true)
    const preventDefault = vi.fn()
    view.webContents.emit('will-navigate', {
      preventDefault,
      url: 'mailto:test@example.test',
      isMainFrame: true
    })
    await flushPromises()
    expect(preventDefault).toHaveBeenCalled()
    expect(harness.confirmExternal).toHaveBeenCalledWith('mailto:test@example.test')
    expect(harness.openExternal).toHaveBeenCalledWith('mailto:test@example.test')

    const safeRedirect = { preventDefault: vi.fn() }
    view.webContents.emit('will-redirect', {
      ...safeRedirect,
      url: 'https://example.test/redirected',
      isMainFrame: true
    })
    expect(safeRedirect.preventDefault).not.toHaveBeenCalled()

    harness.confirmExternal.mockResolvedValueOnce(true)
    const unsafeRedirect = { preventDefault: vi.fn() }
    view.webContents.emit('will-redirect', {
      ...unsafeRedirect,
      url: 'mailto:redirect@example.test',
      isMainFrame: true
    })
    await flushPromises()
    expect(unsafeRedirect.preventDefault).toHaveBeenCalled()
    expect(harness.confirmExternal).toHaveBeenCalledWith('mailto:redirect@example.test')
    expect(harness.openExternal).toHaveBeenCalledWith('mailto:redirect@example.test')

    const subframeRedirect = { preventDefault: vi.fn() }
    view.webContents.emit('will-redirect', {
      ...subframeRedirect,
      url: 'mailto:subframe@example.test',
      isMainFrame: false
    })
    expect(subframeRedirect.preventDefault).toHaveBeenCalled()
    expect(harness.confirmExternal).toHaveBeenCalledTimes(2)
  })

  it('denies unsafe subframe navigation without duplicating main-frame prompts', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    const mainFrameEvent = { preventDefault: vi.fn() }
    view.webContents.emit('will-frame-navigate', {
      ...mainFrameEvent,
      url: 'mailto:main@example.test',
      isMainFrame: true
    })
    expect(mainFrameEvent.preventDefault).not.toHaveBeenCalled()

    const navigateEvent = { preventDefault: vi.fn() }
    view.webContents.emit('will-navigate', {
      ...navigateEvent,
      url: 'mailto:main@example.test',
      isMainFrame: true
    })
    await flushPromises()
    expect(navigateEvent.preventDefault).toHaveBeenCalled()
    expect(harness.confirmExternal).toHaveBeenCalledTimes(1)
    expect(harness.confirmExternal).toHaveBeenCalledWith('mailto:main@example.test')

    const subframeEvent = { preventDefault: vi.fn() }
    view.webContents.emit('will-frame-navigate', {
      ...subframeEvent,
      url: 'mailto:subframe@example.test',
      isMainFrame: false
    })
    expect(subframeEvent.preventDefault).toHaveBeenCalled()
    expect(harness.confirmExternal).toHaveBeenCalledTimes(1)

    const safeSubframeEvent = { preventDefault: vi.fn() }
    view.webContents.emit('will-frame-navigate', {
      ...safeSubframeEvent,
      url: 'https://example.test/frame',
      isMainFrame: false
    })
    expect(safeSubframeEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('reruns structural reconciliation when an invalidation arrives in flight', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    const firstRefresh = deferred<WorkspaceListResult>()
    harness.control.listWorkspaces
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValueOnce(workspaceListResult([], 9))

    harness.control.emit(structuralEvent('tab.changed', 8))
    await flushPromises()
    expect(harness.control.listWorkspaces).toHaveBeenCalledTimes(1)

    harness.control.emit(structuralEvent('workspace.changed', 9))
    firstRefresh.resolve(workspaceListResult([workspaceResult(WORKSPACE_A).workspace], 8))
    await flushPromises()
    await flushPromises()

    expect(harness.control.listWorkspaces).toHaveBeenCalledTimes(2)
    expect(harness.manager.size).toBe(0)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('pauses downloads until an app-owned save dialog selects a path and cancels declined downloads', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    const item = {
      getURL: () => 'https://example.test/file',
      getFilename: () => '../unsafe?.txt',
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      setSavePath: vi.fn()
    }
    harness.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/file.txt' })

    harness.remoteSession.emit('will-download', { preventDefault: vi.fn() }, item, view.webContents)
    await flushPromises()
    expect(item.pause).toHaveBeenCalled()
    expect(harness.showSaveDialog).toHaveBeenCalledWith(
      harness.window,
      expect.objectContaining({
        title: browserMessages.native.saveDownloadTitle,
        buttonLabel: browserMessages.native.save,
        defaultPath: '/downloads/unsafe_.txt'
      })
    )
    expect(item.setSavePath).toHaveBeenCalledWith('/tmp/file.txt')
    expect(item.resume).toHaveBeenCalled()

    harness.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    harness.remoteSession.emit('will-download', { preventDefault: vi.fn() }, item, view.webContents)
    await flushPromises()
    expect(item.cancel).toHaveBeenCalled()
  })

  it('observes current navigation state with a revision above the authoritative baseline', async () => {
    const harness = createHarness(browserState({ stateRevision: 10 }))
    const view = await mount(harness)
    view.webContents.url = 'https://example.test/observed'
    view.webContents.title = 'Observed'
    view.webContents.canBack = true
    view.webContents.loading = true
    view.webContents.emit('did-navigate')

    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(harness.control.observeBrowser).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      tabId: TAB_ID,
      state: {
        browserSessionId: SESSION_ID,
        url: 'https://example.test/observed',
        navigationTitle: 'Observed',
        canBack: true,
        canForward: false,
        loading: true,
        devToolsOpen: false,
        profilePartition: 'persist:agent-workspace-default',
        stateRevision: 11,
        correlationId: 'browser:test'
      }
    })
  })

  it('bounds an observation storm to one in-flight request and one latest snapshot', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    const firstObservation = deferred<MutationResult>()
    harness.control.observeBrowser.mockImplementationOnce(() => firstObservation.promise)

    view.webContents.url = 'https://example.test/storm/first'
    view.webContents.title = 'Storm first'
    view.webContents.emit('page-title-updated')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(harness.control.observeBrowser).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 100; index += 1) {
      view.webContents.url = `https://example.test/storm/${index}`
      view.webContents.title = `Storm ${index}`
      view.webContents.emit(index % 2 === 0 ? 'page-title-updated' : 'did-navigate')
      await vi.advanceTimersByTimeAsync(0)
    }

    expect(harness.control.observeBrowser).toHaveBeenCalledTimes(1)
    firstObservation.resolve(
      mutationResult(WORKSPACE_A, harness.control.observeBrowser.mock.calls[0]![0].state)
    )
    await flushPromises()
    await flushPromises()

    expect(harness.control.observeBrowser).toHaveBeenCalledTimes(2)
    expect(harness.control.observeBrowser.mock.calls[1]![0].state).toMatchObject({
      url: 'https://example.test/storm/99',
      navigationTitle: 'Storm 99',
      stateRevision: 7
    })
    expect(
      harness.control.observeBrowser.mock.calls.map(([params]) => params.state.navigationTitle)
    ).toEqual(['Storm first', 'Storm 99'])
  })

  it('drops an observation backlog on unmount and never dispatches from the stale view', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    const firstObservation = deferred<MutationResult>()
    harness.control.observeBrowser.mockImplementationOnce(() => firstObservation.promise)

    view.webContents.url = 'https://example.test/in-flight'
    view.webContents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(harness.control.observeBrowser).toHaveBeenCalledTimes(1)

    view.webContents.url = 'https://example.test/queued-before-unmount'
    view.webContents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    harness.manager.unmount({ browserSessionId: SESSION_ID, lifecycleId: LIFECYCLE_ID })

    firstObservation.resolve(
      mutationResult(
        WORKSPACE_A,
        browserState({ url: 'https://example.test/stale-result', stateRevision: 99 })
      )
    )
    await flushPromises()
    await flushPromises()
    view.webContents.url = 'https://example.test/emitted-after-unmount'
    view.webContents.emit('page-title-updated')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    expect(harness.control.observeBrowser).toHaveBeenCalledTimes(1)
  })

  it('isolates a replacement lifecycle from queued work and the stale completion', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    const firstObservation = deferred<MutationResult>()
    harness.control.observeBrowser.mockImplementationOnce(() => firstObservation.promise)

    view.webContents.url = 'https://example.test/old-in-flight'
    view.webContents.title = 'Old in flight'
    view.webContents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    view.webContents.url = 'https://example.test/old-queued'
    view.webContents.title = 'Old queued'
    view.webContents.emit('page-title-updated')
    await vi.advanceTimersByTimeAsync(0)

    const replacementState = browserState({
      url: 'https://example.test/replacement',
      navigationTitle: 'Replacement',
      stateRevision: 20,
      correlationId: 'browser:replacement'
    })
    harness.control.snapshotWorkspace.mockResolvedValueOnce(
      workspaceResult(WORKSPACE_A, replacementState)
    )
    await harness.manager.mount({
      workspaceId: WORKSPACE_A,
      tabId: TAB_ID,
      browserSessionId: SESSION_ID,
      lifecycleId: REPLACEMENT_LIFECYCLE_ID
    })

    view.webContents.url = 'https://example.test/replacement-latest'
    view.webContents.title = 'Replacement latest'
    view.webContents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.control.observeBrowser).toHaveBeenCalledTimes(1)

    firstObservation.resolve(
      mutationResult(
        WORKSPACE_A,
        browserState({
          url: 'https://example.test/stale-old-result',
          stateRevision: 99,
          correlationId: 'browser:stale'
        })
      )
    )
    await flushPromises()
    await flushPromises()

    expect(harness.control.observeBrowser).toHaveBeenCalledTimes(2)
    expect(harness.control.observeBrowser.mock.calls[1]![0]).toMatchObject({
      workspaceId: WORKSPACE_A,
      tabId: TAB_ID,
      state: {
        url: 'https://example.test/replacement-latest',
        navigationTitle: 'Replacement latest',
        stateRevision: 21,
        correlationId: 'browser:replacement'
      }
    })
    expect(
      harness.control.observeBrowser.mock.calls.map(([params]) => params.state.navigationTitle)
    ).toEqual(['Old in flight', 'Replacement latest'])
  })

  it('derives navigation capabilities from the active history index and traverses by index', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    view.webContents.canBack = true
    view.webContents.canForward = true

    harness.manager.back(SESSION_ID)
    harness.manager.forward(SESSION_ID)

    expect(view.webContents.navigationHistory.goToIndex).toHaveBeenNthCalledWith(1, 0)
    expect(view.webContents.navigationHistory.goToIndex).toHaveBeenNthCalledWith(2, 2)
  })

  it('advances observed revisions without replaying delayed URLs into native history', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    view.webContents.loadURL.mockClear()
    view.webContents.url = 'https://example.test/newer-navigation'

    harness.control.emit({
      event: 'browser.changed',
      revision: 12,
      data: {
        state: browserState({
          url: 'https://example.test/delayed-observation',
          stateRevision: 12
        })
      }
    })

    expect(view.webContents.loadURL).not.toHaveBeenCalled()
    view.webContents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(harness.control.observeBrowser.mock.calls.at(-1)?.[0].state).toMatchObject({
      url: 'https://example.test/newer-navigation',
      stateRevision: 13
    })
  })

  it('reconciles the authoritative mutation before applying its live navigation URL', async () => {
    const harness = createHarness()
    const view = await mount(harness)
    const authoritative = browserState({
      url: 'https://example.test/backend-authoritative',
      stateRevision: 12,
      correlationId: 'browser:backend'
    })

    harness.manager.applyCommandMutation(
      mutationResult(WORKSPACE_A, authoritative),
      SESSION_ID,
      'navigate'
    )

    expect(view.webContents.loadURL).toHaveBeenLastCalledWith(
      'https://example.test/backend-authoritative'
    )
    view.webContents.url = authoritative.url
    view.webContents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(harness.control.observeBrowser.mock.calls.at(-1)?.[0].state.stateRevision).toBe(13)
  })
})
