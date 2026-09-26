import {
  searchQueryParamsSchema,
  searchQueryResultSchema,
  searchCancelParamsSchema,
  searchCancelResultSchema,
  searchSourcePolicyParamsSchema,
  searchSourceMutationParamsSchema,
  searchRebuildParamsSchema,
  searchExportParamsSchema,
  searchExportConfirmationIssueParamsSchema,
  searchExportConfirmationIssueResultSchema,
  searchExportResultSchema,
  searchControlResultSchema,
  diagnosticExportRequestSchema,
  diagnosticExportResultSchema,
  terminalAttachResultSchema,
  terminalCreateResultSchema,
  terminalErrorSchema,
  terminalEventSchema,
  stateSnapshotResultSchema,
  settingsGetResultSchema,
  configurationQualificationSchema,
  settingsWriteRequestSchema,
  settingsResetRequestSchema,
  settingsMutationResultSchema,
  notificationPageRequestSchema,
  notificationListResultSchema,
  notificationWriteRequestSchema,
  notificationPublishRequestSchema,
  notificationClearRequestSchema,
  notificationChangeResultSchema,
  workspaceCardSlotsSnapshotParamsSchema,
  workspaceCardSlotsSnapshotSchema,
  workspaceCardSlotsReplaceParamsSchema,
  workspaceCardSlotV2GetParamsSchema,
  workspaceCardSlotV2SnapshotSchema,
  workspaceCardSlotV2ReplaceParamsSchema,
  workspaceAttentionSnapshotParamsSchema,
  workspaceAttentionSnapshotSchema,
  attentionAcknowledgementParamsSchema,
  attentionAcknowledgementResultSchema,
  closedItemListResultSchema,
  closedItemGetParamsSchema,
  closedItemGetResultSchema,
  tabReopenRequestSchema,
  tabReopenResultSchema,
  workspaceListResultSchema,
  workspaceMutationResultSchema,
  workspaceCreateResultSchema,
  workspaceCloseResultSchema,
  terminalRestartResultSchema,
  tabCloseResultSchema,
  tabOpenTerminalResultSchema,
  tabOpenBrowserResultSchema,
  paneSplitResultSchema,
  paneCloseResultSchema,
  workspaceOrganizationGetResultSchema,
  layoutListResultSchema,
  layoutGetResultSchema,
  layoutExportResultSchema,
  remoteListParamsSchema,
  remoteSessionIdParamsSchema,
  remoteTargetListResultSchema,
  remoteTargetResultSchema,
  remoteSessionListResultSchema,
  remoteSessionResultSchema,
  remoteTerminalResultSchema,
  remoteSessionReconnectParamsSchema,
  agentCatalogListParamsSchema,
  agentCatalogListResultSchema,
  agentCatalogGetResultSchema,
  agentCatalogRegisterParamsSchema,
  agentCatalogRegisterResultSchema,
  agentRestoreAssessParamsSchema,
  agentRestoreAssessResultSchema,
  agentSessionRestoreParamsSchema,
  agentSessionRestoreResultSchema,
  agentSessionForkParamsSchema,
  agentSessionForkResultSchema,
  agentAttentionSetParamsSchema,
  agentAttentionSetResultSchema,
  agentTeamCreateParamsSchema,
  agentTeamUpdateParamsSchema,
  agentTeamDeleteParamsSchema,
  agentTeamMutationResultSchema,
  agentTeamMemberCreateParamsSchema,
  agentTeamMemberUpdateParamsSchema,
  agentTeamMemberMoveParamsSchema,
  agentTeamMemberDeleteParamsSchema,
  agentTeamMemberMutationResultSchema,
  actionListParamsSchema,
  actionListResultSchema,
  actionInvokeParamsSchema,
  actionInvokeResultSchema,
  actionCancelParamsSchema,
  actionCancelResultSchema,
  taskListParamsSchema,
  taskListResultSchema,
  taskActionParamsSchema,
  taskActionResultSchema,
  taskConfirmationIssueParamsSchema,
  taskConfirmationIssueResultSchema,
  recentlyClosedListResultSchema,
  recentlyClosedReopenParamsSchema,
  sidebarGetParamsSchema,
  sidebarPlacementSchema,
  sidebarSaveParamsSchema,
  sidebarListResultSchema,
  boundedListParamsSchema,
  workspaceRootListResultSchema,
  workspaceDirectoryListParamsSchema,
  workspaceDirectoryListResultSchema,
  contentDocumentIssueParamsSchema,
  contentDocumentIssueResultSchema,
  contentReadParamsSchema,
  contentSaveParamsSchema,
  contentSaveResultSchema,
  contentPreviewSchema,
  contentMarkdownParamsSchema,
  safeMarkdownDocumentSchema,
  contentDiffParamsSchema,
  contentDiffResultSchema,
  textBoxIdParamsSchema,
  textBoxDocumentSchema,
  textBoxCreateParamsSchema,
  textBoxSaveParamsSchema,
  textBoxDeleteParamsSchema,
  textBoxListResultSchema,
  remoteHostKeyChallengeSchema,
  remoteTmuxDiscoveryResultSchema,
  terminalRuntimeMetadataResultSchema,
  type TerminalRestartRequest,
  type TabSelectRequest,
  type TabCloseRequest,
  type TabOpenTerminalRequest,
  type TabOpenBrowserRequest,
  type BrowserNavigateRequest,
  type BrowserActionRequest,
  type BrowserObserveRequest,
  type PaneFocusRequest,
  type PaneResizeRequest,
  type PaneSplitRequest,
  type PaneCloseRequest,
  type WorkspacePinRequest,
  type WorkspaceSelectionReplaceRequest,
  type WorkspaceCanonicalMoveRequest,
  type WorkspaceBatchCloseRequest,
  type LayoutSaveRequest,
  type LayoutDeleteRequest,
  type LayoutApplyRequest,
  type LayoutImportRequest,
  type RemoteTargetCreateParams,
  type RemoteSessionConnectParams,
  type RemoteSessionReconnectParams,
  type RemoteSessionDetachParams,
  type RemoteSessionCloseParams,
  type AgentCatalogListParams,
  type ActionListParams,
  type RemoteHostKeyScanParams,
  type RemoteHostKeyTrustParams,
  type RemoteTmuxDiscoverParams,
  type GroupCreateRequest,
  type GroupRenameRequest,
  type GroupDeleteRequest,
  type GroupMoveRequest,
  type GroupAssignRequest,
  type GroupCollapseRequest,
  type TabMoveRequest,
  type TabUpdateRequest,
  type WorkspaceCloseRequest,
  type WorkspaceCreateRequest,
  type WorkspaceMoveRequest,
  type WorkspaceSelectRequest,
  type WorkspaceUpdateRequest,
  type TerminalCheckpoint,
  type TerminalCreateParams
} from '@agent-workspace/contracts'
import {
  tabDuplicateParamsSchema,
  tabMoveExactParamsSchema,
  tabDetachParamsSchema,
  advancedTabMutationResultSchema,
  focusHistoryNavigateParamsSchema,
  focusHistoryNavigateResultSchema
} from '@agent-workspace/protocol-client'
import { z, type ZodType } from 'zod'
import {
  agentHibernationPreflightParamsSchema,
  agentHibernationPreflightResultSchema,
  agentHibernationCancelParamsSchema,
  agentHibernationConfirmParamsSchema,
  agentHibernationMutationResultSchema,
  windowListResultSchema,
  windowBindResultSchema,
  windowCreateParamsSchema,
  windowFocusParamsSchema,
  windowCloseParamsSchema,
  windowMutationResultSchema,
  windowCloseResultSchema,
  windowStateGetForParamsSchema,
  windowStateGetForResultSchema,
  windowStateUpdateForParamsSchema,
  configurationGetResultSchema,
  configurationUpdateParamsSchema,
  diagnosticBundlePreviewSchema,
  remoteTargetDeleteParamsSchema,
  type RemoteTargetDeleteParams,
  remoteTargetEnrollmentBeginSchema,
  remoteTargetEnrollmentCommitSchema,
  remoteTargetEnrollmentAbortSchema,
  remoteTargetEnrollmentAbortResultSchema,
  remoteCredentialReplacementSchema,
  browserAutomationSessionCreateParamsSchema,
  browserAutomationSessionCreateResultSchema,
  browserAutomationSessionParamsSchema,
  browserAutomationSessionResultSchema,
  browserAutomationSessionListResultSchema,
  browserAutomationOperationInvokeParamsSchema,
  browserAutomationOperationInvokeResultSchema,
  browserAutomationOperationCancelParamsSchema,
  browserAutomationScreenshotReadParamsSchema,
  browserAutomationScreenshotReadResultSchema,
  browserAutomationScreenshotReleaseParamsSchema,
  browserAutomationScreenshotReleaseResultSchema
} from '@agent-workspace/protocol-client'

