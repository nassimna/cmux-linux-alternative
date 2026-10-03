import { z } from 'zod'
import {
  applicationSnapshotSchema,
  diagnosticBundlePreviewSchema,
  paneTreeNodeSchema,
  workspaceListResultSchema,
  workspaceCreateParamsSchema,
  workspaceMoveParamsSchema,
  workspaceUpdateParamsSchema,
  tabSelectParamsSchema,
  tabOpenTerminalParamsSchema,
  tabOpenBrowserParamsSchema,
  browserNavigateParamsSchema,
  browserBackParamsSchema,
  browserForwardParamsSchema,
  browserReloadParamsSchema,
  browserStopParamsSchema,
  browserOpenDevToolsParamsSchema,
  browserObserveParamsSchema,
  paneFocusParamsSchema,
  paneResizeParamsSchema,
  paneSplitParamsSchema,
  paneCloseParamsSchema,
  workspacePinParamsSchema,
  groupCreateParamsSchema,
  groupRenameParamsSchema,
  groupDeleteParamsSchema,
  groupMoveParamsSchema,
  groupAssignParamsSchema,
  groupCollapseParamsSchema,
  workspaceOrganizationGetResultSchema,
  workspaceSelectionReplaceParamsSchema,
  workspaceCanonicalMoveParamsSchema,
  workspaceBatchCloseParamsSchema,
  layoutTemplateSnapshotSchema,
  layoutExportEnvelopeSchema,
  layoutListResultSchema,
  layoutGetParamsSchema,
  layoutGetResultSchema,
  layoutSaveParamsSchema,
  layoutDeleteParamsSchema,
  layoutApplyParamsSchema,
  layoutExportResultSchema,
  layoutImportParamsSchema,
  remoteListParamsSchema,
  remoteTargetIdParamsSchema,
  remoteSessionIdParamsSchema,
  remoteTargetCreateParamsSchema,
  remoteTargetDeleteParamsSchema,
  remoteSessionConnectParamsSchema,
  remoteSessionReconnectParamsSchema,
  remoteSessionDetachParamsSchema,
  remoteSessionCloseParamsSchema,
  remoteTmuxDiscoverParamsSchema,
  remoteTmuxDiscoveryResultSchema,
  remoteHostKeyScanParamsSchema,
  remoteHostKeyTrustParamsSchema,
  remoteHostKeyChallengeSchema,
  remoteTargetListResultSchema,
  remoteTargetResultSchema,
  remoteSessionListResultSchema,
  remoteSessionResultSchema,
  agentCatalogListParamsSchema,
  agentCatalogListResultSchema,
  agentCatalogGetParamsSchema,
  agentCatalogGetResultSchema,
  agentTeamCreateParamsSchema,
  agentTeamUpdateParamsSchema,
  agentTeamDeleteParamsSchema,
  agentTeamMutationResultSchema,
  agentTeamMemberCreateParamsSchema,
  agentTeamMemberUpdateParamsSchema,
  agentTeamMemberMoveParamsSchema,
  agentTeamMemberDeleteParamsSchema,
  agentTeamMemberMutationResultSchema,
  agentCatalogRegisterParamsSchema,
  agentCatalogRegisterResultSchema,
  agentAttentionSetParamsSchema,
  agentAttentionSetResultSchema,
  agentHibernationPreflightParamsSchema,
  agentHibernationCancelParamsSchema,
  agentHibernationConfirmParamsSchema,
  COMMAND_CATALOG,
  settingsGetResultSchema,
  configurationSnapshotSchema,
  settingsUpdateParamsSchema,
  settingsResetKeyParamsSchema,
  notificationListParamsSchema,
  notificationListResultSchema,
  notificationClearScopeSchema,
  notificationPublishParamsSchema,
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
  advancedTabMutationResultSchema,
  actionDefinitionSchema,
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
  sidebarPlacementSchema,
  sidebarSaveParamsSchema,
  sidebarGetParamsSchema,
  sidebarListResultSchema,
  boundedListParamsSchema,
  workspaceDirectoryListParamsSchema,
  workspaceRootListResultSchema,
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
  textBoxDocumentSchema,
  textBoxCreateParamsSchema,
  textBoxSaveParamsSchema,
  textBoxDeleteParamsSchema,
  textBoxIdParamsSchema,
  textBoxListResultSchema,
  tabMoveParamsSchema,
  tabUpdateParamsSchema
} from '@agent-workspace/protocol-client'

