import { contextBridge, ipcRenderer } from 'electron'

import {
  actionInvocationSnapshotSchema,
  actionListResultSchema,
  agentAttentionSetResultSchema,
  agentCatalogListResultSchema,
  agentCatalogRegisterResultSchema,
  agentHibernationMutationResultSchema,
  agentRestoreAssessResultSchema,
  agentSessionForkResultSchema,
  agentSessionRestoreResultSchema,
  agentTeamMemberMutationResultSchema,
  agentTeamMutationResultSchema,
  actionRegistryChangedEventSchema,
  attentionAcknowledgementParamsSchema,
  attentionAcknowledgementResultSchema,
  advancedTabMutationResultSchema,
  advancedTabCloseResultSchema,
  browserBackParamsSchema,
  browserForwardParamsSchema,
  browserNavigateParamsSchema,
  browserOpenDevToolsParamsSchema,
  browserPlaceholderMetadataSchema,
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
  settingsGetResultSchema,
  settingsResetKeyParamsSchema,
  settingsUpdateParamsSchema,
  serviceEventSchema,
  paneCloseParamsSchema,
  paneFocusParamsSchema,
  paneMoveTabParamsSchema,
  paneResizeParamsSchema,
  paneSplitParamsSchema,
  tabCloseParamsSchema,
  tabCloseAdvancedParamsSchema,
  tabDetachParamsSchema,
  tabDuplicateParamsSchema,
  tabMoveExactParamsSchema,
  tabReopenParamsSchema,
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
  workspaceUpdateParamsSchema,
  windowCloseParamsSchema,
  windowCreateParamsSchema,
  windowFocusParamsSchema,
  windowListResultSchema,
  windowMutationResultSchema,
  windowCloseResultSchema,
  remoteSessionListResultSchema,
  remoteSessionResultSchema,
  remoteTargetListResultSchema,
  remoteTargetResultSchema,
  remoteTmuxDiscoveryResultSchema,
  type ConfigurationGetResult,
  type ActionInvocationSnapshot,
  type ActionListResult,
  type AttentionAcknowledgementResult,
  type AdvancedTabMutationResult,
  type MutationResult,
  type NotificationListResult,
  type TerminalAttachResult,
  type WorkspaceListResult,
  type WorkspaceOrganizationGetResult,
  type LayoutGetResult,
  type WorkspaceAttentionSnapshot,
  type WorkspaceSnapshotResult,
  type WindowCloseResult,
  type RemoteSessionListResult,
  type RemoteSessionResult,
  type RemoteTargetListResult
} from '@agent-workspace/protocol-client'
import {
  contentDiffParamsSchema,
  contentDiffResultSchema,
  contentDocumentIssueParamsSchema,
  contentDocumentIssueResultSchema,
  contentMarkdownParamsSchema,
  contentPreviewSchema,
  contentReadParamsSchema,
  contentSaveResultSchema,
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
  workspaceRootListResultSchema,
  type SafeMarkdownDocument
} from '@agent-workspace/protocol-client'

import {
  DESKTOP_IPC,
  parseBrowserViewBoundsParams,
  parseBrowserViewMountParams,
  parseBrowserViewSessionParams,
  parseDesktopLifecycleState,
  parseDesktopUpdateState,
  parseWorkspaceRuntimeMetadata,
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
  desktopSearchExportRequestSchema,
  desktopSearchRebuildRequestSchema,
  desktopSearchSourceRequestSchema,
  desktopSidebarSelectionSchema,
  desktopTaskActionRequestSchema,
  desktopTextBoxCreateRequestSchema,
  desktopTextBoxDeleteRequestSchema,
  desktopTextBoxSaveRequestSchema,
  desktopContentSaveRequestSchema,
  desktopWorkspacePathOpenersSchema,
  desktopWorkspacePathOpenRequestSchema,
  savedLayoutImportRequestSchema,
  desktopActionInvokeRequestSchema,
  type DesktopBridge,
  type DomainResyncNotice
} from '@agent-workspace/contracts/desktop/desktop-bridge'
import {
  parseApplicationMenuCommandId,
  parseApplicationMenuState
} from '@agent-workspace/contracts/desktop/application-menu'

const PROTOCOL_ERROR_PATTERN = /\[agent-workspace-protocol-error:([a-z0-9_]+)\]\s*(.*)$/u

