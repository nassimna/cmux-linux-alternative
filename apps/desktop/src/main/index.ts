import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

import {
  app,
  BrowserWindow,
  dialog,
  net,
  Notification,
  protocol,
  safeStorage,
  screen,
  shell
} from 'electron'
import {
  configurationGetResultSchema,
  isSafeExternalUrl,
  windowStateGetResultSchema,
  type WindowStateSnapshot,
  type DesktopProviderAcknowledgeParams,
  type DesktopProviderIdentityParams,
  type DesktopProviderRequest,
  type WindowCloseParams
} from '@agent-workspace/protocol-client'
import electronUpdater from 'electron-updater'

import { BrowserViewManager } from './browser-view-manager'
import { BrowserAutomationManager } from './browser-automation-manager'
import { BrowserAutomationProvider } from './browser-automation-provider'
import { DesktopWindowBinding } from './desktop-window-binding'
import {
  DesktopProviderAcknowledgementCache,
  DesktopProviderController
} from './desktop-provider-controller'
import {
  DESKTOP_ACTION_PROVIDER_CAPABILITIES,
  DesktopActionAcknowledgementCache,
  DesktopActionProvider
} from './desktop-action-provider'
import { ProjectActionConfirmationProvider } from './project-action-confirmation-provider'
import { registerWithStableWindowClaims } from './desktop-provider-registration'
import { ApplicationQuitOrchestrator } from './application-quit-orchestrator'
import { performExitCleanup as performApplicationExitCleanup } from './application-exit-cleanup'
import {
  NativeApplicationMenu,
  registerSenderBoundApplicationMenuHandlers
} from './application-menu'
import type { ControlClient } from './control-client'
import { resolveControlEndpoint } from './control-endpoint'
import { ControlTokenStore, type TokenCipher } from './control-token-store'
import {
  forwardDesktopEvents,
  forwardLifecycleState,
  registerDesktopHandlers,
  registerDesktopLifecycleHandlers,
  registerMultiWindowDesktopHandlers
} from './desktop-ipc'
import { CLI_SESSION_FILE_NAME, PRODUCT_NAME } from './identity'
import { LifecycleController } from './lifecycle-controller'
import { RENDERER_SCHEME, resolveRendererAsset } from './renderer-protocol'
import { loadRendererForCurrentLifecycle } from './renderer-load-orchestrator'
import { acquireMainWindow } from './main-window-acquisition'
import { resolveRendererTarget } from './renderer-target'
import { resolveServicePath, ServiceSupervisor } from './service-supervisor'
import { forwardSystemNotifications, shouldShowSystemNotification } from './system-notifications'
import {
  visibleSavedWindowState,
  WindowStateController,
  type DisplaySnapshot
} from './window-state-controller'
import { createWindowOptions } from './window-options'
import {
  detectNativeUpdatePackageType,
  parseUpdateFeedConfiguration,
  UpdateController
} from './update-controller'
import { registerSenderBoundDesktopUpdateHandlers } from './update-ipc'
import { WindowCreationEntrypoints } from './window-creation-entrypoints'
import { connectWindowScopedClient, rebindRegisteredWindows } from './window-client-rebinding'
import { WindowCreationCoordinator } from './window-lifecycle-coordinator'
import { WindowRegistry } from './window-registry'
import { SenderBoundIpcRouter } from './sender-bound-ipc-router'
import { invalidateProviderWindowBindings } from './provider-loss-cleanup'
import { closeTransferredProviderWindow, focusProviderWindow } from './provider-window-operations'
import { ProviderRecoveryCoordinator } from './provider-recovery-coordinator'
import { ProviderPollingGate } from './provider-polling-gate'
import { recoverProviderOwnership } from './provider-ownership-recovery'
import { DESKTOP_IPC } from '../shared/desktop-bridge'
import { reloadRendererAfterCrash } from './renderer-crash-reloader'
import { runtimeResourceIds } from './renderer-ownership-reconciliation'
import { shouldRequestServiceWindowClose } from './window-close-policy'
import { DesktopProviderClaims } from './desktop-provider-claims'

type ActiveDesktopProvider = DesktopProviderController<
  DesktopProviderRequest,
  Omit<DesktopProviderAcknowledgeParams, 'identity'>
>

interface DesktopProviderRecoveryContext {
  readonly controller: ActiveDesktopProvider
  readonly client: ControlClient
}

let supervisor: ServiceSupervisor | undefined
let lifecycle: LifecycleController | undefined
let readyBindingOperation: Promise<void> = Promise.resolve()
const providerPollingGate = new ProviderPollingGate()
const providerClaims = new DesktopProviderClaims()
let stopUpdateForwarding: (() => void) | undefined
let updateController: UpdateController | undefined
let desktopProvider: ActiveDesktopProvider | undefined
let desktopActionProvider: DesktopActionProvider | undefined
let browserAutomationProvider: BrowserAutomationProvider | undefined
let browserAutomationManager: BrowserAutomationManager | undefined
let projectActionConfirmationProvider: ProjectActionConfirmationProvider | undefined
let desktopProviderClient: ControlClient | undefined
let desktopProviderIdentity: DesktopProviderIdentityParams | undefined
let desktopProviderStart: { client: ControlClient; promise: Promise<void> } | undefined
const desktopInstanceId = randomUUID()
const desktopProviderAcknowledgements = new DesktopProviderAcknowledgementCache<
  Omit<DesktopProviderAcknowledgeParams, 'identity'>
>()
const desktopActionAcknowledgements = new DesktopActionAcknowledgementCache()
const desktopProviderRecovery = new ProviderRecoveryCoordinator<DesktopProviderRecoveryContext>({
  delaysMs: [0, 100, 500, 1_000, 2_000],
  recover: recoverDesktopProvider,
  sameContext: (left, right) =>
    left.controller === right.controller && left.client === right.client,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancelSchedule: (handle) => clearTimeout(handle),
  logError: (error) => console.error('[desktop-provider] recovery attempt failed', error)
})
const applicationMenu = new NativeApplicationMenu(process.platform, PRODUCT_NAME)
const windowRegistry = new WindowRegistry()
const closingWindowIds = new Set<string>()
const placementCreations = new Map<string, Promise<BrowserWindow>>()
const placementGenerations = new Map<string, number>()
const suspendedBrowserTransfers = new Map<
  string,
  { sourceWindowId: string; source: BrowserViewManager; rollback: () => void }
>()
const suspendedTerminalTransfers = new Map<
  string,
  { sourceWindowId: string; rollback: () => Promise<void> }