import { durableApplicationStateSchema } from './durable-application'

export { durableApplicationStateSchema }
export {
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
  searchControlResultSchema
}
export {
  workspaceCardSlotsSnapshotParamsSchema,
  workspaceCardSlotsSnapshotSchema,
  workspaceCardSlotsReplaceParamsSchema,
  workspaceCardSlotV2GetParamsSchema,
  workspaceCardSlotV2SnapshotSchema,
  workspaceCardSlotV2ReplaceParamsSchema,
  workspaceAttentionSnapshotParamsSchema,
  workspaceAttentionSnapshotSchema,
  attentionAcknowledgementParamsSchema,
  attentionAcknowledgementResultSchema
}
export {
  workspaceDirectoryListParamsSchema,
  workspaceRootListResultSchema,
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
  contentDiffResultSchema
}
export { closedItemListResultSchema, closedItemGetParamsSchema, closedItemGetResultSchema }
export const tabReopenResultSchema = advancedTabMutationResultSchema
export type { DurableApplicationState } from './durable-application'
export { durableWorkspaceSnapshotSchema } from './durable-workspace'
export type { DurableWorkspaceSnapshot } from './durable-workspace'
export { workspaceCreateParamsSchema }
export { tabMoveParamsSchema }
export { tabOpenTerminalParamsSchema }
export { tabOpenBrowserParamsSchema }
export { paneSplitParamsSchema }
export { paneCloseParamsSchema }
export {
  workspacePinParamsSchema,
  groupCreateParamsSchema,
  groupRenameParamsSchema,
  groupDeleteParamsSchema,
  groupMoveParamsSchema,
  groupAssignParamsSchema,
  groupCollapseParamsSchema
}
export {
  workspaceSelectionReplaceParamsSchema,
  workspaceCanonicalMoveParamsSchema,
  workspaceBatchCloseParamsSchema
}
export {
  layoutTemplateSnapshotSchema,
  layoutExportEnvelopeSchema,
  layoutListResultSchema,
  layoutGetParamsSchema,
  layoutGetResultSchema,
  layoutSaveParamsSchema,
  layoutDeleteParamsSchema,
  layoutApplyParamsSchema,
  layoutExportResultSchema,
  layoutImportParamsSchema
}
export {
  remoteListParamsSchema,
  remoteTargetIdParamsSchema,
  remoteSessionIdParamsSchema,
  remoteTargetCreateParamsSchema,
  remoteTargetDeleteParamsSchema,
  remoteSessionConnectParamsSchema,
  remoteSessionReconnectParamsSchema,
  remoteSessionDetachParamsSchema,
  remoteSessionCloseParamsSchema,
  remoteTmuxDiscoverParamsSchema,
  remoteTmuxDiscoveryResultSchema,
  remoteHostKeyScanParamsSchema,
  remoteHostKeyTrustParamsSchema,
  remoteHostKeyChallengeSchema,
  remoteTargetListResultSchema,
  remoteTargetResultSchema,
  remoteSessionListResultSchema,
  remoteSessionResultSchema,
  agentCatalogListParamsSchema,
  agentCatalogListResultSchema,
  agentCatalogGetParamsSchema,
  agentCatalogGetResultSchema,
  agentTeamCreateParamsSchema,
  agentTeamUpdateParamsSchema,
  agentTeamDeleteParamsSchema,
  agentTeamMutationResultSchema,
  agentTeamMemberCreateParamsSchema,
  agentTeamMemberUpdateParamsSchema,
  agentTeamMemberMoveParamsSchema,
  agentTeamMemberDeleteParamsSchema,
  agentTeamMemberMutationResultSchema,
  agentCatalogRegisterParamsSchema,
  agentCatalogRegisterResultSchema,
  agentAttentionSetParamsSchema,
  agentAttentionSetResultSchema,
  agentHibernationPreflightParamsSchema,
  agentHibernationCancelParamsSchema,
  agentHibernationConfirmParamsSchema,
  COMMAND_CATALOG,
  settingsGetResultSchema,
  settingsUpdateParamsSchema,
  settingsResetKeyParamsSchema,
  notificationListParamsSchema,
  notificationListResultSchema,
  notificationClearScopeSchema,
  notificationPublishParamsSchema,
  actionDefinitionSchema,
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
  sidebarPlacementSchema,
  sidebarSaveParamsSchema,
  sidebarGetParamsSchema,
  sidebarListResultSchema,
  boundedListParamsSchema,
  textBoxDocumentSchema,
  textBoxCreateParamsSchema,
  textBoxSaveParamsSchema,
  textBoxDeleteParamsSchema,
  textBoxIdParamsSchema,
  textBoxListResultSchema
}
export { tabUpdateParamsSchema }
export { applicationSnapshotSchema, paneTreeNodeSchema, workspaceListResultSchema }
export { workspaceOrganizationGetResultSchema }
export type ApplicationSnapshot = z.infer<typeof applicationSnapshotSchema>
export type { WorkspaceCreateParams } from '@agent-workspace/protocol-client'
export {
  agentRestoreAssessParamsSchema,
  agentRestoreAssessResultSchema,
  agentSessionRestoreParamsSchema,
  agentSessionRestoreResultSchema,
  agentSessionForkParamsSchema,
  agentSessionForkResultSchema
} from '@agent-workspace/protocol-client'

