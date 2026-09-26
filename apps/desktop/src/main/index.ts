import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { promisify } from 'node:util'

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
  advancedTabMutationResultSchema,
  configurationGetResultSchema,
  diagnosticBundlePreviewSchema,
  focusHistoryNavigateResultSchema,
  recoveryExportResultSchema,
  isSafeExternalUrl,
  taskListParamsSchema,
  tabMoveExactParamsSchema,
  tabDetachParamsSchema,
  windowMutationResultSchema,
  windowStateGetResultSchema,
  type WindowStateSnapshot,
  type DesktopProviderAcknowledgeParams,
  type DesktopProviderIdentityParams,
  type DesktopProviderRequest,
  type WindowCloseParams,
  type WorkspaceSnapshotResult
} from '@agent-workspace/protocol-client'
import type { DesktopLifecycleState } from '@agent-workspace/contracts/desktop/desktop-bridge'
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
import { WindowRegistry, type WindowRegistryEntry } from './window-registry'
import { SenderBoundIpcRouter } from './sender-bound-ipc-router'
import { invalidateProviderWindowBindings } from './provider-loss-cleanup'
import { closeTransferredProviderWindow, focusProviderWindow } from './provider-window-operations'
import { ProviderRecoveryCoordinator } from './provider-recovery-coordinator'
import { ProviderPollingGate } from './provider-polling-gate'
import { recoverProviderOwnership } from './provider-ownership-recovery'
import { DESKTOP_IPC } from '@agent-workspace/contracts/desktop/desktop-bridge'
import { reloadRendererAfterCrash } from './renderer-crash-reloader'
import { runtimeResourceIds } from './renderer-ownership-reconciliation'
import { shouldRequestServiceWindowClose } from './window-close-policy'
import { DesktopProviderClaims } from './desktop-provider-claims'
import { NodeSidecar } from './node-sidecar'
import { NodeCopyDiagnostics } from './node-copy-diagnostics'
import { matchesNodeCopyBase } from './node-copy-topology'
import { rehomeNodeBrowsers } from './node-window-browser-rehome'
import { moveNodeBrowserTab } from './node-tab-browser-move'

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
let nodeSidecar: NodeSidecar | undefined
let nodeCoreDemoReady = false
let nativeNodeDesktop = false
let nativeLifecycleState: DesktopLifecycleState = { status: 'starting' }
let nativeRestartOperation: Promise<void> | undefined
const execFileAsync = promisify(execFile)
/** Native placements created only in the isolated copy must never enter Rust provider claims. */
const nodeOnlyWindowIds = new Set<string>()
const nativeRecoveryWindowIds = new Set<string>()
let readyBindingOperation: Promise<void> = Promise.resolve()
let terminalCleanupDuringQuit = false
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
const windowRegistry = new WindowRegistry((windowId) => {
  stopNodeHostingForWindow(windowId)
  const sidecar = nodeSidecar
  if (sidecar) void sidecar.revokeWindowCapabilities(windowId).catch(() => undefined)
})
const nodeAutomationProviders = new Map<
  string,
  {
    generation: number
    sidecar: NodeSidecar
    profileKey: string
    browserViews: BrowserViewManager
    provider: BrowserAutomationProvider
    manager: BrowserAutomationManager
    identity: DesktopProviderIdentityParams
  }
>()
const nodeHostingClaims = new Map<
  string,
  {
    entry: WindowRegistryEntry
    sidecar: NodeSidecar
    timer?: NodeJS.Timeout
    pending: boolean
    registration: Promise<void>
  }
>()

function stopNodeHostingForWindow(windowId: string): void {
  const claim = nodeHostingClaims.get(windowId)
  if (claim) {
    nodeHostingClaims.delete(windowId)
    if (claim.timer) clearInterval(claim.timer)
    void claim.sidecar
      .reconcileHostingForTrustedOwner('revokeHosting', windowId, claim.entry.generation)
      .catch(() => undefined)
  }
  stopNodeAutomationForWindow(windowId, 'Node hosting stopped')
}

function stopNodeAutomationForWindow(windowId: string, reason: string): void {
  cancelNodeAutomationRecovery(windowId)
  const active = nodeAutomationProviders.get(windowId)
  if (!active) return
  nodeAutomationProviders.delete(windowId)
  void Promise.allSettled([
    active.provider.stop(reason),
    active.sidecar.revokeAutomationProviderForTrustedOwner(
      windowId,
      active.generation,
      active.identity
    )
  ])
}

function startNodeHostingForWindow(
  entry: WindowRegistryEntry,
  sidecar: NodeSidecar
): Promise<void> {
  const previous = nodeHostingClaims.get(entry.windowId)
  if (previous?.entry === entry && previous.sidecar === sidecar) return previous.registration
  if (previous) stopNodeHostingForWindow(entry.windowId)
  const claim = { entry, sidecar, pending: false } as {
    entry: WindowRegistryEntry
    sidecar: NodeSidecar
    timer?: NodeJS.Timeout
    pending: boolean
    registration: Promise<void>
  }
  const current = () =>
    nodeSidecar === sidecar &&
    windowRegistry.get(entry.windowId) === entry &&
    !entry.window.isDestroyed()
  if (!current()) return Promise.reject(new Error('The Node hosting window changed'))
  nodeHostingClaims.set(entry.windowId, claim)
  claim.registration = sidecar
    .reconcileHostingForTrustedOwner('registerHosting', entry.windowId, entry.generation)
    .then(() => {
      if (!current()) {
        if (nodeHostingClaims.get(entry.windowId) === claim)
          stopNodeHostingForWindow(entry.windowId)
        return
      }
      claim.timer = setInterval(() => {
        if (!current()) {
          if (nodeHostingClaims.get(entry.windowId) === claim)
            stopNodeHostingForWindow(entry.windowId)
          return
        }
        if (claim.pending) return
        claim.pending = true
        void sidecar
          .reconcileHostingForTrustedOwner('heartbeatHosting', entry.windowId, entry.generation)
          .then(() => {
            if (!current() && nodeHostingClaims.get(entry.windowId) === claim)
              stopNodeHostingForWindow(entry.windowId)
          })
          .catch(() => {
            if (nodeHostingClaims.get(entry.windowId) === claim)
              stopNodeHostingForWindow(entry.windowId)
          })
          .finally(() => {
            claim.pending = false
          })
      }, 5_000)
      claim.timer.unref()
    })
    .catch((error) => {
      if (nodeHostingClaims.get(entry.windowId) === claim) stopNodeHostingForWindow(entry.windowId)
      throw error
    })
  return claim.registration
}
const nodeAutomationStarts = new Map<string, Promise<void>>()
interface NodeAutomationRecoveryContext {
  readonly entry: WindowRegistryEntry
  readonly sidecar: NodeSidecar
  readonly profileKey: string
  readonly browserViews: BrowserViewManager
}
const nodeAutomationRecovery = new Map<
  string,
  ProviderRecoveryCoordinator<NodeAutomationRecoveryContext>
