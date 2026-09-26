import { timingSafeEqual } from 'node:crypto'

import {
  terminalCheckpointSchema,
  settingsGetResultSchema,
  settingsWriteRequestSchema,
  settingsResetRequestSchema,
  settingsMutationResultSchema,
  notificationPageRequestSchema,
  notificationListResultSchema,
  notificationWriteRequestSchema,
  notificationPublishRequestSchema,
  notificationClearRequestSchema,
  notificationChangeResultSchema,
  terminalCreateParamsSchema,
  terminalInputSchema,
  terminalResizeSchema,
  terminalRestartRequestSchema,
  tabSelectRequestSchema,
  tabCloseRequestSchema,
  tabOpenTerminalRequestSchema,
  tabOpenBrowserRequestSchema,
  browserNavigateRequestSchema,
  browserBackRequestSchema,
  browserForwardRequestSchema,
  browserReloadRequestSchema,
  browserStopRequestSchema,
  browserOpenDevToolsRequestSchema,
  browserObserveRequestSchema,
  closedItemListResultSchema,
  closedItemGetParamsSchema,
  closedItemGetResultSchema,
  tabReopenRequestSchema,
  tabReopenResultSchema,
  paneFocusRequestSchema,
  paneResizeRequestSchema,
  paneSplitRequestSchema,
  paneCloseRequestSchema,
  workspacePinRequestSchema,
  workspaceSelectionReplaceRequestSchema,
  workspaceCanonicalMoveRequestSchema,
  workspaceBatchCloseRequestSchema,
  layoutGetParamsSchema,
  layoutSaveRequestSchema,
  layoutDeleteRequestSchema,
  layoutApplyRequestSchema,
  layoutImportRequestSchema,
  remoteListParamsSchema,
  remoteTargetIdParamsSchema,
  remoteSessionIdParamsSchema,
  remoteTerminalResultSchema,
  remoteSessionConnectParamsSchema,
  remoteSessionReconnectParamsSchema,
  remoteSessionDetachParamsSchema,
  remoteSessionCloseParamsSchema,
  agentCatalogListParamsSchema,
  agentCatalogGetParamsSchema,
  agentCatalogRegisterParamsSchema,
  agentCatalogRegisterResultSchema,
  agentRestoreAssessParamsSchema,
  agentRestoreAssessResultSchema,
  agentCatalogListResultSchema,
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
  actionCancelParamsSchema,
  actionInvokeParamsSchema,
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
  remoteHostKeyScanParamsSchema,
  remoteHostKeyTrustParamsSchema,
  remoteTmuxDiscoverParamsSchema,
  groupCreateRequestSchema,
  groupRenameRequestSchema,
  groupDeleteRequestSchema,
  groupMoveRequestSchema,
  groupAssignRequestSchema,
  groupCollapseRequestSchema,
  tabMoveRequestSchema,
  tabUpdateRequestSchema,
  diagnosticExportRequestSchema,
  diagnosticExportResultSchema,
  workspaceCreateRequestSchema,
  workspaceCloseRequestSchema,
  workspaceMoveRequestSchema,
  workspaceSelectRequestSchema,
  workspaceUpdateRequestSchema
} from '@agent-workspace/contracts'
import { upgradeWebSocket } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type { ZodType } from 'zod'
import type { BrowserAutomationProviderAcknowledgeParams } from '@agent-workspace/protocol-client'
import {
  tabDuplicateParamsSchema,
  tabMoveExactParamsSchema,
  tabDetachParamsSchema,
  advancedTabMutationResultSchema,
  focusHistoryNavigateParamsSchema,
  focusHistoryNavigateResultSchema
} from '@agent-workspace/protocol-client'
import type WebSocket from 'ws'
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
  agentSessionRestoreParamsSchema,
  agentSessionRestoreResultSchema,
  agentSessionForkParamsSchema,
  agentSessionForkResultSchema,
  agentHibernationPreflightParamsSchema,
  agentHibernationPreflightResultSchema,
  agentHibernationCancelParamsSchema,
  agentHibernationConfirmParamsSchema,
  agentHibernationMutationResultSchema,
  configurationGetResultSchema,
  configurationUpdateParamsSchema,
  remoteTargetCreateParamsSchema,
  remoteTargetDeleteParamsSchema,
  remoteTargetResultSchema,
  remoteTargetEnrollmentBeginSchema,
  remoteTargetEnrollmentCommitSchema,
  remoteTargetEnrollmentAbortSchema,
  remoteTargetEnrollmentAbortResultSchema,
  remoteCredentialReplacementSchema,
  diagnosticBundlePreviewSchema,
  browserAutomationProviderPollParamsSchema,
  browserAutomationProviderPollResultSchema,
  browserAutomationProviderAcknowledgeParamsSchema,
  browserAutomationProviderAcknowledgeResultSchema,
  browserAutomationProviderTransferRespondParamsSchema,
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
  browserAutomationScreenshotReleaseResultSchema,
  windowBindResultSchema,
  windowCreateParamsSchema,
  windowCloseParamsSchema,
  windowFocusParamsSchema,
  windowMutationResultSchema,
  windowCloseResultSchema,
  windowStateGetForParamsSchema,
  windowStateGetForResultSchema,
  windowStateUpdateForParamsSchema,
  type WindowCloseParams
} from '@agent-workspace/protocol-client'

import { LegacyDatabaseError } from '../persistence/legacy-inspection'
import { serviceLogger } from '../logging/service-logger'
import {
  DiagnosticService,
  createSafeConfigurationSummary
} from '../diagnostics/diagnostic-service'
import type { LegacyStateReader } from '../persistence/legacy-state-reader'
import {
  StateStoreError,
  WindowStateStoreError,
  type ApplicationStateStore
} from '../persistence/application-state-store'
import { projectWindowList, projectStateToWindow } from '../domain/window-projection'
import { WindowMutationError } from '../domain/window-mutations'
import {
  ConfigurationQualificationError,
  type ConfigurationQualification
} from '../configuration/configuration-qualification'
import { RemoteCatalogError } from '../persistence/remote-catalog'
import { AgentCatalogError } from '../persistence/agent-catalog'
import { AgentMutationError } from '../persistence/agent-mutations'
import type { AgentRegistrationService } from '../agents/agent-registration-service'
import {
  NotificationMutationError,
  type NotificationMutations
} from '../persistence/notification-mutations'
import { SettingsMutationError, type SettingsMutations } from '../persistence/settings-mutations'
import {
  AgentTeamMutationError,
  type AgentTeamMutations,
  type MemberRecord,
  type TeamMutationOutcome,
  type TeamRecord
} from '../persistence/agent-team-mutations'
import { ActionRegistry, ActionRegistryError } from '../actions/action-registry'
import { ServiceActionError, ServiceActionInvoker } from '../actions/service-action-invoker'
import { ContentCatalogError, type ContentCatalog } from '../content/content-catalog'
import { ContentMutationError, type ContentMutations } from '../content/content-mutations'
import { TaskCatalogError, type TaskCatalog } from '../content/task-catalog'
import { TaskActionError, type TaskActions } from '../content/task-actions'
import { FilesServiceError, type FilesService } from '../content/files-service'
import { BrowserMutationError } from '../domain/browser-mutations'
import { VaultSearchError, type VaultSearch } from '../content/vault-search'
import { EncryptedVaultSearch } from '../content/encrypted-vault-search'
import type { WindowBindingRegistry } from './window-binding-registry'
import { HostKeyAuthorityError, type HostKeyAuthority } from '../remote/host-key-authority'
import { HostKeyScanError } from '../remote/host-key-scanner'
import { KnownHostsError } from '../remote/known-hosts-store'
import { RemoteHostKeyService } from '../remote/remote-host-key-service'
import type { RemoteInteractiveRuntime } from '../remote/remote-interactive-runtime'
import type { RemoteTargetDeletionService } from '../remote/remote-target-deletion-service'
import {
  RemoteCredentialEnrollmentError,
  type RemoteCredentialEnrollmentService
} from '../remote/remote-credential-enrollment-service'
import {
  RemoteActivationError,
  type RemoteSessionActivationService
} from '../remote/remote-session-activation-service'
import {
  RemoteTransportError,
  type RemoteTmuxDiscoveryService
} from '../remote/remote-tmux-discovery-service'
import { CredentialError } from '../remote/credential-provider'
import { BrowserAutomationMailboxError } from '../browser-automation/provider-mailbox'
import type { BrowserAutomationProviderAuthority } from '../browser-automation/provider-authority'
import type { BrowserAutomationDurableRecords } from '../browser-automation/durable-records'
import type { BrowserAutomationRuntime } from '../browser-automation/runtime'
import type { BrowserAutomationSessionCreateParams } from '@agent-workspace/protocol-client'
import { SshLaunchError } from '../remote/ssh-launch-plan'
import { TmuxProtocolError } from '../remote/tmux-protocol'
import { WorkspaceMutationError } from '../domain/workspace-mutations'
import { projectOrganization } from '../domain/organization-mutations'
import { listLayouts, getLayout, exportLayout } from '../domain/layout-mutations'
import { projectApplicationSnapshot } from '../domain/application-projection'
import { projectSettings } from '../domain/settings-projection'
import { RecentlyClosedError } from '../domain/recently-closed-mutations'
import type { WorkspaceTerminalRuntime } from '../domain/workspace-terminal-runtime'
import type { RecentlyClosedService } from '../persistence/recently-closed-service'
import { TerminalServiceError, type TerminalService } from '../terminal/terminal-service'
import {
  CardSlotAttentionError,
  type CardSlotAttentionService
} from '../domain/card-slot-attention'
import {
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
} from '@agent-workspace/protocol-client'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024

class AgentTeamOutcomeError extends Error {
  constructor(
    public readonly code:
      | 'idempotency_conflict'
      | 'stale_revision'
      | 'resource_limit'
      | 'invalid_state'
      | 'team_unavailable',
    message: string
  ) {
    super(message)
    this.name = 'AgentTeamOutcomeError'
  }
}

function appliedTeamMutation<T>(outcome: TeamMutationOutcome<T>): T {
  if (outcome.status === 'applied' || outcome.status === 'replay') return outcome.value
  const code =
    outcome.status === 'conflict'
      ? 'idempotency_conflict'
      : outcome.status === 'resourceLimit'
        ? 'resource_limit'
        : outcome.status === 'dependencyConflict'
          ? 'invalid_state'
          : 'stale_revision'
  throw new AgentTeamOutcomeError(code, `Agent team mutation: ${outcome.status}`)
}

const AUTOMATION_CALLER_ERRORS = new Set([
  'session_not_found',
  'session_generation_mismatch',
  'provider_unavailable',
  'provider_ineligible',
  'provider_lease_expired',
  'provider_epoch_mismatch',
  'automation_backpressure',
  'session_limit',
  'session_expired',
  'invalid_operation',
  'idempotency_expired',
  'idempotency_conflict',
  'interrupted',
  'timeout',
  'target_required',
  'target_not_found',
  'target_stale',
  'resource_limit',
  'result_expired',
  'policy_denied',
  'capability_unavailable',
  'stale_navigation',
  'invalid_selector',
  'unsafe_url',
  'canceled'
])

