import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, fstatSync, readFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import WebSocket, { type RawData } from 'ws'

import {
  AgentWorkspaceClient,
  parseTerminalEvent,
  ServerError
} from '@agent-workspace/client-runtime'
import {
  DESKTOP_IPC,
  desktopRemoteTargetDraftSchema,
  desktopRemoteTargetIdentitySchema,
  desktopRemoteTargetDeleteRequestSchema,
  desktopTaskActionRequestSchema,
  desktopAgentSessionActionSchema,
  desktopAgentRegisterRequestSchema,
  desktopAgentForkRequestSchema,
  desktopAgentTeamCreateRequestSchema,
  desktopAgentTeamDeleteRequestSchema,
  desktopAgentTeamMemberCreateRequestSchema,
  desktopAgentTeamMemberUpdateRequestSchema,
  desktopAgentTeamMemberMoveRequestSchema,
  desktopAgentTeamMemberDeleteRequestSchema,
  desktopAgentAttentionRequestSchema,
  desktopTextBoxCreateRequestSchema,
  desktopTextBoxSaveRequestSchema,
  desktopTextBoxDeleteRequestSchema,
  desktopContentSaveRequestSchema,
  desktopSearchConsentRequestSchema,
  desktopSearchSourceRequestSchema,
  desktopSearchRebuildRequestSchema,
  desktopRemoteConnectRequestSchema,
  desktopRemoteSessionActionSchema,
  desktopActionInvokeRequestSchema,
  desktopRecentlyClosedReopenRequestSchema,
  desktopSidebarSelectionSchema,
  savedLayoutImportRequestSchema,
  parseWorkspaceRuntimeMetadata
} from '@agent-workspace/contracts/desktop/desktop-bridge'
import type { DesktopTaskActionRequest } from '@agent-workspace/contracts/desktop/desktop-bridge'
import { desktopMessages } from '@agent-workspace/contracts/desktop/desktop-messages'
import {
  actionInvocationSnapshotSchema,
  actionListResultSchema,
  identifyResultSchema,
  agentCatalogListResultSchema,
  agentCatalogGetResultSchema,
  agentCatalogRegisterResultSchema,
  agentSessionRestoreResultSchema,
  agentSessionForkResultSchema,
  agentTeamMutationResultSchema,
  agentTeamMemberMutationResultSchema,
  agentAttentionSetResultSchema,
  advancedTabCloseResultSchema,
  advancedTabMutationResultSchema,
  recentlyClosedListResultSchema,
  agentRestoreAssessResultSchema,
  mutationResultSchema,
  terminalAttachResultSchema,
  terminalCheckpointSchema,
  terminalCreateParamsSchema,
  terminalEventSchema,
  workspaceListResultSchema,
  workspaceSnapshotParamsSchema,
  workspaceSnapshotResultSchema,
  type WindowStateSnapshot,
  workspaceOrganizationGetResultSchema,
  layoutListResultSchema,
  layoutGetParamsSchema,
  layoutGetResultSchema,
  layoutExportParamsSchema,
  layoutExportEnvelopeSchema,
  layoutSaveParamsSchema,
  layoutDeleteParamsSchema,
  layoutApplyParamsSchema,
  layoutMutationResultSchema,
  workspaceCreateParamsSchema,
  workspaceMoveParamsSchema,
  workspaceCloseParamsSchema,
  workspaceBatchCloseParamsSchema,
  workspaceUpdateParamsSchema,
  workspaceSelectParamsSchema,
  workspacePinParamsSchema,
  workspaceSelectionReplaceParamsSchema,
  workspaceCanonicalMoveParamsSchema,
  groupCreateParamsSchema,
  groupRenameParamsSchema,
  groupDeleteParamsSchema,
  groupMoveParamsSchema,
  groupAssignParamsSchema,
  groupCollapseParamsSchema,
  tabOpenTerminalParamsSchema,
  tabOpenBrowserParamsSchema,
  tabSelectParamsSchema,
  tabUpdateParamsSchema,
  tabCloseParamsSchema,
  tabMoveParamsSchema,
  tabCloseAdvancedParamsSchema,
  tabDuplicateParamsSchema,
  tabMoveExactParamsSchema,
  tabDetachParamsSchema,
  focusHistoryNavigateParamsSchema,
  tabReopenParamsSchema,
  paneSplitParamsSchema,
  paneCloseParamsSchema,
  paneFocusParamsSchema,
  paneResizeParamsSchema,
  terminalRestartParamsSchema,
  workspaceCardSlotsSnapshotSchema,
  workspaceCardSlotsSnapshotParamsSchema,
  workspaceCardSlotsReplaceParamsSchema,
  workspaceCardSlotV2SnapshotSchema,
  workspaceCardSlotV2GetParamsSchema,
  workspaceCardSlotV2ReplaceParamsSchema,
  workspaceAttentionSnapshotSchema,
  workspaceAttentionSnapshotParamsSchema,
  attentionAcknowledgementParamsSchema,
  attentionAcknowledgementResultSchema,
  workspaceCardSlotsChangedEventSchema,
  workspaceCardSlotV2ChangedEventSchema,
  workspaceAttentionChangedEventSchema,
  notificationListParamsSchema,
  notificationListResultSchema,
  notificationMarkReadParamsSchema,
  notificationMarkUnreadParamsSchema,
  notificationClearParamsSchema,
  remoteHostKeyChallengeSchema,
  remoteSessionListResultSchema,
  remoteSessionResultSchema,
  remoteTargetListResultSchema,
  remoteTargetResultSchema,
  remoteTmuxDiscoveryResultSchema,
  taskActionResultSchema,
  settingsGetResultSchema,
  settingsUpdateParamsSchema,
  settingsResetKeyParamsSchema,
  sidebarPlacementSchema,
  sidebarSurfaceSchema,
  workspaceRootListResultSchema,
  workspaceDirectoryListParamsSchema,
  workspaceDirectoryListResultSchema,
  contentDocumentIssueParamsSchema,
  contentDocumentIssueResultSchema,
  contentReadParamsSchema,
  contentPreviewSchema,
  contentSaveResultSchema,
  contentMarkdownParamsSchema,
  safeMarkdownDocumentSchema,
  contentDiffParamsSchema,
  contentDiffResultSchema,
  searchQueryParamsSchema,
  searchQueryResultSchema,
  searchControlResultSchema,
  textBoxDocumentSchema,
  textBoxListResultSchema,
  browserNavigateParamsSchema,
  browserBackParamsSchema,
  browserForwardParamsSchema,
  browserReloadParamsSchema,
  browserStopParamsSchema,
  browserOpenDevToolsParamsSchema,
  browserObserveParamsSchema,
  domainEventSchema,
  browserAutomationProviderPollParamsSchema,
  browserAutomationProviderPollResultSchema,
  browserAutomationProviderAcknowledgeParamsSchema,
  browserAutomationProviderAcknowledgeResultSchema,
  browserAutomationProviderTransferRespondParamsSchema,
  emptyParamsSchema,
  type DesktopProviderIdentityParams,
  type BrowserAutomationProviderPollParams,
  type BrowserAutomationProviderPollResult,
  type BrowserAutomationProviderAcknowledgeParams,
  type BrowserAutomationProviderAcknowledgeResult,
  type BrowserAutomationProviderTransferRespondParams,
  type WindowListResult,
  type WindowCreateParams,
  type WindowCloseParams,
  type TabCloseAdvancedParams,
  type WindowFocusParams,
  type WorkspaceListResult,
  type MutationResult,
  type DomainEventMessage
} from '@agent-workspace/protocol-client'
import { resolveWorkspaceRuntimeMetadata } from './workspace-runtime-metadata'
import { atomicWriteSavedLayout, constrainSidebarWidth, readSavedLayout } from './desktop-ipc'
import {
  createNodeBrowserControl,
  parseBrowserMountParams,
  parseBrowserSessionParams,
  type BrowserControl,
  type BrowserLiveAction,
  type BrowserViewManager
} from './browser-view-manager'

const READY_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 10_000
const MAX_STDOUT_BYTES = 16 * 1024
const MAX_OWNER_FRAME_BYTES = 1_024
const MAX_OWNER_BUFFER_BYTES = 4_096
const MAX_OWNER_PENDING = 16
const OWNER_RESPONSE_TIMEOUT_MS = 5_000
const LAYOUT_APPLY_RETRY_TTL_MS = 10 * 60_000
const MAX_LAYOUT_APPLY_RETRIES = 64
const RECENTLY_CLOSED_RETRY_TTL_MS = 10 * 60_000
const MAX_RECENTLY_CLOSED_RETRIES = 64
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function socketText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.concat(data).toString('utf8')
}
const ENROLL_TIMEOUT_MS = 30_000
const MAX_ENROLL_OUTPUT_BYTES = 4_096
const MAX_FILE_DESCRIPTORS_PER_WINDOW = 8_192
const MAX_FILE_DOCUMENTS_PER_WINDOW = 4_096
const MAX_CLOSED_TERMINAL_CHECKPOINTS = 256
const CLOSED_TERMINAL_CHECKPOINT_MS = 30_000
const UNSUPPORTED_NODE_DEMO_CHANNELS = new Set<string>([
  DESKTOP_IPC.taskAction,
  DESKTOP_IPC.workspacePathOpen,
  DESKTOP_IPC.agentSessionHibernate
])

interface OwnerResponse {
  id: string
  ok: boolean
  capability?: string
  identity?: DesktopProviderIdentityParams
  revision?: number
  proof?: unknown
  error?: string
}

interface LiveBackupProof {
  liveStatePath: string
  backupStatePath: string
  liveStateIdentity: string
  backupStateIdentity: string
  backupSha256: string
}

interface RemoteReplacementRequest {
  remoteTargetId: string
  enrollmentId: string
  expectedRevision: number
}

interface LiveNewTargetResume {
  targetId: string
  enrollmentId: string
}

function validLiveBackupProof(value: unknown): value is LiveBackupProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proof = value as Record<string, unknown>
  return (
    Object.keys(proof).length === 5 &&
    typeof proof.liveStatePath === 'string' &&
    isAbsolute(proof.liveStatePath) &&
    typeof proof.backupStatePath === 'string' &&
    isAbsolute(proof.backupStatePath) &&
    proof.liveStatePath !== proof.backupStatePath &&
    typeof proof.liveStateIdentity === 'string' &&
    /^\d+:\d+$/u.test(proof.liveStateIdentity) &&
    typeof proof.backupStateIdentity === 'string' &&
    /^\d+:\d+$/u.test(proof.backupStateIdentity) &&
    typeof proof.backupSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(proof.backupSha256)
  )
}

/** Main-only framed transport over the child process's inherited fd 3. */
class WindowOwnerChannelClient {
  private pending = Buffer.alloc(0)
  private readonly requests = new Map<
    string,
    {
      resolve(value: OwnerResponse): void
      reject(error: Error): void
      timer: NodeJS.Timeout
    }
  >()
  private closed = false

  public constructor(private readonly stream: Duplex) {
    stream.on('data', this.onData)
    stream.on('error', this.close)
    stream.on('close', this.close)
  }

  public issueForTrustedOwner(windowId: string): Promise<string> {
    if (!UUID.test(windowId)) return Promise.reject(new Error('Window ID is invalid'))
    return this.request({ operation: 'issue', windowId }).then((response) => {
      if (!response.capability || !CAPABILITY.test(response.capability)) {
        throw new Error('Window owner channel returned an invalid capability')
      }
      return response.capability
    })
  }

  public liveBackupProof(): Promise<LiveBackupProof> {
    return this.request({ operation: 'liveBackupProof' }).then((response) => {
      if (!validLiveBackupProof(response.proof)) {
        throw new Error('Window owner channel returned an invalid live backup proof')
      }
      return response.proof
    })
  }

  public registerAutomationProviderForTrustedOwner(
    windowId: string,
    windowGeneration: number
  ): Promise<DesktopProviderIdentityParams> {
    if (!UUID.test(windowId) || !Number.isSafeInteger(windowGeneration) || windowGeneration < 1)
      return Promise.reject(new Error('Automation window claim is invalid'))
    return this.request({
      operation: 'registerAutomationProvider',
      windowId,
      windowGeneration
    }).then((response) => {
      if (!validAutomationProviderIdentity(response.identity))
        throw new Error('Window owner channel returned an invalid provider identity')
      return response.identity
    })
  }

  public async revokeAutomationProvider(
    windowId: string,
    windowGeneration: number,
    identity: DesktopProviderIdentityParams
  ): Promise<void> {
    if (
      !UUID.test(windowId) ||
      !Number.isSafeInteger(windowGeneration) ||
      windowGeneration < 1 ||
      !validAutomationProviderIdentity(identity)
    ) {
      throw new Error('Automation provider claim is invalid')
    }
    await this.request({
      operation: 'revokeAutomationProvider',
      windowId,
      windowGeneration,
      identity
    })
  }

  public hosting(
    operation: 'registerHosting' | 'heartbeatHosting' | 'revokeHosting',
    windowId: string,
    windowGeneration: number
  ): Promise<number> {
    if (!UUID.test(windowId) || !Number.isSafeInteger(windowGeneration) || windowGeneration < 1)
      return Promise.reject(new Error('Hosting window claim is invalid'))
    return this.request({ operation, windowId, windowGeneration }).then((response) => {
      if (
        !Number.isSafeInteger(response.revision) ||
        response.revision === undefined ||
        response.revision < 0
      ) {
        throw new Error('Window owner channel returned an invalid hosting revision')
      }
      return response.revision
    })
  }

  public async revoke(capability: string): Promise<void> {
    if (!CAPABILITY.test(capability)) throw new Error('Window capability is invalid')
    await this.request({ operation: 'revoke', capability })
  }

  public async revokeWindow(windowId: string): Promise<void> {
    if (!UUID.test(windowId)) throw new Error('Window ID is invalid')
    await this.request({ operation: 'revokeWindow', windowId })
  }

  public close = (): void => {
    if (this.closed) return
    this.closed = true
    this.pending = Buffer.alloc(0)
    this.stream.off('data', this.onData)
    this.stream.destroy()
    for (const request of this.requests.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Window owner channel closed'))
    }
    this.requests.clear()
  }

  private request(command: object): Promise<OwnerResponse> {
    if (this.closed) return Promise.reject(new Error('Window owner channel closed'))
    if (this.requests.size >= MAX_OWNER_PENDING) {
      return Promise.reject(new Error('Window owner channel is busy'))
    }
    const id = randomUUID()
    const payload = Buffer.from(JSON.stringify({ id, ...command }), 'utf8')
    if (payload.length > MAX_OWNER_FRAME_BYTES) {
      return Promise.reject(new Error('Window owner request exceeded its limit'))
    }
    const frame = Buffer.allocUnsafe(payload.length + 4)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(this.close, OWNER_RESPONSE_TIMEOUT_MS)
      this.requests.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
      try {
        this.stream.write(frame)
      } catch {
        this.close()
      }
    })
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.closed) return
    if (!Buffer.isBuffer(chunk) || this.pending.length + chunk.length > MAX_OWNER_BUFFER_BYTES) {
      this.close()
      return
    }
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0)
      if (length === 0 || length > MAX_OWNER_FRAME_BYTES) {
        this.close()
        return
      }
      if (this.pending.length < length + 4) break
      const payload = this.pending.subarray(4, length + 4)
      this.pending = this.pending.subarray(length + 4)
      let response: OwnerResponse
      try {
        response = JSON.parse(payload.toString('utf8')) as OwnerResponse
      } catch {
        this.close()
        return
      }
      if (!validOwnerResponse(response)) {
        this.close()
        return
      }
      const request = this.requests.get(response.id)
      if (!request) {
        this.close()
        return
      }
      this.requests.delete(response.id)
      clearTimeout(request.timer)
      if (response.ok) request.resolve(response)
      else request.reject(new Error(`Window owner channel: ${response.error}`))
    }
  }
}

function validOwnerResponse(value: OwnerResponse): boolean {
  if (!value || typeof value !== 'object' || !UUID.test(value.id) || typeof value.ok !== 'boolean')
    return false
  if (value.ok)
    return (
      value.error === undefined &&
      (value.capability === undefined || CAPABILITY.test(value.capability)) &&
      (value.identity === undefined || validAutomationProviderIdentity(value.identity)) &&
      (value.revision === undefined ||
        (Number.isSafeInteger(value.revision) && value.revision >= 0))
    )
  return (
    typeof value.error === 'string' &&
    /^[a-z_]{1,40}$/u.test(value.error) &&
    value.capability === undefined &&
    value.identity === undefined &&
    value.revision === undefined
  )
}

function validAutomationProviderIdentity(value: unknown): value is DesktopProviderIdentityParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.providerId === 'string' &&
    UUID.test(candidate.providerId) &&
    typeof candidate.leaseId === 'string' &&
    UUID.test(candidate.leaseId) &&
    typeof candidate.providerEpoch === 'number' &&
    Number.isSafeInteger(candidate.providerEpoch) &&
    candidate.providerEpoch > 0
  )
}

function parseCoreTerminalId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('Invalid terminal identifier')
  }
  return value
}

export interface NodeSidecarOptions {
  serverPath: string
  sourcePath: string
  backupPath: string
  workingPath: string
  liveDatabasePath: string
  executable?: string
  sessionFilePath?: string
  resumeCopy?: boolean
  remoteDemo?: boolean
  encryptedSearch?: boolean
}

/** Paths must be selected by Electron main after the live cutover has been qualified. */
export interface NodeSidecarLiveOptions {
  serverPath: string
  liveDatabasePath: string
  backupPath: string
  rustDesktopConfigPath: string
  sessionFilePath: string
  executable?: string
  encryptedSearch?: boolean
  remoteTransport?: boolean
  /** Explicitly permit a disposable profile under the server's temporary preview root. */
  disposablePreview?: boolean
}

/** The native Node owner creates and opens its own state; no Rust config or copy is involved. */
export interface NodeSidecarNativeOptions extends Omit<
  NodeSidecarLiveOptions,
  'rustDesktopConfigPath' | 'disposablePreview'
> {
  native: true
  defaultWorkingDirectory: string
}

type AnyNodeSidecarOptions = NodeSidecarOptions | NodeSidecarLiveOptions | NodeSidecarNativeOptions

interface RemoteConfirmation {
  confirm(options: {
    title: string
    message: string
    detail: string
    cancel: string
    accept: string
  }): Promise<boolean>
  isCurrent(): boolean
  pickCredential?(): Promise<FileHandle | null>
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
  payload: { expectedCatalogRevision: number; expectedTeamRevision: number }
) {
  return {
    ...agentCatalogMutation(namespace, payload, payload.expectedCatalogRevision),
    expectedTeamRevision: payload.expectedTeamRevision
  }
}

/** Opt-in desktop main-process binding to a Node server on an isolated Rust-v15 copy. */
export class NodeSidecar {
  private stopped = false
  private pendingTerminalAttaches: Set<Promise<unknown>> | undefined
  private handoff: Promise<unknown> | undefined
  private readonly remoteConfirmations = new Map<string, Promise<unknown>>()
  private readonly windowCapabilityReads = new Map<string, Promise<void>>()
  private readonly terminalSockets = new Map<
    string,
    {
      socket: WebSocket
      windowId: string
      suspended?: boolean
      resync?: () => void
    }
  >()
  private readonly remoteTerminals = new Map<
    string,
    { remoteSessionId: string; terminalId?: string; windowId: string; suspended?: boolean }
  >()
  private layoutApplyRequests:
    | Map<
        string,
        {
          windowId: string
          layoutId: string
          expectedRevision: number
          expectedWindowRevision: number
          idempotencyEpoch: string
          expiresAtMs: number
          completedAtMs?: number
        }
      >
    | undefined
  private recentlyClosedReopenRequests:
    | Map<
        string,
        {
          request: Parameters<AgentWorkspaceClient['reopenRecentlyClosedSidebarBound']>[0]
          expiresAtMs?: number
          completedAtMs?: number
        }
      >
    | undefined
  private closedTerminalCheckpoints:
    Map<string, { windowId: string; expiresAtMs: number }> | undefined
  private fileGrants:
    | Map<
        string,
        {
          descriptors: Map<
            string,
            { workspaceId: string; generation: number; kind: 'directory' | 'file' }
          >
          documents: Map<string, { workspaceId: string; identityVersion: number }>
        }
      >
    | undefined
  private workspaceEventSocket: WebSocket | undefined
  private workspaceEventRetry: NodeJS.Timeout | undefined
  private workspaceEventRetryMs = 1_000
  private workspaceEventSink:
    ((channel: string, event: unknown, workspaceId: string) => void) | undefined
  private browserEventSink:
    ((workspaceId: string, event: DomainEventMessage) => Promise<void>) | undefined

  public setBrowserEventSink(
    sink: (workspaceId: string, event: DomainEventMessage) => Promise<void>
  ): void {
    this.browserEventSink = sink
  }

  public createBrowserControl(windowId: string): BrowserControl {
    return createNodeBrowserControl({
      listWorkspaces: async () =>
        workspaceListResultSchema.parse(
          await this.listWorkspacesForTrustedOwner(windowId)
        ) as unknown as WorkspaceListResult,
      focusPane: (params) =>
        this.browserMutation(windowId, (identity) =>
          this.client.focusPane({ ...paneFocusParamsSchema.parse(params), ...identity })
        ),
      observeBrowser: (params) =>
        this.browserMutation(
          windowId,
          (identity) =>
            this.client.observeBrowser({
              ...browserObserveParamsSchema.parse(params),
              ...identity
            }),
          params.state.browserSessionId
        )
    })
  }

  private async browserMutation(
    windowId: string,
    invoke: (identity: {
      expectedRevision: number
      idempotencyEpoch: string
      idempotencyKey: string
    }) => Promise<{ revision: number }>,
    browserSessionId?: string
  ) {
    const [identity, before] = await Promise.all([
      this.client.identify(),
      this.client.listWorkspaces()
    ])
    if (!identity.idempotencyEpoch) throw new Error('Node sidecar has no mutation epoch')
    await invoke({
      expectedRevision: before.snapshot.revision,
      idempotencyEpoch: identity.idempotencyEpoch,
      idempotencyKey: randomUUID()
    })
    const after = workspaceListResultSchema.parse(
      await this.listWorkspacesForTrustedOwner(windowId)
    )
    const result = mutationResultSchema.parse({
      revision: after.snapshot.revision,
      snapshot: after.snapshot
    }) as unknown as MutationResult
    if (browserSessionId) await this.emitBrowserChanged(result, browserSessionId)
    return result
  }

  private async emitBrowserChanged(
    result: MutationResult,
    browserSessionId: string
  ): Promise<void> {
    if (!this.browserEventSink) return
    for (const workspace of result.snapshot.workspaces) {
      const tab = workspace.tabs.find(
        (candidate) =>
          candidate.content.kind === 'browser' &&
          candidate.content.state.browserSessionId === browserSessionId
      )
      if (!tab || tab.content.kind !== 'browser') continue
      const event = domainEventSchema.parse({
        event: 'browser.changed',
        revision: result.snapshot.revision,
        data: { state: tab.content.state }
      })
      try {
        await this.browserEventSink(workspace.id, event)
      } catch (error) {
        console.error('[node-sidecar] browser event delivery failed', error)
      }
      return
    }
  }