const identifySchema = z.strictObject({
  application: z.literal('agent-workspace'),
  apiVersion: z.literal(1),
  idempotencyEpoch: z.uuid().optional(),
  agentProvider: z
    .strictObject({ adapterId: z.literal('codex'), adapterVersion: z.string().min(1) })
    .optional(),
  capabilities: z.array(z.string())
})

export class ServerError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ServerError'
  }
}

/** Main-process client. Keep the bearer token out of renderer state and URLs. */
export class AgentWorkspaceClient {
  private readonly baseUrl: URL

  public constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.baseUrl = new URL(baseUrl)
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)) {
      throw new Error('Terminal server URL must use HTTP or HTTPS')
    }
  }

  public identify() {
    return this.request('/v1/system/identify', 'GET', undefined, identifySchema)
  }

  public createBrowserAutomationSession(request: unknown) {
    return this.request(
      '/v1/browser-automation/sessions',
      'POST',
      browserAutomationSessionCreateParamsSchema.parse(request),
      browserAutomationSessionCreateResultSchema
    )
  }

  public listBrowserAutomationSessions() {
    return this.request(
      '/v1/browser-automation/sessions',
      'GET',
      undefined,
      browserAutomationSessionListResultSchema
    )
  }

  public getBrowserAutomationSession(request: unknown) {
    return this.request(
      '/v1/browser-automation/sessions/get',
      'POST',
      browserAutomationSessionParamsSchema.parse(request),
      browserAutomationSessionResultSchema
    )
  }

  public invokeBrowserAutomationOperation(request: unknown) {
    return this.request(
      '/v1/browser-automation/operations',
      'POST',
      browserAutomationOperationInvokeParamsSchema.parse(request),
      browserAutomationOperationInvokeResultSchema
    )
  }

  /** Exact replay is the durable status read in the Rust browser contract. */
  public async invokeBrowserAutomationUntilTerminal(request: unknown) {
    const params = browserAutomationOperationInvokeParamsSchema.parse(request)
    const deadline = Date.now() + params.timeoutMs + 5_000
    while (true) {
      const result = await this.invokeBrowserAutomationOperation(params)
      if (result.operation.state !== 'queued' && result.operation.state !== 'running') return result
      if (Date.now() >= deadline)
        throw new ServerError(408, 'timeout', 'Browser automation operation status timed out')
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  public cancelBrowserAutomationOperation(request: unknown) {
    return this.request(
      '/v1/browser-automation/operations/cancel',
      'POST',
      browserAutomationOperationCancelParamsSchema.parse(request),
      browserAutomationOperationInvokeResultSchema
    )
  }

  public readBrowserAutomationScreenshot(request: unknown) {
    return this.request(
      '/v1/browser-automation/screenshots/read',
      'POST',
      browserAutomationScreenshotReadParamsSchema.parse(request),
      browserAutomationScreenshotReadResultSchema
    )
  }

  public releaseBrowserAutomationScreenshot(request: unknown) {
    return this.request(
      '/v1/browser-automation/screenshots/release',
      'POST',
      browserAutomationScreenshotReleaseParamsSchema.parse(request),
      browserAutomationScreenshotReleaseResultSchema
    )
  }

  public destroyBrowserAutomationSession(request: unknown) {
    return this.request(
      '/v1/browser-automation/sessions/destroy',
      'POST',
      browserAutomationSessionParamsSchema.parse(request),
      browserAutomationSessionResultSchema
    )
  }

  public stateSnapshot() {
    return this.request('/v1/state/snapshot', 'GET', undefined, stateSnapshotResultSchema)
  }

  public qualifyConfiguration() {
    return this.request(
      '/v1/configuration/qualification',
      'GET',
      undefined,
      configurationQualificationSchema
    )
  }

  public getConfiguration() {
    return this.request('/v1/configuration', 'GET', undefined, configurationGetResultSchema)
  }

  public updateConfiguration(request: z.infer<typeof configurationUpdateParamsSchema>) {
    return this.request(
      '/v1/configuration/update',
      'POST',
      configurationUpdateParamsSchema.parse(request),
      configurationGetResultSchema
    )
  }

  public previewDiagnostics() {
    return this.request('/v1/diagnostics/preview', 'GET', undefined, diagnosticBundlePreviewSchema)
  }

  public exportDiagnostics(request: z.infer<typeof diagnosticExportRequestSchema>) {
    return this.request(
      '/v1/diagnostics/export',
      'POST',
      diagnosticExportRequestSchema.parse(request),
      diagnosticExportResultSchema
    )
  }

  public listClosedItems(windowCapability: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request('/v1/closed', 'GET', undefined, closedItemListResultSchema, {
      'x-agent-workspace-window-capability': windowCapability
    })
  }

  public getClosedItem(closedItemId: string, windowCapability: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    const params = closedItemGetParamsSchema.parse({ closedItemId })
    return this.request(
      `/v1/closed/${encodeURIComponent(params.closedItemId)}`,
      'GET',
      undefined,
      closedItemGetResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public reopenClosedTab(
    request: z.infer<typeof tabReopenRequestSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/tabs/reopen',
      'POST',
      tabReopenRequestSchema.parse(request),
      tabReopenResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  /** Privileged owner-only CLI route; the renderer has no discovery bearer. */
  public listClosedItemsPrivileged() {
    return this.request('/v1/cli/closed', 'GET', undefined, closedItemListResultSchema)
  }

  public getClosedItemPrivileged(closedItemId: string) {
    const params = closedItemGetParamsSchema.parse({ closedItemId })
    return this.request(
      `/v1/cli/closed/${encodeURIComponent(params.closedItemId)}`,
      'GET',
      undefined,
      closedItemGetResultSchema
    )
  }

  public reopenClosedTabPrivileged(request: z.infer<typeof tabReopenRequestSchema>) {
    return this.request(
      '/v1/cli/tabs/reopen',
      'POST',
      tabReopenRequestSchema.parse(request),
      tabReopenResultSchema
    )
  }

  public duplicateTabExact(
    request: z.infer<typeof tabDuplicateParamsSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/tabs/duplicate-exact',
      'POST',
      tabDuplicateParamsSchema.parse(request),
      advancedTabMutationResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public moveTabExact(request: z.infer<typeof tabMoveExactParamsSchema>, windowCapability: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/tabs/move-exact',
      'POST',
      tabMoveExactParamsSchema.parse(request),
      advancedTabMutationResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public detachTab(request: z.infer<typeof tabDetachParamsSchema>, windowCapability: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/tabs/detach',
      'POST',
      tabDetachParamsSchema.parse(request),
      advancedTabMutationResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public navigateFocusHistory(
    request: z.infer<typeof focusHistoryNavigateParamsSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/focus-history/navigate',
      'POST',
      focusHistoryNavigateParamsSchema.parse(request),
      focusHistoryNavigateResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  /** Main-process only: a private capability binds sidebar descriptors to the sender window. */
  public listRecentlyClosedSidebarBound(
    request: z.infer<typeof boundedListParamsSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability)) {
      throw new Error('Window capability is invalid')
    }
    return this.request(
      '/v1/sidebar/recently-closed/list',
      'POST',
      boundedListParamsSchema.parse(request),
      recentlyClosedListResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  /** Main-process only: the server rechecks the exact sender binding before commit. */
  public reopenRecentlyClosedSidebarBound(
    request: z.infer<typeof recentlyClosedReopenParamsSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability)) {
      throw new Error('Window capability is invalid')
    }
    return this.request(
      '/v1/sidebar/recently-closed/reopen',
      'POST',
      recentlyClosedReopenParamsSchema.parse(request),
      tabReopenResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public getSettings() {
    return this.request('/v1/settings', 'GET', undefined, settingsGetResultSchema)
  }

  public updateSettings(request: z.infer<typeof settingsWriteRequestSchema>) {
    return this.request(
      '/v1/settings/update',
      'POST',
      settingsWriteRequestSchema.parse(request),
      settingsMutationResultSchema
    )
  }

  public resetShortcut(request: z.infer<typeof settingsResetRequestSchema>) {
    return this.request(
      '/v1/settings/reset-key',
      'POST',
      settingsResetRequestSchema.parse(request),
      settingsMutationResultSchema
    )
  }

  public listNotifications(params: z.input<typeof notificationPageRequestSchema>) {
    const page = notificationPageRequestSchema.parse(params)
    const query = new URLSearchParams({
      windowId: page.windowId,
      unreadOnly: String(page.unreadOnly),
      offset: String(page.offset),
      limit: String(page.limit)
    })
    if (page.workspaceId) query.set('workspaceId', page.workspaceId)
    return this.request(
      `/v1/notifications?${query.toString()}`,
      'GET',
      undefined,
      notificationListResultSchema
    )
  }

  public markNotificationRead(request: z.infer<typeof notificationWriteRequestSchema>) {
    return this.request(
      '/v1/notifications/mark-read',
      'POST',
      notificationWriteRequestSchema.parse(request),
      notificationChangeResultSchema
    )
  }

  public publishNotification(request: z.infer<typeof notificationPublishRequestSchema>) {
    return this.request(
      '/v1/notifications/publish',
      'POST',
      notificationPublishRequestSchema.parse(request),
      notificationChangeResultSchema
    )
  }

  public markNotificationUnread(request: z.infer<typeof notificationWriteRequestSchema>) {
    return this.request(
      '/v1/notifications/mark-unread',
      'POST',
      notificationWriteRequestSchema.parse(request),
      notificationChangeResultSchema
    )
  }

  public clearNotifications(request: z.infer<typeof notificationClearRequestSchema>) {
    return this.request(
      '/v1/notifications/clear',
      'POST',
      notificationClearRequestSchema.parse(request),
      notificationChangeResultSchema
    )
  }

  public getWorkspaceCardSlots(workspaceId: string) {
    const input = workspaceCardSlotsSnapshotParamsSchema.parse({ workspaceId })
    return this.request(
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/card-slots`,
      'GET',
      undefined,
      workspaceCardSlotsSnapshotSchema
    )
  }

  public replaceWorkspaceCardSlots(params: z.infer<typeof workspaceCardSlotsReplaceParamsSchema>) {
    return this.request(
      '/v1/workspaces/card-slots/replace',
      'POST',
      workspaceCardSlotsReplaceParamsSchema.parse(params),
      workspaceCardSlotsSnapshotSchema
    )
  }

  public getWorkspaceCardSlotV2(
    workspaceId: string,
    kind: z.infer<typeof workspaceCardSlotV2GetParamsSchema>['kind']
  ) {
    const input = workspaceCardSlotV2GetParamsSchema.parse({ workspaceId, kind })
    return this.request(
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/card-slots/v2/${encodeURIComponent(input.kind)}`,
      'GET',
      undefined,
      workspaceCardSlotV2SnapshotSchema
    )
  }

  public replaceWorkspaceCardSlotV2(
    params: z.infer<typeof workspaceCardSlotV2ReplaceParamsSchema>
  ) {
    return this.request(
      '/v1/workspaces/card-slots/v2/replace',
      'POST',
      workspaceCardSlotV2ReplaceParamsSchema.parse(params),
      workspaceCardSlotV2SnapshotSchema
    )
  }

  public getWorkspaceAttention(workspaceId: string) {
    const input = workspaceAttentionSnapshotParamsSchema.parse({ workspaceId })
    return this.request(
      `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/attention`,
      'GET',
      undefined,
      workspaceAttentionSnapshotSchema
    )
  }

  public acknowledgeAttention(params: z.infer<typeof attentionAcknowledgementParamsSchema>) {
    return this.request(
      '/v1/attention/acknowledge',
      'POST',
      attentionAcknowledgementParamsSchema.parse(params),
      attentionAcknowledgementResultSchema
    )
  }

  public listWorkspaces() {
    return this.request('/v1/workspaces', 'GET', undefined, workspaceListResultSchema)
  }

  public listWindows() {
    return this.request('/v1/windows', 'GET', undefined, windowListResultSchema)
  }

  /** Main-process only: resolve the exact window issued by the private owner channel. */
  public getBoundWindow(windowCapability: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability)) {
      throw new Error('Window capability is invalid')
    }
    return this.request('/v1/windows/bound', 'GET', undefined, windowBindResultSchema, {
      'x-agent-workspace-window-capability': windowCapability
    })
  }

  public listBoundWorkspaces(windowCapability: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request('/v1/workspaces/bound', 'GET', undefined, workspaceListResultSchema, {
      'x-agent-workspace-window-capability': windowCapability
    })
  }

  public getBoundOrganization(windowCapability: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/organization/bound',
      'GET',
      undefined,
      workspaceOrganizationGetResultSchema,
      {
        'x-agent-workspace-window-capability': windowCapability
      }
    )
  }

  public createWindow(params: z.infer<typeof windowCreateParamsSchema>, windowCapability: string) {
    return this.request(
      '/v1/windows/create',
      'POST',
      windowCreateParamsSchema.parse(params),
      windowMutationResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public focusWindow(params: z.infer<typeof windowFocusParamsSchema>, windowCapability: string) {
    return this.request(
      '/v1/windows/focus',
      'POST',
      windowFocusParamsSchema.parse(params),
      windowMutationResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public closeWindow(params: z.infer<typeof windowCloseParamsSchema>, windowCapability: string) {
    return this.request(
      '/v1/windows/close',
      'POST',
      windowCloseParamsSchema.parse(params),
      windowCloseResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public getWindowStateFor(
    params: z.infer<typeof windowStateGetForParamsSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/windows/state/get',
      'POST',
      windowStateGetForParamsSchema.parse(params),
      windowStateGetForResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public updateWindowStateFor(
    params: z.infer<typeof windowStateUpdateForParamsSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/windows/state/update',
      'POST',
      windowStateUpdateForParamsSchema.parse(params),
      windowStateGetForResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public getOrganization() {
    return this.request('/v1/organization', 'GET', undefined, workspaceOrganizationGetResultSchema)
  }

  public listRemoteTargets(params: { limit: number; cursor?: string | null }) {
    const page = remoteListParamsSchema.parse(params)
    const query = new URLSearchParams({ limit: String(page.limit) })
    if (page.cursor) query.set('cursor', page.cursor)
    return this.request(
      `/v1/remote-targets?${query.toString()}`,
      'GET',
      undefined,
      remoteTargetListResultSchema
    )
  }

  public getRemoteTarget(targetId: string) {
    return this.request(
      `/v1/remote-targets/${encodeURIComponent(targetId)}`,
      'GET',
      undefined,
      remoteTargetResultSchema
    )
  }

  public createRemoteTarget(request: RemoteTargetCreateParams) {
    return this.request('/v1/remote-targets', 'POST', request, remoteTargetResultSchema)
  }

  public deleteRemoteTarget(request: RemoteTargetDeleteParams) {
    return this.request(
      '/v1/remote-targets/delete',
      'POST',
      remoteTargetDeleteParamsSchema.parse(request),
      remoteTargetResultSchema
    )
  }

  public beginRemoteTargetEnrollment(request: z.infer<typeof remoteTargetEnrollmentBeginSchema>) {
    return this.request(
      '/v1/remote-targets/enrollment/begin',
      'POST',
      remoteTargetEnrollmentBeginSchema.parse(request),
      remoteTargetEnrollmentBeginSchema
    )
  }

  public commitRemoteTargetEnrollment(request: z.infer<typeof remoteTargetEnrollmentCommitSchema>) {
    return this.request(
      '/v1/remote-targets/enrollment/commit',
      'POST',
      remoteTargetEnrollmentCommitSchema.parse(request),
      remoteTargetResultSchema
    )
  }

  public abortRemoteTargetEnrollment(request: z.infer<typeof remoteTargetEnrollmentAbortSchema>) {
    return this.request(
      '/v1/remote-targets/enrollment/abort',
      'POST',
      remoteTargetEnrollmentAbortSchema.parse(request),
      remoteTargetEnrollmentAbortResultSchema
    )
  }

  public beginRemoteCredentialReplacement(
    request: z.infer<typeof remoteCredentialReplacementSchema>
  ) {
    return this.request(
      '/v1/remote-targets/replacement/begin',
      'POST',
      remoteCredentialReplacementSchema.parse(request),
      remoteCredentialReplacementSchema
    )
  }

  public commitRemoteCredentialReplacement(
    request: z.infer<typeof remoteCredentialReplacementSchema>
  ) {
    return this.request(
      '/v1/remote-targets/replacement/commit',
      'POST',
      remoteCredentialReplacementSchema.parse(request),
      remoteTargetResultSchema
    )
  }

  public abortRemoteCredentialReplacement(
    request: z.infer<typeof remoteCredentialReplacementSchema>
  ) {
    return this.request(
      '/v1/remote-targets/replacement/abort',
      'POST',
      remoteCredentialReplacementSchema.parse(request),
      remoteTargetEnrollmentAbortResultSchema
    )
  }

  public listRemoteSessions(params: { limit: number; cursor?: string | null }) {
    const page = remoteListParamsSchema.parse(params)
    const query = new URLSearchParams({ limit: String(page.limit) })
    if (page.cursor) query.set('cursor', page.cursor)
    return this.request(
      `/v1/remote-sessions?${query.toString()}`,
      'GET',
      undefined,
      remoteSessionListResultSchema
    )
  }

  public getRemoteSession(sessionId: string) {
    return this.request(
      `/v1/remote-sessions/${encodeURIComponent(sessionId)}`,
      'GET',
      undefined,
      remoteSessionResultSchema
    )
  }

  public getRemoteTerminal(sessionId: string) {
    const parsed = remoteSessionIdParamsSchema.parse({ remoteSessionId: sessionId })
    return this.request(
      `/v1/remote-sessions/${encodeURIComponent(parsed.remoteSessionId)}/terminal`,
      'GET',
      undefined,
      remoteTerminalResultSchema
    )
  }

  /** Persists intent only; SSH transport and credential handoff are not available yet. */
  public prepareRemoteSession(request: RemoteSessionConnectParams) {
    return this.request('/v1/remote-sessions/prepare', 'POST', request, remoteSessionResultSchema)
  }

  public scanRemoteHostKey(request: RemoteHostKeyScanParams) {
    return this.request(
      '/v1/remote-sessions/scan-host-key',
      'POST',
      request,
      remoteHostKeyChallengeSchema
    )
  }

  public decideRemoteHostKey(request: RemoteHostKeyTrustParams) {
    return this.request(
      '/v1/remote-sessions/decide-host-key',
      'POST',
      request,
      remoteSessionResultSchema
    )
  }

  public discoverRemoteTmux(request: RemoteTmuxDiscoverParams) {
    return this.request(
      '/v1/remote-sessions/discover-tmux',
      'POST',
      request,
      remoteTmuxDiscoveryResultSchema
    )
  }

  public activateRemoteSession(request: RemoteSessionReconnectParams) {
    return this.request(
      '/v1/remote-sessions/activate',
      'POST',
      remoteSessionReconnectParamsSchema.parse(request),
      remoteSessionResultSchema
    )
  }

  public detachRemoteSession(request: RemoteSessionDetachParams) {
    return this.request('/v1/remote-sessions/detach', 'POST', request, remoteSessionResultSchema)
  }

  public closeRemoteSession(request: RemoteSessionCloseParams) {
    return this.request('/v1/remote-sessions/close', 'POST', request, remoteSessionResultSchema)
  }

  public listAgentCatalog(params: AgentCatalogListParams) {
    const request = agentCatalogListParamsSchema.parse(params)
    return this.request(
      `/v1/agent-catalog?catalogVersion=${request.catalogVersion}`,
      'GET',
      undefined,
      agentCatalogListResultSchema
    )
  }

  public getAgentSession(sessionId: string) {
    return this.request(
      `/v1/agent-catalog/${encodeURIComponent(sessionId)}`,
      'GET',
      undefined,
      agentCatalogGetResultSchema
    )
  }

  public registerAgentSession(request: z.infer<typeof agentCatalogRegisterParamsSchema>) {
    return this.request(
      '/v1/agent-catalog/register',
      'POST',
      agentCatalogRegisterParamsSchema.parse(request),
      agentCatalogRegisterResultSchema
    )
  }

  public assessAgentRestore(request: z.infer<typeof agentRestoreAssessParamsSchema>) {
    return this.request(
      '/v1/agent-sessions/restore/assess',
      'POST',
      agentRestoreAssessParamsSchema.parse(request),
      agentRestoreAssessResultSchema
    )
  }

  public restoreAgentSession(request: z.infer<typeof agentSessionRestoreParamsSchema>) {
    return this.request(
      '/v1/agent-sessions/restore',
      'POST',
      agentSessionRestoreParamsSchema.parse(request),
      agentSessionRestoreResultSchema
    )
  }

  public forkAgentSession(request: z.infer<typeof agentSessionForkParamsSchema>) {
    return this.request(
      '/v1/agent-sessions/fork',
      'POST',
      agentSessionForkParamsSchema.parse(request),
      agentSessionForkResultSchema
    )
  }

  public preflightAgentHibernation(request: z.infer<typeof agentHibernationPreflightParamsSchema>) {
    return this.request(
      '/v1/agent-sessions/hibernate/preflight',
      'POST',
      agentHibernationPreflightParamsSchema.parse(request),
      agentHibernationPreflightResultSchema
    )
  }

  public cancelAgentHibernation(request: z.infer<typeof agentHibernationCancelParamsSchema>) {
    return this.request(
      '/v1/agent-sessions/hibernate/cancel',
      'POST',
      agentHibernationCancelParamsSchema.parse(request),
      agentHibernationMutationResultSchema
    )
  }

  public confirmAgentHibernation(request: z.infer<typeof agentHibernationConfirmParamsSchema>) {
    return this.request(
      '/v1/agent-sessions/hibernate/confirm',
      'POST',
      agentHibernationConfirmParamsSchema.parse(request),
      agentHibernationMutationResultSchema
    )
  }

  public setAgentAttention(request: z.infer<typeof agentAttentionSetParamsSchema>) {
    return this.request(
      '/v1/agent-attention/set',
      'POST',
      agentAttentionSetParamsSchema.parse(request),
      agentAttentionSetResultSchema
    )
  }

  public createAgentTeam(request: z.infer<typeof agentTeamCreateParamsSchema>) {
    return this.request(
      '/v1/agent-teams/create',
      'POST',
      agentTeamCreateParamsSchema.parse(request),
      agentTeamMutationResultSchema
    )
  }

  public updateAgentTeam(request: z.infer<typeof agentTeamUpdateParamsSchema>) {
    return this.request(
      '/v1/agent-teams/update',
      'POST',
      agentTeamUpdateParamsSchema.parse(request),
      agentTeamMutationResultSchema
    )
  }

  public deleteAgentTeam(request: z.infer<typeof agentTeamDeleteParamsSchema>) {
    return this.request(
      '/v1/agent-teams/delete',
      'POST',
      agentTeamDeleteParamsSchema.parse(request),
      agentCatalogListResultSchema
    )
  }

  public createAgentTeamMember(request: z.infer<typeof agentTeamMemberCreateParamsSchema>) {
    return this.request(
      '/v1/agent-teams/members/create',
      'POST',
      agentTeamMemberCreateParamsSchema.parse(request),
      agentTeamMemberMutationResultSchema
    )
  }

  public updateAgentTeamMember(request: z.infer<typeof agentTeamMemberUpdateParamsSchema>) {
    return this.request(
      '/v1/agent-teams/members/update',
      'POST',
      agentTeamMemberUpdateParamsSchema.parse(request),
      agentTeamMemberMutationResultSchema
    )
  }

  public moveAgentTeamMember(request: z.infer<typeof agentTeamMemberMoveParamsSchema>) {
    return this.request(
      '/v1/agent-teams/members/move',
      'POST',
      agentTeamMemberMoveParamsSchema.parse(request),
      agentTeamMemberMutationResultSchema
    )
  }

  public deleteAgentTeamMember(request: z.infer<typeof agentTeamMemberDeleteParamsSchema>) {
    return this.request(
      '/v1/agent-teams/members/delete',
      'POST',
      agentTeamMemberDeleteParamsSchema.parse(request),
      agentTeamMutationResultSchema
    )
  }

  public listActions(params: ActionListParams) {
    const page = actionListParamsSchema.parse(params)
    const query = new URLSearchParams({ limit: String(page.limit) })
    if (page.cursor) query.set('cursor', page.cursor)
    return this.request(`/v1/actions?${query.toString()}`, 'GET', undefined, actionListResultSchema)
  }

  public invokeAction(request: z.infer<typeof actionInvokeParamsSchema>) {
    return this.request(
      '/v1/actions/invoke',
      'POST',
      actionInvokeParamsSchema.parse(request),
      actionInvokeResultSchema
    )
  }

  public cancelAction(request: z.infer<typeof actionCancelParamsSchema>) {
    return this.request(
      '/v1/actions/cancel',
      'POST',
      actionCancelParamsSchema.parse(request),
      actionCancelResultSchema
    )
  }

  /** Main-process only: capability comes from the inherited private window owner channel. */
  public listTasksBound(request: z.infer<typeof taskListParamsSchema>, windowCapability: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability)) {
      throw new Error('Window capability is invalid')
    }
    return this.request(
      '/v1/tasks/list',
      'POST',
      taskListParamsSchema.parse(request),
      taskListResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  /** Requires a capability issued to a verified Electron window over the private owner channel. */
  public issueTaskConfirmationBound(
    request: z.infer<typeof taskConfirmationIssueParamsSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/tasks/confirmation/issue',
      'POST',
      taskConfirmationIssueParamsSchema.parse(request),
      taskConfirmationIssueResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  /** The same sender-bound capability must still be current when the action executes. */
  public taskActionBound(
    request: z.infer<typeof taskActionParamsSchema>,
    windowCapability: string
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(windowCapability))
      throw new Error('Window capability is invalid')
    return this.request(
      '/v1/tasks/action',
      'POST',
      taskActionParamsSchema.parse(request),
      taskActionResultSchema,
      { 'x-agent-workspace-window-capability': windowCapability }
    )
  }

  public listSidebarPlacements() {
    return this.request('/v1/sidebar/placements', 'GET', undefined, sidebarListResultSchema)
  }

  public searchContent(request: z.infer<typeof searchQueryParamsSchema>) {
    return this.request(
      '/v1/search/query',
      'POST',
      searchQueryParamsSchema.parse(request),
      searchQueryResultSchema
    )
  }

  public cancelSearch(request: z.infer<typeof searchCancelParamsSchema>) {
    return this.request(
      '/v1/search/cancel',
      'POST',
      searchCancelParamsSchema.parse(request),
      searchCancelResultSchema
    )
  }

  public setSearchSourcePolicy(request: z.infer<typeof searchSourcePolicyParamsSchema>) {
    return this.request(
      '/v1/search/sources/policy',
      'POST',
      searchSourcePolicyParamsSchema.parse(request),
      searchControlResultSchema
    )
  }

  public excludeSearchSource(request: z.infer<typeof searchSourceMutationParamsSchema>) {
    return this.request(
      '/v1/search/sources/exclude',
      'POST',
      searchSourceMutationParamsSchema.parse(request),
      searchControlResultSchema
    )
  }

  public forgetSearchSource(request: z.infer<typeof searchSourceMutationParamsSchema>) {
    return this.request(
      '/v1/search/sources/forget',
      'POST',
      searchSourceMutationParamsSchema.parse(request),
      searchControlResultSchema
    )
  }

  public rebuildSearchSource(request: z.infer<typeof searchRebuildParamsSchema>) {
    return this.request(
      '/v1/search/sources/rebuild',
      'POST',
      searchRebuildParamsSchema.parse(request),
      searchControlResultSchema
    )
  }

  public issueSearchExportConfirmation(
    request: z.infer<typeof searchExportConfirmationIssueParamsSchema>
  ) {
    return this.request(
      '/v1/search/sources/export/confirmation',
      'POST',
      searchExportConfirmationIssueParamsSchema.parse(request),
      searchExportConfirmationIssueResultSchema
    )
  }

  public exportSearchSource(request: z.infer<typeof searchExportParamsSchema>) {
    return this.request(
      '/v1/search/sources/export',
      'POST',
      searchExportParamsSchema.parse(request),
      searchExportResultSchema
    )
  }

  public listContentRoots(params: z.infer<typeof boundedListParamsSchema>) {
    const page = boundedListParamsSchema.parse(params)
    const query = new URLSearchParams({ limit: String(page.limit) })
    if (page.cursor) query.set('cursor', page.cursor)
    return this.request(
      `/v1/content/roots?${query.toString()}`,
      'GET',
      undefined,
      workspaceRootListResultSchema
    )
  }

  public listContentDirectory(params: z.infer<typeof workspaceDirectoryListParamsSchema>) {
    return this.request(
      '/v1/content/directories/list',
      'POST',
      workspaceDirectoryListParamsSchema.parse(params),
      workspaceDirectoryListResultSchema
    )
  }

  public issueContentDocument(params: z.infer<typeof contentDocumentIssueParamsSchema>) {
    return this.request(
      '/v1/content/documents/issue',
      'POST',
      contentDocumentIssueParamsSchema.parse(params),
      contentDocumentIssueResultSchema
    )
  }

  public readContent(params: z.infer<typeof contentReadParamsSchema>) {
    return this.request(
      '/v1/content/read',
      'POST',
      contentReadParamsSchema.parse(params),
      contentPreviewSchema
    )
  }

  public saveContent(params: z.infer<typeof contentSaveParamsSchema>) {
    return this.request(
      '/v1/content/save',
      'POST',
      contentSaveParamsSchema.parse(params),
      contentSaveResultSchema
    )
  }

  public renderMarkdown(params: z.infer<typeof contentMarkdownParamsSchema>) {
    return this.request(
      '/v1/content/markdown',
      'POST',
      contentMarkdownParamsSchema.parse(params),
      safeMarkdownDocumentSchema
    )
  }

  public diffContent(params: z.infer<typeof contentDiffParamsSchema>) {
    return this.request(
      '/v1/content/diff',
      'POST',
      contentDiffParamsSchema.parse(params),
      contentDiffResultSchema
    )
  }

  public getSidebarPlacement(windowId: string) {
    const params = sidebarGetParamsSchema.parse({ windowId })
    return this.request(
      `/v1/sidebar/placements/${encodeURIComponent(params.windowId)}`,
      'GET',
      undefined,
      sidebarPlacementSchema
    )
  }

  public saveSidebarPlacement(request: z.infer<typeof sidebarSaveParamsSchema>) {
    return this.request(
      '/v1/sidebar/placements/save',
      'POST',
      sidebarSaveParamsSchema.parse(request),
      sidebarPlacementSchema
    )
  }

  public listTextBoxes(params: { limit: number; cursor?: string }) {
    const page = boundedListParamsSchema.parse(params)
    const query = new URLSearchParams({ limit: String(page.limit) })
    if (page.cursor) query.set('cursor', page.cursor)
    return this.request(
      `/v1/text-boxes?${query.toString()}`,
      'GET',
      undefined,
      textBoxListResultSchema
    )
  }

  public getTextBox(textBoxDocumentId: string) {
    const params = textBoxIdParamsSchema.parse({ textBoxDocumentId })
    return this.request(
      `/v1/text-boxes/${encodeURIComponent(params.textBoxDocumentId)}`,
      'GET',
      undefined,
      textBoxDocumentSchema
    )
  }

  public createTextBox(request: z.infer<typeof textBoxCreateParamsSchema>) {
    return this.request(
      '/v1/text-boxes/create',
      'POST',
      textBoxCreateParamsSchema.parse(request),
      textBoxDocumentSchema
    )
  }

  public saveTextBox(request: z.infer<typeof textBoxSaveParamsSchema>) {
    return this.request(
      '/v1/text-boxes/save',
      'POST',
      textBoxSaveParamsSchema.parse(request),
      textBoxDocumentSchema
    )
  }

  public deleteTextBox(request: z.infer<typeof textBoxDeleteParamsSchema>) {
    return this.request(
      '/v1/text-boxes/delete',
      'POST',
      textBoxDeleteParamsSchema.parse(request),
      textBoxDocumentSchema
    )
  }

  public listLayouts() {
    return this.request('/v1/layouts', 'GET', undefined, layoutListResultSchema)
  }

  public getLayout(layoutId: string) {
    return this.request(
      `/v1/layouts/${encodeURIComponent(layoutId)}`,
      'GET',
      undefined,
      layoutGetResultSchema
    )
  }

  public exportLayout(layoutId: string) {
    return this.request(
      `/v1/layouts/${encodeURIComponent(layoutId)}/export`,
      'GET',
      undefined,
      layoutExportResultSchema
    )
  }

  public saveLayout(request: LayoutSaveRequest) {
    return this.request('/v1/layouts/save', 'POST', request, workspaceMutationResultSchema)
  }

  public deleteLayout(request: LayoutDeleteRequest) {
    return this.request('/v1/layouts/delete', 'POST', request, workspaceMutationResultSchema)
  }

  public applyLayout(request: LayoutApplyRequest) {
    return this.request('/v1/layouts/apply', 'POST', request, workspaceMutationResultSchema)
  }

  public importLayout(request: LayoutImportRequest) {
    return this.request('/v1/layouts/import', 'POST', request, workspaceMutationResultSchema)
  }

  public selectWorkspace(request: WorkspaceSelectRequest) {
    return this.request('/v1/workspaces/select', 'POST', request, workspaceMutationResultSchema)
  }

  public moveWorkspace(request: WorkspaceMoveRequest) {
    return this.request('/v1/workspaces/move', 'POST', request, workspaceMutationResultSchema)
  }

  public updateWorkspace(request: WorkspaceUpdateRequest) {
    return this.request('/v1/workspaces/update', 'POST', request, workspaceMutationResultSchema)
  }

  public createWorkspace(request: WorkspaceCreateRequest) {
    return this.request('/v1/workspaces/create', 'POST', request, workspaceCreateResultSchema)
  }

  public closeWorkspace(request: WorkspaceCloseRequest) {
    return this.request('/v1/workspaces/close', 'POST', request, workspaceCloseResultSchema)
  }

  public restartTerminal(request: TerminalRestartRequest) {
    return this.request('/v1/terminals/restart', 'POST', request, terminalRestartResultSchema)
  }

  public selectTab(request: TabSelectRequest) {
    return this.request('/v1/tabs/select', 'POST', request, workspaceMutationResultSchema)
  }

  public closeTab(request: TabCloseRequest) {
    return this.request('/v1/tabs/close', 'POST', request, tabCloseResultSchema)
  }

  public openTerminalTab(request: TabOpenTerminalRequest) {
    return this.request('/v1/tabs/open-terminal', 'POST', request, tabOpenTerminalResultSchema)
  }

  public openBrowserTab(request: TabOpenBrowserRequest) {
    return this.request('/v1/tabs/open-browser', 'POST', request, tabOpenBrowserResultSchema)
  }

  public navigateBrowser(request: BrowserNavigateRequest) {
    return this.request('/v1/browser/navigate', 'POST', request, workspaceMutationResultSchema)
  }

  public browserBack(request: BrowserActionRequest) {
    return this.request('/v1/browser/back', 'POST', request, workspaceMutationResultSchema)
  }

  public browserForward(request: BrowserActionRequest) {
    return this.request('/v1/browser/forward', 'POST', request, workspaceMutationResultSchema)
  }

  public browserReload(request: BrowserActionRequest) {
    return this.request('/v1/browser/reload', 'POST', request, workspaceMutationResultSchema)
  }

  public browserStop(request: BrowserActionRequest) {
    return this.request('/v1/browser/stop', 'POST', request, workspaceMutationResultSchema)
  }

  public browserOpenDevTools(request: BrowserActionRequest) {
    return this.request('/v1/browser/openDevTools', 'POST', request, workspaceMutationResultSchema)
  }

  public observeBrowser(request: BrowserObserveRequest) {
    return this.request('/v1/browser/observe', 'POST', request, workspaceMutationResultSchema)
  }

  public focusPane(request: PaneFocusRequest) {
    return this.request('/v1/panes/focus', 'POST', request, workspaceMutationResultSchema)
  }

  public resizePane(request: PaneResizeRequest) {
    return this.request('/v1/panes/resize', 'POST', request, workspaceMutationResultSchema)
  }

  public splitPane(request: PaneSplitRequest) {
    return this.request('/v1/panes/split', 'POST', request, paneSplitResultSchema)
  }

  public closePane(request: PaneCloseRequest) {
    return this.request('/v1/panes/close', 'POST', request, paneCloseResultSchema)
  }

  public pinWorkspace(request: WorkspacePinRequest) {
    return this.request('/v1/workspaces/pin', 'POST', request, workspaceMutationResultSchema)
  }

  public selectWorkspaces(request: WorkspaceSelectionReplaceRequest) {
    return this.request(
      '/v1/workspaces/select-many',
      'POST',
      request,
      workspaceMutationResultSchema
    )
  }

  public reorderWorkspace(request: WorkspaceCanonicalMoveRequest) {
    return this.request('/v1/workspaces/reorder', 'POST', request, workspaceMutationResultSchema)
  }

  public closeSelectedWorkspaces(request: WorkspaceBatchCloseRequest) {
    return this.request(
      '/v1/workspaces/close-selected',
      'POST',
      request,
      workspaceCloseResultSchema
    )
  }

  public createGroup(request: GroupCreateRequest) {
    return this.request('/v1/groups/create', 'POST', request, workspaceMutationResultSchema)
  }

  public renameGroup(request: GroupRenameRequest) {
    return this.request('/v1/groups/rename', 'POST', request, workspaceMutationResultSchema)
  }

  public deleteGroup(request: GroupDeleteRequest) {
    return this.request('/v1/groups/delete', 'POST', request, workspaceMutationResultSchema)
  }

  public moveGroup(request: GroupMoveRequest) {
    return this.request('/v1/groups/move', 'POST', request, workspaceMutationResultSchema)
  }

  public assignGroup(request: GroupAssignRequest) {
    return this.request('/v1/groups/assign', 'POST', request, workspaceMutationResultSchema)
  }

  public collapseGroup(request: GroupCollapseRequest) {
    return this.request('/v1/groups/collapse', 'POST', request, workspaceMutationResultSchema)
  }

  public moveTab(request: TabMoveRequest) {
    return this.request('/v1/tabs/move', 'POST', request, workspaceMutationResultSchema)
  }

  public updateTab(request: TabUpdateRequest) {
    return this.request('/v1/tabs/update', 'POST', request, workspaceMutationResultSchema)
  }

  public create(params: TerminalCreateParams) {
    return this.request('/v1/terminals', 'POST', params, terminalCreateResultSchema)
  }

  public attach(terminalId: string) {
    return this.request(
      `/v1/terminals/${encodeURIComponent(terminalId)}`,
      'GET',
      undefined,
      terminalAttachResultSchema
    )
  }

  public runtimeMetadata(terminalId: string) {
    return this.request(
      `/v1/terminals/${encodeURIComponent(terminalId)}/metadata`,
      'GET',
      undefined,
      terminalRuntimeMetadataResultSchema
    )
  }

  public send(terminalId: string, data: Buffer) {
    return this.request(
      `/v1/terminals/${encodeURIComponent(terminalId)}/input`,
      'POST',
      { data: data.toString('base64') },
      z.strictObject({})
    )
  }

  public resize(terminalId: string, rows: number, cols: number) {
    return this.request(
      `/v1/terminals/${encodeURIComponent(terminalId)}/resize`,
      'POST',
      { rows, cols },
      z.strictObject({})
    )
  }

  public checkpoint(terminalId: string, checkpoint: TerminalCheckpoint) {
    return this.request(
      `/v1/terminals/${encodeURIComponent(terminalId)}/checkpoint`,
      'PUT',
      checkpoint,
      z.strictObject({})
    )
  }

  public async close(terminalId: string): Promise<void> {
    await this.request(`/v1/terminals/${encodeURIComponent(terminalId)}`, 'DELETE')
  }

  public eventsUrl(terminalId: string): string {
    const url = new URL(`/v1/terminals/${encodeURIComponent(terminalId)}/events`, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  }

  public workspaceEventsUrl(): string {
    const url = new URL('/v1/workspace-events', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  }

  public authorizationHeader(): { authorization: string } {
    return { authorization: `Bearer ${this.token}` }
  }

  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
    schema?: ZodType<T>,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method,
      headers: {
        ...extraHeaders,
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok) {
      const parsed = terminalErrorSchema.safeParse(await response.json().catch(() => undefined))
      throw new ServerError(
        response.status,
        parsed.success ? parsed.data.error.code : 'request_failed',
        parsed.success ? parsed.data.error.message : `Server returned ${response.status}`
      )
    }
    if (response.status === 204) return undefined as T
    const value: unknown = await response.json()
    return schema ? schema.parse(value) : (value as T)
  }
}

/** Kept while terminal-only call sites move to the full service client. */
export { AgentWorkspaceClient as TerminalApiClient }
export {
  createNodeSessionFile,
  readNodeSessionFile,
  resolveNodeSessionFile
} from './node-session-file'

export function parseTerminalEvent(
  value: string
):
  | { event: 'terminal.attached'; data: z.infer<typeof terminalAttachResultSchema> }
  | z.infer<typeof terminalEventSchema> {
  const parsed: unknown = JSON.parse(value)
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'event' in parsed &&
    parsed.event === 'terminal.attached'
  ) {
    return z
      .strictObject({ event: z.literal('terminal.attached'), data: terminalAttachResultSchema })
      .parse(parsed)
  }
  return terminalEventSchema.parse(parsed)
}