>()
const nodeBrowserViews = new Map<string, BrowserViewManager>()
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
  isNodeCoreEnabled: () => nodeCoreDemoReady,
  isNodeConfigurationEnabled: () =>
    nodeCoreDemoReady && nodeSidecar?.configurationWritable === true,
  isNodeRemoteEnabled: () =>
    nodeCoreDemoReady &&
    (nativeNodeDesktop || process.env.AGENT_WORKSPACE_DESKTOP_NODE_REMOTE_DEMO === '1'),
  isNodeRemoteEnrollmentEnabled: () =>
    nodeCoreDemoReady && nodeSidecar?.remoteEnrollmentEnabled === true,
  isNodeRemoteReplacementEnabled: () =>
    nodeCoreDemoReady && nodeSidecar?.remoteReplacementEnabled === true,
  isNodeRemoteDeletionEnabled: () =>
    nodeCoreDemoReady && nodeSidecar?.remoteDeletionEnabled === true,
  isNodeAgentAssessmentEnabled: () =>
    nodeCoreDemoReady && nodeSidecar?.agentAssessmentEnabled === true,
  isNodeAgentRegistrationEnabled: () =>
    nodeCoreDemoReady && nodeSidecar?.agentRegistrationEnabled === true,
  isNodeAgentForkEnabled: () => nodeCoreDemoReady && nodeSidecar?.agentForkEnabled === true,
  isNodeRecentlyClosedEnabled: () =>
    nodeCoreDemoReady && nodeSidecar?.recentlyClosedEnabled === true,
  isNodeTaskListEnabled: () =>
    nodeCoreDemoReady &&
    (nativeNodeDesktop || process.env.AGENT_WORKSPACE_DESKTOP_NODE_TASK_LIST === '1') &&
    nodeSidecar?.taskListEnabled === true,
  isNodeTaskDetachEnabled: () =>
    nodeCoreDemoReady &&
    (nativeNodeDesktop || process.env.AGENT_WORKSPACE_DESKTOP_NODE_TASK_LIST === '1') &&
    nodeSidecar?.taskActionsEnabled === true,
  isNodeEncryptedSearchEnabled: () =>
    nodeCoreDemoReady && nodeSidecar?.encryptedSearchEnabled === true,
  issueNodeSearchExportConfirmation: (params) => {
    if (!nodeCoreDemoReady || !nodeSidecar?.encryptedSearchEnabled)
      throw new Error('Encrypted search is unavailable in this Node sidecar')
    return nodeSidecar.issueSearchExportConfirmation(params)
  },
  exportNodeSearchSource: (params) => {
    if (!nodeCoreDemoReady || !nodeSidecar?.encryptedSearchEnabled)
      throw new Error('Encrypted search is unavailable in this Node sidecar')
    return nodeSidecar.exportSearchSource(params)
  },
  invokeNodeCore: (entry, channel, args) => {
    const sidecar = nodeSidecar
    if (!sidecar || !nodeCoreDemoReady) return undefined
    if (windowRegistry.get(entry.windowId) !== entry || entry.window.isDestroyed()) {
      throw new Error('The Node core window changed')
    }
    return sidecar.invokeDesktopCore(
      entry.windowId,
      channel,
      args,
      (terminalEvent) => {
        if (windowRegistry.get(entry.windowId) === entry && !entry.window.isDestroyed()) {
          entry.window.webContents.send(DESKTOP_IPC.terminalEvent, terminalEvent)
        }
      },
      {
        views: () => entry.binding.browserViews,
        isCurrent: () =>
          nodeSidecar === sidecar &&
          nodeCoreDemoReady &&
          windowRegistry.get(entry.windowId) === entry &&
          !entry.window.isDestroyed(),
        senderCurrent: () =>
          windowRegistry.get(entry.windowId) === entry && !entry.window.isDestroyed(),
        shuttingDown: () => quitOrchestrator.isQuitStarted(),
        emitDomainEvent: (event) => {
          if (
            nodeSidecar !== sidecar ||
            !nodeCoreDemoReady ||
            windowRegistry.get(entry.windowId) !== entry ||
            entry.window.isDestroyed()
          )
            return
          entry.window.webContents.send(DESKTOP_IPC.domainEvent, event)
        },
        automationActive: () => {
          const automation = nodeAutomationProviders.get(entry.windowId)
          return Boolean(
            automation?.generation === entry.generation &&
            automation.sidecar === sidecar &&
            automation.manager.hasAttachedSessions()
          )
        },
        attachedTerminalIds: () => [...entry.terminalAttachments],
        reconcileRendererOwnership: (liveResourceIds) =>
          windowRegistry.reconcileRendererOwnership(entry.windowId, liveResourceIds),
        contentWidth: () => {
          if (windowRegistry.get(entry.windowId) !== entry || entry.window.isDestroyed()) {
            throw new Error('The Node sidebar window changed')
          }
          return entry.window.getContentBounds().width
        },
        chooseLayoutExportPath: async (layoutId) => {
          if (
            nodeSidecar !== sidecar ||
            !nodeCoreDemoReady ||
            windowRegistry.get(entry.windowId) !== entry ||
            entry.window.isDestroyed()
          ) {
            throw new Error('The Node layout window changed')
          }
          const chosen = await dialog.showSaveDialog(entry.window, {
            title: 'Export saved layout',
            defaultPath: `${layoutId}.workspace-layout.json`,
            filters: [{ name: 'Workspace layout', extensions: ['json'] }]
          })
          if (
            nodeSidecar !== sidecar ||
            !nodeCoreDemoReady ||
            windowRegistry.get(entry.windowId) !== entry ||
            entry.window.isDestroyed()
          ) {
            throw new Error('The Node layout window changed')
          }
          return chosen.canceled ? null : chosen.filePath || null
        },
        chooseLayoutImportPath: async () => {
          if (
            nodeSidecar !== sidecar ||
            !nodeCoreDemoReady ||
            windowRegistry.get(entry.windowId) !== entry ||
            entry.window.isDestroyed()
          ) {
            throw new Error('The Node layout window changed')
          }
          const chosen = await dialog.showOpenDialog(entry.window, {
            title: 'Import saved layout',
            buttonLabel: 'Import layout',
            properties: ['openFile'],
            filters: [{ name: 'Workspace layout', extensions: ['json'] }]
          })
          if (
            nodeSidecar !== sidecar ||
            !nodeCoreDemoReady ||
            windowRegistry.get(entry.windowId) !== entry ||
            entry.window.isDestroyed()
          ) {
            throw new Error('The Node layout window changed')
          }
          return chosen.canceled || chosen.filePaths.length !== 1 ? null : chosen.filePaths[0]!
        },
        waitForOwnershipTransfer: (browserSessionId) =>
          windowRegistry.waitForOwnershipTransfer(browserSessionId, entry.windowId),
        ownershipAcquired: (browserSessionId) =>
          windowRegistry.recordRendererOwnership(browserSessionId, entry.windowId),
        browserDetached: (browserSessionId) =>
          windowRegistry.forgetRendererOwnership(browserSessionId, entry.windowId),
        terminalDetached: (terminalId) => entry.terminalAttachments.delete(terminalId)
      },
      {
        confirm: async ({ title, message, detail, cancel, accept }) => {
          const choice = await dialog.showMessageBox(entry.window, {
            type: 'warning',
            buttons: [cancel, accept],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            title,
            message,
            detail
          })
          return choice.response === 1
        },
        isCurrent: () =>
          nodeSidecar === sidecar &&
          nodeCoreDemoReady &&
          windowRegistry.get(entry.windowId) === entry &&
          !entry.window.isDestroyed(),
        pickCredential: async () => {
          const chosen = await dialog.showOpenDialog(entry.window, {
            title: 'Choose an unencrypted Ed25519 OpenSSH private key',
            buttonLabel: 'Use SSH key',
            properties: ['openFile', 'dontAddToRecent']
          })
          if (chosen.canceled || chosen.filePaths.length !== 1 || !chosen.filePaths[0]) return null
          if (
            nodeSidecar !== sidecar ||
            !nodeCoreDemoReady ||
            windowRegistry.get(entry.windowId) !== entry ||
            entry.window.isDestroyed()
          ) {
            throw new Error('The remote target window changed')
          }
          return open(chosen.filePaths[0], constants.O_RDONLY | constants.O_NOFOLLOW)
        }
      }
    )
  },
  serializeResource: (resourceId, operation) => windowRegistry.transfer(resourceId, operation),
  terminalAttached: (windowId, terminalId) =>
    windowRegistry.get(windowId)?.terminalAttachments.add(terminalId),
  terminalDetached: (windowId, terminalId) =>
    windowRegistry.get(windowId)?.terminalAttachments.delete(terminalId),
  isTerminalCleanupDuringQuit: () => terminalCleanupDuringQuit,
  ownershipAcquired: (windowId, resourceId) =>
    windowRegistry.recordRendererOwnership(resourceId, windowId),
  waitForOwnershipTransfer: (windowId, resourceId) =>
    windowRegistry.waitForOwnershipTransfer(resourceId, windowId),
  waitForWindowActivation: (entry) => windowRegistry.waitForWindowActivation(entry),
  isWindowEntryCurrent: (entry) => windowRegistry.get(entry.windowId) === entry,
  resolveNodeWorkspacePath: async (entry, workspaceId) => {
    const sidecar = nodeSidecar
    if (
      !nodeCoreDemoReady ||
      !sidecar ||
      windowRegistry.get(entry.windowId) !== entry ||
      entry.window.isDestroyed()
    ) {
      throw new Error('The Node workspace owner changed')
    }
    const { snapshot } = await sidecar.listWorkspacesForTrustedOwner(entry.windowId)
    if (
      !nodeCoreDemoReady ||
      nodeSidecar !== sidecar ||
      windowRegistry.get(entry.windowId) !== entry ||
      entry.window.isDestroyed()
    ) {
      throw new Error('The Node workspace owner changed')
    }
    const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId)
    if (!workspace) throw new Error('The workspace is not hosted by this window')
    return workspace.workingDirectory
  },
  isNodeTaskListSelected: () =>
    nativeNodeDesktop || process.env.AGENT_WORKSPACE_DESKTOP_NODE_TASK_LIST === '1',
  listTasksFromNodeSidecar: (entry, request) => {
    const sidecar = nodeSidecar
    // A sidecar probe may be backed by a different disposable state copy, whose
    // window IDs do not belong to this renderer. Keep the Rust path until the
    // test explicitly binds the same hosted window in both stores.
    if (
      !sidecar ||
      !nodeCoreDemoReady ||
      (!nativeNodeDesktop && process.env.AGENT_WORKSPACE_DESKTOP_NODE_TASK_LIST !== '1')
    ) {
      return undefined
    }
    if (windowRegistry.get(entry.windowId) !== entry || entry.window.isDestroyed()) {
      throw new Error('The task list window changed')
    }
    return sidecar
      .listTasksForTrustedOwner(entry.windowId, taskListParamsSchema.parse(request))
      .then((result) => {
        if (
          nodeSidecar !== sidecar ||
          windowRegistry.get(entry.windowId) !== entry ||
          entry.window.isDestroyed()
        ) {
          throw new Error('The task list window changed')
        }
        return result
      })
  },
  detachRemoteTaskFromNodeSidecar: (entry, request) => {
    const sidecar = nodeSidecar
    if (
      !sidecar ||
      !nodeCoreDemoReady ||
      !sidecar.taskActionsEnabled ||
      (!nativeNodeDesktop && process.env.AGENT_WORKSPACE_DESKTOP_NODE_TASK_LIST !== '1')
    ) {
      return undefined
    }
    if (windowRegistry.get(entry.windowId) !== entry || entry.window.isDestroyed()) {
      throw new Error('The task action window changed')
    }
    return sidecar.detachRemoteTaskForTrustedOwner(entry.windowId, request).then((result) => {
      if (
        nodeSidecar !== sidecar ||
        windowRegistry.get(entry.windowId) !== entry ||
        entry.window.isDestroyed()
      ) {
        throw new Error('The task action window changed')
      }
      return result
    })
  },
  actOnNodeTaskFromSidecar: (entry, request, confirm) => {
    const sidecar = nodeSidecar
    if (!nodeCoreDemoReady || !sidecar?.taskActionsEnabled) return undefined
    if (windowRegistry.get(entry.windowId) !== entry || entry.window.isDestroyed()) {
      throw new Error('The task action window changed')
    }
    return sidecar
      .actOnTaskForTrustedOwner(entry.windowId, entry.generation, request, async () => {
        if (
          !nodeCoreDemoReady ||
          nodeSidecar !== sidecar ||
          windowRegistry.get(entry.windowId) !== entry ||
          entry.window.isDestroyed()
        ) {
          throw new Error('The task action window changed')
        }
        return confirm()
      })
      .then((result) => {
        if (
          !nodeCoreDemoReady ||
          nodeSidecar !== sidecar ||
          windowRegistry.get(entry.windowId) !== entry ||
          entry.window.isDestroyed()
        ) {
          throw new Error('The task action window changed')
        }
        return result
      })
  },
  isApplicationGlobalLayoutAvailable: () => windowRegistry.size <= 1,
  getDesktopProviderIdentity: () => desktopProviderIdentity,
  getNodeAgentHibernationContext: (entry) => {
    const sidecar = nodeSidecar
    const automation = nodeAutomationProviders.get(entry.windowId)
    const isCurrent = () =>
      nodeCoreDemoReady &&
      nodeSidecar === sidecar &&
      windowRegistry.get(entry.windowId) === entry &&
      !entry.window.isDestroyed() &&
      nodeHostingClaims.get(entry.windowId)?.entry === entry &&
      nodeHostingClaims.get(entry.windowId)?.sidecar === sidecar &&
      nodeAutomationProviders.get(entry.windowId) === automation &&
      automation?.generation === entry.generation &&
      automation.sidecar === sidecar &&
      !closingWindowIds.has(entry.windowId) &&
      !quitOrchestrator.isQuitStarted()
    if (!sidecar?.agentHibernationEnabled || !automation || !isCurrent()) return undefined
    return {
      client: sidecar.agentHibernationClientForTrustedOwner(entry.windowId),
      provider: automation.identity,
      isCurrent
    }
  },
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
registerMultiWindowDesktopHandlers(
  senderBoundIpc,
  () => nodeCoreDemoReady,
  async (entry) => {
    const sidecar = nodeSidecar
    if (
      !nodeCoreDemoReady ||
      !sidecar ||
      windowRegistry.get(entry.windowId) !== entry ||
      entry.window.isDestroyed()
    ) {
      throw new Error('The Node window owner changed')
    }
    const topology = await sidecar.listWindowsForTrustedOwner(entry.windowId)
    if (
      !nodeCoreDemoReady ||
      nodeSidecar !== sidecar ||
      windowRegistry.get(entry.windowId) !== entry ||
      entry.window.isDestroyed()
    ) {
      throw new Error('The Node window owner changed')
    }
    return topology
  },
  {
    create: async (entry, params) => {
      const sidecar = nodeSidecar
      const rustClient = lifecycle?.getClient()
      if (
        !nodeCoreDemoReady ||
        !sidecar ||
        (!rustClient && !nativeNodeDesktop) ||
        windowRegistry.get(entry.windowId) !== entry ||
        entry.window.isDestroyed()
      )
        throw new Error('The Node window owner changed')
      const projection = await sidecar.client.listWorkspaces()
      const moved = projection.snapshot.workspaces.find(({ id }) => id === params.workspaceId)
      if (!moved) throw new Error('The Node workspace is unavailable')
      const current = (): void => {
        if (
          !nodeCoreDemoReady ||
          nodeSidecar !== sidecar ||
          windowRegistry.get(entry.windowId) !== entry ||
          entry.window.isDestroyed()
        )
          throw new Error('The Node window owner changed during creation')
      }
      current()
      const terminalIds = moved.tabs.flatMap((tab) =>
        tab.content.kind === 'terminal' &&
        tab.content.runtimeSessionId &&
        entry.terminalAttachments.has(tab.content.runtimeSessionId)
          ? [tab.content.runtimeSessionId]
          : []
      )
      const remoteIds = moved.tabs.flatMap((tab) =>
        tab.content.kind === 'terminal' &&
        tab.content.runtimeSessionId &&
        sidecar.isRemoteTerminalBinding(tab.content.runtimeSessionId)
          ? [tab.content.runtimeSessionId]
          : []
      )
      for (const tab of moved.tabs) {
        if (tab.content.kind !== 'terminal' || !tab.content.runtimeSessionId) continue
        const id = tab.content.runtimeSessionId
        if (
          !sidecar.isRemoteTerminalBinding(id) &&
          sidecar.localTerminalSocketOwner(id) !==
            (entry.terminalAttachments.has(id) ? entry.windowId : undefined)
        )
          throw new Error('The Node terminal socket owner changed')
      }
      const movedBrowsers = new Map(
        moved.tabs.flatMap((tab) =>
          tab.content.kind === 'browser' ? [[tab.content.state.browserSessionId, tab] as const] : []
        )
      )
      const browserDescriptors = entry.binding.browserViews
        .ownedTransferDescriptors()
        .filter((descriptor) => descriptor.workspaceId === moved.id)
      for (const id of movedBrowsers.keys()) {
        if (
          windowRegistry
            .list()
            .some((owner) => owner !== entry && owner.binding.browserViews.ownsSession(id))
        )
          throw new Error('The Node browser native owner changed')
      }
      for (const descriptor of browserDescriptors) {
        const tab = movedBrowsers.get(descriptor.browserSessionId)
        if (!tab || tab.id !== descriptor.tabId || tab.paneId !== descriptor.paneId)
          throw new Error('The Node browser native placement changed')
      }
      const terminalTransfer = sidecar.suspendLocalTerminalEvents(
        entry.windowId,
        terminalIds.filter((id) => !sidecar.isRemoteTerminalBinding(id))
      )
      const remoteTransfers: ReturnType<NodeSidecar['suspendRemoteTerminalEvents']>[] = []
      const browserSuspensions: { id: string; resume: () => void }[] = []
      try {
        for (const id of remoteIds)
          remoteTransfers.push(sidecar.suspendRemoteTerminalEvents(entry.windowId, id))
        for (const descriptor of browserDescriptors) {
          current()
          browserSuspensions.push({
            id: descriptor.browserSessionId,
            resume: entry.binding.browserViews.suspendOwnedSession(descriptor.browserSessionId)
          })
        }
      } catch (error) {
        for (const { resume } of browserSuspensions.reverse()) resume()
        for (const transfer of remoteTransfers.reverse()) transfer.rollback()
        terminalTransfer.rollback()
        throw error
      }
      const rollback = (): void => {
        for (const { resume } of browserSuspensions.reverse()) resume()
        for (const transfer of remoteTransfers.reverse()) transfer.rollback()
        terminalTransfer.rollback()
      }
      let result: ReturnType<typeof windowMutationResultSchema.parse> | undefined
      try {
        result = windowMutationResultSchema.parse(
          await sidecar.createWindowForTrustedOwner(entry.windowId, params)
        )
      } catch (error) {
        // A lost response can be recovered with the same idempotency key.
        result = await sidecar
          .createWindowForTrustedOwner(entry.windowId, params)
          .then((value) => windowMutationResultSchema.parse(value))
          .catch(() => undefined)
        if (!result) {
          const topology = await sidecar.client.listWindows().catch(() => undefined)
          const destination = topology?.windows.find((window) =>
            window.workspaceIds.includes(params.workspaceId)
          )
          if (topology && destination && destination.windowId !== entry.windowId) {
            result = windowMutationResultSchema.parse({
              revision: topology.revision,
              idempotencyEpoch: topology.idempotencyEpoch,
              window: destination,
              replayed: true
            })
          } else if (destination?.windowId === entry.windowId) {
            rollback()
            throw error
          } else {
            throw new Error('Node window creation outcome is unknown; resources are quarantined', {
              cause: error
            })
          }
        }
      }
      current()
      nodeOnlyWindowIds.add(result.window.windowId)
      if (!windowRegistry.get(result.window.windowId)) {
        const created = rustClient
          ? await createServicePlacementWindow(rustClient, result.window.windowId)
          : await createNativeNodePlacementWindow(sidecar, result.window.windowId)
        if (nodeSidecar !== sidecar || !nodeCoreDemoReady || created.isDestroyed())
          throw new Error('The Node window owner changed after creation')
      }
      current()
      const target = windowRegistry.get(result.window.windowId)
      if (!target || target.window.isDestroyed())
        throw new Error('The new Node window is unavailable after creation')
      const trustedSnapshot = {
        revision: projection.snapshot.revision,
        workspace: moved
      } as unknown as WorkspaceSnapshotResult
      for (const descriptor of browserDescriptors) {
        await target.binding.browserViews.mountTransferred(descriptor, trustedSnapshot)
      }
      for (const descriptor of browserDescriptors) {
        target.binding.browserViews.activateTransferredSession(descriptor.browserSessionId)
        entry.binding.browserViews.destroyOwnedSession(descriptor.browserSessionId)
        windowRegistry.forgetRendererOwnership(descriptor.browserSessionId, entry.windowId)
        windowRegistry.recordRendererOwnership(descriptor.browserSessionId, target.windowId)
      }
      terminalTransfer.finalize()
      for (const transfer of remoteTransfers) transfer.finalize(target.windowId)
      for (const id of terminalIds) {
        entry.terminalAttachments.delete(id)
        windowRegistry.forgetRendererOwnership(id, entry.windowId)
      }
      entry.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
      entry.window.webContents.send(DESKTOP_IPC.browserViewsRebind)
      target.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
      target.window.webContents.send(DESKTOP_IPC.browserViewsRebind)
      target.window.focus()
      return result
    },
    focus: async (entry, params) => {
      const sidecar = nodeSidecar
      if (
        !nodeCoreDemoReady ||
        !sidecar ||
        windowRegistry.get(entry.windowId) !== entry ||
        entry.window.isDestroyed()
      )
        throw new Error('The Node window owner changed')
      const target = windowRegistry.get(params.window.windowId)
      if (!target || target.window.isDestroyed())
        throw new Error('The Node focus target is unhosted')
      const result = await sidecar.focusWindowForTrustedOwner(entry.windowId, params)
      if (target.window.isMinimized()) target.window.restore()
      target.window.focus()
      if (!result.replayed) {
        target.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
        if (target !== entry) entry.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
      }
      return result
    },
    close: async (entry, params) => {
      const sidecar = nodeSidecar
      if (
        !nodeCoreDemoReady ||
        !sidecar ||
        windowRegistry.get(entry.windowId) !== entry ||
        entry.window.isDestroyed()
      )
        throw new Error('The Node window owner changed')
      if (params.policy === 'closeWorkspaces') {
        if (!nodeOnlyWindowIds.has(entry.windowId))
          throw new Error('Rust base window deletion requires reconciliation')
        return closeNodeWindowWorkspaces(sidecar, entry, params)
      }
      if (!params.rehomeTarget) throw new Error('Node window close policy is invalid')
      const target = windowRegistry.get(params.rehomeTarget.windowId)
      if (!target || target.window.isDestroyed())
        throw new Error('The Node rehome target is unhosted')
      return closeNodeWindowPlacement(sidecar, entry, target, params)
    },
    closeTab: async (entry, params) => {
      const sidecar = nodeSidecar
      if (
        !nodeCoreDemoReady ||
        !sidecar ||
        windowRegistry.get(entry.windowId) !== entry ||
        entry.window.isDestroyed()
      )
        throw new Error('The Node window owner changed')
      return sidecar.closeTabForTrustedOwner(
        entry.windowId,
        params,
        entry.binding.browserViews,
        (browserSessionId) =>
          windowRegistry.forgetRendererOwnership(browserSessionId, entry.windowId),
        (terminalId) => entry.terminalAttachments.delete(terminalId)
      )
    },
    listClosedItems: async (entry) => {
      const sidecar = nodeSidecar
      if (!nodeCoreDemoReady || !sidecar || windowRegistry.get(entry.windowId) !== entry)
        throw new Error('The Node window owner changed')
      return sidecar.listClosedItemsForTrustedOwner(entry.windowId)
    },
    getClosedItem: async (entry, params) => {
      const sidecar = nodeSidecar
      if (!nodeCoreDemoReady || !sidecar || windowRegistry.get(entry.windowId) !== entry)
        throw new Error('The Node window owner changed')
      return sidecar.getClosedItemForTrustedOwner(entry.windowId, params.closedItemId)
    },
    reopenTab: async (entry, params) => {
      const sidecar = nodeSidecar
      if (!nodeCoreDemoReady || !sidecar || windowRegistry.get(entry.windowId) !== entry)
        throw new Error('The Node window owner changed')
      return sidecar.reopenTabForTrustedOwner(entry.windowId, params)
    },
    duplicateTab: async (entry, params) => {
      const sidecar = nodeSidecar
      if (!nodeCoreDemoReady || !sidecar || windowRegistry.get(entry.windowId) !== entry)
        throw new Error('The Node window owner changed')
      const destination = windowRegistry.get(params.target.windowId)
      if (!destination || destination.window.isDestroyed())
        throw new Error('The Node tab target window is unavailable')
      const result = advancedTabMutationResultSchema.parse(
        await sidecar.duplicateTabForTrustedOwner(entry.windowId, params)
      )
      if (!result.replayed) {
        destination.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
        if (destination !== entry) entry.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
      }
      return result
    },
    moveTabExact: async (entry, params) => moveNodeTabExact(entry, params),
    detachTab: async (entry, params) => detachNodeTab(entry, params),
    navigateFocusHistory: async (entry, params) => {
      const sidecar = nodeSidecar
      if (!nodeCoreDemoReady || !sidecar || windowRegistry.get(entry.windowId) !== entry)
        throw new Error('The Node window owner changed')
      const result = focusHistoryNavigateResultSchema.parse(
        await sidecar.navigateFocusHistoryForTrustedOwner(entry.windowId, params)
      )
      const target = windowRegistry.get(result.target.windowId)
      if (!target || target.window.isDestroyed())
        throw new Error('The Node focus target is unavailable')
      if (target.window.isMinimized()) target.window.restore()
      target.window.focus()
      if (!result.replayed) {
        target.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
        if (target !== entry) entry.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
      }
      return result
    }
  }
)
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

