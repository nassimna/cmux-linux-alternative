import type {
  ActionInvocationSnapshot,
  ActionInvokeParams,
  ActionListResult,
  ActionRegistryChangedEvent,
  AttentionAcknowledgementParams,
  AttentionAcknowledgementResult,
  BrowserBackParams,
  BrowserForwardParams,
  BrowserNavigateParams,
  BrowserOpenDevToolsParams,
  BrowserReloadParams,
  BrowserStopParams,
  AdvancedTabMutationResult,
  AdvancedTabCloseResult,
  ClosedItemGetParams,
  ClosedItemGetResult,
  ClosedItemListResult,
  FocusHistoryNavigateParams,
  FocusHistoryNavigateResult,
  ConfigurationGetResult,
  ConfigurationUpdateParams,
  GroupAssignParams,
  GroupCollapseParams,
  GroupCreateParams,
  GroupDeleteParams,
  GroupMoveParams,
  GroupRenameParams,
  DiagnosticBundlePreview,
  DomainEventMessage,
  IdentifyResult,
  LayoutApplyParams,
  LayoutDeleteParams,
  LayoutExportParams,
  LayoutGetParams,
  LayoutGetResult,
  LayoutImportParams,
  LayoutListResult,
  LayoutMutationResult,
  LayoutSaveParams,
  MutationResult,
  MultiWindowEventMessage,
  NotificationClearParams,
  NotificationListParams,
  NotificationListResult,
  NotificationMarkReadParams,
  NotificationMarkUnreadParams,
  PaneCloseParams,
  PaneFocusParams,
  PaneMoveTabParams,
  PaneResizeParams,
  PaneSplitParams,
  RecoveryExportResult,
  SettingsGetResult,
  SettingsResetKeyParams,
  SettingsUpdateParams,
  ServiceEventMessage,
  ServiceRecoveryRequiredRecord,
  TabCloseParams,
  TabCloseAdvancedParams,
  TabDetachParams,
  TabDuplicateParams,
  TabMoveExactParams,
  TabReopenParams,
  TabMoveParams,
  TabOpenBrowserParams,
  TabOpenTerminalParams,
  TabSelectParams,
  TabUpdateParams,
  TerminalAttachResult,
  TerminalCheckpoint,
  TerminalEventMessage,
  TerminalRestartParams,
  WorkspaceCloseParams,
  WorkspaceAttentionEventMessage,
  WorkspaceAttentionSnapshot,
  WorkspaceAttentionSnapshotParams,
  WorkspaceCardSlotsEventMessage,
  WorkspaceCardSlotsReplaceParams,
  WorkspaceCardSlotsSnapshot,
  WorkspaceCardSlotsSnapshotParams,
  WorkspaceCardSlotV2EventMessage,
  WorkspaceCardSlotV2GetParams,
  WorkspaceCardSlotV2ReplaceParams,
  WorkspaceCardSlotV2Snapshot,
  WorkspaceCreateParams,
  WorkspaceListResult,
  WorkspaceBatchCloseParams,
  WorkspaceCanonicalMoveParams,
  WorkspaceOrganizationGetResult,
  WorkspacePinParams,
  WorkspaceSelectionReplaceParams,
  WorkspaceMoveParams,
  WorkspaceSelectParams,
  WorkspaceSnapshotParams,
  WorkspaceSnapshotResult,
  WorkspaceUpdateParams,
  WindowCloseParams,
  WindowCreateParams,
  WindowFocusParams,
  WindowListResult,
  WindowMutationResult,
  WindowCloseResult,
  AgentAttentionSetResult,
  AgentCatalogListResult,
  AgentCatalogRegisterResult,
  AgentHibernationMutationResult,
  AgentRestoreAssessResult,
  AgentSessionForkResult,
  AgentSessionRestoreResult,
  AgentTeamMemberMutationResult,
  AgentTeamMutationResult,
  RemoteSessionListResult,
  RemoteSessionResult,
  RemoteTargetListResult,
  RemoteTargetResult,
  RemoteTmuxDiscoveryResult,
  SidebarPlacement,
  TextBoxDocument,
  TextBoxListResult,
  ContentPreview,
  ContentReadParams,
  ContentSaveResult,
  ContentDocumentIssueParams,
  ContentDocumentIssueResult,
  ContentMarkdownParams,
  SafeMarkdownDocument,
  ContentDiffParams,
  ContentDiffResult,
  WorkspaceRootListResult,
  WorkspaceDirectoryListParams,
  WorkspaceDirectoryListResult,
  SearchQueryParams,
  SearchQueryResult,
  SearchControlResult,
  TaskListParams,
  TaskListResult,
  TaskActionResult,
  RecentlyClosedListResult
} from '@agent-workspace/protocol-client'
import { z } from 'zod'
import {
  actionInvokeParamsSchema,
  agentAttentionSetParamsSchema,
  agentCatalogRegisterParamsSchema,
  agentSessionBindingSchema,
  agentTeamCreateParamsSchema,
  agentTeamMemberCreateParamsSchema,
  contentSaveParamsSchema,
  layoutDeleteParamsSchema,
  remoteReconnectPolicySchema,
  remoteTargetCreateParamsSchema,
  remoteTmuxIdentitySchema,
  searchExportConfirmationIssueParamsSchema,
  searchExportConfirmationIssueResultSchema,
  searchExportParamsSchema,
  searchExportResultSchema
} from '@agent-workspace/protocol-client'
import { serviceRecoveryRequiredSafeRecordSchema } from '@agent-workspace/protocol-client'
import type { ApplicationMenuCommandId, ApplicationMenuState } from './application-menu'

export type DesktopRecoveryRequiredRecord = Omit<
  ServiceRecoveryRequiredRecord,
  'migrationBackupPath'
>

export type DesktopLifecycleState =
  | { status: 'starting' }
  | { status: 'ready' }
  | { status: 'recovering'; attempt: number; maxAttempts: number; message: string }
  | { status: 'recoveryRequired'; recovery: DesktopRecoveryRequiredRecord }
  | {
      status: 'failed'
      message: string
      availableActions?: { recoveryExport: boolean; diagnostics: boolean }
    }