  private emitWorkspaceProjectionChanged(
    snapshot: ReturnType<typeof workspaceListResultSchema.parse>['snapshot'],
    reason: string,
    emit: (event: DomainEventMessage) => void
  ): void {
    const event = domainEventSchema.parse({
      event: 'workspace.changed',
      revision: snapshot.revision,
      data: {
        revision: snapshot.revision,
        workspaceIds: snapshot.workspaces.map(({ id }) => id),
        paneIds: snapshot.workspaces.flatMap(({ panes }) => panes.map(({ id }) => id)),
        tabIds: snapshot.workspaces.flatMap(({ tabs }) => tabs.map(({ id }) => id)),
        commandIds: [],
        reason
      }
    })
    try {
      emit(event)
    } catch (error) {
      console.error('[node-sidecar] workspace event delivery failed', error)
    }
  }

  private async applyNodeBrowserCommand(
    windowId: string,
    browser: { views(): BrowserViewManager } | undefined,
    browserSessionId: string,
    action: BrowserLiveAction,
    invoke: Parameters<NodeSidecar['browserMutation']>[1]
  ): Promise<{ handled: true; value: unknown }> {
    if (!browser) throw new Error('Node browser view is unavailable')
    const result = await this.browserMutation(windowId, invoke, browserSessionId)
    browser.views().applyCommandMutation(result, browserSessionId, action)
    return { handled: true, value: result }
  }
  private constructor(
    private child: ChildProcessWithoutNullStreams,
    private ownerChannel: WindowOwnerChannelClient,
    public client: AgentWorkspaceClient,
    public baseUrl: string,
    public readonly configurationWritable: boolean,
    public readonly diagnosticsEnabled: boolean,
    public readonly remoteEnrollmentEnabled: boolean,
    public readonly remoteReplacementEnabled: boolean,
    public readonly remoteDeletionEnabled: boolean,
    public readonly agentAssessmentEnabled: boolean,
    public readonly agentRegistrationEnabled: boolean,
    public readonly agentAdapterVersion: string | undefined,
    public readonly agentForkEnabled: boolean,
    public readonly agentHibernationEnabled: boolean,
    public readonly recentlyClosedEnabled: boolean,
    public readonly encryptedSearchEnabled: boolean,
    public taskListEnabled: boolean,
    public taskActionsEnabled: boolean,
    private readonly options: AnyNodeSidecarOptions
  ) {}

  static async start(options: NodeSidecarOptions): Promise<NodeSidecar> {
    const paths = [
      options.serverPath,
      options.sourcePath,
      options.backupPath,
      options.workingPath,
      options.liveDatabasePath
    ]
    if (
      paths.some((path) => !isAbsolute(path)) ||
      new Set(paths.map((path) => resolve(path))).size !== paths.length
    ) {
      throw new Error('Node sidecar requires distinct absolute paths')
    }
    const source = await realpath(options.sourcePath)
    const live = await realpath(options.liveDatabasePath).catch(() =>
      resolve(options.liveDatabasePath)
    )
    if (source === live) throw new Error('Node sidecar cannot copy the live desktop state')
    const sourceStat = await lstat(options.sourcePath)
    const liveStat = await lstat(options.liveDatabasePath).catch(() => undefined)
    if (liveStat && liveStat.dev === sourceStat.dev && liveStat.ino === sourceStat.ino) {
      throw new Error('Node sidecar source aliases the live desktop state')
    }
    const serverStat = await lstat(options.serverPath)
    if (
      !sourceStat.isFile() ||
      sourceStat.isSymbolicLink() ||
      (sourceStat.mode & 0o077) !== 0 ||
      !serverStat.isFile() ||
      serverStat.isSymbolicLink()
    ) {
      throw new Error('Node sidecar source or bundle is unsafe')
    }
    for (const target of [options.backupPath, options.workingPath]) {
      const parent = await realpath(dirname(target))
      if (parent !== dirname(target)) throw new Error('Node sidecar copy parent must be canonical')
      const parentStat = await lstat(parent)
      if (!parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0) {
        throw new Error('Node sidecar copy parent must be private')
      }
      let file: Stats | undefined
      try {
        file = await lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (options.resumeCopy) {
        if (!file || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
          throw new Error('Node sidecar resume requires private regular backup and working files')
        }
      } else if (file) {
        throw new Error('Node sidecar fresh copy targets must not exist')
      }
    }
    const token = randomBytes(32).toString('hex')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_WORKSPACE_SERVER_TOKEN: token,
      AGENT_WORKSPACE_SERVER_PORT: '0',
      AGENT_WORKSPACE_STATE_SOURCE: source,
      AGENT_WORKSPACE_STATE_BACKUP: options.backupPath,
      AGENT_WORKSPACE_STATE_WORKING: options.workingPath,
      AGENT_WORKSPACE_STATE_RESUME: options.resumeCopy ? '1' : '0',
      // Configuration changes stay beside the disposable Node database.
      AGENT_WORKSPACE_CONFIG_QUALIFICATION: '1',
      AGENT_WORKSPACE_CONFIG_WRITE: '1',
      AGENT_WORKSPACE_ENCRYPTED_SEARCH: options.encryptedSearch ? '1' : '0',
      AGENT_WORKSPACE_WINDOW_OWNER_CHANNEL: '1',
      AGENT_WORKSPACE_REMOTE_HOST_KEYS: options.remoteDemo ? '1' : '0',
      AGENT_WORKSPACE_REMOTE_TRANSPORT: options.remoteDemo ? '1' : '0'
    }
    if (options.sessionFilePath) {
      env.AGENT_WORKSPACE_NODE_SESSION_FILE = options.sessionFilePath
    } else {
      delete env.AGENT_WORKSPACE_NODE_SESSION_FILE
    }
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    delete env.AGENT_WORKSPACE_STATE_LIVE
    delete env.AGENT_WORKSPACE_LIVE_PREVIEW
    delete env.AGENT_WORKSPACE_RUST_DESKTOP_CONFIG
    delete env.AGENT_WORKSPACE_STATE_LIVE_RESUME
    delete env.AGENT_WORKSPACE_LIVE_STATE_IDENTITY
    delete env.AGENT_WORKSPACE_LIVE_BACKUP_IDENTITY
    delete env.AGENT_WORKSPACE_LIVE_BACKUP_SHA256
    delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID
    delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID
    delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION
    delete env.AGENT_WORKSPACE_LIVE_NEW_TARGET_ID
    delete env.AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID
    return NodeSidecar.launch(options, env, options.remoteDemo === true)
  }

  /** Own an explicitly selected live database. The server's cutover guard remains authoritative. */
  static async startLive(
    options: NodeSidecarLiveOptions,
    resumeProof?: LiveBackupProof,
    resumeReplacement?: RemoteReplacementRequest,
    resumeNewTarget?: LiveNewTargetResume
  ): Promise<NodeSidecar> {
    if (process.platform !== 'linux' || !process.getuid) {
      throw new Error('Node live sidecar requires Linux ownership')
    }
    const paths = [
      options.serverPath,
      options.liveDatabasePath,
      options.backupPath,
      options.rustDesktopConfigPath,
      options.sessionFilePath
    ]
    if (
      paths.some((path) => !isAbsolute(path) || resolve(path) !== path) ||
      new Set(paths).size !== paths.length ||
      basename(options.rustDesktopConfigPath) !== 'desktop.json'
    ) {
      throw new Error('Node live sidecar requires distinct canonical absolute paths')
    }
    if (options.disposablePreview) {
      const previewPath = relative(tmpdir(), options.liveDatabasePath)
      const previewRoot = previewPath.split(sep)[0]
      if (
        !previewPath ||
        previewPath === '..' ||
        previewPath.startsWith(`..${sep}`) ||
        !previewRoot?.startsWith('agent-workspace-live-')
      ) {
        throw new Error('Node live preview requires a disposable temporary profile')
      }
    }
    const server = await lstat(options.serverPath)
    if (!server.isFile() || server.isSymbolicLink()) {
      throw new Error('Node live sidecar bundle is unsafe')
    }
    const stateParent = dirname(options.liveDatabasePath)
    const stateDirectory = await lstat(stateParent)
    const state = await lstat(options.liveDatabasePath)
    if (
      (await realpath(stateParent)) !== stateParent ||
      !stateDirectory.isDirectory() ||
      stateDirectory.isSymbolicLink() ||
      stateDirectory.uid !== process.getuid() ||
      (stateDirectory.mode & 0o777) !== 0o700 ||
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.nlink !== 1 ||
      state.uid !== process.getuid() ||
      (state.mode & 0o777) !== 0o600
    ) {
      throw new Error('Node live sidecar state must be private and owned by this user')
    }
    if (
      resumeProof &&
      (!validLiveBackupProof(resumeProof) ||
        resumeProof.liveStatePath !== options.liveDatabasePath ||
        resumeProof.backupStatePath !== options.backupPath)
    ) {
      throw new Error('Node live resume proof does not match the owned paths')
    }
    if ((resumeReplacement || resumeNewTarget) && !resumeProof) {
      throw new Error('Node live intent resume requires a pinned backup proof')
    }
    if (resumeReplacement && resumeNewTarget) {
      throw new Error('Node live resume accepts only one credential intent')
    }
    for (const target of [options.backupPath, options.sessionFilePath]) {
      const parent = dirname(target)
      const directory = await lstat(parent)
      if (
        (await realpath(parent)) !== parent ||
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.uid !== process.getuid() ||
        (directory.mode & 0o077) !== 0
      ) {
        throw new Error('Node live sidecar output directory must be private and canonical')
      }
      let file: Stats | undefined
      try {
        file = await lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (target === options.backupPath && resumeProof) {
        if (
          !file?.isFile() ||
          file.isSymbolicLink() ||
          file.nlink !== 1 ||
          file.uid !== process.getuid() ||
          (file.mode & 0o777) !== 0o600 ||
          `${file.dev}:${file.ino}` !== resumeProof.backupStateIdentity
        ) {
          throw new Error('Node live resume requires the pinned private backup')
        }
      } else if (file) {
        throw new Error('Node live sidecar backup and session targets must not exist')
      }
    }
    const configParent = dirname(options.rustDesktopConfigPath)
    const configDirectory = await lstat(configParent)
    if (
      (await realpath(configParent)) !== configParent ||
      !configDirectory.isDirectory() ||
      configDirectory.uid !== process.getuid() ||
      (configDirectory.mode & 0o077) !== 0
    ) {
      throw new Error('Node live sidecar configuration directory must be private and canonical')
    }
    const token = randomBytes(32).toString('hex')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_WORKSPACE_SERVER_TOKEN: token,
      AGENT_WORKSPACE_SERVER_PORT: '0',
      AGENT_WORKSPACE_STATE_LIVE: options.liveDatabasePath,
      AGENT_WORKSPACE_STATE_BACKUP: options.backupPath,
      AGENT_WORKSPACE_RUST_DESKTOP_CONFIG: options.rustDesktopConfigPath,
      AGENT_WORKSPACE_NODE_SESSION_FILE: options.sessionFilePath,
      AGENT_WORKSPACE_WINDOW_OWNER_CHANNEL: '1',
      AGENT_WORKSPACE_ENCRYPTED_SEARCH: options.encryptedSearch ? '1' : '0',
      AGENT_WORKSPACE_REMOTE_HOST_KEYS: options.remoteTransport ? '1' : '0',
      AGENT_WORKSPACE_REMOTE_TRANSPORT: options.remoteTransport ? '1' : '0'
    }
    for (const key of [
      'AGENT_WORKSPACE_STATE_SOURCE',
      'AGENT_WORKSPACE_STATE_WORKING',
      'AGENT_WORKSPACE_STATE_RESUME',
      'AGENT_WORKSPACE_LIVE_PREVIEW',
      'AGENT_WORKSPACE_CONFIG_QUALIFICATION',
      'AGENT_WORKSPACE_CONFIG_WRITE',
      'AGENT_WORKSPACE_EXPERIMENTAL_VOLATILE_SEARCH',
      'NODE_OPTIONS',
      'NODE_PATH'
    ])
      delete env[key]
    if (options.disposablePreview === true) env.AGENT_WORKSPACE_LIVE_PREVIEW = '1'
    if (resumeProof) {
      env.AGENT_WORKSPACE_STATE_LIVE_RESUME = '1'
      env.AGENT_WORKSPACE_LIVE_STATE_IDENTITY = resumeProof.liveStateIdentity
      env.AGENT_WORKSPACE_LIVE_BACKUP_IDENTITY = resumeProof.backupStateIdentity
      env.AGENT_WORKSPACE_LIVE_BACKUP_SHA256 = resumeProof.backupSha256
      if (resumeReplacement) {
        env.AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID = resumeReplacement.remoteTargetId
        env.AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID = resumeReplacement.enrollmentId
        env.AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION = String(
          resumeReplacement.expectedRevision
        )
      } else {
        delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID
        delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID
        delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION
      }
      if (resumeNewTarget) {
        env.AGENT_WORKSPACE_LIVE_NEW_TARGET_ID = resumeNewTarget.targetId
        env.AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID = resumeNewTarget.enrollmentId
      } else {
        delete env.AGENT_WORKSPACE_LIVE_NEW_TARGET_ID
        delete env.AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID
      }
    } else {
      delete env.AGENT_WORKSPACE_STATE_LIVE_RESUME
      delete env.AGENT_WORKSPACE_LIVE_STATE_IDENTITY
      delete env.AGENT_WORKSPACE_LIVE_BACKUP_IDENTITY
      delete env.AGENT_WORKSPACE_LIVE_BACKUP_SHA256
      delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID
      delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID
      delete env.AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION
      delete env.AGENT_WORKSPACE_LIVE_NEW_TARGET_ID
      delete env.AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID
    }
    return NodeSidecar.launch(options, env, options.remoteTransport === true, true, resumeProof)
  }

