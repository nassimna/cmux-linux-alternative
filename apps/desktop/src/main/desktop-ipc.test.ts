/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel)
  },
  dialog: {
    showOpenDialog: electron.showOpenDialog,
    showMessageBox: electron.showMessageBox,
    showSaveDialog: electron.showSaveDialog
  },
  shell: { openExternal: electron.openExternal, openPath: electron.openPath }
}))

import { DESKTOP_IPC } from '../shared/desktop-bridge'
import { desktopMessages } from '../shared/desktop-messages'
import projection from '../../../../crates/protocol/fixtures/milestone2-projection.json'
import type { BrowserViewManager } from './browser-view-manager'
import { ControlRequestError, type ControlClient } from './control-client'
import {
  DESKTOP_INVOKE_CHANNELS,
  DESKTOP_LIFECYCLE_INVOKE_CHANNELS,
  constrainSidebarWidth,
  forwardDesktopEvents,
  registerDesktopHandlers as registerGlobalDesktopHandlers,
  registerDesktopLifecycleHandlers as registerGlobalDesktopLifecycleHandlers,
  registerMultiWindowDesktopHandlers,
  removeDesktopLifecycleHandlers
} from './desktop-ipc'
import { DesktopWindowBinding } from './desktop-window-binding'
import { SenderBoundIpcRouter } from './sender-bound-ipc-router'
import { WindowRegistry } from './window-registry'

describe('sidebar width confinement', () => {
  it('uses the overlay width on narrow windows and the desktop cap otherwise', () => {
    expect(constrainSidebarWidth(332, 569)).toBe(332)
    expect(constrainSidebarWidth(600, 1280)).toBe(576)
  })
})