export const stateSnapshotResultSchema = z.strictObject({
  snapshot: durableApplicationStateSchema
})

/** Private Node-service discovery record. It never crosses the renderer bridge. */
export const nodeSessionRecordSchema = z.strictObject({
  application: z.literal('agent-workspace'),
  apiVersion: z.literal(1),
  baseUrl: z.string().refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        url.port !== '' &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === '' &&
        url.username === '' &&
        url.password === ''
      )
    } catch {
      return false
    }
  }),
  token: z.string().min(32),
  sessionId: z.uuid()
})

export type NodeSessionRecord = z.infer<typeof nodeSessionRecordSchema>

export const workspaceSelectRequestSchema = z.strictObject({
  workspaceId: z.uuid(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idempotencyEpoch: z.uuid(),
  idempotencyKey: z.uuid()
})

const mutationIdentity = {
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idempotencyEpoch: z.uuid(),
  idempotencyKey: z.uuid()
}

export const tabReopenRequestSchema = z.strictObject({
  closedItemId: z.uuid(),
  target: z.strictObject({
    windowId: z.uuid(),
    workspaceId: z.uuid(),
    paneId: z.uuid(),
    destinationIndex: z.number().int().min(0).max(1_024),
    expectedWindowRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  }),
  ...mutationIdentity
})

export const nodeMutationIdentitySchema = z.strictObject(mutationIdentity)
export const notificationPageRequestSchema = notificationListParamsSchema.extend({
  windowId: z.uuid()
})
export const notificationWriteRequestSchema = z.strictObject({
  windowId: z.uuid(),
  notificationId: z.uuid(),
  mutation: nodeMutationIdentitySchema
})
export const notificationPublishRequestSchema = notificationPublishParamsSchema.extend({
  windowId: z.uuid(),
  mutation: nodeMutationIdentitySchema
})
export const notificationClearRequestSchema = z.strictObject({
  windowId: z.uuid(),
  scope: notificationClearScopeSchema,
  mutation: nodeMutationIdentitySchema
})
export const notificationChangeResultSchema = z.strictObject({
  revision: mutationIdentity.expectedRevision,
  replayed: z.boolean(),
  changedIds: z.array(z.uuid()).max(1_000)
})
export const settingsWriteRequestSchema = z.strictObject({
  windowId: z.uuid(),
  update: settingsUpdateParamsSchema,
  mutation: nodeMutationIdentitySchema
})
export const settingsResetRequestSchema = settingsResetKeyParamsSchema.extend({
  windowId: z.uuid(),
  mutation: nodeMutationIdentitySchema
})
export const settingsMutationResultSchema = z.strictObject({
  revision: mutationIdentity.expectedRevision,
  replayed: z.boolean()
})

export const workspaceMoveRequestSchema = workspaceMoveParamsSchema.extend(mutationIdentity)
export const workspaceUpdateRequestSchema = workspaceUpdateParamsSchema.extend(mutationIdentity)
export const workspaceCloseRequestSchema = workspaceSelectRequestSchema
export const terminalRestartRequestSchema = z.strictObject({
  workspaceId: z.uuid(),
  tabId: z.uuid(),
  ...mutationIdentity
})
export const tabSelectRequestSchema = tabSelectParamsSchema.extend(mutationIdentity)
export const tabCloseRequestSchema = tabSelectRequestSchema
export const tabOpenTerminalRequestSchema = tabOpenTerminalParamsSchema.extend(mutationIdentity)
export const tabOpenBrowserRequestSchema = tabOpenBrowserParamsSchema.extend(mutationIdentity)
export const browserNavigateRequestSchema = browserNavigateParamsSchema.extend(mutationIdentity)
export const browserBackRequestSchema = browserBackParamsSchema.extend(mutationIdentity)
export const browserForwardRequestSchema = browserForwardParamsSchema.extend(mutationIdentity)
export const browserReloadRequestSchema = browserReloadParamsSchema.extend(mutationIdentity)
export const browserStopRequestSchema = browserStopParamsSchema.extend(mutationIdentity)
export const browserOpenDevToolsRequestSchema =
  browserOpenDevToolsParamsSchema.extend(mutationIdentity)
export const browserObserveRequestSchema = browserObserveParamsSchema.extend(mutationIdentity)
export const paneFocusRequestSchema = paneFocusParamsSchema.extend(mutationIdentity)
export const paneResizeRequestSchema = paneResizeParamsSchema.extend(mutationIdentity)
export const paneSplitRequestSchema = paneSplitParamsSchema.extend(mutationIdentity)
export const paneCloseRequestSchema = paneCloseParamsSchema.extend(mutationIdentity)
export const workspacePinRequestSchema = workspacePinParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const workspaceSelectionReplaceRequestSchema = workspaceSelectionReplaceParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const workspaceCanonicalMoveRequestSchema = workspaceCanonicalMoveParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const workspaceBatchCloseRequestSchema = workspaceBatchCloseParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const layoutSaveRequestSchema = layoutSaveParamsSchema.extend({ idempotencyEpoch: z.uuid() })
export const layoutDeleteRequestSchema = layoutDeleteParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const layoutApplyRequestSchema = layoutApplyParamsSchema.extend({
  targetWindowId: z.uuid(),
  expectedWindowRevision: z.number().int().nonnegative().safe(),
  idempotencyEpoch: z.uuid()
})
export const layoutImportRequestSchema = layoutImportParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})