export function createApp(
  service: TerminalService,
  token: string,
  stateReader?: LegacyStateReader,
  stateStore?: ApplicationStateStore,
  workspaceRuntime?: WorkspaceTerminalRuntime,
  hostKeyAuthority?: HostKeyAuthority,
  remoteTmux?: RemoteTmuxDiscoveryService,
  contentCatalog?: ContentCatalog,
  contentMutations?: ContentMutations,
  remoteInteractive?: RemoteInteractiveRuntime,
  remoteActivation?: RemoteSessionActivationService,
  agentTeamMutations?: AgentTeamMutations,
  notificationMutations?: NotificationMutations,
  settingsMutations?: SettingsMutations,
  recentlyClosed?: RecentlyClosedService,
  taskCatalog?: TaskCatalog,
  windowBindings?: WindowBindingRegistry,
  filesService?: FilesService,
  agentRegistration?: AgentRegistrationService,
  taskActions?: TaskActions,
  vaultSearch?: VaultSearch | EncryptedVaultSearch,
  cardSlotAttention?: CardSlotAttentionService,
  configurationQualification?: ConfigurationQualification,
  remoteTargetDeletion?: RemoteTargetDeletionService,
  remoteCredentialEnrollment?: RemoteCredentialEnrollmentService,
  remoteCredentialV1Replacement?: RemoteCredentialEnrollmentService,
  remoteCredentialLiveReplacement?: RemoteCredentialEnrollmentService,
  diagnosticLogDirectory?: string,
  browserAutomation?: {
    authority: BrowserAutomationProviderAuthority
    records: BrowserAutomationDurableRecords
    runtime?: BrowserAutomationRuntime
  }
): Hono {
  if (Buffer.byteLength(token) < 32) {
    throw new Error('The server token must contain at least 32 bytes')
  }
  if (stateReader && stateStore) throw new Error('Provide one state owner per server')
  if (configurationQualification && !stateStore) {
    throw new Error('Configuration qualification requires an isolated state store')
  }
  if (diagnosticLogDirectory && (!stateStore || !configurationQualification)) {
    throw new Error('Node diagnostics require a qualified isolated state copy')
  }
  if (hostKeyAuthority && !stateStore) {
    throw new Error('Remote host-key authority requires a state store')
  }
  if (contentCatalog && !stateStore) {
    throw new Error('Content catalog requires an isolated state store')
  }
  if (contentMutations && (!contentCatalog || !stateStore)) {
    throw new Error('Content mutations require an isolated state store and catalog')
  }
  if (agentTeamMutations && !stateStore) {
    throw new Error('Agent team mutations require an isolated state store')
  }
  if (agentRegistration && (!stateStore || !workspaceRuntime || !workspaceRuntime.uses(service))) {
    throw new Error('Agent registration requires the isolated state and terminal runtime')
  }
  if (notificationMutations && !stateStore) {
    throw new Error('Notification mutations require an isolated state store')
  }
  if (cardSlotAttention && !stateStore) {
    throw new Error('Card slots and attention require an isolated state store')
  }
  if (settingsMutations && !stateStore) {
    throw new Error('Settings mutations require an isolated state store')
  }
  if (remoteInteractive && (!stateStore || !remoteInteractive.uses(service))) {
    throw new Error(
      'Remote interactive runtime requires the isolated state store and terminal service'
    )
  }
  if (remoteActivation && (!remoteInteractive || !stateStore)) {
    throw new Error('Remote activation requires the interactive runtime and isolated state store')
  }
  if (remoteTargetDeletion && (!stateStore || !remoteActivation || !hostKeyAuthority)) {
    throw new Error('Remote target deletion requires scoped transport and host-key authority')
  }
  if (remoteCredentialEnrollment && (!stateStore || !remoteActivation || !hostKeyAuthority)) {
    throw new Error('Remote target enrollment requires scoped transport and host-key authority')
  }
  if (
    (remoteCredentialV1Replacement || remoteCredentialLiveReplacement) &&
    ((remoteCredentialEnrollment &&
      remoteCredentialEnrollment !== remoteCredentialLiveReplacement) ||
      (remoteCredentialV1Replacement && remoteCredentialLiveReplacement) ||
      !stateStore ||
      !remoteActivation ||
      !hostKeyAuthority)
  ) {
    throw new Error('Live replacement requires its own scoped transport')
  }
  const replacementService =
    remoteCredentialLiveReplacement ?? remoteCredentialV1Replacement ?? remoteCredentialEnrollment
  if (
    workspaceRuntime &&
    (!stateStore || !workspaceRuntime.uses(service) || !workspaceRuntime.isReady())
  ) {
    throw new Error('Workspace runtime must use the state store and terminal service')
  }
  if (recentlyClosed && (!stateStore || !workspaceRuntime)) {
    throw new Error(
      'Recently closed commands require an isolated state store and ready workspace runtime'
    )
  }
  if (taskCatalog && (!stateStore || !windowBindings)) {
    throw new Error('Task catalog requires an isolated store and private window bindings')
  }
  if (taskActions && (!taskCatalog || !windowBindings || !remoteActivation)) {
    throw new Error(
      'Task actions require the remote provider, catalog, and private window bindings'
    )
  }
  if (windowBindings && !stateStore) {
    throw new Error('Window bindings require an isolated state store')
  }
  if (filesService && !stateStore) throw new Error('Files service requires an isolated state store')

  const app = new Hono()
  const actionRegistry = stateStore ? new ActionRegistry() : undefined
  const serviceActionInvoker = stateStore ? new ServiceActionInvoker(stateStore) : undefined
  const remoteHostKeys =
    hostKeyAuthority && stateStore
      ? new RemoteHostKeyService(stateStore, hostKeyAuthority)
      : undefined
  app.onError((error, c) => {
    if (
      browserAutomation?.runtime &&
      error instanceof Error &&
      AUTOMATION_CALLER_ERRORS.has(error.message)
    ) {
      const code = error.message
      const status =
        code === 'session_not_found'
          ? 404
          : code === 'policy_denied'
            ? 403
            : code === 'provider_unavailable' ||
                code === 'interrupted' ||
                code === 'timeout' ||
                code === 'capability_unavailable'
              ? 503
              : code === 'automation_backpressure' || code === 'session_limit'
                ? 429
                : code === 'invalid_operation'
                  ? 422
                  : 409
      return c.json({ error: { code, message: code } }, status)
    }
    if (error instanceof BrowserAutomationMailboxError) {
      const status =
        error.code === 'provider_unavailable'
          ? 503
          : error.code === 'automation_backpressure'
            ? 429
            : error.code === 'invalid_operation'
              ? 422
              : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof ConfigurationQualificationError) {
      const status =
        error.code === 'revision_conflict'
          ? 409
          : error.code === 'runtime_unavailable' || error.code === 'config_unavailable'
            ? 503
            : error.code === 'consistency_failure' || error.code === 'runtime_failure'
              ? 500
              : 422
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof VaultSearchError) {
      const status =
        error.code === 'unauthorized'
          ? 403
          : error.code === 'resource_limit'
            ? 422
            : error.code === 'runtime_unavailable'
              ? 503
              : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof FilesServiceError) {
      const status =
        error.code === 'invalid_params'
          ? 400
          : error.code === 'unauthorized'
            ? 403
            : error.code === 'resource_limit'
              ? 422
              : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof RecentlyClosedError) {
      const status =
        error.code === 'source_not_found' || error.code === 'target_not_found'
          ? 404
          : error.code === 'unauthorized' || error.code === 'policy_denied'
            ? 403
            : error.code === 'runtime_unavailable'
              ? 503
              : error.code === 'resource_limit'
                ? 422
                : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (
      error instanceof StateStoreError ||
      error instanceof WindowStateStoreError ||
      error instanceof WorkspaceMutationError ||
      error instanceof WindowMutationError ||
      error instanceof BrowserMutationError ||
      error instanceof RemoteCatalogError
    ) {
      const status =
        error.code === 'workspace_not_found' ||
        error.code === 'source_not_found' ||
        error.code === 'layout_not_found' ||
        error.code === 'target_not_found' ||
        error.code === 'session_not_found' ||
        error.code === 'browser_session_not_found'
          ? 404
          : error.code === 'unauthorized_layout_path'
            ? 403
            : error.code === 'resource_limit'
              ? 422
              : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof AgentCatalogError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.code === 'session_unavailable' ? 404 : 500
      )
    }
    if (error instanceof AgentMutationError) {
      const status =
        error.code === 'invalid_params'
          ? 400
          : error.code === 'session_unavailable'
            ? 404
            : error.code === 'runtime_unavailable' || error.code === 'provider_unavailable'
              ? 503
              : error.code === 'resource_limit'
                ? 422
                : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof AgentTeamMutationError || error instanceof AgentTeamOutcomeError) {
      const status =
        error.code === 'invalid_params'
          ? 400
          : error.code === 'team_unavailable' || error.code === 'session_unavailable'
            ? 404
            : error.code === 'runtime_unavailable'
              ? 503
              : error.code === 'storage_failure'
                ? 500
                : error.code === 'resource_limit'
                  ? 422
                  : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof NotificationMutationError) {
      const status =
        error.code === 'invalid_params'
          ? 400
          : error.code === 'target_not_found'
            ? 404
            : error.code === 'unauthorized'
              ? 403
              : error.code === 'runtime_unavailable'
                ? 503
                : error.code === 'resource_limit'
                  ? 422
                  : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof CardSlotAttentionError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.code === 'invalid_params' ? 400 : error.code === 'workspace_not_found' ? 404 : 409
      )
    }
    if (error instanceof SettingsMutationError) {
      const status =
        error.code === 'invalid_params'
          ? 400
          : error.code === 'unauthorized'
            ? 403
            : error.code === 'runtime_unavailable'
              ? 503
              : error.code === 'resource_limit'
                ? 422
                : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof ActionRegistryError) {
      return c.json({ error: { code: error.code, message: error.message } }, 409)
    }
    if (error instanceof ServiceActionError) {
      const status =
        error.code === 'invalid_params' || error.code === 'invalid_parameters'
          ? 400
          : error.code === 'action_not_found' || error.code === 'target_not_found'
            ? 404
            : error.code === 'resource_limit'
              ? 422
              : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof ContentCatalogError) {
      const status = error.code === 'invalid_params' ? 400 : error.code === 'not_found' ? 404 : 500
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof ContentMutationError) {
      const status =
        error.code === 'invalid_params'
          ? 400
          : error.code === 'target_not_found'
            ? 404
            : error.code === 'unauthorized'
              ? 403
              : error.code === 'runtime_unavailable'
                ? 503
                : error.code === 'resource_limit'
                  ? 422
                  : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof TaskCatalogError) {
      const status =
        error.code === 'invalid_params'
          ? 400
          : error.code === 'unauthorized'
            ? 403
            : error.code === 'resource_limit'
              ? 422
              : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof TaskActionError) {
      const status =
        error.code === 'invalid_params'
          ? 400
          : error.code === 'unauthorized'
            ? 403
            : error.code === 'provider_unavailable'
              ? 503
              : error.code === 'resource_limit'
                ? 422
                : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof RemoteActivationError) {
      const status =
        error.code === 'credential_provider_unavailable' || error.code === 'transport_unavailable'
          ? 503
          : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof RemoteCredentialEnrollmentError) {
      const status =
        error.code === 'invalid_target'
          ? 400
          : error.code === 'storage_unavailable' || error.code === 'cleanup_required'
            ? 503
            : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof LegacyDatabaseError) {
      const status = error.code === 'database_unavailable' ? 503 : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (
      error instanceof HostKeyAuthorityError ||
      error instanceof HostKeyScanError ||
      error instanceof KnownHostsError
    ) {
      const status = error.code === 'scan_unavailable' ? 503 : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (
      error instanceof RemoteTransportError ||
      error instanceof CredentialError ||
      error instanceof SshLaunchError ||
      error instanceof TmuxProtocolError
    ) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.code === 'credential_provider_unavailable' || error.code === 'transport_unavailable'
          ? 503
          : 409
      )
    }
    if (error instanceof TerminalServiceError) {
      const status =
        error.code === 'terminal_not_found'
          ? 404
          : [
                'invalid_params',
                'invalid_input',
                'invalid_working_directory',
                'invalid_command'
              ].includes(error.code)
            ? 400
            : 409
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    if (error instanceof HTTPException) {
      return c.json({ error: { code: 'invalid_request', message: error.message } }, error.status)
    }
    serviceLogger.emit('error', 'requestFailed')
    return c.json({ error: { code: 'internal_error', message: 'Request failed' } }, 500)
  })

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization')
    const supplied = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!equalToken(supplied, token)) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    await next()
    if (!c.req.path.startsWith('/v1/diagnostics/')) {
      serviceLogger.emit('trace', 'requestHandled')
    }
  })
  app.use('/v1/*', bodyLimit({ maxSize: MAX_BODY_BYTES }))

  if (browserAutomation) {
    if (browserAutomation.runtime) {
      const runtime = browserAutomation.runtime
      app.post('/v1/browser-automation/sessions', async (c) => {
        const params = await parseBody(c.req.json(), browserAutomationSessionCreateParamsSchema)
        return c.json(
          browserAutomationSessionCreateResultSchema.parse({
            session: await runtime.createSession(params as BrowserAutomationSessionCreateParams)
          })
        )
      })
      app.get('/v1/browser-automation/sessions', (c) =>
        c.json(browserAutomationSessionListResultSchema.parse({ sessions: runtime.listSessions() }))
      )
      app.post('/v1/browser-automation/sessions/get', async (c) => {
        const params = await parseBody(c.req.json(), browserAutomationSessionParamsSchema)
        return c.json(
          browserAutomationSessionResultSchema.parse({ session: runtime.getSession(params) })
        )
      })
      app.post('/v1/browser-automation/operations', async (c) => {
        const params = await parseBody(c.req.json(), browserAutomationOperationInvokeParamsSchema)
        return c.json(
          browserAutomationOperationInvokeResultSchema.parse({
            operation: await runtime.invoke(params)
          })
        )
      })
      app.post('/v1/browser-automation/operations/cancel', async (c) => {
        const params = await parseBody(c.req.json(), browserAutomationOperationCancelParamsSchema)
        return c.json(
          browserAutomationOperationInvokeResultSchema.parse({
            operation: runtime.cancelOperation(params)
          })
        )
      })
      app.post('/v1/browser-automation/screenshots/read', async (c) => {
        const params = await parseBody(c.req.json(), browserAutomationScreenshotReadParamsSchema)
        return c.json(
          browserAutomationScreenshotReadResultSchema.parse(
            await runtime.readScreenshot(params, c.req.raw.signal)
          )
        )
      })
      app.post('/v1/browser-automation/screenshots/release', async (c) => {
        const params = await parseBody(c.req.json(), browserAutomationScreenshotReleaseParamsSchema)
        return c.json(
          browserAutomationScreenshotReleaseResultSchema.parse(
            await runtime.releaseScreenshot(params, c.req.raw.signal)
          )
        )
      })
      app.post('/v1/browser-automation/sessions/destroy', async (c) => {
        const params = await parseBody(c.req.json(), browserAutomationSessionParamsSchema)
        return c.json(
          browserAutomationSessionResultSchema.parse({
            session: await runtime.destroySession(params)
          })
        )
      })
    }
    app.post('/v1/browser-automation/provider/poll', async (c) => {
      const params = await parseBody(c.req.json(), browserAutomationProviderPollParamsSchema)
      return c.json(
        browserAutomationProviderPollResultSchema.parse(
          await browserAutomation.authority.mailbox.poll(params)
        )
      )
    })
    app.post('/v1/browser-automation/provider/acknowledge', async (c) => {
      const params = await parseBody(c.req.json(), browserAutomationProviderAcknowledgeParamsSchema)
      return c.json(
        browserAutomationProviderAcknowledgeResultSchema.parse({
          operation: browserAutomation.records.acknowledge(
            params as BrowserAutomationProviderAcknowledgeParams
          )
        })
      )
    })
    app.post('/v1/browser-automation/provider/transfer-respond', async (c) => {
      const params = await parseBody(
        c.req.json(),
        browserAutomationProviderTransferRespondParamsSchema
      )
      browserAutomation.authority.mailbox.respondTransfer(params)
      return c.json({})
    })
  }

  app.get('/v1/system/identify', (c) =>
    c.json({
      application: 'agent-workspace',
      apiVersion: 1,
      ...(stateStore ? { idempotencyEpoch: stateStore.currentIdempotencyEpoch() } : {}),
      ...(agentRegistration?.qualifiedProviderVersion?.()
        ? {
            agentProvider: {
              adapterId: 'codex',
              adapterVersion: agentRegistration.qualifiedProviderVersion()
            }
          }
        : {}),
      capabilities: [
        ...(browserAutomation?.runtime ? ['browser-automation-v1'] : []),
        ...(stateReader || stateStore ? ['state.snapshot'] : []),
        ...(stateStore && windowBindings
          ? ['window.list', 'window.create', 'window.close', 'window.focus']
          : []),
        ...(stateStore && windowBindings && workspaceRuntime
          ? ['tab.duplicateExact', 'tab.moveExact', 'tab.detachExact', 'focusHistory.navigate']
          : []),
        ...(stateReader || stateStore ? ['workspace.list'] : []),
        ...(stateReader || stateStore ? ['workspace.organization.get'] : []),
        ...(stateReader || stateStore ? ['settings.get'] : []),
        ...(settingsMutations ? ['settings.update', 'settings.resetKey'] : []),
        ...(notificationMutations
          ? [
              'notification.list',
              'notification.publish',
              'notification.markRead',
              'notification.markUnread',
              'notification.clear'
            ]
          : []),
        ...(cardSlotAttention
          ? [
              'workspace.cardSlots.get',
              'workspace.cardSlots.replace',
              'workspace.cardSlots.events',
              'workspace.cardSlots.v2.get',
              'workspace.cardSlots.v2.replace',
              'workspace.cardSlots.v2.events',
              'workspace.attention.get',
              'workspace.attention.events',
              ...(notificationMutations ? ['attention.acknowledge', 'attention-v1'] : [])
            ]
          : []),
        ...(stateReader || stateStore ? ['layout.list', 'layout.get', 'layout.export'] : []),
        ...(contentCatalog
          ? ['sidebar.placement.list', 'sidebar.placement.get', 'textbox.list', 'textbox.get']
          : []),
        ...(filesService
          ? [
              'content.root.list',
              'content.directory.list',
              'content.document.issue',
              'content.read',
              'content.save',
              'content.markdown',
              'content.diff'
            ]
          : []),
        ...(vaultSearch instanceof EncryptedVaultSearch ? ['search.encrypted-v1'] : []),
        ...(vaultSearch
          ? [
              'search.query',
              'search.cancel',
              'search.source.policy',
              'search.source.exclude',
              'search.source.forget',
              'search.source.rebuild',
              'search.source.export.confirmation.issue',
              'search.source.export'
            ]
          : []),
        ...(contentMutations
          ? ['sidebar.placement.save', 'textbox.create', 'textbox.save', 'textbox.delete']
          : []),
        ...(taskCatalog && windowBindings ? ['task.list'] : []),
        ...(taskActions ? ['task.confirmation.issue', 'task.action'] : []),
        ...(recentlyClosed && windowBindings
          ? ['recentlyClosed.list', 'recentlyClosed.reopen']
          : []),
        ...(agentTeamMutations
          ? [
              'agent.attention.set',
              'agent.team.create',
              'agent.team.update',
              'agent.team.delete',
              'agent.team.member.create',
              'agent.team.member.update',
              'agent.team.member.move',
              'agent.team.member.delete'
            ]
          : []),
        ...(agentRegistration ? ['agent.restore.assess'] : []),
        ...(agentRegistration?.providerProfileQualified()
          ? ['agent.catalog.register', 'agent.session.restore']
          : []),
        ...(agentRegistration?.forkAvailable() ? ['agent.session.fork'] : []),
        ...(agentRegistration?.hibernationAvailable()
          ? ['agent.hibernate.preflight', 'agent.hibernate.cancel', 'agent.hibernate.confirm']
          : []),
        ...(stateStore ? ['workspace.select'] : []),
        ...(stateStore && windowBindings ? ['windowState.getFor', 'windowState.updateFor'] : []),
        ...(configurationQualification ? ['configuration.qualify'] : []),
        ...(configurationQualification?.writable
          ? ['configuration.get', 'configuration.update']
          : []),
        ...(diagnosticLogDirectory ? ['diagnostics.preview', 'diagnostics.export'] : []),
        ...(stateStore
          ? [
              'remote.target.list',
              'remote.target.get',
              'remote.target.create',
              ...(remoteTargetDeletion ? ['remote.target.delete'] : []),
              ...(remoteCredentialEnrollment ? ['remote.target.enroll'] : []),
              ...(replacementService?.supportsReplacement
                ? [
                    remoteCredentialV1Replacement
                      ? 'remote.target.replaceCredential.v1'
                      : 'remote.target.replaceCredential'
                  ]
                : []),
              'remote.session.list',
              'remote.session.get',
              'remote.session.detach',
              'remote.session.close',
              'agent.catalog.list',
              'agent.catalog.get',
              'action.list',
              'action.invoke',
              'action.cancel',
              ...(remoteHostKeys
                ? ['remote.session.prepare', 'remote.hostKey.scan', 'remote.hostKey.decide']
                : []),
              ...(remoteTmux ? ['remote.tmux.discover'] : []),
              ...(remoteActivation ? ['remote.session.activate', 'remote.session.terminal'] : [])
            ]
          : []),
        ...(stateStore ? ['workspace.move', 'workspace.update'] : []),
        ...(stateStore
          ? [
              'workspace.pin',
              'workspace.selectMany',
              'workspace.reorder',
              ...(workspaceRuntime ? ['workspace.closeSelected'] : []),
              ...(workspaceRuntime ? ['layout.apply'] : []),
              'group.create',
              'group.rename',
              'group.delete',
              'group.move',
              'group.assign',
              'group.collapse',
              'layout.save',
              'layout.delete',
              'layout.import'
            ]
          : []),
        ...(stateStore
          ? [
              'tab.select',
              'tab.move',
              'tab.update',
              'tab.openBrowser',
              'browser.navigate',
              'browser.back',
              'browser.forward',
              'browser.reload',
              'browser.stop',
              'browser.openDevTools',
              'browser.observe'
            ]
          : []),
        ...(recentlyClosed ? ['closed.list', 'closed.get', 'tab.reopen'] : []),
        ...(stateStore ? ['pane.focus', 'pane.resize'] : []),
        ...(workspaceRuntime
          ? [
              'workspace.create',
              'workspace.close',
              'tab.openTerminal',
              'tab.close',
              'pane.split',
              'pane.close',
              'terminal.restart'
            ]
          : []),
        'terminal.create',
        'terminal.attach',
        'terminal.runtimeMetadata',
        'terminal.events',
        'terminal.send',
        'terminal.resize',
        'terminal.checkpoint',
        'terminal.close'
      ]
    })
  )

  const stateSource = stateStore ?? stateReader
  if (configurationQualification) {
    app.get('/v1/configuration/qualification', async (c) =>
      c.json(await configurationQualification.inspect())
    )
    if (configurationQualification.writable) {
      app.get('/v1/configuration', async (c) =>
        c.json(configurationGetResultSchema.parse(await configurationQualification.get()))
      )
      app.post('/v1/configuration/update', async (c) => {
        const request = await parseBody(c.req.json(), configurationUpdateParamsSchema)
        return c.json(
          configurationGetResultSchema.parse(await configurationQualification.update(request))
        )
      })
    }
  }
  if (diagnosticLogDirectory && configurationQualification) {
    let pendingDiagnostics: DiagnosticService | undefined
    app.get('/v1/diagnostics/preview', async (c) => {
      const { config } = await configurationQualification.inspect()
      const diagnostics = new DiagnosticService({
        logDirectory: diagnosticLogDirectory,
        application: 'agent-workspace',
        version: '0.1.0',
        platform: process.platform,
        recovery: 'healthy',
        configurationSummary: createSafeConfigurationSummary(config)
      })
      pendingDiagnostics = diagnostics
      return c.json(diagnosticBundlePreviewSchema.parse(diagnostics.preview()))
    })
    app.post('/v1/diagnostics/export', async (c) => {
      const request = await parseBody(c.req.json(), diagnosticExportRequestSchema)
      const diagnostics = pendingDiagnostics
      pendingDiagnostics = undefined
      if (!diagnostics) throw new HTTPException(409, { message: 'Diagnostic preview required' })
      try {
        return c.json(
          diagnosticExportResultSchema.parse(
            diagnostics.export(request.destination, request.approvedPreview)
          )
        )
      } catch {
        throw new HTTPException(409, { message: 'Diagnostic export failed or preview changed' })
      }
    })
  }
  if (cardSlotAttention) {
    app.get('/v1/workspaces/:workspaceId/card-slots', (c) => {
      const params = parseRoute(
        { workspaceId: c.req.param('workspaceId') },
        workspaceCardSlotsSnapshotParamsSchema
      )
      return c.json(workspaceCardSlotsSnapshotSchema.parse(cardSlotAttention.getSlots(params)))
    })
    app.post('/v1/workspaces/card-slots/replace', async (c) => {
      const request = await parseBody(c.req.json(), workspaceCardSlotsReplaceParamsSchema)
      return c.json(workspaceCardSlotsSnapshotSchema.parse(cardSlotAttention.replaceSlots(request)))
    })
    app.get('/v1/workspaces/:workspaceId/card-slots/v2/:kind', (c) => {
      const params = parseRoute(
        { workspaceId: c.req.param('workspaceId'), kind: c.req.param('kind') },
        workspaceCardSlotV2GetParamsSchema
      )
      return c.json(workspaceCardSlotV2SnapshotSchema.parse(cardSlotAttention.getSlotV2(params)))
    })
    app.post('/v1/workspaces/card-slots/v2/replace', async (c) => {
      const request = await parseBody(c.req.json(), workspaceCardSlotV2ReplaceParamsSchema)
      return c.json(
        workspaceCardSlotV2SnapshotSchema.parse(cardSlotAttention.replaceSlotV2(request))
      )
    })
    app.get('/v1/workspaces/:workspaceId/attention', (c) => {
      const params = parseRoute(
        { workspaceId: c.req.param('workspaceId') },
        workspaceAttentionSnapshotParamsSchema
      )
      return c.json(workspaceAttentionSnapshotSchema.parse(cardSlotAttention.getAttention(params)))
    })
    if (notificationMutations) {
      app.post('/v1/attention/acknowledge', async (c) => {
        const request = await parseBody(c.req.json(), attentionAcknowledgementParamsSchema)
        return c.json(
          attentionAcknowledgementResultSchema.parse(
            notificationMutations.acknowledgeAttention(request, cardSlotAttention)
          )
        )
      })
    }
  }
  if (stateSource) {
    app.get('/v1/state/snapshot', (c) => c.json({ snapshot: stateSource.readSnapshot() }))
    app.get('/v1/workspaces', (c) =>
      c.json({
        snapshot: projectApplicationSnapshot(
          stateSource.readSnapshot(),
          workspaceRuntime ? (tabId) => workspaceRuntime.sessionForTab(tabId) : undefined
        )
      })
    )
    app.get('/v1/organization', (c) => c.json(projectOrganization(stateSource.readSnapshot())))
    app.get('/v1/settings', (c) =>
      c.json(settingsGetResultSchema.parse(projectSettings(stateSource.readSnapshot())))
    )
    app.get('/v1/layouts', (c) => c.json(listLayouts(stateSource.readSnapshot())))
    app.get('/v1/layouts/:layoutId', (c) =>
      c.json(getLayout(stateSource.readSnapshot(), parseLayoutId(c.req.param('layoutId'))))
    )
    app.get('/v1/layouts/:layoutId/export', (c) =>
      c.json(exportLayout(stateSource.readSnapshot(), parseLayoutId(c.req.param('layoutId'))))
    )
  }
  if (stateStore) {
    // Application-level topology read; mutations below require a private binding.
    app.get('/v1/windows', (c) =>
      c.json(projectWindowList(stateStore.readSnapshot(), stateStore.currentIdempotencyEpoch()))
    )
    if (windowBindings) {
      const boundWindow = (capability: string | undefined) =>
        capability ? windowBindings.resolve(capability) : undefined
      const projectedWindowState = (capability: string | undefined) => {
        const binding = boundWindow(capability)
        if (!binding || !binding.isCurrent()) return undefined
        return projectStateToWindow(stateStore.readSnapshot(), binding.windowId)
      }
      app.get('/v1/workspaces/bound', (c) => {
        const state = projectedWindowState(c.req.header('x-agent-workspace-window-capability'))
        if (!state) return c.json({ error: { code: 'placement_required' } }, 403)
        return c.json({
          snapshot: projectApplicationSnapshot(
            state,
            workspaceRuntime ? (tabId) => workspaceRuntime.sessionForTab(tabId) : undefined
          )
        })
      })
      app.get('/v1/organization/bound', (c) => {
        const state = projectedWindowState(c.req.header('x-agent-workspace-window-capability'))
        if (!state) return c.json({ error: { code: 'placement_required' } }, 403)
        return c.json(projectOrganization(state))
      })
      app.post('/v1/windows/create', async (c) => {
        const request = await parseBody(c.req.json(), windowCreateParamsSchema)
        const binding = boundWindow(c.req.header('x-agent-workspace-window-capability'))
        if (!binding || binding.windowId !== request.sourceWindow.windowId || !binding.isCurrent())
          return c.json({ error: { code: 'placement_required' } }, 403)
        return c.json(windowMutationResultSchema.parse(stateStore.createWindow(request)))
      })
      app.post('/v1/windows/focus', async (c) => {
        const request = await parseBody(c.req.json(), windowFocusParamsSchema)
        const binding = boundWindow(c.req.header('x-agent-workspace-window-capability'))
        if (!binding || !binding.isCurrent())
          return c.json({ error: { code: 'placement_required' } }, 403)
        return c.json(windowMutationResultSchema.parse(stateStore.focusWindow(request)))
      })
      app.post('/v1/windows/close', async (c) => {
        const request = await parseBody(c.req.json(), windowCloseParamsSchema)
        const binding = boundWindow(c.req.header('x-agent-workspace-window-capability'))
        if (!binding || binding.windowId !== request.window.windowId || !binding.isCurrent())
          return c.json({ error: { code: 'placement_required' } }, 403)
        const result =
          request.policy === 'closeWorkspaces'
            ? await workspaceRuntime?.closeWindowWorkspaces(
                stateStore,
                request as WindowCloseParams
              )
            : stateStore.closeWindow(request as WindowCloseParams)
        if (!result) return c.json({ error: { code: 'capability_unavailable' } }, 503)
        return c.json(windowCloseResultSchema.parse(result))
      })
      app.get('/v1/windows/bound', (c) => {
        const capability = c.req.header('x-agent-workspace-window-capability')
        const binding = capability ? windowBindings.resolve(capability) : undefined
        if (!binding) return c.json({ error: { code: 'placement_required' } }, 403)
        const topology = projectWindowList(
          stateStore.readSnapshot(),
          stateStore.currentIdempotencyEpoch()
        )
        const window = topology.windows.find(({ windowId }) => windowId === binding.windowId)
        if (!window || !binding.isCurrent())
          return c.json({ error: { code: 'placement_required' } }, 403)
        return c.json(windowBindResultSchema.parse({ window }))
      })
      app.post('/v1/windows/state/get', async (c) => {
        const request = await parseBody(c.req.json(), windowStateGetForParamsSchema)
        const binding = boundWindow(c.req.header('x-agent-workspace-window-capability'))
        if (!binding || binding.windowId !== request.windowId || !binding.isCurrent())
          return c.json({ error: { code: 'placement_required' } }, 403)
        return c.json(
          windowStateGetForResultSchema.parse(stateStore.getWindowStateFor(request.windowId))
        )
      })
      app.post('/v1/windows/state/update', async (c) => {
        const request = await parseBody(c.req.json(), windowStateUpdateForParamsSchema)
        const binding = boundWindow(c.req.header('x-agent-workspace-window-capability'))
        if (!binding || binding.windowId !== request.windowId || !binding.isCurrent())
          return c.json({ error: { code: 'placement_required' } }, 403)
        return c.json(
          windowStateGetForResultSchema.parse(
            stateStore.updateWindowStateFor(request.windowId, request.state)
          )
        )
      })
    }
  }
  if (settingsMutations) {
    app.post('/v1/settings/update', async (c) => {
      const request = await parseBody(c.req.json(), settingsWriteRequestSchema)
      return c.json(
        settingsMutationResultSchema.parse(
          settingsMutations.update({
            windowId: request.windowId,
            mutation: request.mutation,
            update: {
              ...(request.update.shortcutOverrides === undefined
                ? {}
                : { shortcutOverrides: request.update.shortcutOverrides }),
              ...(request.update.notifications === undefined
                ? {}
                : { notifications: request.update.notifications })
            }
          })
        )
      )
    })
    app.post('/v1/settings/reset-key', async (c) => {
      const request = await parseBody(c.req.json(), settingsResetRequestSchema)
      return c.json(settingsMutationResultSchema.parse(settingsMutations.resetKey(request)))
    })
  }
  if (notificationMutations) {
    app.get('/v1/notifications', (c) => {
      const parsed = notificationPageRequestSchema.safeParse({
        windowId: c.req.query('windowId'),
        ...(c.req.query('workspaceId') === undefined
          ? {}
          : { workspaceId: c.req.query('workspaceId') }),
        ...(c.req.query('unreadOnly') === undefined
          ? {}
          : { unreadOnly: c.req.query('unreadOnly') === 'true' }),
        ...(c.req.query('offset') === undefined ? {} : { offset: Number(c.req.query('offset')) }),
        ...(c.req.query('limit') === undefined ? {} : { limit: Number(c.req.query('limit')) })
      })
      if (
        !parsed.success ||
        (c.req.query('unreadOnly') !== undefined &&
          !['true', 'false'].includes(c.req.query('unreadOnly')!))
      ) {
        throw new TerminalServiceError('invalid_params', 'Notification page is invalid')
      }
      const { windowId, workspaceId, unreadOnly, offset, limit } = parsed.data
      return c.json(
        notificationListResultSchema.parse(
          notificationMutations.list({
            windowId,
            ...(workspaceId === undefined ? {} : { workspaceId }),
            unreadOnly,
            offset,
            limit
          })
        )
      )
    })
    app.post('/v1/notifications/mark-read', async (c) => {
      const request = await parseBody(c.req.json(), notificationWriteRequestSchema)
      return c.json(notificationChangeResultSchema.parse(notificationMutations.markRead(request)))
    })
    app.post('/v1/notifications/publish', async (c) => {
      const request = await parseBody(c.req.json(), notificationPublishRequestSchema)
      return c.json(
        notificationChangeResultSchema.parse(
          notificationMutations.publish({
            windowId: request.windowId,
            target: {
              workspaceId: request.target.workspaceId,
              ...(request.target.paneId === undefined ? {} : { paneId: request.target.paneId }),
              ...(request.target.tabId === undefined ? {} : { tabId: request.target.tabId })
            },
            source: request.source,
            level: request.level,
            title: request.title,
            ...(request.body === undefined ? {} : { body: request.body }),
            mutation: request.mutation
          })
        )
      )
    })
    app.post('/v1/notifications/mark-unread', async (c) => {
      const request = await parseBody(c.req.json(), notificationWriteRequestSchema)
      return c.json(notificationChangeResultSchema.parse(notificationMutations.markUnread(request)))
    })
    app.post('/v1/notifications/clear', async (c) => {
      const request = await parseBody(c.req.json(), notificationClearRequestSchema)
      return c.json(notificationChangeResultSchema.parse(notificationMutations.clear(request)))
    })
  }
  if (filesService) {
    app.get('/v1/content/roots', (c) => {
      const parsed = boundedListParamsSchema.safeParse({
        limit: Number(c.req.query('limit')),
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {})
      })
      if (!parsed.success) throw new TerminalServiceError('invalid_params', 'Root page is invalid')
      const params = parsed.data
      return c.json(
        workspaceRootListResultSchema.parse(
          filesService.listRoots({
            limit: params.limit,
            ...(params.cursor ? { cursor: params.cursor } : {})
          })
        )
      )
    })
    app.post('/v1/content/directories/list', async (c) => {
      const params = await parseBody(c.req.json(), workspaceDirectoryListParamsSchema)
      return c.json(
        workspaceDirectoryListResultSchema.parse(
          filesService.listDirectory({
            ...params,
            ...(params.cursor ? { cursor: params.cursor } : {})
          })
        )
      )
    })
    app.post('/v1/content/documents/issue', async (c) => {
      const params = await parseBody(c.req.json(), contentDocumentIssueParamsSchema)
      return c.json(contentDocumentIssueResultSchema.parse(filesService.issueDocument(params)))
    })
    app.post('/v1/content/read', async (c) => {
      const params = await parseBody(c.req.json(), contentReadParamsSchema)
      return c.json(contentPreviewSchema.parse(filesService.read(params)))
    })
    app.post('/v1/content/save', async (c) => {
      const params = await parseBody(c.req.json(), contentSaveParamsSchema)
      return c.json(contentSaveResultSchema.parse(filesService.save(params)))
    })
    app.post('/v1/content/markdown', async (c) => {
      const params = await parseBody(c.req.json(), contentMarkdownParamsSchema)
      return c.json(safeMarkdownDocumentSchema.parse(filesService.markdown(params)))
    })
    app.post('/v1/content/diff', async (c) => {
      const params = await parseBody(c.req.json(), contentDiffParamsSchema)
      return c.json(contentDiffResultSchema.parse(filesService.diff(params)))
    })
  }

  if (vaultSearch) {
    app.post('/v1/search/query', async (c) =>
      c.json(
        searchQueryResultSchema.parse(
          await vaultSearch.query(await parseBody(c.req.json(), searchQueryParamsSchema))
        )
      )
    )
    app.post('/v1/search/cancel', async (c) =>
      c.json(
        searchCancelResultSchema.parse(
          vaultSearch.cancel(await parseBody(c.req.json(), searchCancelParamsSchema))
        )
      )
    )
    app.post('/v1/search/sources/policy', async (c) =>
      c.json(
        searchControlResultSchema.parse(
          vaultSearch.policy(await parseBody(c.req.json(), searchSourcePolicyParamsSchema))
        )
      )
    )
    app.post('/v1/search/sources/exclude', async (c) =>
      c.json(
        searchControlResultSchema.parse(
          vaultSearch.exclude(await parseBody(c.req.json(), searchSourceMutationParamsSchema))
        )
      )
    )
    app.post('/v1/search/sources/forget', async (c) =>
      c.json(
        searchControlResultSchema.parse(
          vaultSearch.forget(await parseBody(c.req.json(), searchSourceMutationParamsSchema))
        )
      )
    )
    app.post('/v1/search/sources/rebuild', async (c) =>
      c.json(
        searchControlResultSchema.parse(
          await vaultSearch.rebuild(await parseBody(c.req.json(), searchRebuildParamsSchema))
        )
      )
    )
    app.post('/v1/search/sources/export/confirmation', async (c) =>
      c.json(
        searchExportConfirmationIssueResultSchema.parse(
          vaultSearch.issueExport(
            await parseBody(c.req.json(), searchExportConfirmationIssueParamsSchema)
          )
        )
      )
    )
    app.post('/v1/search/sources/export', async (c) =>
      c.json(
        searchExportResultSchema.parse(
          vaultSearch.export(await parseBody(c.req.json(), searchExportParamsSchema))
        )
      )
    )
  }

  if (contentCatalog) {
    app.get('/v1/sidebar/placements', (c) =>
      c.json(sidebarListResultSchema.parse(contentCatalog.listSidebarPlacements()))
    )
    app.get('/v1/sidebar/placements/:windowId', (c) => {
      const parsed = sidebarGetParamsSchema.safeParse({ windowId: c.req.param('windowId') })
      if (!parsed.success) throw new TerminalServiceError('invalid_params', 'Window ID is invalid')
      return c.json(
        sidebarPlacementSchema.parse(contentCatalog.getSidebarPlacement(parsed.data.windowId))
      )
    })
    app.get('/v1/text-boxes', (c) => {
      const parsed = boundedListParamsSchema.safeParse({
        limit: Number(c.req.query('limit')),
        ...(c.req.query('cursor') === undefined ? {} : { cursor: c.req.query('cursor') })
      })
      if (!parsed.success)
        throw new TerminalServiceError('invalid_params', 'TextBox page is invalid')
      return c.json(
        textBoxListResultSchema.parse(
          contentCatalog.listTextBoxes({
            limit: parsed.data.limit,
            ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor })
          })
        )
      )
    })
    app.get('/v1/text-boxes/:textBoxDocumentId', (c) => {
      const parsed = textBoxIdParamsSchema.safeParse({
        textBoxDocumentId: c.req.param('textBoxDocumentId')
      })
      if (!parsed.success) throw new TerminalServiceError('invalid_params', 'TextBox ID is invalid')
      return c.json(
        textBoxDocumentSchema.parse(contentCatalog.getTextBox(parsed.data.textBoxDocumentId))
      )
    })
  }
  if (contentMutations) {
    app.post('/v1/sidebar/placements/save', async (c) => {
      const request = await parseBody(c.req.json(), sidebarSaveParamsSchema)
      return c.json(sidebarPlacementSchema.parse(contentMutations.saveSidebarPlacement(request)))
    })
    app.post('/v1/text-boxes/create', async (c) => {
      const request = await parseBody(c.req.json(), textBoxCreateParamsSchema)
      return c.json(textBoxDocumentSchema.parse(contentMutations.createTextBox(request)))
    })
    app.post('/v1/text-boxes/save', async (c) => {
      const request = await parseBody(c.req.json(), textBoxSaveParamsSchema)
      return c.json(textBoxDocumentSchema.parse(contentMutations.saveTextBox(request)))
    })
    app.post('/v1/text-boxes/delete', async (c) => {
      const request = await parseBody(c.req.json(), textBoxDeleteParamsSchema)
      return c.json(textBoxDocumentSchema.parse(contentMutations.deleteTextBox(request)))
    })
  }
  if (agentTeamMutations && stateStore) {
    app.post('/v1/agent-attention/set', async (c) => {
      const request = await parseBody(c.req.json(), agentAttentionSetParamsSchema)
      return c.json(
        agentAttentionSetResultSchema.parse(
          await stateStore.exclusive(() => agentTeamMutations.setAttentionWithOperation(request))
        )
      )
    })
    const catalog = () =>
      agentCatalogListResultSchema.parse(stateStore.listAgentCatalog({ catalogVersion: 1 }))
    const teamResult = (team: TeamRecord) =>
      agentTeamMutationResultSchema.parse({
        team: {
          ...team,
          members: catalog().teams.find((item) => item.teamId === team.teamId)?.members ?? []
        }
      })
    const memberResult = (member: MemberRecord) =>
      agentTeamMemberMutationResultSchema.parse({
        member: {
          memberId: member.memberId,
          role: member.role,
          target: member.target,
          ...(member.parentMemberId === undefined ? {} : { parentMemberId: member.parentMemberId }),
          revision: member.revision
        }
      })
    app.post('/v1/agent-teams/create', async (c) => {
      const request = await parseBody(c.req.json(), agentTeamCreateParamsSchema)
      return c.json(teamResult(appliedTeamMutation(agentTeamMutations.createTeam(request))))
    })
    app.post('/v1/agent-teams/update', async (c) => {
      const request = await parseBody(c.req.json(), agentTeamUpdateParamsSchema)
      return c.json(teamResult(appliedTeamMutation(agentTeamMutations.updateTeam(request))))
    })
    app.post('/v1/agent-teams/delete', async (c) => {
      const request = await parseBody(c.req.json(), agentTeamDeleteParamsSchema)
      appliedTeamMutation(agentTeamMutations.deleteTeam(request))
      return c.json(catalog())
    })
    app.post('/v1/agent-teams/members/create', async (c) => {
      const request = await parseBody(c.req.json(), agentTeamMemberCreateParamsSchema)
      return c.json(memberResult(appliedTeamMutation(agentTeamMutations.createMember(request))))
    })
    app.post('/v1/agent-teams/members/update', async (c) => {
      const request = await parseBody(c.req.json(), agentTeamMemberUpdateParamsSchema)
      return c.json(memberResult(appliedTeamMutation(agentTeamMutations.updateMember(request))))
    })
    app.post('/v1/agent-teams/members/move', async (c) => {
      const request = await parseBody(c.req.json(), agentTeamMemberMoveParamsSchema)
      return c.json(memberResult(appliedTeamMutation(agentTeamMutations.moveMember(request))))
    })
    app.post('/v1/agent-teams/members/delete', async (c) => {
      const request = await parseBody(c.req.json(), agentTeamMemberDeleteParamsSchema)
      const removed = appliedTeamMutation(agentTeamMutations.deleteMember(request))
      const team = catalog().teams.find((item) => item.teamId === removed.teamId)
      if (!team) throw new AgentTeamOutcomeError('team_unavailable', 'The team is unavailable')
      return c.json(agentTeamMutationResultSchema.parse({ team }))
    })
  }
  if (stateStore) {
    if (recentlyClosed) {
      if (windowBindings) {
        app.post('/v1/sidebar/recently-closed/list', async (c) => {
          const capability = c.req.header('x-agent-workspace-window-capability')
          const binding = capability ? windowBindings.resolve(capability) : undefined
          if (!binding) throw new RecentlyClosedError('unauthorized')
          const request = await parseBody(c.req.json(), boundedListParamsSchema)
          const result = recentlyClosed.listSidebar(
            {
              limit: request.limit,
              ...(request.cursor === undefined ? {} : { cursor: request.cursor })
            },
            binding
          )
          return c.json(
            recentlyClosedListResultSchema.parse({
              records: result.records,
              nextCursor: result.nextCursor ?? null
            })
          )
        })
        app.post('/v1/sidebar/recently-closed/reopen', async (c) => {
          const capability = c.req.header('x-agent-workspace-window-capability')
          const binding = capability ? windowBindings.resolve(capability) : undefined
          if (!binding) throw new RecentlyClosedError('unauthorized')
          const request = await parseBody(c.req.json(), recentlyClosedReopenParamsSchema)
          if (request.target.windowId !== binding.windowId) {
            throw new RecentlyClosedError('unauthorized')
          }
          if (request.mutation.expectedRevision !== request.expectedRevision) {
            throw new RecentlyClosedError('stale_revision')
          }
          if (request.action !== 'reopenTerminal' && request.action !== 'reopenBrowser') {
            throw new RecentlyClosedError('policy_denied')
          }
          return c.json(
            tabReopenResultSchema.parse(
              await recentlyClosed.reopenFromSidebar(
                {
                  closedItemId: request.recentlyClosedId,
                  authorizedDescriptorId: request.authorizedDescriptorId,
                  action: request.action,
                  expectedClosedRevision: request.expectedRevision,
                  expectedRevision: request.expectedRevision,
                  idempotencyEpoch: request.idempotencyEpoch,
                  idempotencyKey: request.mutation.idempotencyKey,
                  target: request.target
                },
                binding
              )
            )
          )
        })
      }
      const boundClosed = (capability: string | undefined) => {
        const binding = capability ? windowBindings?.resolve(capability) : undefined
        if (!binding) throw new RecentlyClosedError('unauthorized')
        return { binding, service: recentlyClosed.forWindow(binding) }
      }
      app.get('/v1/closed', (c) => {
        const { service } = boundClosed(c.req.header('x-agent-workspace-window-capability'))
        return c.json(closedItemListResultSchema.parse(service.list()))
      })
      app.get('/v1/closed/:closedItemId', (c) => {
        const { service } = boundClosed(c.req.header('x-agent-workspace-window-capability'))
        const parsed = closedItemGetParamsSchema.safeParse({
          closedItemId: c.req.param('closedItemId')
        })
        if (!parsed.success) {
          throw new TerminalServiceError('invalid_params', 'Closed item ID is invalid')
        }
        return c.json(closedItemGetResultSchema.parse(service.get(parsed.data.closedItemId)))
      })
      app.post('/v1/tabs/reopen', async (c) => {
        const { binding, service } = boundClosed(
          c.req.header('x-agent-workspace-window-capability')
        )
        const request = await parseBody(c.req.json(), tabReopenRequestSchema)
        if (request.target.windowId !== binding.windowId)
          throw new RecentlyClosedError('unauthorized')
        return c.json(tabReopenResultSchema.parse(await service.reopenTab(request)))
      })
      // The CLI holds the owner-only discovery bearer and has an explicit global command path.
      // Renderer calls use the window-bound routes above and never receive this bearer.
      app.get('/v1/cli/closed', (c) =>
        c.json(closedItemListResultSchema.parse(recentlyClosed.list()))
      )
      app.get('/v1/cli/closed/:closedItemId', (c) => {
        const parsed = closedItemGetParamsSchema.safeParse({
          closedItemId: c.req.param('closedItemId')
        })
        if (!parsed.success)
          throw new TerminalServiceError('invalid_params', 'Closed item ID is invalid')
        return c.json(closedItemGetResultSchema.parse(recentlyClosed.get(parsed.data.closedItemId)))
      })
      app.post('/v1/cli/tabs/reopen', async (c) => {
        const request = await parseBody(c.req.json(), tabReopenRequestSchema)
        return c.json(tabReopenResultSchema.parse(await recentlyClosed.reopenTab(request)))
      })
    }
    app.get('/v1/actions', (c) => {
      const parsed = actionListParamsSchema.safeParse({
        limit: Number(c.req.query('limit')),
        ...(c.req.query('cursor') === undefined ? {} : { cursor: c.req.query('cursor') })
      })
      if (!parsed.success) {
        throw new TerminalServiceError('invalid_params', 'Action page is invalid')
      }
      return c.json(actionRegistry!.list(parsed.data, stateStore.currentIdempotencyEpoch()))
    })
    app.post('/v1/actions/invoke', async (c) => {
      const request = await parseBody(c.req.json(), actionInvokeParamsSchema)
      return c.json(await stateStore.exclusive(() => serviceActionInvoker!.invoke(request)))
    })
    app.post('/v1/actions/cancel', async (c) => {
      const request = await parseBody(c.req.json(), actionCancelParamsSchema)
      return serviceActionInvoker!.cancel(request)
    })
    if (taskCatalog && windowBindings) {
      app.post('/v1/tasks/list', async (c) => {
        const capability = c.req.header('x-agent-workspace-window-capability')
        const binding = capability ? windowBindings.resolve(capability) : undefined
        if (!binding) throw new TaskCatalogError('unauthorized', 'Bound window is unavailable')
        const request = await parseBody(c.req.json(), taskListParamsSchema)
        return c.json(
          taskListResultSchema.parse(taskCatalog.list(request, binding, c.req.raw.signal))
        )
      })
      if (taskActions) {
        app.post('/v1/tasks/confirmation/issue', async (c) => {
          const capability = c.req.header('x-agent-workspace-window-capability')
          const binding = capability ? windowBindings.resolve(capability) : undefined
          if (!binding) throw new TaskActionError('unauthorized', 'Bound window is unavailable')
          const request = await parseBody(c.req.json(), taskConfirmationIssueParamsSchema)
          return c.json(
            taskConfirmationIssueResultSchema.parse(taskActions.issue(request, binding))
          )
        })
        app.post('/v1/tasks/action', async (c) => {
          const capability = c.req.header('x-agent-workspace-window-capability')
          const binding = capability ? windowBindings.resolve(capability) : undefined
          if (!binding) throw new TaskActionError('unauthorized', 'Bound window is unavailable')
          const request = await parseBody(c.req.json(), taskActionParamsSchema)
          return c.json(taskActionResultSchema.parse(await taskActions.action(request, binding)))
        })
      }
    }
    app.get('/v1/agent-catalog', (c) => {
      const parsed = agentCatalogListParamsSchema.safeParse({
        catalogVersion: Number(c.req.query('catalogVersion'))
      })
      if (!parsed.success) {
        throw new TerminalServiceError('invalid_params', 'Agent catalog version is invalid')
      }
      return c.json(stateStore.listAgentCatalog(parsed.data))
    })
    app.get('/v1/agent-catalog/:sessionId', (c) => {
      const parsed = agentCatalogGetParamsSchema.safeParse({
        agentSessionId: c.req.param('sessionId')
      })
      if (!parsed.success) {
        throw new TerminalServiceError('invalid_params', 'Agent session ID is invalid')
      }
      return c.json(stateStore.getAgentSession(parsed.data.agentSessionId))
    })
    if (agentRegistration?.providerProfileQualified()) {
      app.post('/v1/agent-catalog/register', async (c) => {
        const request = await parseBody(c.req.json(), agentCatalogRegisterParamsSchema)
        return c.json(
          agentCatalogRegisterResultSchema.parse(await agentRegistration.register(request))
        )
      })
      app.post('/v1/agent-sessions/restore', async (c) => {
        const request = await parseBody(c.req.json(), agentSessionRestoreParamsSchema)
        return c.json(
          agentSessionRestoreResultSchema.parse(await agentRegistration.restore(request))
        )
      })
      app.post('/v1/agent-sessions/fork', async (c) => {
        const request = await parseBody(c.req.json(), agentSessionForkParamsSchema)
        return c.json(
          agentSessionForkResultSchema.parse(await agentRegistration.forkSession(request))
        )
      })
    }
    if (agentRegistration) {
      app.post('/v1/agent-sessions/restore/assess', async (c) => {
        const request = await parseBody(c.req.json(), agentRestoreAssessParamsSchema)
        return c.json(
          agentRestoreAssessResultSchema.parse(await agentRegistration.assessRestore(request))
        )
      })
    }
    if (agentRegistration?.hibernationAvailable()) {
      app.post('/v1/agent-sessions/hibernate/preflight', async (c) => {
        const request = await parseBody(c.req.json(), agentHibernationPreflightParamsSchema)
        return c.json(
          agentHibernationPreflightResultSchema.parse(
            await agentRegistration.hibernatePreflight(request)
          )
        )
      })
      app.post('/v1/agent-sessions/hibernate/cancel', async (c) => {
        const request = await parseBody(c.req.json(), agentHibernationCancelParamsSchema)
        return c.json(
          agentHibernationMutationResultSchema.parse(agentRegistration.hibernateCancel(request))
        )
      })
      app.post('/v1/agent-sessions/hibernate/confirm', async (c) => {
        const request = await parseBody(c.req.json(), agentHibernationConfirmParamsSchema)
        return c.json(
          agentHibernationMutationResultSchema.parse(
            await agentRegistration.hibernateConfirm(request)
          )
        )
      })
    }
    app.get('/v1/remote-targets', (c) =>
      c.json(
        stateStore.listRemoteTargets(parseRemoteList(c.req.query('limit'), c.req.query('cursor')))
      )
    )
    app.get('/v1/remote-targets/:targetId', (c) =>
      c.json(stateStore.getRemoteTarget(parseRemoteTargetId(c.req.param('targetId'))))
    )
    app.post('/v1/remote-targets', async (c) => {
      const request = await parseBody(c.req.json(), remoteTargetCreateParamsSchema)
      return c.json(
        remoteTargetResultSchema.parse(
          await stateStore.exclusive(() => stateStore.createRemoteTarget(request))
        )
      )
    })
    if (remoteTargetDeletion) {
      app.post('/v1/remote-targets/delete', async (c) => {
        const request = await parseBody(c.req.json(), remoteTargetDeleteParamsSchema)
        return c.json(remoteTargetResultSchema.parse(await remoteTargetDeletion.delete(request)))
      })
    }
    if (remoteCredentialEnrollment) {
      app.post('/v1/remote-targets/enrollment/begin', async (c) => {
        const request = await parseBody(c.req.json(), remoteTargetEnrollmentBeginSchema)
        const enrollmentId = await remoteCredentialEnrollment.beginOnlineNew(
          request.remoteTargetId,
          request.enrollmentId
        )
        return c.json(
          remoteTargetEnrollmentBeginSchema.parse({
            remoteTargetId: request.remoteTargetId,
            enrollmentId
          })
        )
      })
      app.post('/v1/remote-targets/enrollment/commit', async (c) => {
        const request = await parseBody(c.req.json(), remoteTargetEnrollmentCommitSchema)
        const result = await remoteCredentialEnrollment.commitOnlineNew(
          request.enrollmentId,
          request.target.remoteTargetId,
          () =>
            stateStore.exclusive(() =>
              stateStore.commitEnrolledRemoteTarget(request.target, request.enrollmentId)
            )
        )
        return c.json(remoteTargetResultSchema.parse(result))
      })
      app.post('/v1/remote-targets/enrollment/abort', async (c) => {
        const request = await parseBody(c.req.json(), remoteTargetEnrollmentAbortSchema)
        await remoteCredentialEnrollment.abortOnlineNew(
          request.enrollmentId,
          request.remoteTargetId
        )
        return c.json(remoteTargetEnrollmentAbortResultSchema.parse({ status: 'aborted' }))
      })
    }
    if (replacementService?.supportsReplacement) {
      app.post('/v1/remote-targets/replacement/begin', async (c) => {
        const request = await parseBody(c.req.json(), remoteCredentialReplacementSchema)
        const enrollmentId = await replacementService.beginOnlineReplacement(
          request.remoteTargetId,
          request.enrollmentId,
          request.expectedRevision,
          !!remoteCredentialV1Replacement
        )
        return c.json(remoteCredentialReplacementSchema.parse({ ...request, enrollmentId }))
      })
      app.post('/v1/remote-targets/replacement/commit', async (c) => {
        const request = await parseBody(c.req.json(), remoteCredentialReplacementSchema)
        const result = await replacementService.commitOnlineReplacement(
          request.enrollmentId,
          request.remoteTargetId,
          request.expectedRevision,
          () => stateStore.exclusive(() => stateStore.getRemoteTarget(request.remoteTargetId)),
          !!remoteCredentialV1Replacement
        )
        return c.json(remoteTargetResultSchema.parse(result))
      })
      app.post('/v1/remote-targets/replacement/abort', async (c) => {
        const request = await parseBody(c.req.json(), remoteCredentialReplacementSchema)
        await replacementService.abortOnlineReplacement(
          request.enrollmentId,
          request.remoteTargetId,
          !!remoteCredentialV1Replacement
        )
        return c.json(remoteTargetEnrollmentAbortResultSchema.parse({ status: 'aborted' }))
      })
    }
    app.get('/v1/remote-sessions', (c) =>
      c.json(
        stateStore.listRemoteSessions(parseRemoteList(c.req.query('limit'), c.req.query('cursor')))
      )
    )
    app.get('/v1/remote-sessions/:sessionId', (c) =>
      c.json(stateStore.getRemoteSession(parseRemoteSessionId(c.req.param('sessionId'))))
    )
    if (remoteActivation) {
      app.get('/v1/remote-sessions/:sessionId/terminal', (c) => {
        const sessionId = parseRemoteSessionId(c.req.param('sessionId'))
        const { session } = stateStore.getRemoteSession(sessionId)
        if (session.state !== 'connected') {
          throw new TerminalServiceError('terminal_not_found', 'Remote terminal is unavailable')
        }
        const terminalId = remoteActivation.terminalFor(sessionId)
        if (!terminalId)
          throw new TerminalServiceError('terminal_not_found', 'Remote terminal is unavailable')
        return c.json(remoteTerminalResultSchema.parse({ terminalId }))
      })
    }
    app.post('/v1/remote-sessions/detach', async (c) => {
      const request = await parseBody(c.req.json(), remoteSessionDetachParamsSchema)
      const result = await stateStore.exclusive(() => stateStore.detachRemoteSession(request))
      await remoteActivation?.terminate(
        result.session.remoteSessionId,
        result.session.attemptGeneration
      )
      return c.json(result)
    })
    app.post('/v1/remote-sessions/close', async (c) => {
      const request = await parseBody(c.req.json(), remoteSessionCloseParamsSchema)
      const result = await stateStore.exclusive(() => stateStore.closeRemoteSession(request))
      await remoteActivation?.terminate(
        result.session.remoteSessionId,
        result.session.attemptGeneration
      )
      return c.json(result)
    })
    if (remoteActivation) {
      app.post('/v1/remote-sessions/activate', async (c) => {
        const request = await parseBody(c.req.json(), remoteSessionReconnectParamsSchema)
        return c.json(await remoteActivation.activate(request))
      })
    }
    if (hostKeyAuthority && remoteHostKeys) {
      app.post('/v1/remote-sessions/prepare', async (c) => {
        const request = await parseBody(c.req.json(), remoteSessionConnectParamsSchema)
        return c.json(await remoteHostKeys.prepare(request), 202)
      })
      app.post('/v1/remote-sessions/scan-host-key', async (c) => {
        const request = await parseBody(c.req.json(), remoteHostKeyScanParamsSchema)
        return c.json(await remoteHostKeys.scan(request))
      })
      app.post('/v1/remote-sessions/decide-host-key', async (c) => {
        const request = await parseBody(c.req.json(), remoteHostKeyTrustParamsSchema)
        return c.json(await remoteHostKeys.decide(request))
      })
    }
    if (remoteTmux) {
      app.post('/v1/remote-sessions/discover-tmux', async (c) => {
        const request = await parseBody(c.req.json(), remoteTmuxDiscoverParamsSchema)
        return c.json(await remoteTmux.discover(request))
      })
    }
    if (workspaceRuntime) {
      app.post('/v1/layouts/apply', async (c) => {
        const request = await parseBody(c.req.json(), layoutApplyRequestSchema)
        return c.json(await workspaceRuntime.applyLayout(stateStore, request))
      })
      app.post('/v1/workspaces/create', async (c) => {
        const request = await parseBody(c.req.json(), workspaceCreateRequestSchema)
        return c.json(await workspaceRuntime.createWorkspace(stateStore, request))
      })
      app.post('/v1/workspaces/close', async (c) => {
        const request = await parseBody(c.req.json(), workspaceCloseRequestSchema)
        return c.json(await workspaceRuntime.closeWorkspace(stateStore, request))
      })
      app.post('/v1/workspaces/close-selected', async (c) => {
        const request = await parseBody(c.req.json(), workspaceBatchCloseRequestSchema)
        return c.json(await workspaceRuntime.closeSelectedWorkspaces(stateStore, request))
      })
      app.post('/v1/terminals/restart', async (c) => {
        const request = await parseBody(c.req.json(), terminalRestartRequestSchema)
        return c.json(await workspaceRuntime.restartTerminal(stateStore, request))
      })
      app.post('/v1/tabs/close', async (c) => {
        const request = await parseBody(c.req.json(), tabCloseRequestSchema)
        return c.json(await workspaceRuntime.closeTab(stateStore, request))
      })
      app.post('/v1/tabs/open-terminal', async (c) => {
        const request = await parseBody(c.req.json(), tabOpenTerminalRequestSchema)
        return c.json(await workspaceRuntime.openTerminalTab(stateStore, request))
      })
      app.post('/v1/tabs/duplicate-exact', async (c) => {
        const capability = c.req.header('x-agent-workspace-window-capability')
        const binding = capability ? windowBindings?.resolve(capability) : undefined
        if (!binding?.isCurrent()) throw new RecentlyClosedError('unauthorized')
        const request = await parseBody(c.req.json(), tabDuplicateParamsSchema)
        if (request.source.windowId !== binding.windowId)
          throw new RecentlyClosedError('unauthorized')
        return c.json(
          advancedTabMutationResultSchema.parse(
            await workspaceRuntime.duplicateTabExact(stateStore, request, binding)
          )
        )
      })
      app.post('/v1/tabs/move-exact', async (c) => {
        const capability = c.req.header('x-agent-workspace-window-capability')
        const binding = capability ? windowBindings?.resolve(capability) : undefined
        if (!binding?.isCurrent()) throw new RecentlyClosedError('unauthorized')
        const request = await parseBody(c.req.json(), tabMoveExactParamsSchema)
        if (request.source.windowId !== binding.windowId)
          throw new RecentlyClosedError('unauthorized')
        return c.json(
          advancedTabMutationResultSchema.parse(
            await stateStore.exclusive(() => {
              if (!binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
              return stateStore.moveTabExact(request)
            })
          )
        )
      })
      app.post('/v1/tabs/detach', async (c) => {
        const capability = c.req.header('x-agent-workspace-window-capability')
        const binding = capability ? windowBindings?.resolve(capability) : undefined
        if (!binding?.isCurrent()) throw new RecentlyClosedError('unauthorized')
        const request = await parseBody(c.req.json(), tabDetachParamsSchema)
        if (request.source.windowId !== binding.windowId)
          throw new RecentlyClosedError('unauthorized')
        return c.json(
          advancedTabMutationResultSchema.parse(
            await stateStore.exclusive(() => {
              if (!binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
              return workspaceRuntime.detachTabExact(stateStore, request)
            })
          )
        )
      })
      app.post('/v1/focus-history/navigate', async (c) => {
        const capability = c.req.header('x-agent-workspace-window-capability')
        const binding = capability ? windowBindings?.resolve(capability) : undefined
        if (!binding) throw new RecentlyClosedError('unauthorized')
        const request = await parseBody(c.req.json(), focusHistoryNavigateParamsSchema)
        return c.json(
          focusHistoryNavigateResultSchema.parse(
            await stateStore.exclusive(() => {
              if (!binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
              if (stateStore.readSnapshot().focusedWindowId !== binding.windowId)
                throw new RecentlyClosedError('unauthorized')
              return stateStore.navigateFocusHistory(request)
            })
          )
        )
      })
    }
    app.post('/v1/workspaces/select', async (c) => {
      const request = await parseBody(c.req.json(), workspaceSelectRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.selectWorkspace(request)))
    })
    app.post('/v1/workspaces/move', async (c) => {
      const request = await parseBody(c.req.json(), workspaceMoveRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.moveWorkspace(request)))
    })
    app.post('/v1/workspaces/update', async (c) => {
      const request = await parseBody(c.req.json(), workspaceUpdateRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.updateWorkspace(request)))
    })
    app.post('/v1/workspaces/pin', async (c) => {
      const request = await parseBody(c.req.json(), workspacePinRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.pinWorkspace(request)))
    })
    app.post('/v1/workspaces/select-many', async (c) => {
      const request = await parseBody(c.req.json(), workspaceSelectionReplaceRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.selectWorkspaces(request)))
    })
    app.post('/v1/workspaces/reorder', async (c) => {
      const request = await parseBody(c.req.json(), workspaceCanonicalMoveRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.reorderWorkspace(request)))
    })
    app.post('/v1/groups/create', async (c) => {
      const request = await parseBody(c.req.json(), groupCreateRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.createGroup(request)))
    })
    app.post('/v1/groups/rename', async (c) => {
      const request = await parseBody(c.req.json(), groupRenameRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.renameGroup(request)))
    })
    app.post('/v1/groups/delete', async (c) => {
      const request = await parseBody(c.req.json(), groupDeleteRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.deleteGroup(request)))
    })
    app.post('/v1/groups/move', async (c) => {
      const request = await parseBody(c.req.json(), groupMoveRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.moveGroup(request)))
    })
    app.post('/v1/groups/assign', async (c) => {
      const request = await parseBody(c.req.json(), groupAssignRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.assignGroup(request)))
    })
    app.post('/v1/groups/collapse', async (c) => {
      const request = await parseBody(c.req.json(), groupCollapseRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.collapseGroup(request)))
    })
    app.post('/v1/layouts/save', async (c) => {
      const request = await parseBody(c.req.json(), layoutSaveRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.saveLayout(request)))
    })
    app.post('/v1/layouts/delete', async (c) => {
      const request = await parseBody(c.req.json(), layoutDeleteRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.deleteLayout(request)))
    })
    app.post('/v1/layouts/import', async (c) => {
      const request = await parseBody(c.req.json(), layoutImportRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.importLayout(request)))
    })
    app.post('/v1/tabs/select', async (c) => {
      const request = await parseBody(c.req.json(), tabSelectRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.selectTab(request)))
    })
    app.post('/v1/tabs/move', async (c) => {
      const request = await parseBody(c.req.json(), tabMoveRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.moveTab(request)))
    })
    app.post('/v1/tabs/update', async (c) => {
      const request = await parseBody(c.req.json(), tabUpdateRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.updateTab(request)))
    })
    app.post('/v1/tabs/open-browser', async (c) => {
      const request = await parseBody(c.req.json(), tabOpenBrowserRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.openBrowserTab(request)))
    })
    app.post('/v1/browser/navigate', async (c) => {
      const request = await parseBody(c.req.json(), browserNavigateRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.navigateBrowser(request)))
    })
    for (const [action, schema] of [
      ['back', browserBackRequestSchema],
      ['forward', browserForwardRequestSchema],
      ['reload', browserReloadRequestSchema],
      ['stop', browserStopRequestSchema],
      ['openDevTools', browserOpenDevToolsRequestSchema]
    ] as const) {
      app.post(`/v1/browser/${action}`, async (c) => {
        const request = await parseBody(c.req.json(), schema)
        return c.json(await stateStore.exclusive(() => stateStore.browserAction(action, request)))
      })
    }
    app.post('/v1/browser/observe', async (c) => {
      const request = await parseBody(c.req.json(), browserObserveRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.observeBrowser(request)))
    })
    app.post('/v1/panes/focus', async (c) => {
      const request = await parseBody(c.req.json(), paneFocusRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.focusPane(request)))
    })
    app.post('/v1/panes/resize', async (c) => {
      const request = await parseBody(c.req.json(), paneResizeRequestSchema)
      return c.json(await stateStore.exclusive(() => stateStore.resizePane(request)))
    })
    if (workspaceRuntime) {
      app.post('/v1/panes/split', async (c) => {
        const request = await parseBody(c.req.json(), paneSplitRequestSchema)
        return c.json(await workspaceRuntime.splitPane(stateStore, request))
      })
      app.post('/v1/panes/close', async (c) => {
        const request = await parseBody(c.req.json(), paneCloseRequestSchema)
        return c.json(await workspaceRuntime.closePane(stateStore, request))
      })
    }
  }

  app.post('/v1/terminals', async (c) => {
    const body = await parseBody(c.req.json(), terminalCreateParamsSchema)
    return c.json(
      await service.create({
        rows: body.rows,
        cols: body.cols,
        ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
        ...(body.command === undefined ? {} : { command: body.command })
      }),
      201
    )
  })

  app.get('/v1/terminals/:id', (c) => c.json(service.attach(terminalId(c.req.param('id')))))

  app.get('/v1/terminals/:id/metadata', async (c) =>
    c.json(await service.runtimeMetadata(terminalId(c.req.param('id'))))
  )

  app.post('/v1/terminals/:id/input', async (c) => {
    const id = terminalId(c.req.param('id'))
    const body = await parseBody(c.req.json(), terminalInputSchema)
    service.send(id, Buffer.from(body.data, 'base64'))
    return c.json({})
  })

  app.post('/v1/terminals/:id/resize', async (c) => {
    const id = terminalId(c.req.param('id'))
    const body = await parseBody(c.req.json(), terminalResizeSchema)
    service.resize(id, body.rows, body.cols)
    return c.json({})
  })

  app.put('/v1/terminals/:id/checkpoint', async (c) => {
    const id = terminalId(c.req.param('id'))
    const body = await parseBody(c.req.json(), terminalCheckpointSchema)
    service.checkpoint(id, body)
    return c.json({})
  })

  app.delete('/v1/terminals/:id', (c) => {
    const id = terminalId(c.req.param('id'))
    if (workspaceRuntime?.ownsTerminal(id) || remoteInteractive?.ownsTerminal(id)) {
      throw new TerminalServiceError('terminal_owned', 'Owned terminal requires a state mutation')
    }
    service.close(id)
    return c.body(null, 204)
  })

  app.get(
    '/v1/terminals/:id/events',
    async (c, next) => {
      service.attach(terminalId(c.req.param('id')))
      await next()
    },
    upgradeWebSocket((c) => {
      const id = terminalId(c.req.param('id'))
      let unsubscribe: (() => void) | undefined
      return {
        onOpen(_event, socket) {
          const raw = socket.raw as WebSocket
          unsubscribe = service.subscribe(id, (event) => {
            if (raw.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
              socket.close(1013, 'Terminal event backlog; reattach')
              return
            }
            socket.send(JSON.stringify(event))
          })
          socket.send(JSON.stringify({ event: 'terminal.attached', data: service.attach(id) }))
        },
        onClose() {
          unsubscribe?.()
        },
        onError() {
          unsubscribe?.()
        }
      }
    })
  )

  if (cardSlotAttention) {
    app.get(
      '/v1/workspace-events',
      upgradeWebSocket(() => {
        let unsubscribe: (() => void) | undefined
        return {
          onOpen(_event, socket) {
            const send = (value: unknown) => {
              if ((socket.raw as WebSocket).bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
                socket.close(1013, 'Workspace event backlog; reconnect')
                return
              }
              socket.send(JSON.stringify(value))
            }
            unsubscribe = cardSlotAttention.subscribe(send)
            for (const event of cardSlotAttention.resyncEvents()) send(event)
          },
          onClose() {
            unsubscribe?.()
          },
          onError() {
            unsubscribe?.()
          }
        }
      })
    )
  }

  return app
}