>()
const senderBoundIpc = new SenderBoundIpcRouter(windowRegistry)
registerDesktopHandlers(senderBoundIpc, {
  serializeResource: (resourceId, operation) => windowRegistry.transfer(resourceId, operation),
  terminalAttached: (windowId, terminalId) =>
    windowRegistry.get(windowId)?.terminalAttachments.add(terminalId),
  terminalDetached: (windowId, terminalId) =>
    windowRegistry.get(windowId)?.terminalAttachments.delete(terminalId),
  ownershipAcquired: (windowId, resourceId) =>
    windowRegistry.recordRendererOwnership(resourceId, windowId),
  waitForOwnershipTransfer: (windowId, resourceId) =>
    windowRegistry.waitForOwnershipTransfer(resourceId, windowId),
  waitForWindowActivation: (entry) => windowRegistry.waitForWindowActivation(entry),
  isWindowEntryCurrent: (entry) => windowRegistry.get(entry.windowId) === entry,
  isApplicationGlobalLayoutAvailable: () => windowRegistry.size <= 1,
  getDesktopProviderIdentity: () => desktopProviderIdentity,
  enrollRemoteCredential: async (targetId, expectedRevision, credentialFd) => {
    if (!supervisor) throw new Error('The local service is not ready')
    return supervisor.enrollRemoteCredential(targetId, expectedRevision, credentialFd)
  },
  commitRemoteCredential: async (enrollmentId, targetId, expectedRevision) => {
    if (!supervisor) throw new Error('The local service is not ready')
    await supervisor.commitRemoteCredential(enrollmentId, targetId, expectedRevision)
  },
  removeRemoteCredential: async (enrollmentId, targetId) => {
    if (!supervisor) throw new Error('The local service is not ready')
    await supervisor.removeRemoteCredential(enrollmentId, targetId)
  }
})
registerMultiWindowDesktopHandlers(senderBoundIpc)
registerSenderBoundApplicationMenuHandlers(senderBoundIpc, applicationMenu)

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true
    }
  }
])

function createTokenCipher(): TokenCipher {
  return {
    decrypt: (value) => safeStorage.decryptString(value),
    encrypt: (value) => safeStorage.encryptString(value),
    isSecure: () => {
      if (!safeStorage.isEncryptionAvailable()) return false
      return (
        process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
      )
    }
  }
}

async function bindReadyClient(client: ControlClient): Promise<void> {
  desktopProviderRecovery.cancel()
  await providerPollingGate.bindAll(
    () => rebindRegisteredWindows(windowRegistry, client, bindReadyClientForWindow),
    () => startProviderPolling(client)
  )
}

function bindReadyClientForWindow(
  window: BrowserWindow,
  client: ControlClient,
  options: { notifyRenderer?: boolean } = {}
): Promise<void> {
  return serializeReadyBindingOperation(async () => {
    await bindReadyClientNow(window, client, options)
    providerPollingGate.bindingReady(() => startProviderPolling(client))
  })
}

function startProviderPolling(client: ControlClient): void {
  if (desktopProviderClient !== client || !desktopProvider?.active) return
  desktopProvider.startPolling()
  desktopActionProvider?.start()
  browserAutomationProvider?.start()
  projectActionConfirmationProvider?.start()
}

async function bindReadyClientNow(
  window: BrowserWindow,
  providerClient: ControlClient,
  options: { notifyRenderer?: boolean } = {}
): Promise<void> {
  let entry = windowRegistry.findByWindow(window)
  if (!entry || window.isDestroyed() || quitOrchestrator.isQuitStarted()) return
  await unbindReadyClientNow(window)
  if (
    windowRegistry.findByWindow(window) !== entry ||
    window.isDestroyed() ||
    quitOrchestrator.isQuitStarted()
  )
    return
  const initialEntry = entry
  let scopedWindow: boolean
  try {
    const topology = await providerClient.listWindows()
    if (!topology.windows.some(({ windowId }) => windowId === initialEntry.windowId)) {
      const projection = await providerClient.listWorkspaces()
      const selectedWorkspaceId = projection.snapshot.selectedWorkspaceId
      const candidates = topology.windows.filter(
        ({ windowId, workspaceIds }) =>
          !windowRegistry.get(windowId) &&
          selectedWorkspaceId !== null &&
          workspaceIds.includes(selectedWorkspaceId)
      )
      if (candidates.length !== 1) {
        throw new Error('The renderer placement could not be bound unambiguously')
      }
      entry = windowRegistry.rekey(initialEntry.windowId, candidates[0]!.windowId)
    }
    scopedWindow = true
  } catch {
    scopedWindow = false
  }

  let client = providerClient
  let ownsClient = false
  if (scopedWindow) {
    await ensureDesktopProvider(providerClient)
    await desktopProvider?.heartbeatNow()
    const identity = desktopProviderIdentity
    const current = windowRegistry.findByWindow(window)
    if (!identity || !current) throw new Error('Desktop-provider window claim is unavailable')
    const activeSupervisor = supervisor
    if (!activeSupervisor) throw new Error('Window-scoped control client is unavailable')
    const child = await connectWindowScopedClient(activeSupervisor, identity, current)
    client = child
    ownsClient = true
    entry = current
  }

  const browserViews = new BrowserViewManager(window, client, {
    reconcileResources: (snapshot) => {
      const current = windowRegistry.findByWindow(window)
      if (current) {
        windowRegistry.reconcileRendererOwnership(current.windowId, runtimeResourceIds(snapshot))
      }
    }
  })
  let stopEvents: (() => void) | undefined
  let stopNotifications: (() => void) | undefined
  try {
    stopEvents = forwardDesktopEvents(window, client, (resourceId, epoch, source, target) =>
      windowRegistry.observeOwnershipTransfer(resourceId, epoch, source, target)
    )
    stopNotifications = await forwardSystemNotifications(client, (payload) => {
      if (window.isDestroyed()) return
      if (shouldShowSystemNotification(Notification.isSupported(), window.isFocused())) {
        new Notification(payload).show()
      }
    })
    const configuration = await client
      .getConfiguration()
      .then((result) => configurationGetResultSchema.parse(result))
      .catch(() => undefined)
    if (configuration) {
      browserViews.configureBrowserProfile(configuration.config.browser)
      updateController?.applyChannel(configuration.config.updates.channel)
    }
    if (
      windowRegistry.findByWindow(window) !== entry ||
      window.isDestroyed() ||
      quitOrchestrator.isQuitStarted()
    ) {
      stopEvents?.()
      stopNotifications?.()
      browserViews.dispose()
      if (ownsClient) client.close()
      return
    }
  } catch (error) {
    stopEvents?.()
    stopNotifications?.()
    browserViews.dispose()
    if (ownsClient) client.close()
    throw error
  }
  let disposed = false
  const binding = entry.binding as DesktopWindowBinding
  binding.replaceReady(client, browserViews, () => {
    if (disposed) return Promise.resolve()
    disposed = true
    stopEvents?.()
    stopNotifications?.()
    browserViews.dispose()
    if (ownsClient) client.close()
    return Promise.resolve()
  })
  if (
    options.notifyRenderer !== false &&
    windowRegistry.findByWindow(window) === entry &&
    !window.isDestroyed()
  ) {
    window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
  }
  const boundsClient = scopedWindow ? scopedWindowStateClient(client, window) : client
  await binding.stateController.rebase(boundsClient).catch(() => undefined)
  if (
    options.notifyRenderer !== false &&
    windowRegistry.findByWindow(window) === entry &&
    !window.isDestroyed()
  ) {
    window.webContents.send(DESKTOP_IPC.browserViewsRebind)
  }
}