/** Read-only qualification of a private config copy; never claims update parity. */
export const configurationQualificationSchema = z.strictObject({
  config: configurationSnapshotSchema,
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  unknownFieldsPresent: z.boolean(),
  runtimeSettingsMatch: z.boolean(),
  writable: z.literal(false)
})
export type ConfigurationQualificationResult = z.infer<typeof configurationQualificationSchema>
export const groupCreateRequestSchema = groupCreateParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const groupRenameRequestSchema = groupRenameParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const groupDeleteRequestSchema = groupDeleteParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const groupMoveRequestSchema = groupMoveParamsSchema.extend({ idempotencyEpoch: z.uuid() })
export const groupAssignRequestSchema = groupAssignParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const groupCollapseRequestSchema = groupCollapseParamsSchema.extend({
  idempotencyEpoch: z.uuid()
})
export const tabMoveRequestSchema = tabMoveParamsSchema.extend(mutationIdentity)
export const tabUpdateRequestSchema = tabUpdateParamsSchema.extend(mutationIdentity)
export const workspaceCreateRequestSchema = workspaceCreateParamsSchema.extend({
  ...mutationIdentity,
  windowId: z.uuid().optional()
})

export const workspaceMutationResultSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  replayed: z.boolean()
})

export const workspaceCreateCommitResultSchema = workspaceMutationResultSchema.extend({
  workspaceId: z.uuid(),
  paneId: z.uuid(),
  tabId: z.uuid()
})

export const workspaceCreateResultSchema = workspaceCreateCommitResultSchema.extend({
  terminalId: z.uuid().nullable()
})

export const workspaceCloseCommitResultSchema = workspaceMutationResultSchema.extend({
  replacementWorkspaceId: z.uuid().nullable(),
  replacementPaneId: z.uuid().nullable(),
  replacementTabId: z.uuid().nullable()
})

