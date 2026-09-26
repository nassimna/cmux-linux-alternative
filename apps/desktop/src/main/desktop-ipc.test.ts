/* eslint-disable @typescript-eslint/require-await */
import { randomUUID } from 'node:crypto'
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

import { DESKTOP_IPC } from '@agent-workspace/contracts/desktop/desktop-bridge'
import { desktopMessages } from '@agent-workspace/contracts/desktop/desktop-messages'
import projection from '../../../../packages/protocol-client/fixtures/milestone2-projection.json'
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

  it('uses an optional sender-bound Node task read and keeps the Rust fallback', async () => {
    const request = { limit: 10, cancellationId: '10000000-0000-4000-8000-000000000001' }
    const result = { tasks: [], nextCursor: null }
    const listTasks = vi.fn().mockResolvedValue(result)
    const listTasksFromNodeSidecar = vi.fn().mockResolvedValue(result)
    registerDesktopHandlers(window, { listTasks } as unknown as ControlClient, browserViews, {
      isNodeTaskListSelected: () => true,
      listTasksFromNodeSidecar
    })
    const handler = electron.handlers.get(DESKTOP_IPC.taskList)

    await expect(
      handler?.({ sender: webContents, senderFrame: mainFrame }, request)
    ).resolves.toEqual(result)
    expect(listTasksFromNodeSidecar).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' }),
      request
    )
    expect(listTasks).not.toHaveBeenCalled()

    expect(() => handler?.({ sender: webContents, senderFrame: {} }, request)).toThrow()
    expect(listTasksFromNodeSidecar).toHaveBeenCalledOnce()

    listTasksFromNodeSidecar.mockReturnValueOnce(undefined)
    await expect(
      handler?.({ sender: webContents, senderFrame: mainFrame }, request)
    ).rejects.toThrow('Node task list is unavailable')
    expect(listTasks).not.toHaveBeenCalled()
  })

  it('routes only opt-in remote detach to Node and fails closed for unsupported actions', async () => {
    const target = {
      sessionId: '20000000-0000-4000-8000-000000000010',
      generation: 2,
      revision: 7
    }
    const result = {
      target: { ...target, revision: 8 },
      lifecycle: 'detached',
      observation: 'lastVerified',
      outcome: 'accepted',
      revision: 8
    }
    const actOnTask = vi.fn()
    const detachRemoteTaskFromNodeSidecar = vi.fn().mockResolvedValue(result)
    registerDesktopHandlers(window, { actOnTask } as unknown as ControlClient, browserViews, {
      isNodeTaskListSelected: () => true,
      detachRemoteTaskFromNodeSidecar
    })
    const event = { sender: webContents, senderFrame: mainFrame }
    const handler = electron.handlers.get(DESKTOP_IPC.taskAction)

    await expect(handler?.(event, { action: 'detach', target })).resolves.toEqual(result)
    expect(detachRemoteTaskFromNodeSidecar).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' }),
      expect.objectContaining({
        action: 'detach',
        target
      })
    )
    const submitted = detachRemoteTaskFromNodeSidecar.mock.calls[0]?.[1] as {
      mutation: { expectedRevision: number }
    }
    expect(submitted.mutation.expectedRevision).toBe(target.revision)
    expect(actOnTask).not.toHaveBeenCalled()
    expect(() =>
      handler?.({ sender: webContents, senderFrame: {} }, { action: 'detach', target })
    ).toThrow()
    await expect(handler?.(event, { action: 'terminate', target })).rejects.toThrow(
      'Node task confirmation is unavailable'
    )
    expect(actOnTask).not.toHaveBeenCalled()
  })

  it('does not fall back to Rust when the selected Node task action hook is missing', async () => {
    const target = {
      sessionId: '20000000-0000-4000-8000-000000000010',
      generation: 2,
      revision: 7
    }
    const actOnTask = vi.fn()
    registerDesktopHandlers(window, { actOnTask } as unknown as ControlClient, browserViews, {
      isNodeTaskListSelected: () => true
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.taskAction)?.(
        { sender: webContents, senderFrame: mainFrame },
        { action: 'detach', target }
      )
    ).rejects.toThrow('Node task action is unavailable')
    expect(actOnTask).not.toHaveBeenCalled()
  })

  it('routes the opt-in Node workspace read only for the current main-frame sender', async () => {
    const nodeResult = { snapshot: { revision: 1 } }
    const invokeNodeCore = vi.fn().mockResolvedValue({ handled: true, value: nodeResult })
    const listWorkspaces = vi.fn()
    registerDesktopHandlers(window, { listWorkspaces } as unknown as ControlClient, browserViews, {
      invokeNodeCore
    })
    const handler = electron.handlers.get(DESKTOP_IPC.workspaceList)

    await expect(handler?.({ sender: webContents, senderFrame: mainFrame })).resolves.toBe(
      nodeResult
    )
    expect(invokeNodeCore).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' }),
      DESKTOP_IPC.workspaceList,
      []
    )
    expect(listWorkspaces).not.toHaveBeenCalled()
    expect(() => handler?.({ sender: webContents, senderFrame: {} })).toThrow()
    expect(invokeNodeCore).toHaveBeenCalledOnce()
  })

  it('never falls through to a sealed Rust binding while Node exclusively owns state', async () => {
    const listWorkspaces = vi.fn()
    registerDesktopHandlers(window, { listWorkspaces } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeExclusive: () => true,
      invokeNodeCore: vi.fn().mockResolvedValue({ handled: false })
    })

    await expect(
      electron.handlers.get(DESKTOP_IPC.workspaceList)?.({
        sender: webContents,
        senderFrame: mainFrame
      })
    ).rejects.toThrow('Node owner cannot handle desktop channel')
    expect(listWorkspaces).not.toHaveBeenCalled()
  })

  it('routes a Node-exclusive binding without a Rust client and rejects unhandled operations', async () => {
    const registry = new WindowRegistry()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceNodeExclusive(browserViews, vi.fn().mockResolvedValue(undefined))
    registry.register('window-a', window, binding)
    const router = new SenderBoundIpcRouter(registry)
    const invokeNodeCore = vi
      .fn()
      .mockResolvedValueOnce({ handled: true, value: { revision: 3 } })
      .mockResolvedValue({ handled: false })
    registerGlobalDesktopHandlers(router, { invokeNodeCore })
    const event = { sender: webContents, senderFrame: mainFrame }

    await expect(electron.handlers.get(DESKTOP_IPC.workspaceList)?.(event)).resolves.toEqual({
      revision: 3
    })
    await expect(electron.handlers.get(DESKTOP_IPC.workspaceList)?.(event)).rejects.toThrow(
      `Node owner cannot handle desktop channel ${DESKTOP_IPC.workspaceList}`
    )
    expect(invokeNodeCore).toHaveBeenCalledTimes(2)

    registerGlobalDesktopHandlers(router)
    await expect(electron.handlers.get(DESKTOP_IPC.workspaceList)?.(event)).rejects.toThrow(
      `Node owner cannot handle desktop channel ${DESKTOP_IPC.workspaceList}`
    )
    expect(() =>
      electron.handlers.get(DESKTOP_IPC.workspaceList)?.({
        sender: webContents,
        senderFrame: {}
      })
    ).toThrow('Unauthorized')
  })

  it('opens only a Node-bound workspace path from a current exclusive window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'node-workspace-path-'))
    try {
      const registry = new WindowRegistry()
      const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
      binding.replaceNodeExclusive(browserViews, vi.fn().mockResolvedValue(undefined))
      registry.register('window-a', window, binding)
      const router = new SenderBoundIpcRouter(registry)
      const workspaceId = randomUUID()
      const invokeNodeCore = vi.fn()
      const resolveNodeWorkspacePath = vi.fn().mockResolvedValue(directory)
      const openWorkspacePath = vi.fn().mockResolvedValue(undefined)
      let current = true
      electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [directory] })
      registerGlobalDesktopHandlers(router, {
        isNodeCoreEnabled: () => true,
        invokeNodeCore,
        isWindowEntryCurrent: () => current,
        resolveNodeWorkspacePath,
        openWorkspacePath,
        detectWorkspacePathOpeners: async () => [
          { id: 'fileManager', label: 'File Explorer', kind: 'fileManager' }
        ]
      })
      const event = { sender: webContents, senderFrame: mainFrame }
      await expect(
        electron.handlers.get(DESKTOP_IPC.workspacePickDirectory)?.(event)
      ).resolves.toBe(directory)
      await expect(
        electron.handlers.get(DESKTOP_IPC.workspacePathOpeners)?.(event)
      ).resolves.toEqual([{ id: 'fileManager', label: 'File Explorer', kind: 'fileManager' }])
      await expect(
        electron.handlers.get(DESKTOP_IPC.workspacePathOpen)?.(event, {
          workspaceId,
          openerId: 'fileManager'
        })
      ).resolves.toBeUndefined()
      expect(resolveNodeWorkspacePath).toHaveBeenCalledWith(
        expect.objectContaining({ windowId: 'window-a' }),
        workspaceId
      )
      expect(openWorkspacePath).toHaveBeenCalledWith('fileManager', directory)
      current = false
      await expect(
        electron.handlers.get(DESKTOP_IPC.workspacePathOpen)?.(event, {
          workspaceId,
          openerId: 'fileManager'
        })
      ).rejects.toThrow('Node workspace window changed')
      expect(openWorkspacePath).toHaveBeenCalledOnce()
      expect(invokeNodeCore).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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

    const nodeDestination = join(directory, 'vault-node.json')
    const issueNodeSearchExportConfirmation = vi.fn().mockResolvedValue({
      confirmation: { confirmationId, sourceAuthorizationId, expiresAtMs: 10 }
    })
    const exportNodeSearchSource = vi.fn().mockResolvedValue({
      sourceAuthorizationId,
      artifact: {
        document: { documentId: '20000000-0000-4000-8000-000000000022', identityVersion: 1 },
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
        showSaveDialog: electron.showSaveDialog,
        isNodeCoreEnabled: () => true,
        isNodeEncryptedSearchEnabled: () => true,
        issueNodeSearchExportConfirmation,
        exportNodeSearchSource
      }
    )
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: nodeDestination })
    await expect(
      electron.handlers.get(DESKTOP_IPC.searchExport)?.(event, { sourceAuthorizationId })
    ).resolves.toBe(true)
    expect(issueNodeSearchExportConfirmation).toHaveBeenCalledWith({ sourceAuthorizationId })
    expect(exportNodeSearchSource).toHaveBeenCalledWith({ sourceAuthorizationId, confirmationId })
    expect(issueSearchExportConfirmation).toHaveBeenCalledTimes(1)
    expect(exportSearchSource).toHaveBeenCalledTimes(1)
    await expect(readFile(nodeDestination, 'utf8')).resolves.toBe(artifactText)

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

  it('blocks Rust multi-window writes while the isolated Node demo is active', async () => {
    const registry = new WindowRegistry()
    const client = { createWindow: vi.fn() }
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceReady(
      client as unknown as ControlClient,
      browserViews,
      vi.fn().mockResolvedValue(undefined)
    )
    registry.register('window-a', window, binding)
    registerMultiWindowDesktopHandlers(new SenderBoundIpcRouter(registry), () => true)

    await expect(
      electron.handlers.get(DESKTOP_IPC.windowList)?.({
        sender: webContents,
        senderFrame: mainFrame
      })
    ).rejects.toThrow('Node window topology is unavailable')

    await expect(
      electron.handlers.get(DESKTOP_IPC.windowCreate)?.(
        { sender: webContents, senderFrame: mainFrame },
        {}
      )
    ).rejects.toThrow('unavailable in the isolated Node demo')
    expect(client.createWindow).not.toHaveBeenCalled()
  })

  it('routes Node window creation only from the sender placement', async () => {
    const registry = new WindowRegistry()
    const windowId = randomUUID()
    const workspaceId = randomUUID()
    const paneId = randomUUID()
    const createdWindowId = randomUUID()
    const epoch = randomUUID()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    const rustCreate = vi.fn()
    binding.replaceReady(
      { createWindow: rustCreate } as unknown as ControlClient,
      browserViews,
      vi.fn().mockResolvedValue(undefined)
    )
    const entry = registry.register(windowId, window, binding)
    const create = vi.fn().mockResolvedValue({
      revision: 3,
      idempotencyEpoch: epoch,
      replayed: false,
      window: {
        windowId: createdWindowId,
        label: 'Second',
        workspaceIds: [workspaceId],
        focusedWorkspaceId: workspaceId,
        hostingState: 'unhosted',
        revision: 0,
        defaultTabDestination: { workspaceId, paneId, destinationIndex: 1 }
      }
    })
    registerMultiWindowDesktopHandlers(new SenderBoundIpcRouter(registry), () => true, vi.fn(), {
      create,
      focus: vi.fn(),
      close: vi.fn()
    })
    const request = {
      mutation: { expectedRevision: 2, idempotencyEpoch: epoch, idempotencyKey: randomUUID() },
      label: 'Second',
      workspaceId,
      sourceWindow: { windowId, expectedRevision: 1 }
    }
    await expect(
      electron.handlers.get(DESKTOP_IPC.windowCreate)?.(
        { sender: webContents, senderFrame: mainFrame },
        { ...request, sourceWindow: { ...request.sourceWindow, windowId: randomUUID() } }
      )
    ).rejects.toThrow('Unauthorized window authority')
    expect(create).not.toHaveBeenCalled()
    await expect(
      electron.handlers.get(DESKTOP_IPC.windowCreate)?.(
        { sender: webContents, senderFrame: mainFrame },
        request
      )
    ).resolves.toMatchObject({ revision: 3, window: { windowId: createdWindowId } })
    expect(create).toHaveBeenCalledWith(entry, request)
    expect(rustCreate).not.toHaveBeenCalled()
  })

  it('routes Node tab close only from the exact sender window', async () => {
    const registry = new WindowRegistry()
    const windowId = randomUUID()
    const workspaceId = randomUUID()
    const paneId = randomUUID()
    const tabId = randomUUID()
    const epoch = randomUUID()
    const entry = registry.register(
      windowId,
      window,
      new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    )
    const closeTab = vi.fn().mockResolvedValue({
      revision: 4,
      idempotencyEpoch: epoch,
      closedTabId: tabId,
      closedItemId: randomUUID(),
      replayed: false
    })
    registerMultiWindowDesktopHandlers(new SenderBoundIpcRouter(registry), () => true, vi.fn(), {
      create: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      closeTab
    })
    const request = {
      mutation: { expectedRevision: 3, idempotencyEpoch: epoch, idempotencyKey: randomUUID() },
      source: { windowId, workspaceId, paneId, tabId, expectedWindowRevision: 2 }
    }
    const handler = electron.handlers.get(DESKTOP_IPC.tabCloseAdvanced)!
    await expect(
      handler(
        { sender: webContents, senderFrame: mainFrame },
        {
          ...request,
          source: { ...request.source, windowId: randomUUID() }
        }
      )
    ).rejects.toThrow('Unauthorized window authority')
    expect(closeTab).not.toHaveBeenCalled()
    await expect(
      handler({ sender: webContents, senderFrame: mainFrame }, request)
    ).resolves.toMatchObject({ closedTabId: tabId, revision: 4 })
    expect(closeTab).toHaveBeenCalledWith(entry, request)
  })

  it('routes Node closed tabs, duplicate, and focus history from a Node-exclusive window', async () => {
    const registry = new WindowRegistry()
    const windowId = randomUUID()
    const workspaceId = randomUUID()
    const paneId = randomUUID()
    const tabId = randomUUID()
    const closedItemId = randomUUID()
    const epoch = randomUUID()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceNodeExclusive(browserViews, vi.fn().mockResolvedValue(undefined))
    const entry = registry.register(windowId, window, binding)
    const listClosedItems = vi.fn().mockResolvedValue({ revision: 3, items: [] })
    const getClosedItem = vi.fn().mockResolvedValue({
      revision: 3,
      item: {
        closedItemId,
        itemKind: 'tab',
        priorItemId: tabId,
        contentKind: 'terminal',
        title: 'Shell',
        closedAtMs: 1,
        restored: false
      }
    })
    const tabResult = {
      revision: 4,
      idempotencyEpoch: epoch,
      tabId,
      runtimeSessionId: randomUUID(),
      ownershipKind: 'terminal',
      placement: { windowId, workspaceId, paneId, index: 0, windowRevision: 2 },
      transferEpoch: 4,
      replayed: false
    }
    const duplicateTab = vi.fn().mockResolvedValue(tabResult)
    const reopenTab = vi.fn().mockResolvedValue(tabResult)
    const navigateFocusHistory = vi.fn().mockResolvedValue({
      revision: 4,
      idempotencyEpoch: epoch,
      target: { windowId, workspaceId, paneId, tabId },
      replayed: false
    })
    registerMultiWindowDesktopHandlers(new SenderBoundIpcRouter(registry), () => true, vi.fn(), {
      create: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      listClosedItems,
      getClosedItem,
      duplicateTab,
      reopenTab,
      navigateFocusHistory
    })
    const event = { sender: webContents, senderFrame: mainFrame }
    const mutation = { expectedRevision: 3, idempotencyEpoch: epoch, idempotencyKey: randomUUID() }
    const target = { windowId, workspaceId, paneId, destinationIndex: 0, expectedWindowRevision: 1 }
    const source = { windowId, workspaceId, paneId, tabId, expectedWindowRevision: 1 }
    await expect(electron.handlers.get(DESKTOP_IPC.closedList)?.(event)).resolves.toEqual({
      revision: 3,
      items: []
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.closedGet)?.(event, { closedItemId })
    ).resolves.toMatchObject({ item: { closedItemId } })
    await expect(
      electron.handlers.get(DESKTOP_IPC.tabDuplicate)?.(event, { mutation, source, target })
    ).resolves.toMatchObject({ tabId })
    await expect(
      electron.handlers.get(DESKTOP_IPC.tabReopen)?.(event, { mutation, closedItemId, target })
    ).resolves.toMatchObject({ tabId })
    await expect(
      electron.handlers.get(DESKTOP_IPC.focusHistoryNavigate)?.(event, {
        mutation,
        direction: 'back'
      })
    ).resolves.toMatchObject({ target: { windowId } })
    expect(listClosedItems).toHaveBeenCalledWith(entry)
    expect(getClosedItem).toHaveBeenCalledWith(entry, { closedItemId })
    expect(duplicateTab).toHaveBeenCalledWith(entry, { mutation, source, target })
    expect(reopenTab).toHaveBeenCalledWith(entry, { mutation, closedItemId, target })
    expect(navigateFocusHistory).toHaveBeenCalledWith(entry, { mutation, direction: 'back' })
  })

  it('routes the Node demo window list through the exact sender entry', async () => {
    const registry = new WindowRegistry()
    const windowId = randomUUID()
    const workspaceId = randomUUID()
    const paneId = randomUUID()
    const rustList = vi.fn()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceReady(
      { listWindows: rustList } as unknown as ControlClient,
      browserViews,
      vi.fn().mockResolvedValue(undefined)
    )
    registry.register(windowId, window, binding)
    const listNode = vi.fn().mockResolvedValue({
      revision: 2,
      idempotencyEpoch: randomUUID(),
      focusedWindowId: windowId,
      windows: [
        {
          windowId,
          label: 'Node window',
          workspaceIds: [workspaceId],
          focusedWorkspaceId: workspaceId,
          hostingState: 'hosted',
          revision: 1,
          defaultTabDestination: { workspaceId, paneId, destinationIndex: 1 }
        }
      ]
    })
    registerMultiWindowDesktopHandlers(new SenderBoundIpcRouter(registry), () => true, listNode)
    const handler = electron.handlers.get(DESKTOP_IPC.windowList)!
    await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toMatchObject({
      windows: [{ windowId }]
    })
    expect(listNode).toHaveBeenCalledWith(expect.objectContaining({ windowId }))
    expect(rustList).not.toHaveBeenCalled()
    expect(() => handler({ sender: webContents, senderFrame: {} })).toThrow(
      'Unauthorized desktop IPC sender'
    )
    expect(listNode).toHaveBeenCalledTimes(1)
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

  it('blocks Rust lifecycle fallback for a Node-exclusive binding while allowing Node diagnostics and quit', async () => {
    const registry = new WindowRegistry()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceNodeExclusive(browserViews, vi.fn().mockResolvedValue(undefined))
    registry.register('window-a', window, binding)
    const router = new SenderBoundIpcRouter(registry)
    const controller = {
      getState: () => ({ status: 'failed' as const, message: 'Rust is sealed' }),
      getClient: vi.fn(),
      restart: vi.fn()
    }
    const supervisor = {
      exportRecovery: vi.fn(),
      previewDiagnostics: vi.fn(),
      exportDiagnostics: vi.fn()
    }
    const quit = vi.fn()
    const preview = { entries: [], totalBytes: 0, redactionCount: 0, createdAt: 123 }
    const previewNodeDiagnostics = vi.fn().mockResolvedValue(preview)
    const exportNodeDiagnostics = vi.fn().mockResolvedValue(undefined)
    let nodeDiagnosticsMode = false
    const dependencies = {
      downloadsDirectory: '/downloads',
      quit,
      showSaveDialog: electron.showSaveDialog,
      pathExists: vi.fn().mockResolvedValue(false),
      scheduleQuit: (callback: () => void) => callback(),
      isNodeDiagnosticsMode: () => nodeDiagnosticsMode,
      isNodeDiagnosticsEnabled: () => true,
      previewNodeDiagnostics,
      exportNodeDiagnostics
    }
    registerGlobalDesktopLifecycleHandlers(router, controller, supervisor, dependencies)
    const event = { sender: webContents, senderFrame: mainFrame }

    for (const channel of [
      DESKTOP_IPC.serviceRestart,
      DESKTOP_IPC.recoveryExportDatabase,
      DESKTOP_IPC.diagnosticsPreview,
      DESKTOP_IPC.diagnosticsExport,
      DESKTOP_IPC.configurationGet
    ]) {
      await expect(electron.handlers.get(channel)?.(event, preview)).rejects.toThrow(
        `Node owner cannot handle desktop channel ${channel}`
      )
    }
    expect(controller.restart).not.toHaveBeenCalled()
    expect(supervisor.exportRecovery).not.toHaveBeenCalled()
    expect(supervisor.previewDiagnostics).not.toHaveBeenCalled()
    expect(supervisor.exportDiagnostics).not.toHaveBeenCalled()
    expect(electron.showSaveDialog).not.toHaveBeenCalled()

    electron.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/downloads/node-diagnostics.json'
    })
    nodeDiagnosticsMode = true
    await expect(electron.handlers.get(DESKTOP_IPC.diagnosticsPreview)?.(event)).resolves.toEqual(
      preview
    )
    await expect(
      electron.handlers.get(DESKTOP_IPC.diagnosticsExport)?.(event, preview)
    ).resolves.toBeUndefined()
    expect(previewNodeDiagnostics).toHaveBeenCalledOnce()
    expect(exportNodeDiagnostics).toHaveBeenCalledWith('/downloads/node-diagnostics.json', preview)
    expect(electron.handlers.get(DESKTOP_IPC.lifecycleGet)?.(event)).toEqual({
      status: 'failed',
      message: 'Rust is sealed'
    })
    electron.handlers.get(DESKTOP_IPC.applicationQuit)?.(event)
    expect(quit).toHaveBeenCalledOnce()
  })

  it('restarts and exports recovery for a Node-owned lifecycle', async () => {
    const registry = new WindowRegistry()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceNodeExclusive(browserViews, vi.fn().mockResolvedValue(undefined))
    registry.register('window-a', window, binding)
    const router = new SenderBoundIpcRouter(registry)
    const restart = vi.fn().mockResolvedValue(undefined)
    const exportRecovery = vi.fn().mockResolvedValue({
      path: '/downloads/recovery.sqlite',
      bytes: 128
    })
    registerGlobalDesktopLifecycleHandlers(
      router,
      { getState: () => ({ status: 'ready' }), getClient: vi.fn(), restart },
      { exportRecovery, previewDiagnostics: vi.fn(), exportDiagnostics: vi.fn() },
      {
        downloadsDirectory: '/downloads',
        quit: vi.fn(),
        isNodeLifecycleEnabled: () => true,
        showSaveDialog: electron.showSaveDialog,
        pathExists: vi.fn().mockResolvedValue(false)
      }
    )
    const event = { sender: webContents, senderFrame: mainFrame }
    electron.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/downloads/recovery.sqlite'
    })

    await expect(
      electron.handlers.get(DESKTOP_IPC.serviceRestart)?.(event)
    ).resolves.toBeUndefined()
    await expect(
      electron.handlers.get(DESKTOP_IPC.recoveryExportDatabase)?.(event)
    ).resolves.toEqual({
      path: '/downloads/recovery.sqlite',
      bytes: 128
    })
    expect(restart).toHaveBeenCalledOnce()
    expect(exportRecovery).toHaveBeenCalledWith('/downloads/recovery.sqlite', 'sqlite')
  })

  it('offers a TAR archive for failed native state and refuses export without a source', async () => {
    const registry = new WindowRegistry()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    registry.register('window-a', window, binding)
    const router = new SenderBoundIpcRouter(registry)
    let available = true
    const exportRecovery = vi.fn().mockResolvedValue({
      path: '/downloads/recovery.tar',
      bytes: 128
    })
    registerGlobalDesktopLifecycleHandlers(
      router,
      {
        getState: () => ({
          status: 'failed',
          message: 'Node failed',
          availableActions: { recoveryExport: available, diagnostics: false }
        }),
        getClient: vi.fn(),
        restart: vi.fn()
      },
      { exportRecovery, previewDiagnostics: vi.fn(), exportDiagnostics: vi.fn() },
      {
        downloadsDirectory: '/downloads',
        quit: vi.fn(),
        isNodeLifecycleEnabled: () => true,
        showSaveDialog: electron.showSaveDialog,
        pathExists: vi.fn().mockResolvedValue(false)
      }
    )
    const event = { sender: webContents, senderFrame: mainFrame }
    electron.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/downloads/recovery.tar'
    })

    await expect(
      electron.handlers.get(DESKTOP_IPC.recoveryExportDatabase)?.(event)
    ).resolves.toEqual({ path: '/downloads/recovery.tar', bytes: 128 })
    expect(electron.showSaveDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ filters: [{ name: 'TAR recovery archive', extensions: ['tar'] }] })
    )
    expect(exportRecovery).toHaveBeenCalledWith('/downloads/recovery.tar', 'archive')

    available = false
    await expect(
      electron.handlers.get(DESKTOP_IPC.recoveryExportDatabase)?.(event)
    ).rejects.toThrow('No private database')
    expect(electron.showSaveDialog).toHaveBeenCalledOnce()
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

  it('keeps Node diagnostics on the isolated copy when the Node service is down', async () => {
    const preview = {
      entries: [{ name: 'logs/service.json', bytes: 12 }],
      totalBytes: 12,
      redactionCount: 1,
      createdAt: 123
    }
    const supervisor = {
      exportRecovery: vi.fn(),
      previewDiagnostics: vi.fn(),
      exportDiagnostics: vi.fn()
    }
    const previewNodeDiagnostics = vi.fn().mockResolvedValue(preview)
    const exportNodeDiagnostics = vi.fn().mockResolvedValue({
      path: '/downloads/node-diagnostics.json',
      bytes: 12
    })
    const controller = {
      getState: () => ({ status: 'failed' as const, message: 'Node service stopped' }),
      getClient: vi.fn(),
      restart: vi.fn()
    }
    electron.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/downloads/node-diagnostics.json'
    })
    registerDesktopLifecycleHandlers(window, controller, supervisor, {
      downloadsDirectory: '/downloads',
      quit: vi.fn(),
      isNodeCoreEnabled: () => false,
      isNodeDiagnosticsMode: () => true,
      isNodeDiagnosticsEnabled: () => true,
      previewNodeDiagnostics,
      exportNodeDiagnostics,
      showSaveDialog: electron.showSaveDialog,
      pathExists: vi.fn().mockResolvedValue(false)
    })
    const event = { sender: webContents, senderFrame: mainFrame }
    await expect(electron.handlers.get(DESKTOP_IPC.diagnosticsPreview)?.(event)).resolves.toEqual(
      preview
    )
    await expect(
      electron.handlers.get(DESKTOP_IPC.diagnosticsExport)?.(event, preview)
    ).resolves.toBeUndefined()
    expect(previewNodeDiagnostics).toHaveBeenCalledOnce()
    expect(exportNodeDiagnostics).toHaveBeenCalledWith('/downloads/node-diagnostics.json', preview)
    expect(supervisor.previewDiagnostics).not.toHaveBeenCalled()
    expect(supervisor.exportDiagnostics).not.toHaveBeenCalled()
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
    let nodeCoreEnabled = false
    let nodeConfigurationEnabled = false
    const getNodeConfiguration = vi
      .fn()
      .mockResolvedValue({ config: { ...config, schemaVersion: 2 } })
    const updateNodeConfiguration = vi.fn().mockResolvedValue({
      config: { ...config, schemaVersion: 2, revision: 8 }
    })
    registerDesktopLifecycleHandlers(window, controller, {} as never, {
      downloadsDirectory: '/downloads',
      quit: vi.fn(),
      showSaveDialog: electron.showSaveDialog,
      pathExists: vi.fn(),
      isNodeCoreEnabled: () => nodeCoreEnabled,
      isNodeConfigurationEnabled: () => nodeConfigurationEnabled,
      getNodeConfiguration,
      updateNodeConfiguration,
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
    nodeCoreEnabled = true
    await expect(electron.handlers.get(DESKTOP_IPC.configurationGet)?.(event)).resolves.toEqual({
      config
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.configurationUpdate)?.(event, params)
    ).rejects.toThrow('Configuration is unavailable in the isolated Node demo')
    expect(client.getConfiguration).toHaveBeenCalledTimes(2)
    expect(client.updateConfiguration).toHaveBeenCalledOnce()
    nodeConfigurationEnabled = true
    await expect(
      electron.handlers.get(DESKTOP_IPC.configurationGet)?.(event)
    ).resolves.toMatchObject({
      config: { schemaVersion: 2, revision: 7 }
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.configurationUpdate)?.(event, params)
    ).resolves.toMatchObject({ config: { schemaVersion: 2, revision: 8 } })
    expect(getNodeConfiguration).toHaveBeenCalledOnce()
    expect(updateNodeConfiguration).toHaveBeenCalledWith(params)
    expect(client.getConfiguration).toHaveBeenCalledTimes(2)
    expect(client.updateConfiguration).toHaveBeenCalledOnce()
  })

  it('advertises only enabled configuration and remote capabilities in the Node demo', async () => {
    const identify = vi.fn().mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: [
        'configuration-v2',
        'remote.target.enroll',
        'remote.target.replaceCredential',
        'remote.target.delete',
        'remote-sessions-v1',
        'multi-window-v1',
        'agent-sessions-v1',
        'browser-automation-v1',
        'saved-layouts-v1',
        'sidebar-surfaces-v1',
        'task.list',
        'task.confirmation.issue',
        'task.action',
        'search.query',
        'search.cancel',
        'search.source.policy',
        'actions-v1'
      ]
    })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.identify)?.({ sender: webContents, senderFrame: mainFrame })
    ).resolves.toMatchObject({ capabilities: ['actions-v1', 'node-core-demo'] })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeTaskListEnabled: () => true
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.identify)?.({ sender: webContents, senderFrame: mainFrame })
    ).resolves.toMatchObject({ capabilities: ['actions-v1', 'task.list', 'node-core-demo'] })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeTaskListEnabled: () => true,
      isNodeTaskDetachEnabled: () => true
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.identify)?.({ sender: webContents, senderFrame: mainFrame })
    ).resolves.toMatchObject({
      capabilities: ['actions-v1', 'task.list', 'task.detach', 'node-core-demo']
    })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeRecentlyClosedEnabled: () => true
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.identify)?.({ sender: webContents, senderFrame: mainFrame })
    ).resolves.toMatchObject({
      capabilities: ['actions-v1', 'recentlyClosed.list', 'recentlyClosed.reopen', 'node-core-demo']
    })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeConfigurationEnabled: () => true
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.identify)?.({ sender: webContents, senderFrame: mainFrame })
    ).resolves.toMatchObject({
      capabilities: ['actions-v1', 'configuration-v2', 'node-core-demo']
    })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeRemoteEnabled: () => true,
      isNodeRemoteEnrollmentEnabled: () => false
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.identify)?.({ sender: webContents, senderFrame: mainFrame })
    ).resolves.toMatchObject({
      capabilities: ['remote-sessions-v1', 'actions-v1', 'node-core-demo']
    })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeRemoteEnabled: () => true,
      isNodeRemoteEnrollmentEnabled: () => true,
      isNodeRemoteReplacementEnabled: () => true,
      isNodeRemoteDeletionEnabled: () => true
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.identify)?.({ sender: webContents, senderFrame: mainFrame })
    ).resolves.toMatchObject({
      capabilities: [
        'remote-sessions-v1',
        'actions-v1',
        'remote.target.enroll',
        'remote.target.replaceCredential',
        'remote.target.delete',
        'node-core-demo'
      ]
    })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeAgentAssessmentEnabled: () => true
    })
    await expect(
      electron.handlers.get(DESKTOP_IPC.identify)?.({ sender: webContents, senderFrame: mainFrame })
    ).resolves.toMatchObject({
      capabilities: [
        'actions-v1',
        'agent.catalog.list',
        'agent.catalog.get',
        'agent.restore.assess',
        'node-core-demo'
      ]
    })
    registerDesktopHandlers(window, { identify } as unknown as ControlClient, browserViews, {
      isNodeCoreEnabled: () => true,
      isNodeEncryptedSearchEnabled: () => true
    })
    const encryptedIdentity = (await electron.handlers.get(DESKTOP_IPC.identify)?.({
      sender: webContents,
      senderFrame: mainFrame
    })) as { capabilities: string[] } | undefined
    expect(encryptedIdentity?.capabilities).toContain('search.encrypted-v1')
    expect(encryptedIdentity?.capabilities).toContain('search.query')
    expect(encryptedIdentity?.capabilities).not.toContain('search.cancel')
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

  it.each([false, true])(
    'confirms the exact Node session with verified checkpoint=%s',
    async (hasCheckpoint) => {
      const agentSessionId = '40000000-0000-4000-8000-000000000001'
      const provider = {
        providerId: '40000000-0000-4000-8000-000000000002',
        providerEpoch: 1,
        leaseId: '40000000-0000-4000-8000-000000000003'
      }
      const session = {
        catalogVersion: 1,
        binding: {
          workspaceId: '40000000-0000-4000-8000-000000000004',
          paneId: '40000000-0000-4000-8000-000000000005',
          tabId: '40000000-0000-4000-8000-000000000006',
          agentSessionId
        },
        adapterId: 'codex',
        adapterVersion: '0.142.4',
        title: 'agent',
        lifecycle: 'running',
        restore: { level: 'toolResume', assessedAtMs: 1, evidenceEpoch: 1 },
        revision: 7,
        attemptEpoch: 3,
        lastVerifiedAtMs: 1
      }
      const outcome = hasCheckpoint ? 'hibernated' : 'terminatedAfterWarning'
      const nodeClient = {
        getAgentSession: vi.fn().mockResolvedValue({ session }),
        preflightAgentHibernation: vi
          .fn()
          .mockImplementation(
            async ({ challenge }: Parameters<ControlClient['preflightAgentHibernation']>[0]) => ({
              state: 'confirmationRequired',
              ...(hasCheckpoint
                ? {
                    checkpoint: {
                      descriptorVersion: 1,
                      kind: 'codex-thread-v1',
                      digestSha256: 'a'.repeat(64),
                      sizeBytes: 16,
                      createdAtMs: 1,
                      expiresAtMs: 30_001
                    }
                  }
                : {}),
              confirmationId: '40000000-0000-4000-8000-000000000007',
              challenge: {
                ...challenge,
                provider: { ...challenge.provider },
                confirmationId: '40000000-0000-4000-8000-000000000007',
                nonce: 'node-lease-nonce',
                expiresAtMs: 10_000
              }
            })
          ),
        cancelAgentHibernation: vi.fn().mockResolvedValue({ state: 'canceled' }),
        confirmAgentHibernation: vi.fn().mockResolvedValue({ state: outcome })
      }
      const invokeNodeCore = vi.fn().mockResolvedValue({ handled: false })
      const showMessageBox = vi.fn().mockResolvedValue({ response: 1 })
      let contextCurrent = true
      const windowId = '40000000-0000-4000-8000-000000000008'
      const registry = new WindowRegistry()
      const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
      binding.replaceNodeExclusive(browserViews, vi.fn().mockResolvedValue(undefined))
      registry.register(windowId, window, binding)
      const router = new SenderBoundIpcRouter(registry)
      registerGlobalDesktopHandlers(router, {
        isNodeCoreEnabled: () => true,
        invokeNodeCore,
        getNodeAgentHibernationContext: () => ({
          client: nodeClient as unknown as ControlClient,
          provider,
          isCurrent: () => contextCurrent
        }),
        showMessageBox,
        isWindowEntryCurrent: () => true
      })
      await expect(
        electron.handlers.get(DESKTOP_IPC.agentSessionHibernate)?.(
          { sender: webContents, senderFrame: mainFrame },
          { agentSessionId, expectedRevision: 7 }
        )
      ).resolves.toEqual({ state: outcome })
      expect(invokeNodeCore).not.toHaveBeenCalled()
      expect(binding.isNodeExclusive).toBe(true)
      expect(nodeClient.preflightAgentHibernation).toHaveBeenCalledWith(
        expect.objectContaining({
          challenge: {
            choice: 'terminateAfterWarning',
            provider,
            window: {
              windowId,
              windowGeneration: 1
            }
          }
        })
      )
      expect(showMessageBox).toHaveBeenCalledWith(
        window,
        expect.objectContaining({
          type: 'warning',
          defaultId: 0,
          cancelId: 0,
          title: hasCheckpoint
            ? 'Hibernate agent session?'
            : 'Stop agent session without a checkpoint?',
          buttons: [
            'Leave running',
            hasCheckpoint ? 'Hibernate session' : 'Stop without checkpoint'
          ]
        })
      )
      expect(nodeClient.confirmAgentHibernation).toHaveBeenCalledWith(
        expect.objectContaining({ provider, nonce: 'node-lease-nonce' })
      )
      expect(nodeClient.cancelAgentHibernation).not.toHaveBeenCalled()

      showMessageBox.mockImplementationOnce(async () => {
        contextCurrent = false
        return { response: 1 }
      })
      await expect(
        electron.handlers.get(DESKTOP_IPC.agentSessionHibernate)?.(
          { sender: webContents, senderFrame: mainFrame },
          { agentSessionId, expectedRevision: 7 }
        )
      ).rejects.toThrow('desktop authority is stale')
      expect(nodeClient.cancelAgentHibernation).toHaveBeenCalledOnce()
      expect(nodeClient.confirmAgentHibernation).toHaveBeenCalledOnce()

      contextCurrent = true
      showMessageBox.mockResolvedValueOnce({ response: 0 })
      await expect(
        electron.handlers.get(DESKTOP_IPC.agentSessionHibernate)?.(
          { sender: webContents, senderFrame: mainFrame },
          { agentSessionId, expectedRevision: 7 }
        )
      ).resolves.toBeNull()
      expect(nodeClient.cancelAgentHibernation).toHaveBeenCalledTimes(2)
      expect(nodeClient.confirmAgentHibernation).toHaveBeenCalledOnce()
      expect(() =>
        electron.handlers.get(DESKTOP_IPC.agentSessionHibernate)?.(
          { sender: webContents, senderFrame: {} },
          { agentSessionId, expectedRevision: 7 }
        )
      ).toThrow('Unauthorized')
      expect(nodeClient.preflightAgentHibernation).toHaveBeenCalledTimes(3)

      showMessageBox.mockImplementationOnce(async () => {
        provider.leaseId = '40000000-0000-4000-8000-000000000009'
        return { response: 1 }
      })
      await expect(
        electron.handlers.get(DESKTOP_IPC.agentSessionHibernate)?.(
          { sender: webContents, senderFrame: mainFrame },
          { agentSessionId, expectedRevision: 7 }
        )
      ).rejects.toThrow('desktop authority is stale')
      expect(nodeClient.cancelAgentHibernation).toHaveBeenCalledTimes(3)
      expect(nodeClient.confirmAgentHibernation).toHaveBeenCalledOnce()
    }
  )

  it('fails closed when the Node-exclusive hibernation authority is unavailable', async () => {
    const registry = new WindowRegistry()
    const binding = new DesktopWindowBinding({ clearClient: vi.fn() } as never)
    binding.replaceNodeExclusive(browserViews, vi.fn().mockResolvedValue(undefined))
    registry.register('40000000-0000-4000-8000-000000000008', window, binding)
    const invokeNodeCore = vi.fn().mockResolvedValue({ handled: false })
    const showMessageBox = vi.fn()
    registerGlobalDesktopHandlers(new SenderBoundIpcRouter(registry), {
      isNodeCoreEnabled: () => true,
      invokeNodeCore,
      showMessageBox
    })

    await expect(
      electron.handlers.get(DESKTOP_IPC.agentSessionHibernate)?.(
        { sender: webContents, senderFrame: mainFrame },
        {
          agentSessionId: '40000000-0000-4000-8000-000000000001',
          expectedRevision: 7
        }
      )
    ).rejects.toThrow('Node hibernation authority is unavailable')
    expect(invokeNodeCore).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