function unbindReadyClient(): Promise<void> {
  desktopProviderRecovery.cancel()
  return serializeReadyBindingOperation(async () => {
    // Keep the shared lease registered until an in-flight start claim has either
    // been declined or acknowledged as stopped before its native effect.
    await Promise.all([
      desktopActionProvider?.stop(),
      browserAutomationProvider?.stop(),
      projectActionConfirmationProvider?.stop()
    ])
    await desktopProvider?.stop()
    desktopActionProvider = undefined
    browserAutomationProvider = undefined
    browserAutomationManager = undefined
    projectActionConfirmationProvider = undefined
    desktopProvider = undefined
    desktopProviderClient = undefined
    desktopProviderIdentity = undefined
    for (const transfer of suspendedBrowserTransfers.values()) transfer.rollback()
    suspendedBrowserTransfers.clear()
    await Promise.allSettled(
      [...suspendedTerminalTransfers.values()].map(({ rollback }) => rollback())
    )
    suspendedTerminalTransfers.clear()
    await Promise.all(windowRegistry.list().map(({ window }) => unbindReadyClientNow(window)))
  })
}

async function invalidateProviderBindings(owner?: ActiveDesktopProvider): Promise<void> {
  if (owner && desktopProvider !== owner) return
  await desktopActionProvider?.stop('desktop provider lease was lost').catch(() => undefined)
  await browserAutomationProvider?.stop('desktop provider lease was lost').catch(() => undefined)
  await projectActionConfirmationProvider
    ?.stop('desktop provider lease was lost')
    .catch(() => undefined)
  desktopActionProvider = undefined
  browserAutomationProvider = undefined
  browserAutomationManager = undefined
  projectActionConfirmationProvider = undefined
  suspendedTerminalTransfers.clear()
  windowRegistry.failOwnershipTransfers('Desktop-provider lease was lost')
  await invalidateProviderWindowBindings(windowRegistry, () => {
    for (const transfer of suspendedBrowserTransfers.values()) transfer.rollback()
    suspendedBrowserTransfers.clear()
  })
  desktopProvider = undefined
  desktopProviderClient = undefined
  desktopProviderIdentity = undefined
}

async function recoverDesktopProvider(context: DesktopProviderRecoveryContext): Promise<boolean> {
  if (
    quitOrchestrator.isQuitStarted() ||
    lifecycle?.getClient() !== context.client ||
    (desktopProvider !== undefined && desktopProvider !== context.controller)
  ) {
    return true
  }
  return serializeReadyBindingOperation(async () => {
    if (
      quitOrchestrator.isQuitStarted() ||
      lifecycle?.getClient() !== context.client ||
      (desktopProvider !== undefined && desktopProvider !== context.controller)
    ) {
      return true
    }
    await invalidateProviderBindings(context.controller)
    if (quitOrchestrator.isQuitStarted() || lifecycle?.getClient() !== context.client) return true
    try {
      await context.client.connect()
      await ensureDesktopProvider(context.client)
      const entries = windowRegistry.list().map(({ generation, window, windowId }) => ({
        generation,
        window,
        windowId
      }))
      for (const entry of entries) {
        const current = windowRegistry.get(entry.windowId)
        if (current?.generation !== entry.generation || current.window !== entry.window) continue
        await bindReadyClientNow(entry.window, context.client)
      }
      if (desktopProviderClient === context.client && desktopProvider?.active) {
        startProviderPolling(context.client)
      }
      return (
        lifecycle?.getClient() === context.client &&
        desktopProviderClient === context.client &&
        desktopProvider?.active === true
      )
    } catch (error) {
      console.error('[desktop-provider] recovery failed', error)
      const failed = desktopProvider
      if (failed && desktopProviderClient === context.client) {
        await failed.stop().catch(() => undefined)
        await invalidateProviderBindings(failed)
      }
      return false
    }
  })
}

function unbindReadyClientForWindow(window: BrowserWindow): Promise<void> {
  return serializeReadyBindingOperation(() => unbindReadyClientNow(window))
}

async function unbindReadyClientNow(owner?: BrowserWindow): Promise<void> {
  if (owner) {
    const entry = windowRegistry.findByWindow(owner)
    const binding = entry?.binding
    if (entry) await browserAutomationManager?.destroyTarget(entry.windowId, entry.generation)
    if (binding instanceof DesktopWindowBinding) await binding.clearReady()
    return
  }
  await Promise.all(
    windowRegistry
      .list()
      .map(({ binding }) =>
        binding instanceof DesktopWindowBinding ? binding.clearReady() : Promise.resolve()
      )
  )
}

function createBrowserAutomationManager(approvedProfileKey: string): BrowserAutomationManager {
  const requireEntry = (target: { window: { windowId: string; windowGeneration: number } }) => {
    const entry = windowRegistry.get(target.window.windowId)
    if (
      !entry ||
      entry.generation !== target.window.windowGeneration ||
      entry.window.isDestroyed()
    ) {
      return undefined
    }
    return entry
  }
  return new BrowserAutomationManager({
    acquireAttachedPage: (target, profileKey, signal) => {
      if (signal.aborted) return Promise.resolve(undefined)
      if (profileKey !== approvedProfileKey) return Promise.resolve(undefined)
      const entry = requireEntry(target)
      if (!entry) return Promise.resolve(undefined)
      try {
        return Promise.resolve(
          entry.binding.browserViews.acquireAutomationPage(target, approvedProfileKey)
        )
      } catch {
        return Promise.resolve(undefined)
      }
    },
    createEphemeralPage: (snapshot, signal) => {
      if (signal.aborted) return Promise.reject(new Error('Automation creation was canceled'))
      if (snapshot.profileKey !== approvedProfileKey) {
        return Promise.reject(new Error('Automation profile is unavailable'))
      }
      const entry = requireEntry(snapshot.target)
      if (!entry) return Promise.reject(new Error('Automation target window is stale'))
      return Promise.resolve(entry.binding.browserViews.createEphemeralAutomationPage(snapshot))
    },
    confirmAttachment: async (target, signal) => {
      if (signal.aborted) return false
      const entry = requireEntry(target)
      if (!entry) return false
      const result = await dialog.showMessageBox(entry.window, {
        type: 'warning',
        buttons: ['Deny', 'Allow once'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Allow browser automation?',
        message: 'Allow automation to control the selected browser tab?',
        detail: 'This one-time approval applies only to the exact current tab and window.'
      })
      return !signal.aborted && requireEntry(target) === entry && result.response === 1
    },
    now: Date.now,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle)
  })
}

function serializeReadyBindingOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = readyBindingOperation.catch(() => undefined).then(operation)
  readyBindingOperation = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function createMainWindow(
  savedState?: WindowStateSnapshot,
  serviceWindowId?: string,
  serviceGeneration?: number
): Promise<BrowserWindow> {
  let acquiredRegistryBinding: DesktopWindowBinding | undefined
  let provisionalWindowId: string | undefined
  let acquiredLifecycle: LifecycleController | undefined
  let registryRemoval: Promise<unknown> | undefined
  return acquireMainWindow({
    clear: (window) => {
      registryRemoval ??= windowRegistry.removeWindow(window, 'closed')
    },
    create: () =>
      new BrowserWindow(
        createWindowOptions(join(import.meta.dirname, '../preload/index.cjs'), savedState)
      ),
    destroy: (window) => window.destroy(),
    initialize: (window, acquisition) => {
      if (savedState?.maximized) window.maximize()
      if (!app.isPackaged) installDevelopmentLogging(window)
      window.setTitle(PRODUCT_NAME)
      window.once('ready-to-show', () => window.show())
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.on('close', (event) => {
        if (
          shouldRequestServiceWindowClose(
            windowRegistry.size,
            desktopProvider?.active === true,
            quitOrchestrator.isQuitStarted()
          )
        ) {
          event.preventDefault()
          void requestServiceWindowClose(window)
          return
        }
        if (process.platform !== 'darwin') quitOrchestrator.windowClose(event)
      })

      const removeWindowApplicationMenu = applicationMenu.bindWindow(window)
      acquisition.addCleanup(removeWindowApplicationMenu)

      const currentLifecycle = lifecycle
      if (!currentLifecycle || !supervisor) {
        throw new Error('Desktop lifecycle is unavailable')
      }
      acquiredLifecycle = currentLifecycle

      const stopLifecycleForwarding = forwardLifecycleState(window, (listener) =>
        currentLifecycle.onStateChanged(listener)
      )
      acquisition.addCleanup(stopLifecycleForwarding)

      const stateController = new WindowStateController(window, {
        getDisplayMatching: (bounds) => toDisplaySnapshot(screen.getDisplayMatching(bounds))
      })
      const client = currentLifecycle.getClient()
      if (client) stateController.setClient(client, savedState)

      provisionalWindowId = serviceWindowId ?? randomUUID()
      acquiredRegistryBinding = new DesktopWindowBinding(stateController)
      acquisition.addCleanup(async () => {
        registryRemoval ??= windowRegistry.removeWindow(window, 'closed')
        await registryRemoval
      })
      installRendererCrashRecovery(window, currentLifecycle)
      window.once('closed', () => {
        void acquisition.release().catch((error) => {
          console.error('[window] failed to release main-window bindings', error)
        })
      })
    },
    isDestroyed: (window) => window.isDestroyed(),
    load: (window) => {
      const currentLifecycle = acquiredLifecycle
      if (!currentLifecycle) return Promise.reject(new Error('Desktop lifecycle is unavailable'))
      return loadRendererForCurrentLifecycle({
        getReadyClient: () => getReadyClient(currentLifecycle),
        bind: (client) => bindReadyClientForWindow(window, client),
        unbind: () => unbindReadyClientForWindow(window),
        load: () =>
          window.loadURL(resolveRendererTarget(app.isPackaged, process.env.ELECTRON_RENDERER_URL))
      })
    },
    publish: (window) => {
      if (!provisionalWindowId || !acquiredRegistryBinding) {
        throw new Error('Window registry binding is unavailable')
      }
      windowRegistry.register(
        provisionalWindowId,
        window,
        acquiredRegistryBinding,
        serviceGeneration
      )
    }
  })
}

function createServicePlacementWindow(
  client: ControlClient,
  windowId: string,
  generation?: number
): Promise<BrowserWindow> {
  const existing = windowRegistry.get(windowId)
  if (existing) return Promise.resolve(existing.window)
  if (generation !== undefined) placementGenerations.set(windowId, generation)
  const pending = placementCreations.get(windowId)
  if (pending) return pending
  const creation = resolveSavedWindowStateFor(client, windowId).then((savedState) =>
    createMainWindow(savedState, windowId, placementGenerations.get(windowId) ?? generation)
  )
  placementCreations.set(windowId, creation)
  return creation.finally(() => {
    if (placementCreations.get(windowId) === creation) placementCreations.delete(windowId)
    placementGenerations.delete(windowId)
  })
}

function discardMainWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.destroy()
}

function installRendererCrashRecovery(
  window: BrowserWindow,
  currentLifecycle: LifecycleController
): void {
  let previousCrashAt = 0
  let reloadInProgress = false
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || window.isDestroyed()) return
    const now = Date.now()
    if (reloadInProgress || now - previousCrashAt < 10_000) {
      queueMicrotask(() => app.quit())
      return
    }
    previousCrashAt = now
    reloadInProgress = true
    const provider = desktopProvider
    const actionProvider = desktopActionProvider
    const confirmationProvider = projectActionConfirmationProvider
    void Promise.resolve()
      .then(async () => {
        await Promise.all([
          provider?.pausePolling('renderer generation changed'),
          actionProvider?.pause('renderer generation changed'),
          confirmationProvider?.pause('renderer generation changed')
        ])
        if (window.isDestroyed()) throw new Error('Window closed during renderer recovery')
        const entry = windowRegistry.findByWindow(window)
        if (entry) {
          windowRegistry.refreshRenderer(entry.windowId)
          if (provider && desktopProvider === provider && provider.active) {
            await provider.heartbeatNow().catch(() => undefined)
          }
        }
        await loadRendererForCurrentLifecycle(
          {
            getReadyClient: () => getReadyClient(currentLifecycle),
            bind: (client) => bindReadyClientForWindow(window, client, { notifyRenderer: false }),
            unbind: () => unbindReadyClientForWindow(window),
            load: () => reloadRendererAfterCrash(window)
          },
          { unbindFirst: true }
        )
      })
      .then(() => {
        previousCrashAt = 0
      })
      .catch(() => app.quit())
      .finally(() => {
        reloadInProgress = false
      })
  })
}

function getReadyClient(currentLifecycle: LifecycleController): ControlClient | undefined {
  return currentLifecycle.getState().status === 'ready' ? currentLifecycle.getClient() : undefined
}