export function parseDesktopLifecycleState(value: unknown): DesktopLifecycleState {
  const record = parseStrictLifecycleRecord(value)
  if (record.status === 'starting' || record.status === 'ready') {
    requireExactLifecycleKeys(record, ['status'])
    return { status: record.status }
  }
  if (record.status === 'recovering') {
    requireExactLifecycleKeys(record, ['status', 'attempt', 'maxAttempts', 'message'])
    const attempt = parseLifecycleAttempt(record.attempt)
    const maxAttempts = parseLifecycleAttempt(record.maxAttempts)
    if (attempt > maxAttempts) throw new Error('Invalid desktop lifecycle attempt')
    return {
      status: 'recovering',
      attempt,
      maxAttempts,
      message: parseLifecycleMessage(record.message)
    }
  }
  if (record.status === 'recoveryRequired') {
    requireExactLifecycleKeys(record, ['status', 'recovery'])
    return {
      status: 'recoveryRequired',
      recovery: serviceRecoveryRequiredSafeRecordSchema.parse(record.recovery)
    }
  }
  if (record.status === 'failed') {
    if (!('availableActions' in record)) {
      requireExactLifecycleKeys(record, ['status', 'message'])
      return { status: 'failed', message: parseLifecycleMessage(record.message) }
    }
    requireExactLifecycleKeys(record, ['status', 'message', 'availableActions'])
    const actions = parseStrictLifecycleRecord(record.availableActions)
    requireExactLifecycleKeys(actions, ['recoveryExport', 'diagnostics'])
    if (typeof actions.recoveryExport !== 'boolean' || typeof actions.diagnostics !== 'boolean') {
      throw new Error('Invalid desktop lifecycle actions')
    }
    return {
      status: 'failed',
      message: parseLifecycleMessage(record.message),
      availableActions: {
        recoveryExport: actions.recoveryExport,
        diagnostics: actions.diagnostics
      }
    }
  }
  throw new Error('Invalid desktop lifecycle status')
}

function parseStrictLifecycleRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid desktop lifecycle state')
  }
  return value as Record<string, unknown>
}

function requireExactLifecycleKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    throw new Error('Invalid desktop lifecycle state')
  }
}

function parseLifecycleAttempt(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10) {
    throw new Error('Invalid desktop lifecycle attempt')
  }
  return Number(value)
}

function parseLifecycleMessage(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    [...value].length < 1 ||
    [...value].length > 512 ||
    /[\p{Cc}]/u.test(value)
  ) {
    throw new Error('Invalid desktop lifecycle message')
  }
  return value
}

export interface DomainResyncNotice {
  expectedRevision: number
  receivedRevision: number
}

export type SavedLayoutImportRequest = Omit<LayoutImportParams, 'envelope'>
export const savedLayoutImportRequestSchema = layoutDeleteParamsSchema

/** The renderer supplies action data only; main owns correlation, idempotency, and exact target. */
export type DesktopActionInvokeRequest = Omit<
  ActionInvokeParams,
  'correlationId' | 'idempotency' | 'target'
>
export const desktopActionInvokeRequestSchema = actionInvokeParamsSchema.omit({
  correlationId: true,
  idempotency: true,
  target: true
})

const remoteUuidSchema = remoteTargetCreateParamsSchema.shape.remoteTargetId
const remoteRevisionSchema = remoteTargetCreateParamsSchema.shape.mutation.shape.expectedRevision
export const desktopRemoteTargetDraftSchema = remoteTargetCreateParamsSchema.omit({
  remoteTargetId: true,
  mutation: true
})
export const desktopRemoteTargetIdentitySchema = remoteTargetCreateParamsSchema.pick({
  remoteTargetId: true
})
export const desktopRemoteTargetDeleteRequestSchema = desktopRemoteTargetIdentitySchema.extend({
  expectedRevision: remoteRevisionSchema.positive()
})
export const desktopRemoteSessionActionSchema = z.strictObject({
  remoteSessionId: remoteUuidSchema,
  expectedRevision: remoteRevisionSchema.positive()
})
export const desktopRemoteConnectRequestSchema = z.strictObject({
  remoteTargetId: remoteUuidSchema,
  workspaceId: remoteUuidSchema,
  paneId: remoteUuidSchema,
  tabId: remoteUuidSchema,
  tmux: remoteTmuxIdentitySchema,
  reconnect: remoteReconnectPolicySchema
})
export type DesktopRemoteTargetDraft = z.infer<typeof desktopRemoteTargetDraftSchema>

export const DESKTOP_WORKSPACE_PATH_OPENER_IDS = [
  'fileManager',
  'vscode',
  'vscodeInsiders',
  'vscodium',
  'cursor',
  'windsurf',
  'zed',
  'sublimeText',
  'kate',
  't3Code',
  'intellijIdea',
  'webstorm',
  'pycharm',
  'goland',
  'clion',
  'rider',
  'fleet',
  'androidStudio'
] as const

export const desktopWorkspacePathOpenerIdSchema = z.enum(DESKTOP_WORKSPACE_PATH_OPENER_IDS)
export type DesktopWorkspacePathOpenerId = z.infer<typeof desktopWorkspacePathOpenerIdSchema>

export const desktopWorkspacePathOpenerSchema = z.strictObject({
  id: desktopWorkspacePathOpenerIdSchema,
  label: z.string().trim().min(1).max(80),
  kind: z.enum(['fileManager', 'ide'])
})
export type DesktopWorkspacePathOpener = z.infer<typeof desktopWorkspacePathOpenerSchema>

export const desktopWorkspacePathOpenersSchema = z
  .array(desktopWorkspacePathOpenerSchema)
  .min(1)
  .max(DESKTOP_WORKSPACE_PATH_OPENER_IDS.length)
  .superRefine((openers, context) => {
    if (openers[0]?.id !== 'fileManager' || openers[0].kind !== 'fileManager') {
      context.addIssue({ code: 'custom', message: 'The file manager opener must be first' })
    }
    if (new Set(openers.map(({ id }) => id)).size !== openers.length) {
      context.addIssue({ code: 'custom', message: 'Workspace path opener IDs must be unique' })
    }
    if (openers.some(({ id, kind }) => (id === 'fileManager') !== (kind === 'fileManager'))) {
      context.addIssue({ code: 'custom', message: 'Invalid workspace path opener kind' })
    }
  })

export const desktopWorkspacePathOpenRequestSchema = z.strictObject({
  workspaceId: remoteUuidSchema,
  openerId: desktopWorkspacePathOpenerIdSchema
})
export type DesktopWorkspacePathOpenRequest = z.infer<typeof desktopWorkspacePathOpenRequestSchema>
export type DesktopRemoteTargetDeleteRequest = z.infer<
  typeof desktopRemoteTargetDeleteRequestSchema
>
export type DesktopRemoteSessionAction = z.infer<typeof desktopRemoteSessionActionSchema>
export type DesktopRemoteConnectRequest = z.infer<typeof desktopRemoteConnectRequestSchema>