export const workspaceCloseResultSchema = workspaceCloseCommitResultSchema.extend({
  replacementTerminalId: z.uuid().nullable()
})

export const terminalRestartResultSchema = workspaceMutationResultSchema.extend({
  terminalId: z.uuid().nullable()
})

export const tabCloseCommitResultSchema = workspaceMutationResultSchema.extend({
  closedItemId: z.uuid(),
  replacementTabId: z.uuid().nullable()
})

export const tabCloseResultSchema = tabCloseCommitResultSchema.extend({
  replacementTerminalId: z.uuid().nullable()
})

export const tabOpenTerminalCommitResultSchema = workspaceMutationResultSchema.extend({
  tabId: z.uuid()
})

export const tabOpenTerminalResultSchema = tabOpenTerminalCommitResultSchema.extend({
  terminalId: z.uuid().nullable()
})

export const tabOpenBrowserResultSchema = workspaceMutationResultSchema.extend({
  tabId: z.uuid(),
  browserSessionId: z.uuid()
})

export const paneSplitCommitResultSchema = workspaceMutationResultSchema.extend({
  paneId: z.uuid(),
  splitId: z.uuid(),
  tabId: z.uuid(),
  browserSessionId: z.uuid().nullable()
})

export const paneSplitResultSchema = paneSplitCommitResultSchema.extend({
  terminalId: z.uuid().nullable()
})

export const paneCloseCommitResultSchema = workspaceMutationResultSchema.extend({
  replacementTabId: z.uuid().nullable()
})

export const paneCloseResultSchema = paneCloseCommitResultSchema.extend({
  replacementTerminalId: z.uuid().nullable()
})

export type WorkspaceSelectRequest = z.infer<typeof workspaceSelectRequestSchema>
export type WorkspaceMoveRequest = z.infer<typeof workspaceMoveRequestSchema>
export type WorkspaceUpdateRequest = z.infer<typeof workspaceUpdateRequestSchema>
export type WorkspaceMutationResult = z.infer<typeof workspaceMutationResultSchema>
export type WorkspaceCreateRequest = z.infer<typeof workspaceCreateRequestSchema>
export type WorkspaceCreateCommitResult = z.infer<typeof workspaceCreateCommitResultSchema>
export type WorkspaceCreateResult = z.infer<typeof workspaceCreateResultSchema>
export type WorkspaceCloseRequest = z.infer<typeof workspaceCloseRequestSchema>
export type WorkspaceCloseCommitResult = z.infer<typeof workspaceCloseCommitResultSchema>
export type WorkspaceCloseResult = z.infer<typeof workspaceCloseResultSchema>
export type TerminalRestartRequest = z.infer<typeof terminalRestartRequestSchema>
export type TerminalRestartResult = z.infer<typeof terminalRestartResultSchema>
export type TabSelectRequest = z.infer<typeof tabSelectRequestSchema>
export type TabCloseRequest = z.infer<typeof tabCloseRequestSchema>
export type TabCloseCommitResult = z.infer<typeof tabCloseCommitResultSchema>
export type TabCloseResult = z.infer<typeof tabCloseResultSchema>
export type TabOpenTerminalRequest = z.infer<typeof tabOpenTerminalRequestSchema>
export type TabOpenTerminalCommitResult = z.infer<typeof tabOpenTerminalCommitResultSchema>
export type TabOpenTerminalResult = z.infer<typeof tabOpenTerminalResultSchema>
export type TabOpenBrowserRequest = z.infer<typeof tabOpenBrowserRequestSchema>
export type BrowserNavigateRequest = z.infer<typeof browserNavigateRequestSchema>
export type BrowserActionRequest = z.infer<typeof browserBackRequestSchema>
export type BrowserObserveRequest = z.infer<typeof browserObserveRequestSchema>
export type TabOpenBrowserResult = z.infer<typeof tabOpenBrowserResultSchema>
export type PaneFocusRequest = z.infer<typeof paneFocusRequestSchema>
export type PaneResizeRequest = z.infer<typeof paneResizeRequestSchema>
export type PaneSplitRequest = z.infer<typeof paneSplitRequestSchema>
export type PaneSplitCommitResult = z.infer<typeof paneSplitCommitResultSchema>
export type PaneSplitResult = z.infer<typeof paneSplitResultSchema>
export type PaneCloseRequest = z.infer<typeof paneCloseRequestSchema>
export type PaneCloseCommitResult = z.infer<typeof paneCloseCommitResultSchema>
export type PaneCloseResult = z.infer<typeof paneCloseResultSchema>
export type WorkspacePinRequest = z.infer<typeof workspacePinRequestSchema>
export type WorkspaceSelectionReplaceRequest = z.infer<
  typeof workspaceSelectionReplaceRequestSchema
