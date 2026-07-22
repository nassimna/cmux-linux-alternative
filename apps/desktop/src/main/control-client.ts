import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

import {
  actionInvocationChangedEventSchema,
  actionCancelParamsSchema,
  actionCancelResultSchema,
  actionInvokeParamsSchema,
  actionInvokeResultSchema,
  actionListParamsSchema,
  actionListResultSchema,
  actionRegistryChangedEventSchema,
  attentionAcknowledgementParamsSchema,
  attentionAcknowledgementResultSchema,
  configurationGetResultSchema,
  configurationUpdateParamsSchema,
  advancedTabMutationResultSchema,
  advancedTabCloseResultSchema,
  closedItemGetParamsSchema,
  closedItemGetResultSchema,
  closedItemListResultSchema,
  desktopActionAcknowledgeParamsSchema,
  desktopActionAcknowledgeResultSchema,
  desktopActionPollParamsSchema,
  desktopActionPollResultSchema,
  desktopActionStartClaimParamsSchema,
  desktopActionStartClaimResultSchema,
  browserAutomationProviderAcknowledgeParamsSchema,
  browserAutomationProviderAcknowledgeResultSchema,
  browserAutomationProviderPollParamsSchema,
  browserAutomationProviderPollResultSchema,
  browserAutomationProviderTransferRespondParamsSchema,
  browserAutomationScreenshotReadParamsSchema,
  browserAutomationScreenshotReadResultSchema,
  browserAutomationScreenshotReleaseParamsSchema,
  browserAutomationScreenshotReleaseResultSchema,
  projectActionConfirmationPollParamsSchema,
  projectActionConfirmationPollResultSchema,
  projectActionConfirmationRespondParamsSchema,
  projectActionConfirmationRespondResultSchema,
  desktopProviderAcknowledgeParamsSchema,
  desktopProviderCancelParamsSchema,
  desktopProviderHeartbeatParamsSchema,
  desktopProviderHeartbeatResultSchema,
  desktopProviderPollParamsSchema,
  desktopProviderPollResultSchema,
  desktopProviderRegisterParamsSchema,
  desktopProviderRegistrationSchema,
  desktopProviderUnregisterParamsSchema,
  focusHistoryNavigateParamsSchema,
  focusHistoryNavigateResultSchema,
  groupAssignParamsSchema,
  groupCollapseParamsSchema,
  groupCreateParamsSchema,
  groupDeleteParamsSchema,
  groupMoveParamsSchema,
  groupRenameParamsSchema,
  emptyParamsSchema,
  identifyResultSchema,
  layoutApplyParamsSchema,
  layoutDeleteParamsSchema,
  layoutExportParamsSchema,
  layoutExportResultSchema,
  layoutGetParamsSchema,
  layoutGetResultSchema,
  layoutImportParamsSchema,
  layoutListResultSchema,
  layoutMutationResultSchema,
  layoutSaveParamsSchema,
  mutationResponseEnvelopeSchema,
  multiWindowProtocolEventSchema,
  notificationListResultSchema,
  protocolEventSchema,
  responseEnvelopeSchema,
  settingsGetResultSchema,
  terminalAttachResultSchema,
  terminalRuntimeMetadataResultSchema,
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
  windowStateGetResultSchema,
  windowStateGetForParamsSchema,
  windowStateGetForResultSchema,
  windowStateUpdateForParamsSchema,
  windowStateUpdateParamsSchema,
  workspaceListResultSchema,
  workspaceBatchCloseParamsSchema,
  workspaceCanonicalMoveParamsSchema,
  workspaceOrganizationGetResultSchema,
  workspacePinParamsSchema,
  workspaceSelectionReplaceParamsSchema,
  workspaceSnapshotResultSchema,
  tabCloseAdvancedParamsSchema,
  tabDetachParamsSchema,
  tabDuplicateParamsSchema,
  tabMoveExactParamsSchema,
  tabReopenParamsSchema,
  windowCloseParamsSchema,
  windowBindParamsSchema,
  windowBindResultSchema,
  windowCreateParamsSchema,
  windowFocusParamsSchema,
  windowListResultSchema,
  windowMutationResultSchema,
  windowCloseResultSchema,
  type AdvancedTabCloseResult,
  type AdvancedTabMutationResult,
  type ActionDefinition,
  type ActionCancelParams,
  type ActionInvocationChangedEvent,
  type ActionInvocationSnapshot,
  type ActionInvokeParams,
  type ActionListResult,
  type ActionRegistryChangedEvent,
  type AttentionAcknowledgementParams,
  type AttentionAcknowledgementResult,
  type BrowserBackParams,
  type BrowserForwardParams,
  type BrowserNavigateParams,
  type BrowserObserveParams,
  type BrowserOpenDevToolsParams,
  type BrowserReloadParams,
  type BrowserStopParams,
  type ConfigurationGetResult,
  type ConfigurationUpdateParams,
  type ClosedItemGetParams,
  type ClosedItemGetResult,
  type ClosedItemListResult,
  type DesktopActionAcknowledgeParams,
  type DesktopActionAcknowledgeResult,
  type DesktopActionPollParams,
  type DesktopActionPollResult,
  type DesktopActionStartClaimParams,
  type DesktopActionStartClaimResult,
  type BrowserAutomationProviderAcknowledgeParams,
  type BrowserAutomationProviderAcknowledgeResult,
  type BrowserAutomationProviderPollParams,
  type BrowserAutomationProviderPollResult,
  type BrowserAutomationProviderTransferRespondParams,
  type BrowserAutomationScreenshotReadParams,
  type BrowserAutomationScreenshotReadResult,
  type BrowserAutomationScreenshotReleaseParams,
  type BrowserAutomationScreenshotReleaseResult,
  type ProjectActionConfirmationPollParams,
  type ProjectActionConfirmationPollResult,
  type ProjectActionConfirmationRespondParams,
  type ProjectActionConfirmationRespondResult,
  type DesktopProviderAcknowledgeParams,
  type DesktopProviderCancelParams,
  type DesktopProviderHeartbeatParams,
  type DesktopProviderHeartbeatResult,
  type DesktopProviderPollParams,
  type DesktopProviderPollResult,
  type DesktopProviderRegisterParams,
  type DesktopProviderRegistration,
  type DesktopProviderUnregisterParams,
  type GroupAssignParams,
  type GroupCollapseParams,
  type GroupCreateParams,
  type GroupDeleteParams,
  type GroupMoveParams,
  type GroupRenameParams,
  type DomainEventMessage,
  type IdentifyResult,
  type FocusHistoryNavigateParams,
  type FocusHistoryNavigateResult,
  type LayoutApplyParams,
  type LayoutDeleteParams,
  type LayoutExportParams,
  type LayoutExportResult,
  type LayoutGetParams,
  type LayoutGetResult,
  type LayoutImportParams,
  type LayoutListResult,
  type LayoutMutationResult,
  type LayoutSaveParams,
  type MutationResult,
  type MultiWindowEventMessage,
  type NotificationClearParams,
  type NotificationListParams,
  type NotificationListResult,
  type NotificationMarkReadParams,
  type NotificationMarkUnreadParams,
  type PaneCloseParams,
  type PaneFocusParams,
  type PaneMoveTabParams,
  type PaneResizeParams,
  type PaneSplitParams,
  type ResponseEnvelope,
  type SettingsGetResult,
  type SettingsResetKeyParams,
  type SettingsUpdateParams,
  type ServiceEventMessage,
  type TabCloseParams,
  type TabCloseAdvancedParams,
  type TabDetachParams,
  type TabDuplicateParams,
  type TabMoveExactParams,
  type TabReopenParams,
  type TabMoveParams,
  type TabOpenBrowserParams,
  type TabOpenTerminalParams,
  type TabSelectParams,
  type TabUpdateParams,
  type TerminalAttachResult,
  type TerminalCheckpoint,
  type TerminalEventMessage,
  type TerminalRestartParams,
  type TerminalRuntimeMetadataResult,
  type WindowStateGetResult,
  type WindowStateGetForParams,
  type WindowStateGetForResult,
  type WindowStateUpdateParams,
  type WindowStateUpdateForParams,
  type WindowCloseParams,
  type WindowBindParams,
  type WindowBindResult,
  type WindowCreateParams,
  type WindowFocusParams,
  type WindowListResult,
  type WindowMutationResult,
  type WindowCloseResult,
  type WorkspaceCloseParams,
  type WorkspaceCardSlotsEventMessage,
  type WorkspaceAttentionEventMessage,
  type WorkspaceAttentionSnapshot,
  type WorkspaceAttentionSnapshotParams,
  type WorkspaceCardSlotsReplaceParams,
  type WorkspaceCardSlotsSnapshot,
  type WorkspaceCardSlotsSnapshotParams,
  type WorkspaceCardSlotV2EventMessage,
  type WorkspaceCardSlotV2GetParams,
  type WorkspaceCardSlotV2ReplaceParams,
  type WorkspaceCardSlotV2Snapshot,
  type WorkspaceCreateParams,
  type WorkspaceListResult,
  type WorkspaceBatchCloseParams,
  type WorkspaceCanonicalMoveParams,
  type WorkspaceOrganizationGetResult,
  type WorkspacePinParams,
  type WorkspaceSelectionReplaceParams,
  type WorkspaceMoveParams,
  type WorkspaceSelectParams,
  type WorkspaceSnapshotParams,
  type WorkspaceSnapshotResult,
  type WorkspaceUpdateParams
} from '@agent-workspace/protocol-client'
import {
  boundedListParamsSchema,
  contentDiffParamsSchema,
  contentDiffResultSchema,
  contentDocumentIssueParamsSchema,
  contentDocumentIssueResultSchema,
  contentMarkdownParamsSchema,
  contentPreviewSchema,
  contentReadParamsSchema,
  recentlyClosedListResultSchema,
  recentlyClosedReopenParamsSchema,
  searchCancelParamsSchema,
  searchCancelResultSchema,
  searchControlResultSchema,
  searchQueryParamsSchema,
  searchQueryResultSchema,
  searchRebuildParamsSchema,
  searchSourceMutationParamsSchema,
  searchSourcePolicyParamsSchema,
  safeMarkdownDocumentSchema,
  sidebarGetParamsSchema,
  sidebarPlacementSchema,
  sidebarSaveParamsSchema,
  taskActionParamsSchema,
  taskActionResultSchema,
  taskConfirmationIssueParamsSchema,
  taskConfirmationIssueResultSchema,
  taskListParamsSchema,
  taskListResultSchema,
  textBoxCreateParamsSchema,
  textBoxDeleteParamsSchema,
  textBoxDocumentSchema,
  textBoxSaveParamsSchema,
  textBoxListResultSchema,
  workspaceDirectoryListParamsSchema,
  workspaceDirectoryListResultSchema,
  workspaceRootListResultSchema,
  type ContentDiffParams,
  type ContentDiffResult,
  type ContentDocumentIssueParams,
  type ContentDocumentIssueResult,
  type ContentMarkdownParams,
  type ContentPreview,
  type ContentReadParams,
  type RecentlyClosedListResult,
  type RecentlyClosedReopenParams,
  type SearchCancelParams,
  type SearchCancelResult,
  type SearchControlResult,
  type SearchExportConfirmationIssueParams,
  type SearchExportConfirmationIssueResult,
  type SearchExportParams,
  type SearchExportResult,
  type SearchQueryParams,
  type SearchQueryResult,
  type SearchRebuildParams,
  type SearchSourceMutationParams,
  type SearchSourcePolicyParams,
  type SidebarPlacement,
  type SidebarSaveParams,
  type TaskActionParams,
  type TaskActionResult,
  type TaskConfirmationIssueParams,
  type TaskConfirmationIssueResult,
  type TaskListParams,
  type TaskListResult,
  type TextBoxCreateParams,
  type TextBoxDeleteParams,
  type TextBoxDocument,
  type TextBoxListResult,
  type TextBoxSaveParams,
  type WorkspaceDirectoryListParams,
  type WorkspaceDirectoryListResult,
  type WorkspaceRootListResult
} from '@agent-workspace/protocol-client'
import {
  desktopSearchExportConfirmationIssueParamsSchema,
  desktopSearchExportConfirmationIssueResultSchema,
  desktopSearchExportParamsSchema,
  desktopSearchExportResultSchema
} from '../shared/desktop-bridge'
import {
  agentAttentionSetParamsSchema,
  agentAttentionSetResultSchema,
  agentCatalogGetParamsSchema,
  agentCatalogGetResultSchema,
  agentCatalogListParamsSchema,
  agentCatalogListResultSchema,
  agentCatalogRegisterParamsSchema,
  agentCatalogRegisterResultSchema,
  agentHibernationCancelParamsSchema,
  agentHibernationConfirmParamsSchema,
  agentHibernationMutationResultSchema,
  agentHibernationPreflightParamsSchema,
  agentHibernationPreflightResultSchema,
  agentRestoreAssessParamsSchema,
  agentRestoreAssessResultSchema,
  agentSessionForkParamsSchema,
  agentSessionForkResultSchema,
  agentSessionRestoreParamsSchema,
  agentSessionRestoreResultSchema,
  agentTeamCreateParamsSchema,
  agentTeamDeleteParamsSchema,
  agentTeamMemberCreateParamsSchema,
  agentTeamMemberDeleteParamsSchema,
  agentTeamMemberMoveParamsSchema,
  agentTeamMemberMutationResultSchema,
  agentTeamMemberUpdateParamsSchema,
  agentTeamMutationResultSchema,
  agentTeamUpdateParamsSchema,
  type AgentAttentionSetParams,
  type AgentAttentionSetResult,
  type AgentCatalogGetParams,
  type AgentCatalogGetResult,
  type AgentCatalogListParams,
  type AgentCatalogListResult,
  type AgentCatalogRegisterParams,
  type AgentCatalogRegisterResult,
  type AgentHibernationCancelParams,
  type AgentHibernationConfirmParams,
  type AgentHibernationMutationResult,
  type AgentHibernationPreflightParams,
  type AgentHibernationPreflightResult,
  type AgentRestoreAssessParams,
  type AgentRestoreAssessResult,
  type AgentSessionForkParams,
  type AgentSessionForkResult,
  type AgentSessionRestoreParams,
  type AgentSessionRestoreResult,
  type AgentTeamCreateParams,
  type AgentTeamDeleteParams,
  type AgentTeamMemberCreateParams,
  type AgentTeamMemberDeleteParams,
  type AgentTeamMemberMoveParams,
  type AgentTeamMemberMutationResult,
  type AgentTeamMemberUpdateParams,
  type AgentTeamMutationResult,
  type AgentTeamUpdateParams,
  remoteHostKeyChallengeSchema,
  remoteHostKeyScanParamsSchema,
  remoteHostKeyTrustParamsSchema,
  remoteListParamsSchema,
  remoteSessionCloseParamsSchema,
  remoteSessionConnectParamsSchema,
  remoteSessionDetachParamsSchema,
  remoteSessionIdParamsSchema,
  remoteSessionListResultSchema,
  remoteSessionReconnectParamsSchema,
  remoteSessionResultSchema,
  remoteTargetCreateParamsSchema,
  remoteTargetDeleteParamsSchema,
  remoteTargetIdParamsSchema,
  remoteTargetListResultSchema,
  remoteTargetResultSchema,
  remoteTmuxDiscoverParamsSchema,
  remoteTmuxDiscoveryResultSchema,
  type RemoteHostKeyChallenge,
  type RemoteHostKeyScanParams,
  type RemoteHostKeyTrustParams,
  type RemoteListParams,
  type RemoteSessionCloseParams,
  type RemoteSessionConnectParams,
  type RemoteSessionDetachParams,
  type RemoteSessionIdParams,
  type RemoteSessionListResult,
  type RemoteSessionReconnectParams,
  type RemoteSessionResult,
  type RemoteTargetCreateParams,
  type RemoteTargetDeleteParams,
  type RemoteTargetIdParams,
  type RemoteTargetListResult,
  type RemoteTargetResult,
  type RemoteTmuxDiscoverParams,
  type RemoteTmuxDiscoveryResult
} from '@agent-workspace/protocol-client'