  /** Start the production Node owner without a Rust service or copied database. */
  static async startNative(options: NodeSidecarNativeOptions): Promise<NodeSidecar> {
    if (process.platform !== 'linux' || !process.getuid) {
      throw new Error('Native Node desktop ownership requires Linux')
    }
    for (const path of [
      options.serverPath,
      options.liveDatabasePath,
      options.backupPath,
      options.sessionFilePath
    ]) {
      if (!isAbsolute(path) || resolve(path) !== path)
        throw new Error('Native Node paths must be absolute')
    }
    if (
      new Set([
        options.serverPath,
        options.liveDatabasePath,
        options.backupPath,
        options.sessionFilePath
      ]).size !== 4
    ) {
      throw new Error('Native Node paths must be distinct')
    }
    const server = await lstat(options.serverPath)
    if (!server.isFile() || server.isSymbolicLink()) throw new Error('Native Node server is unsafe')
    for (const target of [options.liveDatabasePath, options.backupPath, options.sessionFilePath]) {
      const parent = dirname(target)
      const directory = await lstat(parent)
      if (
        (await realpath(parent)) !== parent ||
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.uid !== process.getuid() ||
        (directory.mode & 0o077) !== 0
      ) {
        throw new Error('Native Node state directory must be private')
      }
    }
    const token = randomBytes(32).toString('hex')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_WORKSPACE_SERVER_TOKEN: token,
      AGENT_WORKSPACE_SERVER_PORT: '0',
      AGENT_WORKSPACE_STATE_NATIVE: options.liveDatabasePath,
      AGENT_WORKSPACE_STATE_BACKUP: options.backupPath,
      AGENT_WORKSPACE_NODE_SESSION_FILE: options.sessionFilePath,
      AGENT_WORKSPACE_DEFAULT_WORKING_DIRECTORY: options.defaultWorkingDirectory,
      AGENT_WORKSPACE_WINDOW_OWNER_CHANNEL: '1',
      AGENT_WORKSPACE_ENCRYPTED_SEARCH: options.encryptedSearch ? '1' : '0',
      AGENT_WORKSPACE_REMOTE_HOST_KEYS: options.remoteTransport ? '1' : '0',
      AGENT_WORKSPACE_REMOTE_TRANSPORT: options.remoteTransport ? '1' : '0'
    }
    for (const key of [
      'AGENT_WORKSPACE_STATE_SOURCE',
      'AGENT_WORKSPACE_STATE_WORKING',
      'AGENT_WORKSPACE_STATE_LIVE',
      'AGENT_WORKSPACE_STATE_RESUME',
      'AGENT_WORKSPACE_STATE_LIVE_RESUME',
      'AGENT_WORKSPACE_LIVE_PREVIEW',
      'NODE_OPTIONS',
      'NODE_PATH'
    ])
      delete env[key]
    return NodeSidecar.launch(options, env, options.remoteTransport === true)
  }

  private static async launch(
    options: AnyNodeSidecarOptions,
    env: NodeJS.ProcessEnv,
    remoteEnabled: boolean,
    live = false,
    resumeProof?: LiveBackupProof
  ): Promise<NodeSidecar> {
    const token = env.AGENT_WORKSPACE_SERVER_TOKEN!
    const child = spawn(options.executable ?? process.execPath, [options.serverPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false
    })
    child.stdin.end()
    if (process.env.AGENT_WORKSPACE_DEBUG_STARTUP === '1') {
      child.stderr.on('data', (chunk: Buffer) =>
        console.error('[node-server]', chunk.toString('utf8'))
      )
    }
    child.stderr.resume()
    const ownerPipe = child.stdio[3] as Duplex | null
    if (!ownerPipe) {
      await stopChild(child)
      throw new Error('Node sidecar private owner pipe is unavailable')
    }
    const ownerChannel = new WindowOwnerChannelClient(ownerPipe)
    try {
      const port = await readyPort(child)
      const baseUrl = `http://127.0.0.1:${port}/`
      const client = new AgentWorkspaceClient(baseUrl, token)
      const identity = await client.identify()
      if (!identity.capabilities.includes('state.snapshot')) {
        throw new Error('Node sidecar lacks state snapshot capability')
      }
      if (remoteEnabled && !identity.capabilities.includes('remote.session.terminal')) {
        throw new Error('Node sidecar lacks the remote session transport capability')
      }
      await client.stateSnapshot()
      if (live) {
        const proof = await ownerChannel.liveBackupProof()
        if (
          proof.liveStatePath !== options.liveDatabasePath ||
          proof.backupStatePath !== options.backupPath ||
          (resumeProof && !isDeepStrictEqual(proof, resumeProof))
        ) {
          throw new Error('Node live sidecar returned a backup proof for different paths')
        }
      }
      return new NodeSidecar(
        child,
        ownerChannel,
        client,
        baseUrl,
        identity.capabilities.includes('configuration.get') &&
          identity.capabilities.includes('configuration.update'),
        identity.capabilities.includes('diagnostics.preview') &&
          identity.capabilities.includes('diagnostics.export'),
        remoteEnabled && identity.capabilities.includes('remote.target.enroll'),
        remoteEnabled && identity.capabilities.includes('remote.target.replaceCredential'),
        remoteEnabled && identity.capabilities.includes('remote.target.delete'),
        identity.capabilities.includes('agent.catalog.list') &&
          identity.capabilities.includes('agent.catalog.get') &&
          identity.capabilities.includes('agent.restore.assess'),
        identity.capabilities.includes('agent.catalog.register') &&
          identity.capabilities.includes('agent.session.restore') &&
          identity.agentProvider?.adapterId === 'codex' &&
          !!identity.agentProvider.adapterVersion,
        identity.agentProvider?.adapterVersion,
        identity.capabilities.includes('agent.session.fork'),
        identity.capabilities.includes('agent.catalog.get') &&
          identity.capabilities.includes('agent.hibernate.preflight') &&
          identity.capabilities.includes('agent.hibernate.cancel') &&
          identity.capabilities.includes('agent.hibernate.confirm'),
        identity.capabilities.includes('recentlyClosed.list') &&
          identity.capabilities.includes('recentlyClosed.reopen'),
        [
          'search.encrypted-v1',
          'search.query',
          'search.source.policy',
          'search.source.exclude',
          'search.source.forget',
          'search.source.rebuild',
          'search.source.export.confirmation.issue',
          'search.source.export'
        ].every((capability) => identity.capabilities.includes(capability)),
        identity.capabilities.includes('task.list'),
        remoteEnabled &&
          identity.capabilities.includes('task.list') &&
          identity.capabilities.includes('task.action'),
        { ...options }
      )
    } catch (error) {
      ownerChannel.close()
      await stopChild(child)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.handoff) await this.handoff.catch(() => undefined)
    if (this.stopped) return
    this.stopped = true
    let drainTimeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.allSettled([...(this.pendingTerminalAttaches ?? [])]),
        new Promise<void>((resolve) => {
          drainTimeout = setTimeout(resolve, STOP_TIMEOUT_MS)
          drainTimeout.unref()
        })
      ])
    } finally {
      if (drainTimeout) clearTimeout(drainTimeout)
    }
    if (this.workspaceEventRetry) clearTimeout(this.workspaceEventRetry)
    this.workspaceEventRetry = undefined
    this.workspaceEventSocket?.close()
    this.workspaceEventSocket = undefined
    this.workspaceEventSink = undefined
    for (const { socket } of this.terminalSockets.values()) socket.close()
    this.terminalSockets.clear()
    this.remoteTerminals.clear()
    this.layoutApplyRequests?.clear()
    this.closedTerminalCheckpoints?.clear()
    this.fileGrants?.clear()
    this.ownerChannel.close()
    await stopChild(this.child)
  }

  public issueSearchExportConfirmation(
    request: Parameters<AgentWorkspaceClient['issueSearchExportConfirmation']>[0]
  ) {
    if (!this.encryptedSearchEnabled) throw new Error('Encrypted search is unavailable')
    return this.client.issueSearchExportConfirmation(request)
  }

  public exportSearchSource(request: Parameters<AgentWorkspaceClient['exportSearchSource']>[0]) {
    if (!this.encryptedSearchEnabled) throw new Error('Encrypted search is unavailable')
    return this.client.exportSearchSource(request)
  }

  /** Desktop-main-only, authenticated stream for process-local card and attention changes. */
  public async startWorkspaceEvents(
    emit: (channel: string, event: unknown, workspaceId: string) => void
  ): Promise<void> {
    if (this.stopped || this.workspaceEventSink) {
      throw new Error('Node workspace event stream is unavailable')
    }
    this.workspaceEventSink = emit
    await this.connectWorkspaceEvents()
  }

  private connectWorkspaceEvents(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Node sidecar is stopped'))
    const socket = new WebSocket(this.client.workspaceEventsUrl(), {
      headers: this.client.authorizationHeader(),
      maxPayload: 64 * 1024
    })
    this.workspaceEventSocket = socket
    return new Promise((resolveOpen, rejectOpen) => {
      let opened = false
      socket.once('open', () => {
        opened = true
        this.workspaceEventRetryMs = 1_000
        resolveOpen()
      })
      socket.on('message', (data) => {
        try {
          const frame = JSON.parse(socketText(data)) as { event?: string }
          let channel: string
          let event: { data: { workspaceId: string } }
          switch (frame.event) {
            case 'workspace.cardSlotsChanged':
              channel = DESKTOP_IPC.workspaceCardSlotsEvent
              event = workspaceCardSlotsChangedEventSchema.parse(frame)
              break
            case 'workspace.cardSlots.v2Changed':
              channel = DESKTOP_IPC.workspaceCardSlotV2Event
              event = workspaceCardSlotV2ChangedEventSchema.parse(frame)
              break
            case 'workspace.attentionChanged':
              channel = DESKTOP_IPC.workspaceAttentionEvent
              event = workspaceAttentionChangedEventSchema.parse(frame)
              break
            default:
              throw new Error('Unknown Node workspace event')
          }
          this.workspaceEventSink?.(channel, event, event.data.workspaceId)
        } catch {
          socket.close(1003, 'Invalid workspace event')
        }
      })
      socket.once('error', () => {
        if (!opened) rejectOpen(new Error('Node workspace event stream failed to open'))
      })
      socket.once('close', () => {
        if (this.workspaceEventSocket !== socket) return
        this.workspaceEventSocket = undefined
        if (!opened) rejectOpen(new Error('Node workspace event stream closed before attach'))
        if (this.stopped || !this.workspaceEventSink) return
        this.workspaceEventRetry = setTimeout(() => {
          this.workspaceEventRetry = undefined
          void this.connectWorkspaceEvents().catch(() => undefined)
        }, this.workspaceEventRetryMs)
        this.workspaceEventRetryMs = Math.min(this.workspaceEventRetryMs * 2, 5_000)
      })
    })
  }

  /** Opt-in IPC probe against the isolated copy. The router has already resolved the sender. */
  public async invokeDesktopCore(
    windowId: string,
    channel: string,
    args: readonly unknown[],
    emitTerminalEvent: (event: unknown) => void,
    browser?: {
      views(): BrowserViewManager
      contentWidth(): number
      isCurrent(): boolean
      senderCurrent(): boolean
      shuttingDown(): boolean
      emitDomainEvent(event: DomainEventMessage): void
      automationActive(): boolean
      attachedTerminalIds(): readonly string[]
      reconcileRendererOwnership(liveResourceIds: ReadonlySet<string>): void
      chooseLayoutExportPath(layoutId: string): Promise<string | null>
      chooseLayoutImportPath(): Promise<string | null>
      waitForOwnershipTransfer(browserSessionId: string): Promise<void>
      ownershipAcquired(browserSessionId: string): void
      browserDetached(browserSessionId: string): void
      terminalDetached(terminalId: string): void
    },
    remoteConfirmation?: RemoteConfirmation
  ): Promise<{ handled: boolean; value?: unknown }> {
    const arg = args[0]
    const shutdownMetadata = (): { handled: true; value: unknown } => {
      workspaceSnapshotParamsSchema.parse(arg)
      return {
        handled: true,
        value: parseWorkspaceRuntimeMetadata({
          gitBranch: null,
          gitStatus: null,
          listeningPorts: []
        })
      }
    }
    if (this.stopped) {
      if (
        channel === DESKTOP_IPC.workspaceRuntimeMetadata &&
        browser?.shuttingDown() &&
        browser.senderCurrent()
      )
        return shutdownMetadata()
      throw new Error('Node sidecar is stopped')
    }
    const mutation = async (
      invoke: (identity: {
        expectedRevision: number
        idempotencyEpoch: string
        idempotencyKey: string
      }) => Promise<{ revision: number }>,
      requested?: { expectedRevision: number; idempotencyKey: string }
    ) => {
      const [identity, before] = await Promise.all([
        this.client.identify(),
        this.client.listWorkspaces()
      ])
      if (!identity.idempotencyEpoch) throw new Error('Node sidecar has no mutation epoch')
      const result = await invoke({
        expectedRevision: requested?.expectedRevision ?? before.snapshot.revision,
        idempotencyEpoch: identity.idempotencyEpoch,
        idempotencyKey: requested?.idempotencyKey ?? randomUUID()
      })
      const after = workspaceListResultSchema.parse(
        await this.listWorkspacesForTrustedOwner(windowId)
      )
      if (after.snapshot.revision !== result.revision) {
        throw new Error('Node sidecar mutation snapshot advanced unexpectedly')
      }
      return mutationResultSchema.parse({ revision: result.revision, snapshot: after.snapshot })
    }
    const assertAgentWindow = async () => {
      const { snapshot } = await this.client.stateSnapshot()
      if (!snapshot.windowPlacements.some(({ id }) => id === windowId)) {
        throw new Error('The window is unavailable in this Node sidecar')
      }
    }
    const ownedAgentSession = async (agentSessionId: string, expectedRevision?: number) => {
      const { session } = agentCatalogGetResultSchema.parse(
        await this.client.getAgentSession(agentSessionId)
      )
      if (expectedRevision !== undefined && session.revision !== expectedRevision) {
        throw new Error('The agent session revision is stale')
      }
      await this.assertRemotePlacementOwner(windowId, session.binding)
      return session
    }
    const exactAgentTeam = async (request: {
      teamId: string
      expectedCatalogRevision: number
      expectedTeamRevision: number
    }) => {
      const catalog = agentCatalogListResultSchema.parse(
        await this.client.listAgentCatalog({ catalogVersion: 1 })
      )
      const team = catalog.teams.find(({ teamId }) => teamId === request.teamId)
      if (
        catalog.revision !== request.expectedCatalogRevision ||
        team?.revision !== request.expectedTeamRevision
      ) {
        throw new Error('The agent team revision is stale')
      }
      return team
    }
    const exactAgentMember = async (request: {
      teamId: string
      memberId: string
      expectedCatalogRevision: number
      expectedTeamRevision: number
      expectedMemberRevision: number
    }) => {
      const team = await exactAgentTeam(request)
      const member = team.members.find(({ memberId }) => memberId === request.memberId)
      if (!member || member.revision !== request.expectedMemberRevision) {
        throw new Error('The agent team member revision is stale')
      }
      const session = await ownedAgentSession(member.target.agentSessionId)
      if (!isDeepStrictEqual(session.binding, member.target)) {
        throw new Error('The agent team member placement is stale')
      }
      return { team, member }
    }
    const assertOwnedParent = async (
      team: Awaited<ReturnType<typeof exactAgentTeam>>,
      parentMemberId?: string
    ) => {
      if (!parentMemberId) return
      const parent = team.members.find(({ memberId }) => memberId === parentMemberId)
      if (!parent) throw new Error('The agent team parent is unavailable')
      const session = await ownedAgentSession(parent.target.agentSessionId)
      if (!isDeepStrictEqual(session.binding, parent.target)) {
        throw new Error('The agent team parent placement is stale')
      }
    }
    try {
      switch (channel) {
        case DESKTOP_IPC.identify: {
          const identity = await this.client.identify()
          const available = new Set(identity.capabilities)
          const has = (...capabilities: string[]) =>
            capabilities.every((capability) => available.has(capability))
          const layoutTopology = has('layout.list', 'layout.get', 'layout.save', 'layout.apply')
            ? await this.listWindowsForTrustedOwner(windowId).catch(() => null)
            : null
          const capabilities = [
            ...identity.capabilities,
            'node-core-demo',
            ...(has('window.list', 'window.create', 'window.close', 'window.focus')
              ? ['multi-window-v1']
              : []),
            ...(has('workspace.organization.get', 'group.create', 'group.assign')
              ? ['workspace-groups-v1']
              : []),
            ...(layoutTopology?.windows.length === 1 ? ['saved-layouts-v1'] : []),
            ...(has('sidebar.placement.get', 'sidebar.placement.save')
              ? ['sidebar-surfaces-v1']
              : []),
            ...(has('workspace.cardSlots.v2.get', 'workspace.cardSlots.v2.replace')
              ? ['card-slots-v2']
              : []),
            ...(has('action.list', 'action.invoke') ? ['actions-v1'] : []),
            ...(this.configurationWritable ? ['configuration-v2'] : []),
            ...(this.agentAssessmentEnabled ? ['agent-sessions-v1'] : []),
            ...(this.remoteEnrollmentEnabled ||
            this.remoteReplacementEnabled ||
            this.remoteDeletionEnabled
              ? ['remote-sessions-v1']
              : [])
          ]
          return {
            handled: true,
            value: identifyResultSchema.parse({
              application: identity.application,
              version: '0.1.0',
              protocolVersion: identity.apiVersion,
              capabilities: [...new Set(capabilities)]
            })
          }
        }
        case DESKTOP_IPC.browserMountView: {
          if (!browser) throw new Error('Node browser view is unavailable')
          const params = parseBrowserMountParams(arg)
          await browser.waitForOwnershipTransfer(params.browserSessionId)
          await browser.views().mount(params)
          try {
            browser.ownershipAcquired(params.browserSessionId)
          } catch (error) {
            browser.views().destroySession({ browserSessionId: params.browserSessionId })
            throw error
          }
          return { handled: true }
        }
        case DESKTOP_IPC.browserUnmountView:
          if (!browser) throw new Error('Node browser view is unavailable')
          browser.views().unmount(parseBrowserSessionParams(arg))
          return { handled: true }
        case DESKTOP_IPC.browserSetBounds:
          if (!browser) throw new Error('Node browser view is unavailable')
          browser.views().setBounds(arg)
          return { handled: true }
        case DESKTOP_IPC.browserFocusView:
          if (!browser) throw new Error('Node browser view is unavailable')
          browser.views().focus(parseBrowserSessionParams(arg))
          return { handled: true }
        case DESKTOP_IPC.browserNavigate: {
          const params = browserNavigateParamsSchema.parse(arg)
          return await this.applyNodeBrowserCommand(
            windowId,
            browser,
            params.browserSessionId,
            'navigate',
            (identity) => this.client.navigateBrowser({ ...params, ...identity })
          )
        }
        case DESKTOP_IPC.browserBack: {
          const params = browserBackParamsSchema.parse(arg)
          return await this.applyNodeBrowserCommand(
            windowId,
            browser,
            params.browserSessionId,
            'back',
            (identity) => this.client.browserBack({ ...params, ...identity })
          )
        }
        case DESKTOP_IPC.browserForward: {
          const params = browserForwardParamsSchema.parse(arg)
          return await this.applyNodeBrowserCommand(
            windowId,
            browser,
            params.browserSessionId,
            'forward',
            (identity) => this.client.browserForward({ ...params, ...identity })
          )
        }
        case DESKTOP_IPC.browserReload: {
          const params = browserReloadParamsSchema.parse(arg)
          return await this.applyNodeBrowserCommand(
            windowId,
            browser,
            params.browserSessionId,
            'reload',
            (identity) => this.client.browserReload({ ...params, ...identity })
          )
        }
        case DESKTOP_IPC.browserStop: {
          const params = browserStopParamsSchema.parse(arg)
          return await this.applyNodeBrowserCommand(
            windowId,
            browser,
            params.browserSessionId,
            'stop',
            (identity) => this.client.browserStop({ ...params, ...identity })
          )
        }
        case DESKTOP_IPC.browserOpenDevTools: {
          const params = browserOpenDevToolsParamsSchema.parse(arg)
          return await this.applyNodeBrowserCommand(
            windowId,
            browser,
            params.browserSessionId,
            'openDevTools',
            (identity) => this.client.browserOpenDevTools({ ...params, ...identity })
          )
        }
        case DESKTOP_IPC.actionList:
          return {
            handled: true,
            value: actionListResultSchema.parse(await this.client.listActions({ limit: 64 }))
          }
        case DESKTOP_IPC.actionInvoke: {
          const request = desktopActionInvokeRequestSchema.parse(arg)
          const catalog = actionListResultSchema.parse(await this.client.listActions({ limit: 64 }))
          const definition = catalog.definitions.find(
            ({ actionId, actionVersion }) =>
              actionId === request.actionId && actionVersion === request.actionVersion
          )
          if (
            !definition ||
            definition.owner !== 'service' ||
            definition.interactionClass !== 'headless'
          ) {
            throw new Error('The Node public action is unavailable')
          }
          const result = await this.client.invokeAction({
            ...request,
            idempotency: { epoch: catalog.idempotencyEpoch, key: randomUUID() },
            correlationId: randomUUID()
          })
          return { handled: true, value: actionInvocationSnapshotSchema.parse(result.invocation) }
        }
        case DESKTOP_IPC.workspaceList:
          return {
            handled: true,
            value: workspaceListResultSchema.parse(
              await this.listWorkspacesForTrustedOwner(windowId)
            )
          }
        case DESKTOP_IPC.workspaceSnapshot: {
          const { workspaceId } = workspaceSnapshotParamsSchema.parse(arg)
          const { snapshot } = await this.listWorkspacesForTrustedOwner(windowId)
          const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId)
          if (!workspace)
            throw new Error(
              '[agent-workspace-protocol-error:workspace_not_found] Workspace is unavailable'
            )
          return {
            handled: true,
            value: workspaceSnapshotResultSchema.parse({ revision: snapshot.revision, workspace })
          }
        }
        case DESKTOP_IPC.workspaceRuntimeMetadata: {
          const { workspaceId } = workspaceSnapshotParamsSchema.parse(arg)
          const { snapshot } = await this.listWorkspacesForTrustedOwner(windowId)
          const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId)
          if (!workspace)
            throw new Error(
              '[agent-workspace-protocol-error:workspace_not_found] Workspace is unavailable'
            )
          const pane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)
          const tab = workspace.tabs.find(({ id }) => id === pane?.selectedTabId)
          const terminalId =
            tab?.content.kind === 'terminal' ? tab.content.runtimeSessionId : undefined
          const [gitMetadata, terminalMetadata] = await Promise.all([
            resolveWorkspaceRuntimeMetadata(workspace.workingDirectory),
            terminalId
              ? this.client.runtimeMetadata(terminalId).catch(() => ({ listeningPorts: [] }))
              : Promise.resolve({ listeningPorts: [] })
          ])
          return {
            handled: true,
            value: parseWorkspaceRuntimeMetadata({
              ...gitMetadata,
              listeningPorts: terminalMetadata.listeningPorts
            })
          }
        }
        case DESKTOP_IPC.workspaceOrganizationGet:
          return {
            handled: true,
            value: workspaceOrganizationGetResultSchema.parse(
              await this.withWindowCapability(windowId, (capability) =>
                this.client.getBoundOrganization(capability)
              )
            )
          }
        case DESKTOP_IPC.sidebarPlacementGet: {
          await this.listWindowsForTrustedOwner(windowId)
          try {
            return {
              handled: true,
              value: sidebarPlacementSchema.parse(await this.client.getSidebarPlacement(windowId))
            }
          } catch (error) {
            if (!(error instanceof ServerError) || error.code !== 'not_found') throw error
            const order = [...sidebarSurfaceSchema.options]
            const placement = sidebarPlacementSchema.parse({
              windowId,
              revision: 1,
              side: 'right',
              width: 320,
              enabled: order,
              order,
              selected: 'textBox'
            })
            return {
              handled: true,
              value: sidebarPlacementSchema.parse(
                await this.client.saveSidebarPlacement({
                  placement,
                  mutation: remoteMutation('sidebar.placement.save', placement, 0)
                })
              )
            }
          }
        }
        case DESKTOP_IPC.sidebarPlacementSave: {
          const params = desktopSidebarSelectionSchema.parse(arg)
          await this.listWindowsForTrustedOwner(windowId)
          const current = sidebarPlacementSchema.parse(
            await this.client.getSidebarPlacement(windowId)
          )
          if (current.windowId !== windowId || current.revision !== params.expectedRevision) {
            throw new Error('The sidebar placement changed; reload before retrying')
          }
          if (!browser?.contentWidth) throw new Error('The sidebar window bounds are unavailable')
          const contentWidth = browser.contentWidth()
          if (!Number.isSafeInteger(contentWidth) || contentWidth <= 0) {
            throw new Error('The sidebar window bounds are invalid')
          }
          const placement = sidebarPlacementSchema.parse({
            ...current,
            windowId,
            side: 'right',
            width: constrainSidebarWidth(params.width, contentWidth),
            selected: params.selected,
            revision: current.revision + 1
          })
          return {
            handled: true,
            value: sidebarPlacementSchema.parse(
              await this.client.saveSidebarPlacement({
                placement,
                mutation: remoteMutation('sidebar.placement.save', placement, current.revision)
              })
            )
          }
        }
        case DESKTOP_IPC.contentRootList: {
          const all = workspaceRootListResultSchema.parse(
            await this.client.listContentRoots({ limit: 64 })
          )
          if (all.nextCursor !== null) throw new Error('Node Files roots exceeded their bound')
          const { snapshot } = await this.client.stateSnapshot()
          const placement = snapshot.windowPlacements.find(({ id }) => id === windowId)
          if (!placement) throw new Error('The Files window is unavailable')
          const owned = new Set(placement.workspaceIds)
          const roots = all.roots.filter(({ workspaceId }) => owned.has(workspaceId))
          const grants = this.grantsForWindow(windowId)
          for (const root of roots) {
            this.grantDescriptor(grants, root.directoryDescriptorId, {
              workspaceId: root.workspaceId,
              generation: root.generation,
              kind: 'directory'
            })
          }
          return {
            handled: true,
            value: workspaceRootListResultSchema.parse({ roots, nextCursor: null })
          }
        }
        case DESKTOP_IPC.contentDirectoryList: {
          const request = workspaceDirectoryListParamsSchema.parse(arg)
          const descriptor = await this.assertFileDescriptorOwner(
            windowId,
            request.directoryDescriptorId,
            request.generation,
            'directory'
          )
          const result = workspaceDirectoryListResultSchema.parse(
            await this.client.listContentDirectory(request)
          )
          await this.assertWorkspaceOwner(windowId, descriptor.workspaceId)
          const grants = this.grantsForWindow(windowId)
          for (const entry of result.entries) {
            this.grantDescriptor(grants, entry.entryDescriptorId, {
              workspaceId: descriptor.workspaceId,
              generation: entry.generation,
              kind: entry.kind
            })
          }
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.contentDocumentIssue: {
          const request = contentDocumentIssueParamsSchema.parse(arg)
          const descriptor = await this.assertFileDescriptorOwner(
            windowId,
            request.authorizedDescriptorId,
            request.descriptorGeneration,
            'file'
          )
          const result = contentDocumentIssueResultSchema.parse(
            await this.client.issueContentDocument(request)
          )
          await this.assertWorkspaceOwner(windowId, descriptor.workspaceId)
          const grants = this.grantsForWindow(windowId)
          if (
            !grants.documents.has(result.document.documentId) &&
            grants.documents.size >= MAX_FILE_DOCUMENTS_PER_WINDOW
          ) {
            throw new Error('The Files document grant limit was reached')
          }
          grants.documents.set(result.document.documentId, {
            workspaceId: descriptor.workspaceId,
            identityVersion: result.document.identityVersion
          })
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.contentRead: {
          const request = contentReadParamsSchema.parse(arg)
          const workspaceId = await this.assertFileDocumentOwner(windowId, request.document)
          const preview = contentPreviewSchema.parse(await this.client.readContent(request))
          await this.assertWorkspaceOwner(windowId, workspaceId)
          return {
            handled: true,
            value: preview
          }
        }
        case DESKTOP_IPC.contentSave: {
          const request = desktopContentSaveRequestSchema.parse(arg)
          const workspaceId = await this.assertFileDocumentOwner(windowId, request.document)
          await this.assertWorkspaceOwner(windowId, workspaceId)
          const saved = contentSaveResultSchema.parse(
            await this.client.saveContent({
              ...request,
              mutation: remoteMutation('content.save', request, request.expectedRevision)
            })
          )
          await this.assertWorkspaceOwner(windowId, workspaceId)
          this.grantsForWindow(windowId).documents.set(saved.document.documentId, {
            workspaceId,
            identityVersion: saved.document.identityVersion
          })
          return { handled: true, value: saved }
        }
        case DESKTOP_IPC.contentMarkdown: {
          const request = contentMarkdownParamsSchema.parse(arg)
          const workspaceId = await this.assertFileDocumentOwner(windowId, request.document)
          const document = safeMarkdownDocumentSchema.parse(
            await this.client.renderMarkdown(request)
          )
          await this.assertWorkspaceOwner(windowId, workspaceId)
          return {
            handled: true,
            value: document
          }
        }
        case DESKTOP_IPC.contentDiff: {
          const request = contentDiffParamsSchema.parse(arg)
          const workspaceIds = await Promise.all([
            this.assertFileDocumentOwner(windowId, request.before),
            this.assertFileDocumentOwner(windowId, request.after)
          ])
          const diff = contentDiffResultSchema.parse(await this.client.diffContent(request))
          await Promise.all(
            workspaceIds.map((workspaceId) => this.assertWorkspaceOwner(windowId, workspaceId))
          )
          return {
            handled: true,
            value: diff
          }
        }
        case DESKTOP_IPC.searchQuery: {
          if (!this.encryptedSearchEnabled) throw new Error('Encrypted search is unavailable')
          const request = searchQueryParamsSchema.parse(arg)
          const { snapshot: initialSnapshot } = await this.client.stateSnapshot()
          const initialPlacement = initialSnapshot.windowPlacements.find(
            ({ id }) => id === windowId
          )
          if (!initialPlacement) throw new Error('The search window is unavailable')
          const sourceAuthorizationIds = new Set(initialPlacement.workspaceIds)
          const catalog = await this.client.listAgentCatalog({ catalogVersion: 1 })
          for (const session of catalog.sessions) {
            if (sourceAuthorizationIds.has(session.binding.workspaceId)) {
              sourceAuthorizationIds.add(session.binding.agentSessionId)
            }
          }
          const result = searchQueryResultSchema.parse(
            await this.client.searchContent({
              ...request,
              sourceAuthorizationIds: [...sourceAuthorizationIds]
            })
          )
          const { snapshot } = await this.client.stateSnapshot()
          const placement = snapshot.windowPlacements.find(({ id }) => id === windowId)
          if (!placement) throw new Error('The search window is unavailable')
          const owned = new Set(placement.workspaceIds)
          const grants = this.grantsForWindow(windowId)
          const results: typeof result.results = []
          for (const item of result.results) {
            const sourceId = item.sourceAuthorizationId
            if (!sourceId) continue
            if (item.sourceKind === 'workspaceFile') {
              if (!owned.has(sourceId)) continue
              if (
                !grants.documents.has(item.document.documentId) &&
                grants.documents.size >= MAX_FILE_DOCUMENTS_PER_WINDOW
              )
                throw new Error('The Files document grant limit was reached')
              grants.documents.set(item.document.documentId, {
                workspaceId: sourceId,
                identityVersion: item.document.identityVersion
              })
            } else {
              const session = await this.client.getAgentSession(sourceId).catch(() => undefined)
              if (!session || !owned.has(session.session.binding.workspaceId)) continue
            }
            results.push(item)
          }
          return {
            handled: true,
            value: searchQueryResultSchema.parse({ results, truncated: result.truncated })
          }
        }
        case DESKTOP_IPC.searchConsent: {
          if (!this.encryptedSearchEnabled) throw new Error('Encrypted search is unavailable')
          const request = desktopSearchConsentRequestSchema.parse(arg)
          const { expectedRevision, ...policy } = request
          return {
            handled: true,
            value: searchControlResultSchema.parse(
              await this.client.setSearchSourcePolicy({
                ...policy,
                mutation: remoteMutation('search.source.policy', policy, expectedRevision)
              })
            )
          }
        }
        case DESKTOP_IPC.searchExclude:
        case DESKTOP_IPC.searchForget: {
          if (!this.encryptedSearchEnabled) throw new Error('Encrypted search is unavailable')
          const request = desktopSearchSourceRequestSchema.parse(arg)
          const command =
            channel === DESKTOP_IPC.searchExclude ? 'search.source.exclude' : 'search.source.forget'
          const payload = {
            sourceAuthorizationId: request.sourceAuthorizationId,
            mutation: remoteMutation(command, request, request.expectedRevision)
          }
          return {
            handled: true,
            value: searchControlResultSchema.parse(
              channel === DESKTOP_IPC.searchExclude
                ? await this.client.excludeSearchSource(payload)
                : await this.client.forgetSearchSource(payload)
            )
          }
        }
        case DESKTOP_IPC.searchRebuild: {
          if (!this.encryptedSearchEnabled) throw new Error('Encrypted search is unavailable')
          const request = desktopSearchRebuildRequestSchema.parse(arg)
          return {
            handled: true,
            value: searchControlResultSchema.parse(
              await this.client.rebuildSearchSource({
                sourceAuthorizationId: request.sourceAuthorizationId,
                cancellationId: request.cancellationId,
                mutation: remoteMutation('search.source.rebuild', request, request.expectedRevision)
              })
            )
          }
        }
        case DESKTOP_IPC.searchExport:
          if (!this.encryptedSearchEnabled) throw new Error('Encrypted search is unavailable')
          return { handled: false }
        case DESKTOP_IPC.textBoxList: {
          const result = textBoxListResultSchema.parse(
            await this.client.listTextBoxes({ limit: 64 })
          )
          if (result.nextCursor !== null) throw new Error('Node Text Boxes exceeded their bound')
          return {
            handled: true,
            value: textBoxListResultSchema.parse({
              documents: result.documents.filter((document) => document.windowId === windowId),
              nextCursor: null
            })
          }
        }
        case DESKTOP_IPC.textBoxCreate: {
          const request = desktopTextBoxCreateRequestSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, request.workspaceId)
          const payload = { ...request, textBoxDocumentId: randomUUID(), windowId }
          const document = textBoxDocumentSchema.parse(
            await this.client.createTextBox({
              ...payload,
              mutation: remoteMutation('textbox.create', payload, 0)
            })
          )
          return { handled: true, value: document }
        }
        case DESKTOP_IPC.textBoxSave:
        case DESKTOP_IPC.textBoxDelete: {
          const request =
            channel === DESKTOP_IPC.textBoxSave
              ? desktopTextBoxSaveRequestSchema.parse(arg)
              : desktopTextBoxDeleteRequestSchema.parse(arg)
          const current = textBoxDocumentSchema.parse(
            await this.client.getTextBox(request.textBoxDocumentId)
          )
          if (current.windowId !== windowId) {
            throw new Error('The TextBox is not owned by this window')
          }
          await this.assertWorkspaceOwner(windowId, current.workspaceId)
          const namespace = channel === DESKTOP_IPC.textBoxSave ? 'textbox.save' : 'textbox.delete'
          const mutation = remoteMutation(namespace, request, request.expectedRevision)
          const document = textBoxDocumentSchema.parse(
            channel === DESKTOP_IPC.textBoxSave
              ? await this.client.saveTextBox({
                  ...desktopTextBoxSaveRequestSchema.parse(arg),
                  mutation
                })
              : await this.client.deleteTextBox({ ...request, mutation })
          )
          return { handled: true, value: document }
        }
        case DESKTOP_IPC.workspaceCardSlotsGet: {
          const { workspaceId } = workspaceCardSlotsSnapshotParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, workspaceId)
          return {
            handled: true,
            value: workspaceCardSlotsSnapshotSchema.parse(
              await this.client.getWorkspaceCardSlots(workspaceId)
            )
          }
        }
        case DESKTOP_IPC.workspaceCardSlotsReplace: {
          const request = workspaceCardSlotsReplaceParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, request.workspaceId)
          return {
            handled: true,
            value: workspaceCardSlotsSnapshotSchema.parse(
              await this.client.replaceWorkspaceCardSlots(request)
            )
          }
        }
        case DESKTOP_IPC.workspaceCardSlotV2Get: {
          const { workspaceId, kind } = workspaceCardSlotV2GetParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, workspaceId)
          return {
            handled: true,
            value: workspaceCardSlotV2SnapshotSchema.parse(
              await this.client.getWorkspaceCardSlotV2(workspaceId, kind)
            )
          }
        }
        case DESKTOP_IPC.workspaceCardSlotV2Replace: {
          const request = workspaceCardSlotV2ReplaceParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, request.workspaceId)
          return {
            handled: true,
            value: workspaceCardSlotV2SnapshotSchema.parse(
              await this.client.replaceWorkspaceCardSlotV2(request)
            )
          }
        }
        case DESKTOP_IPC.workspaceAttentionGet: {
          const { workspaceId } = workspaceAttentionSnapshotParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, workspaceId)
          return {
            handled: true,
            value: workspaceAttentionSnapshotSchema.parse(
              await this.client.getWorkspaceAttention(workspaceId)
            )
          }
        }
        case DESKTOP_IPC.notificationList:
          return {
            handled: true,
            value: notificationListResultSchema.parse(
              await this.client.listNotifications({
                ...notificationListParamsSchema.parse(arg ?? {}),
                windowId
              })
            )
          }
        case DESKTOP_IPC.settingsGet:
          return {
            handled: true,
            value: settingsGetResultSchema.parse(await this.client.getSettings())
          }
        case DESKTOP_IPC.settingsUpdate: {
          const update = settingsUpdateParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.updateSettings({ windowId, update, mutation: identity })
            )
          }
        }
        case DESKTOP_IPC.settingsResetKey: {
          const { commandId } = settingsResetKeyParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.resetShortcut({ windowId, commandId, mutation: identity })
            )
          }
        }
        case DESKTOP_IPC.notificationMarkRead: {
          const { notificationId } = notificationMarkReadParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.markNotificationRead({ windowId, notificationId, mutation: identity })
            )
          }
        }
        case DESKTOP_IPC.notificationMarkUnread: {
          const { notificationId } = notificationMarkUnreadParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.markNotificationUnread({ windowId, notificationId, mutation: identity })
            )
          }
        }
        case DESKTOP_IPC.notificationClear: {
          const { scope } = notificationClearParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.clearNotifications({ windowId, scope, mutation: identity })
            )
          }
        }
        case DESKTOP_IPC.attentionAcknowledge: {
          const request = attentionAcknowledgementParamsSchema.parse(arg)
          await this.assertNotificationOwner(windowId, request.notificationId)
          return {
            handled: true,
            value: attentionAcknowledgementResultSchema.parse(
              await this.client.acknowledgeAttention(request)
            )
          }
        }
        case DESKTOP_IPC.workspaceCreate:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.createWorkspace({
                ...workspaceCreateParamsSchema.parse(arg),
                ...identity,
                windowId
              })
            )
          }
        case DESKTOP_IPC.recentlyClosedList:
          return {
            handled: true,
            value: recentlyClosedListResultSchema.parse(
              await this.withWindowCapability(windowId, (capability) =>
                this.client.listRecentlyClosedSidebarBound({ limit: 100 }, capability)
              )
            )
          }
        case DESKTOP_IPC.recentlyClosedReopen: {
          const params = desktopRecentlyClosedReopenRequestSchema.parse(arg)
          if (!browser?.isCurrent()) throw new Error('The reopen window changed')
          const cacheKey = JSON.stringify([
            windowId,
            params.record.recentlyClosedId,
            params.record.authorizedDescriptorId,
            params.record.action,
            params.record.expectedRevision,
            params.workspaceId,
            params.paneId
          ])
          const requests = (this.recentlyClosedReopenRequests ??= new Map())
          const now = Date.now()
          for (const [key, cached] of requests) {
            if (cached.expiresAtMs !== undefined && cached.expiresAtMs <= now) requests.delete(key)
          }
          let original = requests.get(cacheKey)
          if (!original) {
            const topology = await this.listWindowsForTrustedOwner(windowId)
            const owner = topology.windows.find((entry) => entry.windowId === windowId)
            const before = workspaceListResultSchema.parse(
              await this.listWorkspacesForTrustedOwner(windowId)
            )
            const workspace = before.snapshot.workspaces.find(
              (entry) => entry.id === params.workspaceId
            )
            const pane = workspace?.panes.find((entry) => entry.id === params.paneId)
            // A simultaneous click may have established the exact request while
            // these preflight reads were in flight. Both calls must use one key.
            original = requests.get(cacheKey)
            if (!original) {
              if (
                !owner ||
                !owner.workspaceIds.includes(params.workspaceId) ||
                !pane ||
                topology.revision !== params.record.expectedRevision ||
                before.snapshot.revision !== topology.revision ||
                !topology.idempotencyEpoch ||
                !browser.isCurrent()
              ) {
                throw new Error('The reopen destination is no longer available')
              }
              const payload = {
                recentlyClosedId: params.record.recentlyClosedId,
                authorizedDescriptorId: params.record.authorizedDescriptorId,
                action: params.record.action,
                expectedRevision: params.record.expectedRevision,
                idempotencyEpoch: topology.idempotencyEpoch,
                target: {
                  windowId,
                  workspaceId: params.workspaceId,
                  paneId: params.paneId,
                  destinationIndex: pane.tabIds.length,
                  expectedWindowRevision: owner.revision
                }
              }
              if (requests.size >= MAX_RECENTLY_CLOSED_RETRIES) {
                let oldestCompleted: { key: string; completedAtMs: number } | undefined
                for (const [key, cached] of requests) {
                  if (cached.completedAtMs === undefined) continue
                  if (!oldestCompleted || cached.completedAtMs < oldestCompleted.completedAtMs) {
                    oldestCompleted = { key, completedAtMs: cached.completedAtMs }
                  }
                }
                if (!oldestCompleted) throw new Error('Too many pending reopen requests')
                requests.delete(oldestCompleted.key)
              }
              original = {
                request: {
                  ...payload,
                  mutation: remoteMutation(
                    'recentlyClosed.reopen',
                    payload,
                    params.record.expectedRevision
                  )
                }
              }
              requests.set(cacheKey, original)
            }
          }
          if (!browser.isCurrent()) throw new Error('The reopen window changed')
          let result: ReturnType<typeof advancedTabMutationResultSchema.parse>
          try {
            result = advancedTabMutationResultSchema.parse(
              await this.withWindowCapability(windowId, (capability) =>
                this.client.reopenRecentlyClosedSidebarBound(original.request, capability)
              )
            )
          } catch (error) {
            if (
              error instanceof ServerError &&
              [
                'unauthorized',
                'stale_revision',
                'source_not_found',
                'policy_denied',
                'runtime_unavailable'
              ].includes(error.code)
            ) {
              requests.delete(cacheKey)
            }
            throw error
          }
          if (result.idempotencyEpoch !== original.request.idempotencyEpoch) {
            throw new Error('The reopened tab mutation epoch changed')
          }
          // Reopening creates native resources in the Node service. The renderer
          // attaches them after receiving the projection event; reconcile any
          // already-mounted BrowserViews against that same authoritative state.
          const after = workspaceListResultSchema.parse(
            await this.listWorkspacesForTrustedOwner(windowId)
          )
          if (!browser.isCurrent() || after.snapshot.revision < result.revision) {
            throw new Error('The reopened tab projection changed')
          }
          const reopenedWorkspace = after.snapshot.workspaces.find(
            (entry) => entry.id === result.placement.workspaceId
          )
          const reopenedTab = reopenedWorkspace?.tabs.find((entry) => entry.id === result.tabId)
          const reopenedPane = reopenedWorkspace?.panes.find(
            (entry) => entry.id === result.placement.paneId
          )
          if (
            result.placement.windowId !== windowId ||
            result.placement.workspaceId !== params.workspaceId ||
            result.placement.paneId !== params.paneId ||
            !reopenedPane?.tabIds.includes(result.tabId) ||
            (after.snapshot.revision === result.revision &&
              reopenedPane.tabIds[result.placement.index] !== result.tabId) ||
            !reopenedTab ||
            reopenedTab.content.kind !== result.ownershipKind ||
            (reopenedTab.content.kind === 'browser' &&
              reopenedTab.content.state.browserSessionId !== result.runtimeSessionId)
          ) {
            throw new Error('The reopened tab is unavailable in this window')
          }
          const liveResourceIds = new Set(
            after.snapshot.workspaces.flatMap((entry) =>
              entry.tabs.flatMap((tab) =>
                tab.content.kind === 'browser'
                  ? [tab.content.state.browserSessionId]
                  : tab.content.runtimeSessionId
                    ? [tab.content.runtimeSessionId]
                    : []
              )
            )
          )
          browser.views().reconcileAuthoritativeSnapshot(after.snapshot, false)
          browser.reconcileRendererOwnership(liveResourceIds)
          this.emitWorkspaceProjectionChanged(
            after.snapshot,
            'recentlyClosed.reopen',
            browser.emitDomainEvent
          )
          original.completedAtMs ??= Date.now()
          original.expiresAtMs = original.completedAtMs + RECENTLY_CLOSED_RETRY_TTL_MS
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.layoutList: {
          const topology = await this.listWindowsForTrustedOwner(windowId)
          if (topology.windows.length !== 1) {
            const { revision } = await this.client.listLayouts()
            return {
              handled: true,
              value: layoutListResultSchema.parse({ revision, layouts: [] })
            }
          }
          await this.assertOnlyLayoutWindow(windowId)
          return {
            handled: true,
            value: layoutListResultSchema.parse(await this.client.listLayouts())
          }
        }
        case DESKTOP_IPC.layoutGet: {
          const { layoutId } = layoutGetParamsSchema.parse(arg)
          await this.assertOnlyLayoutWindow(windowId)
          return {
            handled: true,
            value: layoutGetResultSchema.parse(await this.client.getLayout(layoutId))
          }
        }
        case DESKTOP_IPC.layoutSave: {
          const params = layoutSaveParamsSchema.parse(arg)
          const owned = await this.assertOnlyLayoutWindow(windowId)
          if (
            params.workspaceIds.some(
              (id) => !owned.snapshot.workspaces.some((workspace) => workspace.id === id)
            )
          )
            throw new Error('The saved layout contains a workspace unavailable in this window')
          const identity = await this.client.identify()
          if (!identity.idempotencyEpoch) throw new Error('Node sidecar has no mutation epoch')
          const result = await this.client.saveLayout({
            ...params,
            idempotencyEpoch: identity.idempotencyEpoch
          })
          return {
            handled: true,
            value: layoutMutationResultSchema.parse({ revision: result.revision })
          }
        }
        case DESKTOP_IPC.layoutDelete: {
          const params = layoutDeleteParamsSchema.parse(arg)
          await this.assertOnlyLayoutWindow(windowId)
          const identity = await this.client.identify()
          if (!identity.idempotencyEpoch) throw new Error('Node sidecar has no mutation epoch')
          const result = await this.client.deleteLayout({
            ...params,
            idempotencyEpoch: identity.idempotencyEpoch
          })
          return {
            handled: true,
            value: layoutMutationResultSchema.parse({ revision: result.revision })
          }
        }
        case DESKTOP_IPC.layoutApply: {
          const params = layoutApplyParamsSchema.parse(arg)
          if (!browser?.isCurrent()) throw new Error('The saved-layout window changed')
          const before = await this.assertOnlyLayoutWindow(windowId)
          const topology = await this.listWindowsForTrustedOwner(windowId)
          const owner = topology.windows[0]
          if (
            topology.windows.length !== 1 ||
            owner?.windowId !== windowId ||
            owner.hostingState !== 'hosted'
          ) {
            throw new Error('Saved layout apply requires the sole hosted window')
          }
          // Native BrowserViews may still exist after a committed response was lost.
          // Replaying must wait until their attached automation owners are gone.
          if (browser.automationActive()) {
            throw new Error('Saved layout apply requires browser automation to stop')
          }
          const retryProbe = before.snapshot.revision > params.expectedRevision
          const cacheKey = `${windowId}:${params.idempotencyKey}`
          const requests = (this.layoutApplyRequests ??= new Map())
          const now = Date.now()
          for (const [key, request] of requests) {
            if (request.expiresAtMs <= now) requests.delete(key)
          }
          let original = requests.get(cacheKey)
          if (
            original &&
            (original.windowId !== windowId ||
              original.layoutId !== params.layoutId ||
              original.expectedRevision !== params.expectedRevision)
          ) {
            throw new Error('Saved layout apply idempotency request changed')
          }
          if (retryProbe) {
            if (!original) throw new Error('Saved layout apply replay cannot be verified')
          } else {
            const remote = remoteSessionListResultSchema.parse(
              await this.client.listRemoteSessions({ limit: 128, cursor: null })
            )
            if (
              remote.nextCursor ||
              remote.sessions.some((session) => session.state !== 'closed')
            ) {
              throw new Error('Saved layout apply requires closed remote sessions')
            }
            const agents = agentCatalogListResultSchema.parse(
              await this.client.listAgentCatalog({ catalogVersion: 1 })
            )
            const beforeIds = new Set(before.snapshot.workspaces.map(({ id }) => id))
            if (agents.sessions.some((session) => beforeIds.has(session.binding.workspaceId))) {
              throw new Error('Saved layout apply requires unbound agent sessions')
            }
            if (!original) {
              const identity = await this.client.identify()
              if (!identity.idempotencyEpoch) throw new Error('Node sidecar has no mutation epoch')
              const identifiedAt = Date.now()
              for (const [key, request] of requests) {
                if (request.expiresAtMs <= identifiedAt) requests.delete(key)
              }
              const concurrent = requests.get(cacheKey)
              if (concurrent) {
                if (
                  concurrent.windowId !== windowId ||
                  concurrent.layoutId !== params.layoutId ||
                  concurrent.expectedRevision !== params.expectedRevision
                ) {
                  throw new Error('Saved layout apply idempotency request changed')
                }
                original = concurrent
              } else {
                if (requests.size >= MAX_LAYOUT_APPLY_RETRIES) {
                  let oldestCompleted: { key: string; completedAtMs: number } | undefined
                  for (const [key, request] of requests) {
                    if (request.completedAtMs === undefined) continue
                    if (!oldestCompleted || request.completedAtMs < oldestCompleted.completedAtMs) {
                      oldestCompleted = { key, completedAtMs: request.completedAtMs }
                    }
                  }
                  if (!oldestCompleted) {
                    throw new Error('Too many pending saved layout apply requests')
                  }
                  requests.delete(oldestCompleted.key)
                }
                original = {
                  windowId,
                  layoutId: params.layoutId,
                  expectedRevision: params.expectedRevision,
                  expectedWindowRevision: owner.revision,
                  idempotencyEpoch: identity.idempotencyEpoch,
                  expiresAtMs: identifiedAt + LAYOUT_APPLY_RETRY_TTL_MS
                }
                requests.set(cacheKey, original)
              }
            }
          }
          if (!browser.isCurrent()) throw new Error('The saved-layout window changed')
          const result = await this.client.applyLayout({
            ...params,
            targetWindowId: windowId,
            expectedWindowRevision: original.expectedWindowRevision,
            idempotencyEpoch: original.idempotencyEpoch
          })
          if (retryProbe && !result.replayed) {
            throw new Error('Saved layout apply replay was not confirmed')
          }
          const after = workspaceListResultSchema.parse(
            await this.listWorkspacesForTrustedOwner(windowId)
          )
          if (!browser.isCurrent()) throw new Error('The saved-layout window changed')
          const afterTopology = await this.listWindowsForTrustedOwner(windowId)
          const afterOwner = afterTopology.windows[0]
          if (
            afterTopology.windows.length !== 1 ||
            afterOwner?.windowId !== windowId ||
            afterOwner.hostingState !== 'hosted' ||
            !isDeepStrictEqual(
              [...afterOwner.workspaceIds].sort(),
              after.snapshot.workspaces.map(({ id }) => id).sort()
            ) ||
            !browser.isCurrent()
          ) {
            throw new Error('Saved layout apply changed the sender window')
          }
          if (
            after.snapshot.revision < result.revision ||
            (!result.replayed && after.snapshot.revision !== result.revision)
          ) {
            throw new Error('Saved layout apply projection revision changed')
          }
          const nextTerminals = new Set(
            after.snapshot.workspaces.flatMap((workspace) =>
              workspace.tabs.flatMap((tab) =>
                tab.content.kind === 'terminal' && tab.content.runtimeSessionId
                  ? [tab.content.runtimeSessionId]
                  : []
              )
            )
          )
          const nextBrowsers = new Set(
            after.snapshot.workspaces.flatMap((workspace) =>
              workspace.tabs.flatMap((tab) =>
                tab.content.kind === 'browser' ? [tab.content.state.browserSessionId] : []
              )
            )
          )
          const retiredTerminals = new Set<string>()
          const retiredBrowsers = new Set<string>()
          const candidateTerminals = new Set(browser.attachedTerminalIds())
          for (const [terminalId, attachment] of this.terminalSockets?.entries() ?? []) {
            if (attachment.windowId === windowId) candidateTerminals.add(terminalId)
          }
          for (const workspace of before.snapshot.workspaces) {
            for (const tab of workspace.tabs) {
              if (tab.content.kind === 'terminal' && tab.content.runtimeSessionId) {
                candidateTerminals.add(tab.content.runtimeSessionId)
              } else if (
                tab.content.kind === 'browser' &&
                !nextBrowsers.has(tab.content.state.browserSessionId) &&
                !retiredBrowsers.has(tab.content.state.browserSessionId)
              ) {
                retiredBrowsers.add(tab.content.state.browserSessionId)
                browser
                  .views()
                  .destroySession({ browserSessionId: tab.content.state.browserSessionId })
                browser.browserDetached(tab.content.state.browserSessionId)
              }
            }
          }
          for (const terminalId of candidateTerminals) {
            if (nextTerminals.has(terminalId) || retiredTerminals.has(terminalId)) continue
            retiredTerminals.add(terminalId)
            this.detachTerminal(terminalId)
            this.rememberClosedTerminal(windowId, terminalId)
            browser.terminalDetached(terminalId)
          }
          browser.views().reconcileAuthoritativeSnapshot(after.snapshot, false)
          browser.reconcileRendererOwnership(new Set([...nextTerminals, ...nextBrowsers]))
          this.emitWorkspaceProjectionChanged(
            after.snapshot,
            'layout.apply',
            browser.emitDomainEvent
          )
          if (original.completedAtMs === undefined) {
            original.completedAtMs = Date.now()
            original.expiresAtMs = original.completedAtMs + LAYOUT_APPLY_RETRY_TTL_MS
          }
          return {
            handled: true,
            value: layoutMutationResultSchema.parse({ revision: result.revision })
          }
        }
        case DESKTOP_IPC.layoutExportFile: {
          const { layoutId } = layoutExportParamsSchema.parse(arg)
          await this.assertOnlyLayoutWindow(windowId)
          if (!browser?.isCurrent()) throw new Error('The saved-layout window changed')
          const path = await browser.chooseLayoutExportPath(layoutId)
          if (!path) return { handled: true, value: false }
          if (!browser.isCurrent()) throw new Error('The saved-layout window changed')
          const exported = await this.client.exportLayout(layoutId)
          if (!browser.isCurrent()) throw new Error('The saved-layout window changed')
          await atomicWriteSavedLayout(path, `${JSON.stringify(exported.envelope, null, 2)}\n`)
          return { handled: true, value: true }
        }
        case DESKTOP_IPC.layoutImportFile: {
          const params = savedLayoutImportRequestSchema.parse(arg)
          await this.assertOnlyLayoutWindow(windowId)
          if (!browser?.isCurrent()) throw new Error('The saved-layout window changed')
          const path = await browser.chooseLayoutImportPath()
          if (!path) return { handled: true, value: null }
          const envelope = layoutExportEnvelopeSchema.parse(JSON.parse(await readSavedLayout(path)))
          if (!browser.isCurrent()) throw new Error('The saved-layout window changed')
          const identity = await this.client.identify()
          if (!identity.idempotencyEpoch) throw new Error('Node sidecar has no mutation epoch')
          const result = await this.client.importLayout({
            ...params,
            envelope,
            idempotencyEpoch: identity.idempotencyEpoch
          })
          return {
            handled: true,
            value: layoutMutationResultSchema.parse({ revision: result.revision })
          }
        }
        case DESKTOP_IPC.workspaceUpdate:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.updateWorkspace({
                ...workspaceUpdateParamsSchema.parse(arg),
                ...identity
              })
            )
          }
        case DESKTOP_IPC.workspaceSelect:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.selectWorkspace({
                ...workspaceSelectParamsSchema.parse(arg),
                ...identity
              })
            )
          }
        case DESKTOP_IPC.workspaceMove: {
          const request = workspaceMoveParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, request.workspaceId)
          const result = await mutation((identity) =>
            this.client.moveWorkspace({ ...request, ...identity })
          )
          browser?.views().reconcileAuthoritativeSnapshot(result.snapshot, false)
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.workspaceClose: {
          const request = workspaceCloseParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, request.workspaceId)
          const { snapshot: before } = await this.listWorkspacesForTrustedOwner(windowId)
          const closing = before.workspaces.find((item) => item.id === request.workspaceId)
          if (!closing) throw new Error('The workspace is unavailable in this window')
          const result = await mutation((identity) =>
            this.client.closeWorkspace({ ...request, ...identity })
          )
          for (const tab of closing.tabs) {
            if (tab.content.kind === 'terminal' && tab.content.runtimeSessionId) {
              this.detachTerminal(tab.content.runtimeSessionId)
              this.rememberClosedTerminal(windowId, tab.content.runtimeSessionId)
              browser?.terminalDetached(tab.content.runtimeSessionId)
            } else if (tab.content.kind === 'browser') {
              browser?.views().destroySession({
                browserSessionId: tab.content.state.browserSessionId
              })
              browser?.browserDetached(tab.content.state.browserSessionId)
            }
          }
          browser?.views().reconcileAuthoritativeSnapshot(result.snapshot, false)
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.workspaceCloseSelected: {
          const request = workspaceBatchCloseParamsSchema.parse(arg)
          const { snapshot: before } = await this.client.stateSnapshot()
          const { snapshot: projection } = await this.listWorkspacesForTrustedOwner(windowId)
          const closing = projection.workspaces.filter(({ id }) =>
            before.workspaceSelection.includes(id)
          )
          if (closing.length === 0 || closing.length !== before.workspaceSelection.length) {
            throw new Error('The selected workspaces changed')
          }
          for (const workspace of closing) await this.assertWorkspaceOwner(windowId, workspace.id)
          const result = await mutation((identity) =>
            this.client.closeSelectedWorkspaces({ ...request, ...identity })
          )
          for (const workspace of closing) {
            for (const tab of workspace.tabs) {
              if (tab.content.kind === 'terminal' && tab.content.runtimeSessionId) {
                this.detachTerminal(tab.content.runtimeSessionId)
                this.rememberClosedTerminal(windowId, tab.content.runtimeSessionId)
                browser?.terminalDetached(tab.content.runtimeSessionId)
              } else if (tab.content.kind === 'browser') {
                browser?.views().destroySession({
                  browserSessionId: tab.content.state.browserSessionId
                })
                browser?.browserDetached(tab.content.state.browserSessionId)
              }
            }
          }
          browser?.views().reconcileAuthoritativeSnapshot(result.snapshot, false)
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.workspacePin:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.pinWorkspace({
                ...workspacePinParamsSchema.parse(arg),
                idempotencyEpoch: identity.idempotencyEpoch
              })
            )
          }
        case DESKTOP_IPC.workspaceSelectMany: {
          const request = workspaceSelectionReplaceParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation(
              (identity) => this.client.selectWorkspaces({ ...request, ...identity }),
              request
            )
          }
        }
        case DESKTOP_IPC.workspaceReorder: {
          const request = workspaceCanonicalMoveParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation(
              (identity) => this.client.reorderWorkspace({ ...request, ...identity }),
              request
            )
          }
        }
        case DESKTOP_IPC.groupCreate: {
          const request = groupCreateParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation(
              (identity) => this.client.createGroup({ ...request, ...identity }),
              request
            )
          }
        }
        case DESKTOP_IPC.groupRename: {
          const request = groupRenameParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation(
              (identity) => this.client.renameGroup({ ...request, ...identity }),
              request
            )
          }
        }
        case DESKTOP_IPC.groupDelete: {
          const request = groupDeleteParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation(
              (identity) => this.client.deleteGroup({ ...request, ...identity }),
              request
            )
          }
        }
        case DESKTOP_IPC.groupMove: {
          const request = groupMoveParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation(
              (identity) => this.client.moveGroup({ ...request, ...identity }),
              request
            )
          }
        }
        case DESKTOP_IPC.groupAssign: {
          const request = groupAssignParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation(
              (identity) => this.client.assignGroup({ ...request, ...identity }),
              request
            )
          }
        }
        case DESKTOP_IPC.groupCollapse: {
          const request = groupCollapseParamsSchema.parse(arg)
          return {
            handled: true,
            value: await mutation(
              (identity) => this.client.collapseGroup({ ...request, ...identity }),
              request
            )
          }
        }
        case DESKTOP_IPC.tabOpenTerminal:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.openTerminalTab({
                ...tabOpenTerminalParamsSchema.parse(arg),
                ...identity
              })
            )
          }
        case DESKTOP_IPC.tabOpenBrowser:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.openBrowserTab({
                ...tabOpenBrowserParamsSchema.parse(arg),
                ...identity
              })
            )
          }
        case DESKTOP_IPC.tabSelect:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.selectTab({ ...tabSelectParamsSchema.parse(arg), ...identity })
            )
          }
        case DESKTOP_IPC.tabUpdate: {
          const params = tabUpdateParamsSchema.parse(arg)
          const { snapshot } = await this.listWorkspacesForTrustedOwner(windowId)
          const workspace = snapshot.workspaces.find((item) => item.id === params.workspaceId)
          if (!workspace?.tabs.some((tab) => tab.id === params.tabId)) {
            throw new Error('The tab is unavailable in this window')
          }
          return {
            handled: true,
            value: await mutation((identity) => this.client.updateTab({ ...params, ...identity }))
          }
        }
        case DESKTOP_IPC.tabClose: {
          const params = tabCloseParamsSchema.parse(arg)
          const { snapshot } = await this.listWorkspacesForTrustedOwner(windowId)
          const workspace = snapshot.workspaces.find((item) => item.id === params.workspaceId)
          const tab = workspace?.tabs.find((item) => item.id === params.tabId)
          if (!tab) throw new Error('The tab is unavailable in this window')
          const result = await mutation((identity) =>
            this.client.closeTab({ ...params, ...identity })
          )
          if (tab.content.kind === 'terminal' && tab.content.runtimeSessionId) {
            this.detachTerminal(tab.content.runtimeSessionId)
            this.rememberClosedTerminal(windowId, tab.content.runtimeSessionId)
            browser?.terminalDetached(tab.content.runtimeSessionId)
          }
          if (tab.content.kind === 'browser') {
            browser
              ?.views()
              .destroySession({ browserSessionId: tab.content.state.browserSessionId })
            browser?.browserDetached(tab.content.state.browserSessionId)
          }
          browser?.views().reconcileAuthoritativeSnapshot(result.snapshot, false)
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.paneSplit: {
          const params = paneSplitParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, params.workspaceId)
          const result = await mutation((identity) =>
            this.client.splitPane({ ...params, ...identity })
          )
          browser?.views().reconcileAuthoritativeSnapshot(result.snapshot, false)
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.paneClose: {
          const params = paneCloseParamsSchema.parse(arg)
          const { snapshot } = await this.listWorkspacesForTrustedOwner(windowId)
          const workspace = snapshot.workspaces.find((item) => item.id === params.workspaceId)
          const pane = workspace?.panes.find((item) => item.id === params.paneId)
          if (!workspace || !pane) throw new Error('The pane is unavailable in this window')
          const removed = workspace.tabs.filter((tab) => pane.tabIds.includes(tab.id))
          const result = await mutation((identity) =>
            this.client.closePane({ ...params, ...identity })
          )
          const remaining = new Set(
            result.snapshot.workspaces
              .find((item) => item.id === params.workspaceId)
              ?.tabs.map((tab) => tab.id) ?? []
          )
          for (const tab of removed) {
            if (remaining.has(tab.id)) continue
            if (tab.content.kind === 'terminal' && tab.content.runtimeSessionId) {
              this.detachTerminal(tab.content.runtimeSessionId)
              this.rememberClosedTerminal(windowId, tab.content.runtimeSessionId)
              browser?.terminalDetached(tab.content.runtimeSessionId)
            } else if (tab.content.kind === 'browser') {
              browser
                ?.views()
                .destroySession({ browserSessionId: tab.content.state.browserSessionId })
              browser?.browserDetached(tab.content.state.browserSessionId)
            }
          }
          browser?.views().reconcileAuthoritativeSnapshot(result.snapshot, false)
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.paneMoveTab:
        case DESKTOP_IPC.tabMove: {
          const params = tabMoveParamsSchema.parse(arg)
          await this.assertWorkspaceOwner(windowId, params.workspaceId)
          const result = await mutation((identity) =>
            this.client.moveTab({ ...params, ...identity })
          )
          browser?.views().reconcileAuthoritativeSnapshot(result.snapshot, false)
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.paneFocus:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.focusPane({ ...paneFocusParamsSchema.parse(arg), ...identity })
            )
          }
        case DESKTOP_IPC.paneResize:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.resizePane({ ...paneResizeParamsSchema.parse(arg), ...identity })
            )
          }
        case DESKTOP_IPC.terminalRestart:
          return {
            handled: true,
            value: await mutation((identity) =>
              this.client.restartTerminal({
                ...terminalRestartParamsSchema.parse(arg),
                ...identity
              })
            )
          }
        case DESKTOP_IPC.agentCatalogList:
          if (!this.agentAssessmentEnabled)
            throw new Error('Agent catalog is unavailable in this Node sidecar')
          return {
            handled: true,
            value: agentCatalogListResultSchema.parse(
              await this.client.listAgentCatalog({ catalogVersion: 1 })
            )
          }
        case DESKTOP_IPC.agentTeamCreate: {
          const request = desktopAgentTeamCreateRequestSchema.parse(arg)
          await assertAgentWindow()
          const catalog = agentCatalogListResultSchema.parse(
            await this.client.listAgentCatalog({ catalogVersion: 1 })
          )
          return {
            handled: true,
            value: agentTeamMutationResultSchema.parse(
              await this.client.createAgentTeam({
                teamId: randomUUID(),
                title: request.title,
                mutation: agentCatalogMutation('agent.team.create', request, catalog.revision)
              })
            )
          }
        }
        case DESKTOP_IPC.agentTeamDelete: {
          const request = desktopAgentTeamDeleteRequestSchema.parse(arg)
          const team = await exactAgentTeam(request)
          await assertAgentWindow()
          for (const member of team.members) {
            const session = await ownedAgentSession(member.target.agentSessionId)
            if (!isDeepStrictEqual(session.binding, member.target)) {
              throw new Error('The agent team member placement is stale')
            }
          }
          agentCatalogListResultSchema.parse(
            await this.client.deleteAgentTeam({
              teamId: request.teamId,
              mutation: agentTeamMutation('agent.team.delete', request)
            })
          )
          return { handled: true, value: agentTeamMutationResultSchema.parse({ team }) }
        }
        case DESKTOP_IPC.agentTeamMemberCreate: {
          const request = desktopAgentTeamMemberCreateRequestSchema.parse(arg)
          const team = await exactAgentTeam(request)
          await assertOwnedParent(team, request.parentMemberId)
          const session = await ownedAgentSession(request.agentSessionId)
          return {
            handled: true,
            value: agentTeamMemberMutationResultSchema.parse(
              await this.client.createAgentTeamMember({
                teamId: request.teamId,
                memberId: randomUUID(),
                role: request.role,
                target: session.binding,
                ...(request.parentMemberId ? { parentMemberId: request.parentMemberId } : {}),
                mutation: agentTeamMutation('agent.team.member.create', request)
              })
            )
          }
        }
        case DESKTOP_IPC.agentTeamMemberUpdate: {
          const request = desktopAgentTeamMemberUpdateRequestSchema.parse(arg)
          const { team } = await exactAgentMember(request)
          await assertOwnedParent(team, request.parentMemberId)
          return {
            handled: true,
            value: agentTeamMemberMutationResultSchema.parse(
              await this.client.updateAgentTeamMember({
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
          }
        }
        case DESKTOP_IPC.agentTeamMemberMove: {
          const request = desktopAgentTeamMemberMoveRequestSchema.parse(arg)
          await exactAgentMember(request)
          const session = await ownedAgentSession(request.agentSessionId)
          return {
            handled: true,
            value: agentTeamMemberMutationResultSchema.parse(
              await this.client.moveAgentTeamMember({
                teamId: request.teamId,
                memberId: request.memberId,
                target: session.binding,
                mutation: {
                  ...agentTeamMutation('agent.team.member.move', request),
                  expectedMemberRevision: request.expectedMemberRevision
                }
              })
            )
          }
        }
        case DESKTOP_IPC.agentTeamMemberDelete: {
          const request = desktopAgentTeamMemberDeleteRequestSchema.parse(arg)
          const { member } = await exactAgentMember(request)
          agentTeamMutationResultSchema.parse(
            await this.client.deleteAgentTeamMember({
              teamId: request.teamId,
              memberId: request.memberId,
              mutation: {
                ...agentTeamMutation('agent.team.member.delete', request),
                expectedMemberRevision: request.expectedMemberRevision
              }
            })
          )
          return { handled: true, value: agentTeamMemberMutationResultSchema.parse({ member }) }
        }
        case DESKTOP_IPC.agentAttentionSet: {
          const request = desktopAgentAttentionRequestSchema.parse(arg)
          const session = await ownedAgentSession(
            request.agentSessionId,
            request.expectedSessionRevision
          )
          const catalog = agentCatalogListResultSchema.parse(
            await this.client.listAgentCatalog({ catalogVersion: 1 })
          )
          const existing = catalog.attention.find(
            ({ target }) => target.target.agentSessionId === request.agentSessionId
          )
          if ((existing?.revision ?? null) !== request.expectedAttentionRevision) {
            throw new Error('The agent attention revision is stale')
          }
          return {
            handled: true,
            value: agentAttentionSetResultSchema.parse(
              await this.client.setAgentAttention({
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
          }
        }
        case DESKTOP_IPC.agentCatalogRegister: {
          if (!this.agentRegistrationEnabled)
            throw new Error('Agent registration requires an isolated Codex profile')
          const request = desktopAgentRegisterRequestSchema.parse(arg)
          await this.assertRemotePlacementOwner(windowId, request)
          return {
            handled: true,
            value: agentCatalogRegisterResultSchema.parse(
              await this.client.registerAgentSession({
                catalogVersion: 1,
                binding: {
                  workspaceId: request.workspaceId,
                  paneId: request.paneId,
                  tabId: request.tabId,
                  agentSessionId: request.agentSessionId
                },
                adapterId: 'codex',
                adapterVersion: this.agentAdapterVersion!,
                title: request.title,
                operation: agentOperation('agent.catalog.register', request, 1, 1)
              })
            )
          }
        }
        case DESKTOP_IPC.agentRestoreAssess: {
          if (!this.agentAssessmentEnabled)
            throw new Error('Agent restore assessment is unavailable in this Node sidecar')
          const request = desktopAgentSessionActionSchema.parse(arg)
          const { session } = agentCatalogGetResultSchema.parse(
            await this.client.getAgentSession(request.agentSessionId)
          )
          if (session.revision !== request.expectedRevision)
            throw new Error('The agent session revision is stale')
          await this.assertWorkspaceOwner(windowId, session.binding.workspaceId)
          return {
            handled: true,
            value: agentRestoreAssessResultSchema.parse(
              await this.client.assessAgentRestore({
                agentSessionId: request.agentSessionId,
                operation: agentOperation(
                  'agent.restore.assess',
                  request,
                  session.revision,
                  session.attemptEpoch
                )
              })
            )
          }
        }
        case DESKTOP_IPC.agentSessionRestore: {
          if (!this.agentRegistrationEnabled)
            throw new Error('Agent restore requires an isolated Codex profile')
          const request = desktopAgentSessionActionSchema.parse(arg)
          const { session } = agentCatalogGetResultSchema.parse(
            await this.client.getAgentSession(request.agentSessionId)
          )
          if (session.revision !== request.expectedRevision)
            throw new Error('The agent session revision is stale')
          await this.assertRemotePlacementOwner(windowId, session.binding)
          const previousTerminalId = await this.projectedTerminalId(session.binding)
          const result = agentSessionRestoreResultSchema.parse(
            await this.client.restoreAgentSession({
              agentSessionId: request.agentSessionId,
              operation: agentOperation(
                'agent.session.restore',
                request,
                session.revision,
                session.attemptEpoch
              )
            })
          )
          if (result.outcome === 'resumed' && previousTerminalId) {
            this.retireReplacedTerminal(windowId, previousTerminalId, browser)
          }
          return {
            handled: true,
            value: result
          }
        }
        case DESKTOP_IPC.agentSessionFork: {
          if (!this.agentForkEnabled)
            throw new Error('Agent fork requires an isolated Codex profile and audited provider')
          const request = desktopAgentForkRequestSchema.parse(arg)
          const { session } = agentCatalogGetResultSchema.parse(
            await this.client.getAgentSession(request.agentSessionId)
          )
          if (session.revision !== request.expectedRevision)
            throw new Error('The agent session revision is stale')
          await this.assertRemotePlacementOwner(windowId, session.binding)
          await this.assertRemotePlacementOwner(windowId, request)
          const previousTerminalId = await this.projectedTerminalId(request)
          const result = agentSessionForkResultSchema.parse(
            await this.client.forkAgentSession({
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
                session.revision,
                session.attemptEpoch
              )
            })
          )
          if (previousTerminalId) {
            this.retireReplacedTerminal(windowId, previousTerminalId, browser)
          }
          return {
            handled: true,
            value: result
          }
        }
        case DESKTOP_IPC.remoteTargetList:
          this.assertRemoteDemo()
          return {
            handled: true,
            value: remoteTargetListResultSchema.parse(
              await this.client.listRemoteTargets({ limit: 128, cursor: null })
            )
          }
        case DESKTOP_IPC.remoteTargetEnroll: {
          this.assertRemoteDemo()
          if (!this.remoteEnrollmentEnabled) {
            throw new Error('Remote target enrollment is unavailable in this Node sidecar')
          }
          if (!remoteConfirmation?.pickCredential || !remoteConfirmation.isCurrent()) {
            throw new Error('Remote credential selection is unavailable')
          }
          const draft = desktopRemoteTargetDraftSchema.parse(arg)
          const handle = await remoteConfirmation.pickCredential()
          if (!handle) return { handled: true, value: null }
          try {
            assertPrivateReadOnlyCredentialFd(handle.fd)
            if (!remoteConfirmation.isCurrent()) {
              throw new Error('The remote target window changed')
            }
            const remoteTargetId = randomUUID()
            const enrollmentId = randomUUID()
            await this.client.beginRemoteTargetEnrollment({ remoteTargetId, enrollmentId })
            let commitAttempted = false
            try {
              if ('native' in this.options) {
                await runNativeEnrollmentUtility(
                  this.options,
                  remoteTargetId,
                  enrollmentId,
                  handle.fd
                )
              } else if ('workingPath' in this.options) {
                await runOnlineEnrollmentUtility(
                  this.options,
                  remoteTargetId,
                  enrollmentId,
                  handle.fd
                )
              } else {
                const proof = await this.liveBackupProof()
                await this.enrollLiveRemoteTarget(remoteTargetId, enrollmentId, proof, handle.fd)
              }
              if (!remoteConfirmation.isCurrent()) {
                throw new Error('The remote target window changed')
              }
              const target = {
                remoteTargetId,
                ...draft,
                mutation: remoteMutation('remote.target.create', { remoteTargetId, ...draft }, 0)
              }
              commitAttempted = true
              const committed = remoteTargetResultSchema.parse(
                await this.client.commitRemoteTargetEnrollment({ enrollmentId, target })
              )
              if (
                committed.target.remoteTargetId !== remoteTargetId ||
                committed.target.revision !== 1
              ) {
                throw new Error('Remote target enrollment result changed')
              }
              return {
                handled: true,
                value: committed
              }
            } catch (error) {
              if (this.stopped) {
                throw new Error('Remote target enrollment handoff is pending recovery', {
                  cause: error
                })
              }
              const current = commitAttempted
                ? await this.client.getRemoteTarget(remoteTargetId).catch(() => null)
                : null
              if (
                current?.target.remoteTargetId === remoteTargetId &&
                current.target.label === draft.label &&
                current.target.host === draft.host &&
                current.target.port === draft.port &&
                current.target.user === draft.user &&
                current.target.revision === 1
              ) {
                return { handled: true, value: remoteTargetResultSchema.parse(current) }
              }
              await this.client
                .abortRemoteTargetEnrollment({ remoteTargetId, enrollmentId })
                .catch((cleanupError) =>
                  console.error('[node-sidecar] enrollment cleanup failed', cleanupError)
                )
              throw error
            }
          } finally {
            await handle.close()
          }
        }
        case DESKTOP_IPC.remoteCredentialReplace: {
          this.assertRemoteDemo()
          if (!this.remoteReplacementEnabled)
            throw new Error('Remote credential replacement is unavailable in this Node sidecar')
          if (!remoteConfirmation?.pickCredential || !remoteConfirmation.isCurrent())
            throw new Error('Remote credential selection is unavailable')
          const { remoteTargetId } = desktopRemoteTargetIdentitySchema.parse(arg)
          const before = remoteTargetResultSchema.parse(
            await this.client.getRemoteTarget(remoteTargetId)
          )
          const handle = await remoteConfirmation.pickCredential()
          if (!handle) return { handled: true, value: null }
          try {
            assertPrivateReadOnlyCredentialFd(handle.fd)
            if (!remoteConfirmation.isCurrent()) throw new Error('The remote target window changed')
            const request: RemoteReplacementRequest = {
              remoteTargetId,
              enrollmentId: randomUUID(),
              expectedRevision: before.target.revision
            }
            await this.client.beginRemoteCredentialReplacement(request)
            let commitAttempted = false
            try {
              if ('native' in this.options) {
                await runNativeReplacementUtility(this.options, request, handle.fd)
              } else if ('workingPath' in this.options) {
                await runOnlineReplacementUtility(this.options, request, handle.fd)
              } else {
                const proof = await this.liveBackupProof()
                await this.replaceLiveRemoteCredential(request, proof, handle.fd)
              }
              if (!remoteConfirmation.isCurrent())
                throw new Error('The remote target window changed')
              commitAttempted = true
              const result = remoteTargetResultSchema.parse(
                await this.client.commitRemoteCredentialReplacement(request)
              )
              if (
                result.target.remoteTargetId !== remoteTargetId ||
                result.target.revision !== request.expectedRevision + 1
              )
                throw new Error('Remote credential replacement result changed')
              if (!('workingPath' in this.options)) {
                const observed = remoteTargetResultSchema.parse(
                  await this.client.getRemoteTarget(remoteTargetId)
                )
                if (
                  observed.target.remoteTargetId !== remoteTargetId ||
                  observed.target.revision !== request.expectedRevision + 1
                )
                  throw new Error('Remote credential replacement revision was not observed')
              }
              return { handled: true, value: true }
            } catch (error) {
              if (this.stopped) {
                throw new Error('Remote credential handoff is pending recovery', { cause: error })
              }
              const current = commitAttempted
                ? await this.client.getRemoteTarget(remoteTargetId).catch(() => null)
                : null
              if (current?.target.revision === request.expectedRevision + 1) {
                throw new Error(
                  'Remote credential replacement committed; backup cleanup status is uncertain',
                  { cause: error }
                )
              }
              try {
                await this.client.abortRemoteCredentialReplacement(request)
              } catch (cleanupError) {
                throw new Error('Remote credential rollback is pending recovery', {
                  cause: cleanupError
                })
              }
              throw error
            }
          } finally {
            await handle.close()
          }
        }
        case DESKTOP_IPC.remoteTargetDelete: {
          this.assertRemoteDemo()
          if (!this.remoteDeletionEnabled)
            throw new Error('Remote target deletion is unavailable in this Node sidecar')
          if (!remoteConfirmation || !remoteConfirmation.isCurrent())
            throw new Error('Remote target confirmation is unavailable')
          const request = desktopRemoteTargetDeleteRequestSchema.parse(arg)
          const before = remoteTargetResultSchema.parse(
            await this.client.getRemoteTarget(request.remoteTargetId)
          )
          if (before.target.revision !== request.expectedRevision)
            throw new Error('The remote target revision is stale')
          const messages = desktopMessages.remoteConfirmations.deleteTarget
          const accepted = await remoteConfirmation.confirm({
            title: messages.title,
            message: messages.message,
            detail: messages.detail,
            cancel: desktopMessages.remoteConfirmations.cancel,
            accept: messages.button
          })
          if (!accepted || !remoteConfirmation.isCurrent()) return { handled: true, value: null }
          const current = remoteTargetResultSchema.parse(
            await this.client.getRemoteTarget(request.remoteTargetId)
          )
          if (current.target.revision !== request.expectedRevision)
            throw new Error('The remote target revision changed')
          const deleted = await this.client.deleteRemoteTarget({
            remoteTargetId: request.remoteTargetId,
            mutation: remoteMutation('remote.target.delete', request, request.expectedRevision)
          })
          return { handled: true, value: remoteTargetResultSchema.parse(deleted) }
        }
        case DESKTOP_IPC.remoteSessionList:
          this.assertRemoteDemo()
          return {
            handled: true,
            value: remoteSessionListResultSchema.parse(
              await this.client.listRemoteSessions({ limit: 128, cursor: null })
            )
          }
        case DESKTOP_IPC.remoteSessionConnect: {
          this.assertRemoteDemo()
          const request = desktopRemoteConnectRequestSchema.parse(arg)
          await this.assertRemotePlacementOwner(windowId, request)
          const remoteSessionId = randomUUID()
          let result = remoteSessionResultSchema.parse(
            await this.client.prepareRemoteSession({
              remoteSessionId,
              ...request,
              mutation: remoteMutation('remote.session.connect', { remoteSessionId, ...request }, 0)
            })
          )
          if (result.session.remoteSessionId !== remoteSessionId) {
            throw new Error('Node remote prepare returned a different session')
          }
          if (result.session.state === 'credentialRequired') {
            await this.markRemoteTerminalPending(windowId, result.session)
            result = remoteSessionResultSchema.parse(
              await this.client.activateRemoteSession({
                remoteSessionId,
                mutation: remoteMutation(
                  'remote.session.reconnect',
                  { remoteSessionId, expectedRevision: result.session.revision },
                  result.session.revision
                )
              })
            )
            if (result.session.remoteSessionId !== remoteSessionId) {
              throw new Error('Node remote activation returned a different session')
            }
            if (result.session.state === 'connected') {
              await this.bindRemoteTerminal(windowId, result.session, emitTerminalEvent)
            }
          }
          return { handled: true, value: result }
        }
        case DESKTOP_IPC.remoteHostKeyConfirm: {
          this.assertRemoteDemo()
          if (!remoteConfirmation) throw new Error('Remote confirmation is unavailable')
          const request = desktopRemoteSessionActionSchema.parse(arg)
          return {
            handled: true,
            value: await this.confirmRemoteHostKey(windowId, request, remoteConfirmation)
          }
        }
        case DESKTOP_IPC.remoteTmuxDiscover:
        case DESKTOP_IPC.remoteSessionDetach:
        case DESKTOP_IPC.remoteSessionReconnect:
        case DESKTOP_IPC.remoteSessionClose: {
          this.assertRemoteDemo()
          const request = desktopRemoteSessionActionSchema.parse(arg)
          const initial = remoteSessionResultSchema.parse(
            await this.client.getRemoteSession(request.remoteSessionId)
          ).session
          await this.assertRemotePlacementOwner(windowId, initial)
          if (initial.revision !== request.expectedRevision) {
            throw new Error('The remote session revision is stale')
          }
          const params = {
            remoteSessionId: request.remoteSessionId,
            mutation: remoteMutation(
              channel === DESKTOP_IPC.remoteTmuxDiscover
                ? 'remote.tmux.discover'
                : channel === DESKTOP_IPC.remoteSessionDetach
                  ? 'remote.session.detach'
                  : channel === DESKTOP_IPC.remoteSessionReconnect
                    ? 'remote.session.reconnect'
                    : 'remote.session.close',
              request,
              request.expectedRevision
            )
          }
          if (channel === DESKTOP_IPC.remoteTmuxDiscover) {
            return {
              handled: true,
              value: remoteTmuxDiscoveryResultSchema.parse(
                await this.client.discoverRemoteTmux(params)
              )
            }
          }
          if (channel === DESKTOP_IPC.remoteSessionDetach) {
            const result = remoteSessionResultSchema.parse(
              await this.client.detachRemoteSession(params)
            )
            this.unbindRemoteTerminal(result.session.remoteSessionId, emitTerminalEvent)
            return { handled: true, value: result }
          }
          if (channel === DESKTOP_IPC.remoteSessionReconnect) {
            await this.markRemoteTerminalPending(windowId, initial)
            const result = remoteSessionResultSchema.parse(
              await this.client.activateRemoteSession(params)
            )
            if (result.session.state === 'connected') {
              await this.bindRemoteTerminal(windowId, result.session, emitTerminalEvent)
            }
            return { handled: true, value: result }
          }
          if (!remoteConfirmation) throw new Error('Remote confirmation is unavailable')
          const result = await this.closeRemoteSession(windowId, request, remoteConfirmation)
          if (result) this.unbindRemoteTerminal(result.session.remoteSessionId, emitTerminalEvent)
          return {
            handled: true,
            value: result
          }
        }
        case DESKTOP_IPC.terminalAttach: {
          const attach = (async () => {
            const id = parseCoreTerminalId(arg)
            if (
              this.options &&
              ('remoteDemo' in this.options
                ? this.options.remoteDemo
                : 'remoteTransport' in this.options && this.options.remoteTransport)
            )
              await this.refreshRemoteTerminalBinding(windowId, id)
            await this.assertTerminalOwner(windowId, id)
            this.closedTerminalCheckpoints?.delete(id)
            const actualId = this.remoteTerminalFor(windowId, id)
            const attached = terminalAttachResultSchema.parse(await this.client.attach(actualId))
            const result = terminalAttachResultSchema.parse({
              ...attached,
              terminal: { ...attached.terminal, id }
            })
            await this.subscribeTerminal(id, actualId, windowId, emitTerminalEvent)
            return { handled: true, value: result }
          })()
          const pending = (this.pendingTerminalAttaches ??= new Set())
          pending.add(attach)
          try {
            return await attach
          } finally {
            pending.delete(attach)
          }
        }
        case DESKTOP_IPC.terminalDetach: {
          const id = parseCoreTerminalId(arg)
          if (this.terminalSockets.get(id)?.windowId === windowId) this.detachTerminal(id)
          return { handled: true }
        }
        case DESKTOP_IPC.terminalSend: {
          const id = parseCoreTerminalId(arg)
          await this.assertTerminalOwner(windowId, id)
          if (typeof args[1] !== 'string' || Buffer.byteLength(args[1]) > 256 * 1024)
            throw new Error('Invalid terminal input')
          await this.client.send(this.remoteTerminalFor(windowId, id), Buffer.from(args[1]))
          return { handled: true }
        }
        case DESKTOP_IPC.terminalResize: {
          const id = parseCoreTerminalId(arg)
          const size = terminalCreateParamsSchema
            .pick({ rows: true, cols: true })
            .parse({ rows: args[1], cols: args[2] })
          if (this.wasClosedTerminal(windowId, id)) return { handled: true }
          await this.assertTerminalOwner(windowId, id)
          await this.client.resize(this.remoteTerminalFor(windowId, id), size.rows, size.cols)
          return { handled: true }
        }
        case DESKTOP_IPC.terminalCheckpoint:
          if (this.wasClosedTerminal(windowId, parseCoreTerminalId(arg))) {
            terminalCheckpointSchema.parse(args[1])
            return { handled: true }
          }
          await this.assertTerminalOwner(windowId, parseCoreTerminalId(arg))
          await this.client.checkpoint(
            this.remoteTerminalFor(windowId, parseCoreTerminalId(arg)),
            terminalCheckpointSchema.parse(args[1])
          )
          return { handled: true }
        default:
          if (UNSUPPORTED_NODE_DEMO_CHANNELS.has(channel)) {
            throw new Error('This command is unavailable in the isolated Node demo')
          }
          return { handled: false }
      }
    } catch (error) {
      if (
        channel === DESKTOP_IPC.workspaceRuntimeMetadata &&
        this.stopped &&
        browser?.shuttingDown() &&
        browser.senderCurrent()
      )
        return shutdownMetadata()
      if (error instanceof ServerError) {
        throw new Error(`[agent-workspace-protocol-error:${error.code}] ${error.message}`, {
          cause: error
        })
      }
      throw error
    }
  }

  public releaseWindowResources(windowId: string | undefined): void {
    if (!windowId) return
    // The private owner pipe revokes any automation lease for this exact window.
    // A stopped sidecar closes that pipe and disposes every remaining lease.
    if (!this.stopped && this.ownerChannel)
      void this.revokeWindowCapabilities(windowId).catch(() => undefined)
    this.fileGrants?.delete(windowId)
    for (const [terminalId, closed] of this.closedTerminalCheckpoints ?? []) {
      if (closed.windowId === windowId) this.closedTerminalCheckpoints?.delete(terminalId)
    }
    for (const [projectedId, binding] of this.remoteTerminals) {
      if (binding.windowId === windowId) this.remoteTerminals.delete(projectedId)
    }
    for (const [terminalId, attachment] of this.terminalSockets) {
      if (attachment.windowId === windowId) this.detachTerminal(terminalId)
    }
  }

  /** Quiesce local event delivery while a fenced window close moves its placement. */
  public suspendLocalTerminalEvents(windowId: string, ids: readonly string[]) {
    const attachments = ids.map((id) => {
      if (this.remoteTerminals.has(id))
        throw new Error('Remote terminal rehome requires its own binding transfer')
      const attachment = this.terminalSockets.get(id)
      if (!attachment || attachment.windowId !== windowId || attachment.suspended)
        throw new Error('The Node terminal socket owner changed during rehome')
      return { id, attachment }
    })
    const isCurrent = () =>
      attachments.every(
        ({ id, attachment }) =>
          this.terminalSockets.get(id) === attachment && attachment.suspended === true
      )
    for (const { attachment } of attachments) attachment.suspended = true
    return {
      isCurrent,
      rollback: () => {
        if (!isCurrent()) throw new Error('The Node terminal transfer cannot be restored safely')
        for (const { attachment } of attachments) {
          attachment.suspended = false
          attachment.resync?.()
        }
      },
      finalize: () => {
        if (!isCurrent()) throw new Error('The Node terminal transfer owner changed')
        for (const { id } of attachments) this.detachTerminal(id)
      }
    }
  }

  /** Fence an active remote terminal until its durable tab placement commits. */
  public suspendRemoteTerminalEvents(windowId: string, projectedId: string) {
    const binding = this.remoteTerminals.get(projectedId)
    if (!binding || binding.windowId !== windowId || binding.suspended)
      throw new Error('The Node remote terminal owner changed')
    const attachment = this.terminalSockets.get(projectedId)
    if (attachment && (attachment.windowId !== windowId || attachment.suspended))
      throw new Error('The Node remote terminal socket owner changed')
    binding.suspended = true
    if (attachment) attachment.suspended = true
    const isCurrent = () =>
      this.remoteTerminals.get(projectedId) === binding &&
      binding.suspended === true &&
      (!attachment ||
        (this.terminalSockets.get(projectedId) === attachment && attachment.suspended === true))
    return {
      isCurrent,
      rollback: () => {
        if (!isCurrent()) throw new Error('The remote terminal transfer cannot be restored')
        binding.suspended = false
        if (attachment) {
          attachment.suspended = false
          attachment.resync?.()
        }
      },
      finalize: (targetWindowId: string) => {
        if (!isCurrent()) throw new Error('The remote terminal transfer owner changed')
        if (attachment) this.detachTerminal(projectedId)
        this.remoteTerminals.set(projectedId, {
          remoteSessionId: binding.remoteSessionId,
          ...(binding.terminalId ? { terminalId: binding.terminalId } : {}),
          windowId: targetWindowId
        })
      }
    }
  }

  public isRemoteTerminalBinding(terminalId: string): boolean {
    return this.remoteTerminals.has(terminalId)
  }

  public localTerminalSocketOwner(terminalId: string): string | undefined {
    return this.terminalSockets.get(terminalId)?.windowId
  }

  private grantsForWindow(windowId: string) {
    this.fileGrants ??= new Map()
    let grants = this.fileGrants.get(windowId)
    if (!grants) {
      grants = { descriptors: new Map(), documents: new Map() }
      this.fileGrants.set(windowId, grants)
    }
    return grants
  }

  private grantDescriptor(
    grants: ReturnType<NodeSidecar['grantsForWindow']>,
    id: string,
    descriptor: { workspaceId: string; generation: number; kind: 'directory' | 'file' }
  ): void {
    if (!grants.descriptors.has(id) && grants.descriptors.size >= MAX_FILE_DESCRIPTORS_PER_WINDOW) {
      throw new Error('The Files descriptor grant limit was reached')
    }
    grants.descriptors.set(id, descriptor)
  }

  private async assertFileDescriptorOwner(
    windowId: string,
    descriptorId: string,
    generation: number,
    kind: 'directory' | 'file'
  ) {
    const descriptor = this.fileGrants?.get(windowId)?.descriptors.get(descriptorId)
    if (!descriptor || descriptor.generation !== generation || descriptor.kind !== kind) {
      throw new Error('The Files descriptor is unavailable in this window')
    }
    await this.assertWorkspaceOwner(windowId, descriptor.workspaceId)
    return descriptor
  }

  private async assertFileDocumentOwner(
    windowId: string,
    document: { documentId: string; identityVersion: number }
  ): Promise<string> {
    const granted = this.fileGrants?.get(windowId)?.documents.get(document.documentId)
    if (!granted || granted.identityVersion !== document.identityVersion) {
      throw new Error('The Files document is unavailable in this window')
    }
    await this.assertWorkspaceOwner(windowId, granted.workspaceId)
    return granted.workspaceId
  }

  private async assertWorkspaceOwner(windowId: string, workspaceId: string): Promise<void> {
    const { snapshot } = await this.client.stateSnapshot()
    const placement = snapshot.windowPlacements.find(({ id }) => id === windowId)
    if (!placement?.workspaceIds.includes(workspaceId)) {
      throw new Error('The workspace is unavailable in this window')
    }
  }

  private async assertOnlyLayoutWindow(windowId: string) {
    const topology = await this.listWindowsForTrustedOwner(windowId)
    if (topology.windows.length !== 1 || topology.windows[0]?.windowId !== windowId) {
      throw new Error('Saved layouts require the sole hosted window')
    }
    const [global, owned] = await Promise.all([
      this.client.listWorkspaces(),
      this.listWorkspacesForTrustedOwner(windowId)
    ])
    const globalIds = global.snapshot.workspaces.map(({ id }) => id).sort()
    const ownedIds = owned.snapshot.workspaces.map(({ id }) => id).sort()
    if (!isDeepStrictEqual(globalIds, ownedIds)) {
      throw new Error('Saved layouts include workspaces outside this window')
    }
    return owned
  }

  private async assertTerminalOwner(windowId: string, terminalId: string): Promise<void> {
    const remote = this.remoteTerminals.get(terminalId)
    if (remote) {
      if (remote.windowId !== windowId || remote.suspended)
        throw new Error('The terminal is unavailable in this window')
      return
    }
    const { snapshot } = workspaceListResultSchema.parse(await this.client.listWorkspaces())
    const workspace = snapshot.workspaces.find((item) =>
      item.tabs.some(
        (tab) => tab.content.kind === 'terminal' && tab.content.runtimeSessionId === terminalId
      )
    )
    if (!workspace) throw new Error('The terminal is unavailable in this window')
    await this.assertWorkspaceOwner(windowId, workspace.id)
  }

  private rememberClosedTerminal(windowId: string, terminalId: string): void {
    const closed = (this.closedTerminalCheckpoints ??= new Map())
    closed.delete(terminalId)
    closed.set(terminalId, {
      windowId,
      expiresAtMs: Date.now() + CLOSED_TERMINAL_CHECKPOINT_MS
    })
    if (closed.size > MAX_CLOSED_TERMINAL_CHECKPOINTS) {
      const oldest = closed.keys().next().value
      if (oldest) closed.delete(oldest)
    }
  }

  private retireReplacedTerminal(
    windowId: string,
    terminalId: string,
    browser?: { terminalDetached(terminalId: string): void }
  ): void {
    this.detachTerminal(terminalId)
    this.rememberClosedTerminal(windowId, terminalId)
    browser?.terminalDetached(terminalId)
  }

  private wasClosedTerminal(windowId: string, terminalId: string): boolean {
    const closed = this.closedTerminalCheckpoints?.get(terminalId)
    if (!closed) return false
    if (closed.expiresAtMs <= Date.now()) {
      this.closedTerminalCheckpoints?.delete(terminalId)
      return false
    }
    return closed.windowId === windowId
  }

  private assertRemoteDemo(): void {
    if (
      !this.options ||
      (!('remoteDemo' in this.options && this.options.remoteDemo) &&
        !('remoteTransport' in this.options && this.options.remoteTransport))
    ) {
      throw new Error('Remote sessions are unavailable outside the isolated Node demo')
    }
  }

  private async assertRemotePlacementOwner(
    windowId: string,
    placement: { workspaceId: string; paneId: string; tabId: string }
  ): Promise<void> {
    await this.assertWorkspaceOwner(windowId, placement.workspaceId)
    const { snapshot } = workspaceListResultSchema.parse(await this.client.listWorkspaces())
    const workspace = snapshot.workspaces.find(({ id }) => id === placement.workspaceId)
    const pane = workspace?.panes.find(({ id }) => id === placement.paneId)
    const tab = workspace?.tabs.find(({ id }) => id === placement.tabId)
    if (!pane || !tab || !pane.tabIds.includes(tab.id) || tab.content.kind !== 'terminal') {
      throw new Error('The remote terminal placement is unavailable in this window')
    }
  }

  private async projectedTerminalId(placement: {
    workspaceId: string
    paneId: string
    tabId: string
  }): Promise<string | undefined> {
    const { snapshot } = workspaceListResultSchema.parse(await this.client.listWorkspaces())
    const workspace = snapshot.workspaces.find(({ id }) => id === placement.workspaceId)
    const pane = workspace?.panes.find(({ id }) => id === placement.paneId)
    const tab = workspace?.tabs.find(({ id }) => id === placement.tabId)
    if (!pane?.tabIds.includes(placement.tabId) || tab?.content.kind !== 'terminal') return
    return tab.content.runtimeSessionId ?? undefined
  }

  private async bindRemoteTerminal(
    windowId: string,
    session: { remoteSessionId: string; workspaceId: string; paneId: string; tabId: string },
    emit: (event: unknown) => void
  ): Promise<void> {
    const projectedId = await this.projectedTerminalId(session)
    if (!projectedId) throw new Error('The remote terminal has no visible pane binding')
    this.assertRemoteBindingWritable(windowId, projectedId)
    this.remoteTerminals.set(projectedId, {
      remoteSessionId: session.remoteSessionId,
      windowId
    })
    const { terminalId } = await this.client.getRemoteTerminal(session.remoteSessionId)
    this.assertRemoteBindingWritable(windowId, projectedId)
    this.remoteTerminals.set(projectedId, {
      remoteSessionId: session.remoteSessionId,
      terminalId,
      windowId
    })
    this.detachTerminal(projectedId)
    emit({ event: 'terminal.resyncRequired', data: { terminalId: projectedId } })
  }

  private async markRemoteTerminalPending(
    windowId: string,
    session: { remoteSessionId: string; workspaceId: string; paneId: string; tabId: string }
  ): Promise<void> {
    const projectedId = await this.projectedTerminalId(session)
    if (!projectedId) return
    this.assertRemoteBindingWritable(windowId, projectedId)
    this.remoteTerminals.set(projectedId, { remoteSessionId: session.remoteSessionId, windowId })
    this.detachTerminal(projectedId)
  }

  private unbindRemoteTerminal(remoteSessionId: string, emit: (event: unknown) => void): void {
    for (const [projectedId, binding] of this.remoteTerminals) {
      if (binding.remoteSessionId !== remoteSessionId) continue
      this.remoteTerminals.delete(projectedId)
      this.detachTerminal(projectedId)
      emit({ event: 'terminal.resyncRequired', data: { terminalId: projectedId } })
    }
  }

  private remoteTerminalFor(windowId: string, projectedId: string): string {
    const binding = this.remoteTerminals.get(projectedId)
    if (binding && (binding.windowId !== windowId || binding.suspended)) {
      throw new Error('The remote terminal is unavailable in this window')
    }
    if (binding && !binding.terminalId) {
      throw new Error('The active remote terminal binding is unavailable')
    }
    return binding?.terminalId ?? projectedId
  }

  private assertRemoteBindingWritable(windowId: string, projectedId: string): void {
    const binding = this.remoteTerminals.get(projectedId)
    if (binding && (binding.windowId !== windowId || binding.suspended))
      throw new Error('The remote terminal binding changed during transfer')
  }

  private async refreshRemoteTerminalBinding(windowId: string, projectedId: string): Promise<void> {
    this.assertRemoteBindingWritable(windowId, projectedId)
    const { sessions } = remoteSessionListResultSchema.parse(
      await this.client.listRemoteSessions({ limit: 128, cursor: null })
    )
    const connected = sessions.filter((session) => session.state === 'connected')
    for (const session of connected) {
      if ((await this.projectedTerminalId(session)) !== projectedId) continue
      await this.assertRemotePlacementOwner(windowId, session)
      this.assertRemoteBindingWritable(windowId, projectedId)
      this.remoteTerminals.set(projectedId, {
        remoteSessionId: session.remoteSessionId,
        windowId
      })
      const { terminalId } = await this.client.getRemoteTerminal(session.remoteSessionId)
      this.assertRemoteBindingWritable(windowId, projectedId)
      this.remoteTerminals.set(projectedId, {
        remoteSessionId: session.remoteSessionId,
        terminalId,
        windowId
      })
      return
    }
    this.assertRemoteBindingWritable(windowId, projectedId)
    this.remoteTerminals.delete(projectedId)
  }

  private serializeRemoteConfirmation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.remoteConfirmations.get(key)
    if (existing) return existing as Promise<T>
    const pending = operation().finally(() => this.remoteConfirmations.delete(key))
    this.remoteConfirmations.set(key, pending)
    return pending
  }

  private confirmRemoteHostKey(
    windowId: string,
    request: { remoteSessionId: string; expectedRevision: number },
    confirmation: RemoteConfirmation
  ) {
    return this.serializeRemoteConfirmation(
      `host-key:${request.remoteSessionId}:${request.expectedRevision}`,
      async () => {
        const initial = remoteSessionResultSchema.parse(
          await this.client.getRemoteSession(request.remoteSessionId)
        ).session
        await this.assertRemotePlacementOwner(windowId, initial)
        if (initial.revision !== request.expectedRevision) {
          throw new Error('The remote session revision is stale')
        }
        const challenge = remoteHostKeyChallengeSchema.parse(
          await this.client.scanRemoteHostKey({
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
        const target = remoteTargetResultSchema.parse(
          await this.client.getRemoteTarget(initial.remoteTargetId)
        ).target
        if (
          target.revision !== challenge.targetRevision ||
          !['untrusted', 'changed', 'revoked'].includes(target.hostKeyState)
        ) {
          throw new Error('The remote target revision or trust state is stale')
        }
        const messages =
          target.hostKeyState === 'untrusted'
            ? desktopMessages.remoteConfirmations.trustHostKey
            : desktopMessages.remoteConfirmations.replaceHostKey
        const trust = await confirmation.confirm({
          title: messages.title,
          message: messages.message,
          detail: `Host: ${challenge.canonicalHost}:${String(challenge.port)}\nAlgorithm: ${challenge.algorithm}\nFingerprint: ${challenge.presentedFingerprint}`,
          cancel: messages.reject,
          accept: messages.trust
        })
        const [current, currentTarget] = await Promise.all([
          this.client.getRemoteSession(request.remoteSessionId),
          this.client.getRemoteTarget(initial.remoteTargetId)
        ])
        if (
          !confirmation.isCurrent() ||
          current.session.revision !== initial.revision ||
          current.session.attemptGeneration !== initial.attemptGeneration ||
          current.session.remoteTargetId !== initial.remoteTargetId ||
          currentTarget.target.revision !== target.revision ||
          currentTarget.target.hostKeyState !== target.hostKeyState
        ) {
          throw new Error('The remote session, target, or desktop authority is stale')
        }
        const params = {
          remoteSessionId: challenge.remoteSessionId,
          promptId: challenge.promptId,
          attemptGeneration: challenge.attemptGeneration,
          presentedFingerprint: challenge.presentedFingerprint,
          decision: trust ? ('trust' as const) : ('reject' as const)
        }
        return remoteSessionResultSchema.parse(
          await this.client.decideRemoteHostKey({
            ...params,
            mutation: remoteMutation('remote.hostKey.decide', params, challenge.targetRevision)
          })
        )
      }
    )
  }

  private closeRemoteSession(
    windowId: string,
    request: { remoteSessionId: string; expectedRevision: number },
    confirmation: RemoteConfirmation
  ) {
    return this.serializeRemoteConfirmation(
      `session:${request.remoteSessionId}:${request.expectedRevision}`,
      async () => {
        const initial = remoteSessionResultSchema.parse(
          await this.client.getRemoteSession(request.remoteSessionId)
        ).session
        await this.assertRemotePlacementOwner(windowId, initial)
        if (initial.revision !== request.expectedRevision) {
          throw new Error('The remote session revision is stale')
        }
        const messages = desktopMessages.remoteConfirmations.closeSession
        const accepted = await confirmation.confirm({
          title: messages.title,
          message: messages.message,
          detail: messages.detail,
          cancel: desktopMessages.remoteConfirmations.cancel,
          accept: messages.button
        })
        if (!accepted || !confirmation.isCurrent()) return null
        const current = remoteSessionResultSchema.parse(
          await this.client.getRemoteSession(request.remoteSessionId)
        ).session
        if (current.revision !== request.expectedRevision) {
          throw new Error('The remote session revision is stale')
        }
        return remoteSessionResultSchema.parse(
          await this.client.closeRemoteSession({
            remoteSessionId: request.remoteSessionId,
            mutation: remoteMutation('remote.session.close', request, request.expectedRevision)
          })
        )
      }
    )
  }

  private async assertNotificationOwner(windowId: string, notificationId: string): Promise<void> {
    const { snapshot } = await this.client.stateSnapshot()
    const placement = snapshot.windowPlacements.find(({ id }) => id === windowId)
    const notification = snapshot.notifications.find(({ id }) => id === notificationId)
    if (!notification || !placement?.workspaceIds.includes(notification.workspaceId)) {
      throw new Error('The notification is unavailable in this window')
    }
  }

  private subscribeTerminal(
    id: string,
    actualId: string,
    windowId: string,
    emit: (event: unknown) => void
  ): Promise<void> {
    this.detachTerminal(id)
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(this.client.eventsUrl(actualId), {
        headers: this.client.authorizationHeader()
      })
      const attachment = {
        socket,
        windowId,
        suspended: false,
        resync: () => emit({ event: 'terminal.resyncRequired', data: { terminalId: id } })
      }
      this.terminalSockets.set(id, attachment)
      let opened = false
      socket.once('open', () => {
        opened = true
        resolveOpen()
      })
      socket.on('message', (data) => {
        try {
          if (this.terminalSockets.get(id) !== attachment || attachment.suspended) return
          const event = parseTerminalEvent(socketText(data))
          if (event.event !== 'terminal.attached') {
            const parsed = terminalEventSchema.parse(event)
            emit(
              terminalEventSchema.parse({
                ...parsed,
                data: { ...parsed.data, terminalId: id }
              })
            )
          }
        } catch {
          socket.close()
        }
      })
      socket.once('error', () => {
        if (!opened) rejectOpen(new Error('Node terminal event stream failed to open'))
      })
      socket.once('close', () => {
        if (this.terminalSockets.get(id)?.socket !== socket) return
        this.terminalSockets.delete(id)
        if (!opened) rejectOpen(new Error('Node terminal event stream closed before attach'))
        else if (!attachment.suspended) attachment.resync?.()
      })
    })
  }

  private detachTerminal(id: string): void {
    const attachment = this.terminalSockets.get(id)
    if (!attachment) return
    this.terminalSockets.delete(id)
    attachment.socket.close()
  }

  /** Main-only Linux handoff for an existing target in this isolated copy. Never pass key bytes. */
  public async enrollExistingRemoteCredential(
    targetId: string,
    expectedRevision: number,
    credentialFd: number
  ): Promise<{ status: 'stored'; targetId: string; revision: number }> {
    if (!('workingPath' in this.options)) {
      throw new Error('Node live sidecar cannot use isolated credential handoff')
    }
    if (this.handoff || this.stopped) throw new Error('Node sidecar is unavailable for enrollment')
    if (this.workspaceEventSink) {
      throw new Error('Node credential handoff requires the desktop core demo to be stopped')
    }
    if (
      process.platform !== 'linux' ||
      !UUID.test(targetId) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    ) {
      throw new Error('Node credential enrollment request is invalid')
    }
    assertPrivateReadOnlyCredentialFd(credentialFd)
    const target = await this.client.getRemoteTarget(targetId)
    if (target.target.revision !== expectedRevision) {
      throw new Error('Node remote target revision is stale')
    }
    const handoff = this.runCredentialHandoff(targetId, expectedRevision, credentialFd)
    this.handoff = handoff
    try {
      return await handoff
    } finally {
      this.handoff = undefined
    }
  }

  private async runCredentialHandoff(
    targetId: string,
    expectedRevision: number,
    credentialFd: number
  ) {
    if (!('workingPath' in this.options)) {
      throw new Error('Node live sidecar cannot use isolated credential handoff')
    }
    const options = this.options
    this.stopped = true
    this.ownerChannel.close()
    await stopChild(this.child)
    await assertOwnerLockReleased(options.workingPath)
    let result: { status: 'stored'; targetId: string; revision: number }
    try {
      result = await runEnrollmentUtility(options, targetId, expectedRevision, credentialFd)
    } catch (error) {
      await assertOwnerLockReleased(options.workingPath)
      throw error instanceof Error ? error : new Error('Node credential enrollment failed')
    }
    // A failed utility must release its lock before the server can reclaim the copy.
    await assertOwnerLockReleased(options.workingPath)
    const resumed = await NodeSidecar.start({ ...options, resumeCopy: true })
    try {
      const target = await resumed.client.getRemoteTarget(targetId)
      if (target.target.revision !== expectedRevision + 1) {
        throw new Error('Node credential revision did not advance after enrollment')
      }
    } catch (error) {
      await resumed.stop()
      throw error
    }
    this.child = resumed.child
    this.ownerChannel = resumed.ownerChannel
    this.client = resumed.client
    this.baseUrl = resumed.baseUrl
    this.taskListEnabled = resumed.taskListEnabled
    this.taskActionsEnabled = resumed.taskActionsEnabled
    this.stopped = false
    return result
  }

  /** Transfer a reserved live v1 replacement through the two Linux owner fences. */
  private async replaceLiveRemoteCredential(
    request: RemoteReplacementRequest,
    proof: LiveBackupProof,
    credentialFd: number
  ): Promise<void> {
    if ('workingPath' in this.options || 'native' in this.options || this.stopped || this.handoff) {
      throw new Error('Node live credential handoff is unavailable')
    }
    const options = this.options
    const eventSink = this.workspaceEventSink
    const shutdown = this.stop()
    const handoff = (async () => {
      await shutdown
      await assertLiveOwnerLocksReleased(options.liveDatabasePath)
      let utilityError: unknown
      try {
        await runLiveReplacementUtility(options, request, proof, credentialFd)
      } catch (error) {
        utilityError = error
      }
      await assertLiveOwnerLocksReleased(options.liveDatabasePath)
      const resumed = await NodeSidecar.startLive(options, proof, request)
      try {
        if (!resumed.remoteReplacementEnabled) {
          throw new Error('Node live replacement capability changed during handoff')
        }
        const current = remoteTargetResultSchema.parse(
          await resumed.client.getRemoteTarget(request.remoteTargetId)
        )
        if (
          current.target.remoteTargetId !== request.remoteTargetId ||
          current.target.revision !== request.expectedRevision
        ) {
          throw new Error('Node live credential handoff changed the target revision')
        }
      } catch (error) {
        await resumed.stop()
        throw error
      }
      await this.adoptResumedLiveSidecar(resumed, eventSink)
      if (utilityError) {
        throw utilityError instanceof Error
          ? utilityError
          : new Error('Node live credential replacement failed')
      }
    })()
    this.handoff = handoff
    try {
      await handoff
    } finally {
      this.handoff = undefined
    }
  }

  /** Publish a new target only after the offline v2 wallet write and exact live resume. */
  private async enrollLiveRemoteTarget(
    targetId: string,
    enrollmentId: string,
    proof: LiveBackupProof,
    credentialFd: number
  ): Promise<void> {
    if ('workingPath' in this.options || 'native' in this.options || this.stopped || this.handoff) {
      throw new Error('Node live credential handoff is unavailable')
    }
    const options = this.options
    const eventSink = this.workspaceEventSink
    const shutdown = this.stop()
    const handoff = (async () => {
      await shutdown
      await assertLiveOwnerLocksReleased(options.liveDatabasePath)
      let utilityError: unknown
      try {
        await runLiveEnrollmentUtility(options, targetId, enrollmentId, proof, credentialFd)
      } catch (error) {
        utilityError = error
      }
      await assertLiveOwnerLocksReleased(options.liveDatabasePath)
      const resumed = await NodeSidecar.startLive(options, proof, undefined, {
        targetId,
        enrollmentId
      })
      try {
        if (!resumed.remoteEnrollmentEnabled) {
          throw new Error('Node live enrollment capability changed during handoff')
        }
        try {
          await resumed.client.getRemoteTarget(targetId)
          throw new Error('Node live enrollment published a target before commit')
        } catch (error) {
          if (!(error instanceof ServerError && error.status === 404)) throw error
        }
      } catch (error) {
        await resumed.stop()
        throw error
      }
      await this.adoptResumedLiveSidecar(resumed, eventSink)
      if (utilityError) {
        throw utilityError instanceof Error
          ? utilityError
          : new Error('Node live target enrollment failed')
      }
    })()
    this.handoff = handoff
    try {
      await handoff
    } finally {
      this.handoff = undefined
    }
  }

  private async adoptResumedLiveSidecar(
    resumed: NodeSidecar,
    eventSink: typeof this.workspaceEventSink
  ): Promise<void> {
    this.child = resumed.child
    this.ownerChannel = resumed.ownerChannel
    this.client = resumed.client
    this.baseUrl = resumed.baseUrl
    this.taskListEnabled = resumed.taskListEnabled
    this.taskActionsEnabled = resumed.taskActionsEnabled
    this.stopped = false
    if (!eventSink) return
    try {
      await this.startWorkspaceEvents(eventSink)
    } catch (error) {
      this.stopped = true
      this.workspaceEventSocket?.close()
      this.workspaceEventSocket = undefined
      this.workspaceEventSink = undefined
      this.ownerChannel.close()
      await stopChild(this.child)
      throw error
    }
  }

  /** Call only with the current WindowRegistry.resolveSender(event) entry in Electron main. */
  public issueWindowCapabilityForTrustedOwner(windowId: string): Promise<string> {
    if (this.stopped) return Promise.reject(new Error('Node sidecar is stopped'))
    return this.ownerChannel.issueForTrustedOwner(windowId)
  }

  public async liveBackupProof(): Promise<LiveBackupProof> {
    if (this.stopped) return Promise.reject(new Error('Node sidecar is stopped'))
    const proof = await this.ownerChannel.liveBackupProof()
    if (
      'workingPath' in this.options ||
      proof.liveStatePath !== this.options.liveDatabasePath ||
      proof.backupStatePath !== this.options.backupPath
    ) {
      throw new Error('Node live backup proof does not match the owned paths')
    }
    return proof
  }

  /** Exact sender and current generation are verified by Electron main at each call. */
  public reconcileHostingForTrustedOwner(
    operation: 'registerHosting' | 'heartbeatHosting' | 'revokeHosting',
    windowId: string,
    windowGeneration: number
  ): Promise<number> {
    if (this.stopped) return Promise.reject(new Error('Node sidecar is stopped'))
    return this.ownerChannel.hosting(operation, windowId, windowGeneration)
  }

  /** Main must pass a current WindowRegistry entry, not renderer supplied identifiers. */
  public registerAutomationProviderForTrustedOwner(
    windowId: string,
    windowGeneration: number
  ): Promise<DesktopProviderIdentityParams> {
    if (this.stopped) return Promise.reject(new Error('Node sidecar is stopped'))
    return this.ownerChannel.registerAutomationProviderForTrustedOwner(windowId, windowGeneration)
  }

  public revokeAutomationProviderForTrustedOwner(
    windowId: string,
    windowGeneration: number,
    identity: DesktopProviderIdentityParams
  ): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Node sidecar is stopped'))
    return this.ownerChannel.revokeAutomationProvider(windowId, windowGeneration, identity)
  }

  /** Hibernation uses this sidecar's catalog and in-process PTY, scoped to one hosted window. */
  public agentHibernationClientForTrustedOwner(windowId: string) {
    const session = async (agentSessionId: string) => {
      if (this.stopped || !this.agentHibernationEnabled)
        throw new Error('Node agent catalog is unavailable')
      return agentCatalogGetResultSchema.parse(await this.client.getAgentSession(agentSessionId))
    }
    const assertSession = async (agentSessionId: string) => {
      const result = await session(agentSessionId)
      await this.assertWorkspaceOwner(windowId, result.session.binding.workspaceId)
    }
    return {
      getAgentSession: ({ agentSessionId }: { agentSessionId: string }) => session(agentSessionId),
      preflightAgentHibernation: async (
        request: Parameters<AgentWorkspaceClient['preflightAgentHibernation']>[0]
      ) => {
        await assertSession(request.agentSessionId)
        return this.client.preflightAgentHibernation(request)
      },
      cancelAgentHibernation: async (
        request: Parameters<AgentWorkspaceClient['cancelAgentHibernation']>[0]
      ) => this.client.cancelAgentHibernation(request),
      confirmAgentHibernation: async (
        request: Parameters<AgentWorkspaceClient['confirmAgentHibernation']>[0]
      ) => {
        await assertSession(request.agentSessionId)
        return this.client.confirmAgentHibernation(request)
      }
    }
  }

  public pollBrowserAutomation(
    params: BrowserAutomationProviderPollParams,
    signal: AbortSignal
  ): Promise<BrowserAutomationProviderPollResult> {
    return this.automationProviderRequest(
      'poll',
      browserAutomationProviderPollParamsSchema.parse(params),
      browserAutomationProviderPollResultSchema,
      signal
    ) as Promise<BrowserAutomationProviderPollResult>
  }

  public acknowledgeBrowserAutomation(
    params: BrowserAutomationProviderAcknowledgeParams
  ): Promise<BrowserAutomationProviderAcknowledgeResult> {
    return this.automationProviderRequest(
      'acknowledge',
      browserAutomationProviderAcknowledgeParamsSchema.parse(params),
      browserAutomationProviderAcknowledgeResultSchema
    ) as Promise<BrowserAutomationProviderAcknowledgeResult>
  }

  public respondBrowserAutomationTransfer(
    params: BrowserAutomationProviderTransferRespondParams
  ): Promise<void> {
    return this.automationProviderRequest(
      'transfer-respond',
      browserAutomationProviderTransferRespondParamsSchema.parse(params),
      emptyParamsSchema
    ).then(() => undefined)
  }

  private async automationProviderRequest<T>(
    operation: 'poll' | 'acknowledge' | 'transfer-respond',
    body: unknown,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal
  ): Promise<T> {
    if (this.stopped) throw new Error('Node sidecar is stopped')
    const response = await fetch(
      new URL(`/v1/browser-automation/provider/${operation}`, this.baseUrl),
      {
        method: 'POST',
        headers: { ...this.client.authorizationHeader(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {})
      }
    )
    if (!response.ok)
      throw new Error(`Node automation provider ${operation} failed (${response.status})`)
    return schema.parse(await response.json())
  }

  public revokeWindowCapability(capability: string): Promise<void> {
    return this.ownerChannel.revoke(capability)
  }

  public revokeWindowCapabilities(windowId: string): Promise<void> {
    return this.ownerChannel.revokeWindow(windowId)
  }

  /** Main calls this only after WindowRegistry.resolveSender(event) returns the current entry. */
  public async listTasksForTrustedOwner(
    windowId: string,
    request: Parameters<AgentWorkspaceClient['listTasksBound']>[0]
  ) {
    return this.withWindowCapability(windowId, (capability) =>
      this.client.listTasksBound(request, capability)
    )
  }

  /** Only a task in this isolated copy may be detached through its bound owner window. */
  public async detachRemoteTaskForTrustedOwner(
    windowId: string,
    request: Extract<Parameters<AgentWorkspaceClient['taskActionBound']>[0], { action: 'detach' }>
  ) {
    if (!this.taskActionsEnabled) throw new Error('Node task actions are unavailable')
    return this.withWindowCapability(windowId, async (capability) => {
      let cursor: string | undefined
      const visitedCursors = new Set<string>()
      for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
        const page = await this.client.listTasksBound(
          {
            kind: 'remoteSession',
            limit: 100,
            cancellationId: randomUUID(),
            ...(cursor ? { cursor } : {})
          },
          capability
        )
        const found = page.tasks.some(
          (task) =>
            task.kind === 'remoteSession' &&
            task.target.sessionId === request.target.sessionId &&
            task.target.generation === request.target.generation &&
            task.target.revision === request.target.revision
        )
        if (found) return this.client.taskActionBound(request, capability)
        cursor = page.nextCursor ?? undefined
        if (!cursor) break
        if (visitedCursors.has(cursor)) throw new Error('The Node task list cursor repeated')
        visitedCursors.add(cursor)
      }
      throw new Error('Remote task is unavailable in the Node copy')
    })
  }

  /** Keep a destructive task confirmation bound to the current Electron window. */
  public async actOnTaskForTrustedOwner(
    windowId: string,
    windowGeneration: number,
    rawRequest: DesktopTaskActionRequest,
    confirm: () => Promise<boolean>
  ) {
    if (!this.taskActionsEnabled) throw new Error('Node task actions are unavailable')
    const request = desktopTaskActionRequestSchema.parse(rawRequest)
    if (request.action === 'detach') throw new Error('Detach uses the direct task action')
    if (!Number.isSafeInteger(windowGeneration) || windowGeneration < 1)
      throw new Error('Task action window generation is invalid')
    return this.withWindowCapability(windowId, async (capability) => {
      const bound = await this.client.getBoundWindow(capability)
      if (bound.window.windowId !== windowId) throw new Error('Task action window binding changed')
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            action: request.action,
            target: request.target,
            windowId,
            windowGeneration
          })
        )
        .digest('hex')
      const issued = await this.client.issueTaskConfirmationBound(
        {
          action: request.action,
          target: request.target,
          window: { windowId, windowGeneration },
          requestHash
        },
        capability
      )
      if (!(await confirm())) return null
      if (this.stopped) throw new Error('Node task owner changed')
      if (
        issued.confirmation.windowId !== windowId ||
        issued.confirmation.windowGeneration !== windowGeneration
      ) {
        throw new Error('Task confirmation window changed')
      }
      return taskActionResultSchema.parse(
        await this.client.taskActionBound(
          {
            action: request.action,
            target: request.target,
            confirmation: issued.confirmation,
            mutation: {
              idempotencyKey: randomUUID(),
              requestHash,
              expectedRevision: request.target.revision
            }
          },
          capability
        )
      )
    })
  }

  /** Main calls this only for a current sender-resolved WindowRegistry entry. */
  public async listWindowsForTrustedOwner(windowId: string): Promise<WindowListResult> {
    return this.withWindowCapability(windowId, async (capability) => {
      const bound = await this.client.getBoundWindow(capability)
      if (bound.window.windowId !== windowId) throw new Error('Node window binding changed')
      const topology = await this.client.listWindows()
      const current = topology.windows.find((window) => window.windowId === windowId)
      if (!current || !isDeepStrictEqual(current, bound.window)) {
        throw new Error('Node window topology changed during the bound read')
      }
      return topology
    })
  }

  public getWindowStateForTrustedOwner(windowId: string) {
    return this.withWindowCapability(windowId, (capability) =>
      this.client.getWindowStateFor({ windowId }, capability)
    )
  }

  /** Startup uses an ID from the Node placement list before a native window is registered. */
  public async getWindowStateForTrustedPlacement(windowId: string) {
    const topology = await this.client.listWindows()
    if (!topology.windows.some((placement) => placement.windowId === windowId)) {
      throw new Error('Node window placement is unavailable')
    }
    return this.getWindowStateForTrustedOwner(windowId)
  }

  public updateWindowStateForTrustedOwner(windowId: string, state: WindowStateSnapshot) {
    return this.withWindowCapability(windowId, (capability) =>
      this.client.updateWindowStateFor({ windowId, state }, capability)
    )
  }

  /** Adapts the exact-window desktop close to the isolated copy's durable tab close. */
  public async closeTabForTrustedOwner(
    windowId: string,
    input: TabCloseAdvancedParams,
    browserViews: BrowserViewManager,
    browserDetached: (browserSessionId: string) => void,
    terminalDetached: (terminalId: string) => void
  ) {
    const params = tabCloseAdvancedParamsSchema.parse(input)
    if (params.source.windowId !== windowId) throw new Error('The tab source window changed')
    const topology = await this.listWindowsForTrustedOwner(windowId)
    const owner = topology.windows.find((window) => window.windowId === windowId)
    if (
      !owner ||
      topology.revision !== params.mutation.expectedRevision ||
      topology.idempotencyEpoch !== params.mutation.idempotencyEpoch ||
      owner.revision !== params.source.expectedWindowRevision ||
      !owner.workspaceIds.includes(params.source.workspaceId)
    )
      throw new Error('The Node window topology changed')
    const { snapshot } = await this.listWorkspacesForTrustedOwner(windowId)
    const workspace = snapshot.workspaces.find((item) => item.id === params.source.workspaceId)
    const tab = workspace?.tabs.find((item) => item.id === params.source.tabId)
    if (!tab || tab.paneId !== params.source.paneId) {
      throw new Error('The tab is unavailable in this window')
    }
    const result = await this.client.closeTab({
      workspaceId: params.source.workspaceId,
      tabId: params.source.tabId,
      ...params.mutation
    })
    if (!result.replayed) {
      if (tab.content.kind === 'browser') {
        browserViews.destroySession({ browserSessionId: tab.content.state.browserSessionId })
        browserDetached(tab.content.state.browserSessionId)
      } else if (tab.content.runtimeSessionId) {
        this.detachTerminal(tab.content.runtimeSessionId)
        terminalDetached(tab.content.runtimeSessionId)
      }
    }
    return advancedTabCloseResultSchema.parse({
      revision: result.revision,
      idempotencyEpoch: params.mutation.idempotencyEpoch,
      closedTabId: params.source.tabId,
      closedItemId: result.closedItemId,
      replayed: result.replayed
    })
  }

  public listClosedItemsForTrustedOwner(windowId: string) {
    return this.withWindowCapability(windowId, (capability) =>
      this.client.listClosedItems(capability)
    )
  }

  public getClosedItemForTrustedOwner(windowId: string, closedItemId: string) {
    return this.withWindowCapability(windowId, (capability) =>
      this.client.getClosedItem(closedItemId, capability)
    )
  }

  public async reopenTabForTrustedOwner(
    windowId: string,
    input: ReturnType<typeof tabReopenParamsSchema.parse>
  ) {
    const params = tabReopenParamsSchema.parse(input)
    if (params.target.windowId !== windowId) throw new Error('The tab target window changed')
    const topology = await this.listWindowsForTrustedOwner(windowId)
    const target = topology.windows.find((placement) => placement.windowId === windowId)
    if (
      !target ||
      topology.revision !== params.mutation.expectedRevision ||
      topology.idempotencyEpoch !== params.mutation.idempotencyEpoch ||
      target.revision !== params.target.expectedWindowRevision ||
      !target.workspaceIds.includes(params.target.workspaceId)
    )
      throw new Error('The Node window topology changed')
    return this.withWindowCapability(windowId, (capability) =>
      this.client.reopenClosedTab(
        { ...params.mutation, closedItemId: params.closedItemId, target: params.target },
        capability
      )
    )
  }

  public async duplicateTabForTrustedOwner(
    windowId: string,
    input: ReturnType<typeof tabDuplicateParamsSchema.parse>
  ) {
    const params = tabDuplicateParamsSchema.parse(input)
    if (params.source.windowId !== windowId) throw new Error('The tab source window changed')
    const topology = await this.listWindowsForTrustedOwner(windowId)
    const source = topology.windows.find((item) => item.windowId === windowId)
    const target = topology.windows.find((item) => item.windowId === params.target.windowId)
    if (
      !source ||
      !target ||
      topology.revision !== params.mutation.expectedRevision ||
      topology.idempotencyEpoch !== params.mutation.idempotencyEpoch ||
      source.revision !== params.source.expectedWindowRevision ||
      target.revision !== params.target.expectedWindowRevision ||
      !source.workspaceIds.includes(params.source.workspaceId) ||
      !target.workspaceIds.includes(params.target.workspaceId)
    )
      throw new Error('The Node window topology changed')
    return this.withWindowCapability(windowId, (capability) =>
      this.client.duplicateTabExact(params, capability)
    )
  }

  public async moveTabExactForTrustedOwner(
    windowId: string,
    input: ReturnType<typeof tabMoveExactParamsSchema.parse>
  ) {
    const params = tabMoveExactParamsSchema.parse(input)
    if (params.source.windowId !== windowId) throw new Error('The tab source window changed')
    const topology = await this.listWindowsForTrustedOwner(windowId)
    const source = topology.windows.find((item) => item.windowId === windowId)
    const target = topology.windows.find((item) => item.windowId === params.target.windowId)
    if (
      !source ||
      !target ||
      topology.revision !== params.mutation.expectedRevision ||
      topology.idempotencyEpoch !== params.mutation.idempotencyEpoch ||
      source.revision !== params.source.expectedWindowRevision ||
      target.revision !== params.target.expectedWindowRevision ||
      !source.workspaceIds.includes(params.source.workspaceId) ||
      !target.workspaceIds.includes(params.target.workspaceId)
    )
      throw new Error('The Node window topology changed')
    return this.withWindowCapability(windowId, (capability) =>
      this.client.moveTabExact(params, capability)
    )
  }

  public async detachTabForTrustedOwner(
    windowId: string,
    input: ReturnType<typeof tabDetachParamsSchema.parse>
  ) {
    const params = tabDetachParamsSchema.parse(input)
    if (params.source.windowId !== windowId) throw new Error('The tab source window changed')
    return this.withWindowCapability(windowId, (capability) =>
      this.client.detachTab(params, capability)
    )
  }

  public navigateFocusHistoryForTrustedOwner(
    windowId: string,
    input: ReturnType<typeof focusHistoryNavigateParamsSchema.parse>
  ) {
    const params = focusHistoryNavigateParamsSchema.parse(input)
    return this.withWindowCapability(windowId, (capability) =>
      this.client.navigateFocusHistory(params, capability)
    )
  }

  public listWorkspacesForTrustedOwner(windowId: string) {
    return this.withWindowCapability(windowId, (capability) =>
      this.client.listBoundWorkspaces(capability)
    )
  }

  public createWindowForTrustedOwner(windowId: string, params: WindowCreateParams) {
    if (params.sourceWindow.windowId !== windowId)
      throw new Error('Node window create source changed')
    return this.withWindowCapability(windowId, (capability) =>
      this.client.createWindow(params, capability)
    )
  }

  public focusWindowForTrustedOwner(windowId: string, params: WindowFocusParams) {
    return this.withWindowCapability(windowId, (capability) =>
      this.client.focusWindow(params, capability)
    )
  }

  public closeWindowForTrustedOwner(windowId: string, params: WindowCloseParams) {
    if (params.window.windowId !== windowId) throw new Error('Node window close source changed')
    return this.withWindowCapability(windowId, (capability) =>
      this.client.closeWindow(params, capability)
    )
  }

  /** Owner issuance rotates the previous token, so same-window reads must not overlap. */
  private async withWindowCapability<T>(
    windowId: string,
    read: (capability: string) => Promise<T>
  ): Promise<T> {
    const previous = this.windowCapabilityReads.get(windowId)
    let release!: () => void
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    this.windowCapabilityReads.set(windowId, finished)
    if (previous) await previous
    try {
      if (this.stopped) throw new Error('Node sidecar is stopped')
      const capability = await this.issueWindowCapabilityForTrustedOwner(windowId)
      try {
        return await read(capability)
      } finally {
        await this.revokeWindowCapability(capability)
      }
    } finally {
      if (this.windowCapabilityReads.get(windowId) === finished) {
        this.windowCapabilityReads.delete(windowId)
      }
      release()
    }
  }
}