async function parseBody<T>(body: Promise<unknown>, schema: ZodType<T>): Promise<T> {
  let value: unknown
  try {
    value = await body
  } catch {
    throw new TerminalServiceError('invalid_params', 'Request body must be JSON')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new TerminalServiceError('invalid_params', 'Request body does not match the contract')
  }
  return parsed.data
}

function parseRoute<T>(value: unknown, schema: ZodType<T>): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new TerminalServiceError('invalid_params', 'Route parameters do not match the contract')
  return parsed.data
}

function parseLayoutId(layoutId: string): string {
  const parsed = layoutGetParamsSchema.safeParse({ layoutId })
  if (!parsed.success) throw new TerminalServiceError('invalid_params', 'Layout ID is invalid')
  return parsed.data.layoutId
}

function parseRemoteList(limit: string | undefined, cursor: string | undefined) {
  const parsed = remoteListParamsSchema.safeParse({
    limit: limit === undefined ? 128 : Number(limit),
    cursor: cursor ?? null
  })
  if (!parsed.success) throw new TerminalServiceError('invalid_params', 'Remote page is invalid')
  return parsed.data
}

function parseRemoteTargetId(targetId: string): string {
  const parsed = remoteTargetIdParamsSchema.safeParse({ remoteTargetId: targetId })
  if (!parsed.success)
    throw new TerminalServiceError('invalid_params', 'Remote target ID is invalid')
  return parsed.data.remoteTargetId
}

function parseRemoteSessionId(sessionId: string): string {
  const parsed = remoteSessionIdParamsSchema.safeParse({ remoteSessionId: sessionId })
  if (!parsed.success)
    throw new TerminalServiceError('invalid_params', 'Remote session ID is invalid')
  return parsed.data.remoteSessionId
}

function terminalId(value: string | undefined): string {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new TerminalServiceError('invalid_params', 'Terminal ID is invalid')
  }
  return value
}

function equalToken(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  )
}