const desktopUuidSchema = remoteUuidSchema
const desktopPositiveRevisionSchema = remoteRevisionSchema.positive()
export const desktopSidebarSelectionSchema = z.strictObject({
  selected: z.enum([
    'textBox',
    'vault',
    'taskManager',
    'files',
    'markdown',
    'diff',
    'search',
    'recentlyClosed'
  ]),
  width: z.number().int().min(240).max(720),
  expectedRevision: desktopPositiveRevisionSchema
})
export const desktopTextBoxCreateRequestSchema = z.strictObject({
  workspaceId: desktopUuidSchema,
  title: z.string().trim().min(1).max(120),
  text: z.string().max(256 * 1024)
})
export const desktopTextBoxSaveRequestSchema = z.strictObject({
  textBoxDocumentId: desktopUuidSchema,
  expectedRevision: desktopPositiveRevisionSchema,
  title: z.string().trim().min(1).max(120),
  text: z.string().max(256 * 1024)
})
export const desktopTextBoxDeleteRequestSchema = z.strictObject({
  textBoxDocumentId: desktopUuidSchema,
  expectedRevision: desktopPositiveRevisionSchema
})
export const desktopContentSaveRequestSchema = contentSaveParamsSchema.omit({ mutation: true })
export const desktopSearchConsentRequestSchema = z.strictObject({
  sourceAuthorizationId: desktopUuidSchema,
  sourceKind: z.enum(['workspaceFile', 'agentTranscript']),
  retentionDays: z.number().int().min(1).max(365),
  exclusionIds: z.array(desktopUuidSchema).max(256),
  expectedRevision: desktopPositiveRevisionSchema
})
export const desktopSearchSourceRequestSchema = z.strictObject({
  sourceAuthorizationId: desktopUuidSchema,
  expectedRevision: desktopPositiveRevisionSchema
})
export const desktopSearchExportRequestSchema = z.strictObject({
  sourceAuthorizationId: desktopUuidSchema
})
export const desktopSearchExportConfirmationIssueParamsSchema =
  searchExportConfirmationIssueParamsSchema
export const desktopSearchExportParamsSchema = searchExportParamsSchema
export const desktopSearchExportConfirmationIssueResultSchema =
  searchExportConfirmationIssueResultSchema
export const desktopSearchExportResultSchema = searchExportResultSchema
export const desktopSearchRebuildRequestSchema = desktopSearchSourceRequestSchema.extend({
  cancellationId: desktopUuidSchema
})
export const desktopTaskActionRequestSchema = z.strictObject({
  action: z.enum(['detach', 'cancel', 'terminate', 'forceTerminate']),
  target: z.strictObject({
    sessionId: desktopUuidSchema,
    generation: desktopPositiveRevisionSchema,
    revision: desktopPositiveRevisionSchema
  })
})
export const desktopRecentlyClosedReopenRequestSchema = z.strictObject({
  record: z.strictObject({
    recentlyClosedId: desktopUuidSchema,
    authorizedDescriptorId: desktopUuidSchema,
    action: z.enum([
      'reopenTerminal',
      'reopenAgent',
      'reopenBrowser',
      'reconnectRemote',
      'reinvokeAction'
    ]),
    expectedRevision: desktopPositiveRevisionSchema
  }),
  workspaceId: desktopUuidSchema,
  paneId: desktopUuidSchema
})
export type DesktopSidebarSelection = z.infer<typeof desktopSidebarSelectionSchema>
export type DesktopTextBoxCreateRequest = z.infer<typeof desktopTextBoxCreateRequestSchema>
export type DesktopTextBoxSaveRequest = z.infer<typeof desktopTextBoxSaveRequestSchema>
export type DesktopTextBoxDeleteRequest = z.infer<typeof desktopTextBoxDeleteRequestSchema>
export type DesktopContentSaveRequest = z.infer<typeof desktopContentSaveRequestSchema>
export type DesktopSearchConsentRequest = z.infer<typeof desktopSearchConsentRequestSchema>
export type DesktopSearchSourceRequest = z.infer<typeof desktopSearchSourceRequestSchema>
export type DesktopSearchExportRequest = z.infer<typeof desktopSearchExportRequestSchema>
export type DesktopSearchRebuildRequest = z.infer<typeof desktopSearchRebuildRequestSchema>
export type DesktopTaskActionRequest = z.infer<typeof desktopTaskActionRequestSchema>
export type DesktopRecentlyClosedReopenRequest = z.infer<
  typeof desktopRecentlyClosedReopenRequestSchema
>

const agentUuidSchema = agentSessionBindingSchema.shape.agentSessionId
const agentRevisionSchema = agentCatalogRegisterParamsSchema.shape.operation.shape.sessionRevision
export const desktopAgentRegisterRequestSchema = z.strictObject({
  agentSessionId: agentUuidSchema,
  title: agentCatalogRegisterParamsSchema.shape.title,
  workspaceId: agentSessionBindingSchema.shape.workspaceId,
  paneId: agentSessionBindingSchema.shape.paneId,
  tabId: agentSessionBindingSchema.shape.tabId
})
export const desktopAgentSessionActionSchema = z.strictObject({
  agentSessionId: agentUuidSchema,
  expectedRevision: agentRevisionSchema.positive()
})
export const desktopAgentForkRequestSchema = desktopAgentSessionActionSchema.extend({
  destinationKind: z.enum(['existingTerminal', 'newTerminal']),
  workspaceId: agentSessionBindingSchema.shape.workspaceId,
  paneId: agentSessionBindingSchema.shape.paneId,
  tabId: agentSessionBindingSchema.shape.tabId,
  title: agentCatalogRegisterParamsSchema.shape.title
})
export const desktopAgentTeamCreateRequestSchema = agentTeamCreateParamsSchema.pick({ title: true })
export const desktopAgentTeamDeleteRequestSchema = z.strictObject({
  teamId: agentUuidSchema,
  expectedCatalogRevision: agentRevisionSchema,
  expectedTeamRevision: agentRevisionSchema.positive()
})
export const desktopAgentTeamMemberCreateRequestSchema = z.strictObject({
  teamId: agentUuidSchema,
  agentSessionId: agentUuidSchema,
  role: agentTeamMemberCreateParamsSchema.shape.role,
  parentMemberId: agentUuidSchema.optional(),
  expectedCatalogRevision: agentRevisionSchema,
  expectedTeamRevision: agentRevisionSchema.positive()
})
export const desktopAgentTeamMemberDeleteRequestSchema = z.strictObject({
  teamId: agentUuidSchema,
  memberId: agentUuidSchema,
  expectedCatalogRevision: agentRevisionSchema,
  expectedTeamRevision: agentRevisionSchema.positive(),
  expectedMemberRevision: agentRevisionSchema.positive()
})
export const desktopAgentTeamMemberUpdateRequestSchema =
  desktopAgentTeamMemberDeleteRequestSchema.extend({
    role: agentTeamMemberCreateParamsSchema.shape.role,
    parentMemberId: agentUuidSchema.optional()
  })
export const desktopAgentTeamMemberMoveRequestSchema =
  desktopAgentTeamMemberDeleteRequestSchema.extend({
    agentSessionId: agentUuidSchema
  })