function assertPrivateReadOnlyCredentialFd(fd: number): void {
  try {
    if (!Number.isInteger(fd) || fd < 0 || !process.getuid) throw new Error()
    const file = fstatSync(fd)
    const info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    const flags = /^flags:[ \t]*([0-7]+)[ \t]*$/mu.exec(info)
    if (
      !file.isFile() ||
      file.uid !== process.getuid() ||
      file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 ||
      file.size < 1 ||
      file.size > 64 * 1024 ||
      !flags ||
      (Number.parseInt(flags[1]!, 8) & 0o3) !== 0
    )
      throw new Error()
  } catch {
    throw new Error('Node credential descriptor must be a private read-only regular file')
  }
}

async function assertOwnerLockReleased(workingPath: string): Promise<void> {
  try {
    await lstat(`${workingPath}.owner.lock`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('Node isolated copy owner lock remains held')
}

async function assertLiveOwnerLocksReleased(livePath: string): Promise<void> {
  if (process.platform !== 'linux' || !process.getuid) {
    throw new Error('Node live credential handoff requires Linux ownership')
  }
  for (const suffix of ['.writer-transfer.lock', '.live-owner.lock']) {
    const path = `${livePath}${suffix}`
    const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      const opened = await file.stat()
      const named = await lstat(path)
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.uid !== process.getuid() ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.dev !== named.dev ||
        opened.ino !== named.ino
      ) {
        throw new Error('Node live owner fence is unsafe')
      }
      const probe = spawnSync('/usr/bin/flock', ['-n', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', file.fd],
        timeout: 5_000
      })
      const after = await lstat(path)
      if (
        probe.error ||
        probe.status !== 0 ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino
      ) {
        throw new Error('Node live owner fence remains held or changed')
      }
    } finally {
      await file.close()
    }
  }
}