import { toNodeSocketPath } from './control-endpoint'
import type { DomainResyncNotice } from '../shared/desktop-bridge'

export class ControlRequestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ControlRequestError'
    this.code = code
  }
}

const MAX_CONTROL_MESSAGE_BYTES = 1024 * 1024
const AGENT_SESSIONS_CAPABILITY = 'agent-sessions-v1'
const REMOTE_SESSIONS_CAPABILITY = 'remote-sessions-v1'
const ACTION_REQUEST_TIMEOUT_MS = 1_000
const WORKSPACE_GROUPS_CAPABILITY = 'workspace-groups-v1'
const SAVED_LAYOUTS_CAPABILITY = 'saved-layouts-v1'
const MULTI_WINDOW_CAPABILITY = 'multi-window-v1'
const ACTIONS_CAPABILITY = 'actions-v1'
const BROWSER_AUTOMATION_CAPABILITY = 'browser-automation-v1'
const SIDEBAR_SURFACES_CAPABILITY = 'sidebar-surfaces-v1'

export class UnsupportedServiceCapabilityError extends Error {
  public constructor(public readonly capability: string) {
    super(`The local control service does not support ${capability}`)
    this.name = 'UnsupportedServiceCapabilityError'
  }
}

interface PendingRequest {
  reject(error: Error): void
  resolve(value: ResponseEnvelope): void
  readonly timer?: ReturnType<typeof setTimeout>
}

interface PendingActionInvocation {
  readonly invocationId: string
  reject(error: Error): void
  resolve(event: ActionInvocationChangedEvent | undefined): void
  readonly timer: ReturnType<typeof setTimeout>
}

interface ResultSchema<T> {
  parse(value: unknown): T
}

const advancedTabResultSchema =
  advancedTabMutationResultSchema as unknown as ResultSchema<AdvancedTabMutationResult>

export class ControlClient {
  private buffer = ''
  private readonly domainEventListeners = new Set<(event: DomainEventMessage) => void>()
  private readonly multiWindowEventListeners = new Set<(event: MultiWindowEventMessage) => void>()
  private readonly domainResyncListeners = new Set<(notice: DomainResyncNotice) => void>()
  private readonly serviceEventListeners = new Set<(event: ServiceEventMessage) => void>()
  private readonly terminalEventListeners = new Set<(event: TerminalEventMessage) => void>()
  private readonly cardSlotEventListeners = new Set<
    (event: WorkspaceCardSlotsEventMessage) => void
  >()
  private readonly cardSlotV2EventListeners = new Set<
    (event: WorkspaceCardSlotV2EventMessage) => void
  >()
  private readonly attentionEventListeners = new Set<
    (event: WorkspaceAttentionEventMessage) => void
  >()
  private readonly actionRegistryEventListeners = new Set<
    (event: ActionRegistryChangedEvent) => void
  >()
  private readonly actionInvocationEvents = new Map<string, ActionInvocationChangedEvent>()
  private readonly pendingActionInvocations = new Map<string, PendingActionInvocation>()
  private lastRevision: number | undefined
  private identity: IdentifyResult | undefined
  private identityRequest: Promise<IdentifyResult> | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private socket: Socket | undefined

  public constructor(
    private readonly endpoint: string,
    private readonly token: string
  ) {}

  public async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return