export const desktopAgentAttentionRequestSchema = z.strictObject({
  agentSessionId: agentUuidSchema,
  state: agentAttentionSetParamsSchema.shape.state,
  expectedAttentionRevision: agentAttentionSetParamsSchema.shape.expectedAttentionRevision,
  expectedSessionRevision: agentRevisionSchema.positive()
})
export type DesktopAgentRegisterRequest = z.infer<typeof desktopAgentRegisterRequestSchema>
export type DesktopAgentSessionAction = z.infer<typeof desktopAgentSessionActionSchema>
export type DesktopAgentForkRequest = z.infer<typeof desktopAgentForkRequestSchema>
export type DesktopAgentTeamCreateRequest = z.infer<typeof desktopAgentTeamCreateRequestSchema>
export type DesktopAgentTeamDeleteRequest = z.infer<typeof desktopAgentTeamDeleteRequestSchema>
export type DesktopAgentTeamMemberCreateRequest = z.infer<
  typeof desktopAgentTeamMemberCreateRequestSchema
>
export type DesktopAgentTeamMemberDeleteRequest = z.infer<
  typeof desktopAgentTeamMemberDeleteRequestSchema
>
export type DesktopAgentTeamMemberUpdateRequest = z.infer<
  typeof desktopAgentTeamMemberUpdateRequestSchema
>
export type DesktopAgentTeamMemberMoveRequest = z.infer<
  typeof desktopAgentTeamMemberMoveRequestSchema
>
export type DesktopAgentAttentionRequest = z.infer<typeof desktopAgentAttentionRequestSchema>

export const MAX_WORKSPACE_RUNTIME_METADATA_CHARS = 256
export const MAX_WORKSPACE_LISTENING_PORTS = 16

export interface WorkspaceGitStatus {
  clean: boolean
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
  ahead: number
  behind: number
}

export interface WorkspaceRuntimeMetadata {
  gitBranch: string | null
  gitStatus: WorkspaceGitStatus | null
  listeningPorts: number[]
}

export function parseWorkspaceRuntimeMetadata(value: unknown): WorkspaceRuntimeMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid workspace runtime metadata')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 3 ||
    !('gitBranch' in record) ||
    !('gitStatus' in record) ||
    !('listeningPorts' in record)
  ) {
    throw new Error('Invalid workspace runtime metadata')
  }
  const rawListeningPorts = record.listeningPorts
  if (
    !Array.isArray(rawListeningPorts) ||
    rawListeningPorts.length > MAX_WORKSPACE_LISTENING_PORTS ||
    rawListeningPorts.some(
      (port, index) =>
        typeof port !== 'number' ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 0xffff ||
        (index > 0 && rawListeningPorts[index - 1] >= port)
    )
  ) {
    throw new Error('Invalid workspace runtime metadata')
  }
  const listeningPorts = rawListeningPorts.map(Number)
  const rawStatus = record.gitStatus
  let gitStatus: WorkspaceGitStatus | null = null
  if (rawStatus !== null) {
    if (typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
      throw new Error('Invalid workspace runtime metadata')
    }
    const status = rawStatus as Record<string, unknown>
    const booleanKeys = ['clean', 'staged', 'unstaged', 'untracked', 'conflicted'] as const
    if (
      Object.keys(status).length !== 7 ||
      booleanKeys.some((key) => typeof status[key] !== 'boolean') ||
      typeof status.ahead !== 'number' ||
      !Number.isSafeInteger(status.ahead) ||
      status.ahead < 0 ||
      typeof status.behind !== 'number' ||
      !Number.isSafeInteger(status.behind) ||
      status.behind < 0 ||
      status.clean !== !(status.staged || status.unstaged || status.untracked || status.conflicted)
    ) {
      throw new Error('Invalid workspace runtime metadata')
    }
    gitStatus = {
      clean: Boolean(status.clean),
      staged: Boolean(status.staged),
      unstaged: Boolean(status.unstaged),
      untracked: Boolean(status.untracked),
      conflicted: Boolean(status.conflicted),
      ahead: status.ahead,
      behind: status.behind
    }
  }
  const branch = record.gitBranch
  if (branch === null) return { gitBranch: null, gitStatus, listeningPorts }
  if (
    typeof branch !== 'string' ||
    !branch ||
    branch !== branch.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(branch) ||
    [...branch].length > MAX_WORKSPACE_RUNTIME_METADATA_CHARS
  ) {
    throw new Error('Invalid workspace runtime metadata')
  }
  return { gitBranch: branch, gitStatus, listeningPorts }
}

export type DesktopUpdateChannel = 'stable' | 'beta'
export type DesktopUpdatePackageType = 'appimage' | 'deb' | 'mac' | 'nsis' | 'rpm'

export type DesktopUpdateState =
  | { status: 'unconfigured'; channel: DesktopUpdateChannel }
  | { status: 'development'; channel: DesktopUpdateChannel }
  | { status: 'unsupported'; channel: DesktopUpdateChannel }
  | {
      status: 'idle' | 'checking' | 'up-to-date'
      channel: DesktopUpdateChannel
      packageType: DesktopUpdatePackageType
    }
  | {
      status: 'available' | 'downloaded'
      channel: DesktopUpdateChannel
      packageType: DesktopUpdatePackageType
      version: string
    }
  | {
      status: 'downloading'
      channel: DesktopUpdateChannel
      packageType: DesktopUpdatePackageType
      version: string
      progress: number
    }
  | {
      status: 'error'
      channel: DesktopUpdateChannel
      packageType: DesktopUpdatePackageType
      message: string
    }

export function parseDesktopUpdateState(value: unknown): DesktopUpdateState {
  const record = parseStrictUpdateRecord(value)
  const status = record.status
  const channel = parseUpdateChannel(record.channel)
  if (status === 'unconfigured' || status === 'development' || status === 'unsupported') {
    requireExactUpdateKeys(record, ['status', 'channel'])
    return { status, channel }
  }
  const packageType = parseUpdatePackageType(record.packageType)
  if (status === 'idle' || status === 'checking' || status === 'up-to-date') {
    requireExactUpdateKeys(record, ['status', 'channel', 'packageType'])
    return { status, channel, packageType }
  }
  if (status === 'available' || status === 'downloaded') {
    requireExactUpdateKeys(record, ['status', 'channel', 'packageType', 'version'])
    return { status, channel, packageType, version: parseUpdateVersion(record.version) }
  }
  if (status === 'downloading') {
    requireExactUpdateKeys(record, ['status', 'channel', 'packageType', 'version', 'progress'])
    if (
      typeof record.progress !== 'number' ||
      !Number.isFinite(record.progress) ||
      record.progress < 0 ||
      record.progress > 100
    ) {
      throw new Error('Invalid desktop update progress')
    }
    return {
      status,
      channel,
      packageType,
      version: parseUpdateVersion(record.version),
      progress: record.progress
    }
  }
  if (status === 'error') {
    requireExactUpdateKeys(record, ['status', 'channel', 'packageType', 'message'])
    return {
      status,
      channel,
      packageType,
      message: parseUpdateMessage(record.message)
    }
  }
  throw new Error('Invalid desktop update status')
}

function parseStrictUpdateRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid desktop update state')
  }
  return value as Record<string, unknown>
}

function requireExactUpdateKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    throw new Error('Invalid desktop update state')
  }
}

function parseUpdateChannel(value: unknown): DesktopUpdateChannel {
  if (value !== 'stable' && value !== 'beta') throw new Error('Invalid desktop update channel')
  return value
}

function parseUpdatePackageType(value: unknown): DesktopUpdatePackageType {
  if (
    value !== 'appimage' &&
    value !== 'deb' &&
    value !== 'mac' &&
    value !== 'nsis' &&
    value !== 'rpm'
  ) {
    throw new Error('Invalid desktop update package type')
  }
  return value
}

function parseUpdateVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(value)
  ) {
    throw new Error('Invalid desktop update version')
  }
  return value
}

function parseUpdateMessage(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 160 ||
    /[\p{Cc}]/u.test(value)
  ) {
    throw new Error('Invalid desktop update message')
  }
  return value
}

export interface BrowserViewMountParams {
  workspaceId: string
  tabId: string
  browserSessionId: string
  lifecycleId: string
}

export interface BrowserViewSessionParams {
  browserSessionId: string
  lifecycleId: string
}

export interface BrowserViewBoundsParams extends BrowserViewSessionParams {
  revision: number
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

const BROWSER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function parseBrowserViewMountParams(value: unknown): BrowserViewMountParams {
  const record = parseStrictBrowserRecord(value, [
    'workspaceId',
    'tabId',
    'browserSessionId',
    'lifecycleId'
  ])
  return {
    workspaceId: parseBrowserUuid(record.workspaceId),
    tabId: parseBrowserUuid(record.tabId),
    browserSessionId: parseBrowserUuid(record.browserSessionId),
    lifecycleId: parseBrowserUuid(record.lifecycleId)
  }
}

export function parseBrowserViewSessionParams(value: unknown): BrowserViewSessionParams {
  const record = parseStrictBrowserRecord(value, ['browserSessionId', 'lifecycleId'])
  return {
    browserSessionId: parseBrowserUuid(record.browserSessionId),
    lifecycleId: parseBrowserUuid(record.lifecycleId)
  }
}

export function parseBrowserViewBoundsParams(value: unknown): BrowserViewBoundsParams {
  const record = parseStrictBrowserRecord(value, [
    'browserSessionId',
    'lifecycleId',
    'revision',
    'x',
    'y',
    'width',
    'height',
    'visible'
  ])
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
    throw new Error('Invalid browser bounds revision')
  }
  if (typeof record.visible !== 'boolean') throw new Error('Invalid browser visibility')
  const finite = (field: 'x' | 'y' | 'width' | 'height', minimum: number, maximum: number) => {
    const value = record[field]
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new Error(`Invalid browser ${field}`)
    }
    return value
  }
  return {
    browserSessionId: parseBrowserUuid(record.browserSessionId),
    lifecycleId: parseBrowserUuid(record.lifecycleId),
    revision: Number(record.revision),
    x: finite('x', -1_000_000, 1_000_000),
    y: finite('y', -1_000_000, 1_000_000),
    width: finite('width', 0, 32_768),
    height: finite('height', 0, 32_768),
    visible: record.visible
  }
}

function parseStrictBrowserRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid browser operation payload')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    throw new Error('Invalid browser operation payload')
  }
  return record
}

function parseBrowserUuid(value: unknown): string {
  if (typeof value !== 'string' || !BROWSER_UUID_PATTERN.test(value)) {
    throw new Error('Invalid browser identifier')
  }
  return value
}