async function runEnrollmentUtility(
  options: NodeSidecarOptions,
  targetId: string,
  expectedRevision: number,
  credentialFd: number
): Promise<{ status: 'stored'; targetId: string; revision: number }> {
  const parsed = await runCredentialUtility(options, credentialFd, {
    version: 1,
    sourceStatePath: options.sourcePath,
    backupStatePath: options.backupPath,
    workingStatePath: options.workingPath,
    targetId,
    expectedRevision
  })
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('status' in parsed) ||
    parsed.status !== 'stored' ||
    !('targetId' in parsed) ||
    parsed.targetId !== targetId ||
    !('revision' in parsed) ||
    parsed.revision !== expectedRevision + 1
  ) {
    throw new Error('Node credential enrollment failed')
  }
  return { status: 'stored', targetId, revision: expectedRevision + 1 }
}

async function runOnlineEnrollmentUtility(
  options: NodeSidecarOptions,
  targetId: string,
  enrollmentId: string,
  credentialFd: number
): Promise<void> {
  const parsed = await runCredentialUtility(options, credentialFd, {
    version: 2,
    sourceStatePath: options.sourcePath,
    backupStatePath: options.backupPath,
    workingStatePath: options.workingPath,
    targetId,
    enrollmentId,
    expectedRevision: 0
  })
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('status' in parsed) ||
    parsed.status !== 'stored' ||
    !('targetId' in parsed) ||
    parsed.targetId !== targetId ||
    !('enrollmentId' in parsed) ||
    parsed.enrollmentId !== enrollmentId
  ) {
    throw new Error('Node credential enrollment failed')
  }
}