    this.buffer = ''
    this.resetNegotiation()
    const socket = createConnection(toNodeSocketPath(this.endpoint))
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.receive(chunk))
    socket.on('error', (error) => this.fail(error))
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined
      this.resetNegotiation()
      this.fail(new Error('The local control service disconnected'))
    })

    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        socket.off('error', onInitialError)
        resolve()
      }
      const onInitialError = (error: Error): void => {
        socket.off('connect', onConnect)
        if (this.socket === socket) this.socket = undefined
        reject(error)
      }
      socket.once('connect', onConnect)
      socket.once('error', onInitialError)
    })

    socket.write(`${JSON.stringify({ auth: { token: this.token } })}\n`)
  }

  public async identify(): Promise<IdentifyResult> {
    if (this.identity) return this.identity
    if (this.identityRequest) return this.identityRequest
    const request = this.result('system.identify', {}).then((result) => {
      const identity = identifyResultSchema.parse(result)
      this.identity = identity
      return identity
    })
    this.identityRequest = request
    try {
      return await request
    } finally {
      if (this.identityRequest === request) this.identityRequest = undefined
    }
  }

  public async listWindows(): Promise<WindowListResult> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    return windowListResultSchema.parse(await this.result('window.list', {}))
  }

  public async bindWindow(params: WindowBindParams): Promise<WindowBindResult> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    const parsed = windowBindResultSchema.parse(
      await this.result('window.bind', windowBindParamsSchema.parse(params))
    )
    if (parsed.window.windowId !== params.window.windowId) {
      throw new Error('The service bound an unexpected window placement')
    }
    // system.identify is connection-projected. A child is identified once while
    // unbound so it can negotiate window.bind, then must renegotiate the scoped
    // capability set before renderer initialization (for example saved layouts
    // are intentionally absent from placement-bound connections).
    this.resetNegotiation()
    return parsed
  }

  public async createWindow(params: WindowCreateParams): Promise<WindowMutationResult> {
    return this.multiWindowMutation(
      'window.create',
      windowCreateParamsSchema.parse(params),
      windowMutationResultSchema
    )
  }

  public closeWindow(params: WindowCloseParams): Promise<WindowCloseResult> {
    return this.multiWindowMutation(
      'window.close',
      windowCloseParamsSchema.parse(params),
      windowCloseResultSchema
    ) as unknown as Promise<WindowCloseResult>
  }

  public async focusWindow(params: WindowFocusParams): Promise<WindowMutationResult> {
    return this.multiWindowMutation(
      'window.focus',
      windowFocusParamsSchema.parse(params),
      windowMutationResultSchema
    )
  }

  public async duplicateTab(params: TabDuplicateParams): Promise<AdvancedTabMutationResult> {
    return this.multiWindowMutation(
      'tab.duplicate',
      tabDuplicateParamsSchema.parse(params),
      advancedTabResultSchema
    )
  }

  public async moveTabExact(params: TabMoveExactParams): Promise<AdvancedTabMutationResult> {
    return this.multiWindowMutation(
      'tab.moveExact',
      tabMoveExactParamsSchema.parse(params),
      advancedTabResultSchema
    )
  }

  public async detachTab(params: TabDetachParams): Promise<AdvancedTabMutationResult> {
    return this.multiWindowMutation(
      'tab.detach',
      tabDetachParamsSchema.parse(params),
      advancedTabResultSchema
    )
  }

  public async closeTabAdvanced(params: TabCloseAdvancedParams): Promise<AdvancedTabCloseResult> {
    return this.multiWindowMutation(
      'tab.closeAdvanced',
      tabCloseAdvancedParamsSchema.parse(params),
      advancedTabCloseResultSchema
    )
  }

  public async reopenTab(params: TabReopenParams): Promise<AdvancedTabMutationResult> {
    return this.multiWindowMutation(
      'tab.reopen',
      tabReopenParamsSchema.parse(params),
      advancedTabResultSchema
    )
  }

  public async listClosedItems(): Promise<ClosedItemListResult> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    return closedItemListResultSchema.parse(await this.result('closed.list', {}))
  }

  public async getClosedItem(params: ClosedItemGetParams): Promise<ClosedItemGetResult> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    return closedItemGetResultSchema.parse(
      await this.result('closed.get', closedItemGetParamsSchema.parse(params))
    )
  }

  public async navigateFocusHistory(
    params: FocusHistoryNavigateParams
  ): Promise<FocusHistoryNavigateResult> {
    return this.multiWindowMutation(
      'focusHistory.navigate',
      focusHistoryNavigateParamsSchema.parse(params),
      focusHistoryNavigateResultSchema
    )
  }

  public async registerDesktopProvider(
    params: DesktopProviderRegisterParams
  ): Promise<DesktopProviderRegistration> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    return desktopProviderRegistrationSchema.parse(
      await this.result(
        'desktopProvider.register',
        desktopProviderRegisterParamsSchema.parse(params)
      )
    )
  }

  public async heartbeatDesktopProvider(
    params: DesktopProviderHeartbeatParams
  ): Promise<DesktopProviderHeartbeatResult> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    return desktopProviderHeartbeatResultSchema.parse(
      await this.result(
        'desktopProvider.heartbeat',
        desktopProviderHeartbeatParamsSchema.parse(params)
      )
    )
  }

  public async unregisterDesktopProvider(params: DesktopProviderUnregisterParams): Promise<void> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    emptyParamsSchema.parse(
      await this.result(
        'desktopProvider.unregister',
        desktopProviderUnregisterParamsSchema.parse(params)
      )
    )
  }

  public async pollDesktopProvider(
    params: DesktopProviderPollParams
  ): Promise<DesktopProviderPollResult> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    return desktopProviderPollResultSchema.parse(
      await this.result('desktopProvider.poll', desktopProviderPollParamsSchema.parse(params))
    ) as DesktopProviderPollResult
  }

  public async acknowledgeDesktopProvider(params: DesktopProviderAcknowledgeParams): Promise<void> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    emptyParamsSchema.parse(
      await this.result(
        'desktopProvider.acknowledge',
        desktopProviderAcknowledgeParamsSchema.parse(params)
      )
    )
  }

  public async cancelDesktopProvider(params: DesktopProviderCancelParams): Promise<void> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    emptyParamsSchema.parse(
      await this.result('desktopProvider.cancel', desktopProviderCancelParamsSchema.parse(params))
    )
  }

  public async pollDesktopAction(
    params: DesktopActionPollParams
  ): Promise<DesktopActionPollResult> {
    await this.requireCapability(ACTIONS_CAPABILITY)
    return desktopActionPollResultSchema.parse(
      await this.result('desktopAction.poll', desktopActionPollParamsSchema.parse(params))
    ) as DesktopActionPollResult
  }

  public async claimDesktopActionStart(
    params: DesktopActionStartClaimParams
  ): Promise<DesktopActionStartClaimResult> {
    await this.requireCapability(ACTIONS_CAPABILITY)
    return desktopActionStartClaimResultSchema.parse(
      await this.result(
        'desktopAction.startClaim',
        desktopActionStartClaimParamsSchema.parse(params)
      )
    ) as DesktopActionStartClaimResult
  }

  public async acknowledgeDesktopAction(
    params: DesktopActionAcknowledgeParams
  ): Promise<DesktopActionAcknowledgeResult> {
    await this.requireCapability(ACTIONS_CAPABILITY)
    return desktopActionAcknowledgeResultSchema.parse(
      await this.result(
        'desktopAction.acknowledge',
        desktopActionAcknowledgeParamsSchema.parse(params)
      )
    ) as DesktopActionAcknowledgeResult
  }

  public async pollBrowserAutomation(
    params: BrowserAutomationProviderPollParams
  ): Promise<BrowserAutomationProviderPollResult> {
    await this.requireCapability(BROWSER_AUTOMATION_CAPABILITY)
    return browserAutomationProviderPollResultSchema.parse(
      await this.result(
        'browserAutomation.providerPoll',
        browserAutomationProviderPollParamsSchema.parse(params)
      )
    ) as BrowserAutomationProviderPollResult
  }

  public async acknowledgeBrowserAutomation(
    params: BrowserAutomationProviderAcknowledgeParams
  ): Promise<BrowserAutomationProviderAcknowledgeResult> {
    await this.requireCapability(BROWSER_AUTOMATION_CAPABILITY)
    return browserAutomationProviderAcknowledgeResultSchema.parse(
      await this.result(
        'browserAutomation.providerAcknowledge',
        browserAutomationProviderAcknowledgeParamsSchema.parse(params)
      )
    ) as BrowserAutomationProviderAcknowledgeResult
  }

  public async respondBrowserAutomationTransfer(
    params: BrowserAutomationProviderTransferRespondParams
  ): Promise<void> {
    await this.requireCapability(BROWSER_AUTOMATION_CAPABILITY)
    emptyParamsSchema.parse(
      await this.result(
        'browserAutomation.providerTransferRespond',
        browserAutomationProviderTransferRespondParamsSchema.parse(params)
      )
    )
  }

  public async readBrowserAutomationScreenshot(
    params: BrowserAutomationScreenshotReadParams
  ): Promise<BrowserAutomationScreenshotReadResult> {
    await this.requireCapability(BROWSER_AUTOMATION_CAPABILITY)
    return browserAutomationScreenshotReadResultSchema.parse(
      await this.result(
        'browserAutomation.screenshotRead',
        browserAutomationScreenshotReadParamsSchema.parse(params)
      )
    )
  }

  public async releaseBrowserAutomationScreenshot(
    params: BrowserAutomationScreenshotReleaseParams
  ): Promise<BrowserAutomationScreenshotReleaseResult> {
    await this.requireCapability(BROWSER_AUTOMATION_CAPABILITY)
    return browserAutomationScreenshotReleaseResultSchema.parse(
      await this.result(
        'browserAutomation.screenshotRelease',
        browserAutomationScreenshotReleaseParamsSchema.parse(params)
      )
    )
  }

  public async pollProjectActionConfirmation(
    params: ProjectActionConfirmationPollParams
  ): Promise<ProjectActionConfirmationPollResult> {
    await this.requireCapability(ACTIONS_CAPABILITY)
    return projectActionConfirmationPollResultSchema.parse(
      await this.result(
        'projectAction.confirmationPoll',
        projectActionConfirmationPollParamsSchema.parse(params)
      )
    ) as ProjectActionConfirmationPollResult
  }

  public async respondProjectActionConfirmation(
    params: ProjectActionConfirmationRespondParams
  ): Promise<ProjectActionConfirmationRespondResult> {
    await this.requireCapability(ACTIONS_CAPABILITY)
    return projectActionConfirmationRespondResultSchema.parse(
      await this.result(
        'projectAction.confirmationRespond',
        projectActionConfirmationRespondParamsSchema.parse(params)
      )
    )
  }

  /** Returns one strictly validated action-registry page. */
  public async listActions(cursor?: string, limit = 64): Promise<ActionListResult> {
    await this.requireCapability(ACTIONS_CAPABILITY)
    return actionListResultSchema.parse(
      await this.result(
        'action.list',
        actionListParamsSchema.parse({ ...(cursor === undefined ? {} : { cursor }), limit })
      )
    ) as ActionListResult
  }

  /**
   * Reads the complete bounded registry and rejects if its revision or epoch changes mid-page.
   */
  public async listAllActions(): Promise<{
    readonly registryRevision: number
    readonly idempotencyEpoch: string
    readonly definitions: readonly ActionDefinition[]
  }> {
    const maximumDefinitions = 256
    const definitions: ActionDefinition[] = []
    const definitionIdentities = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let registryRevision: number | undefined
    let idempotencyEpoch: string | undefined
    do {
      const page = await this.listActions(cursor)
      if (
        (registryRevision !== undefined && page.registryRevision !== registryRevision) ||
        (idempotencyEpoch !== undefined && page.idempotencyEpoch !== idempotencyEpoch)
      ) {
        throw new Error('The public action registry changed during discovery')
      }
      registryRevision = page.registryRevision
      idempotencyEpoch = page.idempotencyEpoch
      for (const definition of page.definitions) {
        const identity = `${definition.actionId}\u0000${definition.actionVersion}`
        if (definitionIdentities.has(identity)) {
          throw new Error('The public action registry repeated an action identity')
        }
        definitionIdentities.add(identity)
        definitions.push(definition)
        if (definitions.length > maximumDefinitions) {
          throw new Error('The public action registry exceeds the 256-definition limit')
        }
      }
      cursor = page.nextCursor
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new Error('The public action registry repeated a pagination cursor')
        }
        seenCursors.add(cursor)
      }
    } while (cursor !== undefined)
    if (registryRevision === undefined || idempotencyEpoch === undefined) {
      throw new Error('The public action registry omitted its identity')
    }
    return { registryRevision, idempotencyEpoch, definitions }
  }

  /**
   * Keeps this authenticated caller connection alive through the durable lifecycle, then replays
   * the exact idempotent request so the renderer receives only the authoritative terminal result.
   */
  public async invokeAction(
    params: ActionInvokeParams,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<ActionInvocationSnapshot> {
    await this.requireCapability(ACTIONS_CAPABILITY)
    const parsed = actionInvokeParamsSchema.parse(params) as ActionInvokeParams
    const initial = await this.replayActionInvocation(parsed)
    if (isTerminalActionInvocation(initial.invocation)) return initial.invocation

    const deadline = Date.now() + 5 * 60 * 1_000 + 5_000
    let snapshot = initial.invocation
    while (!isTerminalActionInvocation(snapshot)) {
      if (options.signal?.aborted) {
        snapshot = await this.cancelAction({
          invocationId: snapshot.invocationId,
          correlationId: snapshot.correlationId
        })
        if (isTerminalActionInvocation(snapshot)) break
      }
      if (Date.now() >= deadline) throw new Error('The public action lifecycle timed out')
      let event: ActionInvocationChangedEvent | undefined
      try {
        event = await this.waitForActionProgress(
          snapshot.invocationId,
          snapshot.correlationId,
          Math.min(options.signal ? 100 : 1_000, Math.max(1, deadline - Date.now()))
        )
      } catch {
        // A dropped caller connection cannot invalidate the durable invocation. The exact
        // idempotent request below reconnects and recovers the authoritative snapshot.
      }
      if (event && event.invocationId !== snapshot.invocationId) {
        throw new Error('The public action lifecycle changed invocation identity')
      }
      const replay = await this.replayActionInvocation(parsed)
      if (
        replay.invocation.invocationId !== initial.invocation.invocationId ||
        replay.invocation.correlationId !== initial.invocation.correlationId
      ) {
        throw new Error('The public action replay changed its durable identity')
      }
      snapshot = replay.invocation
    }
    this.actionInvocationEvents.delete(parsed.correlationId)
    return snapshot
  }

  /** Cancels one exact durable invocation and returns the authoritative snapshot. */
  public async cancelAction(params: ActionCancelParams): Promise<ActionInvocationSnapshot> {
    await this.requireCapability(ACTIONS_CAPABILITY)
    const parsed = actionCancelParamsSchema.parse(params)
    const result = actionCancelResultSchema.parse(
      await this.actionRequestWithRecovery('action.cancel', parsed)
    ) as unknown as { invocation: ActionInvocationSnapshot }
    return result.invocation
  }

  public onActionRegistryChanged(
    listener: (event: ActionRegistryChangedEvent) => void
  ): () => void {
    this.actionRegistryEventListeners.add(listener)
    return () => this.actionRegistryEventListeners.delete(listener)
  }

  private async sidebarResult(command: string, params: Record<string, unknown>): Promise<unknown> {
    await this.requireCapability(SIDEBAR_SURFACES_CAPABILITY)
    return this.result(command, params)
  }

  public async getSidebarPlacement(windowId: string): Promise<SidebarPlacement | undefined> {
    const result = sidebarPlacementSchema.parse(
      await this.sidebarResult('sidebar.placement.get', sidebarGetParamsSchema.parse({ windowId }))
    )
    return result
  }

  public async saveSidebarPlacement(params: SidebarSaveParams): Promise<SidebarPlacement> {
    return sidebarPlacementSchema.parse(
      await this.sidebarResult('sidebar.placement.save', sidebarSaveParamsSchema.parse(params))
    )
  }

  public async listTextBoxes(): Promise<TextBoxListResult> {
    return textBoxListResultSchema.parse(
      await this.sidebarResult('textbox.list', boundedListParamsSchema.parse({ limit: 64 }))
    )
  }

  public async createTextBox(params: TextBoxCreateParams): Promise<TextBoxDocument> {
    return textBoxDocumentSchema.parse(
      await this.sidebarResult('textbox.create', textBoxCreateParamsSchema.parse(params))
    )
  }

  public async saveTextBox(params: TextBoxSaveParams): Promise<TextBoxDocument> {
    return textBoxDocumentSchema.parse(
      await this.sidebarResult('textbox.save', textBoxSaveParamsSchema.parse(params))
    )
  }

  public async deleteTextBox(params: TextBoxDeleteParams): Promise<TextBoxDocument> {
    return textBoxDocumentSchema.parse(
      await this.sidebarResult('textbox.delete', textBoxDeleteParamsSchema.parse(params))
    )
  }

  public async listContentRoots(): Promise<WorkspaceRootListResult> {
    return workspaceRootListResultSchema.parse(
      await this.sidebarResult('content.root.list', boundedListParamsSchema.parse({ limit: 100 }))
    )
  }

  public async listContentDirectory(
    params: WorkspaceDirectoryListParams
  ): Promise<WorkspaceDirectoryListResult> {
    return workspaceDirectoryListResultSchema.parse(
      await this.sidebarResult(
        'content.directory.list',
        workspaceDirectoryListParamsSchema.parse(params)
      )
    )
  }

  public async issueContentDocument(
    params: ContentDocumentIssueParams
  ): Promise<ContentDocumentIssueResult> {
    return contentDocumentIssueResultSchema.parse(
      await this.sidebarResult(
        'content.document.issue',
        contentDocumentIssueParamsSchema.parse(params)
      )
    )
  }

  public async readContent(params: ContentReadParams): Promise<ContentPreview> {
    return contentPreviewSchema.parse(
      await this.sidebarResult('content.read', contentReadParamsSchema.parse(params))
    )
  }

  public async renderMarkdown(params: ContentMarkdownParams) {
    return safeMarkdownDocumentSchema.parse(
      await this.sidebarResult('content.markdown', contentMarkdownParamsSchema.parse(params))
    )
  }

  public async diffContent(params: ContentDiffParams): Promise<ContentDiffResult> {
    return contentDiffResultSchema.parse(
      await this.sidebarResult('content.diff', contentDiffParamsSchema.parse(params))
    )
  }

  public async searchContent(params: SearchQueryParams): Promise<SearchQueryResult> {
    return searchQueryResultSchema.parse(
      await this.sidebarResult('search.query', searchQueryParamsSchema.parse(params))
    )
  }

  public async cancelSearch(params: SearchCancelParams): Promise<SearchCancelResult> {
    return searchCancelResultSchema.parse(
      await this.sidebarResult('search.cancel', searchCancelParamsSchema.parse(params))
    )
  }

  public async setSearchSourcePolicy(
    params: SearchSourcePolicyParams
  ): Promise<SearchControlResult> {
    return searchControlResultSchema.parse(
      await this.sidebarResult('search.source.policy', searchSourcePolicyParamsSchema.parse(params))
    )
  }

  public async mutateSearchSource(
    command: 'search.source.exclude' | 'search.source.forget',
    params: SearchSourceMutationParams
  ): Promise<SearchControlResult> {
    return searchControlResultSchema.parse(
      await this.sidebarResult(command, searchSourceMutationParamsSchema.parse(params))
    )
  }

  public async rebuildSearchSource(params: SearchRebuildParams): Promise<SearchControlResult> {
    return searchControlResultSchema.parse(
      await this.sidebarResult('search.source.rebuild', searchRebuildParamsSchema.parse(params))
    )
  }

  public async issueSearchExportConfirmation(
    params: SearchExportConfirmationIssueParams
  ): Promise<SearchExportConfirmationIssueResult> {
    return desktopSearchExportConfirmationIssueResultSchema.parse(
      await this.sidebarResult(
        'search.source.export.confirmation.issue',
        desktopSearchExportConfirmationIssueParamsSchema.parse(params)
      )
    )
  }

  public async exportSearchSource(params: SearchExportParams): Promise<SearchExportResult> {
    return desktopSearchExportResultSchema.parse(
      await this.sidebarResult(
        'search.source.export',
        desktopSearchExportParamsSchema.parse(params)
      )
    )
  }

  public async listTasks(params: TaskListParams): Promise<TaskListResult> {
    return taskListResultSchema.parse(
      await this.sidebarResult('task.list', taskListParamsSchema.parse(params))
    )
  }

  public async issueTaskConfirmation(
    params: TaskConfirmationIssueParams
  ): Promise<TaskConfirmationIssueResult> {
    return taskConfirmationIssueResultSchema.parse(
      await this.sidebarResult(
        'task.confirmation.issue',
        taskConfirmationIssueParamsSchema.parse(params)
      )
    )
  }

  public async actOnTask(params: TaskActionParams): Promise<TaskActionResult> {
    return taskActionResultSchema.parse(
      await this.sidebarResult('task.action', taskActionParamsSchema.parse(params))
    )
  }

  public async listRecentlyClosed(): Promise<RecentlyClosedListResult> {
    return recentlyClosedListResultSchema.parse(
      await this.sidebarResult('recentlyClosed.list', boundedListParamsSchema.parse({ limit: 100 }))
    )
  }

  public async reopenRecentlyClosed(
    params: RecentlyClosedReopenParams
  ): Promise<AdvancedTabMutationResult> {
    // The generated schema exposes exact-optional fields as `T | undefined`, while the
    // public protocol type models them as absent-or-T. Runtime parsing still guarantees T.
    return advancedTabMutationResultSchema.parse(
      await this.sidebarResult(
        'recentlyClosed.reopen',
        recentlyClosedReopenParamsSchema.parse(params)
      )
    ) as unknown as AdvancedTabMutationResult
  }

  public async attachTerminal(terminalId: string): Promise<TerminalAttachResult> {
    return terminalAttachResultSchema.parse(
      await this.result('terminal.attach', { terminalId })
    ) as TerminalAttachResult
  }

  public async getTerminalRuntimeMetadata(
    terminalId: string
  ): Promise<TerminalRuntimeMetadataResult> {
    return terminalRuntimeMetadataResultSchema.parse(
      await this.result('terminal.runtimeMetadata', { terminalId })
    )
  }

  public async detachTerminal(terminalId: string): Promise<void> {
    emptyParamsSchema.parse(await this.result('terminal.detach', { terminalId }))
  }

  public async sendTerminalInput(terminalId: string, data: string): Promise<void> {
    emptyParamsSchema.parse(
      await this.result('terminal.send', {
        terminalId,
        data: Buffer.from(data, 'utf8').toString('base64')
      })
    )
  }

  public async resizeTerminal(terminalId: string, rows: number, cols: number): Promise<void> {
    emptyParamsSchema.parse(await this.result('terminal.resize', { terminalId, rows, cols }))
  }

  public async checkpointTerminal(
    terminalId: string,
    checkpoint: TerminalCheckpoint
  ): Promise<void> {
    emptyParamsSchema.parse(await this.result('terminal.checkpoint', { terminalId, checkpoint }))
  }

  public async listWorkspaces(): Promise<WorkspaceListResult> {
    const response = await this.request('workspace.list', {})
    const result = workspaceListResultSchema.parse(this.successResult(response))
    this.assertRevision(response.revision, result.snapshot.revision, true)
    return result as WorkspaceListResult
  }

  public async getWorkspaceOrganization(): Promise<WorkspaceOrganizationGetResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    const response = await this.request('workspace.organization.get', {})
    const result = workspaceOrganizationGetResultSchema.parse(this.successResult(response))
    this.assertRevision(response.revision, result.organization.revision)
    return result as WorkspaceOrganizationGetResult
  }

  public async listSavedLayouts(): Promise<LayoutListResult> {
    await this.requireCapability(SAVED_LAYOUTS_CAPABILITY)
    const response = await this.request('layout.list', {})
    const result = layoutListResultSchema.parse(this.successResult(response))
    this.assertRevision(response.revision, result.revision)
    return result
  }

  public async getSavedLayout(params: LayoutGetParams): Promise<LayoutGetResult> {
    await this.requireCapability(SAVED_LAYOUTS_CAPABILITY)
    const response = await this.request('layout.get', layoutGetParamsSchema.parse(params))
    const result = layoutGetResultSchema.parse(this.successResult(response))
    this.assertRevision(response.revision, result.revision)
    return result
  }

  public async saveLayout(params: LayoutSaveParams): Promise<LayoutMutationResult> {
    await this.requireCapability(SAVED_LAYOUTS_CAPABILITY)
    return this.layoutMutation('layout.save', layoutSaveParamsSchema.parse(params))
  }

  public async deleteLayout(params: LayoutDeleteParams): Promise<LayoutMutationResult> {
    await this.requireCapability(SAVED_LAYOUTS_CAPABILITY)
    return this.layoutMutation('layout.delete', layoutDeleteParamsSchema.parse(params))
  }

  public async applyLayout(params: LayoutApplyParams): Promise<LayoutMutationResult> {
    await this.requireCapability(SAVED_LAYOUTS_CAPABILITY)
    return this.layoutMutation('layout.apply', layoutApplyParamsSchema.parse(params))
  }

  public async exportLayout(params: LayoutExportParams): Promise<LayoutExportResult> {
    await this.requireCapability(SAVED_LAYOUTS_CAPABILITY)
    return layoutExportResultSchema.parse(
      await this.result('layout.export', layoutExportParamsSchema.parse(params))
    )
  }

  public async importLayout(params: LayoutImportParams): Promise<LayoutMutationResult> {
    await this.requireCapability(SAVED_LAYOUTS_CAPABILITY)
    return this.layoutMutation('layout.import', layoutImportParamsSchema.parse(params))
  }

  public async selectWorkspaces(params: WorkspaceSelectionReplaceParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('workspace.selectMany', workspaceSelectionReplaceParamsSchema.parse(params))
  }

  public async pinWorkspace(params: WorkspacePinParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('workspace.pin', workspacePinParamsSchema.parse(params))
  }

  public async closeSelectedWorkspaces(params: WorkspaceBatchCloseParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('workspace.closeSelected', workspaceBatchCloseParamsSchema.parse(params))
  }

  public async reorderWorkspace(params: WorkspaceCanonicalMoveParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('workspace.reorder', workspaceCanonicalMoveParamsSchema.parse(params))
  }

  public async createGroup(params: GroupCreateParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('group.create', groupCreateParamsSchema.parse(params))
  }

  public async renameGroup(params: GroupRenameParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('group.rename', groupRenameParamsSchema.parse(params))
  }

  public async deleteGroup(params: GroupDeleteParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('group.delete', groupDeleteParamsSchema.parse(params))
  }

  public async moveGroup(params: GroupMoveParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('group.move', groupMoveParamsSchema.parse(params))
  }

  public async assignWorkspaceGroup(params: GroupAssignParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('group.assign', groupAssignParamsSchema.parse(params))
  }

  public async collapseGroup(params: GroupCollapseParams): Promise<MutationResult> {
    await this.requireCapability(WORKSPACE_GROUPS_CAPABILITY)
    return this.mutate('group.collapse', groupCollapseParamsSchema.parse(params))
  }

  public async snapshotWorkspace(
    params: WorkspaceSnapshotParams
  ): Promise<WorkspaceSnapshotResult> {
    const response = await this.request('workspace.snapshot', params)
    const result = workspaceSnapshotResultSchema.parse(this.successResult(response))
    this.assertRevision(response.revision, result.revision)
    return result as WorkspaceSnapshotResult
  }

  public async getWorkspaceCardSlots(
    params: WorkspaceCardSlotsSnapshotParams
  ): Promise<WorkspaceCardSlotsSnapshot> {
    const response = await this.request(
      'workspace.cardSlots.get',
      workspaceCardSlotsSnapshotParamsSchema.parse(params)
    )
    if (response.revision !== undefined) {
      throw new Error('Workspace card-slot responses must not use the application revision')
    }
    return workspaceCardSlotsSnapshotSchema.parse(this.successResult(response))
  }

  public async replaceWorkspaceCardSlots(
    params: WorkspaceCardSlotsReplaceParams
  ): Promise<WorkspaceCardSlotsSnapshot> {
    const response = await this.request(
      'workspace.cardSlots.replace',
      workspaceCardSlotsReplaceParamsSchema.parse(params)
    )
    if (response.revision !== undefined) {
      throw new Error('Workspace card-slot responses must not use the application revision')
    }
    return workspaceCardSlotsSnapshotSchema.parse(this.successResult(response))
  }

  public async getWorkspaceCardSlotV2(
    params: WorkspaceCardSlotV2GetParams
  ): Promise<WorkspaceCardSlotV2Snapshot> {
    const response = await this.request(
      'workspace.cardSlots.v2.get',
      workspaceCardSlotV2GetParamsSchema.parse(params)
    )
    if (response.revision !== undefined) {
      throw new Error('Workspace card-slot v2 responses must not use the application revision')
    }
    return workspaceCardSlotV2SnapshotSchema.parse(this.successResult(response))
  }

  public async replaceWorkspaceCardSlotV2(
    params: WorkspaceCardSlotV2ReplaceParams
  ): Promise<WorkspaceCardSlotV2Snapshot> {
    const response = await this.request(
      'workspace.cardSlots.v2.replace',
      workspaceCardSlotV2ReplaceParamsSchema.parse(params)
    )
    if (response.revision !== undefined) {
      throw new Error('Workspace card-slot v2 responses must not use the application revision')
    }
    return workspaceCardSlotV2SnapshotSchema.parse(this.successResult(response))
  }

  public async getWorkspaceAttention(
    params: WorkspaceAttentionSnapshotParams
  ): Promise<WorkspaceAttentionSnapshot> {
    const response = await this.request(
      'workspace.attention.get',
      workspaceAttentionSnapshotParamsSchema.parse(params)
    )
    if (response.revision !== undefined) {
      throw new Error('Workspace attention responses must not use the application revision')
    }
    return workspaceAttentionSnapshotSchema.parse(
      this.successResult(response)
    ) as WorkspaceAttentionSnapshot
  }

  public async acknowledgeAttention(
    params: AttentionAcknowledgementParams
  ): Promise<AttentionAcknowledgementResult> {
    const response = await this.request(
      'attention.acknowledge',
      attentionAcknowledgementParamsSchema.parse(params)
    )
    if (response.revision !== undefined) {
      throw new Error('Attention acknowledgement must not use the application revision')
    }
    return attentionAcknowledgementResultSchema.parse(
      this.successResult(response)
    ) as AttentionAcknowledgementResult
  }

  public createWorkspace(params: WorkspaceCreateParams): Promise<MutationResult> {
    return this.mutate('workspace.create', params)
  }

  public updateWorkspace(params: WorkspaceUpdateParams): Promise<MutationResult> {
    return this.mutate('workspace.update', params)
  }

  public selectWorkspace(params: WorkspaceSelectParams): Promise<MutationResult> {
    return this.mutate('workspace.select', params)
  }

  public moveWorkspace(params: WorkspaceMoveParams): Promise<MutationResult> {
    return this.mutate('workspace.move', params)
  }

  public closeWorkspace(params: WorkspaceCloseParams): Promise<MutationResult> {
    return this.mutate('workspace.close', params)
  }

  public splitPane(params: PaneSplitParams): Promise<MutationResult> {
    return this.mutate('pane.split', params)
  }

  public focusPane(params: PaneFocusParams): Promise<MutationResult> {
    return this.mutate('pane.focus', params)
  }

  public resizePane(params: PaneResizeParams): Promise<MutationResult> {
    return this.mutate('pane.resize', params)
  }

  public closePane(params: PaneCloseParams): Promise<MutationResult> {
    return this.mutate('pane.close', params)
  }

  public moveTabToPane(params: PaneMoveTabParams): Promise<MutationResult> {
    return this.mutate('pane.moveTab', params)
  }

  public openTerminalTab(params: TabOpenTerminalParams): Promise<MutationResult> {
    return this.mutate('tab.openTerminal', params)
  }

  public openBrowserTab(params: TabOpenBrowserParams): Promise<MutationResult> {
    return this.mutate('tab.openBrowser', params)
  }

  public navigateBrowser(params: BrowserNavigateParams): Promise<MutationResult> {
    return this.mutate('browser.navigate', params)
  }

  public browserBack(params: BrowserBackParams): Promise<MutationResult> {
    return this.mutate('browser.back', params)
  }

  public browserForward(params: BrowserForwardParams): Promise<MutationResult> {
    return this.mutate('browser.forward', params)
  }

  public reloadBrowser(params: BrowserReloadParams): Promise<MutationResult> {
    return this.mutate('browser.reload', params)
  }

  public stopBrowser(params: BrowserStopParams): Promise<MutationResult> {
    return this.mutate('browser.stop', params)
  }

  public openBrowserDevTools(params: BrowserOpenDevToolsParams): Promise<MutationResult> {
    return this.mutate('browser.openDevTools', params)
  }

  public observeBrowser(params: BrowserObserveParams): Promise<MutationResult> {
    return this.mutate('browser.observe', params)
  }

  public selectTab(params: TabSelectParams): Promise<MutationResult> {
    return this.mutate('tab.select', params)
  }

  public updateTab(params: TabUpdateParams): Promise<MutationResult> {
    return this.mutate('tab.update', params)
  }

  public moveTab(params: TabMoveParams): Promise<MutationResult> {
    return this.mutate('tab.move', params)
  }

  public closeTab(params: TabCloseParams): Promise<MutationResult> {
    return this.mutate('tab.close', params)
  }

  public restartTerminal(params: TerminalRestartParams): Promise<MutationResult> {
    return this.mutate('terminal.restart', params)
  }

  public async listNotifications(params: NotificationListParams): Promise<NotificationListResult> {
    const response = await this.request('notification.list', params)
    const result = notificationListResultSchema.parse(this.successResult(response))
    this.assertRevision(response.revision, result.revision)
    return result as NotificationListResult
  }

  public markNotificationRead(params: NotificationMarkReadParams): Promise<MutationResult> {
    return this.mutate('notification.markRead', params)
  }

  public markNotificationUnread(params: NotificationMarkUnreadParams): Promise<MutationResult> {
    return this.mutate('notification.markUnread', params)
  }

  public clearNotifications(params: NotificationClearParams): Promise<MutationResult> {
    return this.mutate('notification.clear', params)
  }

  public async getSettings(): Promise<SettingsGetResult> {
    const response = await this.request('settings.get', {})
    const result = settingsGetResultSchema.parse(this.successResult(response))
    this.assertRevision(response.revision, result.revision)
    return result
  }

  public updateSettings(params: SettingsUpdateParams): Promise<MutationResult> {
    return this.mutate('settings.update', params)
  }

  public resetSettingKey(params: SettingsResetKeyParams): Promise<MutationResult> {
    return this.mutate('settings.resetKey', params)
  }

  public async getConfiguration(): Promise<ConfigurationGetResult> {
    const response = await this.request('configuration.get', {})
    const result = configurationGetResultSchema.parse(this.successResult(response))
    this.assertIndependentRevision(response.revision, result.config.revision)
    return result as ConfigurationGetResult
  }

  public async updateConfiguration(
    params: ConfigurationUpdateParams
  ): Promise<ConfigurationGetResult> {
    const response = await this.request(
      'configuration.update',
      configurationUpdateParamsSchema.parse(params)
    )
    const result = configurationGetResultSchema.parse(this.successResult(response))
    this.assertIndependentRevision(response.revision, result.config.revision)
    return result as ConfigurationGetResult
  }

  public async getWindowState(): Promise<WindowStateGetResult> {
    const response = await this.request('window.getState', {})
    const result = windowStateGetResultSchema.parse(this.successResult(response))
    this.assertIndependentRevision(response.revision, result.state?.revision)
    return result as WindowStateGetResult
  }

  public async getWindowStateFor(
    params: WindowStateGetForParams
  ): Promise<WindowStateGetForResult> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    const response = await this.request(
      'windowState.getFor',
      windowStateGetForParamsSchema.parse(params)
    )
    const result = windowStateGetForResultSchema.parse(this.successResult(response))
    this.assertIndependentRevision(response.revision, result.state?.revision)
    return result as WindowStateGetForResult
  }

  public async updateWindowStateFor(
    params: WindowStateUpdateForParams
  ): Promise<WindowStateGetForResult> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    const response = await this.request(
      'windowState.updateFor',
      windowStateUpdateForParamsSchema.parse(params)
    )
    const result = windowStateGetForResultSchema.parse(this.successResult(response))
    this.assertIndependentRevision(response.revision, result.state?.revision)
    return result as WindowStateGetForResult
  }

  public async updateWindowState(params: WindowStateUpdateParams): Promise<WindowStateGetResult> {
    const response = await this.request(
      'window.updateState',
      windowStateUpdateParamsSchema.parse(params)
    )
    const result = windowStateGetResultSchema.parse(this.successResult(response))
    this.assertIndependentRevision(response.revision, result.state?.revision)
    return result as WindowStateGetResult
  }

  public onTerminalEvent(listener: (event: TerminalEventMessage) => void): () => void {
    this.terminalEventListeners.add(listener)
    return () => this.terminalEventListeners.delete(listener)
  }

  public onDomainEvent(listener: (event: DomainEventMessage) => void): () => void {
    this.domainEventListeners.add(listener)
    return () => this.domainEventListeners.delete(listener)
  }

  public onMultiWindowEvent(listener: (event: MultiWindowEventMessage) => void): () => void {
    this.multiWindowEventListeners.add(listener)
    return () => this.multiWindowEventListeners.delete(listener)
  }

  public onWorkspaceCardSlotsEvent(
    listener: (event: WorkspaceCardSlotsEventMessage) => void
  ): () => void {
    this.cardSlotEventListeners.add(listener)
    return () => this.cardSlotEventListeners.delete(listener)
  }

  public onWorkspaceCardSlotV2Event(
    listener: (event: WorkspaceCardSlotV2EventMessage) => void
  ): () => void {
    this.cardSlotV2EventListeners.add(listener)
    return () => this.cardSlotV2EventListeners.delete(listener)
  }

  public onWorkspaceAttentionEvent(
    listener: (event: WorkspaceAttentionEventMessage) => void
  ): () => void {
    this.attentionEventListeners.add(listener)
    return () => this.attentionEventListeners.delete(listener)
  }

  public onDomainResyncRequired(listener: (notice: DomainResyncNotice) => void): () => void {
    this.domainResyncListeners.add(listener)
    return () => this.domainResyncListeners.delete(listener)
  }

  public onServiceEvent(listener: (event: ServiceEventMessage) => void): () => void {
    this.serviceEventListeners.add(listener)
    return () => this.serviceEventListeners.delete(listener)
  }

  public async listAgentCatalog(params: AgentCatalogListParams): Promise<AgentCatalogListResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentCatalogListResultSchema.parse(
      await this.result('agent.catalog.list', agentCatalogListParamsSchema.parse(params))
    )
  }

  public async getAgentSession(params: AgentCatalogGetParams): Promise<AgentCatalogGetResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentCatalogGetResultSchema.parse(
      await this.result('agent.catalog.get', agentCatalogGetParamsSchema.parse(params))
    )
  }

  public async registerAgentSession(
    params: AgentCatalogRegisterParams
  ): Promise<AgentCatalogRegisterResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentCatalogRegisterResultSchema.parse(
      await this.result('agent.catalog.register', agentCatalogRegisterParamsSchema.parse(params))
    )
  }

  public async assessAgentRestore(
    params: AgentRestoreAssessParams
  ): Promise<AgentRestoreAssessResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentRestoreAssessResultSchema.parse(
      await this.result('agent.restore.assess', agentRestoreAssessParamsSchema.parse(params))
    )
  }

  public async restoreAgentSession(
    params: AgentSessionRestoreParams
  ): Promise<AgentSessionRestoreResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentSessionRestoreResultSchema.parse(
      await this.result('agent.session.restore', agentSessionRestoreParamsSchema.parse(params))
    )
  }

  public async forkAgentSession(params: AgentSessionForkParams): Promise<AgentSessionForkResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentSessionForkResultSchema.parse(
      await this.result('agent.session.fork', agentSessionForkParamsSchema.parse(params))
    )
  }

  public async preflightAgentHibernation(
    params: AgentHibernationPreflightParams
  ): Promise<AgentHibernationPreflightResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentHibernationPreflightResultSchema.parse(
      await this.result(
        'agent.hibernate.preflight',
        agentHibernationPreflightParamsSchema.parse(params)
      )
    )
  }

  public async confirmAgentHibernation(
    params: AgentHibernationConfirmParams
  ): Promise<AgentHibernationMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentHibernationMutationResultSchema.parse(
      await this.result(
        'agent.hibernate.confirm',
        agentHibernationConfirmParamsSchema.parse(params)
      )
    )
  }

  public async cancelAgentHibernation(
    params: AgentHibernationCancelParams
  ): Promise<AgentHibernationMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentHibernationMutationResultSchema.parse(
      await this.result('agent.hibernate.cancel', agentHibernationCancelParamsSchema.parse(params))
    )
  }

  public async createAgentTeam(params: AgentTeamCreateParams): Promise<AgentTeamMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentTeamMutationResultSchema.parse(
      await this.result('agent.team.create', agentTeamCreateParamsSchema.parse(params))
    )
  }

  public async updateAgentTeam(params: AgentTeamUpdateParams): Promise<AgentTeamMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentTeamMutationResultSchema.parse(
      await this.result('agent.team.update', agentTeamUpdateParamsSchema.parse(params))
    )
  }

  public async deleteAgentTeam(params: AgentTeamDeleteParams): Promise<AgentTeamMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentTeamMutationResultSchema.parse(
      await this.result('agent.team.delete', agentTeamDeleteParamsSchema.parse(params))
    )
  }

  public async createAgentTeamMember(
    params: AgentTeamMemberCreateParams
  ): Promise<AgentTeamMemberMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentTeamMemberMutationResultSchema.parse(
      await this.result('agent.team.member.create', agentTeamMemberCreateParamsSchema.parse(params))
    )
  }

  public async updateAgentTeamMember(
    params: AgentTeamMemberUpdateParams
  ): Promise<AgentTeamMemberMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentTeamMemberMutationResultSchema.parse(
      await this.result('agent.team.member.update', agentTeamMemberUpdateParamsSchema.parse(params))
    )
  }

  public async moveAgentTeamMember(
    params: AgentTeamMemberMoveParams
  ): Promise<AgentTeamMemberMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentTeamMemberMutationResultSchema.parse(
      await this.result('agent.team.member.move', agentTeamMemberMoveParamsSchema.parse(params))
    )
  }

  public async deleteAgentTeamMember(
    params: AgentTeamMemberDeleteParams
  ): Promise<AgentTeamMemberMutationResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentTeamMemberMutationResultSchema.parse(
      await this.result('agent.team.member.delete', agentTeamMemberDeleteParamsSchema.parse(params))
    )
  }

  public async setAgentAttention(
    params: AgentAttentionSetParams
  ): Promise<AgentAttentionSetResult> {
    await this.requireCapability(AGENT_SESSIONS_CAPABILITY)
    return agentAttentionSetResultSchema.parse(
      await this.result('agent.attention.set', agentAttentionSetParamsSchema.parse(params))
    )
  }

  public async listRemoteTargets(params: RemoteListParams): Promise<RemoteTargetListResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteTargetListResultSchema.parse(
      await this.result('remote.target.list', remoteListParamsSchema.parse(params))
    ) as RemoteTargetListResult
  }

  public async getRemoteTarget(params: RemoteTargetIdParams): Promise<RemoteTargetResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteTargetResultSchema.parse(
      await this.result('remote.target.get', remoteTargetIdParamsSchema.parse(params))
    )
  }

  public async createRemoteTarget(params: RemoteTargetCreateParams): Promise<RemoteTargetResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteTargetResultSchema.parse(
      await this.result('remote.target.create', remoteTargetCreateParamsSchema.parse(params))
    )
  }

  public async deleteRemoteTarget(params: RemoteTargetDeleteParams): Promise<RemoteTargetResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteTargetResultSchema.parse(
      await this.result('remote.target.delete', remoteTargetDeleteParamsSchema.parse(params))
    )
  }

  public async listRemoteSessions(params: RemoteListParams): Promise<RemoteSessionListResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteSessionListResultSchema.parse(
      await this.result('remote.session.list', remoteListParamsSchema.parse(params))
    ) as RemoteSessionListResult
  }

  public async getRemoteSession(params: RemoteSessionIdParams): Promise<RemoteSessionResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteSessionResultSchema.parse(
      await this.result('remote.session.get', remoteSessionIdParamsSchema.parse(params))
    ) as RemoteSessionResult
  }

  public async connectRemoteSession(
    params: RemoteSessionConnectParams
  ): Promise<RemoteSessionResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteSessionResultSchema.parse(
      await this.result('remote.session.connect', remoteSessionConnectParamsSchema.parse(params))
    ) as RemoteSessionResult
  }

  public async scanRemoteHostKey(params: RemoteHostKeyScanParams): Promise<RemoteHostKeyChallenge> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteHostKeyChallengeSchema.parse(
      await this.result('remote.hostKey.scan', remoteHostKeyScanParamsSchema.parse(params))
    )
  }

  public async decideRemoteHostKey(params: RemoteHostKeyTrustParams): Promise<RemoteSessionResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteSessionResultSchema.parse(
      await this.result('remote.hostKey.decide', remoteHostKeyTrustParamsSchema.parse(params))
    ) as RemoteSessionResult
  }

  public async detachRemoteSession(
    params: RemoteSessionDetachParams
  ): Promise<RemoteSessionResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteSessionResultSchema.parse(
      await this.result('remote.session.detach', remoteSessionDetachParamsSchema.parse(params))
    ) as RemoteSessionResult
  }

  public async reconnectRemoteSession(
    params: RemoteSessionReconnectParams
  ): Promise<RemoteSessionResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteSessionResultSchema.parse(
      await this.result(
        'remote.session.reconnect',
        remoteSessionReconnectParamsSchema.parse(params)
      )
    ) as RemoteSessionResult
  }

  public async closeRemoteSession(params: RemoteSessionCloseParams): Promise<RemoteSessionResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteSessionResultSchema.parse(
      await this.result('remote.session.close', remoteSessionCloseParamsSchema.parse(params))
    ) as RemoteSessionResult
  }

  public async discoverRemoteTmux(
    params: RemoteTmuxDiscoverParams
  ): Promise<RemoteTmuxDiscoveryResult> {
    await this.requireCapability(REMOTE_SESSIONS_CAPABILITY)
    return remoteTmuxDiscoveryResultSchema.parse(
      await this.result('remote.tmux.discover', remoteTmuxDiscoverParamsSchema.parse(params))
    )
  }

  public close(): void {
    const socket = this.socket
    this.socket = undefined
    socket?.destroy()
    this.resetNegotiation()
    this.fail(new Error('The local control service connection was closed'))
  }

  private async requireCapability(capability: string): Promise<void> {
    const identity = await this.identify()
    if (!identity.capabilities.includes(capability)) {
      throw new UnsupportedServiceCapabilityError(capability)
    }
  }

  private resetNegotiation(): void {
    this.identity = undefined
    this.identityRequest = undefined
  }

  private async result(
    command: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    return this.successResult(await this.request(command, params, timeoutMs))
  }

  private async replayActionInvocation(
    params: ActionInvokeParams
  ): Promise<{ invocation: ActionInvocationSnapshot }> {
    return actionInvokeResultSchema.parse(
      await this.actionRequestWithRecovery('action.invoke', params)
    ) as unknown as { invocation: ActionInvocationSnapshot }
  }

  private async actionRequestWithRecovery(
    command: 'action.invoke' | 'action.cancel',
    params: Record<string, unknown>
  ): Promise<unknown> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!this.socket || this.socket.destroyed) await this.connect()
        await this.requireCapability(ACTIONS_CAPABILITY)
        return await this.result(command, params, ACTION_REQUEST_TIMEOUT_MS)
      } catch (error) {
        if (error instanceof ControlRequestError) throw error
        lastError = error
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('The public action request could not be recovered')
  }

  private async mutate(command: string, params: object): Promise<MutationResult> {
    const response = mutationResponseEnvelopeSchema.parse(await this.request(command, params))
    this.observeRevision(response.revision, true)
    return response.result as MutationResult
  }

  private async layoutMutation(command: string, params: object): Promise<LayoutMutationResult> {
    const response = await this.request(command, params)
    const result = layoutMutationResultSchema.parse(this.successResult(response))
    this.assertRevision(response.revision, result.revision)
    return result
  }

  private async multiWindowMutation<T>(
    command: string,
    params: object,
    schema: ResultSchema<T>
  ): Promise<T> {
    await this.requireCapability(MULTI_WINDOW_CAPABILITY)
    const response = await this.request(command, params)
    const result = schema.parse(this.successResult(response))
    const revision = (result as { revision?: unknown }).revision
    if (typeof revision !== 'number') throw new Error('Multi-window result omitted its revision')
    this.assertRevision(response.revision, revision)
    return result
  }

  private request(command: string, params: object, timeoutMs?: number): Promise<ResponseEnvelope> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('The local control service is not connected'))
    }

    const id = randomUUID()
    const frame = `${JSON.stringify({ id, command, params })}\n`
    if (Buffer.byteLength(frame) > MAX_CONTROL_MESSAGE_BYTES) {
      return Promise.reject(new Error('The local control request exceeds the maximum frame size'))
    }
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (!this.pending.delete(id)) return
              reject(new Error(`The ${command} response timed out`))
            }, timeoutMs)
      this.pending.set(id, { resolve, reject, ...(timer === undefined ? {} : { timer }) })
      socket.write(frame, (error) => {
        if (error) {
          const pending = this.pending.get(id)
          this.pending.delete(id)
          if (pending?.timer) clearTimeout(pending.timer)
          reject(error)
        }
      })
    })
  }

  private successResult(response: ResponseEnvelope): unknown {
    if (!response.ok) {
      throw new Error(response.error?.message ?? 'The local control service rejected the request')
    }
    if (response.result === undefined) {
      throw new Error('The local control service omitted the response result')
    }
    return response.result
  }

  private assertRevision(
    envelopeRevision: number | undefined,
    resultRevision: number,
    projectionIsComplete = false
  ): void {
    if (envelopeRevision !== resultRevision) {
      throw new Error('The local control service sent inconsistent response revisions')
    }
    this.observeRevision(resultRevision, projectionIsComplete)
  }

  private assertIndependentRevision(
    envelopeRevision: number | undefined,
    resultRevision: number | undefined
  ): void {
    if (envelopeRevision !== resultRevision) {
      throw new Error('The local control service sent inconsistent response revisions')
    }
  }

  private observeRevision(revision: number, projectionIsComplete = false): void {
    const previous = this.lastRevision
    if (previous !== undefined && revision > previous + 1 && !projectionIsComplete) {
      const notice = { expectedRevision: previous + 1, receivedRevision: revision }
      for (const listener of this.domainResyncListeners) listener(notice)
    }
    if (previous === undefined || revision > previous) this.lastRevision = revision
  }

  private receive(chunk: string): void {
    let decoded: DecodedControlFrames
    try {
      decoded = decodeControlFrames(this.buffer + chunk)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      this.close()
      return
    }
    this.buffer = decoded.remainder
    for (const line of decoded.frames) this.handleLine(line)
  }

  private handleLine(line: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      this.fail(new Error('The local control service sent invalid JSON'))
      return
    }

    let multiWindowWireEvent: MultiWindowEventMessage | undefined
    try {
      multiWindowWireEvent = parseMultiWindowWireEvent(decoded)
    } catch {
      this.fail(new Error('The local control service sent an invalid multi-window event'))
      this.close()
      return
    }
    if (multiWindowWireEvent) {
      if (multiWindowWireEvent.event === 'window.topologyChanged') this.resetNegotiation()
      for (const listener of this.multiWindowEventListeners) listener(multiWindowWireEvent)
      return
    }

    let actionWireEvent: ActionInvocationChangedEvent | ActionRegistryChangedEvent | undefined
    try {
      actionWireEvent = parseActionWireEvent(decoded)
    } catch {
      this.fail(new Error('The local control service sent an invalid action event'))
      this.close()
      return
    }
    if (actionWireEvent?.event === 'action.invocationChanged') {
      this.receiveActionInvocationEvent(actionWireEvent)
      return
    }
    if (actionWireEvent?.event === 'action.registryChanged') {
      for (const listener of this.actionRegistryEventListeners) listener(actionWireEvent)
      return
    }

    const event = protocolEventSchema.safeParse(decoded)
    if (event.success) {
      if (event.data.event.startsWith('terminal.')) {
        for (const listener of this.terminalEventListeners)
          listener(event.data as TerminalEventMessage)
      } else if (event.data.event === 'workspace.cardSlotsChanged') {
        const cardSlotEvent = workspaceCardSlotsChangedEventSchema.parse(event.data)
        for (const listener of this.cardSlotEventListeners) listener(cardSlotEvent)
      } else if (event.data.event === 'workspace.cardSlots.v2Changed') {
        const cardSlotEvent = workspaceCardSlotV2ChangedEventSchema.parse(event.data)
        for (const listener of this.cardSlotV2EventListeners) listener(cardSlotEvent)
      } else if (event.data.event === 'workspace.attentionChanged') {
        const attentionEvent = workspaceAttentionChangedEventSchema.parse(event.data)
        for (const listener of this.attentionEventListeners) listener(attentionEvent)
      } else if (event.data.event === 'service.shuttingDown') {
        for (const listener of this.serviceEventListeners) listener(event.data)
      } else {
        this.receiveDomainEvent(event.data as DomainEventMessage)
      }
      return
    }

    const parsed = responseEnvelopeSchema.safeParse(decoded)
    if (!parsed.success) {
      this.fail(new Error('The local control service sent an invalid response'))
      return
    }
    const response = parsed.data as ResponseEnvelope
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    if (pending.timer) clearTimeout(pending.timer)
    if (response.ok) pending.resolve(response)
    else {
      const error = response.error
      pending.reject(
        error
          ? new ControlRequestError(error.code, error.message)
          : new Error('The local control service rejected the request')
      )
    }
  }

  private receiveDomainEvent(event: DomainEventMessage): void {
    const previous = this.lastRevision
    if (previous !== undefined && event.revision < previous) return
    this.observeRevision(event.revision)
    for (const listener of this.domainEventListeners) listener(event)
  }

  private waitForActionProgress(
    invocationId: string,
    correlationId: string,
    timeoutMs: number
  ): Promise<ActionInvocationChangedEvent | undefined> {
    const observed = this.actionInvocationEvents.get(correlationId)
    if (
      observed &&
      observed.invocationId === invocationId &&
      isTerminalActionState(observed.state)
    ) {
      return Promise.resolve(observed)
    }
    if (this.pendingActionInvocations.has(correlationId)) {
      return Promise.reject(new Error('The public action correlation is already pending'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActionInvocations.delete(correlationId)
        resolve(undefined)
      }, timeoutMs)
      this.pendingActionInvocations.set(correlationId, { invocationId, resolve, reject, timer })
    })
  }

  private receiveActionInvocationEvent(event: ActionInvocationChangedEvent): void {
    const previous = this.actionInvocationEvents.get(event.correlationId)
    if (!previous || event.updatedAtMs >= previous.updatedAtMs) {
      this.actionInvocationEvents.set(event.correlationId, event)
    }
    while (this.actionInvocationEvents.size > 4_096) {
      const oldest = this.actionInvocationEvents.keys().next().value
      if (oldest === undefined) break
      this.actionInvocationEvents.delete(oldest)
    }
    if (!isTerminalActionState(event.state)) return
    const pending = this.pendingActionInvocations.get(event.correlationId)
    if (!pending) return
    this.pendingActionInvocations.delete(event.correlationId)
    clearTimeout(pending.timer)
    if (pending.invocationId !== event.invocationId) {
      pending.reject(new Error('The public action lifecycle changed invocation identity'))
    } else {
      pending.resolve(event)
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    for (const invocation of this.pendingActionInvocations.values()) {
      clearTimeout(invocation.timer)
      invocation.reject(error)
    }
    this.pendingActionInvocations.clear()
  }
}