export interface DesktopBridge {
  /** Optional only so older renderer test doubles remain source-compatible. The preload always provides it. */
  getLifecycleState?(): Promise<DesktopLifecycleState>
  restartService?(): Promise<void>
  exportRecoveryDatabase?(): Promise<RecoveryExportResult | null>
  previewDiagnostics?(): Promise<DiagnosticBundlePreview>
  exportDiagnostics?(approvedPreview: DiagnosticBundlePreview): Promise<void | null>
  getConfiguration?(): Promise<ConfigurationGetResult>
  updateConfiguration?(params: ConfigurationUpdateParams): Promise<ConfigurationGetResult>
  quitApplication?(): Promise<void>
  getUpdateState?(): Promise<DesktopUpdateState>
  checkForUpdate?(): Promise<DesktopUpdateState>
  downloadUpdate?(): Promise<DesktopUpdateState>
  installUpdate?(): Promise<void>
  setApplicationMenuState?(state: ApplicationMenuState): Promise<void>
  onApplicationMenuCommand?(listener: (commandId: ApplicationMenuCommandId) => void): () => void
  onLifecycleState?(listener: (state: DesktopLifecycleState) => void): () => void
  onUpdateState?(listener: (state: DesktopUpdateState) => void): () => void
  identify(): Promise<IdentifyResult>
  /** Capability-gated by `actions-v1`; omitted by older preload builds. */
  listPublicActions?(): Promise<ActionListResult>
  /** Main derives exact target and durable idempotency data; renderer cannot forge either. */
  invokePublicAction?(params: DesktopActionInvokeRequest): Promise<ActionInvocationSnapshot>
  listWindows?(): Promise<WindowListResult>
  createWindow?(params: WindowCreateParams): Promise<WindowMutationResult>
  closeWindow?(params: WindowCloseParams): Promise<WindowCloseResult>
  focusWindow?(params: WindowFocusParams): Promise<WindowMutationResult>
  duplicateTab?(params: TabDuplicateParams): Promise<AdvancedTabMutationResult>
  moveTabExact?(params: TabMoveExactParams): Promise<AdvancedTabMutationResult>
  detachTab?(params: TabDetachParams): Promise<AdvancedTabMutationResult>
  closeTabAdvanced?(params: TabCloseAdvancedParams): Promise<AdvancedTabCloseResult>
  reopenTab?(params: TabReopenParams): Promise<AdvancedTabMutationResult>
  listClosedItems?(): Promise<ClosedItemListResult>
  getClosedItem?(params: ClosedItemGetParams): Promise<ClosedItemGetResult>
  navigateFocusHistory?(params: FocusHistoryNavigateParams): Promise<FocusHistoryNavigateResult>
  listWorkspaces(): Promise<WorkspaceListResult>
  /** Capability-gated by `workspace-groups-v1`. */
  getWorkspaceOrganization?(): Promise<WorkspaceOrganizationGetResult | null>
  listSavedLayouts?(): Promise<LayoutListResult | null>
  getSavedLayout?(params: LayoutGetParams): Promise<LayoutGetResult>
  saveLayout?(params: LayoutSaveParams): Promise<LayoutMutationResult>
  deleteLayout?(params: LayoutDeleteParams): Promise<LayoutMutationResult>
  applyLayout?(params: LayoutApplyParams): Promise<LayoutMutationResult>
  exportSavedLayoutToFile?(params: LayoutExportParams): Promise<boolean>
  importSavedLayoutFromFile?(params: SavedLayoutImportRequest): Promise<LayoutMutationResult | null>
  snapshotWorkspace(params: WorkspaceSnapshotParams): Promise<WorkspaceSnapshotResult>
  getSidebarPlacement?(): Promise<SidebarPlacement>
  saveSidebarPlacement?(params: DesktopSidebarSelection): Promise<SidebarPlacement>
  listTextBoxes?(): Promise<TextBoxListResult>
  createTextBox?(params: DesktopTextBoxCreateRequest): Promise<TextBoxDocument>
  saveTextBox?(params: DesktopTextBoxSaveRequest): Promise<TextBoxDocument>
  deleteTextBox?(params: DesktopTextBoxDeleteRequest): Promise<TextBoxDocument>
  listContentRoots?(): Promise<WorkspaceRootListResult>
  listContentDirectory?(
    params: Omit<WorkspaceDirectoryListParams, 'cursor'> & { cursor?: string }
  ): Promise<WorkspaceDirectoryListResult>
  issueContentDocument?(params: ContentDocumentIssueParams): Promise<ContentDocumentIssueResult>
  readContent?(params: ContentReadParams): Promise<ContentPreview>
  saveContent?(params: DesktopContentSaveRequest): Promise<ContentSaveResult>
  renderMarkdown?(params: ContentMarkdownParams): Promise<SafeMarkdownDocument>
  diffContent?(params: ContentDiffParams): Promise<ContentDiffResult>
  searchContent?(params: SearchQueryParams): Promise<SearchQueryResult>
  setSearchConsent?(params: DesktopSearchConsentRequest): Promise<SearchControlResult>
  excludeSearchSource?(params: DesktopSearchSourceRequest): Promise<SearchControlResult>
  forgetSearchSource?(params: DesktopSearchSourceRequest): Promise<SearchControlResult>
  rebuildSearchSource?(params: DesktopSearchRebuildRequest): Promise<SearchControlResult>
  /** Main owns confirmation, destination selection, and the service export challenge. */
  exportSearchSource?(params: DesktopSearchExportRequest): Promise<boolean>
  listTasks?(
    params: Omit<TaskListParams, 'kind' | 'lifecycle' | 'cursor'> & {
      kind?: TaskListParams['kind']
      lifecycle?: TaskListParams['lifecycle']
      cursor?: string
    }
  ): Promise<TaskListResult>
  actOnTask?(params: DesktopTaskActionRequest): Promise<TaskActionResult | null>
  listRecentlyClosed?(): Promise<RecentlyClosedListResult>
  reopenRecentlyClosed?(
    params: DesktopRecentlyClosedReopenRequest
  ): Promise<AdvancedTabMutationResult>
  getWorkspaceCardSlots?(
    params: WorkspaceCardSlotsSnapshotParams
  ): Promise<WorkspaceCardSlotsSnapshot>
  replaceWorkspaceCardSlots?(
    params: WorkspaceCardSlotsReplaceParams
  ): Promise<WorkspaceCardSlotsSnapshot>
  getWorkspaceCardSlotV2?(
    params: WorkspaceCardSlotV2GetParams
  ): Promise<WorkspaceCardSlotV2Snapshot>
  replaceWorkspaceCardSlotV2?(
    params: WorkspaceCardSlotV2ReplaceParams
  ): Promise<WorkspaceCardSlotV2Snapshot>
  getWorkspaceAttention?(
    params: WorkspaceAttentionSnapshotParams
  ): Promise<WorkspaceAttentionSnapshot>
  acknowledgeAttention?(
    params: AttentionAcknowledgementParams
  ): Promise<AttentionAcknowledgementResult>
  /** Optional only so older renderer test doubles remain source-compatible. The preload always provides it. */
  getWorkspaceRuntimeMetadata?(params: WorkspaceSnapshotParams): Promise<WorkspaceRuntimeMetadata>
  /** Optional only so older renderer test doubles remain source-compatible. The preload always provides it. */
  pickWorkspaceDirectory?(): Promise<string | null>
  /** Optional only so older renderer test doubles remain source-compatible. The preload always provides it. */
  listWorkspacePathOpeners?(): Promise<readonly DesktopWorkspacePathOpener[]>
  /** Main resolves the trusted directory from workspaceId; renderer paths are never accepted. */
  openWorkspacePath?(params: DesktopWorkspacePathOpenRequest): Promise<void>
  createWorkspace(params: WorkspaceCreateParams): Promise<MutationResult>
  updateWorkspace(params: WorkspaceUpdateParams): Promise<MutationResult>
  selectWorkspace(params: WorkspaceSelectParams): Promise<MutationResult>
  moveWorkspace(params: WorkspaceMoveParams): Promise<MutationResult>
  closeWorkspace(params: WorkspaceCloseParams): Promise<MutationResult>
  selectWorkspaces?(params: WorkspaceSelectionReplaceParams): Promise<MutationResult>
  pinWorkspace?(params: WorkspacePinParams): Promise<MutationResult>
  closeSelectedWorkspaces?(params: WorkspaceBatchCloseParams): Promise<MutationResult>
  reorderWorkspace?(params: WorkspaceCanonicalMoveParams): Promise<MutationResult>
  createGroup?(params: GroupCreateParams): Promise<MutationResult>
  renameGroup?(params: GroupRenameParams): Promise<MutationResult>
  deleteGroup?(params: GroupDeleteParams): Promise<MutationResult>
  moveGroup?(params: GroupMoveParams): Promise<MutationResult>
  assignWorkspaceGroup?(params: GroupAssignParams): Promise<MutationResult>
  collapseGroup?(params: GroupCollapseParams): Promise<MutationResult>
  splitPane(params: PaneSplitParams): Promise<MutationResult>
  focusPane(params: PaneFocusParams): Promise<MutationResult>
  resizePane(params: PaneResizeParams): Promise<MutationResult>
  closePane(params: PaneCloseParams): Promise<MutationResult>
  moveTabToPane(params: PaneMoveTabParams): Promise<MutationResult>
  openTerminalTab(params: TabOpenTerminalParams): Promise<MutationResult>
  openBrowserTab(params: TabOpenBrowserParams): Promise<MutationResult>
  navigateBrowser(params: BrowserNavigateParams): Promise<MutationResult>
  browserBack(params: BrowserBackParams): Promise<MutationResult>
  browserForward(params: BrowserForwardParams): Promise<MutationResult>
  reloadBrowser(params: BrowserReloadParams): Promise<MutationResult>
  stopBrowser(params: BrowserStopParams): Promise<MutationResult>
  openBrowserDevTools(params: BrowserOpenDevToolsParams): Promise<MutationResult>
  mountBrowserView(params: BrowserViewMountParams): Promise<void>
  unmountBrowserView(params: BrowserViewSessionParams): Promise<void>
  setBrowserBounds(params: BrowserViewBoundsParams): Promise<void>
  focusBrowserView(params: BrowserViewSessionParams): Promise<void>
  selectTab(params: TabSelectParams): Promise<MutationResult>
  updateTab(params: TabUpdateParams): Promise<MutationResult>
  moveTab(params: TabMoveParams): Promise<MutationResult>
  closeTab(params: TabCloseParams): Promise<MutationResult>
  restartTerminal(params: TerminalRestartParams): Promise<MutationResult>
  /** Optional only so older renderer test doubles remain source-compatible. The preload always provides it. */
  listNotifications?(params?: NotificationListParams): Promise<NotificationListResult>
  markNotificationRead?(params: NotificationMarkReadParams): Promise<MutationResult>
  markNotificationUnread?(params: NotificationMarkUnreadParams): Promise<MutationResult>
  clearNotifications?(params: NotificationClearParams): Promise<MutationResult>
  getSettings(): Promise<SettingsGetResult>
  updateSettings(params: SettingsUpdateParams): Promise<MutationResult>
  resetSettingKey(params: SettingsResetKeyParams): Promise<MutationResult>
  attachTerminal(terminalId: string): Promise<TerminalAttachResult>
  detachTerminal(terminalId: string): Promise<void>
  sendTerminalInput(terminalId: string, data: string): Promise<void>
  resizeTerminal(terminalId: string, rows: number, cols: number): Promise<void>
  checkpointTerminal(terminalId: string, checkpoint: TerminalCheckpoint): Promise<void>
  openExternal(url: string): Promise<void>
  listRemoteTargets?(): Promise<RemoteTargetListResult>
  enrollRemoteTarget?(params: DesktopRemoteTargetDraft): Promise<RemoteTargetResult | null>
  replaceRemoteCredential?(remoteTargetId: string): Promise<boolean | null>
  deleteRemoteTarget?(params: DesktopRemoteTargetDeleteRequest): Promise<RemoteTargetResult | null>
  listRemoteSessions?(): Promise<RemoteSessionListResult>
  connectRemoteSession?(params: DesktopRemoteConnectRequest): Promise<RemoteSessionResult>
  confirmRemoteHostKey?(params: DesktopRemoteSessionAction): Promise<RemoteSessionResult>
  discoverRemoteTmux?(params: DesktopRemoteSessionAction): Promise<RemoteTmuxDiscoveryResult>
  detachRemoteSession?(params: DesktopRemoteSessionAction): Promise<RemoteSessionResult>
  reconnectRemoteSession?(params: DesktopRemoteSessionAction): Promise<RemoteSessionResult>
  closeRemoteSession?(params: DesktopRemoteSessionAction): Promise<RemoteSessionResult | null>
  listAgentSessions?(): Promise<AgentCatalogListResult>
  registerAgentSession?(params: DesktopAgentRegisterRequest): Promise<AgentCatalogRegisterResult>
  assessAgentRestore?(params: DesktopAgentSessionAction): Promise<AgentRestoreAssessResult>
  restoreAgentSession?(params: DesktopAgentSessionAction): Promise<AgentSessionRestoreResult>
  forkAgentSession?(params: DesktopAgentForkRequest): Promise<AgentSessionForkResult>
  hibernateAgentSession?(
    params: DesktopAgentSessionAction
  ): Promise<AgentHibernationMutationResult | null>
  createAgentTeam?(params: DesktopAgentTeamCreateRequest): Promise<AgentTeamMutationResult>
  deleteAgentTeam?(params: DesktopAgentTeamDeleteRequest): Promise<AgentTeamMutationResult>
  createAgentTeamMember?(
    params: DesktopAgentTeamMemberCreateRequest
  ): Promise<AgentTeamMemberMutationResult>
  updateAgentTeamMember?(
    params: DesktopAgentTeamMemberUpdateRequest
  ): Promise<AgentTeamMemberMutationResult>
  moveAgentTeamMember?(
    params: DesktopAgentTeamMemberMoveRequest
  ): Promise<AgentTeamMemberMutationResult>
  deleteAgentTeamMember?(
    params: DesktopAgentTeamMemberDeleteRequest
  ): Promise<AgentTeamMemberMutationResult>
  setAgentAttention?(params: DesktopAgentAttentionRequest): Promise<AgentAttentionSetResult>
  onTerminalEvent(listener: (event: TerminalEventMessage) => void): () => void
  onDomainEvent(listener: (event: DomainEventMessage) => void): () => void
  onWorkspaceCardSlotsEvent?(listener: (event: WorkspaceCardSlotsEventMessage) => void): () => void
  onWorkspaceCardSlotV2Event?(
    listener: (event: WorkspaceCardSlotV2EventMessage) => void
  ): () => void
  onWorkspaceAttentionEvent?(listener: (event: WorkspaceAttentionEventMessage) => void): () => void
  onDomainResyncRequired(listener: (notice: DomainResyncNotice) => void): () => void
  onServiceEvent(listener: (event: ServiceEventMessage) => void): () => void
  onMultiWindowEvent?(listener: (event: MultiWindowEventMessage) => void): () => void
  onActionRegistryChanged?(listener: (event: ActionRegistryChangedEvent) => void): () => void
  onDesktopBindingRebind?(listener: () => void): () => void
  onBrowserViewsRebind?(listener: () => void): () => void
}