async function runNativeEnrollmentUtility(
  options: NodeSidecarNativeOptions,
  targetId: string,
  enrollmentId: string,
  credentialFd: number
): Promise<void> {
  const state = await lstat(options.liveDatabasePath)
  const parsed = await runCredentialUtility(options, credentialFd, {
    version: 7,
    nativeStatePath: options.liveDatabasePath,
    stateIdentity: `${state.dev}:${state.ino}`,
    targetId,
    enrollmentId,
    expectedRevision: 0
  })
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('status' in parsed) ||
    parsed.status !== 'stored' ||
    !('targetId' in parsed) ||
    parsed.targetId !== targetId ||
    !('enrollmentId' in parsed) ||
    parsed.enrollmentId !== enrollmentId
  ) {
    throw new Error('Node native credential enrollment failed')
  }
}

async function runNativeReplacementUtility(
  options: NodeSidecarNativeOptions,
  request: RemoteReplacementRequest,
  credentialFd: number
): Promise<void> {
  const state = await lstat(options.liveDatabasePath)
  const parsed = await runCredentialUtility(options, credentialFd, {
    version: 8,
    nativeStatePath: options.liveDatabasePath,
    stateIdentity: `${state.dev}:${state.ino}`,
    targetId: request.remoteTargetId,
    enrollmentId: request.enrollmentId,
    expectedRevision: request.expectedRevision
  })
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('status' in parsed) ||
    parsed.status !== 'stored' ||
    !('targetId' in parsed) ||
    parsed.targetId !== request.remoteTargetId ||
    !('enrollmentId' in parsed) ||
    parsed.enrollmentId !== request.enrollmentId
  ) {
    throw new Error('Node native credential replacement failed')
  }
}