function preserveProtocolError(error: unknown): never {
  if (error instanceof Error) {
    const match = PROTOCOL_ERROR_PATTERN.exec(error.message)
    if (match?.[1]) {
      throw Object.assign(new Error(match[2] || 'The local control service rejected the request'), {
        code: match[1]
      })
    }
  }
  throw error
}

const parseTerminalId = (value: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('Invalid terminal identifier')
  }
  return value
}

const invokeVoid = async (channel: string, ...args: unknown[]): Promise<void> => {
  const result: unknown = await ipcRenderer.invoke(channel, ...args)
  if (result !== undefined) throw new Error('Desktop IPC returned an unexpected result')
}

const invokeVoidOrNull = async (channel: string, ...args: unknown[]): Promise<void | null> => {
  const result: unknown = await ipcRenderer.invoke(channel, ...args)
  if (result === null) return null
  if (result !== undefined) throw new Error('Desktop IPC returned an unexpected result')
}

const invokeMutation = async (channel: string, params: unknown): Promise<MutationResult> =>
  mutationResultSchema.parse(await ipcRenderer.invoke(channel, params)) as MutationResult

const parseAdvancedTabMutationResult = (value: unknown): AdvancedTabMutationResult =>
  advancedTabMutationResultSchema.parse(value) as unknown as AdvancedTabMutationResult

