import { constants } from 'node:fs'
import { access, lstat, open, rename, stat, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import {
  actionInvocationSnapshotSchema,
  actionListResultSchema,
  actionRegistryChangedEventSchema,
  agentAttentionSetResultSchema,
  agentCatalogGetResultSchema,
  agentCatalogListResultSchema,
  agentCatalogRegisterResultSchema,
  agentHibernationMutationResultSchema,
  agentHibernationPreflightResultSchema,
  agentRestoreAssessResultSchema,
  agentSessionForkResultSchema,
  agentSessionRestoreResultSchema,
  agentTeamMemberMutationResultSchema,
  agentTeamMutationResultSchema,
  MAX_TERMINAL_CHECKPOINT_WIRE_BYTES,
  attentionAcknowledgementParamsSchema,
  attentionAcknowledgementResultSchema,
  advancedTabMutationResultSchema,
  advancedTabCloseResultSchema,
  browserBackParamsSchema,
  browserForwardParamsSchema,
  browserNavigateParamsSchema,
  browserOpenDevToolsParamsSchema,
  browserReloadParamsSchema,
  browserStopParamsSchema,
  configurationGetResultSchema,
  configurationUpdateParamsSchema,
  closedItemGetParamsSchema,
  closedItemGetResultSchema,
  closedItemListResultSchema,
  focusHistoryNavigateParamsSchema,
  focusHistoryNavigateResultSchema,
  diagnosticBundlePreviewSchema,
  domainEventSchema,
  groupAssignParamsSchema,
  groupCollapseParamsSchema,
  groupCreateParamsSchema,
  groupDeleteParamsSchema,
  groupMoveParamsSchema,
  groupRenameParamsSchema,
  identifyResultSchema,
  layoutApplyParamsSchema,
  layoutDeleteParamsSchema,
  layoutExportEnvelopeSchema,
  layoutExportParamsSchema,
  layoutGetParamsSchema,
  layoutGetResultSchema,
  layoutListResultSchema,
  layoutMutationResultSchema,
  layoutSaveParamsSchema,
  mutationResultSchema,
  multiWindowEventSchema,
  notificationClearParamsSchema,
  notificationListParamsSchema,
  notificationListResultSchema,
  notificationMarkReadParamsSchema,
  notificationMarkUnreadParamsSchema,
  recoveryExportResultSchema,
  paneCloseParamsSchema,
  paneFocusParamsSchema,
  paneMoveTabParamsSchema,
  paneResizeParamsSchema,
  paneSplitParamsSchema,
  settingsGetResultSchema,
  settingsResetKeyParamsSchema,
  settingsUpdateParamsSchema,
  serviceEventSchema,
  tabCloseParamsSchema,
  tabMoveParamsSchema,
  tabOpenBrowserParamsSchema,
  tabOpenTerminalParamsSchema,
  tabSelectParamsSchema,
  tabUpdateParamsSchema,
  terminalAttachResultSchema,
  terminalCheckpointSchema,
  terminalCreateParamsSchema,
  terminalEventSchema,
  terminalRestartParamsSchema,
  tabCloseAdvancedParamsSchema,
  tabDetachParamsSchema,
  tabDuplicateParamsSchema,
  tabMoveExactParamsSchema,
  tabReopenParamsSchema,
  windowCloseParamsSchema,
  windowCreateParamsSchema,
  windowFocusParamsSchema,
  windowListResultSchema,
  windowMutationResultSchema,
  windowCloseResultSchema,
  remoteHostKeyChallengeSchema,
  remoteSessionListResultSchema,
  remoteSessionResultSchema,
  remoteTargetListResultSchema,
  remoteTargetResultSchema,
  remoteTmuxDiscoveryResultSchema,
  type AgentSessionSnapshot,
  type ConfigurationUpdateParams,
  type DesktopProviderIdentityParams,
  type WindowCloseParams,
  type MutationResult,
  type NotificationListParams,
  type WorkspaceBatchCloseParams,
  workspaceCloseParamsSchema,
  workspaceCardSlotsChangedEventSchema,
  workspaceCardSlotsReplaceParamsSchema,
  workspaceCardSlotsSnapshotParamsSchema,
  workspaceCardSlotsSnapshotSchema,
  workspaceCardSlotV2ChangedEventSchema,
  workspaceCardSlotV2GetParamsSchema,
  workspaceCardSlotV2ReplaceParamsSchema,
  workspaceCardSlotV2SnapshotSchema,
  workspaceAttentionChangedEventSchema,
  workspaceAttentionSnapshotParamsSchema,
  workspaceAttentionSnapshotSchema,
  workspaceCreateParamsSchema,
  workspaceListResultSchema,
  workspaceBatchCloseParamsSchema,
  workspaceCanonicalMoveParamsSchema,
  workspaceOrganizationGetResultSchema,
  workspacePinParamsSchema,
  workspaceSelectionReplaceParamsSchema,
  workspaceMoveParamsSchema,
  workspaceSelectParamsSchema,
  workspaceSnapshotParamsSchema,
  workspaceSnapshotResultSchema,
  workspaceUpdateParamsSchema
} from '@agent-workspace/protocol-client'
import {
  contentDiffParamsSchema,
  contentDiffResultSchema,
  contentDocumentIssueParamsSchema,
  contentDocumentIssueResultSchema,
  contentMarkdownParamsSchema,
  contentPreviewSchema,
  contentReadParamsSchema,
  recentlyClosedListResultSchema,
  searchControlResultSchema,
  searchQueryParamsSchema,
  searchQueryResultSchema,
  safeMarkdownDocumentSchema,
  sidebarPlacementSchema,
  taskActionResultSchema,
  taskListParamsSchema,
  taskListResultSchema,
  textBoxDocumentSchema,
  textBoxListResultSchema,
  workspaceDirectoryListParamsSchema,
  workspaceDirectoryListResultSchema,
  workspaceRootListResultSchema
} from '@agent-workspace/protocol-client'

import {
  DESKTOP_IPC,
  parseBrowserViewMountParams,
  parseBrowserViewSessionParams,
  parseDesktopLifecycleState,
  parseWorkspaceRuntimeMetadata,
  desktopActionInvokeRequestSchema,
  desktopAgentAttentionRequestSchema,
  desktopAgentForkRequestSchema,
  desktopAgentRegisterRequestSchema,
  desktopAgentSessionActionSchema,
  desktopAgentTeamCreateRequestSchema,
  desktopAgentTeamDeleteRequestSchema,
  desktopAgentTeamMemberCreateRequestSchema,
  desktopAgentTeamMemberDeleteRequestSchema,
  desktopAgentTeamMemberMoveRequestSchema,
  desktopAgentTeamMemberUpdateRequestSchema,
  desktopRemoteConnectRequestSchema,
  desktopRemoteSessionActionSchema,
  desktopRemoteTargetDeleteRequestSchema,
  desktopRemoteTargetDraftSchema,
  desktopRemoteTargetIdentitySchema,
  desktopRecentlyClosedReopenRequestSchema,
  desktopSearchConsentRequestSchema,
  desktopSearchExportConfirmationIssueResultSchema,
  desktopSearchExportRequestSchema,
  desktopSearchExportResultSchema,
  desktopSearchRebuildRequestSchema,
  desktopSearchSourceRequestSchema,
  desktopSidebarSelectionSchema,
  desktopTaskActionRequestSchema,
  desktopTextBoxCreateRequestSchema,
  desktopTextBoxDeleteRequestSchema,
  desktopTextBoxSaveRequestSchema,
  desktopWorkspacePathOpenersSchema,
  desktopWorkspacePathOpenRequestSchema,
  savedLayoutImportRequestSchema,
  type DesktopLifecycleState,
  type DesktopWorkspacePathOpenerId,
  type SavedLayoutImportRequest
} from '../shared/desktop-bridge'
import { desktopMessages } from '../shared/desktop-messages'
import {
  isSafeRemoteUrl,
  type BrowserLiveAction,
  type BrowserViewManager
} from './browser-view-manager'
import { ControlRequestError, type ControlClient } from './control-client'
import { DesktopWindowBinding } from './desktop-window-binding'
import type { SenderBoundIpcRouter } from './sender-bound-ipc-router'
import type { WindowRegistryBinding, WindowRegistryEntry } from './window-registry'
import { resolveWorkspaceRuntimeMetadata } from './workspace-runtime-metadata'
import { detectWorkspacePathOpeners, launchWorkspacePathInIde } from './workspace-path-openers'

export const DESKTOP_LIFECYCLE_INVOKE_CHANNELS = [
  DESKTOP_IPC.lifecycleGet,
  DESKTOP_IPC.serviceRestart,
  DESKTOP_IPC.recoveryExportDatabase,
  DESKTOP_IPC.diagnosticsPreview,
  DESKTOP_IPC.diagnosticsExport,
  DESKTOP_IPC.configurationGet,
  DESKTOP_IPC.configurationUpdate,
  DESKTOP_IPC.applicationQuit
] as const

export interface DesktopLifecycleController {
  getState(): DesktopLifecycleState
  getClient(): ControlClient | undefined
  restart(): Promise<void>
}

export interface DesktopUtilitySupervisor {
  exportRecovery(destination: string): Promise<unknown>
  previewDiagnostics(): Promise<unknown>
  exportDiagnostics(destination: string, approvedPreview: unknown): Promise<unknown>
}

export interface DesktopHandlerDependencies {
  resolveWorkspaceRuntimeMetadata?: typeof resolveWorkspaceRuntimeMetadata
  showOpenDialog?: typeof dialog.showOpenDialog
  showSaveDialog?: typeof dialog.showSaveDialog
  showMessageBox?: typeof dialog.showMessageBox
  isWindowEntryCurrent?: (entry: WindowRegistryEntry) => boolean
  isApplicationGlobalLayoutAvailable?: () => boolean
  getDesktopProviderIdentity?: () => DesktopProviderIdentityParams | undefined
  serializeResource?: <T>(resourceId: string, operation: () => Promise<T>) => Promise<T>
  terminalAttached?: (windowId: string, terminalId: string) => void
  terminalDetached?: (windowId: string, terminalId: string) => void
  ownershipAcquired?: (windowId: string, resourceId: string) => void
  waitForOwnershipTransfer?: (windowId: string, resourceId: string) => Promise<void>
  waitForWindowActivation?: (entry: WindowRegistryEntry) => Promise<void>
  detectWorkspacePathOpeners?: typeof detectWorkspacePathOpeners
  openWorkspacePath?: (
    openerId: DesktopWorkspacePathOpenerId,
    workspacePath: string
  ) => Promise<void>
  enrollRemoteCredential?: (
    targetId: string,
    expectedRevision: number,
    credentialFd: number
  ) => Promise<string>
  commitRemoteCredential?: (
    enrollmentId: string,
    targetId: string,
    expectedRevision: number
  ) => Promise<void>
  removeRemoteCredential?: (enrollmentId: string, targetId: string) => Promise<void>
}

export interface DesktopLifecycleHandlerDependencies {
  showSaveDialog?: typeof dialog.showSaveDialog
  pathExists?: (path: string) => Promise<boolean>
  downloadsDirectory: string
  scheduleQuit?: (quit: () => void) => void
  configurationChanged?: (channel: 'stable' | 'beta') => void
  quit(): void
}

type DesktopHandler = Parameters<typeof ipcMain.handle>[1]
type DesktopHandlerMap = Map<string, DesktopHandler>

interface ReadyDesktopHandlerMap {
  readonly client: ControlClient
  readonly browserViews: BrowserViewManager
  readonly handlers: DesktopHandlerMap
}

interface LifecycleDesktopHandlerMap {
  readonly binding: WindowRegistryBinding
  readonly handlers: DesktopHandlerMap
}

let currentCollectingHost: ReturnType<typeof createCollectingHost> | undefined

function createCollectingHost(handlers: DesktopHandlerMap): {
  handle(channel: string, listener: DesktopHandler): void
} {
  const host = {
    handle(channel: string, listener: DesktopHandler): void {
      handlers.set(channel, listener)
    }
  }
  currentCollectingHost = host
  return host
}

function requireCollectingHost(): ReturnType<typeof createCollectingHost> {
  if (!currentCollectingHost) throw new Error('Desktop IPC handler collector is unavailable')
  return currentCollectingHost
}

function requireCollectedHandler(handlers: DesktopHandlerMap, channel: string): DesktopHandler {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Desktop IPC handler was not collected: ${channel}`)
  return handler
}

export function registerDesktopLifecycleHandlers(
  router: SenderBoundIpcRouter,
  controller: DesktopLifecycleController,
  supervisor: DesktopUtilitySupervisor,
  dependencies: DesktopLifecycleHandlerDependencies
): void {
  const handlerMaps = new WeakMap<BrowserWindow, LifecycleDesktopHandlerMap>()
  for (const channel of DESKTOP_LIFECYCLE_INVOKE_CHANNELS) {
    router.handle(channel, (entry, event, ...args) => {
      let cached = handlerMaps.get(entry.window)
      if (!cached || cached.binding !== entry.binding) {
        cached = {
          binding: entry.binding,
          handlers: collectDesktopLifecycleHandlers(entry, controller, supervisor, dependencies)
        }
        handlerMaps.set(entry.window, cached)
      }
      return requireCollectedHandler(cached.handlers, channel)(event, ...args)
    })
  }
}

function collectDesktopLifecycleHandlers(
  entry: WindowRegistryEntry,
  controller: DesktopLifecycleController,
  supervisor: DesktopUtilitySupervisor,
  dependencies: DesktopLifecycleHandlerDependencies
): DesktopHandlerMap {
  const window = entry.window
  const handlers = new Map<string, DesktopHandler>()
  const host = createCollectingHost(handlers)
  const validate = createSenderValidator(window)
  const showSaveDialog = dependencies.showSaveDialog ?? dialog.showSaveDialog.bind(dialog)
  const pathExists = dependencies.pathExists ?? defaultPathExists

  host.handle(DESKTOP_IPC.lifecycleGet, (event) => {
    validate(event)
    return parseDesktopLifecycleState(controller.getState())
  })
  host.handle(DESKTOP_IPC.serviceRestart, async (event) => {
    validate(event)
    await controller.restart()
  })
  host.handle(DESKTOP_IPC.recoveryExportDatabase, async (event) => {
    validate(event)
    const messages = desktopMessages.exportDialogs.recovery
    const chosen = await showSaveDialog(window, {
      title: messages.title,
      defaultPath: join(
        dependencies.downloadsDirectory,
        datedFilename('workspace-recovery', 'sqlite')
      ),
      buttonLabel: messages.button,
      filters: [{ name: messages.filter, extensions: ['sqlite'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (chosen.canceled || !chosen.filePath) return null
    if (await pathExists(chosen.filePath)) {
      throw new Error(messages.overwriteRejected)
    }
    return recoveryExportResultSchema.parse(await supervisor.exportRecovery(chosen.filePath))
  })
  host.handle(DESKTOP_IPC.diagnosticsPreview, async (event) => {
    validate(event)
    return diagnosticBundlePreviewSchema.parse(await supervisor.previewDiagnostics())
  })
  host.handle(DESKTOP_IPC.diagnosticsExport, async (event, rawPreview: unknown) => {
    validate(event)
    const preview = diagnosticBundlePreviewSchema.parse(rawPreview)
    const messages = desktopMessages.exportDialogs.diagnostics
    const chosen = await showSaveDialog(window, {
      title: messages.title,
      defaultPath: join(
        dependencies.downloadsDirectory,
        datedFilename('workspace-diagnostics', 'json')
      ),
      buttonLabel: messages.button,
      filters: [{ name: messages.filter, extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (chosen.canceled || !chosen.filePath) return null
    if (await pathExists(chosen.filePath)) {
      throw new Error(messages.overwriteRejected)
    }
    await supervisor.exportDiagnostics(chosen.filePath, preview)
    return undefined
  })
  host.handle(DESKTOP_IPC.configurationGet, async (event) => {
    validate(event)
    const client = requireReadyClient(controller, entry.binding)
    return configurationGetResultSchema.parse(await client.getConfiguration())
  })
  host.handle(DESKTOP_IPC.configurationUpdate, async (event, rawParams: unknown) => {
    validate(event)
    const client = requireReadyClient(controller, entry.binding)
    const result = configurationGetResultSchema.parse(
      await client.updateConfiguration(
        configurationUpdateParamsSchema.parse(rawParams) as ConfigurationUpdateParams
      )
    )
    dependencies.configurationChanged?.(result.config.updates.channel)
    return result
  })
  host.handle(DESKTOP_IPC.applicationQuit, (event) => {
    validate(event)
    const schedule = dependencies.scheduleQuit ?? ((quit) => queueMicrotask(quit))
    schedule(() => dependencies.quit())
  })
  return handlers
}

export function removeDesktopLifecycleHandlers(): void {
  for (const channel of DESKTOP_LIFECYCLE_INVOKE_CHANNELS) ipcMain.removeHandler(channel)
}

export function forwardLifecycleState(
  window: BrowserWindow,
  subscribe: (listener: (state: DesktopLifecycleState) => void) => () => void
): () => void {
  return subscribe((state) => {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC.lifecycleChanged, parseDesktopLifecycleState(state))
    }
  })
}

export const DESKTOP_INVOKE_CHANNELS = [
  DESKTOP_IPC.identify,
  DESKTOP_IPC.actionList,
  DESKTOP_IPC.actionInvoke,
  DESKTOP_IPC.workspaceList,
  DESKTOP_IPC.workspaceOrganizationGet,
  DESKTOP_IPC.layoutList,
  DESKTOP_IPC.layoutGet,
  DESKTOP_IPC.layoutExportFile,
  DESKTOP_IPC.layoutImportFile,
  DESKTOP_IPC.workspaceSnapshot,
  DESKTOP_IPC.sidebarPlacementGet,
  DESKTOP_IPC.sidebarPlacementSave,
  DESKTOP_IPC.textBoxList,
  DESKTOP_IPC.textBoxCreate,
  DESKTOP_IPC.textBoxSave,
  DESKTOP_IPC.textBoxDelete,
  DESKTOP_IPC.contentRootList,
  DESKTOP_IPC.contentDirectoryList,
  DESKTOP_IPC.contentDocumentIssue,
  DESKTOP_IPC.contentRead,
  DESKTOP_IPC.contentMarkdown,
  DESKTOP_IPC.contentDiff,
  DESKTOP_IPC.searchQuery,
  DESKTOP_IPC.searchConsent,
  DESKTOP_IPC.searchExclude,
  DESKTOP_IPC.searchForget,
  DESKTOP_IPC.searchRebuild,
  DESKTOP_IPC.searchExport,
  DESKTOP_IPC.taskList,
  DESKTOP_IPC.taskAction,
  DESKTOP_IPC.recentlyClosedList,
  DESKTOP_IPC.recentlyClosedReopen,
  DESKTOP_IPC.workspaceCardSlotsGet,
  DESKTOP_IPC.workspaceCardSlotsReplace,
  DESKTOP_IPC.workspaceCardSlotV2Get,
  DESKTOP_IPC.workspaceCardSlotV2Replace,
  DESKTOP_IPC.workspaceAttentionGet,
  DESKTOP_IPC.attentionAcknowledge,
  DESKTOP_IPC.workspaceRuntimeMetadata,
  DESKTOP_IPC.workspacePickDirectory,
  DESKTOP_IPC.workspacePathOpeners,
  DESKTOP_IPC.workspacePathOpen,
  DESKTOP_IPC.workspaceCreate,
  DESKTOP_IPC.workspaceUpdate,
  DESKTOP_IPC.workspaceSelect,
  DESKTOP_IPC.workspaceMove,
  DESKTOP_IPC.workspaceClose,
  DESKTOP_IPC.workspaceSelectMany,
  DESKTOP_IPC.workspacePin,
  DESKTOP_IPC.workspaceCloseSelected,
  DESKTOP_IPC.workspaceReorder,
  DESKTOP_IPC.groupCreate,
  DESKTOP_IPC.groupRename,
  DESKTOP_IPC.groupDelete,
  DESKTOP_IPC.groupMove,
  DESKTOP_IPC.groupAssign,
  DESKTOP_IPC.groupCollapse,
  DESKTOP_IPC.layoutSave,
  DESKTOP_IPC.layoutDelete,
  DESKTOP_IPC.layoutApply,
  DESKTOP_IPC.paneSplit,
  DESKTOP_IPC.paneFocus,
  DESKTOP_IPC.paneResize,
  DESKTOP_IPC.paneClose,
  DESKTOP_IPC.paneMoveTab,
  DESKTOP_IPC.tabOpenTerminal,
  DESKTOP_IPC.tabOpenBrowser,
  DESKTOP_IPC.browserNavigate,
  DESKTOP_IPC.browserBack,
  DESKTOP_IPC.browserForward,
  DESKTOP_IPC.browserReload,
  DESKTOP_IPC.browserStop,
  DESKTOP_IPC.browserOpenDevTools,
  DESKTOP_IPC.browserMountView,
  DESKTOP_IPC.browserUnmountView,
  DESKTOP_IPC.browserSetBounds,
  DESKTOP_IPC.browserFocusView,
  DESKTOP_IPC.tabSelect,
  DESKTOP_IPC.tabUpdate,
  DESKTOP_IPC.tabMove,
  DESKTOP_IPC.tabClose,
  DESKTOP_IPC.terminalRestart,
  DESKTOP_IPC.notificationList,
  DESKTOP_IPC.notificationMarkRead,
  DESKTOP_IPC.notificationMarkUnread,
  DESKTOP_IPC.notificationClear,
  DESKTOP_IPC.settingsGet,
  DESKTOP_IPC.settingsUpdate,
  DESKTOP_IPC.settingsResetKey,
  DESKTOP_IPC.terminalAttach,
  DESKTOP_IPC.terminalDetach,
  DESKTOP_IPC.terminalSend,
  DESKTOP_IPC.terminalResize,
  DESKTOP_IPC.terminalCheckpoint,
  DESKTOP_IPC.openExternal,
  DESKTOP_IPC.remoteTargetList,
  DESKTOP_IPC.remoteTargetEnroll,
  DESKTOP_IPC.remoteCredentialReplace,
  DESKTOP_IPC.remoteTargetDelete,
  DESKTOP_IPC.remoteSessionList,
  DESKTOP_IPC.remoteSessionConnect,
  DESKTOP_IPC.remoteHostKeyConfirm,
  DESKTOP_IPC.remoteTmuxDiscover,
  DESKTOP_IPC.remoteSessionDetach,
  DESKTOP_IPC.remoteSessionReconnect,
  DESKTOP_IPC.remoteSessionClose,
  DESKTOP_IPC.agentCatalogList,
  DESKTOP_IPC.agentCatalogRegister,
  DESKTOP_IPC.agentRestoreAssess,
  DESKTOP_IPC.agentSessionRestore,
  DESKTOP_IPC.agentSessionFork,
  DESKTOP_IPC.agentSessionHibernate,
  DESKTOP_IPC.agentTeamCreate,
  DESKTOP_IPC.agentTeamDelete,
  DESKTOP_IPC.agentTeamMemberCreate,
  DESKTOP_IPC.agentTeamMemberUpdate,
  DESKTOP_IPC.agentTeamMemberMove,
  DESKTOP_IPC.agentTeamMemberDelete,
  DESKTOP_IPC.agentAttentionSet
] as const

export function registerMultiWindowDesktopHandlers(router: SenderBoundIpcRouter): void {
  router.handle(DESKTOP_IPC.windowList, async ({ binding }) =>
    windowListResultSchema.parse(await readyWindowClient(binding).listWindows())
  )
  router.handle(DESKTOP_IPC.windowCreate, async (entry, _event, rawParams) => {
    const params = windowCreateParamsSchema.parse(rawParams)
    requireCallerWindow(entry.windowId, params.sourceWindow.windowId)
    return windowMutationResultSchema.parse(
      await readyWindowClient(entry.binding).createWindow(params)
    )
  })
  router.handle(DESKTOP_IPC.windowClose, async (entry, _event, rawParams) => {
    const params = windowCloseParamsSchema.parse(rawParams)
    requireCallerWindow(entry.windowId, params.window.windowId)
    return windowCloseResultSchema.parse(
      await readyWindowClient(entry.binding).closeWindow(params as WindowCloseParams)
    )
  })
  router.handle(DESKTOP_IPC.windowFocus, async ({ binding }, _event, rawParams) => {
    const params = windowFocusParamsSchema.parse(rawParams)
    return windowMutationResultSchema.parse(await readyWindowClient(binding).focusWindow(params))
  })
  router.handle(DESKTOP_IPC.tabDuplicate, async (entry, _event, rawParams) => {
    const params = tabDuplicateParamsSchema.parse(rawParams)
    requireCallerWindow(entry.windowId, params.source.windowId)
    return advancedTabMutationResultSchema.parse(
      await readyWindowClient(entry.binding).duplicateTab(params)
    )
  })
  router.handle(DESKTOP_IPC.tabMoveExact, async (entry, _event, rawParams) => {
    const params = tabMoveExactParamsSchema.parse(rawParams)
    requireCallerWindow(entry.windowId, params.source.windowId)
    return advancedTabMutationResultSchema.parse(
      await readyWindowClient(entry.binding).moveTabExact(params)
    )
  })
  router.handle(DESKTOP_IPC.tabDetach, async (entry, _event, rawParams) => {
    const params = tabDetachParamsSchema.parse(rawParams)
    requireCallerWindow(entry.windowId, params.source.windowId)
    return advancedTabMutationResultSchema.parse(
      await readyWindowClient(entry.binding).detachTab(params)
    )
  })
  router.handle(DESKTOP_IPC.tabCloseAdvanced, async (entry, _event, rawParams) => {
    const params = tabCloseAdvancedParamsSchema.parse(rawParams)
    requireCallerWindow(entry.windowId, params.source.windowId)
    return advancedTabCloseResultSchema.parse(
      await readyWindowClient(entry.binding).closeTabAdvanced(params)
    )
  })
  router.handle(DESKTOP_IPC.tabReopen, async (entry, _event, rawParams) => {
    const params = tabReopenParamsSchema.parse(rawParams)
    requireCallerWindow(entry.windowId, params.target.windowId)
    return advancedTabMutationResultSchema.parse(
      await readyWindowClient(entry.binding).reopenTab(params)
    )
  })
  router.handle(DESKTOP_IPC.closedList, async ({ binding }) =>
    closedItemListResultSchema.parse(await readyWindowClient(binding).listClosedItems())
  )
  router.handle(DESKTOP_IPC.closedGet, async ({ binding }, _event, rawParams) =>
    closedItemGetResultSchema.parse(
      await readyWindowClient(binding).getClosedItem(closedItemGetParamsSchema.parse(rawParams))
    )
  )
  router.handle(DESKTOP_IPC.focusHistoryNavigate, async ({ binding }, _event, rawParams) =>
    focusHistoryNavigateResultSchema.parse(
      await readyWindowClient(binding).navigateFocusHistory(
        focusHistoryNavigateParamsSchema.parse(rawParams)
      )
    )
  )
}

function readyWindowClient(binding: unknown): ControlClient {
  if (!(binding instanceof DesktopWindowBinding)) throw new Error('Window renderer is not ready')
  return binding.client
}

function requireCallerWindow(callerWindowId: string, authorityWindowId: string): void {
  if (callerWindowId !== authorityWindowId) throw new Error('Unauthorized window authority')
}

export function registerDesktopHandlers(
  router: SenderBoundIpcRouter,
  dependencies: DesktopHandlerDependencies = {}
): void {
  const handlerMaps = new WeakMap<WindowRegistryBinding, ReadyDesktopHandlerMap>()
  const hostKeyConfirmations = new Map<string, Promise<unknown>>()
  const serializeHostKeyConfirmation = <T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const existing = hostKeyConfirmations.get(key)
    if (existing) return existing as Promise<T>
    const pending = operation().finally(() => hostKeyConfirmations.delete(key))
    hostKeyConfirmations.set(key, pending)
    return pending
  }
  for (const channel of DESKTOP_INVOKE_CHANNELS) {
    router.handle(channel, async (entry, event, ...args) => {
      await dependencies.waitForWindowActivation?.(entry)
      const client = readyWindowClient(entry.binding)
      const browserViews = entry.binding.browserViews
      let cached = handlerMaps.get(entry.binding)
      if (!cached || cached.client !== client || cached.browserViews !== browserViews) {
        cached = {
          client,
          browserViews,
          handlers: collectDesktopHandlers(
            entry,
            client,
            browserViews,
            dependencies,
            serializeHostKeyConfirmation
          )
        }
        handlerMaps.set(entry.binding, cached)
      }
      return requireCollectedHandler(cached.handlers, channel)(event, ...args)
    })
  }
}

function collectDesktopHandlers(
  entry: WindowRegistryEntry,
  client: ControlClient,
  browserViews: BrowserViewManager,
  dependencies: DesktopHandlerDependencies,
  serializeHostKeyConfirmation: <T>(key: string, operation: () => Promise<T>) => Promise<T>
): DesktopHandlerMap {
  const window = entry.window
  const handlers = new Map<string, DesktopHandler>()
  const host = createCollectingHost(handlers)
  const showOpenDialog = dependencies.showOpenDialog ?? dialog.showOpenDialog.bind(dialog)
  const showSaveDialog = dependencies.showSaveDialog ?? dialog.showSaveDialog.bind(dialog)
  const showMessageBox = dependencies.showMessageBox ?? dialog.showMessageBox.bind(dialog)
  const isWindowEntryCurrent = dependencies.isWindowEntryCurrent ?? (() => true)
  const destructiveOperations = new Map<string, Promise<unknown>>()
  const serializeDestructive = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = destructiveOperations.get(key)
    if (existing) return existing as Promise<T>
    const pending = operation().finally(() => destructiveOperations.delete(key))
    destructiveOperations.set(key, pending)
    return pending
  }
  const validate = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unauthorized desktop IPC sender')
    }
  }

  host.handle(DESKTOP_IPC.identify, async (event) => {
    validate(event)
    const identity = identifyResultSchema.parse(await client.identify())
    if (dependencies.isApplicationGlobalLayoutAvailable?.() !== false) return identity
    return identifyResultSchema.parse({
      ...identity,
      capabilities: identity.capabilities.filter((capability) => capability !== 'saved-layouts-v1')
    })
  })
  host.handle(DESKTOP_IPC.actionList, async (event) => {
    validate(event)
    const catalog = await client.listAllActions()
    return actionListResultSchema.parse(catalog)
  })
  host.handle(DESKTOP_IPC.actionInvoke, async (event, rawParams: unknown) => {
    validate(event)
    const abortController = new AbortController()
    const cancelOnRendererLoss = (): void => abortController.abort()
    const observesRendererLoss = typeof event.sender.once === 'function'
    if (observesRendererLoss) event.sender.once('destroyed', cancelOnRendererLoss)
    const params = desktopActionInvokeRequestSchema.parse(rawParams)
    try {
      const catalog = await client.listAllActions()
      const definition = catalog.definitions.find(
        ({ actionId, actionVersion }) =>
          actionId === params.actionId && actionVersion === params.actionVersion
      )
      if (!definition) throw new Error('The public action is unavailable')
      const invocationParams = {
        ...params,
        ...(definition.owner === 'desktop' || definition.interactionClass === 'confirmationRequired'
          ? {
              target: {
                windowId: entry.windowId,
                windowGeneration: entry.generation
              }
            }
          : {}),
        idempotency: { epoch: catalog.idempotencyEpoch, key: randomUUID() },
        correlationId: randomUUID()
      } as unknown as Parameters<ControlClient['invokeAction']>[0]
      const invocation = await client.invokeAction(invocationParams, {
        signal: abortController.signal
      })
      return actionInvocationSnapshotSchema.parse(invocation)
    } catch (error) {
      rethrowProtocolError(error)
    } finally {
      if (observesRendererLoss) event.sender.removeListener('destroyed', cancelOnRendererLoss)
    }
  })
  host.handle(DESKTOP_IPC.workspaceList, async (event) => {
    validate(event)
    return workspaceListResultSchema.parse(await client.listWorkspaces())
  })
  host.handle(DESKTOP_IPC.workspaceOrganizationGet, async (event) => {
    validate(event)
    const identity = identifyResultSchema.parse(await client.identify())
    if (!identity.capabilities.includes('workspace-groups-v1')) return null
    return workspaceOrganizationGetResultSchema.parse(await client.getWorkspaceOrganization())
  })
  host.handle(DESKTOP_IPC.layoutList, async (event) => {
    validate(event)
    if (dependencies.isApplicationGlobalLayoutAvailable?.() === false) return null
    const identity = identifyResultSchema.parse(await client.identify())
    if (!identity.capabilities.includes('saved-layouts-v1')) return null
    return layoutListResultSchema.parse(await client.listSavedLayouts())
  })
  host.handle(DESKTOP_IPC.layoutGet, async (event, rawParams: unknown) => {
    validate(event)
    return layoutGetResultSchema.parse(
      await client.getSavedLayout(layoutGetParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.layoutExportFile, async (event, rawParams: unknown) => {
    validate(event)
    const params = layoutExportParamsSchema.parse(rawParams)
    const chosen = await showSaveDialog(window, {
      title: 'Export saved layout',
      defaultPath: `${params.layoutId}.workspace-layout.json`,
      filters: [{ name: 'Workspace layout', extensions: ['json'] }]
    })
    if (chosen.canceled || !chosen.filePath) return false
    const exported = await client.exportLayout(params)
    await atomicWriteSavedLayout(chosen.filePath, `${JSON.stringify(exported.envelope, null, 2)}\n`)
    return true
  })
  host.handle(DESKTOP_IPC.layoutImportFile, async (event, rawParams: unknown) => {
    validate(event)
    const params: SavedLayoutImportRequest = savedLayoutImportRequestSchema.parse(rawParams)
    const chosen = await showOpenDialog(window, {
      title: 'Import saved layout',
      buttonLabel: 'Import layout',
      properties: ['openFile'],
      filters: [{ name: 'Workspace layout', extensions: ['json'] }]
    })
    if (chosen.canceled || chosen.filePaths.length !== 1) return null
    const envelope = layoutExportEnvelopeSchema.parse(
      JSON.parse(await readSavedLayout(chosen.filePaths[0]!))
    )
    return layoutMutationResultSchema.parse(await client.importLayout({ ...params, envelope }))
  })
  host.handle(DESKTOP_IPC.workspaceSnapshot, async (event, rawParams: unknown) => {
    validate(event)
    return workspaceSnapshotResultSchema.parse(
      await client.snapshotWorkspace(workspaceSnapshotParamsSchema.parse(rawParams))
    )
  })
  const sidebarOrder = [
    'textBox',
    'vault',
    'taskManager',
    'files',
    'markdown',
    'diff',
    'search',
    'recentlyClosed'
  ] as const
  const requireSidebarCapability = async (): Promise<void> => {
    const identity = identifyResultSchema.parse(await client.identify())
    if (!identity.capabilities.includes('sidebar-surfaces-v1')) {
      throw new Error('The sidebar service is unavailable')
    }
  }
  host.handle(DESKTOP_IPC.sidebarPlacementGet, async (event) => {
    validate(event)
    await requireSidebarCapability()
    try {
      const placement = await client.getSidebarPlacement(entry.windowId)
      if (!placement) throw new Error('The sidebar placement is unavailable')
      return sidebarPlacementSchema.parse(placement)
    } catch (error) {
      if (!(error instanceof ControlRequestError) || error.code !== 'target_not_found') throw error
      const placement = {
        windowId: entry.windowId,
        revision: 1,
        side: 'right' as const,
        width: 320,
        enabled: [...sidebarOrder],
        order: [...sidebarOrder],
        selected: 'textBox' as const
      }
      return sidebarPlacementSchema.parse(
        await client.saveSidebarPlacement({
          placement,
          mutation: remoteMutation('sidebar.placement.save', placement, 0)
        })
      )
    }
  })
  host.handle(DESKTOP_IPC.sidebarPlacementSave, async (event, rawParams: unknown) => {
    validate(event)
    await requireSidebarCapability()
    const params = desktopSidebarSelectionSchema.parse(rawParams)
    const current = await client.getSidebarPlacement(entry.windowId)
    if (!current || current.revision !== params.expectedRevision) {
      throw new Error('The sidebar placement changed; reload before retrying')
    }
    const placement = {
      ...current,
      windowId: entry.windowId,
      side: 'right' as const,
      width: constrainSidebarWidth(params.width, window.getContentBounds().width),
      selected: params.selected,
      revision: current.revision + 1
    }
    return sidebarPlacementSchema.parse(
      await client.saveSidebarPlacement({
        placement,
        mutation: remoteMutation('sidebar.placement.save', placement, current.revision)
      })
    )
  })
  host.handle(DESKTOP_IPC.textBoxList, async (event) => {
    validate(event)
    const result = await client.listTextBoxes()
    return textBoxListResultSchema.parse({
      documents: result.documents.filter((document) => document.windowId === entry.windowId),
      nextCursor: result.nextCursor ?? null
    })
  })
  host.handle(DESKTOP_IPC.textBoxCreate, async (event, rawParams: unknown) => {
    validate(event)
    const params = desktopTextBoxCreateRequestSchema.parse(rawParams)
    const topology = await client.listWindows()
    const authority = topology.windows.find(({ windowId }) => windowId === entry.windowId)
    if (!authority?.workspaceIds.includes(params.workspaceId)) {
      throw new Error('The TextBox workspace is not hosted by this window')
    }
    const payload = { ...params, textBoxDocumentId: randomUUID(), windowId: entry.windowId }
    return textBoxDocumentSchema.parse(
      await client.createTextBox({
        ...payload,
        mutation: remoteMutation('textbox.create', payload, 0)
      })
    )
  })
  host.handle(DESKTOP_IPC.textBoxSave, async (event, rawParams: unknown) => {
    validate(event)
    const params = desktopTextBoxSaveRequestSchema.parse(rawParams)
    const listed = await client.listTextBoxes()
    if (
      !listed.documents.some(
        (document) =>
          document.textBoxDocumentId === params.textBoxDocumentId &&
          document.windowId === entry.windowId
      )
    )
      throw new Error('The TextBox is not owned by this window')
    return textBoxDocumentSchema.parse(
      await client.saveTextBox({
        ...params,
        mutation: remoteMutation('textbox.save', params, params.expectedRevision)
      })
    )
  })
  host.handle(DESKTOP_IPC.textBoxDelete, async (event, rawParams: unknown) => {
    validate(event)
    const params = desktopTextBoxDeleteRequestSchema.parse(rawParams)
    const listed = await client.listTextBoxes()
    if (
      !listed.documents.some(
        (document) =>
          document.textBoxDocumentId === params.textBoxDocumentId &&
          document.windowId === entry.windowId
      )
    )
      throw new Error('The TextBox is not owned by this window')
    return textBoxDocumentSchema.parse(
      await client.deleteTextBox({
        ...params,
        mutation: remoteMutation('textbox.delete', params, params.expectedRevision)
      })
    )
  })
  host.handle(DESKTOP_IPC.contentRootList, async (event) => {
    validate(event)
    return workspaceRootListResultSchema.parse(await client.listContentRoots())
  })
  host.handle(DESKTOP_IPC.contentDirectoryList, async (event, rawParams: unknown) => {
    validate(event)
    return workspaceDirectoryListResultSchema.parse(
      await client.listContentDirectory(
        workspaceDirectoryListParamsSchema.parse(rawParams) as unknown as Parameters<
          ControlClient['listContentDirectory']
        >[0]
      )
    )
  })
  host.handle(DESKTOP_IPC.contentDocumentIssue, async (event, rawParams: unknown) => {
    validate(event)
    return contentDocumentIssueResultSchema.parse(
      await client.issueContentDocument(contentDocumentIssueParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.contentRead, async (event, rawParams: unknown) => {
    validate(event)
    return contentPreviewSchema.parse(
      await client.readContent(contentReadParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.contentMarkdown, async (event, rawParams: unknown) => {
    validate(event)
    return safeMarkdownDocumentSchema.parse(
      await client.renderMarkdown(contentMarkdownParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.contentDiff, async (event, rawParams: unknown) => {
    validate(event)
    return contentDiffResultSchema.parse(
      await client.diffContent(contentDiffParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.searchQuery, async (event, rawParams: unknown) => {
    validate(event)
    return searchQueryResultSchema.parse(
      await client.searchContent(searchQueryParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.searchConsent, async (event, rawParams: unknown) => {
    validate(event)
    const params = desktopSearchConsentRequestSchema.parse(rawParams)
    const { expectedRevision, ...policy } = params
    return searchControlResultSchema.parse(
      await client.setSearchSourcePolicy({
        ...policy,
        mutation: remoteMutation('search.source.policy', policy, expectedRevision)
      })
    )
  })
  for (const [channel, command] of [
    [DESKTOP_IPC.searchExclude, 'search.source.exclude'],
    [DESKTOP_IPC.searchForget, 'search.source.forget']
  ] as const) {
    host.handle(channel, async (event, rawParams: unknown) => {
      validate(event)
      const params = desktopSearchSourceRequestSchema.parse(rawParams)
      return searchControlResultSchema.parse(
        await client.mutateSearchSource(command, {
          sourceAuthorizationId: params.sourceAuthorizationId,
          mutation: remoteMutation(command, params, params.expectedRevision)
        })
      )
    })
  }
  host.handle(DESKTOP_IPC.searchRebuild, async (event, rawParams: unknown) => {
    validate(event)
    const params = desktopSearchRebuildRequestSchema.parse(rawParams)
    return searchControlResultSchema.parse(
      await client.rebuildSearchSource({
        sourceAuthorizationId: params.sourceAuthorizationId,
        cancellationId: params.cancellationId,
        mutation: remoteMutation('search.source.rebuild', params, params.expectedRevision)
      })
    )
  })
  host.handle(DESKTOP_IPC.searchExport, async (event, rawParams: unknown) => {
    validate(event)
    const params = desktopSearchExportRequestSchema.parse(rawParams)
    const warning = await showMessageBox(window, {
      type: 'warning',
      title: 'Export local search data?',
      message: 'Export the indexed data for this authorized source?',
      detail: 'The JSON file may contain private workspace or agent content.',
      buttons: ['Cancel', 'Continue'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    validate(event)
    if (!isWindowEntryCurrent(entry) || warning.response !== 1) return false

    const chosen = await showSaveDialog(window, {
      title: 'Export local search data',
      defaultPath: `${params.sourceAuthorizationId}.search-export.json`,
      buttonLabel: 'Export JSON',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    validate(event)
    if (!isWindowEntryCurrent(entry) || chosen.canceled || !chosen.filePath) return false

    const issued = desktopSearchExportConfirmationIssueResultSchema.parse(
      await client.issueSearchExportConfirmation(params)
    )
    if (issued.confirmation.sourceAuthorizationId !== params.sourceAuthorizationId) {
      throw new Error('The search export confirmation source changed')
    }
    const result = desktopSearchExportResultSchema.parse(
      await client.exportSearchSource({
        sourceAuthorizationId: params.sourceAuthorizationId,
        confirmationId: issued.confirmation.confirmationId
      })
    )
    if (result.sourceAuthorizationId !== params.sourceAuthorizationId) {
      throw new Error('The search export source changed')
    }
    validate(event)
    if (!isWindowEntryCurrent(entry)) throw new Error('The search export window changed')
    const destination = chosen.filePath.toLowerCase().endsWith('.json')
      ? chosen.filePath
      : `${chosen.filePath}.json`
    await atomicWriteSearchExport(destination, result.artifact.text)
    return true
  })
  host.handle(DESKTOP_IPC.taskList, async (event, rawParams: unknown) => {
    validate(event)
    return taskListResultSchema.parse(
      await client.listTasks(
        taskListParamsSchema.parse(rawParams) as unknown as Parameters<
          ControlClient['listTasks']
        >[0]
      )
    )
  })
  host.handle(DESKTOP_IPC.taskAction, async (event, rawParams: unknown) => {
    validate(event)
    const params = desktopTaskActionRequestSchema.parse(rawParams)
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          action: params.action,
          target: params.target,
          windowId: entry.windowId,
          windowGeneration: entry.generation
        })
      )
      .digest('hex')
    if (params.action === 'detach') {
      return taskActionResultSchema.parse(
        await client.actOnTask({
          action: 'detach',
          target: params.target,
          mutation: remoteMutation(
            'task.action',
            { action: params.action, target: params.target },
            params.target.revision
          )
        })
      )
    }
    return serializeDestructive(
      `${params.target.sessionId}:${params.target.generation}:${params.target.revision}:${params.action}`,
      async () => {
        const issued = await client.issueTaskConfirmation({
          action: params.action,
          target: params.target,
          window: { windowId: entry.windowId, windowGeneration: entry.generation },
          requestHash
        })
        const choice = await showMessageBox(window, {
          type: 'warning',
          title: 'Confirm task action',
          message: `${params.action === 'forceTerminate' ? 'Force terminate' : params.action} this task?`,
          detail: 'This action can stop work and cannot be undone.',
          buttons: ['Cancel', 'Continue'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        validate(event)
        if (
          !isWindowEntryCurrent(entry) ||
          entry.windowId !== issued.confirmation.windowId ||
          entry.generation !== issued.confirmation.windowGeneration
        ) {
          throw new Error('The confirmation window changed')
        }
        if (choice.response !== 1) return null
        return taskActionResultSchema.parse(
          await client.actOnTask({
            action: params.action,
            target: params.target,
            confirmation: issued.confirmation,
            mutation: {
              idempotencyKey: randomUUID(),
              requestHash,
              expectedRevision: params.target.revision
            }
          })
        )
      }
    )
  })
  host.handle(DESKTOP_IPC.recentlyClosedList, async (event) => {
    validate(event)
    return recentlyClosedListResultSchema.parse(await client.listRecentlyClosed())
  })
  host.handle(DESKTOP_IPC.recentlyClosedReopen, async (event, rawParams: unknown) => {
    validate(event)
    const params = desktopRecentlyClosedReopenRequestSchema.parse(rawParams)
    const [topology, snapshot] = await Promise.all([
      client.listWindows(),
      client.snapshotWorkspace({ workspaceId: params.workspaceId })
    ])
    const authority = topology.windows.find(({ windowId }) => windowId === entry.windowId)
    const pane = snapshot.workspace.panes.find(({ id }) => id === params.paneId)
    if (!authority || !pane || !authority.workspaceIds.includes(params.workspaceId)) {
      throw new Error('The reopen destination is no longer available')
    }
    const payload = {
      recentlyClosedId: params.record.recentlyClosedId,
      authorizedDescriptorId: params.record.authorizedDescriptorId,
      action: params.record.action,
      expectedRevision: params.record.expectedRevision,
      idempotencyEpoch: topology.idempotencyEpoch,
      target: {
        windowId: entry.windowId,
        workspaceId: params.workspaceId,
        paneId: params.paneId,
        destinationIndex: pane.tabIds.length,
        expectedWindowRevision: authority.revision
      }
    }
    return client.reopenRecentlyClosed({
      ...payload,
      mutation: remoteMutation('recentlyClosed.reopen', payload, params.record.expectedRevision)
    })
  })
  host.handle(DESKTOP_IPC.workspaceCardSlotsGet, async (event, rawParams: unknown) => {
    validate(event)
    return workspaceCardSlotsSnapshotSchema.parse(
      await client.getWorkspaceCardSlots(workspaceCardSlotsSnapshotParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.workspaceCardSlotsReplace, async (event, rawParams: unknown) => {
    validate(event)
    try {
      return workspaceCardSlotsSnapshotSchema.parse(
        await client.replaceWorkspaceCardSlots(
          workspaceCardSlotsReplaceParamsSchema.parse(rawParams)
        )
      )
    } catch (error) {
      if (error instanceof ControlRequestError) {
        throw new Error(`[agent-workspace-protocol-error:${error.code}] ${error.message}`, {
          cause: error
        })
      }
      throw error
    }
  })
  host.handle(DESKTOP_IPC.workspaceCardSlotV2Get, async (event, rawParams: unknown) => {
    validate(event)
    return workspaceCardSlotV2SnapshotSchema.parse(
      await client.getWorkspaceCardSlotV2(workspaceCardSlotV2GetParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.workspaceCardSlotV2Replace, async (event, rawParams: unknown) => {
    validate(event)
    try {
      return workspaceCardSlotV2SnapshotSchema.parse(
        await client.replaceWorkspaceCardSlotV2(
          workspaceCardSlotV2ReplaceParamsSchema.parse(rawParams)
        )
      )
    } catch (error) {
      if (error instanceof ControlRequestError) {
        throw new Error(`[agent-workspace-protocol-error:${error.code}] ${error.message}`, {
          cause: error
        })
      }
      throw error
    }
  })
  host.handle(DESKTOP_IPC.workspaceAttentionGet, async (event, rawParams: unknown) => {
    validate(event)
    return workspaceAttentionSnapshotSchema.parse(
      await client.getWorkspaceAttention(workspaceAttentionSnapshotParamsSchema.parse(rawParams))
    )
  })
  host.handle(DESKTOP_IPC.attentionAcknowledge, async (event, rawParams: unknown) => {
    validate(event)
    try {
      return attentionAcknowledgementResultSchema.parse(
        await client.acknowledgeAttention(attentionAcknowledgementParamsSchema.parse(rawParams))
      )
    } catch (error) {
      if (error instanceof ControlRequestError) {
        throw new Error(`[agent-workspace-protocol-error:${error.code}] ${error.message}`, {
          cause: error
        })
      }
      throw error
    }
  })
  host.handle(DESKTOP_IPC.workspaceRuntimeMetadata, async (event, rawParams: unknown) => {
    validate(event)
    const params = workspaceSnapshotParamsSchema.parse(rawParams)
    const { workspace } = workspaceSnapshotResultSchema.parse(
      await client.snapshotWorkspace(params)
    )
    const selectedPane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)
    const selectedTab = workspace.tabs.find(({ id }) => id === selectedPane?.selectedTabId)
    const terminalId =
      selectedTab?.content.kind === 'terminal' ? selectedTab.content.runtimeSessionId : undefined
    const [gitMetadata, terminalMetadata] = await Promise.all([
      (dependencies.resolveWorkspaceRuntimeMetadata ?? resolveWorkspaceRuntimeMetadata)(
        workspace.workingDirectory
      ),
      terminalId
        ? client
            .getTerminalRuntimeMetadata(terminalId)
            .catch(() => ({ terminalId, listeningPorts: [] }))
        : Promise.resolve({ terminalId: undefined, listeningPorts: [] })
    ])
    return parseWorkspaceRuntimeMetadata({
      ...gitMetadata,
      listeningPorts: terminalMetadata.listeningPorts
    })
  })
  host.handle(DESKTOP_IPC.workspacePickDirectory, async (event) => {
    validate(event)
    const result = await showOpenDialog(window, {
      title: 'Open a folder as a workspace',
      buttonLabel: 'Open workspace',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length !== 1) return null
    return result.filePaths[0] ?? null
  })
  host.handle(DESKTOP_IPC.workspacePathOpeners, async (event) => {
    validate(event)
    return desktopWorkspacePathOpenersSchema.parse(
      await (dependencies.detectWorkspacePathOpeners ?? detectWorkspacePathOpeners)()
    )
  })
  host.handle(DESKTOP_IPC.workspacePathOpen, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopWorkspacePathOpenRequestSchema.parse(rawRequest)
    const [topology, snapshot] = await Promise.all([
      client.listWindows(),
      client.snapshotWorkspace({ workspaceId: request.workspaceId })
    ])
    const authority = topology.windows.find(({ windowId }) => windowId === entry.windowId)
    const workspace = workspaceSnapshotResultSchema.parse(snapshot).workspace
    if (!authority?.workspaceIds.includes(workspace.id)) {
      throw new Error('The workspace is not hosted by this window')
    }
    const workspaceDirectory = await stat(workspace.workingDirectory)
    if (!workspaceDirectory.isDirectory()) throw new Error('The workspace path is not a directory')

    if (dependencies.openWorkspacePath) {
      await dependencies.openWorkspacePath(request.openerId, workspace.workingDirectory)
      return
    }
    if (request.openerId === 'fileManager') {
      const failure = await shell.openPath(workspace.workingDirectory)
      if (failure) throw new Error(failure)
      return
    }
    await launchWorkspacePathInIde(request.openerId, workspace.workingDirectory)
  })
  registerMutation(DESKTOP_IPC.workspaceCreate, window, workspaceCreateParamsSchema, (params) =>
    client.createWorkspace(params)
  )
  registerMutation(DESKTOP_IPC.workspaceUpdate, window, workspaceUpdateParamsSchema, (params) =>
    client.updateWorkspace(params)
  )
  registerMutation(DESKTOP_IPC.workspaceSelect, window, workspaceSelectParamsSchema, (params) =>
    client.selectWorkspace(params)
  )
  registerReconciledMutation(
    DESKTOP_IPC.workspaceMove,
    window,
    workspaceMoveParamsSchema,
    (params) => client.moveWorkspace(params),
    browserViews
  )
  registerReconciledMutation(
    DESKTOP_IPC.workspaceClose,
    window,
    workspaceCloseParamsSchema,
    (params) => client.closeWorkspace(params),
    browserViews
  )
  registerMutation(
    DESKTOP_IPC.workspaceSelectMany,
    window,
    workspaceSelectionReplaceParamsSchema,
    (params) => client.selectWorkspaces(params)
  )
  registerMutation(DESKTOP_IPC.workspacePin, window, workspacePinParamsSchema, (params) =>
    client.pinWorkspace(params)
  )
  registerReconciledMutation(
    DESKTOP_IPC.workspaceCloseSelected,
    window,
    workspaceBatchCloseParamsSchema,
    (params) => client.closeSelectedWorkspaces(params as WorkspaceBatchCloseParams),
    browserViews
  )
  registerReconciledMutation(
    DESKTOP_IPC.workspaceReorder,
    window,
    workspaceCanonicalMoveParamsSchema,
    (params) => client.reorderWorkspace(params),
    browserViews
  )
  registerMutation(DESKTOP_IPC.groupCreate, window, groupCreateParamsSchema, (params) =>
    client.createGroup(params)
  )
  registerMutation(DESKTOP_IPC.groupRename, window, groupRenameParamsSchema, (params) =>
    client.renameGroup(params)
  )
  registerMutation(DESKTOP_IPC.groupDelete, window, groupDeleteParamsSchema, (params) =>
    client.deleteGroup(params)
  )
  registerMutation(DESKTOP_IPC.groupMove, window, groupMoveParamsSchema, (params) =>
    client.moveGroup(params)
  )
  registerMutation(DESKTOP_IPC.groupAssign, window, groupAssignParamsSchema, (params) =>
    client.assignWorkspaceGroup(params)
  )
  registerMutation(DESKTOP_IPC.groupCollapse, window, groupCollapseParamsSchema, (params) =>
    client.collapseGroup(params)
  )
  registerLayoutMutation(DESKTOP_IPC.layoutSave, window, layoutSaveParamsSchema, (params) =>
    client.saveLayout(params)
  )
  registerLayoutMutation(DESKTOP_IPC.layoutDelete, window, layoutDeleteParamsSchema, (params) =>
    client.deleteLayout(params)
  )
  registerLayoutMutation(DESKTOP_IPC.layoutApply, window, layoutApplyParamsSchema, (params) =>
    client.applyLayout(params)
  )
  registerMutation(DESKTOP_IPC.paneSplit, window, paneSplitParamsSchema, (params) =>
    client.splitPane(params)
  )
  registerMutation(DESKTOP_IPC.paneFocus, window, paneFocusParamsSchema, (params) =>
    client.focusPane(params)
  )
  registerMutation(DESKTOP_IPC.paneResize, window, paneResizeParamsSchema, (params) =>
    client.resizePane(params)
  )
  registerReconciledMutation(
    DESKTOP_IPC.paneClose,
    window,
    paneCloseParamsSchema,
    (params) => client.closePane(params),
    browserViews
  )
  registerReconciledMutation(
    DESKTOP_IPC.paneMoveTab,
    window,
    paneMoveTabParamsSchema,
    (params) => client.moveTabToPane(params),
    browserViews
  )
  registerMutation(DESKTOP_IPC.tabOpenTerminal, window, tabOpenTerminalParamsSchema, (params) =>
    client.openTerminalTab(params)
  )
  registerReconciledMutation(
    DESKTOP_IPC.tabOpenBrowser,
    window,
    tabOpenBrowserParamsSchema,
    (params) =>
      client.openBrowserTab({
        workspaceId: params.workspaceId,
        paneId: params.paneId,
        metadata: params.metadata,
        ...(params.destinationIndex === undefined
          ? {}
          : { destinationIndex: params.destinationIndex }),
        ...(params.profilePartition === undefined
          ? {}
          : { profilePartition: params.profilePartition })
      }),
    browserViews
  )
  registerBrowserCommand(
    DESKTOP_IPC.browserNavigate,
    window,
    browserNavigateParamsSchema,
    (params) => client.navigateBrowser(params),
    browserViews,
    'navigate'
  )
  registerBrowserCommand(
    DESKTOP_IPC.browserBack,
    window,
    browserBackParamsSchema,
    (params) => client.browserBack(params),
    browserViews,
    'back'
  )
  registerBrowserCommand(
    DESKTOP_IPC.browserForward,
    window,
    browserForwardParamsSchema,
    (params) => client.browserForward(params),
    browserViews,
    'forward'
  )
  registerBrowserCommand(
    DESKTOP_IPC.browserReload,
    window,
    browserReloadParamsSchema,
    (params) => client.reloadBrowser(params),
    browserViews,
    'reload'
  )
  registerBrowserCommand(
    DESKTOP_IPC.browserStop,
    window,
    browserStopParamsSchema,
    (params) => client.stopBrowser(params),
    browserViews,
    'stop'
  )
  registerBrowserCommand(
    DESKTOP_IPC.browserOpenDevTools,
    window,
    browserOpenDevToolsParamsSchema,
    (params) => client.openBrowserDevTools(params),
    browserViews,
    'openDevTools'
  )
  host.handle(DESKTOP_IPC.browserMountView, async (event, rawParams: unknown) => {
    validate(event)
    const params = parseBrowserViewMountParams(rawParams)
    await dependencies.waitForOwnershipTransfer?.(entry.windowId, params.browserSessionId)
    await browserViews.mount(params)
    try {
      dependencies.ownershipAcquired?.(entry.windowId, params.browserSessionId)
    } catch (error) {
      browserViews.destroySession({ browserSessionId: params.browserSessionId })
      throw error
    }
  })
  host.handle(DESKTOP_IPC.browserUnmountView, (event, rawParams: unknown) => {
    validate(event)
    browserViews.unmount(parseBrowserViewSessionParams(rawParams))
  })
  host.handle(DESKTOP_IPC.browserSetBounds, (event, rawParams: unknown) => {
    validate(event)
    // The manager performs the same strict parse and can hide an existing view before
    // rejecting malformed geometry, which avoids leaving stale native content visible.
    browserViews.setBounds(rawParams)
  })
  host.handle(DESKTOP_IPC.browserFocusView, (event, rawParams: unknown) => {
    validate(event)
    browserViews.focus(parseBrowserViewSessionParams(rawParams))
  })
  registerMutation(DESKTOP_IPC.tabSelect, window, tabSelectParamsSchema, (params) =>
    client.selectTab(params)
  )
  registerMutation(DESKTOP_IPC.tabUpdate, window, tabUpdateParamsSchema, (params) =>
    client.updateTab(params)
  )
  registerReconciledMutation(
    DESKTOP_IPC.tabMove,
    window,
    tabMoveParamsSchema,
    (params) => client.moveTab(params),
    browserViews
  )
  registerReconciledMutation(
    DESKTOP_IPC.tabClose,
    window,
    tabCloseParamsSchema,
    (params) => client.closeTab(params),
    browserViews
  )
  registerMutation(DESKTOP_IPC.terminalRestart, window, terminalRestartParamsSchema, (params) =>
    client.restartTerminal(params)
  )
  host.handle(DESKTOP_IPC.notificationList, async (event, rawParams: unknown) => {
    validate(event)
    return notificationListResultSchema.parse(
      await client.listNotifications(
        notificationListParamsSchema.parse(rawParams ?? {}) as NotificationListParams
      )
    )
  })
  registerMutation(
    DESKTOP_IPC.notificationMarkRead,
    window,
    notificationMarkReadParamsSchema,
    (params) => client.markNotificationRead(params)
  )
  registerMutation(
    DESKTOP_IPC.notificationMarkUnread,
    window,
    notificationMarkUnreadParamsSchema,
    (params) => client.markNotificationUnread(params)
  )
  registerMutation(DESKTOP_IPC.notificationClear, window, notificationClearParamsSchema, (params) =>
    client.clearNotifications(params)
  )
  host.handle(DESKTOP_IPC.settingsGet, async (event) => {
    validate(event)
    return settingsGetResultSchema.parse(await client.getSettings())
  })
  registerMutation(DESKTOP_IPC.settingsUpdate, window, settingsUpdateParamsSchema, (params) =>
    client.updateSettings(params)
  )
  registerMutation(DESKTOP_IPC.settingsResetKey, window, settingsResetKeyParamsSchema, (params) =>
    client.resetSettingKey(params)
  )

  host.handle(DESKTOP_IPC.terminalAttach, async (event, rawTerminalId: unknown) => {
    validate(event)
    const terminalId = parseTerminalId(rawTerminalId)
    await dependencies.waitForOwnershipTransfer?.(entry.windowId, terminalId)
    const attach = async () => {
      const result = terminalAttachResultSchema.parse(await client.attachTerminal(terminalId))
      dependencies.terminalAttached?.(entry.windowId, terminalId)
      try {
        dependencies.ownershipAcquired?.(entry.windowId, terminalId)
      } catch (error) {
        await client.detachTerminal(terminalId).catch(() => undefined)
        dependencies.terminalDetached?.(entry.windowId, terminalId)
        throw error
      }
      return result
    }
    return dependencies.serializeResource
      ? dependencies.serializeResource(terminalId, attach)
      : attach()
  })
  host.handle(DESKTOP_IPC.terminalDetach, async (event, rawTerminalId: unknown) => {
    validate(event)
    const terminalId = parseTerminalId(rawTerminalId)
    const detach = async () => {
      validateVoid(await client.detachTerminal(terminalId))
      dependencies.terminalDetached?.(entry.windowId, terminalId)
    }
    if (dependencies.serializeResource) await dependencies.serializeResource(terminalId, detach)
    else await detach()
  })
  host.handle(DESKTOP_IPC.terminalSend, async (event, rawTerminalId: unknown, rawData: unknown) => {
    validate(event)
    if (typeof rawData !== 'string' || Buffer.byteLength(rawData) > 256 * 1024) {
      throw new Error('Invalid terminal input')
    }
    validateVoid(await client.sendTerminalInput(parseTerminalId(rawTerminalId), rawData))
  })
  host.handle(
    DESKTOP_IPC.terminalResize,
    async (event, rawTerminalId: unknown, rows: unknown, cols: unknown) => {
      validate(event)
      const size = terminalCreateParamsSchema.pick({ rows: true, cols: true }).parse({ rows, cols })
      validateVoid(
        await client.resizeTerminal(parseTerminalId(rawTerminalId), size.rows, size.cols)
      )
    }
  )
  host.handle(
    DESKTOP_IPC.terminalCheckpoint,
    async (event, rawTerminalId: unknown, rawCheckpoint: unknown) => {
      validate(event)
      const checkpoint = terminalCheckpointSchema.parse(rawCheckpoint)
      if (Buffer.byteLength(JSON.stringify(checkpoint)) > MAX_TERMINAL_CHECKPOINT_WIRE_BYTES) {
        throw new Error('Terminal checkpoint exceeds the maximum wire size')
      }
      validateVoid(await client.checkpointTerminal(parseTerminalId(rawTerminalId), checkpoint))
    }
  )
  host.handle(DESKTOP_IPC.remoteTargetList, async (event) => {
    validate(event)
    return remoteTargetListResultSchema.parse(
      await client.listRemoteTargets({ limit: 128, cursor: null })
    )
  })
  host.handle(DESKTOP_IPC.remoteTargetEnroll, async (event, rawDraft: unknown) => {
    validate(event)
    const draft = desktopRemoteTargetDraftSchema.parse(rawDraft)
    const chosen = await showOpenDialog(window, {
      title: 'Choose an unencrypted Ed25519 OpenSSH private key',
      buttonLabel: 'Use SSH key',
      properties: ['openFile', 'dontAddToRecent']
    })
    if (chosen.canceled || chosen.filePaths.length !== 1 || !chosen.filePaths[0]) return null
    const enroll = dependencies.enrollRemoteCredential
    const commit = dependencies.commitRemoteCredential
    const remove = dependencies.removeRemoteCredential
    if (!enroll || !commit || !remove) {
      throw new Error('Remote credential enrollment is unavailable')
    }
    const targetId = randomUUID()
    const handle = await open(chosen.filePaths[0], constants.O_RDONLY | NOFOLLOW_FILE_FLAG)
    let enrollmentId: string
    try {
      enrollmentId = await enroll(targetId, 0, handle.fd)
    } finally {
      await handle.close()
    }
    try {
      const created = remoteTargetResultSchema.parse(
        await client.createRemoteTarget({
          remoteTargetId: targetId,
          ...draft,
          mutation: remoteMutation(
            'remote.target.create',
            { remoteTargetId: targetId, ...draft },
            0
          )
        })
      )
      try {
        await commit(enrollmentId, targetId, 0)
      } catch (error) {
        await remove(enrollmentId, targetId).catch(() => undefined)
        await client
          .deleteRemoteTarget({
            remoteTargetId: targetId,
            mutation: remoteMutation(
              'remote.target.delete',
              { remoteTargetId: targetId, expectedRevision: created.target.revision },
              created.target.revision
            )
          })
          .catch(() => undefined)
        throw error
      }
      return created
    } catch (error) {
      await remove(enrollmentId, targetId).catch(() => undefined)
      throw error
    }
  })
  host.handle(DESKTOP_IPC.remoteCredentialReplace, async (event, rawTarget: unknown) => {
    validate(event)
    const { remoteTargetId } = desktopRemoteTargetIdentitySchema.parse(rawTarget)
    const chosen = await showOpenDialog(window, {
      title: 'Replace the trusted Ed25519 OpenSSH private key',
      buttonLabel: 'Replace SSH key',
      properties: ['openFile', 'dontAddToRecent']
    })
    if (chosen.canceled || chosen.filePaths.length !== 1 || !chosen.filePaths[0]) return null
    const enroll = dependencies.enrollRemoteCredential
    if (!enroll) throw new Error('Remote credential enrollment is unavailable')
    const handle = await open(chosen.filePaths[0], constants.O_RDONLY | NOFOLLOW_FILE_FLAG)
    try {
      const target = await client.getRemoteTarget({ remoteTargetId })
      await enroll(remoteTargetId, target.target.revision, handle.fd)
      return true
    } finally {
      await handle.close()
    }
  })
  host.handle(DESKTOP_IPC.remoteTargetDelete, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopRemoteTargetDeleteRequestSchema.parse(rawRequest)
    return serializeDestructive(
      `target:${request.remoteTargetId}:${request.expectedRevision}`,
      async () => {
        const before = remoteTargetResultSchema.parse(
          await client.getRemoteTarget({ remoteTargetId: request.remoteTargetId })
        )
        if (before.target.revision !== request.expectedRevision) {
          throw new Error('The remote target revision is stale')
        }
        const messages = desktopMessages.remoteConfirmations.deleteTarget
        const confirmation = await showMessageBox(window, {
          type: 'warning',
          buttons: [desktopMessages.remoteConfirmations.cancel, messages.button],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: messages.title,
          message: messages.message,
          detail: messages.detail
        })
        validate(event)
        if (confirmation.response !== 1 || !isWindowEntryCurrent(entry)) return null
        const current = remoteTargetResultSchema.parse(
          await client.getRemoteTarget({ remoteTargetId: request.remoteTargetId })
        )
        if (current.target.revision !== request.expectedRevision) {
          throw new Error('The remote target revision is stale')
        }
        return remoteTargetResultSchema.parse(
          await client.deleteRemoteTarget({
            remoteTargetId: request.remoteTargetId,
            mutation: remoteMutation('remote.target.delete', request, request.expectedRevision)
          })
        )
      }
    )
  })
  host.handle(DESKTOP_IPC.remoteSessionList, async (event) => {
    validate(event)
    return remoteSessionListResultSchema.parse(
      await client.listRemoteSessions({ limit: 128, cursor: null })
    )
  })
  host.handle(DESKTOP_IPC.remoteSessionConnect, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopRemoteConnectRequestSchema.parse(rawRequest)
    const remoteSessionId = randomUUID()
    return remoteSessionResultSchema.parse(
      await client.connectRemoteSession({
        remoteSessionId,
        ...request,
        mutation: remoteMutation('remote.session.connect', { remoteSessionId, ...request }, 0)
      })
    )
  })
  host.handle(DESKTOP_IPC.remoteHostKeyConfirm, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopRemoteSessionActionSchema.parse(rawRequest)
    return serializeHostKeyConfirmation(
      `host-key:${request.remoteSessionId}:${request.expectedRevision}`,
      async () => {
        const provider = dependencies.getDesktopProviderIdentity?.()
        if (!provider) throw new Error('Desktop-provider identity is unavailable')
        const initial = remoteSessionResultSchema.parse(
          await client.getRemoteSession({ remoteSessionId: request.remoteSessionId })
        ).session
        if (initial.revision !== request.expectedRevision) {
          throw new Error('The remote session revision is stale')
        }
        const challenge = remoteHostKeyChallengeSchema.parse(
          await client.scanRemoteHostKey({
            remoteSessionId: request.remoteSessionId,
            mutation: remoteMutation('remote.hostKey.scan', request, request.expectedRevision)
          })
        )
        if (
          challenge.remoteSessionId !== initial.remoteSessionId ||
          challenge.attemptGeneration !== initial.attemptGeneration
        ) {
          throw new Error('The remote host-key challenge is stale')
        }
        const preparedTarget = remoteTargetResultSchema.parse(
          await client.getRemoteTarget({ remoteTargetId: initial.remoteTargetId })
        ).target
        if (preparedTarget.revision !== challenge.targetRevision) {
          throw new Error('The remote target revision is stale')
        }
        if (!['untrusted', 'changed', 'revoked'].includes(preparedTarget.hostKeyState)) {
          throw new Error('The remote host key does not require confirmation')
        }
        const messages =
          preparedTarget.hostKeyState === 'untrusted'
            ? desktopMessages.remoteConfirmations.trustHostKey
            : desktopMessages.remoteConfirmations.replaceHostKey
        const confirmation = await showMessageBox(window, {
          type: 'warning',
          buttons: [messages.reject, messages.trust],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: messages.title,
          message: messages.message,
          detail: `Host: ${challenge.canonicalHost}:${String(challenge.port)}\nAlgorithm: ${challenge.algorithm}\nFingerprint: ${challenge.presentedFingerprint}`
        })
        validate(event)
        const currentProvider = dependencies.getDesktopProviderIdentity?.()
        const current = remoteSessionResultSchema.parse(
          await client.getRemoteSession({ remoteSessionId: request.remoteSessionId })
        ).session
        const currentTarget = remoteTargetResultSchema.parse(
          await client.getRemoteTarget({ remoteTargetId: initial.remoteTargetId })
        ).target
        if (
          !isWindowEntryCurrent(entry) ||
          !sameProviderIdentity(currentProvider, provider) ||
          current.revision !== initial.revision ||
          current.attemptGeneration !== initial.attemptGeneration ||
          current.remoteTargetId !== initial.remoteTargetId ||
          currentTarget.revision !== challenge.targetRevision ||
          currentTarget.hostKeyState !== preparedTarget.hostKeyState
        ) {
          throw new Error('The remote session, target, or desktop authority is stale')
        }
        const params = {
          remoteSessionId: challenge.remoteSessionId,
          promptId: challenge.promptId,
          attemptGeneration: challenge.attemptGeneration,
          presentedFingerprint: challenge.presentedFingerprint,
          decision: confirmation.response === 1 ? ('trust' as const) : ('reject' as const)
        }
        return remoteSessionResultSchema.parse(
          await client.decideRemoteHostKey({
            ...params,
            mutation: remoteMutation('remote.hostKey.decide', params, challenge.targetRevision)
          })
        )
      }
    )
  })
  host.handle(DESKTOP_IPC.remoteSessionClose, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopRemoteSessionActionSchema.parse(rawRequest)
    return serializeDestructive(
      `session:${request.remoteSessionId}:${request.expectedRevision}`,
      async () => {
        const before = remoteSessionResultSchema.parse(
          await client.getRemoteSession({ remoteSessionId: request.remoteSessionId })
        )
        if (before.session.revision !== request.expectedRevision) {
          throw new Error('The remote session revision is stale')
        }
        const messages = desktopMessages.remoteConfirmations.closeSession
        const confirmation = await showMessageBox(window, {
          type: 'warning',
          buttons: [desktopMessages.remoteConfirmations.cancel, messages.button],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: messages.title,
          message: messages.message,
          detail: messages.detail
        })
        validate(event)
        if (confirmation.response !== 1 || !isWindowEntryCurrent(entry)) return null
        const current = remoteSessionResultSchema.parse(
          await client.getRemoteSession({ remoteSessionId: request.remoteSessionId })
        )
        if (current.session.revision !== request.expectedRevision) {
          throw new Error('The remote session revision is stale')
        }
        const params = {
          remoteSessionId: request.remoteSessionId,
          mutation: remoteMutation('remote.session.close', request, request.expectedRevision)
        }
        return remoteSessionResultSchema.parse(await client.closeRemoteSession(params))
      }
    )
  })
  for (const [channel, namespace, method] of [
    [DESKTOP_IPC.remoteTmuxDiscover, 'remote.tmux.discover', 'discoverRemoteTmux'],
    [DESKTOP_IPC.remoteSessionDetach, 'remote.session.detach', 'detachRemoteSession'],
    [DESKTOP_IPC.remoteSessionReconnect, 'remote.session.reconnect', 'reconnectRemoteSession']
  ] as const) {
    host.handle(channel, async (event, rawRequest: unknown) => {
      validate(event)
      const request = desktopRemoteSessionActionSchema.parse(rawRequest)
      const params = {
        remoteSessionId: request.remoteSessionId,
        mutation: remoteMutation(namespace, request, request.expectedRevision)
      }
      if (method === 'discoverRemoteTmux') {
        return remoteTmuxDiscoveryResultSchema.parse(await client.discoverRemoteTmux(params))
      }
      return remoteSessionResultSchema.parse(await client[method](params))
    })
  }
  host.handle(DESKTOP_IPC.agentCatalogList, async (event) => {
    validate(event)
    return agentCatalogListResultSchema.parse(await client.listAgentCatalog({ catalogVersion: 1 }))
  })
  host.handle(DESKTOP_IPC.agentCatalogRegister, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentRegisterRequestSchema.parse(rawRequest)
    const binding = {
      workspaceId: request.workspaceId,
      paneId: request.paneId,
      tabId: request.tabId,
      agentSessionId: request.agentSessionId
    }
    return agentCatalogRegisterResultSchema.parse(
      await client.registerAgentSession({
        catalogVersion: 1,
        binding,
        adapterId: 'codex',
        adapterVersion: '0.142.4',
        title: request.title,
        operation: agentOperation('agent.catalog.register', request, 1, 1)
      })
    )
  })
  for (const [channel, namespace, method, schema] of [
    [
      DESKTOP_IPC.agentRestoreAssess,
      'agent.restore.assess',
      'assessAgentRestore',
      agentRestoreAssessResultSchema
    ],
    [
      DESKTOP_IPC.agentSessionRestore,
      'agent.session.restore',
      'restoreAgentSession',
      agentSessionRestoreResultSchema
    ]
  ] as const) {
    host.handle(channel, async (event, rawRequest: unknown) => {
      validate(event)
      const request = desktopAgentSessionActionSchema.parse(rawRequest)
      const session = await exactAgentSession(client, request)
      const params = {
        agentSessionId: request.agentSessionId,
        operation: agentOperation(namespace, request, session.revision, session.attemptEpoch)
      }
      return schema.parse(await client[method](params))
    })
  }
  host.handle(DESKTOP_IPC.agentSessionFork, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentForkRequestSchema.parse(rawRequest)
    const source = await exactAgentSession(client, request)
    return agentSessionForkResultSchema.parse(
      await client.forkAgentSession({
        sourceAgentSessionId: request.agentSessionId,
        destination: {
          workspaceId: request.workspaceId,
          paneId: request.paneId,
          tabId: request.tabId
        },
        title: request.title,
        operation: agentOperation(
          'agent.session.fork',
          request,
          source.revision,
          source.attemptEpoch
        )
      })
    )
  })
  host.handle(DESKTOP_IPC.agentSessionHibernate, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentSessionActionSchema.parse(rawRequest)
    return serializeDestructive(
      `agent:${request.agentSessionId}:${request.expectedRevision}`,
      async () => {
        const initial = await exactAgentSession(client, request)
        const provider = dependencies.getDesktopProviderIdentity?.()
        if (!provider) throw new Error('Desktop-provider identity is unavailable')
        const target = { windowId: entry.windowId, windowGeneration: entry.generation }
        const preflight = agentHibernationPreflightResultSchema.parse(
          await client.preflightAgentHibernation({
            agentSessionId: request.agentSessionId,
            challenge: { choice: 'terminateAfterWarning', provider, window: target },
            operation: agentOperation(
              'agent.hibernate.preflight',
              request,
              initial.revision,
              initial.attemptEpoch
            )
          })
        )
        if (
          preflight.state !== 'confirmationRequired' ||
          !preflight.confirmationId ||
          !preflight.challenge
        ) {
          throw new Error('The hibernation challenge is unavailable')
        }
        const prepared = await getAgentSession(client, request.agentSessionId)
        const message = desktopMessages.agentHibernation
        const confirmation = await showMessageBox(window, {
          type: 'warning',
          buttons: [message.cancel, message.confirm],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: message.title,
          message: message.message,
          detail: preflight.checkpoint
            ? `${message.detail} ${message.checkpointDetail}`
            : message.detail
        })
        validate(event)
        const current = await getAgentSession(client, request.agentSessionId)
        const cancel = async (): Promise<void> => {
          await client.cancelAgentHibernation({
            agentSessionId: request.agentSessionId,
            operation: agentOperation(
              'agent.hibernate.cancel',
              request,
              current.revision,
              current.attemptEpoch
            )
          })
        }
        if (confirmation.response !== 1 || !isWindowEntryCurrent(entry)) {
          await cancel()
          return null
        }
        const currentProvider = dependencies.getDesktopProviderIdentity?.()
        if (
          current.revision !== prepared.revision ||
          !sameProviderIdentity(currentProvider, preflight.challenge.provider) ||
          preflight.challenge.window.windowId !== entry.windowId ||
          preflight.challenge.window.windowGeneration !== entry.generation
        ) {
          await cancel()
          throw new Error('The agent session revision or desktop authority is stale')
        }
        return agentHibernationMutationResultSchema.parse(
          await client.confirmAgentHibernation({
            agentSessionId: request.agentSessionId,
            confirmationId: preflight.challenge.confirmationId,
            choice: preflight.challenge.choice,
            provider: preflight.challenge.provider,
            window: preflight.challenge.window,
            nonce: preflight.challenge.nonce,
            expiresAtMs: preflight.challenge.expiresAtMs,
            operation: agentOperation(
              'agent.hibernate.confirm',
              request,
              current.revision,
              current.attemptEpoch
            )
          })
        )
      }
    )
  })
  host.handle(DESKTOP_IPC.agentTeamCreate, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentTeamCreateRequestSchema.parse(rawRequest)
    const catalog = await client.listAgentCatalog({ catalogVersion: 1 })
    return agentTeamMutationResultSchema.parse(
      await client.createAgentTeam({
        teamId: randomUUID(),
        title: request.title,
        mutation: agentCatalogMutation('agent.team.create', request, catalog.revision)
      })
    )
  })
  host.handle(DESKTOP_IPC.agentTeamDelete, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentTeamDeleteRequestSchema.parse(rawRequest)
    await exactAgentTeam(
      client,
      request.teamId,
      request.expectedCatalogRevision,
      request.expectedTeamRevision
    )
    return agentTeamMutationResultSchema.parse(
      await client.deleteAgentTeam({
        teamId: request.teamId,
        mutation: agentTeamMutation('agent.team.delete', request)
      })
    )
  })
  host.handle(DESKTOP_IPC.agentTeamMemberCreate, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentTeamMemberCreateRequestSchema.parse(rawRequest)
    await exactAgentTeam(
      client,
      request.teamId,
      request.expectedCatalogRevision,
      request.expectedTeamRevision
    )
    const session = await getAgentSession(client, request.agentSessionId)
    return agentTeamMemberMutationResultSchema.parse(
      await client.createAgentTeamMember({
        teamId: request.teamId,
        memberId: randomUUID(),
        role: request.role,
        target: session.binding,
        ...(request.parentMemberId ? { parentMemberId: request.parentMemberId } : {}),
        mutation: agentTeamMutation('agent.team.member.create', request)
      })
    )
  })
  host.handle(DESKTOP_IPC.agentTeamMemberDelete, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentTeamMemberDeleteRequestSchema.parse(rawRequest)
    const team = await exactAgentTeam(
      client,
      request.teamId,
      request.expectedCatalogRevision,
      request.expectedTeamRevision
    )
    const member = team.members.find(({ memberId }) => memberId === request.memberId)
    if (!member || member.revision !== request.expectedMemberRevision) {
      throw new Error('The agent team member revision is stale')
    }
    return agentTeamMemberMutationResultSchema.parse(
      await client.deleteAgentTeamMember({
        teamId: request.teamId,
        memberId: request.memberId,
        mutation: {
          ...agentTeamMutation('agent.team.member.delete', request),
          expectedMemberRevision: request.expectedMemberRevision
        }
      })
    )
  })
  host.handle(DESKTOP_IPC.agentTeamMemberUpdate, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentTeamMemberUpdateRequestSchema.parse(rawRequest)
    await exactAgentTeamMember(client, request)
    return agentTeamMemberMutationResultSchema.parse(
      await client.updateAgentTeamMember({
        teamId: request.teamId,
        memberId: request.memberId,
        role: request.role,
        ...(request.parentMemberId ? { parentMemberId: request.parentMemberId } : {}),
        mutation: {
          ...agentTeamMutation('agent.team.member.update', request),
          expectedMemberRevision: request.expectedMemberRevision
        }
      })
    )
  })
  host.handle(DESKTOP_IPC.agentTeamMemberMove, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentTeamMemberMoveRequestSchema.parse(rawRequest)
    await exactAgentTeamMember(client, request)
    const session = await getAgentSession(client, request.agentSessionId)
    return agentTeamMemberMutationResultSchema.parse(
      await client.moveAgentTeamMember({
        teamId: request.teamId,
        memberId: request.memberId,
        target: session.binding,
        mutation: {
          ...agentTeamMutation('agent.team.member.move', request),
          expectedMemberRevision: request.expectedMemberRevision
        }
      })
    )
  })
  host.handle(DESKTOP_IPC.agentAttentionSet, async (event, rawRequest: unknown) => {
    validate(event)
    const request = desktopAgentAttentionRequestSchema.parse(rawRequest)
    const session = await exactAgentSession(client, {
      agentSessionId: request.agentSessionId,
      expectedRevision: request.expectedSessionRevision
    })
    const catalog = await client.listAgentCatalog({ catalogVersion: 1 })
    const existing = catalog.attention.find(
      ({ target }) => target.target.agentSessionId === request.agentSessionId
    )
    if ((existing?.revision ?? null) !== request.expectedAttentionRevision) {
      throw new Error('The agent attention revision is stale')
    }
    return agentAttentionSetResultSchema.parse(
      await client.setAgentAttention({
        target: {
          target: session.binding,
          ...(session.teamId && session.memberId
            ? { teamId: session.teamId, memberId: session.memberId }
            : {})
        },
        state: request.state,
        expectedAttentionRevision: request.expectedAttentionRevision,
        operation: agentOperation(
          'agent.attention.set',
          request,
          session.revision,
          session.attemptEpoch
        )
      })
    )
  })
  host.handle(DESKTOP_IPC.openExternal, async (event, rawUrl: unknown) => {
    validate(event)
    if (typeof rawUrl !== 'string' || !isSafeRemoteUrl(rawUrl)) {
      throw new Error('Invalid external URL')
    }
    validateVoid(await shell.openExternal(rawUrl))
  })
  return handlers
}

function remoteMutation(namespace: string, payload: unknown, expectedRevision: number) {
  return {
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(JSON.stringify({ namespace, payload })).digest('hex'),
    expectedRevision
  }
}

function agentOperation(
  namespace: string,
  payload: unknown,
  sessionRevision: number,
  attemptEpoch: number
) {
  return {
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(JSON.stringify({ namespace, payload })).digest('hex'),
    sessionRevision,
    attemptEpoch
  }
}

function agentCatalogMutation(
  namespace: string,
  payload: unknown,
  expectedCatalogRevision: number
) {
  return {
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(JSON.stringify({ namespace, payload })).digest('hex'),
    expectedCatalogRevision
  }
}

function agentTeamMutation(
  namespace: string,
  payload: {
    expectedCatalogRevision: number
    expectedTeamRevision: number
  }
) {
  return {
    ...agentCatalogMutation(namespace, payload, payload.expectedCatalogRevision),
    expectedTeamRevision: payload.expectedTeamRevision
  }
}

async function getAgentSession(client: ControlClient, agentSessionId: string) {
  return agentCatalogGetResultSchema.parse(await client.getAgentSession({ agentSessionId })).session
}

async function exactAgentSession(
  client: ControlClient,
  request: { agentSessionId: string; expectedRevision: number }
): Promise<AgentSessionSnapshot> {
  const session = await getAgentSession(client, request.agentSessionId)
  if (session.revision !== request.expectedRevision) {
    throw new Error('The agent session revision is stale')
  }
  return session
}

async function exactAgentTeam(
  client: ControlClient,
  teamId: string,
  expectedCatalogRevision: number,
  expectedTeamRevision: number
) {
  const catalog = agentCatalogListResultSchema.parse(
    await client.listAgentCatalog({ catalogVersion: 1 })
  )
  const team = catalog.teams.find((candidate) => candidate.teamId === teamId)
  if (catalog.revision !== expectedCatalogRevision || team?.revision !== expectedTeamRevision) {
    throw new Error('The agent team revision is stale')
  }
  return team
}

async function exactAgentTeamMember(
  client: ControlClient,
  request: {
    teamId: string
    memberId: string
    expectedCatalogRevision: number
    expectedTeamRevision: number
    expectedMemberRevision: number
  }
) {
  const team = await exactAgentTeam(
    client,
    request.teamId,
    request.expectedCatalogRevision,
    request.expectedTeamRevision
  )
  const member = team.members.find(({ memberId }) => memberId === request.memberId)
  if (!member || member.revision !== request.expectedMemberRevision) {
    throw new Error('The agent team member revision is stale')
  }
  return member
}

function sameProviderIdentity(
  left: DesktopProviderIdentityParams | undefined,
  right: DesktopProviderIdentityParams
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.providerEpoch === right.providerEpoch &&
    left.leaseId === right.leaseId
  )
}

function rethrowProtocolError(error: unknown): never {
  if (error instanceof ControlRequestError) {
    throw new Error(`[agent-workspace-protocol-error:${error.code}] ${error.message}`, {
      cause: error
    })
  }
  throw error
}

interface Parser<T> {
  parse(value: unknown): T
}

function registerReconciledMutation<TParsed>(
  channel: string,
  window: BrowserWindow,
  inputSchema: Parser<TParsed>,
  invoke: (params: TParsed) => Promise<unknown>,
  browserViews: BrowserViewManager,
  apply?: (params: TParsed, result: MutationResult) => void
): void {
  requireCollectingHost().handle(channel, async (event, rawParams: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unauthorized desktop IPC sender')
    }
    const params = inputSchema.parse(rawParams)
    const result = mutationResultSchema.parse(await invoke(params)) as MutationResult
    if (apply) apply(params, result)
    else browserViews.reconcileMutation(result)
    return result
  })
}

function registerBrowserCommand<TParsed extends { browserSessionId: string }>(
  channel: string,
  window: BrowserWindow,
  inputSchema: Parser<TParsed>,
  invoke: (params: TParsed) => Promise<unknown>,
  browserViews: BrowserViewManager,
  action: BrowserLiveAction
): void {
  registerReconciledMutation(
    channel,
    window,
    inputSchema,
    invoke,
    browserViews,
    (params, result) => {
      browserViews.applyCommandMutation(result, params.browserSessionId, action)
    }
  )
}

function registerMutation<TParsed>(
  channel: string,
  window: BrowserWindow,
  inputSchema: Parser<TParsed>,
  invoke: (params: never) => Promise<unknown>
): void {
  requireCollectingHost().handle(channel, async (event, rawParams: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unauthorized desktop IPC sender')
    }
    return mutationResultSchema.parse(await invoke(inputSchema.parse(rawParams) as never))
  })
}

function registerLayoutMutation<TParsed>(
  channel: string,
  window: BrowserWindow,
  inputSchema: Parser<TParsed>,
  invoke: (params: TParsed) => Promise<unknown>
): void {
  requireCollectingHost().handle(channel, async (event, rawParams: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unauthorized desktop IPC sender')
    }
    return layoutMutationResultSchema.parse(await invoke(inputSchema.parse(rawParams)))
  })
}

function parseTerminalId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error('Invalid terminal identifier')
  }
  return value
}

function validateVoid(value: unknown): void {
  if (value !== undefined) throw new Error('Desktop operation returned an unexpected result')
}

export function removeDesktopHandlers(): void {
  for (const channel of DESKTOP_INVOKE_CHANNELS) ipcMain.removeHandler(channel)
}

export function forwardDesktopEvents(
  window: BrowserWindow,
  client: ControlClient,
  observeOwnershipTransfer?: (
    resourceId: string,
    transferEpoch: number,
    sourceWindowId: string,
    targetWindowId: string
  ) => void
): () => void {
  const removers = [
    client.onTerminalEvent((event) => {
      if (!window.isDestroyed())
        window.webContents.send(DESKTOP_IPC.terminalEvent, terminalEventSchema.parse(event))
    }),
    client.onDomainEvent((event) => {
      if (!window.isDestroyed())
        window.webContents.send(DESKTOP_IPC.domainEvent, domainEventSchema.parse(event))
    }),
    client.onWorkspaceCardSlotsEvent((event) => {
      if (!window.isDestroyed())
        window.webContents.send(
          DESKTOP_IPC.workspaceCardSlotsEvent,
          workspaceCardSlotsChangedEventSchema.parse(event)
        )
    }),
    client.onWorkspaceCardSlotV2Event((event) => {
      if (!window.isDestroyed())
        window.webContents.send(
          DESKTOP_IPC.workspaceCardSlotV2Event,
          workspaceCardSlotV2ChangedEventSchema.parse(event)
        )
    }),
    client.onWorkspaceAttentionEvent((event) => {
      if (!window.isDestroyed())
        window.webContents.send(
          DESKTOP_IPC.workspaceAttentionEvent,
          workspaceAttentionChangedEventSchema.parse(event)
        )
    }),
    client.onDomainResyncRequired((notice) => {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.domainResyncRequired, notice)
    }),
    client.onServiceEvent((event) => {
      if (!window.isDestroyed())
        window.webContents.send(DESKTOP_IPC.serviceEvent, serviceEventSchema.parse(event))
    }),
    typeof client.onActionRegistryChanged === 'function'
      ? client.onActionRegistryChanged((event) => {
          if (!window.isDestroyed())
            window.webContents.send(
              DESKTOP_IPC.actionRegistryChanged,
              actionRegistryChangedEventSchema.parse(event)
            )
        })
      : () => undefined,
    client.onMultiWindowEvent((event) => {
      const parsed = multiWindowEventSchema.parse(event)
      if (parsed.event === 'tab.ownershipTransferred') {
        // Register the main-owned provider barrier synchronously before this event
        // can trigger a renderer projection refresh.
        try {
          observeOwnershipTransfer?.(
            parsed.runtimeSessionId,
            parsed.transferEpoch,
            parsed.source.windowId,
            parsed.target.windowId
          )
        } catch {
          // Fail closed: an event without a main-owned barrier must not trigger a
          // renderer acquisition, but a bounded-state conflict must not crash main.
          return
        }
      }
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.multiWindowEvent, parsed)
    })
  ]
  return () => removers.forEach((remove) => remove())
}

function createSenderValidator(window: BrowserWindow): (event: IpcMainInvokeEvent) => void {
  return (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unauthorized desktop IPC sender')
    }
  }
}

function requireReadyClient(
  controller: DesktopLifecycleController,
  binding: WindowRegistryBinding
): ControlClient {
  if (controller.getState().status !== 'ready') {
    throw new Error('The local service is not ready')
  }
  return readyWindowClient(binding)
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function datedFilename(kind: string, extension: string): string {
  return `agent-workspace-private-${kind}-${new Date().toISOString().slice(0, 10)}.${extension}`
}

const MAX_SAVED_LAYOUT_FILE_BYTES = 256 * 1024
const NOFOLLOW_FILE_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

export async function readSavedLayout(path: string): Promise<string> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('The saved-layout source is not a regular file')
  }
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW_FILE_FLAG)
  try {
    const metadata = await handle.stat()
    const after = await lstat(path)
    if (
      !metadata.isFile() ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      metadata.dev !== after.dev ||
      metadata.ino !== after.ino
    ) {
      throw new Error('The saved-layout source changed while it was being opened')
    }
    if (metadata.size > MAX_SAVED_LAYOUT_FILE_BYTES) {
      throw new Error('The saved-layout document exceeds 256 KiB')
    }
    const buffer = Buffer.alloc(MAX_SAVED_LAYOUT_FILE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_SAVED_LAYOUT_FILE_BYTES) {
      throw new Error('The saved-layout document exceeds 256 KiB')
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function constrainSidebarWidth(requestedWidth: number, contentWidth: number): number {
  const responsiveMaximum = contentWidth <= 700 ? contentWidth : Math.floor(contentWidth * 0.45)
  return Math.max(240, Math.min(720, responsiveMaximum, requestedWidth))
}

export async function atomicWriteSavedLayout(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > MAX_SAVED_LAYOUT_FILE_BYTES) {
    throw new Error('The saved-layout document exceeds 256 KiB')
  }
  try {
    const destination = await lstat(path)
    if (destination.isSymbolicLink() || !destination.isFile()) {
      throw new Error('The saved-layout destination is not a regular file')
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let temporaryPresent = false
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FILE_FLAG,
      0o600
    )
    temporaryPresent = true
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
    temporaryPresent = false
  } finally {
    if (temporaryPresent) await unlink(temporaryPath).catch(() => undefined)
  }
}

const MAX_SEARCH_EXPORT_BYTES = 64 * 1024

export async function atomicWriteSearchExport(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > MAX_SEARCH_EXPORT_BYTES) {
    throw new Error('The search export exceeds 64 KiB')
  }
  try {
    const destination = await lstat(path)
    if (destination.isSymbolicLink() || !destination.isFile()) {
      throw new Error('The search export destination is not a regular file')
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let temporaryPresent = false
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FILE_FLAG,
      0o600
    )
    temporaryPresent = true
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
    temporaryPresent = false
  } finally {
    if (temporaryPresent) await unlink(temporaryPath).catch(() => undefined)
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