async function runOnlineReplacementUtility(
  options: NodeSidecarOptions,
  request: { remoteTargetId: string; enrollmentId: string; expectedRevision: number },
  credentialFd: number
): Promise<void> {
  const parsed = await runCredentialUtility(options, credentialFd, {
    version: 3,
    sourceStatePath: options.sourcePath,
    backupStatePath: options.backupPath,
    workingStatePath: options.workingPath,
    targetId: request.remoteTargetId,
    enrollmentId: request.enrollmentId,
    expectedRevision: request.expectedRevision
  })
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('status' in parsed) ||
    parsed.status !== 'stored' ||
    !('targetId' in parsed) ||
    parsed.targetId !== request.remoteTargetId ||
    !('enrollmentId' in parsed) ||
    parsed.enrollmentId !== request.enrollmentId
  )
    throw new Error('Node credential replacement failed')
}

async function runLiveReplacementUtility(
  options: NodeSidecarLiveOptions,
  request: RemoteReplacementRequest,
  proof: LiveBackupProof,
  credentialFd: number
): Promise<void> {
  const parsed = await runCredentialUtility(options, credentialFd, {
    version: 5,
    liveStatePath: proof.liveStatePath,
    backupStatePath: proof.backupStatePath,
    liveStateIdentity: proof.liveStateIdentity,
    backupStateIdentity: proof.backupStateIdentity,
    backupSha256: proof.backupSha256,
    targetId: request.remoteTargetId,
    enrollmentId: request.enrollmentId,
    expectedRevision: request.expectedRevision
  })
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('status' in parsed) ||
    parsed.status !== 'stored' ||
    !('targetId' in parsed) ||
    parsed.targetId !== request.remoteTargetId ||
    !('enrollmentId' in parsed) ||
    parsed.enrollmentId !== request.enrollmentId
  ) {
    throw new Error('Node live credential replacement failed')
  }
}