const desktopBridge = Object.freeze({
  getLifecycleState: async () =>
    parseDesktopLifecycleState(await ipcRenderer.invoke(DESKTOP_IPC.lifecycleGet)),
  restartService: async () => invokeVoid(DESKTOP_IPC.serviceRestart),
  exportRecoveryDatabase: async () => {
    const result: unknown = await ipcRenderer.invoke(DESKTOP_IPC.recoveryExportDatabase)
    return result === null ? null : recoveryExportResultSchema.parse(result)
  },
  previewDiagnostics: async () =>
    diagnosticBundlePreviewSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.diagnosticsPreview)),
  exportDiagnostics: async (approvedPreview) =>
    invokeVoidOrNull(
      DESKTOP_IPC.diagnosticsExport,
      diagnosticBundlePreviewSchema.parse(approvedPreview)
    ),
  getConfiguration: async () =>
    configurationGetResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.configurationGet)
    ) as ConfigurationGetResult,
  updateConfiguration: async (params) =>
    configurationGetResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.configurationUpdate,
        configurationUpdateParamsSchema.parse(params)
      )
    ) as ConfigurationGetResult,
  quitApplication: async () => invokeVoid(DESKTOP_IPC.applicationQuit),
  getUpdateState: async () =>
    parseDesktopUpdateState(await ipcRenderer.invoke(DESKTOP_IPC.updateGetState)),
  checkForUpdate: async () =>
    parseDesktopUpdateState(await ipcRenderer.invoke(DESKTOP_IPC.updateCheck)),
  downloadUpdate: async () =>
    parseDesktopUpdateState(await ipcRenderer.invoke(DESKTOP_IPC.updateDownload)),
  installUpdate: async () => invokeVoid(DESKTOP_IPC.updateInstall),
  setApplicationMenuState: async (state) =>
    invokeVoid(DESKTOP_IPC.applicationMenuUpdate, parseApplicationMenuState(state)),
  onLifecycleState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawState: unknown): void =>
      listener(parseDesktopLifecycleState(rawState))
    ipcRenderer.on(DESKTOP_IPC.lifecycleChanged, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.lifecycleChanged, handler)
  },
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawState: unknown): void =>
      listener(parseDesktopUpdateState(rawState))
    ipcRenderer.on(DESKTOP_IPC.updateStateChanged, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.updateStateChanged, handler)
  },
  onApplicationMenuCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawCommandId: unknown): void =>
      listener(parseApplicationMenuCommandId(rawCommandId))
    ipcRenderer.on(DESKTOP_IPC.applicationMenuCommand, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.applicationMenuCommand, handler)
  },
  identify: async () => identifyResultSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.identify)),
  listPublicActions: async () =>
    actionListResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.actionList)
    ) as unknown as ActionListResult,
  invokePublicAction: async (params) => {
    try {
      return actionInvocationSnapshotSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC.actionInvoke,
          desktopActionInvokeRequestSchema.parse(params)
        )
      ) as unknown as ActionInvocationSnapshot
    } catch (error) {
      preserveProtocolError(error)
    }
  },
  listWindows: async () =>
    windowListResultSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.windowList)),
  createWindow: async (params) =>
    windowMutationResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.windowCreate, windowCreateParamsSchema.parse(params))
    ),
  closeWindow: async (params) =>
    windowCloseResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.windowClose, windowCloseParamsSchema.parse(params))
    ) as unknown as WindowCloseResult,
  focusWindow: async (params) =>
    windowMutationResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.windowFocus, windowFocusParamsSchema.parse(params))
    ),
  duplicateTab: async (params) =>
    parseAdvancedTabMutationResult(
      await ipcRenderer.invoke(DESKTOP_IPC.tabDuplicate, tabDuplicateParamsSchema.parse(params))
    ),
  moveTabExact: async (params) =>
    parseAdvancedTabMutationResult(
      await ipcRenderer.invoke(DESKTOP_IPC.tabMoveExact, tabMoveExactParamsSchema.parse(params))
    ),
  detachTab: async (params) =>
    parseAdvancedTabMutationResult(
      await ipcRenderer.invoke(DESKTOP_IPC.tabDetach, tabDetachParamsSchema.parse(params))
    ),
  closeTabAdvanced: async (params) =>
    advancedTabCloseResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.tabCloseAdvanced,
        tabCloseAdvancedParamsSchema.parse(params)
      )
    ),
  reopenTab: async (params) =>
    parseAdvancedTabMutationResult(
      await ipcRenderer.invoke(DESKTOP_IPC.tabReopen, tabReopenParamsSchema.parse(params))
    ),
  listClosedItems: async () =>
    closedItemListResultSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.closedList)),
  getClosedItem: async (params) =>
    closedItemGetResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.closedGet, closedItemGetParamsSchema.parse(params))
    ),
  navigateFocusHistory: async (params) =>
    focusHistoryNavigateResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.focusHistoryNavigate,
        focusHistoryNavigateParamsSchema.parse(params)
      )
    ),
  listWorkspaces: async () =>
    workspaceListResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.workspaceList)
    ) as WorkspaceListResult,
  getWorkspaceOrganization: async () => {
    const result: unknown = await ipcRenderer.invoke(DESKTOP_IPC.workspaceOrganizationGet)
    return result === null
      ? null
      : (workspaceOrganizationGetResultSchema.parse(result) as WorkspaceOrganizationGetResult)
  },
  listSavedLayouts: async () => {
    const result: unknown = await ipcRenderer.invoke(DESKTOP_IPC.layoutList)
    return result === null ? null : layoutListResultSchema.parse(result)
  },
  getSavedLayout: async (params) =>
    layoutGetResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.layoutGet, layoutGetParamsSchema.parse(params))
    ) as LayoutGetResult,
  saveLayout: async (params) =>
    layoutMutationResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.layoutSave, layoutSaveParamsSchema.parse(params))
    ),
  deleteLayout: async (params) =>
    layoutMutationResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.layoutDelete, layoutDeleteParamsSchema.parse(params))
    ),
  applyLayout: async (params) =>
    layoutMutationResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.layoutApply, layoutApplyParamsSchema.parse(params))
    ),
  exportSavedLayoutToFile: async (params) => {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC.layoutExportFile,
      layoutExportParamsSchema.parse(params)
    )
    if (typeof result !== 'boolean') throw new Error('Invalid saved-layout export result')
    return result
  },
  importSavedLayoutFromFile: async (params) => {
    const request = savedLayoutImportRequestSchema.parse(params)
    const result: unknown = await ipcRenderer.invoke(DESKTOP_IPC.layoutImportFile, request)
    return result === null ? null : layoutMutationResultSchema.parse(result)
  },
  snapshotWorkspace: async (params) =>
    // The generated schema exposes exact-optional fields as `T | undefined`, while the
    // bridge contract models them as absent-or-T. Runtime parsing still guarantees T.
    workspaceSnapshotResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.workspaceSnapshot,
        workspaceSnapshotParamsSchema.parse(params)
      )
    ) as unknown as WorkspaceSnapshotResult,
  getSidebarPlacement: async () =>
    sidebarPlacementSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.sidebarPlacementGet)),
  saveSidebarPlacement: async (params) =>
    sidebarPlacementSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.sidebarPlacementSave,
        desktopSidebarSelectionSchema.parse(params)
      )
    ),
  listTextBoxes: async () =>
    textBoxListResultSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.textBoxList)),
  createTextBox: async (params) =>
    textBoxDocumentSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.textBoxCreate,
        desktopTextBoxCreateRequestSchema.parse(params)
      )
    ),
  saveTextBox: async (params) =>
    textBoxDocumentSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.textBoxSave,
        desktopTextBoxSaveRequestSchema.parse(params)
      )
    ),
  deleteTextBox: async (params) =>
    textBoxDocumentSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.textBoxDelete,
        desktopTextBoxDeleteRequestSchema.parse(params)
      )
    ),
  listContentRoots: async () =>
    workspaceRootListResultSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.contentRootList)),
  listContentDirectory: async (params) =>
    workspaceDirectoryListResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.contentDirectoryList,
        workspaceDirectoryListParamsSchema.parse(params)
      )
    ),
  issueContentDocument: async (params) =>
    contentDocumentIssueResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.contentDocumentIssue,
        contentDocumentIssueParamsSchema.parse(params)
      )
    ),
  readContent: async (params) =>
    contentPreviewSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.contentRead, contentReadParamsSchema.parse(params))
    ),
  saveContent: async (params) =>
    contentSaveResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.contentSave,
        desktopContentSaveRequestSchema.parse(params)
      )
    ),
  renderMarkdown: async (params) =>
    // Recursive markdown node inference is `unknown[]`; the parser validates every node.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    safeMarkdownDocumentSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.contentMarkdown,
        contentMarkdownParamsSchema.parse(params)
      )
    ) as unknown as SafeMarkdownDocument,
  diffContent: async (params) =>
    contentDiffResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.contentDiff, contentDiffParamsSchema.parse(params))
    ),
  searchContent: async (params) =>
    searchQueryResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.searchQuery, searchQueryParamsSchema.parse(params))
    ),
  setSearchConsent: async (params) =>
    searchControlResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.searchConsent,
        desktopSearchConsentRequestSchema.parse(params)
      )
    ),
  excludeSearchSource: async (params) =>
    searchControlResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.searchExclude,
        desktopSearchSourceRequestSchema.parse(params)
      )
    ),
  forgetSearchSource: async (params) =>
    searchControlResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.searchForget,
        desktopSearchSourceRequestSchema.parse(params)
      )
    ),
  rebuildSearchSource: async (params) =>
    searchControlResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.searchRebuild,
        desktopSearchRebuildRequestSchema.parse(params)
      )
    ),
  exportSearchSource: async (params) => {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC.searchExport,
      desktopSearchExportRequestSchema.parse(params)
    )
    if (typeof result !== 'boolean') throw new Error('Invalid search export result')
    return result
  },
  listTasks: async (params) =>
    taskListResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.taskList, taskListParamsSchema.parse(params))
    ),
  actOnTask: async (params) => {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC.taskAction,
      desktopTaskActionRequestSchema.parse(params)
    )
    return result === null ? null : taskActionResultSchema.parse(result)
  },
  listRecentlyClosed: async () =>
    recentlyClosedListResultSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.recentlyClosedList)),
  reopenRecentlyClosed: async (params) =>
    parseAdvancedTabMutationResult(
      await ipcRenderer.invoke(
        DESKTOP_IPC.recentlyClosedReopen,
        desktopRecentlyClosedReopenRequestSchema.parse(params)
      )
    ),
  getWorkspaceCardSlots: async (params) =>
    workspaceCardSlotsSnapshotSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.workspaceCardSlotsGet,
        workspaceCardSlotsSnapshotParamsSchema.parse(params)
      )
    ),
  replaceWorkspaceCardSlots: async (params) => {
    try {
      return workspaceCardSlotsSnapshotSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC.workspaceCardSlotsReplace,
          workspaceCardSlotsReplaceParamsSchema.parse(params)
        )
      )
    } catch (error) {
      preserveProtocolError(error)
    }
  },
  getWorkspaceCardSlotV2: async (params) =>
    workspaceCardSlotV2SnapshotSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.workspaceCardSlotV2Get,
        workspaceCardSlotV2GetParamsSchema.parse(params)
      )
    ),
  replaceWorkspaceCardSlotV2: async (params) => {
    try {
      return workspaceCardSlotV2SnapshotSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC.workspaceCardSlotV2Replace,
          workspaceCardSlotV2ReplaceParamsSchema.parse(params)
        )
      )
    } catch (error) {
      preserveProtocolError(error)
    }
  },
  getWorkspaceAttention: async (params) =>
    workspaceAttentionSnapshotSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.workspaceAttentionGet,
        workspaceAttentionSnapshotParamsSchema.parse(params)
      )
    ) as WorkspaceAttentionSnapshot,
  acknowledgeAttention: async (params) => {
    try {
      return attentionAcknowledgementResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_IPC.attentionAcknowledge,
          attentionAcknowledgementParamsSchema.parse(params)
        )
      ) as AttentionAcknowledgementResult
    } catch (error) {
      preserveProtocolError(error)
    }
  },
  getWorkspaceRuntimeMetadata: async (params) =>
    parseWorkspaceRuntimeMetadata(
      await ipcRenderer.invoke(
        DESKTOP_IPC.workspaceRuntimeMetadata,
        workspaceSnapshotParamsSchema.parse(params)
      )
    ),
  pickWorkspaceDirectory: async () => {
    const result: unknown = await ipcRenderer.invoke(DESKTOP_IPC.workspacePickDirectory)
    if (result === null) return null
    if (
      typeof result !== 'string' ||
      result.length < 1 ||
      result.length > 4096 ||
      result !== result.trim() ||
      /[\p{Cc}\p{Cf}]/u.test(result)
    ) {
      throw new Error('Invalid workspace directory selection')
    }
    return result
  },
  listWorkspacePathOpeners: async () =>
    desktopWorkspacePathOpenersSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.workspacePathOpeners)
    ),
  openWorkspacePath: async (params) =>
    invokeVoid(DESKTOP_IPC.workspacePathOpen, desktopWorkspacePathOpenRequestSchema.parse(params)),
  createWorkspace: async (params) =>
    invokeMutation(DESKTOP_IPC.workspaceCreate, workspaceCreateParamsSchema.parse(params)),
  updateWorkspace: async (params) =>
    invokeMutation(DESKTOP_IPC.workspaceUpdate, workspaceUpdateParamsSchema.parse(params)),
  selectWorkspace: async (params) =>
    invokeMutation(DESKTOP_IPC.workspaceSelect, workspaceSelectParamsSchema.parse(params)),
  moveWorkspace: async (params) =>
    invokeMutation(DESKTOP_IPC.workspaceMove, workspaceMoveParamsSchema.parse(params)),
  closeWorkspace: async (params) =>
    invokeMutation(DESKTOP_IPC.workspaceClose, workspaceCloseParamsSchema.parse(params)),
  selectWorkspaces: async (params) =>
    invokeMutation(
      DESKTOP_IPC.workspaceSelectMany,
      workspaceSelectionReplaceParamsSchema.parse(params)
    ),
  pinWorkspace: async (params) =>
    invokeMutation(DESKTOP_IPC.workspacePin, workspacePinParamsSchema.parse(params)),
  closeSelectedWorkspaces: async (params) =>
    invokeMutation(
      DESKTOP_IPC.workspaceCloseSelected,
      workspaceBatchCloseParamsSchema.parse(params)
    ),
  reorderWorkspace: async (params) =>
    invokeMutation(DESKTOP_IPC.workspaceReorder, workspaceCanonicalMoveParamsSchema.parse(params)),
  createGroup: async (params) =>
    invokeMutation(DESKTOP_IPC.groupCreate, groupCreateParamsSchema.parse(params)),
  renameGroup: async (params) =>
    invokeMutation(DESKTOP_IPC.groupRename, groupRenameParamsSchema.parse(params)),
  deleteGroup: async (params) =>
    invokeMutation(DESKTOP_IPC.groupDelete, groupDeleteParamsSchema.parse(params)),
  moveGroup: async (params) =>
    invokeMutation(DESKTOP_IPC.groupMove, groupMoveParamsSchema.parse(params)),
  assignWorkspaceGroup: async (params) =>
    invokeMutation(DESKTOP_IPC.groupAssign, groupAssignParamsSchema.parse(params)),
  collapseGroup: async (params) =>
    invokeMutation(DESKTOP_IPC.groupCollapse, groupCollapseParamsSchema.parse(params)),
  splitPane: async (params) =>
    invokeMutation(DESKTOP_IPC.paneSplit, paneSplitParamsSchema.parse(params)),
  focusPane: async (params) =>
    invokeMutation(DESKTOP_IPC.paneFocus, paneFocusParamsSchema.parse(params)),
  resizePane: async (params) =>
    invokeMutation(DESKTOP_IPC.paneResize, paneResizeParamsSchema.parse(params)),
  closePane: async (params) =>
    invokeMutation(DESKTOP_IPC.paneClose, paneCloseParamsSchema.parse(params)),
  moveTabToPane: async (params) =>
    invokeMutation(DESKTOP_IPC.paneMoveTab, paneMoveTabParamsSchema.parse(params)),
  openTerminalTab: async (params) =>
    invokeMutation(DESKTOP_IPC.tabOpenTerminal, tabOpenTerminalParamsSchema.parse(params)),
  openBrowserTab: async (params) =>
    invokeMutation(DESKTOP_IPC.tabOpenBrowser, tabOpenBrowserParamsSchema.parse(params)),
  navigateBrowser: async (params) =>
    invokeMutation(DESKTOP_IPC.browserNavigate, browserNavigateParamsSchema.parse(params)),
  browserBack: async (params) =>
    invokeMutation(DESKTOP_IPC.browserBack, browserBackParamsSchema.parse(params)),
  browserForward: async (params) =>
    invokeMutation(DESKTOP_IPC.browserForward, browserForwardParamsSchema.parse(params)),
  reloadBrowser: async (params) =>
    invokeMutation(DESKTOP_IPC.browserReload, browserReloadParamsSchema.parse(params)),
  stopBrowser: async (params) =>
    invokeMutation(DESKTOP_IPC.browserStop, browserStopParamsSchema.parse(params)),
  openBrowserDevTools: async (params) =>
    invokeMutation(DESKTOP_IPC.browserOpenDevTools, browserOpenDevToolsParamsSchema.parse(params)),
  mountBrowserView: async (params) =>
    invokeVoid(DESKTOP_IPC.browserMountView, parseBrowserViewMountParams(params)),
  unmountBrowserView: async (params) =>
    invokeVoid(DESKTOP_IPC.browserUnmountView, parseBrowserViewSessionParams(params)),
  setBrowserBounds: async (params) =>
    invokeVoid(DESKTOP_IPC.browserSetBounds, parseBrowserViewBoundsParams(params)),
  focusBrowserView: async (params) =>
    invokeVoid(DESKTOP_IPC.browserFocusView, parseBrowserViewSessionParams(params)),
  selectTab: async (params) =>
    invokeMutation(DESKTOP_IPC.tabSelect, tabSelectParamsSchema.parse(params)),
  updateTab: async (params) =>
    invokeMutation(DESKTOP_IPC.tabUpdate, tabUpdateParamsSchema.parse(params)),
  moveTab: async (params) => invokeMutation(DESKTOP_IPC.tabMove, tabMoveParamsSchema.parse(params)),
  closeTab: async (params) =>
    invokeMutation(DESKTOP_IPC.tabClose, tabCloseParamsSchema.parse(params)),
  restartTerminal: async (params) =>
    invokeMutation(DESKTOP_IPC.terminalRestart, terminalRestartParamsSchema.parse(params)),
  listNotifications: async (params = {}) =>
    notificationListResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.notificationList,
        notificationListParamsSchema.parse(params)
      )
    ) as NotificationListResult,
  markNotificationRead: async (params) =>
    invokeMutation(
      DESKTOP_IPC.notificationMarkRead,
      notificationMarkReadParamsSchema.parse(params)
    ),
  markNotificationUnread: async (params) =>
    invokeMutation(
      DESKTOP_IPC.notificationMarkUnread,
      notificationMarkUnreadParamsSchema.parse(params)
    ),
  clearNotifications: async (params) =>
    invokeMutation(DESKTOP_IPC.notificationClear, notificationClearParamsSchema.parse(params)),
  getSettings: async () =>
    settingsGetResultSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.settingsGet)),
  updateSettings: async (params) =>
    invokeMutation(DESKTOP_IPC.settingsUpdate, settingsUpdateParamsSchema.parse(params)),
  resetSettingKey: async (params) =>
    invokeMutation(DESKTOP_IPC.settingsResetKey, settingsResetKeyParamsSchema.parse(params)),
  attachTerminal: async (terminalId) =>
    terminalAttachResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.terminalAttach, parseTerminalId(terminalId))
    ) as TerminalAttachResult,
  detachTerminal: (terminalId) =>
    invokeVoid(DESKTOP_IPC.terminalDetach, parseTerminalId(terminalId)),
  sendTerminalInput: (terminalId, data) => {
    if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > 256 * 1024) {
      return Promise.reject(new Error('Invalid terminal input'))
    }
    return invokeVoid(DESKTOP_IPC.terminalSend, parseTerminalId(terminalId), data)
  },
  resizeTerminal: (terminalId, rows, cols) => {
    const size = terminalCreateParamsSchema.pick({ rows: true, cols: true }).parse({ rows, cols })
    return invokeVoid(DESKTOP_IPC.terminalResize, parseTerminalId(terminalId), size.rows, size.cols)
  },
  checkpointTerminal: (terminalId, checkpoint) =>
    invokeVoid(
      DESKTOP_IPC.terminalCheckpoint,
      parseTerminalId(terminalId),
      terminalCheckpointSchema.parse(checkpoint)
    ),
  listRemoteTargets: async () =>
    remoteTargetListResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.remoteTargetList)
    ) as unknown as RemoteTargetListResult,
  enrollRemoteTarget: async (params) => {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC.remoteTargetEnroll,
      desktopRemoteTargetDraftSchema.parse(params)
    )
    return result === null ? null : remoteTargetResultSchema.parse(result)
  },
  replaceRemoteCredential: async (remoteTargetId) => {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC.remoteCredentialReplace,
      desktopRemoteTargetIdentitySchema.parse({ remoteTargetId })
    )
    if (result === null) return null
    if (result !== true) throw new Error('Desktop IPC returned an unexpected result')
    return true
  },
  deleteRemoteTarget: async (params) => {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC.remoteTargetDelete,
      desktopRemoteTargetDeleteRequestSchema.parse(params)
    )
    return result === null ? null : remoteTargetResultSchema.parse(result)
  },
  listRemoteSessions: async () =>
    remoteSessionListResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_IPC.remoteSessionList)
    ) as unknown as RemoteSessionListResult,
  connectRemoteSession: async (params) =>
    remoteSessionResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.remoteSessionConnect,
        desktopRemoteConnectRequestSchema.parse(params)
      )
    ) as unknown as RemoteSessionResult,
  confirmRemoteHostKey: async (params) =>
    remoteSessionResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.remoteHostKeyConfirm,
        desktopRemoteSessionActionSchema.parse(params)
      )
    ) as unknown as RemoteSessionResult,
  discoverRemoteTmux: async (params) =>
    remoteTmuxDiscoveryResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.remoteTmuxDiscover,
        desktopRemoteSessionActionSchema.parse(params)
      )
    ),
  detachRemoteSession: async (params) =>
    remoteSessionResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.remoteSessionDetach,
        desktopRemoteSessionActionSchema.parse(params)
      )
    ) as unknown as RemoteSessionResult,
  reconnectRemoteSession: async (params) =>
    remoteSessionResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.remoteSessionReconnect,
        desktopRemoteSessionActionSchema.parse(params)
      )
    ) as unknown as RemoteSessionResult,
  closeRemoteSession: async (params) => {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC.remoteSessionClose,
      desktopRemoteSessionActionSchema.parse(params)
    )
    return result === null
      ? null
      : (remoteSessionResultSchema.parse(result) as unknown as RemoteSessionResult)
  },
  listAgentSessions: async () =>
    agentCatalogListResultSchema.parse(await ipcRenderer.invoke(DESKTOP_IPC.agentCatalogList)),
  registerAgentSession: async (params) =>
    agentCatalogRegisterResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentCatalogRegister,
        desktopAgentRegisterRequestSchema.parse(params)
      )
    ),
  assessAgentRestore: async (params) =>
    agentRestoreAssessResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentRestoreAssess,
        desktopAgentSessionActionSchema.parse(params)
      )
    ),
  restoreAgentSession: async (params) =>
    agentSessionRestoreResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentSessionRestore,
        desktopAgentSessionActionSchema.parse(params)
      )
    ),
  forkAgentSession: async (params) =>
    agentSessionForkResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentSessionFork,
        desktopAgentForkRequestSchema.parse(params)
      )
    ),
  hibernateAgentSession: async (params) => {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC.agentSessionHibernate,
      desktopAgentSessionActionSchema.parse(params)
    )
    return result === null ? null : agentHibernationMutationResultSchema.parse(result)
  },
  createAgentTeam: async (params) =>
    agentTeamMutationResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentTeamCreate,
        desktopAgentTeamCreateRequestSchema.parse(params)
      )
    ),
  deleteAgentTeam: async (params) =>
    agentTeamMutationResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentTeamDelete,
        desktopAgentTeamDeleteRequestSchema.parse(params)
      )
    ),
  createAgentTeamMember: async (params) =>
    agentTeamMemberMutationResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentTeamMemberCreate,
        desktopAgentTeamMemberCreateRequestSchema.parse(params)
      )
    ),
  updateAgentTeamMember: async (params) =>
    agentTeamMemberMutationResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentTeamMemberUpdate,
        desktopAgentTeamMemberUpdateRequestSchema.parse(params)
      )
    ),
  moveAgentTeamMember: async (params) =>
    agentTeamMemberMutationResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentTeamMemberMove,
        desktopAgentTeamMemberMoveRequestSchema.parse(params)
      )
    ),
  deleteAgentTeamMember: async (params) =>
    agentTeamMemberMutationResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentTeamMemberDelete,
        desktopAgentTeamMemberDeleteRequestSchema.parse(params)
      )
    ),
  setAgentAttention: async (params) =>
    agentAttentionSetResultSchema.parse(
      await ipcRenderer.invoke(
        DESKTOP_IPC.agentAttentionSet,
        desktopAgentAttentionRequestSchema.parse(params)
      )
    ),
  openExternal: async (rawUrl) => {
    const { url } = browserPlaceholderMetadataSchema.parse({ url: rawUrl })
    await invokeVoid(DESKTOP_IPC.openExternal, url)
  },
  onTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void =>
      listener(terminalEventSchema.parse(rawEvent))
    ipcRenderer.on(DESKTOP_IPC.terminalEvent, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.terminalEvent, handler)
  },
  onDomainEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void =>
      listener(domainEventSchema.parse(rawEvent))
    ipcRenderer.on(DESKTOP_IPC.domainEvent, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.domainEvent, handler)
  },
  onWorkspaceCardSlotsEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void =>
      listener(workspaceCardSlotsChangedEventSchema.parse(rawEvent))
    ipcRenderer.on(DESKTOP_IPC.workspaceCardSlotsEvent, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.workspaceCardSlotsEvent, handler)
  },
  onWorkspaceCardSlotV2Event: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void =>
      listener(workspaceCardSlotV2ChangedEventSchema.parse(rawEvent))
    ipcRenderer.on(DESKTOP_IPC.workspaceCardSlotV2Event, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.workspaceCardSlotV2Event, handler)
  },
  onWorkspaceAttentionEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void =>
      listener(workspaceAttentionChangedEventSchema.parse(rawEvent))
    ipcRenderer.on(DESKTOP_IPC.workspaceAttentionEvent, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.workspaceAttentionEvent, handler)
  },
  onDomainResyncRequired: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawNotice: unknown): void =>
      listener(parseDomainResyncNotice(rawNotice))
    ipcRenderer.on(DESKTOP_IPC.domainResyncRequired, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.domainResyncRequired, handler)
  },
  onServiceEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void =>
      listener(serviceEventSchema.parse(rawEvent))
    ipcRenderer.on(DESKTOP_IPC.serviceEvent, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.serviceEvent, handler)
  },
  onMultiWindowEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void =>
      listener(multiWindowEventSchema.parse(rawEvent))
    ipcRenderer.on(DESKTOP_IPC.multiWindowEvent, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.multiWindowEvent, handler)
  },
  onActionRegistryChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void =>
      listener(actionRegistryChangedEventSchema.parse(rawEvent))
    ipcRenderer.on(DESKTOP_IPC.actionRegistryChanged, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.actionRegistryChanged, handler)
  },
  onDesktopBindingRebind: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(DESKTOP_IPC.desktopBindingRebind, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.desktopBindingRebind, handler)
  },
  onBrowserViewsRebind: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(DESKTOP_IPC.browserViewsRebind, handler)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.browserViewsRebind, handler)
  }
} satisfies DesktopBridge)

function parseDomainResyncNotice(value: unknown): DomainResyncNotice {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('expectedRevision' in value) ||
    !('receivedRevision' in value) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    !Number.isSafeInteger(value.receivedRevision) ||
    Number(value.expectedRevision) < 0 ||
    Number(value.receivedRevision) <= Number(value.expectedRevision)
  ) {
    throw new Error('Invalid domain resynchronization notice')
  }
  return {
    expectedRevision: Number(value.expectedRevision),
    receivedRevision: Number(value.receivedRevision)
  }
}

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge)