async function closeNodeWindowWorkspaces(
  sidecar: NodeSidecar,
  source: WindowRegistryEntry,
  params: WindowCloseParams
) {
  const current = () => {
    if (
      !nodeCoreDemoReady ||
      nodeSidecar !== sidecar ||
      windowRegistry.get(source.windowId) !== source ||
      source.window.isDestroyed()
    )
      throw new Error('The Node window owner changed during close')
  }
  current()
  const topology = await sidecar.listWindowsForTrustedOwner(source.windowId)
  current()
  const placement = topology.windows.find(({ windowId }) => windowId === source.windowId)
  if (
    !placement ||
    placement.revision !== params.window.expectedRevision ||
    topology.revision !== params.mutation.expectedRevision ||
    topology.idempotencyEpoch !== params.mutation.idempotencyEpoch
  )
    throw new Error('The Node window close projection changed')
  const { snapshot } = await sidecar.client.listWorkspaces()
  current()
  if (snapshot.revision !== topology.revision)
    throw new Error('The Node workspace projection changed')
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]))
  const browserIds = placement.workspaceIds.flatMap((id) =>
    (workspaces.get(id)?.tabs ?? []).flatMap((tab) =>
      tab.content.kind === 'browser' ? [tab.content.state.browserSessionId] : []
    )
  )
  const terminalIds = placement.workspaceIds.flatMap((id) =>
    (workspaces.get(id)?.tabs ?? []).flatMap((tab) =>
      tab.content.kind === 'terminal' && tab.content.runtimeSessionId
        ? [tab.content.runtimeSessionId]
        : []
    )
  )
  if ([...source.terminalAttachments].some((id) => !terminalIds.includes(id)))
    throw new Error('The Node terminal attachments changed during close')
  let result: Awaited<ReturnType<NodeSidecar['closeWindowForTrustedOwner']>>
  try {
    result = await sidecar.closeWindowForTrustedOwner(source.windowId, params)
  } catch (error) {
    const [latest, state] = await Promise.all([
      sidecar.client.listWindows().catch(() => undefined),
      sidecar.client.stateSnapshot().catch(() => undefined)
    ])
    if (
      !latest ||
      !state ||
      latest.revision !== state.snapshot.revision ||
      latest.windows.some(({ windowId }) => windowId === source.windowId) ||
      placement.workspaceIds.some((id) =>
        state.snapshot.workspaces.some((workspace) => workspace.id === id)
      )
    ) {
      throw error
    }
    result = {
      revision: latest.revision,
      idempotencyEpoch: latest.idempotencyEpoch,
      closedWindowId: source.windowId,
      replayed: false
    }
  }
  for (const id of browserIds) {
    source.binding.browserViews.destroySession({ browserSessionId: id })
    windowRegistry.forgetRendererOwnership(id, source.windowId)
  }
  for (const id of terminalIds) {
    source.terminalAttachments.delete(id)
    windowRegistry.forgetRendererOwnership(id, source.windowId)
  }
  sidecar.releaseWindowResources(source.windowId)
  nodeOnlyWindowIds.delete(source.windowId)
  if (windowRegistry.get(source.windowId) === source) source.window.destroy()
  return result
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
  let scopedWindow = false
  if (!nodeCoreDemoReady && !nodeOnlyWindowIds.has(initialEntry.windowId))
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

  const browserViews = new BrowserViewManager(
    window,
    nodeCoreDemoReady && nodeSidecar ? nodeSidecar.createBrowserControl(entry.windowId) : client,
    {
      reconcileResources: (snapshot) => {
        const current = windowRegistry.findByWindow(window)
        if (current) {
          windowRegistry.reconcileRendererOwnership(current.windowId, runtimeResourceIds(snapshot))
        }
      }
    }
  )
  let stopEvents: (() => void) | undefined
  let stopNotifications: (() => void) | undefined
  let nodeAutomationProfile: string | undefined
  try {
    stopEvents = nodeCoreDemoReady
      ? () => undefined
      : forwardDesktopEvents(window, client, (resourceId, epoch, source, target) =>
          windowRegistry.observeOwnershipTransfer(resourceId, epoch, source, target)
        )
    stopNotifications = nodeCoreDemoReady
      ? () => undefined
      : await forwardSystemNotifications(client, (payload) => {
          if (window.isDestroyed()) return
          if (shouldShowSystemNotification(Notification.isSupported(), window.isFocused())) {
            new Notification(payload).show()
          }
        })
    const configurationClient =
      nodeCoreDemoReady && nodeSidecar?.configurationWritable ? nodeSidecar.client : client
    const configuration = await configurationClient
      .getConfiguration()
      .then((result) => configurationGetResultSchema.parse(result))
      .catch(() => undefined)
    if (configuration) {
      browserViews.configureBrowserProfile(configuration.config.browser)
      updateController?.applyChannel(configuration.config.updates.channel)
      if (nodeCoreDemoReady) nodeAutomationProfile = configuration.config.browser.partition
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
  const disposeReady = () => {
    if (disposed) return Promise.resolve()
    disposed = true
    if (nodeBrowserViews.get(entry.windowId) === browserViews) {
      nodeBrowserViews.delete(entry.windowId)
    }
    stopEvents?.()
    stopNotifications?.()
    browserViews.dispose()
    if (ownsClient) client.close()
    return Promise.resolve()
  }
  if (nodeCoreDemoReady) binding.replaceNodeExclusive(browserViews, disposeReady)
  else binding.replaceReady(client, browserViews, disposeReady)
  if (nodeCoreDemoReady) nodeBrowserViews.set(entry.windowId, browserViews)
  if (nodeCoreDemoReady && nodeSidecar) {
    await startNodeHostingForWindow(entry, nodeSidecar)
  }
  if (nodeCoreDemoReady && nodeSidecar && nodeAutomationProfile) {
    startNodeAutomationForWindow(entry, nodeSidecar, nodeAutomationProfile)
  }
  if (
    options.notifyRenderer !== false &&
    windowRegistry.findByWindow(window) === entry &&
    !window.isDestroyed()
  ) {
    window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
  }
  if (nodeCoreDemoReady && nodeSidecar) {
    await binding.stateController
      .rebase(scopedNodeWindowStateClient(nodeSidecar, window))
      .catch((error) => {
        binding.stateController.clearClient()
        console.error('[node-sidecar] window state binding failed', error)
      })
  } else {
    const boundsClient = scopedWindow ? scopedWindowStateClient(client, window) : client
    await binding.stateController.rebase(boundsClient).catch(() => undefined)
  }
  if (
    options.notifyRenderer !== false &&
    windowRegistry.findByWindow(window) === entry &&
    !window.isDestroyed()
  ) {
    window.webContents.send(DESKTOP_IPC.browserViewsRebind)
  }
}

async function bindNativeNodeWindow(window: BrowserWindow): Promise<void> {
  const entry = windowRegistry.findByWindow(window)
  const sidecar = nodeSidecar
  if (!entry || !sidecar || !nodeCoreDemoReady || window.isDestroyed()) {
    throw new Error('Native Node window owner is unavailable')
  }
  const browserViews = new BrowserViewManager(
    window,
    sidecar.createBrowserControl(entry.windowId),
    {
      reconcileResources: (snapshot) => {
        const current = windowRegistry.findByWindow(window)
        if (current)
          windowRegistry.reconcileRendererOwnership(current.windowId, runtimeResourceIds(snapshot))
      }
    }
  )
  try {
    const configuration = configurationGetResultSchema.parse(
      await sidecar.client.getConfiguration()
    )
    browserViews.configureBrowserProfile(configuration.config.browser)
    updateController?.applyChannel(configuration.config.updates.channel)
    if (windowRegistry.findByWindow(window) !== entry || window.isDestroyed()) {
      throw new Error('Native Node window changed before binding')
    }
    const binding = entry.binding as DesktopWindowBinding
    binding.replaceNodeExclusive(browserViews, async () => {
      if (nodeBrowserViews.get(entry.windowId) === browserViews)
        nodeBrowserViews.delete(entry.windowId)
      browserViews.dispose()
    })
    nodeBrowserViews.set(entry.windowId, browserViews)
    await startNodeHostingForWindow(entry, sidecar)
    startNodeAutomationForWindow(entry, sidecar, configuration.config.browser.partition)
    await binding.stateController.rebase(scopedNodeWindowStateClient(sidecar, window))
  } catch (error) {
    browserViews.dispose()
    await (entry.binding as DesktopWindowBinding).clearReady().catch(() => undefined)
    throw error
  }
}

function unbindReadyClient(): Promise<void> {
  desktopProviderRecovery.cancel()
  return serializeReadyBindingOperation(async () => {
    await stopNativeProviders()
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

async function stopNativeProviders(): Promise<void> {
  // Keep the shared lease registered until an in-flight start claim has either
  // been declined or acknowledged as stopped before its native effect.
  await Promise.all([
    desktopActionProvider?.stop(),
    browserAutomationProvider?.stop(),
    projectActionConfirmationProvider?.stop()
  ])
  await desktopProvider?.stop()
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

function startNodeAutomationForWindow(
  entry: WindowRegistryEntry,
  sidecar: NodeSidecar,
  approvedProfileKey: string
): void {
  cancelNodeAutomationRecovery(entry.windowId)
  const context: NodeAutomationRecoveryContext = {
    entry,
    sidecar,
    profileKey: approvedProfileKey,
    browserViews: entry.binding.browserViews
  }
  void startNodeAutomationAttempt(context).catch((error) => {
    console.error('[node-browser-automation] provider startup failed', error)
    requestNodeAutomationRecovery(context)
  })
}

function nodeAutomationContextCurrent(context: NodeAutomationRecoveryContext): boolean {
  const { entry, sidecar, browserViews } = context
  const hosting = nodeHostingClaims.get(entry.windowId)
  return (
    nodeCoreDemoReady &&
    nodeSidecar === sidecar &&
    windowRegistry.get(entry.windowId) === entry &&
    nodeBrowserViews.get(entry.windowId) === browserViews &&
    hosting?.entry === entry &&
    hosting.sidecar === sidecar &&
    !entry.window.isDestroyed() &&
    !closingWindowIds.has(entry.windowId) &&
    !quitOrchestrator.isQuitStarted()
  )
}

function cancelNodeAutomationRecovery(windowId: string): void {
  const recovery = nodeAutomationRecovery.get(windowId)
  if (!recovery) return
  nodeAutomationRecovery.delete(windowId)
  recovery.cancel()
}

function requestNodeAutomationRecovery(context: NodeAutomationRecoveryContext): void {
  if (!nodeAutomationContextCurrent(context)) return
  const windowId = context.entry.windowId
  let recovery = nodeAutomationRecovery.get(windowId)
  if (!recovery) {
    recovery = new ProviderRecoveryCoordinator<NodeAutomationRecoveryContext>({
      delaysMs: [100, 500, 1_000, 2_000, 5_000],
      recover: async (candidate) => {
        if (!nodeAutomationContextCurrent(candidate)) return true
        try {
          await startNodeAutomationAttempt(candidate)
          if (!nodeAutomationContextCurrent(candidate)) return true
          const active = nodeAutomationProviders.get(windowId)
          return (
            active?.sidecar === candidate.sidecar &&
            active.generation === candidate.entry.generation &&
            active.profileKey === candidate.profileKey &&
            active.browserViews === candidate.browserViews
          )
        } catch (error) {
          console.error('[node-browser-automation] provider recovery attempt failed', error)
          return false
        }
      },
      sameContext: (left, right) =>
        left.entry === right.entry &&
        left.sidecar === right.sidecar &&
        left.profileKey === right.profileKey &&
        left.browserViews === right.browserViews,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    nodeAutomationRecovery.set(windowId, recovery)
  }
  recovery.request(context)
}

function startNodeAutomationAttempt(context: NodeAutomationRecoveryContext): Promise<void> {
  const { entry } = context
  const previous = nodeAutomationStarts.get(entry.windowId) ?? Promise.resolve()
  const startup = previous
    .catch(() => undefined)
    .then(() => {
      if (!nodeAutomationContextCurrent(context)) return
      return ensureNodeAutomationForWindow(context)
    })
  nodeAutomationStarts.set(entry.windowId, startup)
  void startup
    .finally(() => {
      if (nodeAutomationStarts.get(entry.windowId) === startup)
        nodeAutomationStarts.delete(entry.windowId)
    })
    .catch(() => undefined)
  return startup
}

async function ensureNodeAutomationForWindow(
  context: NodeAutomationRecoveryContext
): Promise<void> {
  const { entry, sidecar, profileKey: approvedProfileKey } = context
  const current = nodeAutomationProviders.get(entry.windowId)
  if (
    current?.generation === entry.generation &&
    current.sidecar === sidecar &&
    current.profileKey === approvedProfileKey &&
    current.browserViews === context.browserViews
  )
    return
  if (current) {
    nodeAutomationProviders.delete(entry.windowId)
    await current.provider.stop('window generation changed')
  }
  if (!nodeAutomationContextCurrent(context)) return
  const identity = await sidecar.registerAutomationProviderForTrustedOwner(
    entry.windowId,
    entry.generation
  )
  if (!nodeAutomationContextCurrent(context)) {
    await sidecar
      .revokeAutomationProviderForTrustedOwner(entry.windowId, entry.generation, identity)
      .catch(() => undefined)
    return
  }
  const manager = createBrowserAutomationManager(approvedProfileKey)
  const provider = new BrowserAutomationProvider({
    identity,
    transport: {
      poll: (params, signal) => sidecar.pollBrowserAutomation(params, signal),
      acknowledge: (params) => sidecar.acknowledgeBrowserAutomation(params),
      respondTransfer: (params) => sidecar.respondBrowserAutomationTransfer(params)
    },
    resolveManager: (windowId, generation) =>
      windowId === entry.windowId &&
      generation === entry.generation &&
      windowRegistry.get(windowId) === entry &&
      nodeHostingClaims.get(windowId)?.entry === entry &&
      !entry.window.isDestroyed()
        ? manager
        : undefined,
    managers: () => [manager],
    logError: (message, error) => console.error(`[node-browser-automation] ${message}`, error),
    onProviderLost: () => {
      const active = nodeAutomationProviders.get(entry.windowId)
      if (active?.provider !== provider) return
      nodeAutomationProviders.delete(entry.windowId)
      void Promise.allSettled([
        provider.stop('Node provider lost'),
        sidecar.revokeAutomationProviderForTrustedOwner(entry.windowId, entry.generation, identity)
      ]).then(() => requestNodeAutomationRecovery(context))
    }
  })
  nodeAutomationProviders.set(entry.windowId, {
    generation: entry.generation,
    sidecar,
    profileKey: approvedProfileKey,
    browserViews: context.browserViews,
    provider,
    manager,
    identity
  })
  try {
    provider.start()
  } catch (error) {
    if (nodeAutomationProviders.get(entry.windowId)?.provider === provider)
      nodeAutomationProviders.delete(entry.windowId)
    await Promise.allSettled([
      provider.stop('Node provider startup failed'),
      sidecar.revokeAutomationProviderForTrustedOwner(entry.windowId, entry.generation, identity)
    ])
    throw error
  }
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
      nodeSidecar?.releaseWindowResources(windowRegistry.findByWindow(window)?.windowId)
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
          void (nodeOnlyWindowIds.has(windowRegistry.findByWindow(window)?.windowId ?? '')
            ? requestNodeWindowClose(window)
            : requestServiceWindowClose(window))
          return
        }
        if (process.platform !== 'darwin') quitOrchestrator.windowClose(event)
      })

      const removeWindowApplicationMenu = applicationMenu.bindWindow(window)
      acquisition.addCleanup(removeWindowApplicationMenu)

      const currentLifecycle = lifecycle
      if ((!currentLifecycle || !supervisor) && !nativeNodeDesktop) {
        throw new Error('Desktop lifecycle is unavailable')
      }
      acquiredLifecycle = currentLifecycle

      if (currentLifecycle) {
        const stopLifecycleForwarding = forwardLifecycleState(window, (listener) =>
          currentLifecycle.onStateChanged(listener)
        )
        acquisition.addCleanup(stopLifecycleForwarding)
      }

      const stateController = new WindowStateController(window, {
        getDisplayMatching: (bounds) => toDisplaySnapshot(screen.getDisplayMatching(bounds))
      })
      const client = currentLifecycle?.getClient()
      if (
        client &&
        !nodeCoreDemoReady &&
        !(serviceWindowId && nodeOnlyWindowIds.has(serviceWindowId))
      )
        stateController.setClient(client, savedState)

      provisionalWindowId = serviceWindowId ?? randomUUID()
      acquiredRegistryBinding = new DesktopWindowBinding(stateController)
      acquisition.addCleanup(async () => {
        nodeSidecar?.releaseWindowResources(windowRegistry.findByWindow(window)?.windowId)
        registryRemoval ??= windowRegistry.removeWindow(window, 'closed')
        await registryRemoval
      })
      if (currentLifecycle) installRendererCrashRecovery(window, currentLifecycle)
      window.once('closed', () => {
        void acquisition.release().catch((error) => {
          console.error('[window] failed to release main-window bindings', error)
        })
      })
    },
    isDestroyed: (window) => window.isDestroyed(),
    load: (window) => {
      const currentLifecycle = acquiredLifecycle
      if (!currentLifecycle && nativeNodeDesktop) {
        const bind =
          nodeCoreDemoReady && nodeSidecar ? bindNativeNodeWindow(window) : Promise.resolve()
        return bind.then(() =>
          window.loadURL(resolveRendererTarget(app.isPackaged, process.env.ELECTRON_RENDERER_URL))
        )
      }
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
  const creation = (
    nodeCoreDemoReady && nodeSidecar
      ? resolveSavedNodeWindowStateFor(nodeSidecar, windowId)
      : nodeOnlyWindowIds.has(windowId)
        ? Promise.resolve(undefined)
        : resolveSavedWindowStateFor(client, windowId)
  ).then((savedState) =>
    createMainWindow(savedState, windowId, placementGenerations.get(windowId) ?? generation)
  )
  placementCreations.set(windowId, creation)
  return creation.finally(() => {
    if (placementCreations.get(windowId) === creation) placementCreations.delete(windowId)
    placementGenerations.delete(windowId)
  })
}

async function createNativeNodePlacementWindow(
  sidecar: NodeSidecar,
  windowId: string
): Promise<BrowserWindow> {
  const existing = windowRegistry.get(windowId)
  if (existing) return existing.window
  const pending = placementCreations.get(windowId)
  if (pending) return pending
  nodeOnlyWindowIds.add(windowId)
  const creation = resolveSavedNodeWindowStateFor(sidecar, windowId).then((savedState) =>
    createMainWindow(savedState, windowId)
  )
  placementCreations.set(windowId, creation)
  try {
    return await creation
  } catch (error) {
    nodeOnlyWindowIds.delete(windowId)
    throw error
  } finally {
    if (placementCreations.get(windowId) === creation) placementCreations.delete(windowId)
  }
}

async function createInitialNativeWindows(): Promise<BrowserWindow | undefined> {
  const sidecar = nodeSidecar
  if (!nativeNodeDesktop || !nodeCoreDemoReady || !sidecar) return undefined
  const topology = await sidecar.client.listWindows()
  const focused = topology.windows.find(({ windowId }) => windowId === topology.focusedWindowId)
  const ordered = focused
    ? [focused, ...topology.windows.filter((window) => window !== focused)]
    : topology.windows
  for (const placement of ordered) {
    await createNativeNodePlacementWindow(sidecar, placement.windowId)
  }
  const target = focused ? windowRegistry.get(focused.windowId)?.window : currentWindow()
  target?.focus()
  return target
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

async function resolveSavedNodeWindowStateFor(
  sidecar: NodeSidecar,
  windowId: string
): Promise<WindowStateSnapshot | undefined> {
  try {
    const result = await sidecar.getWindowStateForTrustedPlacement(windowId)
    return visibleSavedWindowState(result.state, screen.getAllDisplays().map(toDisplaySnapshot))
  } catch (error) {
    console.error('[node-sidecar] saved window state is unavailable', error)
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
  if (nativeNodeDesktop) {
    return currentWindow() ? Promise.resolve(currentWindow()) : createInitialNativeWindows()
  }
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
    await restoreNodeOnlyWindows(client, new Set(topology.windows.map(({ windowId }) => windowId)))
    return focusedWindow ?? currentWindow()
  } catch {
    return windowRegistry.size > 0 ? currentWindow() : createWindowForCurrentState()
  }
}

async function restoreNodeOnlyWindows(
  rustClient: ControlClient,
  rustWindowIds: ReadonlySet<string>
): Promise<void> {
  const sidecar = nodeCoreDemoReady ? nodeSidecar : undefined
  if (!sidecar) return
  const topology = await sidecar.client.listWindows()
  const ordered = [
    ...topology.windows.filter(({ windowId }) => windowId === topology.focusedWindowId),
    ...topology.windows.filter(({ windowId }) => windowId !== topology.focusedWindowId)
  ]
  for (const { windowId } of ordered) {
    if (rustWindowIds.has(windowId) || windowRegistry.get(windowId)) continue
    nodeOnlyWindowIds.add(windowId)
    try {
      await createServicePlacementWindow(rustClient, windowId)
    } catch (error) {
      nodeOnlyWindowIds.delete(windowId)
      console.error(`[window] failed to restore Node placement ${windowId}`, error)
    }
  }
  if (!rustWindowIds.has(topology.focusedWindowId)) {
    windowRegistry.get(topology.focusedWindowId)?.window.focus()
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

async function requestNodeWindowClose(window: BrowserWindow): Promise<void> {
  const entry = windowRegistry.findByWindow(window)
  const sidecar = nodeSidecar
  if (!entry || !sidecar || !nodeCoreDemoReady || closingWindowIds.has(entry.windowId)) return
  closingWindowIds.add(entry.windowId)
  try {
    const topology = await sidecar.listWindowsForTrustedOwner(entry.windowId)
    const current = topology.windows.find(({ windowId }) => windowId === entry.windowId)
    const target = topology.windows.find(
      ({ hostingState, windowId }) =>
        windowId !== entry.windowId &&
        hostingState === 'hosted' &&
        windowRegistry.get(windowId)?.window.isDestroyed() === false
    )
    if (!current || !target) throw new Error('No eligible Node window rehome target is available')
    await closeNodeWindowPlacement(sidecar, entry, windowRegistry.get(target.windowId)!, {
      mutation: {
        expectedRevision: topology.revision,
        idempotencyEpoch: topology.idempotencyEpoch,
        idempotencyKey: randomUUID()
      },
      window: { windowId: current.windowId, expectedRevision: current.revision },
      policy: 'rehome',
      rehomeTarget: { windowId: target.windowId, expectedRevision: target.revision }
    })
  } catch (error) {
    console.error('[window] Node close request failed', error)
  } finally {
    closingWindowIds.delete(entry.windowId)
  }
}

async function detachNodeTab(
  source: WindowRegistryEntry,
  input: ReturnType<typeof tabDetachParamsSchema.parse>
) {
  const params = tabDetachParamsSchema.parse(input)
  const sidecar = nodeSidecar
  const rustClient = lifecycle?.getClient()
  const current = (): void => {
    if (
      !nodeCoreDemoReady ||
      !sidecar ||
      nodeSidecar !== sidecar ||
      windowRegistry.get(source.windowId) !== source ||
      source.window.isDestroyed()
    )
      throw new Error('The Node tab detach owner changed')
  }
  current()
  if ((!rustClient && !nativeNodeDesktop) || params.source.windowId !== source.windowId)
    throw new Error('The Node tab detach owner changed')
  const [topology, { snapshot }] = await Promise.all([
    sidecar!.listWindowsForTrustedOwner(source.windowId),
    sidecar!.client.listWorkspaces()
  ])
  current()
  const placement = topology.windows.find(({ windowId }) => windowId === source.windowId)
  const workspace = snapshot.workspaces.find(({ id }) => id === params.source.workspaceId)
  const tab = workspace?.tabs.find(({ id }) => id === params.source.tabId)
  if (
    topology.revision !== params.mutation.expectedRevision ||
    topology.idempotencyEpoch !== params.mutation.idempotencyEpoch ||
    snapshot.revision !== topology.revision ||
    placement?.revision !== params.source.expectedWindowRevision ||
    !placement.workspaceIds.includes(params.source.workspaceId) ||
    !tab ||
    tab.paneId !== params.source.paneId
  )
    throw new Error('The Node tab detach placement changed')
  const terminalId = tab.content.kind === 'terminal' ? tab.content.runtimeSessionId : undefined
  const remote = terminalId !== undefined && sidecar!.isRemoteTerminalBinding(terminalId)
  const attached = terminalId !== undefined && source.terminalAttachments.has(terminalId)
  if (
    terminalId &&
    !remote &&
    sidecar!.localTerminalSocketOwner(terminalId) !== (attached ? source.windowId : undefined)
  )
    throw new Error('The Node terminal socket owner changed')
  const browserSessionId =
    tab.content.kind === 'browser' ? tab.content.state.browserSessionId : undefined
  if (tab.content.kind === 'browser' && !browserSessionId)
    throw new Error('The Node browser has no runtime identity')
  if (
    browserSessionId &&
    windowRegistry
      .list()
      .some((entry) => entry !== source && entry.binding.browserViews.ownsSession(browserSessionId))
  )
    throw new Error('The Node browser native owner changed')
  const descriptor = browserSessionId
    ? source.binding.browserViews
        .ownedTransferDescriptors()
        .find((item) => item.browserSessionId === browserSessionId)
    : undefined
  if (
    descriptor &&
    (descriptor.workspaceId !== workspace!.id ||
      descriptor.paneId !== tab.paneId ||
      descriptor.tabId !== tab.id)
  )
    throw new Error('The Node browser native placement changed')
  const terminalTransfer = sidecar!.suspendLocalTerminalEvents(
    source.windowId,
    attached && !remote ? [terminalId!] : []
  )
  const remoteTransfer = remote
    ? sidecar!.suspendRemoteTerminalEvents(source.windowId, terminalId!)
    : undefined
  let resumeBrowser: (() => void) | undefined
  try {
    if (descriptor)
      resumeBrowser = source.binding.browserViews.suspendOwnedSession(descriptor.browserSessionId)
  } catch (error) {
    remoteTransfer?.rollback()
    terminalTransfer.rollback()
    throw error
  }
  const rollback = (): void => {
    resumeBrowser?.()
    remoteTransfer?.rollback()
    terminalTransfer.rollback()
  }
  let result: ReturnType<typeof advancedTabMutationResultSchema.parse> | undefined
  try {
    result = advancedTabMutationResultSchema.parse(
      await sidecar!.detachTabForTrustedOwner(source.windowId, params)
    )
  } catch (error) {
    result = await sidecar!
      .detachTabForTrustedOwner(source.windowId, params)
      .then((value) => advancedTabMutationResultSchema.parse(value))
      .catch(() => undefined)
    if (!result) {
      const [latest, newTopology] = await Promise.all([
        sidecar!.client.listWorkspaces().catch(() => undefined),
        sidecar!.client.listWindows().catch(() => undefined)
      ])
      const stillSource = latest?.snapshot.workspaces
        .find(({ id }) => id === params.source.workspaceId)
        ?.tabs.some(({ id }) => id === tab.id)
      const detachedWorkspace = latest?.snapshot.workspaces.find(
        (item) => item.id !== params.source.workspaceId && item.tabs.some(({ id }) => id === tab.id)
      )
      const detachedWindow = newTopology?.windows.find(
        (item) => detachedWorkspace && item.workspaceIds.includes(detachedWorkspace.id)
      )
      if (detachedWorkspace && detachedWindow) {
        result = advancedTabMutationResultSchema.parse({
          revision: params.mutation.expectedRevision + 1,
          idempotencyEpoch: params.mutation.idempotencyEpoch,
          tabId: tab.id,
          ownershipKind: tab.content.kind,
          ...(browserSessionId ? { runtimeSessionId: browserSessionId } : {}),
          placement: {
            windowId: detachedWindow.windowId,
            workspaceId: detachedWorkspace.id,
            paneId: detachedWorkspace.tabs.find(({ id }) => id === tab.id)!.paneId,
            index: 0,
            windowRevision: 0
          },
          transferEpoch: params.mutation.expectedRevision + 1,
          replayed: true
        })
      } else if (stillSource && latest && newTopology) {
        rollback()
        throw error
      } else {
        throw new Error('Node tab detach outcome is unknown; resources are quarantined', {
          cause: error
        })
      }
    }
  }
  current()
  nodeOnlyWindowIds.add(result.placement.windowId)
  if (!windowRegistry.get(result.placement.windowId)) {
    const created = rustClient
      ? await createServicePlacementWindow(rustClient, result.placement.windowId)
      : await createNativeNodePlacementWindow(sidecar!, result.placement.windowId)
    if (created.isDestroyed()) throw new Error('The detached Node window was destroyed')
  }
  current()
  const target = windowRegistry.get(result.placement.windowId)
  if (!target || target.window.isDestroyed())
    throw new Error('The detached Node window is unavailable')
  if (descriptor) {
    const { snapshot: latest } = await sidecar!.client.listWorkspaces()
    const detachedWorkspace = latest.workspaces.find(
      ({ id }) => id === result!.placement.workspaceId
    )
    if (!detachedWorkspace) throw new Error('The detached browser workspace is unavailable')
    await target.binding.browserViews.mountTransferred(
      {
        ...descriptor,
        workspaceId: result.placement.workspaceId,
        paneId: result.placement.paneId
      },
      {
        revision: latest.revision,
        workspace: detachedWorkspace
      } as unknown as WorkspaceSnapshotResult
    )
    target.binding.browserViews.activateTransferredSession(descriptor.browserSessionId)
    source.binding.browserViews.destroyOwnedSession(descriptor.browserSessionId)
    windowRegistry.forgetRendererOwnership(descriptor.browserSessionId, source.windowId)
    windowRegistry.recordRendererOwnership(descriptor.browserSessionId, target.windowId)
  }
  terminalTransfer.finalize()
  remoteTransfer?.finalize(target.windowId)
  if (terminalId) {
    source.terminalAttachments.delete(terminalId)
    windowRegistry.forgetRendererOwnership(terminalId, source.windowId)
  }
  source.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
  source.window.webContents.send(DESKTOP_IPC.browserViewsRebind)
  target.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
  target.window.webContents.send(DESKTOP_IPC.browserViewsRebind)
  target.window.focus()
  return result
}

async function moveNodeTabExact(
  source: WindowRegistryEntry,
  input: ReturnType<typeof tabMoveExactParamsSchema.parse>
) {
  const params = tabMoveExactParamsSchema.parse(input)
  const sidecar = nodeSidecar
  const target = windowRegistry.get(params.target.windowId)
  const current = (): void => {
    if (
      !nodeCoreDemoReady ||
      nodeSidecar !== sidecar ||
      windowRegistry.get(source.windowId) !== source ||
      windowRegistry.get(params.target.windowId) !== target ||
      source.window.isDestroyed() ||
      !target ||
      target.window.isDestroyed()
    )
      throw new Error('The Node tab transfer owner changed')
  }
  current()
  if (!sidecar || !target || params.source.windowId !== source.windowId)
    throw new Error('The Node tab transfer owner changed')
  if (target === source) throw new Error('Move tab to another window requires another window')
  if (params.source.workspaceId === params.target.workspaceId)
    throw new Error('A workspace cannot belong to two windows')
  const [topology, { snapshot }] = await Promise.all([
    sidecar.listWindowsForTrustedOwner(source.windowId),
    sidecar.client.listWorkspaces()
  ])
  current()
  const sourcePlacement = topology.windows.find(({ windowId }) => windowId === source.windowId)
  const targetPlacement = topology.windows.find(({ windowId }) => windowId === target.windowId)
  const sourceWorkspace = snapshot.workspaces.find(({ id }) => id === params.source.workspaceId)
  const targetWorkspace = snapshot.workspaces.find(({ id }) => id === params.target.workspaceId)
  const tab = sourceWorkspace?.tabs.find(({ id }) => id === params.source.tabId)
  if (
    topology.revision !== params.mutation.expectedRevision ||
    topology.idempotencyEpoch !== params.mutation.idempotencyEpoch ||
    snapshot.revision !== topology.revision ||
    sourcePlacement?.revision !== params.source.expectedWindowRevision ||
    targetPlacement?.revision !== params.target.expectedWindowRevision ||
    !sourcePlacement?.workspaceIds.includes(params.source.workspaceId) ||
    !targetPlacement?.workspaceIds.includes(params.target.workspaceId) ||
    !tab ||
    tab.paneId !== params.source.paneId ||
    !targetWorkspace?.panes.some(({ id }) => id === params.target.paneId)
  )
    throw new Error('The Node tab placement changed')
  if (tab.content.kind === 'browser') {
    const browserTab = { ...tab, content: tab.content }
    const browserSessionId = tab.content.state.browserSessionId
    if (!browserSessionId) throw new Error('The Node browser has no runtime identity')
    const owners = windowRegistry
      .list()
      .filter((entry) => entry.binding.browserViews.ownsSession(browserSessionId))
    if (owners.some((entry) => entry !== source))
      throw new Error('The Node browser native owner changed')
    const descriptor = source.binding.browserViews
      .ownedTransferDescriptors()
      .find((item) => item.browserSessionId === browserSessionId)
    if (
      descriptor &&
      (descriptor.workspaceId !== params.source.workspaceId ||
        descriptor.paneId !== params.source.paneId ||
        descriptor.tabId !== params.source.tabId)
    )
      throw new Error('The Node browser native placement changed')
    const finishCommitted = (): void => {
      if (windowRegistry.get(source.windowId) === source && !source.window.isDestroyed()) {
        source.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
        source.window.webContents.send(DESKTOP_IPC.browserViewsRebind)
      }
      if (windowRegistry.get(target.windowId) === target && !target.window.isDestroyed()) {
        if (target.window.isMinimized()) target.window.restore()
        target.window.focus()
        target.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
        target.window.webContents.send(DESKTOP_IPC.browserViewsRebind)
      }
    }
    let result: ReturnType<typeof advancedTabMutationResultSchema.parse> | undefined
    if (descriptor) {
      const targetPane = targetWorkspace.panes.find(({ id }) => id === params.target.paneId)!
      const targetSnapshot = {
        revision: snapshot.revision,
        workspace: {
          ...targetWorkspace,
          selectedPaneId: targetPane.id,
          panes: targetWorkspace.panes.map((pane) =>
            pane.id === targetPane.id
              ? { ...pane, tabIds: [...pane.tabIds, tab.id], selectedTabId: tab.id }
              : pane
          ),
          tabs: [...targetWorkspace.tabs, { ...browserTab, paneId: targetPane.id }]
        }
      } as unknown as WorkspaceSnapshotResult
      await moveNodeBrowserTab({
        source: source.binding.browserViews,
        target: target.binding.browserViews,
        descriptor,
        destination: { workspaceId: targetWorkspace.id, paneId: targetPane.id },
        targetSnapshot,
        assertCurrent: current,
        commit: async () => {
          result = advancedTabMutationResultSchema.parse(
            await sidecar.moveTabExactForTrustedOwner(source.windowId, params)
          )
        },
        resolveCommit: async () => {
          const { snapshot: latest } = await sidecar.client.listWorkspaces()
          const inSource = latest.workspaces
            .find(({ id }) => id === params.source.workspaceId)
            ?.tabs.some(({ id }) => id === params.source.tabId)
          const inTarget = latest.workspaces
            .find(({ id }) => id === params.target.workspaceId)
            ?.tabs.some(
              ({ id, paneId }) => id === params.source.tabId && paneId === params.target.paneId
            )
          return inTarget && !inSource
            ? 'committed'
            : inSource && !inTarget
              ? 'not-committed'
              : 'unknown'
        },
        transferred: (id) => {
          windowRegistry.forgetRendererOwnership(id, source.windowId)
          windowRegistry.recordRendererOwnership(id, target.windowId)
          finishCommitted()
        }
      })
    } else {
      result = advancedTabMutationResultSchema.parse(
        await sidecar.moveTabExactForTrustedOwner(source.windowId, params)
      )
      finishCommitted()
    }
    if (
      !result ||
      result.tabId !== tab.id ||
      result.ownershipKind !== 'browser' ||
      result.runtimeSessionId !== browserSessionId ||
      result.placement.windowId !== target.windowId ||
      result.placement.workspaceId !== targetWorkspace.id ||
      result.placement.paneId !== params.target.paneId
    )
      throw new Error('The Node browser move returned a different placement')
    return result
  }
  const terminalId = tab.content.runtimeSessionId
  const remote = terminalId !== undefined && sidecar.isRemoteTerminalBinding(terminalId)
  if (terminalId && target.terminalAttachments.has(terminalId))
    throw new Error('The target already owns the terminal')
  if (
    terminalId &&
    !remote &&
    sidecar.localTerminalSocketOwner(terminalId) !==
      (source.terminalAttachments.has(terminalId) ? source.windowId : undefined)
  )
    throw new Error('The Node terminal socket owner changed')
  const attached = terminalId !== undefined && source.terminalAttachments.has(terminalId)
  const transfer =
    attached && !remote
      ? sidecar.suspendLocalTerminalEvents(source.windowId, [terminalId])
      : undefined
  const remoteTransfer = remote
    ? sidecar.suspendRemoteTerminalEvents(source.windowId, terminalId!)
    : undefined
  const resolveCommit = async (): Promise<'committed' | 'not-committed' | 'unknown'> => {
    const { snapshot: latest } = await sidecar.client.listWorkspaces()
    const inSource = latest.workspaces
      .find(({ id }) => id === params.source.workspaceId)
      ?.tabs.find(({ id }) => id === params.source.tabId)
    const inTarget = latest.workspaces
      .find(({ id }) => id === params.target.workspaceId)
      ?.tabs.find(({ id }) => id === params.source.tabId)
    if (inTarget?.paneId === params.target.paneId && !inSource) return 'committed'
    if (inSource?.paneId === params.source.paneId && !inTarget) return 'not-committed'
    return 'unknown'
  }
  const finishCommitted = (): void => {
    let transferError: unknown
    if (transfer) {
      if (transfer.isCurrent()) {
        try {
          transfer.finalize()
        } catch (error) {
          transferError = error
        }
      } else {
        transferError = new Error(
          'The committed terminal socket changed; renderer resync is required'
        )
      }
    }
    if (remoteTransfer) {
      if (remoteTransfer.isCurrent()) {
        try {
          remoteTransfer.finalize(target.windowId)
        } catch (error) {
          transferError = error
        }
      } else {
        transferError = new Error('The committed remote terminal owner changed')
      }
    }
    if (terminalId) {
      source.terminalAttachments.delete(terminalId)
      windowRegistry.forgetRendererOwnership(terminalId, source.windowId)
    }
    if (windowRegistry.get(source.windowId) === source && !source.window.isDestroyed())
      source.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
    if (windowRegistry.get(target.windowId) === target && !target.window.isDestroyed()) {
      if (target.window.isMinimized()) target.window.restore()
      target.window.focus()
      target.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
    }
    if (transferError) throw transferError
  }
  let result: ReturnType<typeof advancedTabMutationResultSchema.parse>
  try {
    result = advancedTabMutationResultSchema.parse(
      await sidecar.moveTabExactForTrustedOwner(source.windowId, params)
    )
    if (
      result.tabId !== params.source.tabId ||
      result.placement.windowId !== target.windowId ||
      result.placement.workspaceId !== params.target.workspaceId ||
      result.placement.paneId !== params.target.paneId
    )
      throw new Error('The Node tab move returned a different placement')
  } catch (error) {
    const outcome = await resolveCommit().catch(() => 'unknown' as const)
    if (outcome === 'not-committed') {
      transfer?.rollback()
      remoteTransfer?.rollback()
    }
    if (outcome === 'committed') finishCommitted()
    throw error
  }
  finishCommitted()
  return result
}

async function closeNodeWindowPlacement(
  sidecar: NodeSidecar,
  source: WindowRegistryEntry,
  target: WindowRegistryEntry,
  params: WindowCloseParams
) {
  let terminalTransfer: ReturnType<NodeSidecar['suspendLocalTerminalEvents']> | undefined
  const remoteTransfers: ReturnType<NodeSidecar['suspendRemoteTerminalEvents']>[] = []
  const current = (): void => {
    if (
      !nodeCoreDemoReady ||
      nodeSidecar !== sidecar ||
      windowRegistry.get(source.windowId) !== source ||
      windowRegistry.get(target.windowId) !== target ||
      source.window.isDestroyed() ||
      target.window.isDestroyed() ||
      (terminalTransfer && !terminalTransfer.isCurrent()) ||
      remoteTransfers.some((transfer) => !transfer.isCurrent())
    ) {
      throw new Error('The Node window owner changed during rehome')
    }
  }
  current()
  const topology = await sidecar.listWindowsForTrustedOwner(source.windowId)
  current()
  const placement = topology.windows.find(({ windowId }) => windowId === source.windowId)
  if (!placement || !topology.windows.some(({ windowId }) => windowId === target.windowId)) {
    throw new Error('The Node rehome placement is unavailable')
  }
  const { snapshot } = await sidecar.client.listWorkspaces()
  current()
  if (
    snapshot.revision !== params.mutation.expectedRevision ||
    topology.revision !== snapshot.revision ||
    placement.revision !== params.window.expectedRevision
  ) {
    throw new Error('The Node rehome projection changed')
  }
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]))
  const terminalIds = [...source.terminalAttachments]
  const placedTerminalIds = new Set(
    placement.workspaceIds.flatMap((workspaceId) =>
      (workspaces.get(workspaceId)?.tabs ?? []).flatMap((tab) =>
        tab.content.kind === 'terminal' && tab.content.runtimeSessionId
          ? [tab.content.runtimeSessionId]
          : []
      )
    )
  )
  for (const id of terminalIds) {
    if (!placedTerminalIds.has(id) || target.terminalAttachments.has(id))
      throw new Error('The Node terminal is outside the closing window placement')
  }
  terminalTransfer = sidecar.suspendLocalTerminalEvents(
    source.windowId,
    terminalIds.filter((id) => !sidecar.isRemoteTerminalBinding(id))
  )
  try {
    for (const id of placedTerminalIds) {
      if (sidecar.isRemoteTerminalBinding(id))
        remoteTransfers.push(sidecar.suspendRemoteTerminalEvents(source.windowId, id))
    }
  } catch (error) {
    for (const transfer of remoteTransfers.reverse()) transfer.rollback()
    terminalTransfer.rollback()
    throw error
  }
  let result: Awaited<ReturnType<NodeSidecar['closeWindowForTrustedOwner']>> | undefined
  let committedTopology: Awaited<ReturnType<typeof sidecar.client.listWindows>> | undefined
  const resolveCommit = async (): Promise<'committed' | 'not-committed' | 'unknown'> => {
    const latest = await sidecar.client.listWindows()
    const destination = latest.windows.find(({ windowId }) => windowId === target.windowId)
    if (!destination) return 'unknown'
    if (
      !latest.windows.some(({ windowId }) => windowId === source.windowId) &&
      placement.workspaceIds.every((id) => destination.workspaceIds.includes(id))
    ) {
      committedTopology = latest
      return 'committed'
    }
    return latest.windows.some(({ windowId }) => windowId === source.windowId)
      ? 'not-committed'
      : 'unknown'
  }
  try {
    await rehomeNodeBrowsers({
      source: source.binding.browserViews,
      target: {
        ownsSession: (id) => target.binding.browserViews.ownsSession(id),
        destroyOwnedSession: (id) => target.binding.browserViews.destroyOwnedSession(id),
        activateTransferredSession: (id) =>
          target.binding.browserViews.activateTransferredSession(id),
        mountTransferred: async (descriptor) => {
          const workspace = workspaces.get(descriptor.workspaceId)
          if (!workspace) throw new Error('The Node browser workspace is unavailable')
          await target.binding.browserViews.mountTransferred(descriptor, {
            revision: snapshot.revision,
            workspace
          } as unknown as WorkspaceSnapshotResult)
        }
      },
      sourceWorkspaceIds: new Set(placement.workspaceIds),
      assertCurrent: current,
      commit: async () => {
        result = await sidecar.closeWindowForTrustedOwner(source.windowId, params)
      },
      resolveCommit,
      transferred: (browserSessionId) =>
        windowRegistry.recordRendererOwnership(browserSessionId, target.windowId)
    })
  } catch (error) {
    const outcome = await resolveCommit().catch(() => 'unknown' as const)
    if (outcome === 'not-committed') {
      for (const transfer of remoteTransfers.reverse()) transfer.rollback()
      terminalTransfer.rollback()
    }
    // An unknown or committed outcome keeps source delivery quiesced. A later
    // renderer attach or process restart must reconcile the durable placement.
    throw error
  }
  // An uncertain response can still be proven committed by the topology read.
  if (!result) {
    if (!committedTopology) throw new Error('The committed Node rehome topology is unavailable')
    const destination = committedTopology.windows.find(
      ({ windowId }) => windowId === target.windowId
    )
    if (!destination) throw new Error('The committed Node rehome target is unavailable')
    result = {
      revision: committedTopology.revision,
      idempotencyEpoch: committedTopology.idempotencyEpoch,
      closedWindowId: source.windowId,
      rehomeTarget: destination,
      replayed: false
    }
  }
  terminalTransfer.finalize()
  for (const transfer of remoteTransfers) transfer.finalize(target.windowId)
  for (const id of terminalIds) {
    source.terminalAttachments.delete(id)
    windowRegistry.forgetRendererOwnership(id, source.windowId)
  }
  nodeOnlyWindowIds.delete(source.windowId)
  if (windowRegistry.get(source.windowId) === source) source.window.destroy()
  if (windowRegistry.get(target.windowId) === target && !target.window.isDestroyed()) {
    target.window.webContents.send(DESKTOP_IPC.desktopBindingRebind)
    target.window.webContents.send(DESKTOP_IPC.browserViewsRebind)
  }
  return result
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

function scopedNodeWindowStateClient(
  sidecar: NodeSidecar,
  window: BrowserWindow
): {
  getWindowState(): Promise<unknown>
  updateWindowState(params: { state: WindowStateSnapshot }): Promise<unknown>
} {
  const windowId = (): string => {
    const entry = windowRegistry.findByWindow(window)
    if (!entry || nodeSidecar !== sidecar || !nodeCoreDemoReady) {
      throw new Error('Node window-state owner is unavailable')
    }
    return entry.windowId
  }
  return {
    getWindowState: async () => {
      const result = await sidecar.getWindowStateForTrustedOwner(windowId())
      return { state: result.state }
    },
    updateWindowState: async ({ state }) => {
      const result = await sidecar.updateWindowStateForTrustedOwner(windowId(), state)
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
      windowRegistry
        .list()
        .filter(({ windowId }) => !nodeOnlyWindowIds.has(windowId))
        .map(({ generation, windowId }) => ({ windowId, generation }))
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

function setNativeLifecycleState(state: DesktopLifecycleState): void {
  nativeLifecycleState = state
  for (const { window } of windowRegistry.list()) {
    if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.lifecycleChanged, state)
  }
}

function requireNativeSidecar(): NodeSidecar {
  if (!nodeCoreDemoReady || !nodeSidecar) throw new Error('The local Node service is unavailable')
  return nodeSidecar
}

async function nativeFailureState(
  databasePath: string,
  message: string
): Promise<DesktopLifecycleState> {
  const source = await lstat(databasePath).catch(() => undefined)
  const recoveryExport =
    process.platform === 'linux' &&
    typeof process.getuid === 'function' &&
    source?.isFile() === true &&
    !source.isSymbolicLink() &&
    source.nlink === 1 &&
    source.uid === process.getuid() &&
    (source.mode & 0o777) === 0o600
  return {
    status: 'failed',
    message,
    availableActions: { recoveryExport, diagnostics: false }
  }
}

async function exportNativeRecovery(
  options: Parameters<typeof NodeSidecar.startNative>[0],
  destination: string,
  format: 'sqlite' | 'archive' = 'sqlite'
): Promise<unknown> {
  const executable = options.executable ?? process.execPath
  const helper = join(dirname(options.serverPath), 'recovery-export.mjs')
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  const { stdout } = await execFileAsync(
    executable,
    [helper, ...(format === 'archive' ? ['--raw'] : []), options.liveDatabasePath, destination],
    { env: environment, timeout: 30_000, maxBuffer: 16 * 1024 }
  )
  return recoveryExportResultSchema.parse(JSON.parse(stdout))
}

async function restartNativeDesktop(
  options: Parameters<typeof NodeSidecar.startNative>[0]
): Promise<void> {
  if (nativeRestartOperation) return nativeRestartOperation
  const operation = (async () => {
    if (quitOrchestrator.isQuitStarted()) throw new Error('Application shutdown is in progress')
    await Promise.all(windowRegistry.list().map(({ binding }) => binding.stateController.flush()))
    setNativeLifecycleState({ status: 'starting' })
    nodeCoreDemoReady = false
    const previous = nodeSidecar
    let replacement: NodeSidecar | undefined
    try {
      for (const windowId of nodeHostingClaims.keys()) stopNodeHostingForWindow(windowId)
      await Promise.allSettled([...nodeAutomationStarts.values()])
      await Promise.all(
        windowRegistry
          .list()
          .map(({ binding }) =>
            binding instanceof DesktopWindowBinding ? binding.clearReady() : Promise.resolve()
          )
      )
      nodeSidecar = undefined
      await previous?.stop()
      replacement = await NodeSidecar.startNative(options)
      nodeSidecar = replacement
      nodeCoreDemoReady = true
      await connectNativeNodeEvents(replacement)
      for (const { windowId, window } of windowRegistry.list()) {
        if (!window.isDestroyed() && !nativeRecoveryWindowIds.has(windowId)) {
          await bindNativeNodeWindow(window)
        }
      }
      await createInitialNativeWindows()
      for (const windowId of nativeRecoveryWindowIds) {
        nativeRecoveryWindowIds.delete(windowId)
        const fallback = windowRegistry.get(windowId)?.window
        if (fallback && !fallback.isDestroyed()) fallback.destroy()
      }
      setNativeLifecycleState({ status: 'ready' })
    } catch (error) {
      nodeCoreDemoReady = false
      nodeSidecar = undefined
      await Promise.allSettled(
        windowRegistry
          .list()
          .map(({ binding }) =>
            binding instanceof DesktopWindowBinding ? binding.clearReady() : Promise.resolve()
          )
      )
      await Promise.allSettled([previous?.stop(), replacement?.stop()])
      console.error('[node] native service restart failed', error)
      setNativeLifecycleState(
        await nativeFailureState(options.liveDatabasePath, 'The local service could not restart')
      )
      throw error
    }
  })()
  nativeRestartOperation = operation
  try {
    await operation
  } finally {
    if (nativeRestartOperation === operation) nativeRestartOperation = undefined
  }
}

async function startNativeDesktop(userData: string): Promise<void> {
  const stateDirectory = join(userData, 'state')
  const runtimeDirectory = join(userData, 'runtime')
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  const stagedRuntime = join(process.resourcesPath, 'node-linux')
  const serverPath = app.isPackaged
    ? join(stagedRuntime, 'server', 'dist', 'bin.mjs')
    : (process.env.AGENT_WORKSPACE_DESKTOP_NODE_SERVER_PATH ??
      join(import.meta.dirname, '../../../server/dist/bin.mjs'))
  const options: Parameters<typeof NodeSidecar.startNative>[0] = {
    serverPath,
    ...(app.isPackaged ? { executable: join(stagedRuntime, 'bin', 'node') } : {}),
    liveDatabasePath: join(stateDirectory, 'workspace.sqlite'),
    backupPath: join(stateDirectory, 'pre-node-migration.sqlite'),
    native: true,
    sessionFilePath: join(runtimeDirectory, 'node-cli-session.json'),
    defaultWorkingDirectory: app.getPath('home'),
    encryptedSearch: true,
    remoteTransport: true
  }
  nativeNodeDesktop = true
  registerDesktopLifecycleHandlers(
    senderBoundIpc,
    {
      getState: () => nativeLifecycleState,
      getClient: () => undefined,
      restart: () => restartNativeDesktop(options)
    },
    {
      exportRecovery: (destination, format) => exportNativeRecovery(options, destination, format),
      previewDiagnostics: async () =>
        diagnosticBundlePreviewSchema.parse(
          await requireNativeSidecar().client.previewDiagnostics()
        ),
      exportDiagnostics: (destination, approvedPreview) =>
        requireNativeSidecar().client.exportDiagnostics({
          destination,
          approvedPreview: diagnosticBundlePreviewSchema.parse(approvedPreview)
        })
    },
    {
      downloadsDirectory: app.getPath('downloads'),
      quit: () => app.quit(),
      isNodeLifecycleEnabled: () => nativeNodeDesktop,
      isNodeCoreEnabled: () => nodeCoreDemoReady,
      isNodeConfigurationEnabled: () => nodeSidecar?.configurationWritable === true,
      isNodeDiagnosticsMode: () => true,
      isNodeDiagnosticsEnabled: () => nodeSidecar?.diagnosticsEnabled === true,
      previewNodeDiagnostics: async () =>
        diagnosticBundlePreviewSchema.parse(
          await requireNativeSidecar().client.previewDiagnostics()
        ),
      exportNodeDiagnostics: (destination, approvedPreview) =>
        requireNativeSidecar().client.exportDiagnostics({
          destination,
          approvedPreview: diagnosticBundlePreviewSchema.parse(approvedPreview)
        }),
      getNodeConfiguration: () => requireNativeSidecar().client.getConfiguration(),
      updateNodeConfiguration: (params) =>
        requireNativeSidecar().client.updateConfiguration(params),
      configurationChanged: (channel) => updateController?.applyChannel(channel)
    }
  )
  try {
    const sidecar = await NodeSidecar.startNative(options)
    nodeSidecar = sidecar
    nodeCoreDemoReady = true
    await connectNativeNodeEvents(sidecar)
    await createInitialNativeWindows()
    setNativeLifecycleState({ status: 'ready' })
    console.info('[node] native desktop ownership is ready')
  } catch (error) {
    nodeCoreDemoReady = false
    await nodeSidecar?.stop().catch(() => undefined)
    nodeSidecar = undefined
    console.error('[node] native desktop startup failed', error)
    setNativeLifecycleState(
      await nativeFailureState(options.liveDatabasePath, 'The local service could not start')
    )
    if (windowRegistry.size === 0) {
      const fallbackId = randomUUID()
      nativeRecoveryWindowIds.add(fallbackId)
      try {
        await createMainWindow(undefined, fallbackId)
      } catch (windowError) {
        nativeRecoveryWindowIds.delete(fallbackId)
        throw windowError
      }
    }
  }
}

async function connectNativeNodeEvents(sidecar: NodeSidecar): Promise<void> {
  sidecar.setBrowserEventSink(async (workspaceId, event) => {
    if (!nodeCoreDemoReady || nodeSidecar !== sidecar) return
    const { snapshot } = await sidecar.client.stateSnapshot()
    for (const placement of snapshot.windowPlacements) {
      if (!placement.workspaceIds.includes(workspaceId)) continue
      const owner = windowRegistry.get(placement.id)
      if (owner && !owner.window.isDestroyed()) {
        owner.window.webContents.send(DESKTOP_IPC.domainEvent, event)
      }
    }
  })
  await sidecar.startWorkspaceEvents((channel, event, workspaceId) => {
    if (!nodeCoreDemoReady || nodeSidecar !== sidecar) return
    void Promise.all([sidecar.client.stateSnapshot(), sidecar.client.listWorkspaces()])
      .then(([{ snapshot }, projection]) => {
        for (const browserViews of nodeBrowserViews.values()) {
          browserViews.reconcileAuthoritativeSnapshot(projection, false)
        }
        for (const placement of snapshot.windowPlacements) {
          if (!placement.workspaceIds.includes(workspaceId)) continue
          const entry = windowRegistry.get(placement.id)
          if (entry && !entry.window.isDestroyed()) entry.window.webContents.send(channel, event)
        }
      })
      .catch((error) => console.error('[node] event delivery failed', error))
  })
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
  await startNativeDesktop(userData)
}

async function performExitCleanup(): Promise<void> {
  await performApplicationExitCleanup({
    flushWindowState: () =>
      Promise.all(windowRegistry.list().map(({ binding }) => binding.stateController.flush())).then(
        () => undefined
      ),
    logStage: (stage) => console.info(`[shutdown] stage=${stage}`),
    stopService: async () => {
      desktopProviderRecovery.cancel()
      for (const windowId of nodeAutomationRecovery.keys()) cancelNodeAutomationRecovery(windowId)
      for (const windowId of nodeHostingClaims.keys()) stopNodeHostingForWindow(windowId)
      await serializeReadyBindingOperation(stopNativeProviders)
      await Promise.allSettled([...nodeAutomationStarts.values()])
      await Promise.all(
        [...nodeAutomationProviders.values()].map(({ provider }) =>
          provider.stop('application exit').catch(() => undefined)
        )
      )
      nodeAutomationProviders.clear()
      await nodeSidecar?.stop()
      nodeSidecar = undefined
      // Final renderer cleanup cannot reach the in-memory terminal runtime once shutdown starts.
      terminalCleanupDuringQuit = true
      try {
        await supervisor?.stop()
      } catch (error) {
        terminalCleanupDuringQuit = false
        throw error
      }
    },
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
    .catch((error: unknown) => {
      console.error('[startup] native Node desktop failed', error)
      return windowCreationEntrypoints.recoverStartup(
        error,
        lifecycle !== undefined && supervisor !== undefined
      )
    })
}