async function runLiveEnrollmentUtility(
  options: NodeSidecarLiveOptions,
  targetId: string,
  enrollmentId: string,
  proof: LiveBackupProof,
  credentialFd: number
): Promise<void> {
  const parsed = await runCredentialUtility(options, credentialFd, {
    version: 6,
    liveStatePath: proof.liveStatePath,
    backupStatePath: proof.backupStatePath,
    liveStateIdentity: proof.liveStateIdentity,
    backupStateIdentity: proof.backupStateIdentity,
    backupSha256: proof.backupSha256,
    targetId,
    enrollmentId,
    expectedRevision: 0
  })
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('status' in parsed) ||
    parsed.status !== 'stored' ||
    !('targetId' in parsed) ||
    parsed.targetId !== targetId ||
    !('enrollmentId' in parsed) ||
    parsed.enrollmentId !== enrollmentId
  ) {
    throw new Error('Node live credential enrollment failed')
  }
}

async function runCredentialUtility(
  options: AnyNodeSidecarOptions,
  credentialFd: number,
  requestPayload: Record<string, unknown>
): Promise<unknown> {
  const utilityPath = join(dirname(options.serverPath), 'credential-enroll.mjs')
  const utility = await lstat(utilityPath)
  if (!utility.isFile() || utility.isSymbolicLink()) {
    throw new Error('Node credential enrollment utility is unavailable')
  }
  const requestPath = join(
    dirname('workingPath' in options ? options.workingPath : options.liveDatabasePath),
    `.node-enroll-${randomUUID()}.json`
  )
  const request = await open(
    requestPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    try {
      await request.writeFile(JSON.stringify(requestPayload))
      await request.sync()
    } finally {
      await request.close()
    }
    const env: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: '1',
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      LANG: process.env.LANG
    }
    const child = spawn(
      options.executable ?? process.execPath,
      [utilityPath, '--request-file', requestPath],
      {
        env,
        stdio: ['ignore', 'pipe', 'ignore', credentialFd],
        windowsHide: true,
        detached: false
      }
    )
    let output = ''
    let overflow = false
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output) > MAX_ENROLL_OUTPUT_BYTES) {
        overflow = true
        child.kill('SIGKILL')
      }
    })
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      let spawnError: Error | undefined
      const timeout = setTimeout(() => child.kill('SIGKILL'), ENROLL_TIMEOUT_MS)
      child.once('error', (error) => {
        spawnError = error
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (spawnError) rejectExit(new Error('Node credential utility could not start'))
        else resolveExit(code)
      })
    })
    if (overflow) throw new Error('Node credential utility output exceeded its limit')
    let parsed: unknown
    try {
      parsed = JSON.parse(output.trim()) as unknown
    } catch {
      /* Invalid utility result. */
    }
    if (exitCode !== 0) {
      const code =
        parsed &&
        typeof parsed === 'object' &&
        'code' in parsed &&
        typeof parsed.code === 'string' &&
        /^[a-z_]{1,40}$/u.test(parsed.code)
          ? parsed.code
          : 'enrollment_unavailable'
      throw new Error(`Node credential enrollment failed: ${code}`)
    }
    return parsed
  } finally {
    await unlink(requestPath)
  }
}

function readyPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false
    let buffer = ''
    const finish = (port?: number, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) rejectReady(error)
      else resolveReady(port!)
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > MAX_STDOUT_BYTES) {
        finish(undefined, new Error('Node sidecar startup output exceeded its limit'))
        return
      }
      const match = buffer.match(/\[server\] listening on 127\.0\.0\.1:(\d+)/u)
      if (!match) return
      const port = Number(match[1])
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        finish(undefined, new Error('Node sidecar announced an invalid port'))
      } else finish(port)
    }
    const onError = () => finish(undefined, new Error('Node sidecar could not start'))
    const onExit = () => finish(undefined, new Error('Node sidecar exited before readiness'))
    const timeout = setTimeout(
      () => finish(undefined, new Error('Node sidecar readiness timed out')),
      READY_TIMEOUT_MS
    )
    child.stdout.on('data', onData)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveStop, rejectStop) => {
    let done = false
    let forcedTimer: NodeJS.Timeout | undefined
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (forcedTimer) clearTimeout(forcedTimer)
      resolveStop()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      forcedTimer = setTimeout(() => {
        if (done) return
        done = true
        child.off('exit', finish)
        child.off('close', finish)
        rejectStop(new Error('Node sidecar could not be stopped'))
      }, 2_000)
    }, STOP_TIMEOUT_MS)
    child.once('exit', finish)
    child.once('close', finish)
    child.kill('SIGTERM')
  })
}