export const DESKTOP_IPC = {
  lifecycleGet: 'lifecycle:get',
  lifecycleChanged: 'lifecycle:changed',
  serviceRestart: 'service:restart',
  recoveryExportDatabase: 'recovery:exportDatabase',
  diagnosticsPreview: 'diagnostics:preview',
  diagnosticsExport: 'diagnostics:export',
  configurationGet: 'configuration:get',
  configurationUpdate: 'configuration:update',
  applicationQuit: 'application:quit',
  updateGetState: 'update:getState',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateStateChanged: 'update:stateChanged',
  applicationMenuUpdate: 'applicationMenu:update',
  applicationMenuCommand: 'applicationMenu:command',
  multiWindowEvent: 'multiWindow:event',
  desktopBindingRebind: 'desktop:bindingRebind',
  browserViewsRebind: 'browser:viewsRebind',
  identify: 'service:identify',
  actionList: 'action:list',
  actionInvoke: 'action:invoke',
  actionRegistryChanged: 'action:registryChanged',
  windowList: 'window:list',
  windowCreate: 'window:create',
  windowClose: 'window:close',
  windowFocus: 'window:focus',
  tabDuplicate: 'tab:duplicate',
  tabMoveExact: 'tab:moveExact',
  tabDetach: 'tab:detach',
  tabCloseAdvanced: 'tab:closeAdvanced',
  tabReopen: 'tab:reopen',
  closedList: 'closed:list',
  closedGet: 'closed:get',
  focusHistoryNavigate: 'focusHistory:navigate',
  workspaceList: 'workspace:list',
  workspaceOrganizationGet: 'workspace:organization:get',
  layoutList: 'layout:list',
  layoutGet: 'layout:get',
  layoutSave: 'layout:save',
  layoutDelete: 'layout:delete',
  layoutApply: 'layout:apply',
  layoutExportFile: 'layout:exportFile',
  layoutImportFile: 'layout:importFile',
  workspaceSnapshot: 'workspace:snapshot',
  sidebarPlacementGet: 'sidebar:placement:get',
  sidebarPlacementSave: 'sidebar:placement:save',
  textBoxList: 'sidebar:textBox:list',
  textBoxCreate: 'sidebar:textBox:create',
  textBoxSave: 'sidebar:textBox:save',
  textBoxDelete: 'sidebar:textBox:delete',
  contentRootList: 'sidebar:content:rootList',
  contentDirectoryList: 'sidebar:content:directoryList',
  contentDocumentIssue: 'sidebar:content:documentIssue',
  contentRead: 'sidebar:content:read',
  contentSave: 'sidebar:content:save',
  contentMarkdown: 'sidebar:content:markdown',
  contentDiff: 'sidebar:content:diff',
  searchQuery: 'sidebar:search:query',
  searchConsent: 'sidebar:search:consent',
  searchExclude: 'sidebar:search:exclude',
  searchForget: 'sidebar:search:forget',
  searchRebuild: 'sidebar:search:rebuild',
  searchExport: 'sidebar:search:export',
  taskList: 'sidebar:task:list',
  taskAction: 'sidebar:task:action',
  recentlyClosedList: 'sidebar:recentlyClosed:list',
  recentlyClosedReopen: 'sidebar:recentlyClosed:reopen',
  workspaceCardSlotsGet: 'workspace:cardSlots:get',
  workspaceCardSlotsReplace: 'workspace:cardSlots:replace',
  workspaceCardSlotV2Get: 'workspace:cardSlots:v2:get',
  workspaceCardSlotV2Replace: 'workspace:cardSlots:v2:replace',
  workspaceAttentionGet: 'workspace:attention:get',
  attentionAcknowledge: 'attention:acknowledge',
  workspaceRuntimeMetadata: 'workspace:runtimeMetadata',
  workspacePickDirectory: 'workspace:pickDirectory',
  workspacePathOpeners: 'workspace:pathOpeners',
  workspacePathOpen: 'workspace:pathOpen',
  workspaceCreate: 'workspace:create',
  workspaceUpdate: 'workspace:update',
  workspaceSelect: 'workspace:select',
  workspaceMove: 'workspace:move',
  workspaceClose: 'workspace:close',
  workspaceSelectMany: 'workspace:selectMany',
  workspacePin: 'workspace:pin',
  workspaceCloseSelected: 'workspace:closeSelected',
  workspaceReorder: 'workspace:reorder',
  groupCreate: 'group:create',
  groupRename: 'group:rename',
  groupDelete: 'group:delete',
  groupMove: 'group:move',
  groupAssign: 'group:assign',
  groupCollapse: 'group:collapse',
  paneSplit: 'pane:split',
  paneFocus: 'pane:focus',
  paneResize: 'pane:resize',
  paneClose: 'pane:close',
  paneMoveTab: 'pane:moveTab',
  tabOpenTerminal: 'tab:openTerminal',
  tabOpenBrowser: 'tab:openBrowser',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserStop: 'browser:stop',
  browserOpenDevTools: 'browser:openDevTools',
  browserMountView: 'browser:mountView',
  browserUnmountView: 'browser:unmountView',
  browserSetBounds: 'browser:setBounds',
  browserFocusView: 'browser:focusView',
  tabSelect: 'tab:select',
  tabUpdate: 'tab:update',
  tabMove: 'tab:move',
  tabClose: 'tab:close',
  terminalRestart: 'terminal:restart',
  notificationList: 'notification:list',
  notificationMarkRead: 'notification:markRead',
  notificationMarkUnread: 'notification:markUnread',
  notificationClear: 'notification:clear',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsResetKey: 'settings:resetKey',
  terminalAttach: 'terminal:attach',
  terminalDetach: 'terminal:detach',
  terminalSend: 'terminal:send',
  terminalResize: 'terminal:resize',
  terminalCheckpoint: 'terminal:checkpoint',
  terminalEvent: 'terminal:event',
  domainEvent: 'domain:event',
  workspaceCardSlotsEvent: 'workspace:cardSlots:event',
  workspaceCardSlotV2Event: 'workspace:cardSlots:v2:event',
  workspaceAttentionEvent: 'workspace:attention:event',
  domainResyncRequired: 'domain:resyncRequired',
  serviceEvent: 'service:event',
  openExternal: 'desktop:openExternal',
  remoteTargetList: 'remoteTarget:list',
  remoteTargetEnroll: 'remoteTarget:enroll',
  remoteCredentialReplace: 'remoteCredential:replace',
  remoteTargetDelete: 'remoteTarget:delete',
  remoteSessionList: 'remoteSession:list',
  remoteSessionConnect: 'remoteSession:connect',
  remoteHostKeyConfirm: 'remoteHostKey:confirm',
  remoteTmuxDiscover: 'remoteTmux:discover',
  remoteSessionDetach: 'remoteSession:detach',
  remoteSessionReconnect: 'remoteSession:reconnect',
  remoteSessionClose: 'remoteSession:close',
  agentCatalogList: 'agentCatalog:list',
  agentCatalogRegister: 'agentCatalog:register',
  agentRestoreAssess: 'agentRestore:assess',
  agentSessionRestore: 'agentSession:restore',
  agentSessionFork: 'agentSession:fork',
  agentSessionHibernate: 'agentSession:hibernate',
  agentTeamCreate: 'agentTeam:create',
  agentTeamDelete: 'agentTeam:delete',
  agentTeamMemberCreate: 'agentTeamMember:create',
  agentTeamMemberUpdate: 'agentTeamMember:update',
  agentTeamMemberMove: 'agentTeamMember:move',
  agentTeamMemberDelete: 'agentTeamMember:delete',
  agentAttentionSet: 'agentAttention:set'
} as const