>
export type WorkspaceCanonicalMoveRequest = z.infer<typeof workspaceCanonicalMoveRequestSchema>
export type WorkspaceBatchCloseRequest = z.infer<typeof workspaceBatchCloseRequestSchema>
export type LayoutSaveRequest = z.infer<typeof layoutSaveRequestSchema>
export type LayoutDeleteRequest = z.infer<typeof layoutDeleteRequestSchema>
export type LayoutApplyRequest = z.infer<typeof layoutApplyRequestSchema>
export type LayoutImportRequest = z.infer<typeof layoutImportRequestSchema>
export type RemoteTargetCreateParams = z.infer<typeof remoteTargetCreateParamsSchema>
export type RemoteSessionConnectParams = z.infer<typeof remoteSessionConnectParamsSchema>
export type RemoteSessionReconnectParams = z.infer<typeof remoteSessionReconnectParamsSchema>
export type RemoteSessionDetachParams = z.infer<typeof remoteSessionDetachParamsSchema>
export type RemoteSessionCloseParams = z.infer<typeof remoteSessionCloseParamsSchema>
export const remoteTerminalResultSchema = z.strictObject({ terminalId: z.uuid() })
export type RemoteTerminalResult = z.infer<typeof remoteTerminalResultSchema>
export type RemoteTmuxDiscoverParams = z.infer<typeof remoteTmuxDiscoverParamsSchema>
export type AgentCatalogListParams = z.infer<typeof agentCatalogListParamsSchema>
export type ActionListParams = z.infer<typeof actionListParamsSchema>
export type RemoteHostKeyScanParams = z.infer<typeof remoteHostKeyScanParamsSchema>
export type RemoteHostKeyTrustParams = z.infer<typeof remoteHostKeyTrustParamsSchema>
export type LayoutTemplate = z.infer<typeof layoutTemplateSnapshotSchema>
export type GroupCreateRequest = z.infer<typeof groupCreateRequestSchema>
export type GroupRenameRequest = z.infer<typeof groupRenameRequestSchema>
export type GroupDeleteRequest = z.infer<typeof groupDeleteRequestSchema>
export type GroupMoveRequest = z.infer<typeof groupMoveRequestSchema>
export type GroupAssignRequest = z.infer<typeof groupAssignRequestSchema>
export type GroupCollapseRequest = z.infer<typeof groupCollapseRequestSchema>
export type TabMoveRequest = z.infer<typeof tabMoveRequestSchema>
export type TabUpdateRequest = z.infer<typeof tabUpdateRequestSchema>

export {
  terminalAttachResultSchema,
  terminalCheckpointSchema,
  terminalCreateParamsSchema,
  terminalCreateResultSchema,
  terminalEventSchema,
  terminalRuntimeMetadataResultSchema
} from '@agent-workspace/protocol-client'

export type {
  TerminalAttachResult,
  TerminalCheckpoint,
  TerminalCreateParams,
  TerminalDescriptor,
  TerminalEventMessage,
  TerminalRuntimeMetadataResult
} from '@agent-workspace/protocol-client'

export const terminalIdSchema = z.uuid()

export const terminalInputSchema = z.strictObject({
  data: z.base64().max(Math.ceil((64 * 1024) / 3) * 4)
})

export const terminalResizeSchema = z.strictObject({
  rows: z.number().int().min(1).max(1000),
  cols: z.number().int().min(1).max(1000)
})

export const terminalErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string()
  })
})

export const diagnosticExportRequestSchema = z.strictObject({
  destination: z.string().min(1).max(4096),
  approvedPreview: diagnosticBundlePreviewSchema
})

export const diagnosticExportResultSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  bytes: z
    .number()
    .int()
    .min(0)
    .max(512 * 1024)
})

export type TerminalInput = z.infer<typeof terminalInputSchema>
export type TerminalResize = z.infer<typeof terminalResizeSchema>