function isTerminalActionState(state: ActionInvocationChangedEvent['state']): boolean {
  return (
    state === 'acknowledged' || state === 'failed' || state === 'canceled' || state === 'expired'
  )
}

function isTerminalActionInvocation(invocation: ActionInvocationSnapshot): boolean {
  return isTerminalActionState(invocation.state)
}

function parseActionWireEvent(
  value: unknown
): ActionInvocationChangedEvent | ActionRegistryChangedEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const envelope = value as Record<string, unknown>
  if (envelope.event === 'action.invocationChanged') {
    if (Object.keys(envelope).length !== 2 || !('data' in envelope)) {
      throw new Error('Invalid action invocation event envelope')
    }
    return actionInvocationChangedEventSchema.parse(envelope.data)
  }
  if (envelope.event === 'action.registryChanged') {
    if (
      Object.keys(envelope).length !== 3 ||
      !('data' in envelope) ||
      !Number.isSafeInteger(envelope.revision)
    ) {
      throw new Error('Invalid action registry event envelope')
    }
    const event = actionRegistryChangedEventSchema.parse(envelope.data)
    if (event.registryRevision !== envelope.revision) {
      throw new Error('Inconsistent action registry event revision')
    }
    return event
  }
  return undefined
}

/** M3 service events use the common revision envelope; renderer IPC stays flat. */
function parseMultiWindowWireEvent(value: unknown): MultiWindowEventMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const envelope = value as Record<string, unknown>
  if (
    envelope.event !== 'window.topologyChanged' &&
    envelope.event !== 'tab.ownershipTransferred'
  ) {
    return undefined
  }
  return multiWindowProtocolEventSchema.parse(value).data
}

interface DecodedControlFrames {
  frames: string[]
  remainder: string
}

export function decodeControlFrames(buffer: string): DecodedControlFrames {
  const frames: string[] = []
  let offset = 0
  let newline = buffer.indexOf('\n', offset)
  while (newline >= 0) {
    const line = buffer.slice(offset, newline)
    if (Buffer.byteLength(line) + 1 > MAX_CONTROL_MESSAGE_BYTES) {
      throw new Error('The local control service sent an oversized message')
    }
    frames.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    offset = newline + 1
    newline = buffer.indexOf('\n', offset)
  }
  const remainder = buffer.slice(offset)
  if (Buffer.byteLength(remainder) > MAX_CONTROL_MESSAGE_BYTES) {
    throw new Error('The local control service sent an oversized message')
  }
  return { frames, remainder }
}