function installDevelopmentLogging(window: BrowserWindow): void {
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.error(`[renderer:${String(level)}] ${sourceId}:${String(line)} ${message}`)
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload] ${preloadPath}: ${error.message}`)
  })
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame) {
        console.error(`[renderer-load] ${validatedUrl}: ${String(errorCode)} ${errorDescription}`)
      }
    }
  )
}

async function resolveSavedWindowState(
  client: ControlClient
): Promise<WindowStateSnapshot | undefined> {
  try {
    const result = windowStateGetResultSchema.parse(await client.getWindowState())
    return visibleSavedWindowState(result.state, screen.getAllDisplays().map(toDisplaySnapshot))
  } catch {
    return undefined
  }
}

async function resolveSavedWindowStateFor(
  client: ControlClient,
  windowId: string
): Promise<WindowStateSnapshot | undefined> {
  try {
    const result = await client.getWindowStateFor({ windowId })
    return visibleSavedWindowState(result.state, screen.getAllDisplays().map(toDisplaySnapshot))
  } catch {
    return undefined
  }
}

function toDisplaySnapshot(display: Electron.Display): DisplaySnapshot {
  return { id: display.id, workArea: display.workArea }
}

const windowCreationCoordinator = new WindowCreationCoordinator<
  BrowserWindow,
  WindowStateSnapshot | undefined
>({
  createWindow: createMainWindow,
  discardWindow: discardMainWindow,
  getCurrentWindow: currentWindow,
  isQuitStarted: () => quitOrchestrator.isQuitStarted(),
  isWindowLive: (window) => !window.isDestroyed(),
  resolveState: async () => {
    const currentLifecycle = lifecycle
    const client =
      currentLifecycle?.getState().status === 'ready' ? currentLifecycle.getClient() : undefined
    return client ? resolveSavedWindowState(client) : undefined
  }
})

function createWindowForCurrentState(): Promise<BrowserWindow | undefined> {
  if (!lifecycle || !supervisor) return Promise.resolve(undefined)
  return windowCreationCoordinator.ensureWindow()
}

async function createInitialWindowForCurrentState(): Promise<BrowserWindow | undefined> {
  const client = lifecycle?.getClient()
  if (!client || !supervisor) return createWindowForCurrentState()
  try {
    const topology = await client.listWindows()
    const focused = topology.windows.find(({ windowId }) => windowId === topology.focusedWindowId)
    if (!focused) throw new Error('Focused service placement is unavailable')
    const ordered = [focused, ...topology.windows.filter((placement) => placement !== focused)]
    const plannedClaims = windowRegistry.reserveRendererGenerations(
      ordered.map(({ windowId }) => windowId)
    )
    const generationByWindow = new Map(
      plannedClaims.map(({ generation, windowId }) => [windowId, generation])
    )
    const finishRestore = providerClaims.stage(plannedClaims)
    let restoreClaimsFinished = false
    let focusedWindow: BrowserWindow | undefined
    try {
      await providerPollingGate.bindAll(
        async () => {
          for (const placement of ordered) {
            if (windowRegistry.get(placement.windowId)) continue
            try {
              const created = await createServicePlacementWindow(
                client,
                placement.windowId,
                generationByWindow.get(placement.windowId)
              )
              if (placement === focused) focusedWindow = created
            } catch (error) {
              console.error(`[window] failed to restore placement ${placement.windowId}`, error)
            }
          }
          // Failed native creations must be withdrawn and published before polling can dispatch
          // requests to the staged placement set. A final exact heartbeat also makes a partial
          // restore authoritative immediately instead of waiting for the lease timer.
          finishRestore()
          restoreClaimsFinished = true
          if (desktopProviderClient === client && desktopProvider?.active) {
            await desktopProvider.heartbeatNow()
          }
        },
        () => startProviderPolling(client)
      )
    } finally {
      if (!restoreClaimsFinished) finishRestore()
    }
    if (windowRegistry.size === 0) throw new Error('No service placement could be restored')
    focusedWindow?.focus()
    return focusedWindow ?? currentWindow()
  } catch {
    return windowRegistry.size > 0 ? currentWindow() : createWindowForCurrentState()
  }
}

const windowCreationEntrypoints = new WindowCreationEntrypoints({
  createWindow: createWindowForCurrentState,
  getLiveWindow: currentWindow,
  hasLiveWindow: () => currentWindow() !== undefined,
  isQuitStarted: () => quitOrchestrator.isQuitStarted(),
  isWindowLive: (window: BrowserWindow) => !window.isDestroyed(),
  logError: (message: string) => console.error(message),
  quit: () => app.quit()
})

function currentWindow(): BrowserWindow | undefined {
  return windowRegistry.list().find(({ window }) => !window.isDestroyed())?.window
}

async function requestServiceWindowClose(window: BrowserWindow): Promise<void> {
  const entry = windowRegistry.findByWindow(window)
  if (!entry || closingWindowIds.has(entry.windowId)) return
  closingWindowIds.add(entry.windowId)
  try {
    const client = (entry.binding as DesktopWindowBinding).client
    const topology = await client.listWindows()
    const current = topology.windows.find(({ windowId }) => windowId === entry.windowId)
    const target = topology.windows.find(
      ({ hostingState, windowId }) => windowId !== entry.windowId && hostingState === 'hosted'
    )
    if (!current || !target) throw new Error('No eligible window rehome target is available')
    await client.closeWindow({
      mutation: {
        expectedRevision: topology.revision,
        idempotencyEpoch: topology.idempotencyEpoch,
        idempotencyKey: randomUUID()
      },
      window: { windowId: current.windowId, expectedRevision: current.revision },
      policy: 'rehome',
      rehomeTarget: { windowId: target.windowId, expectedRevision: target.revision }
    } as unknown as WindowCloseParams)
  } catch (error) {
    console.error('[window] close request failed', error)
  } finally {
    closingWindowIds.delete(entry.windowId)
  }
}

function scopedWindowStateClient(
  client: ControlClient,
  window: BrowserWindow
): {
  getWindowState(): Promise<unknown>
  updateWindowState(params: { state: WindowStateSnapshot }): Promise<unknown>
} {
  const windowId = (): string => {
    const entry = windowRegistry.findByWindow(window)
    if (!entry) throw new Error('Window placement is unavailable')
    return entry.windowId
  }
  return {
    getWindowState: async () => {
      const result = await client.getWindowStateFor({ windowId: windowId() })
      return { state: result.state }
    },
    updateWindowState: async ({ state }) => {
      const result = await client.updateWindowStateFor({ windowId: windowId(), state })
      return { state: result.state }
    }
  }
}

async function ensureDesktopProvider(client: ControlClient): Promise<void> {
  if (desktopProvider?.active && desktopProviderClient === client) return
  if (desktopProvider?.active)
    throw new Error('Desktop provider belongs to another service generation')
  if (desktopProviderStart?.client === client) return desktopProviderStart.promise
  if (desktopProviderStart) throw new Error('Desktop provider is starting for another generation')
  const starting = startDesktopProvider(client)
  desktopProviderStart = { client, promise: starting }
  try {
    await starting
  } finally {
    if (desktopProviderStart?.promise === starting) desktopProviderStart = undefined
  }
}

async function startDesktopProvider(client: ControlClient): Promise<void> {
  const bootstrapProof = supervisor?.getDesktopBootstrapProof()
  if (!bootstrapProof) throw new Error('Desktop-provider bootstrap proof is unavailable')
  const serviceCapabilities = (await client.identify()).capabilities
  const supportsDesktopActions = serviceCapabilities.includes('actions-v1')
  const automationConfiguration = serviceCapabilities.includes('browser-automation-v1')
    ? await client.getConfiguration().catch(() => undefined)
    : undefined
  const supportsBrowserAutomation = automationConfiguration !== undefined
  const requests = new Map<string, DesktopProviderRequest>()
  const claims = () =>
    providerClaims.snapshot(
      windowRegistry.list().map(({ generation, windowId }) => ({ windowId, generation }))
    )
  let controllerIdentity: DesktopProviderIdentityParams | undefined
  const requireIdentity = (): DesktopProviderIdentityParams => {
    if (!controllerIdentity) throw new Error('Desktop-provider identity is unavailable')
    return controllerIdentity
  }
  let actionProvider: DesktopActionProvider | undefined
  let automationProvider: BrowserAutomationProvider | undefined
  let automationManager: BrowserAutomationManager | undefined
  let confirmationProvider: ProjectActionConfirmationProvider | undefined
  const controller: ActiveDesktopProvider = new DesktopProviderController({
    transport: {
      register: async () => {
        const registration = await registerWithStableWindowClaims({
          claims,
          register: (registeredClaims) =>
            client.registerDesktopProvider({
              bootstrapProof,
              instanceId: desktopInstanceId,
              capabilities: [
                'window-host-v1',
                'tab-transfer-v1',
                'browser-transfer-v1',
                ...(supportsDesktopActions ? DESKTOP_ACTION_PROVIDER_CAPABILITIES : []),
                ...(supportsBrowserAutomation ? ['browser-automation-v1'] : [])
              ],
              windows: [...registeredClaims]
            }),
          unregister: (candidate) =>
            client.unregisterDesktopProvider({
              identity: {
                providerId: candidate.providerId,
                providerEpoch: candidate.providerEpoch,
                leaseId: candidate.leaseId
              }
            })
        })
        controllerIdentity = {
          providerId: registration.providerId,
          providerEpoch: registration.providerEpoch,
          leaseId: registration.leaseId
        }
        if (desktopProvider === controller) {
          desktopProviderIdentity = controllerIdentity
          windowRegistry.resetProviderEpoch(registration.providerEpoch)
        }
        return {
          leaseId: registration.leaseId,
          heartbeatIntervalMs: registration.heartbeatIntervalMs,
          providerEpoch: registration.providerEpoch
        }
      },
      heartbeat: async () => {
        const current = requireIdentity()
        await client.heartbeatDesktopProvider({ ...current, windows: [...claims()] })
      },
      unregister: async () => {
        const current = controllerIdentity
        controllerIdentity = undefined
        if (
          desktopProvider === controller &&
          current &&
          desktopProviderIdentity?.providerId === current.providerId &&
          desktopProviderIdentity.providerEpoch === current.providerEpoch &&
          desktopProviderIdentity.leaseId === current.leaseId
        ) {
          desktopProviderIdentity = undefined
        }
        if (current) await client.unregisterDesktopProvider({ identity: current })
      },
      poll: async (_leaseId, signal) => {
        if (signal.aborted) return null
        const result = await client.pollDesktopProvider({
          identity: requireIdentity(),
          timeoutMs: 5_000
        })
        if (result.request) requests.set(result.request.requestId, result.request)
        return result.request ?? null
      },
      acknowledge: async (_leaseId, acknowledgement) => {
        await client.acknowledgeDesktopProvider({
          ...acknowledgement,
          identity: requireIdentity()
        })
        requests.delete(acknowledgement.requestId)
      },
      cancel: async (_leaseId, requestId) => {
        const request = requests.get(requestId)
        if (!request) return
        await client.cancelDesktopProvider({
          identity: requireIdentity(),
          requestId,
          correlationId: request.correlationId,
          attemptEpoch: request.attemptEpoch
        })
        requests.delete(requestId)
      }
    },
    execute: executeDesktopProviderRequest,
    executionFailed: (request) => ({
      requestId: request.requestId,
      correlationId: request.correlationId,
      attemptEpoch: request.attemptEpoch,
      status: 'failed' as const,
      errorCode: 'desktop_action_failed'
    }),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle),
    logError: (message, error) => console.error(`[desktop-provider] ${message}`, error),
    onLeaseLost: async (reason) => {
      if (desktopProvider !== controller || lifecycle?.getClient() !== client) return
      await Promise.all([
        actionProvider?.stop(reason),
        automationProvider?.stop(reason),
        confirmationProvider?.stop(reason)
      ])
      if (desktopProvider !== controller || lifecycle?.getClient() !== client) return
      desktopProviderRecovery.request({ controller, client })
    },
    acknowledgementCache: desktopProviderAcknowledgements,
    acknowledged: (request, acknowledgement) => {
      if (request.operation !== 'createWindow') return
      if (acknowledgement.status === 'succeeded')
        windowRegistry.activateWindow(request.target.windowId, request.target.generation)
      else
        windowRegistry.failWindowActivation(
          request.target.windowId,
          'Desktop-provider rejected window activation'
        )
    },
    deferPolling: true
  })
  desktopProvider = controller
  desktopProviderClient = client
  try {
    await controller.start()
    if (supportsBrowserAutomation) {
      automationManager = createBrowserAutomationManager(
        automationConfiguration.config.browser.partition
      )
      const manager = automationManager
      automationProvider = new BrowserAutomationProvider({
        identity: requireIdentity(),
        transport: {
          poll: (params) => client.pollBrowserAutomation(params),
          acknowledge: (params) => client.acknowledgeBrowserAutomation(params),
          respondTransfer: (params) => client.respondBrowserAutomationTransfer(params)
        },
        resolveManager: (windowId, windowGeneration) => {
          const entry = windowRegistry.get(windowId)
          return entry?.generation === windowGeneration && !entry.window.isDestroyed()
            ? manager
            : undefined
        },
        managers: () => [manager],
        logError: (message, error) => console.error(`[browser-automation] ${message}`, error),
        onProviderLost: (reason) => {
          if (
            desktopProvider !== controller ||
            browserAutomationProvider !== automationProvider ||
            lifecycle?.getClient() !== client
          ) {
            return
          }
          void Promise.all([
            actionProvider?.stop(reason),
            confirmationProvider?.stop(reason),
            controller.stop(reason)
          ]).then(() => {
            if (desktopProvider === controller && lifecycle?.getClient() === client) {
              desktopProviderRecovery.request({ controller, client })
            }
          })
        }
      })
      browserAutomationManager = manager
      browserAutomationProvider = automationProvider
    }
    if (supportsDesktopActions) {
      actionProvider = new DesktopActionProvider({
        identity: requireIdentity(),
        registry: windowRegistry,
        acknowledgementCache: desktopActionAcknowledgements,
        transport: {
          poll: (params) => client.pollDesktopAction(params),
          claimStart: (params) => client.claimDesktopActionStart(params),
          acknowledge: (params) => client.acknowledgeDesktopAction(params)
        },
        logError: (message, error) => console.error(`[desktop-action] ${message}`, error),
        onProviderLost: (reason) => {
          if (
            desktopProvider !== controller ||
            desktopActionProvider !== actionProvider ||
            lifecycle?.getClient() !== client
          ) {
            return
          }
          void Promise.all([
            automationProvider?.stop(reason),
            confirmationProvider?.stop(reason),
            controller.stop(reason)
          ]).then(() => {
            if (desktopProvider === controller && lifecycle?.getClient() === client) {
              desktopProviderRecovery.request({ controller, client })
            }
          })
        }
      })
      desktopActionProvider = actionProvider
      confirmationProvider = new ProjectActionConfirmationProvider({
        identity: requireIdentity(),
        registry: windowRegistry,
        transport: {
          poll: (params) => client.pollProjectActionConfirmation(params),
          respond: (params) => client.respondProjectActionConfirmation(params)
        },
        logError: (message, error) =>
          console.error(`[project-action-confirmation] ${message}`, error),
        onProviderLost: (reason) => {
          if (
            desktopProvider !== controller ||
            projectActionConfirmationProvider !== confirmationProvider ||
            lifecycle?.getClient() !== client
          ) {
            return
          }
          void Promise.all([
            actionProvider?.stop(reason),
            automationProvider?.stop(reason),
            controller.stop(reason)
          ]).then(() => {
            if (desktopProvider === controller && lifecycle?.getClient() === client) {
              desktopProviderRecovery.request({ controller, client })
            }
          })
        }
      })
      projectActionConfirmationProvider = confirmationProvider
    }
    // Provider registration can complete while the final window-binding deferral is unwinding.
    // In that ordering an earlier polling callback sees only the controller, before these optional
    // reverse providers have been published. Re-check the gate after publishing all providers;
    // each start method is idempotent and an outstanding binding deferral still holds the gate.
    providerPollingGate.bindingReady(() => startProviderPolling(client))
  } catch (error) {
    await Promise.all([
      actionProvider?.stop('desktop provider startup failed').catch(() => undefined),
      automationProvider?.stop('desktop provider startup failed').catch(() => undefined),
      confirmationProvider?.stop('desktop provider startup failed').catch(() => undefined)
    ])
    if (desktopProvider === controller) {
      desktopActionProvider = undefined
      browserAutomationProvider = undefined
      browserAutomationManager = undefined
      projectActionConfirmationProvider = undefined
      desktopProvider = undefined
      desktopProviderClient = undefined
      desktopProviderIdentity = undefined
    }
    throw error
  }
}

async function executeDesktopProviderRequest(
  request: DesktopProviderRequest,
  signal: AbortSignal
): Promise<Omit<DesktopProviderAcknowledgeParams, 'identity'>> {
  if (signal.aborted) throw new Error('Desktop-provider request was canceled')
  const existing = windowRegistry.get(request.target.windowId)
  if (existing && existing.generation !== request.target.generation) {
    throw new Error('Desktop-provider target generation is stale')
  }
  if (request.operation === 'createWindow') {
    if (!existing) {
      const providerClient = lifecycle?.getClient()
      if (!providerClient) throw new Error('Desktop-provider control client is unavailable')
      windowRegistry.deferWindowActivation(request.target.windowId, request.target.generation)
      try {
        await createServicePlacementWindow(
          providerClient,
          request.target.windowId,
          request.target.generation
        )
      } catch (error) {
        windowRegistry.failWindowActivation(
          request.target.windowId,
          'Desktop-provider window creation failed'
        )
        throw error
      }
    }
  } else if (request.operation === 'closeWindow') {
    if (!existing) throw new Error('Desktop-provider close target is unavailable')
    // The service queues the complete detach/attach rehome plan ahead of this
    // terminal CloseWindow operation. Reaching this branch with native ownership
    // proves that plan is incomplete and must fail closed.
    await closeTransferredProviderWindow(windowRegistry, existing)
  } else if (request.operation === 'focusWindow') {
    if (!existing) throw new Error('Desktop-provider focus target is unavailable')
    focusProviderWindow(existing)
  } else if (request.operation === 'recoverOwnership') {
    await recoverProviderOwnership(windowRegistry, request, signal, {
      takeSuspendedBrowser: (resourceId, sourceWindowId) => {
        const suspended = suspendedBrowserTransfers.get(resourceId)
        if (!suspended || suspended.sourceWindowId !== sourceWindowId) return undefined
        suspendedBrowserTransfers.delete(resourceId)
        return suspended
      },
      takeSuspendedTerminal: (resourceId, sourceWindowId) => {
        const suspended = suspendedTerminalTransfers.get(resourceId)
        if (!suspended || suspended.sourceWindowId !== sourceWindowId) return undefined
        suspendedTerminalTransfers.delete(resourceId)
        return suspended
      }
    })
  } else if (request.operation === 'attachOwnership') {
    if (!existing || !request.runtimeSessionId || request.transferEpoch === undefined) {
      throw new Error('Desktop-provider attachment target is unavailable')
    }
    await windowRegistry.transferOwnership(
      request.runtimeSessionId,
      request.transferEpoch,
      request.operation,
      existing.windowId,
      async () => {
        if (request.ownershipKind === 'browser') {
          const browser = request.browser
          if (
            !browser ||
            browser.browserSessionId !== request.runtimeSessionId ||
            !request.tabId ||
            !request.workspaceId ||
            !request.paneId
          ) {
            throw new Error('Desktop-provider browser attachment is invalid')
          }
          const suspended = suspendedBrowserTransfers.get(request.runtimeSessionId)
          try {
            await existing.binding.browserViews.mountTransferred({
              workspaceId: request.workspaceId,
              paneId: request.paneId,
              tabId: request.tabId,
              browserSessionId: browser.browserSessionId,
              lifecycleId: browser.lifecycleId,
              profilePartition: browser.profilePartition,
              stateRevision: browser.stateRevision,
              title: browser.title,
              url: browser.url
            })
            suspended?.source.destroyOwnedSession(request.runtimeSessionId)
            suspendedBrowserTransfers.delete(request.runtimeSessionId)
          } catch (error) {
            suspended?.rollback()
            suspendedBrowserTransfers.delete(request.runtimeSessionId)
            throw error
          }
          return
        }
        const suspended = suspendedTerminalTransfers.get(request.runtimeSessionId!)
        try {
          await (existing.binding as DesktopWindowBinding).client.attachTerminal(
            request.runtimeSessionId!
          )
          for (const entry of windowRegistry.list()) {
            entry.terminalAttachments.delete(request.runtimeSessionId!)
          }
          existing.terminalAttachments.add(request.runtimeSessionId!)
          suspendedTerminalTransfers.delete(request.runtimeSessionId!)
        } catch (error) {
          await suspended?.rollback().catch(() => undefined)
          suspendedTerminalTransfers.delete(request.runtimeSessionId!)
          throw error
        }
      }
    )
  } else if (request.operation === 'detachOwnership') {
    if (!existing || !request.runtimeSessionId || request.transferEpoch === undefined) {
      throw new Error('Desktop-provider detachment target is unavailable')
    }
    await windowRegistry.transferOwnership(
      request.runtimeSessionId,
      request.transferEpoch,
      request.operation,
      existing.windowId,
      async () => {
        if (request.ownershipKind === 'browser') {
          if (!existing.binding.browserViews.ownsSession(request.runtimeSessionId!)) return
          suspendedBrowserTransfers.get(request.runtimeSessionId!)?.rollback()
          suspendedBrowserTransfers.set(request.runtimeSessionId!, {
            sourceWindowId: existing.windowId,
            source: existing.binding.browserViews,
            rollback: existing.binding.browserViews.suspendOwnedSession(request.runtimeSessionId!)
          })
          return
        }
        await (existing.binding as DesktopWindowBinding).client.detachTerminal(
          request.runtimeSessionId!
        )
        existing.terminalAttachments.delete(request.runtimeSessionId!)
        suspendedTerminalTransfers.set(request.runtimeSessionId!, {
          sourceWindowId: existing.windowId,
          rollback: async () => {
            const source = windowRegistry.get(existing.windowId)
            if (!source) return
            await (source.binding as DesktopWindowBinding).client.attachTerminal(
              request.runtimeSessionId!
            )
            source.terminalAttachments.add(request.runtimeSessionId!)
          }
        })
      }
    )
  }
  if (request.operation !== 'closeWindow') {
    const completed = windowRegistry.get(request.target.windowId)
    if (!completed || completed.generation !== request.target.generation) {
      if (request.operation === 'createWindow') {
        windowRegistry.failWindowActivation(
          request.target.windowId,
          'Desktop-provider target generation changed during window creation'
        )
      }
      throw new Error('Desktop-provider target generation changed during execution')
    }
  }
  return {
    requestId: request.requestId,
    correlationId: request.correlationId,
    attemptEpoch: request.attemptEpoch,
    status: 'succeeded'
  }
}

async function start(): Promise<void> {
  const rendererRoot = join(import.meta.dirname, '../renderer')
  protocol.handle(RENDERER_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    const assetPath = resolveRendererAsset(rendererRoot, request.url)
    if (!assetPath) return new Response('Not found', { status: 404 })
    try {
      return await net.fetch(pathToFileURL(assetPath).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  const userData = app.getPath('userData')
  let feeds = null
  try {
    feeds = parseUpdateFeedConfiguration(process.env)
  } catch {
    console.warn('Desktop update feeds are invalid; updates are disabled')
  }
  const { autoUpdater } = electronUpdater
  updateController = new UpdateController({
    feeds,
    isPackaged: app.isPackaged,
    packageType: detectNativeUpdatePackageType(process.platform, {
      resourcesPath: process.resourcesPath,
      ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE })
    }),
    platform: process.platform,
    updater: autoUpdater,
    // Updater-owned quit emits before-quit, where the normal quit orchestrator performs the
    // irreversible teardown. This hook must remain safe to return from if quitAndInstall throws.
    beforeInstall: async () => {
      await Promise.all(windowRegistry.list().map(({ binding }) => binding.stateController.flush()))
    }
  })
  stopUpdateForwarding = registerSenderBoundDesktopUpdateHandlers(
    senderBoundIpc,
    windowRegistry,
    updateController
  )
  const tokenPath = join(userData, 'secrets', 'control-token.enc')
  const tokenCipher = createTokenCipher()
  if (!tokenCipher.isSecure()) {
    console.warn(
      'Secure credential storage is unavailable; the control token will remain session-only'
    )
  }
  const token = await new ControlTokenStore(tokenPath, tokenCipher).loadOrCreate()
  const endpoint = resolveControlEndpoint(app.isPackaged)
  const cliSessionFilePath =
    process.platform === 'win32'
      ? join(userData, 'runtime', CLI_SESSION_FILE_NAME)
      : join(dirname(endpoint), CLI_SESSION_FILE_NAME)
  const servicePath = resolveServicePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    workingDirectory: process.cwd()
  })

  supervisor = new ServiceSupervisor(endpoint, token, servicePath, {
    stateDatabasePath: join(userData, 'state', 'workspace.sqlite'),
    configurationPath: join(userData, 'configuration', 'desktop.json'),
    logDirectoryPath: join(userData, 'logs'),
    defaultWorkingDirectory: app.getPath('home'),
    cliSessionFilePath
  })
  lifecycle = new LifecycleController(supervisor, {
    bind: bindReadyClient,
    unbind: unbindReadyClient
  })
  registerDesktopLifecycleHandlers(senderBoundIpc, lifecycle, supervisor, {
    downloadsDirectory: app.getPath('downloads'),
    quit: () => app.quit(),
    configurationChanged: (channel) => updateController?.applyChannel(channel)
  })
  await lifecycle.initialize()
  await createInitialWindowForCurrentState()
}

async function performExitCleanup(): Promise<void> {
  await performApplicationExitCleanup({
    flushWindowState: () =>
      Promise.all(windowRegistry.list().map(({ binding }) => binding.stateController.flush())).then(
        () => undefined
      ),
    logStage: (stage) => console.info(`[shutdown] stage=${stage}`),
    stopService: () => supervisor?.stop(),
    reconcileShutdownFailure: () => lifecycle?.reconcileShutdownFailure(),
    commitTeardown: async () => {
      // Keep the live bindings usable until the service has been confirmed stopped. If a later
      // local teardown fails, quitting remains fail-closed even though the service is already safe.
      applicationMenu.prepareForApplicationQuit()
      stopUpdateForwarding?.()
      stopUpdateForwarding = undefined
      await unbindReadyClient()
      senderBoundIpc.dispose()
      await windowRegistry.dispose()
      await lifecycle?.dispose()
    }
  })
}

const quitOrchestrator = new ApplicationQuitOrchestrator({
  cleanup: performExitCleanup,
  logFailure: (message) => console.error(message),
  quit: () => app.quit()
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    void windowCreationEntrypoints.secondInstance((window) => {
      if (window.isMinimized()) window.restore()
      window.focus()
    })
  })

  app.on('before-quit', (event) => {
    quitOrchestrator.beforeQuit(event)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.once('will-quit', () => updateController?.dispose())

  app.on('activate', () => {
    void windowCreationEntrypoints.activate()
  })

  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) =>
      windowCreationEntrypoints.recoverStartup(
        error,
        lifecycle !== undefined && supervisor !== undefined
      )
    )
}