describe('desktop IPC boundary', () => {
  const mainFrame = {}
  const webContents = { id: 1, mainFrame, send: vi.fn() }
  const window = { webContents, isDestroyed: () => false } as unknown as Electron.BrowserWindow
  const applyCommandMutation = vi.fn()
  const mountBrowserView = vi.fn()
  const destroyBrowserSession = vi.fn()
  const browserViews = {
    applyCommandMutation,
    reconcileMutation: vi.fn(),
    mount: mountBrowserView,
    destroySession: destroyBrowserSession,
    unmount: vi.fn(),
    setBounds: vi.fn(),
    focus: vi.fn()
  } as unknown as BrowserViewManager

  function registerDesktopHandlers(
    targetWindow: Electron.BrowserWindow,
    client: ControlClient,
    views: BrowserViewManager,
    dependencies: Parameters<typeof registerGlobalDesktopHandlers>[1] = {}
  ): SenderBoundIpcRouter {
    const registry = new WindowRegistry()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceReady(client, views, vi.fn().mockResolvedValue(undefined))
    registry.register('window-a', targetWindow, binding)
    const router = new SenderBoundIpcRouter(registry)
    registerGlobalDesktopHandlers(router, dependencies)
    return router
  }

  function registerDesktopLifecycleHandlers(
    targetWindow: Electron.BrowserWindow,
    controller: Parameters<typeof registerGlobalDesktopLifecycleHandlers>[1],
    supervisor: Parameters<typeof registerGlobalDesktopLifecycleHandlers>[2],
    dependencies: Parameters<typeof registerGlobalDesktopLifecycleHandlers>[3]
  ): SenderBoundIpcRouter {
    const registry = new WindowRegistry()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    const client = controller.getClient()
    if (client) binding.replaceReady(client, browserViews, vi.fn().mockResolvedValue(undefined))
    registry.register('window-a', targetWindow, binding)
    const router = new SenderBoundIpcRouter(registry)
    registerGlobalDesktopLifecycleHandlers(router, controller, supervisor, dependencies)
    return router
  }

  beforeEach(() => {
    electron.handlers.clear()
    vi.clearAllMocks()
  })

  it('registers the complete bridge without the removed singleton terminal channel', () => {
    registerDesktopHandlers(window, {} as ControlClient, browserViews)

    expect([...electron.handlers.keys()]).toEqual(DESKTOP_INVOKE_CHANNELS)
    expect(electron.handlers.has('terminal:ensure')).toBe(false)
  })

  it('rejects callers that are not the window main frame', async () => {
    const identify = vi.fn()
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews)
    const handler = electron.handlers.get(DESKTOP_IPC.identify)

    expect(() => handler?.({ sender: webContents, senderFrame: {} })).toThrow(/Unauthorized/)
    expect(identify).not.toHaveBeenCalled()
  })

  it('holds privileged renderer initialization until provider window acknowledgement', async () => {
    let release!: () => void
    const activation = new Promise<void>((resolve) => (release = resolve))
    const identify = vi.fn().mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: []
    })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      waitForWindowActivation: () => activation
    })
    const request = electron.handlers.get(DESKTOP_IPC.identify)?.({
      sender: webContents,
      senderFrame: mainFrame
    })
    await Promise.resolve()
    expect(identify).not.toHaveBeenCalled()

    release()
    await request
    expect(identify).toHaveBeenCalledOnce()
  })

  it('removes application-global saved layouts from multi-window renderer capabilities', async () => {
    const identify = vi.fn().mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: ['multi-window-v1', 'saved-layouts-v1']
    })
    const listSavedLayouts = vi.fn()
    registerDesktopHandlers(
      window,
      { identify, listSavedLayouts } as unknown as ControlClient,
      browserViews,
      { isApplicationGlobalLayoutAvailable: () => false }
    )
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(electron.handlers.get(DESKTOP_IPC.identify)?.(event)).resolves.toMatchObject({
      capabilities: ['multi-window-v1']
    })
    await expect(electron.handlers.get(DESKTOP_IPC.layoutList)?.(event)).resolves.toBeNull()
    expect(listSavedLayouts).not.toHaveBeenCalled()
  })

  it('keeps public-action idempotency and exact renderer targets in trusted main', async () => {
    const listAllActions = vi.fn().mockResolvedValue({
      registryRevision: 4,
      idempotencyEpoch: '20000000-0000-4000-8000-000000000001',
      definitions: [
        {
          actionId: 'desktop.window.focus',
          actionVersion: 1,
          localizedTitleKey: 'actions.desktop_window_focus',
          category: 'window',
          owner: 'desktop',
          parameterSchemaVersion: 1,
          resultSchemaVersion: 1,
          authorizationClass: 'owner',
          interactionClass: 'desktopInteraction',
          requiredDesktopCapability: 'desktop-window-focus-v1',
          limits: { maxParameterBytes: 2, maxResultBytes: 2, timeoutMs: 30_000 }
        },
        {
          actionId: 'project.example.build',
          actionVersion: 1,
          localizedTitleKey: 'actions.project_custom',
          category: 'project',
          owner: 'service',
          parameterSchemaVersion: 1,
          resultSchemaVersion: 1,
          authorizationClass: 'owner',
          interactionClass: 'confirmationRequired',
          limits: { maxParameterBytes: 2, maxResultBytes: 1024, timeoutMs: 30_000 }
        }
      ]
    })
    const invokeAction = vi.fn().mockImplementation((params: { correlationId: string }) => ({
      invocationId: '20000000-0000-4000-8000-000000000002',
      correlationId: params.correlationId,
      state: 'acknowledged',
      terminalCode: 'succeeded',
      result: {},
      updatedAtMs: 5
    }))
    registerDesktopHandlers(
      window,
      { listAllActions, invokeAction } as unknown as ControlClient,
      browserViews
    )
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      electron.handlers.get(DESKTOP_IPC.actionInvoke)?.(event, {
        actionId: 'desktop.window.focus',
        actionVersion: 1,
        parameters: {}
      })
    ).resolves.toMatchObject({ state: 'acknowledged', result: {} })

    expect(invokeAction).toHaveBeenCalledOnce()
    const params = invokeAction.mock.calls[0]?.[0] as {
      correlationId: string
      idempotency: { epoch: string; key: string }
    }
    expect(params).toMatchObject({
      actionId: 'desktop.window.focus',
      target: { windowId: 'window-a', windowGeneration: 1 },
      idempotency: { epoch: '20000000-0000-4000-8000-000000000001' }
    })
    expect(params.idempotency.key).toMatch(/^[0-9a-f-]{36}$/u)
    expect(params.correlationId).toMatch(/^[0-9a-f-]{36}$/u)

    await expect(
      electron.handlers.get(DESKTOP_IPC.actionInvoke)?.(event, {
        actionId: 'project.example.build',
        actionVersion: 1,
        parameters: {}
      })
    ).resolves.toMatchObject({ state: 'acknowledged', result: {} })
    expect(invokeAction.mock.calls[1]?.[0]).toMatchObject({
      actionId: 'project.example.build',
      target: { windowId: 'window-a', windowGeneration: 1 }
    })
  })

  it('owns destructive task confirmation and never accepts a renderer challenge', async () => {
    const target = {
      sessionId: '20000000-0000-4000-8000-000000000010',
      generation: 2,
      revision: 7
    }
    const issueTaskConfirmation = vi
      .fn<ControlClient['issueTaskConfirmation']>()
      .mockImplementation(async (params) => ({
        confirmation: {
          invocationId: '20000000-0000-4000-8000-000000000011',
          action: params.action,
          kind: 'terminal',
          target,
          providerId: '20000000-0000-4000-8000-000000000012',
          providerEpoch: 1,
          providerLeaseId: '20000000-0000-4000-8000-000000000013',
          windowId: 'window-a',
          windowGeneration: 1,
          requestHash: params.requestHash,
          nonce: '20000000-0000-4000-8000-000000000014',
          expiresAtMs: Date.now() + 30_000
        }
      }))
    const actOnTask = vi.fn().mockResolvedValue({
      target,
      lifecycle: 'terminating',
      observation: 'lastVerified',
      outcome: 'accepted',
      revision: 8
    })
    registerDesktopHandlers(
      window,
      { issueTaskConfirmation, actOnTask } as unknown as ControlClient,
      browserViews,
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false }) }
    )
    const event = { sender: webContents, senderFrame: mainFrame }
    await expect(
      electron.handlers.get(DESKTOP_IPC.taskAction)?.(event, {
        action: 'terminate',
        target
      })
    ).resolves.toMatchObject({ outcome: 'accepted' })

    expect(issueTaskConfirmation).toHaveBeenCalledOnce()
    expect(actOnTask).toHaveBeenCalledOnce()
    const submitted = actOnTask.mock.calls[0]?.[0] as unknown as {
      confirmation: { requestHash: string }
      mutation: { requestHash: string }
    }
    expect(submitted.confirmation).toMatchObject({ action: 'terminate', target })
    expect(submitted.mutation.requestHash).toBe(submitted.confirmation.requestHash)
    await expect(
      electron.handlers.get(DESKTOP_IPC.taskAction)?.(event, {
        action: 'terminate',
        target,
        confirmation: { nonce: 'renderer-forged' }
      })
    ).rejects.toThrow()
  })

  it('keeps search export confirmation and destination in main and writes the exact artifact', async () => {
    const sourceAuthorizationId = '20000000-0000-4000-8000-000000000020'
    const confirmationId = '20000000-0000-4000-8000-000000000021'
    const artifactText = '{"private":"exact service artifact"}'
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-search-export-'))
    const destination = join(directory, 'vault.json')
    const issueSearchExportConfirmation = vi.fn().mockResolvedValue({
      confirmation: { confirmationId, sourceAuthorizationId, expiresAtMs: 10 }
    })
    const exportSearchSource = vi.fn().mockResolvedValue({
      sourceAuthorizationId,
      artifact: {
        document: {
          documentId: '20000000-0000-4000-8000-000000000022',
          identityVersion: 1
        },
        offset: 0,
        text: artifactText,
        eof: true,
        contentRevision: 1,
        displayName: 'search-export.json'
      }
    })
    registerDesktopHandlers(
      window,
      { issueSearchExportConfirmation, exportSearchSource } as unknown as ControlClient,
      browserViews,
      {
        showMessageBox: electron.showMessageBox,
        showSaveDialog: electron.showSaveDialog
      }
    )
    const handler = electron.handlers.get(DESKTOP_IPC.searchExport)
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      handler?.(event, { sourceAuthorizationId, confirmationId, path: destination })
    ).rejects.toThrow()
    expect(issueSearchExportConfirmation).not.toHaveBeenCalled()

    electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(handler?.(event, { sourceAuthorizationId })).resolves.toBe(false)
    expect(issueSearchExportConfirmation).not.toHaveBeenCalled()
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })

    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(handler?.(event, { sourceAuthorizationId })).resolves.toBe(false)
    expect(issueSearchExportConfirmation).not.toHaveBeenCalled()
    expect(exportSearchSource).not.toHaveBeenCalled()
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })

    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination })
    await expect(handler?.(event, { sourceAuthorizationId })).resolves.toBe(true)
    expect(issueSearchExportConfirmation).toHaveBeenCalledWith({ sourceAuthorizationId })
    expect(exportSearchSource).toHaveBeenCalledWith({ sourceAuthorizationId, confirmationId })
    await expect(readFile(destination, 'utf8')).resolves.toBe(artifactText)

    await rm(directory, { recursive: true, force: true })
  })

  it('binds confirmation actions to the sender window instead of another focused window', async () => {
    const registry = new WindowRegistry()
    const secondFrame = {}
    const secondContents = { id: 2, mainFrame: secondFrame, send: vi.fn() }
    const secondWindow = {
      webContents: secondContents,
      isDestroyed: () => false
    } as unknown as Electron.BrowserWindow
    const catalog = {
      registryRevision: 4,
      idempotencyEpoch: '20000000-0000-4000-8000-000000000001',
      definitions: [
        {
          actionId: 'project.example.build',
          actionVersion: 1,
          localizedTitleKey: 'actions.project_custom',
          category: 'project',
          owner: 'service',
          parameterSchemaVersion: 1,
          resultSchemaVersion: 1,
          authorizationClass: 'owner',
          interactionClass: 'confirmationRequired',
          limits: { maxParameterBytes: 2, maxResultBytes: 1024, timeoutMs: 30_000 }
        }
      ]
    }
    const invokeAction = vi.fn().mockImplementation((params: { correlationId: string }) => ({
      invocationId: '20000000-0000-4000-8000-000000000002',
      correlationId: params.correlationId,
      state: 'acknowledged',
      terminalCode: 'succeeded',
      result: {},
      updatedAtMs: 5
    }))
    const senderClient = {
      listAllActions: vi.fn().mockResolvedValue(catalog),
      invokeAction
    } as unknown as ControlClient
    const otherInvokeAction = vi.fn()
    const otherClient = {
      listAllActions: vi.fn().mockResolvedValue(catalog),
      invokeAction: otherInvokeAction
    } as unknown as ControlClient
    for (const [windowId, targetWindow, client] of [
      ['window-sender', window, senderClient],
      ['window-focused-elsewhere', secondWindow, otherClient]
    ] as const) {
      const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
      binding.replaceReady(client, browserViews, vi.fn().mockResolvedValue(undefined))
      registry.register(windowId, targetWindow, binding)
    }
    registerGlobalDesktopHandlers(new SenderBoundIpcRouter(registry))

    await electron.handlers.get(DESKTOP_IPC.actionInvoke)?.(
      { sender: webContents, senderFrame: mainFrame },
      { actionId: 'project.example.build', actionVersion: 1, parameters: {} }
    )

    expect(invokeAction.mock.calls[0]?.[0]).toMatchObject({
      target: { windowId: 'window-sender', windowGeneration: 1 }
    })
    expect(otherInvokeAction).not.toHaveBeenCalled()
  })

  it('routes M3 IPC by registry sender and denies forged source-window authority', async () => {
    const registry = new WindowRegistry()
    const routedFrame = {}
    const routedContents = { id: 91, mainFrame: routedFrame }
    const routedWindow = {
      webContents: routedContents,
      isDestroyed: () => false
    } as unknown as Electron.BrowserWindow
    const duplicateTab = vi.fn()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceReady(
      { duplicateTab } as unknown as ControlClient,
      browserViews,
      vi.fn().mockResolvedValue(undefined)
    )
    const windowId = '10000000-0000-4000-8000-000000000010'
    registry.register(windowId, routedWindow, binding)
    registerMultiWindowDesktopHandlers(new SenderBoundIpcRouter(registry))
    const request = {
      mutation: {
        expectedRevision: 1,
        idempotencyEpoch: '10000000-0000-4000-8000-000000000020',
        idempotencyKey: '10000000-0000-4000-8000-000000000021'
      },
      source: {
        windowId: '10000000-0000-4000-8000-000000000099',
        workspaceId: '10000000-0000-4000-8000-000000000001',
        paneId: '11000000-0000-4000-8000-000000000001',
        tabId: '20000000-0000-4000-8000-000000000001',
        expectedWindowRevision: 1
      },
      target: {
        windowId,
        workspaceId: '10000000-0000-4000-8000-000000000001',
        paneId: '11000000-0000-4000-8000-000000000001',
        destinationIndex: 0,
        expectedWindowRevision: 1
      }
    }

    await expect(
      electron.handlers.get(DESKTOP_IPC.tabDuplicate)?.(
        { sender: routedContents, senderFrame: routedFrame },
        request
      )
    ).rejects.toThrow('Unauthorized window authority')
    expect(duplicateTab).not.toHaveBeenCalled()
  })

  it('returns one directory selected through the trusted native picker', async () => {
    electron.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/home/alex/project']
    })
    registerDesktopHandlers(window, {} as ControlClient, browserViews)
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(electron.handlers.get(DESKTOP_IPC.workspacePickDirectory)?.(event)).resolves.toBe(
      '/home/alex/project'
    )
    expect(electron.showOpenDialog).toHaveBeenCalledWith(window, {
      title: 'Open a folder as a workspace',
      buttonLabel: 'Open workspace',
      properties: ['openDirectory', 'createDirectory']
    })

    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(
      electron.handlers.get(DESKTOP_IPC.workspacePickDirectory)?.(event)
    ).resolves.toBeNull()
  })

  it('rejects invalid inputs before dispatch and invalid results after dispatch', async () => {
    const createWorkspace = vi.fn()
    const identify = vi.fn().mockResolvedValue({ application: 'wrong' })
    registerDesktopHandlers(
      window,
      { createWorkspace, identify } as unknown as ControlClient,
      browserViews
    )
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      electron.handlers.get(DESKTOP_IPC.workspaceCreate)?.(event, { name: 'incomplete' })
    ).rejects.toThrow()
    expect(createWorkspace).not.toHaveBeenCalled()
    await expect(electron.handlers.get(DESKTOP_IPC.identify)?.(event)).rejects.toThrow()
  })

  it('fails closed before optional capability reads when the current binding lacks them', async () => {
    const identify = vi.fn().mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: []
    })
    const getWorkspaceOrganization = vi.fn()
    const listSavedLayouts = vi.fn()
    registerDesktopHandlers(
      window,
      { identify, getWorkspaceOrganization, listSavedLayouts } as unknown as ControlClient,
      browserViews
    )
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      electron.handlers.get(DESKTOP_IPC.workspaceOrganizationGet)?.(event)
    ).resolves.toBeNull()
    await expect(electron.handlers.get(DESKTOP_IPC.layoutList)?.(event)).resolves.toBeNull()

    expect(identify).toHaveBeenCalledTimes(2)
    expect(getWorkspaceOrganization).not.toHaveBeenCalled()
    expect(listSavedLayouts).not.toHaveBeenCalled()
  })

  it('resolves Git metadata only from the authoritative workspace path', async () => {
    const authoritativeWorkspace = structuredClone(projection.workspaces[0]!)
    authoritativeWorkspace.selectedPaneId = authoritativeWorkspace.panes[0]!.id
    authoritativeWorkspace.panes[0]!.selectedTabId = authoritativeWorkspace.tabs[0]!.id
    const snapshotWorkspace = vi.fn().mockResolvedValue({
      revision: projection.revision,
      workspace: authoritativeWorkspace
    })
    const resolveWorkspaceRuntimeMetadata = vi.fn().mockResolvedValue({
      gitBranch: 'feature/sidebar',
      gitStatus: {
        clean: false,
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
        ahead: 1,
        behind: 0
      }
    })
    const workspace = authoritativeWorkspace
    const selectedPane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)
    const selectedTab = workspace.tabs.find(({ id }) => id === selectedPane?.selectedTabId)
    const terminalId =
      selectedTab?.content.kind === 'terminal' ? selectedTab.content.runtimeSessionId : undefined
    const getTerminalRuntimeMetadata = vi.fn().mockResolvedValue({
      terminalId,
      listeningPorts: [3000, 5173]
    })
    registerDesktopHandlers(
      window,
      { snapshotWorkspace, getTerminalRuntimeMetadata } as unknown as ControlClient,
      browserViews,
      { resolveWorkspaceRuntimeMetadata }
    )
    const event = { sender: webContents, senderFrame: mainFrame }
    const params = { workspaceId: projection.workspaces[0]?.id }

    await expect(
      electron.handlers.get(DESKTOP_IPC.workspaceRuntimeMetadata)?.(event, params)
    ).resolves.toEqual({
      gitBranch: 'feature/sidebar',
      gitStatus: {
        clean: false,
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
        ahead: 1,
        behind: 0
      },
      listeningPorts: [3000, 5173]
    })
    expect(snapshotWorkspace).toHaveBeenCalledWith(params)
    expect(resolveWorkspaceRuntimeMetadata).toHaveBeenCalledWith(
      projection.workspaces[0]?.workingDirectory
    )
    expect(getTerminalRuntimeMetadata).toHaveBeenCalledWith(terminalId)

    await expect(
      electron.handlers.get(DESKTOP_IPC.workspaceRuntimeMetadata)?.(event, {
        workspaceId: 'invalid',
        workingDirectory: '/renderer-controlled'
      })
    ).rejects.toThrow()
    expect(snapshotWorkspace).toHaveBeenCalledOnce()
  })

  it('lists trusted openers and opens only the authoritative workspace directory', async () => {
    const workspaceDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-open-path-'))
    try {
      const authoritativeWorkspace = {
        ...structuredClone(projection.workspaces[0]!),
        workingDirectory: workspaceDirectory
      }
      const listWindows = vi.fn().mockResolvedValue({
        revision: 1,
        idempotencyEpoch: '20000000-0000-4000-8000-000000000001',
        windows: [
          {
            windowId: 'window-a',
            revision: 1,
            workspaceIds: [authoritativeWorkspace.id],
            selectedWorkspaceId: authoritativeWorkspace.id,
            focused: true
          }
        ]
      })
      const snapshotWorkspace = vi.fn().mockResolvedValue({
        revision: projection.revision,
        workspace: authoritativeWorkspace
      })
      const detectWorkspacePathOpeners = vi.fn().mockResolvedValue([
        { id: 'fileManager', label: 'File Explorer', kind: 'fileManager' },
        { id: 'vscode', label: 'Visual Studio Code', kind: 'ide' }
      ])
      const openWorkspacePath = vi.fn().mockResolvedValue(undefined)
      registerDesktopHandlers(
        window,
        { listWindows, snapshotWorkspace } as unknown as ControlClient,
        browserViews,
        { detectWorkspacePathOpeners, openWorkspacePath }
      )
      const event = { sender: webContents, senderFrame: mainFrame }

      await expect(
        electron.handlers.get(DESKTOP_IPC.workspacePathOpeners)?.(event)
      ).resolves.toEqual([
        { id: 'fileManager', label: 'File Explorer', kind: 'fileManager' },
        { id: 'vscode', label: 'Visual Studio Code', kind: 'ide' }
      ])
      await expect(
        electron.handlers.get(DESKTOP_IPC.workspacePathOpen)?.(event, {
          workspaceId: authoritativeWorkspace.id,
          openerId: 'vscode'
        })
      ).resolves.toBeUndefined()

      expect(openWorkspacePath).toHaveBeenCalledWith('vscode', workspaceDirectory)
      await expect(
        electron.handlers.get(DESKTOP_IPC.workspacePathOpen)?.(event, {
          workspaceId: authoritativeWorkspace.id,
          openerId: 'renderer-command'
        })
      ).rejects.toThrow()
      expect(openWorkspacePath).toHaveBeenCalledOnce()
    } finally {
      await rm(workspaceDirectory, { recursive: true, force: true })
    }
  })

  it('validates and routes notification list and mutation operations', async () => {
    const listNotifications = vi.fn().mockResolvedValue({
      revision: 42,
      notifications: [],
      total: 0,
      unreadCount: 0
    })
    const markNotificationRead = vi.fn().mockResolvedValue({
      revision: 43,
      snapshot: { ...projection, revision: 43 }
    })
    registerDesktopHandlers(
      window,
      {
        listNotifications,
        markNotificationRead
      } as unknown as ControlClient,
      browserViews
    )
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      electron.handlers.get(DESKTOP_IPC.notificationList)?.(event, { unreadOnly: true, limit: 25 })
    ).resolves.toMatchObject({ revision: 42, unreadCount: 0 })
    expect(listNotifications).toHaveBeenCalledWith({ unreadOnly: true, offset: 0, limit: 25 })

    const params = { notificationId: '60000000-0000-4000-8000-000000000001' }
    await expect(
      electron.handlers.get(DESKTOP_IPC.notificationMarkRead)?.(event, params)
    ).resolves.toMatchObject({ revision: 43 })
    expect(markNotificationRead).toHaveBeenCalledWith(params)
  })

  it('validates and routes card slots without using mutation reconciliation', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const getWorkspaceCardSlots = vi.fn().mockResolvedValue({
      workspaceId,
      revision: 0,
      agentStatus: null,
      progress: null
    })
    const replaceWorkspaceCardSlots = vi.fn().mockResolvedValue({
      workspaceId,
      revision: 1,
      agentStatus: { status: 'running', label: null },
      progress: null
    })
    registerDesktopHandlers(
      window,
      { getWorkspaceCardSlots, replaceWorkspaceCardSlots } as unknown as ControlClient,
      browserViews
    )
    const event = { sender: webContents, senderFrame: mainFrame }
    await expect(
      electron.handlers.get(DESKTOP_IPC.workspaceCardSlotsGet)?.(event, { workspaceId })
    ).resolves.toMatchObject({ revision: 0 })
    await expect(
      electron.handlers.get(DESKTOP_IPC.workspaceCardSlotsReplace)?.(event, {
        workspaceId,
        expectedRevision: 0,
        agentStatus: { status: 'running', label: null },
        progress: null
      })
    ).resolves.toMatchObject({ revision: 1 })
    expect(applyCommandMutation).not.toHaveBeenCalled()
  })

  it('encodes card-slot conflict codes for the isolated preload boundary', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const replaceWorkspaceCardSlots = vi
      .fn()
      .mockRejectedValue(new ControlRequestError('revision_conflict', 'Use a fresh revision'))
    registerDesktopHandlers(
      window,
      { replaceWorkspaceCardSlots } as unknown as ControlClient,
      browserViews
    )
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      electron.handlers.get(DESKTOP_IPC.workspaceCardSlotsReplace)?.(event, {
        workspaceId,
        expectedRevision: 0,
        agentStatus: null,
        progress: null
      })
    ).rejects.toThrow('[agent-workspace-protocol-error:revision_conflict] Use a fresh revision')
  })

  it('rejects invalid notification identifiers and malformed notification results', async () => {
    const listNotifications = vi.fn().mockResolvedValue({
      revision: 42,
      notifications: [],
      total: -1,
      unreadCount: 0
    })
    const markNotificationUnread = vi.fn()
    registerDesktopHandlers(
      window,
      {
        listNotifications,
        markNotificationUnread
      } as unknown as ControlClient,
      browserViews
    )
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      electron.handlers.get(DESKTOP_IPC.notificationMarkUnread)?.(event, {
        notificationId: 'not-a-uuid'
      })
    ).rejects.toThrow()
    expect(markNotificationUnread).not.toHaveBeenCalled()
    await expect(electron.handlers.get(DESKTOP_IPC.notificationList)?.(event, {})).rejects.toThrow()
  })

  it('validates browser payloads and applies live actions only after a successful backend mutation', async () => {
    const navigateBrowser = vi
      .fn()
      .mockRejectedValueOnce(new Error('stale state revision'))
      .mockResolvedValueOnce({ revision: 43, snapshot: { ...projection, revision: 43 } })
    registerDesktopHandlers(window, { navigateBrowser } as unknown as ControlClient, browserViews)
    const event = { sender: webContents, senderFrame: mainFrame }
    const params = {
      browserSessionId: '50000000-0000-4000-8000-000000000001',
      url: 'https://example.test/next',
      expectedStateRevision: 0,
      correlationId: 'browser:test'
    }

    await expect(
      electron.handlers.get(DESKTOP_IPC.browserNavigate)?.(event, params)
    ).rejects.toThrow(/stale/)
    expect(applyCommandMutation).not.toHaveBeenCalled()

    await expect(
      electron.handlers.get(DESKTOP_IPC.browserNavigate)?.(event, params)
    ).resolves.toMatchObject({ revision: 43 })
    expect(navigateBrowser).toHaveBeenLastCalledWith(params)
    expect(applyCommandMutation).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 43 }),
      params.browserSessionId,
      'navigate'
    )

    await expect(
      electron.handlers.get(DESKTOP_IPC.browserNavigate)?.(event, {
        ...params,
        expectedStateRevision: -1
      })
    ).rejects.toThrow()
    expect(navigateBrowser).toHaveBeenCalledTimes(2)
  })

  it('locks native browser view handlers to the main frame and strict local schemas', async () => {
    registerDesktopHandlers(window, {} as ControlClient, browserViews)
    const params = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      tabId: '40000000-0000-4000-8000-000000000003',
      browserSessionId: '50000000-0000-4000-8000-000000000001',
      lifecycleId: '70000000-0000-4000-8000-000000000001'
    }

    expect(() =>
      electron.handlers.get(DESKTOP_IPC.browserMountView)?.(
        { sender: webContents, senderFrame: {} },
        params
      )
    ).toThrow(/Unauthorized/)
    expect(mountBrowserView).not.toHaveBeenCalled()

    await expect(
      electron.handlers.get(DESKTOP_IPC.browserMountView)?.(
        { sender: webContents, senderFrame: mainFrame },
        { ...params, url: 'https://renderer-controlled.invalid' }
      )
    ).rejects.toThrow()
    expect(mountBrowserView).not.toHaveBeenCalled()
  })

  it('waits for provider ownership before target terminal attach and browser mount', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const waitForOwnershipTransfer = vi.fn(() => gate)
    const ownershipAcquired = vi.fn()
    const attachTerminal = vi.fn().mockResolvedValue({
      terminal: {
        id: '50000000-0000-4000-8000-000000000001',
        command: ['/bin/sh'],
        cwd: '/',
        rows: 24,
        cols: 80,
        processId: 1,
        exited: false,
        exitCode: undefined
      },
      output: [],
      lastSequence: 0,
      reconstructionComplete: true
    })
    registerDesktopHandlers(window, { attachTerminal } as unknown as ControlClient, browserViews, {
      waitForOwnershipTransfer,
      ownershipAcquired
    })
    const event = { sender: webContents, senderFrame: mainFrame }
    const terminalId = '50000000-0000-4000-8000-000000000001'
    const mount = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      tabId: '40000000-0000-4000-8000-000000000003',
      browserSessionId: '50000000-0000-4000-8000-000000000002',
      lifecycleId: '70000000-0000-4000-8000-000000000001'
    }

    const terminal = electron.handlers.get(DESKTOP_IPC.terminalAttach)?.(event, terminalId)
    const browser = electron.handlers.get(DESKTOP_IPC.browserMountView)?.(event, mount)
    await Promise.resolve()
    expect(attachTerminal).not.toHaveBeenCalled()
    expect(mountBrowserView).not.toHaveBeenCalled()
    release()
    await Promise.all([terminal, browser])
    expect(waitForOwnershipTransfer).toHaveBeenCalledWith('window-a', terminalId)
    expect(waitForOwnershipTransfer).toHaveBeenCalledWith('window-a', mount.browserSessionId)
    expect(attachTerminal).toHaveBeenCalledOnce()
    expect(mountBrowserView).toHaveBeenCalledOnce()
    expect(ownershipAcquired).toHaveBeenCalledWith('window-a', terminalId)
    expect(ownershipAcquired).toHaveBeenCalledWith('window-a', mount.browserSessionId)
  })

  it('rolls native acquisition back when bounded ownership tracking fails closed', async () => {
    const terminalId = '50000000-0000-4000-8000-000000000001'
    const attachTerminal = vi.fn().mockResolvedValue({
      terminal: {
        id: terminalId,
        command: ['/bin/sh'],
        cwd: '/',
        rows: 24,
        cols: 80,
        processId: 1,
        exited: false
      },
      output: [],
      lastSequence: 0,
      reconstructionComplete: true
    })
    const detachTerminal = vi.fn().mockResolvedValue(undefined)
    registerDesktopHandlers(
      window,
      { attachTerminal, detachTerminal } as unknown as ControlClient,
      browserViews,
      {
        ownershipAcquired: () => {
          throw new Error('tracking capacity is exhausted')
        }
      }
    )
    const event = { sender: webContents, senderFrame: mainFrame }
    const mount = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      tabId: '40000000-0000-4000-8000-000000000003',
      browserSessionId: '50000000-0000-4000-8000-000000000002',
      lifecycleId: '70000000-0000-4000-8000-000000000001'
    }

    await expect(
      electron.handlers.get(DESKTOP_IPC.terminalAttach)?.(event, terminalId)
    ).rejects.toThrow('capacity is exhausted')
    await expect(
      electron.handlers.get(DESKTOP_IPC.browserMountView)?.(event, mount)
    ).rejects.toThrow('capacity is exhausted')
    expect(detachTerminal).toHaveBeenCalledWith(terminalId)
    expect(destroyBrowserSession).toHaveBeenCalledWith({
      browserSessionId: mount.browserSessionId
    })
  })

  it('records a typed ownership barrier before forwarding the renderer invalidation', () => {
    const order: string[] = []
    let ownershipListener!: (event: never) => void
    const subscribe = vi.fn(() => () => undefined)
    const client = {
      onTerminalEvent: subscribe,
      onDomainEvent: subscribe,
      onWorkspaceCardSlotsEvent: subscribe,
      onWorkspaceCardSlotV2Event: subscribe,
      onWorkspaceAttentionEvent: subscribe,
      onDomainResyncRequired: subscribe,
      onServiceEvent: subscribe,
      onMultiWindowEvent: vi.fn((listener: Parameters<ControlClient['onMultiWindowEvent']>[0]) => {
        ownershipListener = listener
        return () => undefined
      })
    } as unknown as ControlClient
    const forwardingWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn(() => order.push('renderer')) }
    } as unknown as Electron.BrowserWindow
    forwardDesktopEvents(forwardingWindow, client, () => order.push('barrier'))
    const placement = (windowId: string) => ({
      windowId,
      workspaceId: '10000000-0000-4000-8000-000000000001',
      paneId: '11000000-0000-4000-8000-000000000001',
      index: 0,
      windowRevision: 4
    })

    ownershipListener({
      event: 'tab.ownershipTransferred',
      revision: 9,
      transferEpoch: 3,
      tabId: '40000000-0000-4000-8000-000000000003',
      runtimeSessionId: '50000000-0000-4000-8000-000000000001',
      ownershipKind: 'terminal',
      source: placement('70000000-0000-4000-8000-000000000001'),
      target: placement('70000000-0000-4000-8000-000000000002'),
      reason: 'tabMoved'
    } as never)

    expect(order).toEqual(['barrier', 'renderer'])
  })

  it('forwards strict public-action registry invalidations to the bound renderer', () => {
    let registryListener!: Parameters<ControlClient['onActionRegistryChanged']>[0]
    const subscribe = vi.fn(() => () => undefined)
    const client = {
      onTerminalEvent: subscribe,
      onDomainEvent: subscribe,
      onWorkspaceCardSlotsEvent: subscribe,
      onWorkspaceCardSlotV2Event: subscribe,
      onWorkspaceAttentionEvent: subscribe,
      onDomainResyncRequired: subscribe,
      onServiceEvent: subscribe,
      onActionRegistryChanged: vi.fn(
        (listener: Parameters<ControlClient['onActionRegistryChanged']>[0]) => {
          registryListener = listener
          return () => undefined
        }
      ),
      onMultiWindowEvent: subscribe
    } as unknown as ControlClient
    const send = vi.fn()
    const forwardingWindow = {
      isDestroyed: () => false,
      webContents: { send }
    } as unknown as Electron.BrowserWindow
    forwardDesktopEvents(forwardingWindow, client)
    const event = {
      event: 'action.registryChanged' as const,
      registryRevision: 12,
      reason: 'definitionsChanged' as const
    }

    registryListener(event)

    expect(send).toHaveBeenCalledWith(DESKTOP_IPC.actionRegistryChanged, event)
  })

  it('opens only bounded credential-free canonical HTTP(S) URLs externally', async () => {
    electron.openExternal.mockResolvedValue(undefined)
    registerDesktopHandlers(window, {} as ControlClient, browserViews)
    const event = { sender: webContents, senderFrame: mainFrame }
    const handler = electron.handlers.get(DESKTOP_IPC.openExternal)

    await expect(handler?.(event, 'https://example.test/path')).resolves.toBeUndefined()
    expect(electron.openExternal).toHaveBeenCalledWith('https://example.test/path')

    for (const unsafe of [
      'https://user:secret@example.test/',
      'HTTPS://example.test/',
      ' https://example.test/',
      'https://example.test/bad\npath',
      `https://example.test/${'x'.repeat(8_193)}`,
      'file:///etc/passwd',
      'javascript:alert(1)'
    ]) {
      await expect(handler?.(event, unsafe)).rejects.toThrow(/Invalid external URL/)
    }
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
  })

  it('binds destructive remote confirmation to exact revision and executes double-click once', async () => {
    const remoteTargetId = '30000000-0000-4000-8000-000000000001'
    const target = {
      remoteTargetId,
      label: 'dev',
      host: 'example.com',
      port: 22,
      user: 'alice',
      authentication: 'publicKey',
      hostKeyState: 'trusted',
      knownHostsVersion: 1,
      revision: 4
    }
    let confirm!: (value: Electron.MessageBoxReturnValue) => void
    const shown = new Promise<Electron.MessageBoxReturnValue>((resolve) => (confirm = resolve))
    const showMessageBox = vi.fn((...args: unknown[]) => {
      void args
      return shown
    })
    const getRemoteTarget = vi.fn().mockResolvedValue({ target })
    const deleteRemoteTarget = vi.fn().mockResolvedValue({ target })
    registerDesktopHandlers(
      window,
      { getRemoteTarget, deleteRemoteTarget } as unknown as ControlClient,
      browserViews,
      { showMessageBox, isWindowEntryCurrent: () => true }
    )
    const handler = electron.handlers.get(DESKTOP_IPC.remoteTargetDelete)
    const event = { sender: webContents, senderFrame: mainFrame }
    const request = { remoteTargetId, expectedRevision: 4 }
    const first = handler?.(event, request)
    const second = handler?.(event, request)
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce())
    confirm({ response: 1, checkboxChecked: false })

    await expect(Promise.all([first, second])).resolves.toEqual([{ target }, { target }])
    expect(getRemoteTarget).toHaveBeenCalledTimes(2)
    expect(deleteRemoteTarget).toHaveBeenCalledOnce()
  })

  it('keeps remote destructive cancellation side-effect free and rejects stale confirmation', async () => {
    const remoteTargetId = '30000000-0000-4000-8000-000000000002'
    const target = {
      remoteTargetId,
      label: 'dev',
      host: 'example.com',
      port: 22,
      user: 'alice',
      authentication: 'publicKey',
      hostKeyState: 'trusted',
      knownHostsVersion: 1,
      revision: 4
    }
    const getRemoteTarget = vi.fn().mockResolvedValue({ target })
    const deleteRemoteTarget = vi.fn()
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false })
    registerDesktopHandlers(
      window,
      { getRemoteTarget, deleteRemoteTarget } as unknown as ControlClient,
      browserViews,
      { showMessageBox, isWindowEntryCurrent: () => true }
    )
    const handler = electron.handlers.get(DESKTOP_IPC.remoteTargetDelete)
    const event = { sender: webContents, senderFrame: mainFrame }
    await expect(handler?.(event, { remoteTargetId, expectedRevision: 4 })).resolves.toBeNull()
    expect(deleteRemoteTarget).not.toHaveBeenCalled()

    electron.handlers.clear()
    getRemoteTarget
      .mockReset()
      .mockResolvedValueOnce({ target })
      .mockResolvedValueOnce({ target: { ...target, revision: 5 } })
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    registerDesktopHandlers(
      window,
      { getRemoteTarget, deleteRemoteTarget } as unknown as ControlClient,
      browserViews,
      { showMessageBox, isWindowEntryCurrent: () => true }
    )
    await expect(
      electron.handlers.get(DESKTOP_IPC.remoteTargetDelete)?.(event, {
        remoteTargetId,
        expectedRevision: 4
      })
    ).rejects.toThrow('revision is stale')
    expect(deleteRemoteTarget).not.toHaveBeenCalled()
  })

  it('keeps host-key authority in main, coalesces double clicks, and binds trust to the challenge target revision', async () => {
    const remoteTargetId = '30000000-0000-4000-8000-000000000021'
    const remoteSessionId = '30000000-0000-4000-8000-000000000022'
    const session = {
      remoteSessionId,
      remoteTargetId,
      workspaceId: '30000000-0000-4000-8000-000000000023',
      paneId: '30000000-0000-4000-8000-000000000024',
      tabId: '30000000-0000-4000-8000-000000000025',
      tmux: { mode: 'create', sessionName: 'main' },
      state: 'trustRequired',
      observation: 'unknown',
      attemptGeneration: 3,
      revision: 4,
      reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5_000 }
    }
    const target = {
      remoteTargetId,
      label: 'Build host',
      host: 'example.com',
      port: 2222,
      user: 'builder',
      authentication: 'publicKey',
      hostKeyState: 'untrusted',
      knownHostsVersion: 1,
      revision: 7
    }
    const challenge = {
      remoteSessionId,
      promptId: '30000000-0000-4000-8000-000000000026',
      attemptGeneration: 3,
      canonicalHost: 'example.com',
      port: 2222,
      algorithm: 'ssh-ed25519',
      publicKey: 'QUJDRA==',
      presentedFingerprint: 'SHA256:fixture',
      targetRevision: 7,
      expiresAtMs: 10_000
    }
    const provider = {
      providerId: '30000000-0000-4000-8000-000000000027',
      providerEpoch: 2,
      leaseId: '30000000-0000-4000-8000-000000000028'
    }
    let confirm!: (value: Electron.MessageBoxReturnValue) => void
    const shown = new Promise<Electron.MessageBoxReturnValue>((resolve) => (confirm = resolve))
    const showMessageBox = vi.fn((...args: unknown[]) => {
      void args
      return shown
    })
    const getRemoteSession = vi.fn().mockResolvedValue({ session })
    const getRemoteTarget = vi.fn().mockResolvedValue({ target })
    const scanRemoteHostKey = vi.fn().mockResolvedValue(challenge)
    const decideRemoteHostKey = vi.fn().mockResolvedValue({ session })
    registerDesktopHandlers(
      window,
      {
        getRemoteSession,
        getRemoteTarget,
        scanRemoteHostKey,
        decideRemoteHostKey
      } as unknown as ControlClient,
      browserViews,
      {
        showMessageBox,
        isWindowEntryCurrent: () => true,
        getDesktopProviderIdentity: () => provider
      }
    )
    const event = { sender: webContents, senderFrame: mainFrame }
    const handler = electron.handlers.get(DESKTOP_IPC.remoteHostKeyConfirm)
    const request = { remoteSessionId, expectedRevision: 4 }
    const first = handler?.(event, request)
    const second = handler?.(event, request)
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce())

    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        buttons: ['Reject', 'Trust and save this key'],
        defaultId: 0,
        cancelId: 0,
        detail: 'Host: example.com:2222\nAlgorithm: ssh-ed25519\nFingerprint: SHA256:fixture'
      })
    )
    expect(showMessageBox.mock.calls[0]?.[1]).not.toEqual(
      expect.objectContaining({ publicKey: challenge.publicKey })
    )
    confirm({ response: 1, checkboxChecked: false })

    await expect(Promise.all([first, second])).resolves.toEqual([{ session }, { session }])
    expect(scanRemoteHostKey).toHaveBeenCalledOnce()
    expect(decideRemoteHostKey).toHaveBeenCalledOnce()
    expect(decideRemoteHostKey).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteSessionId,
        promptId: challenge.promptId,
        attemptGeneration: 3,
        presentedFingerprint: 'SHA256:fixture',
        decision: 'trust',
        mutation: expect.objectContaining({ expectedRevision: 7 }) as unknown
      })
    )
  })

  it('coalesces one native host-key prompt across independent window bindings', async () => {
    const remoteTargetId = '31000000-0000-4000-8000-000000000021'
    const remoteSessionId = '31000000-0000-4000-8000-000000000022'
    const session = {
      remoteSessionId,
      remoteTargetId,
      workspaceId: '31000000-0000-4000-8000-000000000023',
      paneId: '31000000-0000-4000-8000-000000000024',
      tabId: '31000000-0000-4000-8000-000000000025',
      tmux: { mode: 'attach', sessionName: 'main' },
      state: 'trustRequired',
      observation: 'unknown',
      attemptGeneration: 2,
      revision: 3,
      reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5_000 }
    }
    const target = {
      remoteTargetId,
      label: 'Build host',
      host: 'example.com',
      port: 22,
      user: 'builder',
      authentication: 'publicKey',
      hostKeyState: 'untrusted',
      knownHostsVersion: 1,
      revision: 4
    }
    const challenge = {
      remoteSessionId,
      promptId: '31000000-0000-4000-8000-000000000026',
      attemptGeneration: 2,
      canonicalHost: 'example.com',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKey: 'QUJDRA==',
      presentedFingerprint: 'SHA256:global-fixture',
      targetRevision: 4,
      expiresAtMs: 10_000
    }
    const provider = {
      providerId: '31000000-0000-4000-8000-000000000027',
      providerEpoch: 2,
      leaseId: '31000000-0000-4000-8000-000000000028'
    }
    const getRemoteSession = vi.fn().mockResolvedValue({ session })
    const getRemoteTarget = vi.fn().mockResolvedValue({ target })
    const scanRemoteHostKey = vi.fn().mockResolvedValue(challenge)
    const decideRemoteHostKey = vi.fn().mockResolvedValue({ session })
    const client = {
      getRemoteSession,
      getRemoteTarget,
      scanRemoteHostKey,
      decideRemoteHostKey
    } as unknown as ControlClient
    const registry = new WindowRegistry()
    const frameA = {}
    const frameB = {}
    const contentsA = { id: 41, mainFrame: frameA }
    const contentsB = { id: 42, mainFrame: frameB }
    const windowA = {
      webContents: contentsA,
      isDestroyed: () => false
    } as unknown as Electron.BrowserWindow
    const windowB = {
      webContents: contentsB,
      isDestroyed: () => false
    } as unknown as Electron.BrowserWindow
    for (const [windowId, targetWindow] of [
      ['window-a', windowA],
      ['window-b', windowB]
    ] as const) {
      const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
      binding.replaceReady(client, browserViews, vi.fn().mockResolvedValue(undefined))
      registry.register(windowId, targetWindow, binding)
    }
    const router = new SenderBoundIpcRouter(registry)
    let confirm!: (value: Electron.MessageBoxReturnValue) => void
    const showMessageBox = vi.fn(
      () => new Promise<Electron.MessageBoxReturnValue>((resolve) => (confirm = resolve))
    )
    registerGlobalDesktopHandlers(router, {
      showMessageBox,
      isWindowEntryCurrent: () => true,
      getDesktopProviderIdentity: () => provider
    })
    const handler = electron.handlers.get(DESKTOP_IPC.remoteHostKeyConfirm)
    const first = handler?.(
      { sender: contentsA, senderFrame: frameA },
      { remoteSessionId, expectedRevision: 3 }
    )
    const second = handler?.(
      { sender: contentsB, senderFrame: frameB },
      { remoteSessionId, expectedRevision: 3 }
    )
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce())
    confirm({ response: 1, checkboxChecked: false })

    await expect(Promise.all([first, second])).resolves.toEqual([{ session }, { session }])
    expect(scanRemoteHostKey).toHaveBeenCalledOnce()
    expect(decideRemoteHostKey).toHaveBeenCalledOnce()
    expect(showMessageBox).toHaveBeenCalledWith(windowA, expect.anything())
  })

  it('uses a distinct fail-closed native confirmation for changed host keys', async () => {
    const remoteTargetId = '32000000-0000-4000-8000-000000000021'
    const remoteSessionId = '32000000-0000-4000-8000-000000000022'
    const session = {
      remoteSessionId,
      remoteTargetId,
      workspaceId: '32000000-0000-4000-8000-000000000023',
      paneId: '32000000-0000-4000-8000-000000000024',
      tabId: '32000000-0000-4000-8000-000000000025',
      state: 'trustRequired',
      observation: 'unknown',
      attemptGeneration: 1,
      revision: 2,
      reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5_000 }
    }
    const target = {
      remoteTargetId,
      label: 'Changed host',
      host: 'example.com',
      port: 22,
      user: 'builder',
      authentication: 'publicKey',
      hostKeyState: 'changed',
      knownHostsVersion: 3,
      revision: 5
    }
    const decideRemoteHostKey = vi.fn().mockResolvedValue({ session })
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false })
    registerDesktopHandlers(
      window,
      {
        getRemoteSession: vi.fn().mockResolvedValue({ session }),
        getRemoteTarget: vi.fn().mockResolvedValue({ target }),
        scanRemoteHostKey: vi.fn().mockResolvedValue({
          remoteSessionId,
          promptId: '32000000-0000-4000-8000-000000000026',
          attemptGeneration: 1,
          canonicalHost: 'example.com',
          port: 22,
          algorithm: 'ssh-ed25519',
          publicKey: 'QUJDRA==',
          presentedFingerprint: 'SHA256:replacement-fixture',
          targetRevision: 5,
          expiresAtMs: 10_000
        }),
        decideRemoteHostKey
      } as unknown as ControlClient,
      browserViews,
      {
        showMessageBox,
        isWindowEntryCurrent: () => true,
        getDesktopProviderIdentity: () => ({
          providerId: '32000000-0000-4000-8000-000000000027',
          providerEpoch: 1,
          leaseId: '32000000-0000-4000-8000-000000000028'
        })
      }
    )
    await expect(
      electron.handlers.get(DESKTOP_IPC.remoteHostKeyConfirm)?.(
        { sender: webContents, senderFrame: mainFrame },
        { remoteSessionId, expectedRevision: 2 }
      )
    ).resolves.toEqual({ session })
    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        title: 'Replace changed remote host key?',
        buttons: ['Keep blocked', 'Replace trusted key'],
        defaultId: 0,
        cancelId: 0
      })
    )
    expect(decideRemoteHostKey).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'reject' })
    )
  })

  it('fails host-key confirmation closed when the target changes under the native dialog', async () => {
    const remoteTargetId = '30000000-0000-4000-8000-000000000031'
    const remoteSessionId = '30000000-0000-4000-8000-000000000032'
    const session = {
      remoteSessionId,
      remoteTargetId,
      workspaceId: '30000000-0000-4000-8000-000000000033',
      paneId: '30000000-0000-4000-8000-000000000034',
      tabId: '30000000-0000-4000-8000-000000000035',
      state: 'trustRequired',
      observation: 'unknown',
      attemptGeneration: 1,
      revision: 2,
      reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5_000 }
    }
    const target = {
      remoteTargetId,
      label: 'Build host',
      host: 'example.com',
      port: 22,
      user: 'builder',
      authentication: 'publicKey',
      hostKeyState: 'untrusted',
      knownHostsVersion: 1,
      revision: 5
    }
    const decideRemoteHostKey = vi.fn()
    registerDesktopHandlers(
      window,
      {
        getRemoteSession: vi.fn().mockResolvedValue({ session }),
        getRemoteTarget: vi
          .fn()
          .mockResolvedValueOnce({ target })
          .mockResolvedValueOnce({ target: { ...target, revision: 6 } }),
        scanRemoteHostKey: vi.fn().mockResolvedValue({
          remoteSessionId,
          promptId: '30000000-0000-4000-8000-000000000036',
          attemptGeneration: 1,
          canonicalHost: 'example.com',
          port: 22,
          algorithm: 'ssh-ed25519',
          publicKey: 'QUJDRA==',
          presentedFingerprint: 'SHA256:fixture',
          targetRevision: 5,
          expiresAtMs: 10_000
        }),
        decideRemoteHostKey
      } as unknown as ControlClient,
      browserViews,
      {
        showMessageBox: vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false }),
        isWindowEntryCurrent: () => true,
        getDesktopProviderIdentity: () => ({
          providerId: '30000000-0000-4000-8000-000000000037',
          providerEpoch: 1,
          leaseId: '30000000-0000-4000-8000-000000000038'
        })
      }
    )

    await expect(
      electron.handlers.get(DESKTOP_IPC.remoteHostKeyConfirm)?.(
        { sender: webContents, senderFrame: mainFrame },
        { remoteSessionId, expectedRevision: 2 }
      )
    ).rejects.toThrow('desktop authority is stale')
    expect(decideRemoteHostKey).not.toHaveBeenCalled()
  })

  it('keeps legacy, M3, browser, dialog, terminal, and lifecycle IPC sender-bound across windows', async () => {
    const registry = new WindowRegistry()
    const frameA = {}
    const frameB = {}
    const contentsA = { id: 11, mainFrame: frameA }
    const contentsB = { id: 12, mainFrame: frameB }
    const windowA = {
      webContents: contentsA,
      isDestroyed: () => false
    } as unknown as Electron.BrowserWindow
    const windowB = {
      webContents: contentsB,
      isDestroyed: () => false
    } as unknown as Electron.BrowserWindow
    const identityA = {
      application: 'agent-workspace' as const,
      version: 'a',
      protocolVersion: 1 as const,
      capabilities: []
    }
    const identityB = { ...identityA, version: 'b' }
    const clientA = {
      identify: vi.fn().mockResolvedValue(identityA),
      markNotificationRead: vi
        .fn()
        .mockResolvedValue({ revision: 43, snapshot: { ...projection, revision: 43 } }),
      detachTerminal: vi.fn().mockResolvedValue(undefined),
      listClosedItems: vi.fn().mockResolvedValue({ revision: 101, items: [] })
    }
    const clientB = {
      identify: vi.fn().mockResolvedValue(identityB),
      markNotificationRead: vi
        .fn()
        .mockResolvedValue({ revision: 44, snapshot: { ...projection, revision: 44 } }),
      detachTerminal: vi.fn().mockResolvedValue(undefined),
      listClosedItems: vi.fn().mockResolvedValue({ revision: 202, items: [] })
    }
    const viewsA = { ...browserViews, mount: vi.fn().mockResolvedValue(undefined) }
    const viewsB = { ...browserViews, mount: vi.fn().mockResolvedValue(undefined) }
    const bindingA = new DesktopWindowBinding({ clearClient: vi.fn(), dispose: vi.fn() } as never)
    const bindingB = new DesktopWindowBinding({ clearClient: vi.fn(), dispose: vi.fn() } as never)
    bindingA.replaceReady(
      clientA as unknown as ControlClient,
      viewsA as unknown as BrowserViewManager,
      vi.fn().mockResolvedValue(undefined)
    )
    bindingB.replaceReady(
      clientB as unknown as ControlClient,
      viewsB as unknown as BrowserViewManager,
      vi.fn().mockResolvedValue(undefined)
    )
    registry.register('window-a', windowA, bindingA)
    registry.register('window-b', windowB, bindingB)
    const router = new SenderBoundIpcRouter(registry)
    const showOpenDialog = vi.fn(async (targetWindow: Electron.BrowserWindow) => ({
      canceled: false,
      filePaths: [targetWindow === windowA ? '/workspace/a' : '/workspace/b']
    }))
    registerGlobalDesktopHandlers(router, { showOpenDialog })
    registerGlobalDesktopHandlers(router, { showOpenDialog })
    registerMultiWindowDesktopHandlers(router)
    registerGlobalDesktopLifecycleHandlers(
      router,
      {
        getState: () => ({ status: 'ready' }),
        getClient: () => undefined,
        restart: vi.fn()
      },
      {} as never,
      { downloadsDirectory: '/downloads', quit: vi.fn() }
    )
    const eventA = { sender: contentsA, senderFrame: frameA }
    const eventB = { sender: contentsB, senderFrame: frameB }
    const terminalId = '50000000-0000-4000-8000-000000000001'
    const notification = { notificationId: '60000000-0000-4000-8000-000000000001' }
    const mount = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      tabId: '40000000-0000-4000-8000-000000000003',
      browserSessionId: '50000000-0000-4000-8000-000000000001',
      lifecycleId: '70000000-0000-4000-8000-000000000001'
    }

    const results = await Promise.all([
      electron.handlers.get(DESKTOP_IPC.identify)?.(eventA),
      electron.handlers.get(DESKTOP_IPC.identify)?.(eventB),
      electron.handlers.get(DESKTOP_IPC.notificationMarkRead)?.(eventA, notification),
      electron.handlers.get(DESKTOP_IPC.notificationMarkRead)?.(eventB, notification),
      electron.handlers.get(DESKTOP_IPC.terminalDetach)?.(eventA, terminalId),
      electron.handlers.get(DESKTOP_IPC.terminalDetach)?.(eventB, terminalId),
      electron.handlers.get(DESKTOP_IPC.browserMountView)?.(eventA, mount),
      electron.handlers.get(DESKTOP_IPC.browserMountView)?.(eventB, mount),
      electron.handlers.get(DESKTOP_IPC.workspacePickDirectory)?.(eventA),
      electron.handlers.get(DESKTOP_IPC.workspacePickDirectory)?.(eventB),
      electron.handlers.get(DESKTOP_IPC.closedList)?.(eventA),
      electron.handlers.get(DESKTOP_IPC.closedList)?.(eventB),
      electron.handlers.get(DESKTOP_IPC.lifecycleGet)?.(eventA),
      electron.handlers.get(DESKTOP_IPC.lifecycleGet)?.(eventB)
    ])

    expect(results[0]).toEqual(identityA)
    expect(results[1]).toEqual(identityB)
    expect(results[8]).toBe('/workspace/a')
    expect(results[9]).toBe('/workspace/b')
    expect(results[10]).toEqual({ revision: 101, items: [] })
    expect(results[11]).toEqual({ revision: 202, items: [] })
    expect(viewsA.mount).toHaveBeenCalledOnce()
    expect(viewsB.mount).toHaveBeenCalledOnce()
    expect(showOpenDialog).toHaveBeenCalledWith(windowA, expect.anything())
    expect(showOpenDialog).toHaveBeenCalledWith(windowB, expect.anything())

    await registry.remove('window-a', 'closed')
    expect(() => electron.handlers.get(DESKTOP_IPC.identify)?.(eventA)).toThrow(/Unauthorized/)
    await expect(electron.handlers.get(DESKTOP_IPC.identify)?.(eventB)).resolves.toEqual(identityB)
  })

  it('keeps lifecycle handlers available independently and authenticates their main frame', async () => {
    const controller = {
      getState: vi.fn(() => ({ status: 'failed' as const, message: 'Safe failure' })),
      getClient: vi.fn(),
      restart: vi.fn()
    }
    registerDesktopLifecycleHandlers(window, controller, {} as never, {
      downloadsDirectory: '/downloads',
      quit: vi.fn(),
      showSaveDialog: electron.showSaveDialog,
      pathExists: vi.fn()
    })

    expect([...electron.handlers.keys()]).toEqual(DESKTOP_LIFECYCLE_INVOKE_CHANNELS)
    expect(() =>
      electron.handlers.get(DESKTOP_IPC.lifecycleGet)?.({ sender: webContents, senderFrame: {} })
    ).toThrow(/Unauthorized/)
    expect(
      electron.handlers.get(DESKTOP_IPC.lifecycleGet)?.({
        sender: webContents,
        senderFrame: mainFrame
      })
    ).toEqual({ status: 'failed', message: 'Safe failure' })

    removeDesktopLifecycleHandlers()
    expect(electron.handlers.size).toBe(0)
  })

  it('cancels utility exports without dispatch and forwards only the exact parsed preview', async () => {
    const preview = {
      entries: [{ name: 'service.log', bytes: 12 }],
      totalBytes: 12,
      redactionCount: 2,
      createdAt: 123
    }
    const supervisor = {
      exportRecovery: vi.fn(),
      previewDiagnostics: vi.fn().mockResolvedValue(preview),
      exportDiagnostics: vi
        .fn()
        .mockResolvedValue({ path: '/downloads/diagnostics.json', bytes: 12 })
    }
    const controller = {
      getState: () => ({ status: 'recoveryRequired' as const, recovery: {} as never }),
      getClient: vi.fn(),
      restart: vi.fn()
    }
    electron.showSaveDialog
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({ canceled: false, filePath: '/downloads/diagnostics.json' })
    registerDesktopLifecycleHandlers(window, controller, supervisor, {
      downloadsDirectory: '/downloads',
      quit: vi.fn(),
      showSaveDialog: electron.showSaveDialog,
      pathExists: vi.fn().mockResolvedValue(false)
    })
    const event = { sender: webContents, senderFrame: mainFrame }
    const recoveryMessages = desktopMessages.exportDialogs.recovery
    const diagnosticMessages = desktopMessages.exportDialogs.diagnostics

    await expect(
      electron.handlers.get(DESKTOP_IPC.recoveryExportDatabase)?.(event)
    ).resolves.toBeNull()
    expect(electron.showSaveDialog).toHaveBeenNthCalledWith(1, window, {
      title: recoveryMessages.title,
      defaultPath: `/downloads/agent-workspace-private-workspace-recovery-${new Date().toISOString().slice(0, 10)}.sqlite`,
      buttonLabel: recoveryMessages.button,
      filters: [{ name: recoveryMessages.filter, extensions: ['sqlite'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    expect(supervisor.exportRecovery).not.toHaveBeenCalled()
    await expect(
      electron.handlers.get(DESKTOP_IPC.diagnosticsExport)?.(event, preview)
    ).resolves.toBeNull()
    const diagnosticDialogOptions = {
      title: diagnosticMessages.title,
      defaultPath: `/downloads/agent-workspace-private-workspace-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      buttonLabel: diagnosticMessages.button,
      filters: [{ name: diagnosticMessages.filter, extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    expect(electron.showSaveDialog).toHaveBeenNthCalledWith(2, window, diagnosticDialogOptions)
    expect(supervisor.exportDiagnostics).not.toHaveBeenCalled()
    await expect(electron.handlers.get(DESKTOP_IPC.diagnosticsPreview)?.(event)).resolves.toEqual(
      preview
    )
    await expect(
      electron.handlers.get(DESKTOP_IPC.diagnosticsExport)?.(event, preview)
    ).resolves.toBeUndefined()
    expect(electron.showSaveDialog).toHaveBeenNthCalledWith(3, window, diagnosticDialogOptions)
    expect(supervisor.exportDiagnostics).toHaveBeenCalledWith(
      '/downloads/diagnostics.json',
      preview
    )
    await expect(
      electron.handlers.get(DESKTOP_IPC.diagnosticsExport)?.(event, {
        ...preview,
        extra: 'rejected'
      })
    ).rejects.toThrow()
    expect(supervisor.exportDiagnostics).toHaveBeenCalledTimes(1)
  })

  it('uses catalog rejection copy when utility export destinations already exist', async () => {
    const preview = {
      entries: [{ name: 'service.log', bytes: 12 }],
      totalBytes: 12,
      redactionCount: 0,
      createdAt: 123
    }
    const supervisor = {
      exportRecovery: vi.fn(),
      previewDiagnostics: vi.fn(),
      exportDiagnostics: vi.fn()
    }
    const controller = {
      getState: () => ({ status: 'recoveryRequired' as const, recovery: {} as never }),
      getClient: vi.fn(),
      restart: vi.fn()
    }
    electron.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/downloads/existing-export'
    })
    registerDesktopLifecycleHandlers(window, controller, supervisor, {
      downloadsDirectory: '/downloads',
      quit: vi.fn(),
      showSaveDialog: electron.showSaveDialog,
      pathExists: vi.fn().mockResolvedValue(true)
    })
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(
      electron.handlers.get(DESKTOP_IPC.recoveryExportDatabase)?.(event)
    ).rejects.toThrow(desktopMessages.exportDialogs.recovery.overwriteRejected)
    await expect(
      electron.handlers.get(DESKTOP_IPC.diagnosticsExport)?.(event, preview)
    ).rejects.toThrow(desktopMessages.exportDialogs.diagnostics.overwriteRejected)
    expect(supervisor.exportRecovery).not.toHaveBeenCalled()
    expect(supervisor.exportDiagnostics).not.toHaveBeenCalled()
  })

  it('strictly validates ready-only configuration ingress and egress', async () => {
    const config = {
      schemaVersion: 1 as const,
      revision: 7,
      appearance: {
        theme: 'system' as const,
        density: 'comfortable' as const,
        fontFamily: 'system-ui'
      },
      terminal: {
        shellPath: null,
        fontFamily: 'monospace',
        fontSize: 14,
        scrollback: 10_000,
        multilinePasteProtection: true
      },
      browser: { profileName: 'default', partition: 'default', privacy: 'strict' as const },
      notifications: { systemEnabled: true, includeBody: false },
      keyboardShortcuts: { overrides: {} },
      agentIntegration: { enabled: true, notificationsEnabled: true, browserEnabled: true },
      updates: { channel: 'stable' as const },
      logging: { level: 'info' as const }
    }
    const client = {
      getConfiguration: vi.fn().mockResolvedValue({ config }),
      updateConfiguration: vi.fn().mockResolvedValue({ config: { ...config, revision: 8 } })
    }
    const controller = {
      getState: () => ({ status: 'ready' as const }),
      getClient: () => client as unknown as ControlClient,
      restart: vi.fn()
    }
    const configurationChanged = vi.fn()
    registerDesktopLifecycleHandlers(window, controller, {} as never, {
      downloadsDirectory: '/downloads',
      quit: vi.fn(),
      showSaveDialog: electron.showSaveDialog,
      pathExists: vi.fn(),
      configurationChanged
    })
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(electron.handlers.get(DESKTOP_IPC.configurationGet)?.(event)).resolves.toEqual({
      config
    })
    const params = {
      expectedRevision: 7,
      update: { appearance: { theme: 'dark', density: 'compact', fontFamily: 'system-ui' } }
    }
    await expect(
      electron.handlers.get(DESKTOP_IPC.configurationUpdate)?.(event, params)
    ).resolves.toMatchObject({
      config: { revision: 8 }
    })
    expect(client.updateConfiguration).toHaveBeenCalledWith(params)
    expect(configurationChanged).toHaveBeenCalledWith('stable')
    await expect(
      electron.handlers.get(DESKTOP_IPC.configurationUpdate)?.(event, {
        ...params,
        unexpected: true
      })
    ).rejects.toThrow()
    expect(configurationChanged).toHaveBeenCalledOnce()
  })

  it('uses current agent epochs and routes exact team member update and move mutations', async () => {
    const binding = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      paneId: '10000000-0000-4000-8000-000000000002',
      tabId: '10000000-0000-4000-8000-000000000003',
      agentSessionId: '10000000-0000-4000-8000-000000000004'
    }
    const session = {
      catalogVersion: 1,
      binding,
      adapterId: 'codex',
      adapterVersion: '0.142.4',
      title: 'agent',
      lifecycle: 'running',
      restore: { level: 'toolResume', assessedAtMs: 1, evidenceEpoch: 1 },
      revision: 7,
      attemptEpoch: 3,
      lastVerifiedAtMs: 1,
      teamId: '20000000-0000-4000-8000-000000000001',
      memberId: '20000000-0000-4000-8000-000000000002'
    }
    const member = {
      memberId: session.memberId,
      role: 'worker',
      target: binding,
      revision: 4
    }
    const team = { teamId: session.teamId, title: 'team', revision: 5, members: [member] }
    const catalog = {
      catalogVersion: 1,
      revision: 9,
      sessions: [session],
      teams: [team],
      attention: []
    }
    const restoreAgentSession = vi
      .fn<(params: Parameters<ControlClient['restoreAgentSession']>[0]) => Promise<unknown>>()
      .mockResolvedValue({ outcome: 'resumed', session })
    const updateAgentTeamMember = vi.fn().mockResolvedValue({ member })
    const moveAgentTeamMember = vi.fn().mockResolvedValue({ member })
    const client = {
      getAgentSession: vi.fn().mockResolvedValue({ session }),
      listAgentCatalog: vi.fn().mockResolvedValue(catalog),
      restoreAgentSession,
      updateAgentTeamMember,
      moveAgentTeamMember
    }
    registerDesktopHandlers(window, client as unknown as ControlClient, browserViews)
    const event = { sender: webContents, senderFrame: mainFrame }

    await electron.handlers.get(DESKTOP_IPC.agentSessionRestore)?.(event, {
      agentSessionId: binding.agentSessionId,
      expectedRevision: session.revision
    })
    expect(restoreAgentSession.mock.calls[0]?.[0].operation).toMatchObject({
      sessionRevision: 7,
      attemptEpoch: 3
    })

    const mutation = {
      teamId: team.teamId,
      memberId: member.memberId,
      expectedCatalogRevision: 9,
      expectedTeamRevision: 5,
      expectedMemberRevision: 4
    }
    await electron.handlers.get(DESKTOP_IPC.agentTeamMemberUpdate)?.(event, {
      ...mutation,
      role: 'reviewer'
    })
    expect(updateAgentTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: team.teamId, memberId: member.memberId, role: 'reviewer' })
    )

    await electron.handlers.get(DESKTOP_IPC.agentTeamMemberMove)?.(event, {
      ...mutation,
      agentSessionId: binding.agentSessionId
    })
    expect(moveAgentTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ target: binding, teamId: team.teamId, memberId: member.memberId })
    )
  })
})
