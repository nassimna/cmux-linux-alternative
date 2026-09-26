import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'

import Database from 'better-sqlite3'
import type { z, ZodType } from 'zod'
import {
  actionInvokeResultSchema,
  windowCreateParamsSchema,
  windowFocusParamsSchema,
  windowCloseParamsSchema,
  windowMutationResultSchema,
  windowCloseResultSchema,
  tabDuplicateParamsSchema,
  tabDetachParamsSchema,
  tabMoveExactParamsSchema,
  advancedTabMutationResultSchema,
  focusHistoryNavigateParamsSchema,
  focusHistoryNavigateResultSchema,
  windowStateSnapshotSchema,
  type RemoteTargetDeleteParams,
  type WindowCreateParams,
  type WindowFocusParams,
  type WindowCloseParams,
  type TabDuplicateParams
} from '@agent-workspace/protocol-client'

import {
  durableApplicationStateSchema,
  workspaceCreateCommitResultSchema,
  workspaceCreateRequestSchema,
  workspaceCloseCommitResultSchema,
  workspaceCloseRequestSchema,
  terminalRestartRequestSchema,
  tabSelectRequestSchema,
  tabCloseRequestSchema,
  tabCloseCommitResultSchema,
  tabOpenTerminalRequestSchema,
  tabOpenTerminalCommitResultSchema,
  tabOpenBrowserRequestSchema,
  tabOpenBrowserResultSchema,
  browserNavigateRequestSchema,
  browserBackRequestSchema,
  browserForwardRequestSchema,
  browserReloadRequestSchema,
  browserStopRequestSchema,
  browserOpenDevToolsRequestSchema,
  browserObserveRequestSchema,
  paneFocusRequestSchema,
  paneResizeRequestSchema,
  paneSplitRequestSchema,
  paneSplitCommitResultSchema,
  paneCloseRequestSchema,
  paneCloseCommitResultSchema,
  workspacePinRequestSchema,
  workspaceSelectionReplaceRequestSchema,
  workspaceCanonicalMoveRequestSchema,
  workspaceBatchCloseRequestSchema,
  groupCreateRequestSchema,
  groupRenameRequestSchema,
  groupDeleteRequestSchema,
  groupMoveRequestSchema,
  groupAssignRequestSchema,
  groupCollapseRequestSchema,
  layoutSaveRequestSchema,
  layoutDeleteRequestSchema,
  layoutApplyRequestSchema,
  layoutImportRequestSchema,
  tabMoveRequestSchema,
  tabUpdateRequestSchema,
  workspaceMutationResultSchema,
  tabReopenRequestSchema,
  tabReopenResultSchema,
  workspaceMoveRequestSchema,
  workspaceSelectRequestSchema,
  workspaceUpdateRequestSchema,
  type DurableApplicationState,
  type WorkspaceCreateCommitResult,
  type WorkspaceCreateRequest,
  type WorkspaceCloseCommitResult,
  type WorkspaceCloseRequest,
  type TerminalRestartRequest,
  type TabSelectRequest,
  type TabCloseRequest,
  type TabCloseCommitResult,
  type TabOpenTerminalRequest,
  type TabOpenTerminalCommitResult,
  type TabOpenBrowserRequest,
  type TabOpenBrowserResult,
  type BrowserNavigateRequest,
  type BrowserActionRequest,
  type BrowserObserveRequest,
  type PaneFocusRequest,
  type PaneResizeRequest,
  type PaneSplitRequest,
  type PaneSplitCommitResult,
  type PaneCloseRequest,
  type PaneCloseCommitResult,
  type WorkspacePinRequest,
  type WorkspaceSelectionReplaceRequest,
  type WorkspaceCanonicalMoveRequest,
  type WorkspaceBatchCloseRequest,
  type GroupCreateRequest,
  type GroupRenameRequest,
  type GroupDeleteRequest,
  type GroupMoveRequest,
  type GroupAssignRequest,
  type GroupCollapseRequest,
  type LayoutSaveRequest,
  type LayoutDeleteRequest,
  type LayoutApplyRequest,
  type LayoutImportRequest,
  type RemoteTargetCreateParams,
  type RemoteSessionConnectParams,
  type RemoteSessionDetachParams,
  type RemoteSessionCloseParams,
  type TabMoveRequest,
  type TabUpdateRequest,
  type WorkspaceMoveRequest,
  type WorkspaceMutationResult,
  type WorkspaceSelectRequest,
  type WorkspaceUpdateRequest
} from '@agent-workspace/contracts'

import { AgentCatalog } from './agent-catalog'
import { duplicateTabExact } from '../domain/advanced-tab-duplicate'
import { detachExactTab } from '../domain/advanced-tab-detach'
import { moveExactTab } from '../domain/advanced-tab-move'
import {
  assertTabBindingsTransferable,
  assertTabUnbound,
  transferTabBindings
} from './tab-binding-transfer'
import { navigateFocusHistory } from '../domain/focus-history-mutations'
import { reopenClosedTab, type ExactReopenTarget } from '../domain/recently-closed-mutations'
import {
  createWindowPlacement,
  focusWindowPlacement,
  closeWindowPlacement,
  closeWindowWorkspaces,
  WindowMutationError
} from '../domain/window-mutations'
import { projectWindowList } from '../domain/window-projection'

import {
  createWorkspace,
  closeWorkspace,
  moveWorkspace,
  restartTerminal,
  selectTab,
  closeTab,
  openTerminalTab,
  openBrowserTab,
  focusPane,
  resizePane,
  splitPane,
  closePane,
  moveTab,
  updateTab,
  selectWorkspace,
  replaceWorkspaceSelection,
  closeSelectedWorkspaces,
  updateWorkspace,
  type NewWorkspaceIds,
  type NewPaneSplitIds
} from '../domain/workspace-mutations'
import {
  navigateBrowser,
  requestBrowserAction,
  observeBrowser,
  type BrowserAction
} from '../domain/browser-mutations'
import {
  setWorkspacePinned,
  createGroup,
  renameGroup,
  deleteGroup,
  moveGroup,
  assignGroup,
  collapseGroup
} from '../domain/organization-mutations'
import {
  assertLayoutBindingsPreserved,
  saveLayout,
  deleteLayout,
  importLayout,
  planLayoutApplication
} from '../domain/layout-mutations'
import { backupLegacyDatabase } from './legacy-backup'
import { IsolatedCopyLock, recordIsolatedCopy, verifyIsolatedCopy } from './isolated-copy-ownership'
import { LiveOwnerLock } from './live-owner-lock'
import { LegacyDatabaseError } from './legacy-inspection'
import { observeSource, sameSourceObservation } from './source-observation'
import { logicalDatabaseDigest } from './logical-database-digest'
import { readLegacySnapshotConnection } from './legacy-state-reader'
import { ensureNativeDatabase } from './native-state'
import { verifyLiveCredentialStateProof } from '../remote/live-credential-utility-policy'
import {
  RemoteCatalog,
  type HostKeyOperation,
  type RemoteOperationMutation
} from './remote-catalog'

interface MutationIdentity {
  expectedRevision: number
  idempotencyEpoch: string
  idempotencyKey: string
}

export interface TabReopenRequest extends MutationIdentity {
  closedItemId: string
  target: ExactReopenTarget
}

export interface TabReopenIds {
  tabId: string
  browserSessionId: string
}

const IDEMPOTENCY_RESULT_RETENTION = 256
const IDEMPOTENCY_TOMBSTONE_CAP = 65_536

function workspaceCreateParams(request: WorkspaceCreateRequest) {
  return {
    name: request.name,
    workingDirectory: request.workingDirectory,
    initialTerminal: request.initialTerminal,
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.color === undefined ? {} : { color: request.color })
  }
}

function tabOpenTerminalParams(request: TabOpenTerminalRequest) {
  return {
    workspaceId: request.workspaceId,
    paneId: request.paneId,
    launch: request.launch,
    ...(request.destinationIndex === undefined
      ? {}
      : { destinationIndex: request.destinationIndex })
  }
}

function tabOpenBrowserParams(request: TabOpenBrowserRequest) {
  return {
    workspaceId: request.workspaceId,
    paneId: request.paneId,
    metadata: request.metadata,
    ...(request.destinationIndex === undefined
      ? {}
      : { destinationIndex: request.destinationIndex }),
    ...(request.profilePartition === undefined
      ? {}
      : { profilePartition: request.profilePartition })
  }
}

function paneSplitParams(request: PaneSplitRequest) {
  return {
    workspaceId: request.workspaceId,
    targetPaneId: request.targetPaneId,
    axis: request.axis,
    ratio: request.ratio,
    placement: request.placement,
    content: request.content
  }
}

export class StateStoreError extends Error {
  public constructor(
    public readonly code:
      | 'stale_revision'
      | 'idempotency_conflict'
      | 'epoch_expired'
      | 'result_expired'
      | 'idempotency_capacity',
    message: string
  ) {
    super(message)
    this.name = 'StateStoreError'
  }
}

export class WindowStateStoreError extends Error {
  public constructor(
    public readonly code: 'target_not_found' | 'stale_revision' | 'resource_limit',
    message: string
  ) {
    super(message)
    this.name = 'WindowStateStoreError'
  }
}

function decodeWindowState(row: { revision: string; json_payload: string }) {
  const stored = JSON.parse(row.json_payload) as unknown
  if (typeof stored !== 'object' || stored === null || !('displayIdentifier' in stored))
    throw new Error('Window-state payload is malformed')
  const { displayIdentifier, ...fields } = stored as Record<string, unknown>
  if (displayIdentifier !== null && typeof displayIdentifier !== 'string')
    throw new Error('Window-state display identifier is malformed')
  const parsed = windowStateSnapshotSchema.parse({
    ...fields,
    ...(displayIdentifier === null ? {} : { displayId: displayIdentifier })
  })
  if (String(parsed.revision) !== row.revision) throw new Error('Window-state revision mismatch')
  return parsed
}

function encodeWindowState(state: z.infer<typeof windowStateSnapshotSchema>): string {
  return JSON.stringify({
    revision: state.revision,
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    maximized: state.maximized,
    fullscreen: state.fullscreen,
    displayIdentifier: state.displayId ?? null
  })
}

/** A transactional writer held by an isolated-copy or exclusive live-state owner fence. */
export type LiveBackupProof = Readonly<{
  liveStatePath: string
  backupStatePath: string
  liveStateIdentity: string
  backupStateIdentity: string
  backupSha256: string
}>

export class ApplicationStateStore {
  private closed = false
  private mutationTail = Promise.resolve()
  private readonly remoteCatalog: RemoteCatalog

  private constructor(
    private readonly database: Database.Database,
    private readonly now: () => number,
    private readonly epoch: string,
    private readonly ownerLock: IsolatedCopyLock | LiveOwnerLock,
    private readonly backupProof?: LiveBackupProof
  ) {
    this.remoteCatalog = new RemoteCatalog(database, now)
  }

  /** Internal capability for ancillary services sharing this exact live writer. */
  public liveOwnerEvidence(
    databasePath: string
  ): Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'> {
    this.requireOpen()
    if (!(this.ownerLock instanceof LiveOwnerLock)) {
      throw new Error('Live owner evidence is unavailable for an isolated copy')
    }
    const owner = this.ownerLock
    owner.assertDatabasePath(databasePath)
    return Object.freeze({
      assertDatabasePath: (path: string) => owner.assertDatabasePath(path),
      assertDatabaseUnchanged: () => owner.assertDatabaseUnchanged()
    })
  }

  /** Pinned at backup creation; the fd-only helper verifies it after handoff. */
  public liveBackupProof(): LiveBackupProof {
    this.requireOpen()
    if (!(this.ownerLock instanceof LiveOwnerLock) || !this.backupProof) {
      throw new Error('Live backup proof is unavailable')
    }
    this.ownerLock.assertDatabasePath(this.backupProof.liveStatePath)
    return this.backupProof
  }

  public static async prepareCopy(
    sourcePath: string,
    backupPath: string,
    workingPath: string,
    now: () => number = Date.now
  ): Promise<ApplicationStateStore> {
    const backup = await backupLegacyDatabase(sourcePath, backupPath)
    const sourceObservation = await observeSource(sourcePath)
    if (backup.database.snapshotRevision !== sourceObservation.database.snapshotRevision) {
      throw new Error('Backup revision differs from observed source revision')
    }
    if (logicalDatabaseDigest(backupPath) !== sourceObservation.logicalSha256) {
      throw new Error('Backup contents differ from observed source contents')
    }
    if (backup.database.snapshotRevision === null) {
      throw new LegacyDatabaseError('state_uninitialized', 'State snapshot has not been saved')
    }
    if (backup.database.legacySnapshotCompatibility) {
      throw new LegacyDatabaseError(
        'migration_required',
        'Legacy-compatible snapshot requires normalization before Node can write it'
      )
    }
    await backupLegacyDatabase(backupPath, workingPath)
    await recordIsolatedCopy(sourcePath, backupPath, workingPath, sourceObservation)
    return ApplicationStateStore.openWorkingCopy(workingPath, now)
  }

  /** Reopens only a previously prepared, explicitly named isolated copy. */
  public static async resumeCopy(
    sourcePath: string,
    backupPath: string,
    workingPath: string,
    now: () => number = Date.now
  ): Promise<ApplicationStateStore> {
    await verifyIsolatedCopy(sourcePath, backupPath, workingPath)
    return ApplicationStateStore.openWorkingCopy(workingPath, now)
  }

  /** Native Node ownership for new installations and existing version-15 profiles. */
  public static async openNative(
    databasePath: string,
    backupPath: string,
    workingDirectory: string,
    now: () => number = Date.now
  ): Promise<ApplicationStateStore> {
    const created = ensureNativeDatabase(databasePath, workingDirectory, now)
    const ownerLock = LiveOwnerLock.acquire(databasePath)
    try {
      if (existsSync(backupPath)) {
        const backup = lstatSync(backupPath)
        if (
          !backup.isFile() ||
          backup.isSymbolicLink() ||
          backup.nlink !== 1 ||
          backup.uid !== process.getuid?.() ||
          (backup.mode & 0o777) !== 0o600
        ) {
          throw new Error('Native profile backup is unsafe')
        }
      }
      // A pre-Node profile gets one immutable backup before any Node mutation.
      if (!created && !existsSync(backupPath)) {
        const inspection = new Database(databasePath, { fileMustExist: true, readonly: true })
        let nativeProfile: boolean
        try {
          nativeProfile =
            inspection
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_native_profile'"
              )
              .get() !== undefined
        } finally {
          inspection.close()
        }
        if (!nativeProfile) {
          await backupLegacyDatabase(databasePath, backupPath)
          ownerLock.assertDatabaseUnchanged()
        }
      }
      return ApplicationStateStore.openOwnedDatabase(databasePath, now, ownerLock)
    } catch (error) {
      ownerLock.close()
      throw error
    }
  }

  /** Reserves live state and verifies a new backup before the first Node write. */
  public static async openLive(
    databasePath: string,
    backupPath: string,
    now: () => number = Date.now,
    preflight?: (
      owner: Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'>
    ) => Promise<void>,
    afterBackup?: (
      owner: Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'>
    ) => Promise<void>
  ): Promise<ApplicationStateStore> {
    const ownerLock = LiveOwnerLock.acquire(databasePath)
    try {
      const source = await observeSource(databasePath)
      if (
        source.database.snapshotRevision === null ||
        source.database.legacySnapshotCompatibility
      ) {
        throw new LegacyDatabaseError('migration_required', 'Live state requires normalization')
      }
      const evidence = Object.freeze({
        assertDatabasePath: (path: string) => ownerLock.assertDatabasePath(path),
        assertDatabaseUnchanged: () => ownerLock.assertDatabaseUnchanged()
      })
      if (preflight) {
        await preflight(evidence)
        ownerLock.assertDatabaseUnchanged()
        if (!sameSourceObservation(source, await observeSource(databasePath))) {
          throw new Error('Live state changed during external preflight')
        }
      }
      const backup = await backupLegacyDatabase(databasePath, backupPath)
      if (
        backup.database.snapshotRevision !== source.database.snapshotRevision ||
        logicalDatabaseDigest(backupPath) !== source.logicalSha256
      ) {
        throw new Error('Live backup differs from the reserved source')
      }
      const backupObservation = await observeSource(backupPath)
      if (backupObservation.walSha256 !== null) {
        throw new Error('Live backup has unexpected WAL')
      }
      if (backupObservation.logicalSha256 !== source.logicalSha256) {
        throw new Error('Live backup contents changed during observation')
      }
      // SQLite's read-only backup connection may checkpoint the source WAL when
      // it closes. Pin the resulting physical state before publishing settings.
      const sourceAfterBackup = await observeSource(databasePath)
      if (
        sourceAfterBackup.identity !== source.identity ||
        sourceAfterBackup.logicalSha256 !== source.logicalSha256 ||
        sourceAfterBackup.database.snapshotRevision !== source.database.snapshotRevision
      ) {
        throw new Error('Live state changed while creating its backup')
      }
      if (afterBackup) {
        await afterBackup(evidence)
        ownerLock.assertDatabaseUnchanged()
        if (!sameSourceObservation(sourceAfterBackup, await observeSource(databasePath))) {
          throw new Error('Live state changed while staging external state')
        }
        if (!sameSourceObservation(backupObservation, await observeSource(backupPath))) {
          throw new Error('Live backup changed while staging external state')
        }
      }
      ownerLock.assertDatabaseUnchanged()
      return ApplicationStateStore.openOwnedDatabase(
        databasePath,
        now,
        ownerLock,
        Object.freeze({
          liveStatePath: databasePath,
          backupStatePath: backupPath,
          liveStateIdentity: source.identity,
          backupStateIdentity: backupObservation.identity,
          backupSha256: backupObservation.sha256
        })
      )
    } catch (error) {
      ownerLock.close()
      throw error
    }
  }

  /** Reclaim the same live database after a fenced helper, retaining its original backup. */
  public static async resumeLive(
    databasePath: string,
    backupPath: string,
    proof: LiveBackupProof,
    now: () => number = Date.now,
    preflight?: (
      owner: Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'>
    ) => Promise<void>
  ): Promise<ApplicationStateStore> {
    if (proof.liveStatePath !== databasePath || proof.backupStatePath !== backupPath) {
      throw new Error('Live resume proof belongs to another state or backup')
    }
    const ownerLock = LiveOwnerLock.acquire(databasePath)
    try {
      verifyLiveCredentialStateProof(proof)
      const source = await observeSource(databasePath)
      if (
        source.database.snapshotRevision === null ||
        source.database.legacySnapshotCompatibility
      ) {
        throw new LegacyDatabaseError('migration_required', 'Live state requires normalization')
      }
      if (preflight) {
        const evidence = Object.freeze({
          assertDatabasePath: (path: string) => ownerLock.assertDatabasePath(path),
          assertDatabaseUnchanged: () => ownerLock.assertDatabaseUnchanged()
        })
        await preflight(evidence)
        ownerLock.assertDatabaseUnchanged()
        if (!sameSourceObservation(source, await observeSource(databasePath))) {
          throw new Error('Live state changed during resume preflight')
        }
      }
      verifyLiveCredentialStateProof(proof)
      ownerLock.assertDatabaseUnchanged()
      return ApplicationStateStore.openOwnedDatabase(
        databasePath,
        now,
        ownerLock,
        Object.freeze({ ...proof })
      )
    } catch (error) {
      ownerLock.close()
      throw error
    }
  }

  private static openWorkingCopy(workingPath: string, now: () => number): ApplicationStateStore {
    const copyLock = IsolatedCopyLock.acquire(workingPath)
    return ApplicationStateStore.openOwnedDatabase(workingPath, now, copyLock)
  }

  private static openOwnedDatabase(
    workingPath: string,
    now: () => number,
    ownerLock: IsolatedCopyLock | LiveOwnerLock,
    backupProof?: LiveBackupProof
  ): ApplicationStateStore {
    try {
      if (ownerLock instanceof LiveOwnerLock) ownerLock.assertDatabaseUnchanged()
      const file = lstatSync(workingPath)
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
        throw new Error('Working database must be a private regular file')
      }
      const database = new Database(workingPath, { fileMustExist: true, timeout: 5_000 })
      try {
        database.pragma('foreign_keys = ON')
        readLegacySnapshotConnection(database)
        const epoch = randomUUID()
        database
          .transaction(() => {
            // This table belongs only to the isolated Node copy. Keep proof for live
            // Node-created placements after their replay results are pruned.
            database.exec(`CREATE TABLE IF NOT EXISTS node_window_provenance (
              window_id TEXT PRIMARY KEY CHECK (length(window_id) = 36)
            )`)
            const liveWindows = new Set(
              readLegacySnapshotConnection(database).windowPlacements.map(({ id }) => id)
            )
            const retainedCreates = database
              .prepare(
                "SELECT result_json FROM idempotency_results WHERE namespace = 'node.window.create' AND result_json IS NOT NULL"
              )
              .all() as { result_json: string }[]
            const recordCreate = database.prepare(
              'INSERT OR IGNORE INTO node_window_provenance (window_id) VALUES (?)'
            )
            for (const { result_json } of retainedCreates) {
              try {
                const parsed = windowMutationResultSchema.safeParse(JSON.parse(result_json))
                if (parsed.success && liveWindows.has(parsed.data.window.windowId))
                  recordCreate.run(parsed.data.window.windowId)
              } catch {
                // A malformed old result cannot establish creation provenance.
              }
            }
            database
              .prepare(
                `DELETE FROM node_window_provenance WHERE window_id NOT IN (
                ${[...liveWindows].map(() => '?').join(', ')}
              )`
              )
              .run(...liveWindows)
            // A fresh epoch fences stale Node mutation requests without erasing Rust's exact
            // results, remote-operation replay data, or durable action/browser tombstones.
            const updated = database
              .prepare(
                'UPDATE idempotency_epoch SET epoch = ?, issued_at_ms = ? WHERE singleton = 1'
              )
              .run(epoch, now())
            if (updated.changes !== 1) throw new Error('Idempotency epoch row is missing')
            new RemoteCatalog(database, now).reconcileAfterRestart()
          })
          .immediate()
        return new ApplicationStateStore(database, now, epoch, ownerLock, backupProof)
      } catch (error) {
        database.close()
        throw error
      }
    } catch (error) {
      ownerLock.close()
      throw error
    }
  }

  public readSnapshot(): DurableApplicationState {
    this.requireOpen()
    return readLegacySnapshotConnection(this.database)
  }

  public getWindowStateFor(windowId: string) {
    this.requireOpen()
    if (!this.readSnapshot().windowPlacements.some(({ id }) => id === windowId))
      throw new WindowStateStoreError('target_not_found', 'Window placement does not exist')
    const row = this.database
      .prepare('SELECT revision, json_payload FROM window_state WHERE window_id = ?')
      .get(windowId) as { revision: string; json_payload: string } | undefined
    return { windowId, ...(row ? { state: decodeWindowState(row) } : {}) }
  }

  public updateWindowStateFor(windowId: string, input: z.infer<typeof windowStateSnapshotSchema>) {
    this.requireOpen()
    const state = windowStateSnapshotSchema.parse(input)
    return this.database
      .transaction(() => {
        if (!this.readSnapshot().windowPlacements.some(({ id }) => id === windowId))
          throw new WindowStateStoreError('target_not_found', 'Window placement does not exist')
        const row = this.database
          .prepare('SELECT revision, json_payload FROM window_state WHERE window_id = ?')
          .get(windowId) as { revision: string; json_payload: string } | undefined
        const payload = encodeWindowState(state)
        if (row) {
          const stored = decodeWindowState(row)
          if (
            state.revision < stored.revision ||
            (state.revision === stored.revision && payload !== row.json_payload)
          )
            throw new WindowStateStoreError('stale_revision', 'Window-state revision conflicts')
          if (state.revision === stored.revision) return { windowId, state }
        } else {
          const count = this.database
            .prepare('SELECT COUNT(*) AS count FROM window_state')
            .get() as { count: number }
          if (count.count >= 16)
            throw new WindowStateStoreError('resource_limit', 'Window-state capacity reached')
        }
        this.database
          .prepare(
            `INSERT INTO window_state (window_id, revision, json_payload, saved_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(window_id) DO UPDATE SET revision = excluded.revision,
           json_payload = excluded.json_payload, saved_at_ms = excluded.saved_at_ms`
          )
          .run(windowId, String(state.revision), payload, this.now())
        return { windowId, state }
      })
      .immediate()
  }

  /** Private owner-channel reconciliation; never accepts a renderer or HTTP claim. */
  public reconcileWindowHosting(claimedWindowIds: ReadonlySet<string>): number {
    this.requireOpen()
    return this.database
      .transaction(() => {
        const current = this.readSnapshot()
        for (const windowId of claimedWindowIds) {
          const placement = current.windowPlacements.find(({ id }) => id === windowId)
          if (!placement || placement.hostingState === 'closing') {
            throw new StateStoreError('stale_revision', 'Window hosting claim is unavailable')
          }
        }
        let changed = false
        const placements = current.windowPlacements.map((placement) => {
          if (placement.hostingState === 'closing') return placement
          const hostingState = claimedWindowIds.has(placement.id) ? 'hosted' : 'unhosted'
          if (placement.hostingState === hostingState) return placement
          if (placement.revision >= Number.MAX_SAFE_INTEGER) {
            throw new StateStoreError('stale_revision', 'Window revision exhausted')
          }
          changed = true
          return { ...placement, hostingState, revision: placement.revision + 1 }
        })
        if (!changed) return current.revision
        if (current.revision >= Number.MAX_SAFE_INTEGER) {
          throw new StateStoreError('stale_revision', 'Application revision exhausted')
        }
        const next = durableApplicationStateSchema.parse({
          ...current,
          revision: current.revision + 1,
          windowPlacements: placements
        })
        const updated = this.database
          .prepare(
            'UPDATE application_snapshot SET revision = ?, json_payload = ?, saved_at_ms = ? WHERE singleton = 1 AND revision = ?'
          )
          .run(String(next.revision), JSON.stringify(next), this.now(), String(current.revision))
        if (updated.changes !== 1) {
          throw new StateStoreError(
            'stale_revision',
            'Window hosting changed during reconciliation'
          )
        }
        return next.revision
      })
      .immediate()
  }

  /** Cheap revision probe for process-local projections watching this owner. */
  public readRevision(): number {
    this.requireOpen()
    const row = this.database
      .prepare('SELECT revision FROM application_snapshot WHERE singleton=1')
      .get() as { revision: string } | undefined
    const revision = Number(row?.revision)
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('Application revision is invalid')
    return revision
  }

  /** A single SQLite transition for the configuration file's runtime-backed sections. */
  public replaceConfigurationRuntimeSettings(
    expectedRevision: number,
    notificationSettings: DurableApplicationState['notificationSettings'],
    shortcutOverrides: DurableApplicationState['shortcutOverrides']
  ): number {
    this.requireOpen()
    return this.database
      .transaction(() => {
        const current = this.readSnapshot()
        if (current.revision !== expectedRevision) {
          throw new StateStoreError(
            'stale_revision',
            'Application state changed during configuration update'
          )
        }
        if (current.revision >= Number.MAX_SAFE_INTEGER) {
          throw new Error('Application revision exhausted')
        }
        const next = durableApplicationStateSchema.parse({
          ...current,
          revision: current.revision + 1,
          notificationSettings,
          shortcutOverrides
        })
        const changed = this.database
          .prepare(
            'UPDATE application_snapshot SET revision = ?, json_payload = ?, saved_at_ms = ? WHERE singleton = 1 AND revision = ?'
          )
          .run(String(next.revision), JSON.stringify(next), this.now(), String(current.revision))
        if (changed.changes !== 1) {
          throw new StateStoreError(
            'stale_revision',
            'Application state changed during configuration update'
          )
        }
        return next.revision
      })
      .immediate()
  }

  /** Commit after the exact agent disposition intent is durable; caller owns the runtime ID fence. */
  public commitAgentTerminalDetach(binding: {
    agentSessionId: string
    sessionRevision: number
    attemptEpoch: number
    workspaceId: string
    paneId: string
    tabId: string
  }): number {
    this.requireOpen()
    return this.database
      .transaction(() => {
        const agent = this.database
          .prepare(
            `SELECT workspace_id, pane_id, tab_id, revision, attempt_epoch,
              durable_intent, hibernation_state FROM agent_sessions WHERE agent_session_id = ?`
          )
          .get(binding.agentSessionId) as
          | {
              workspace_id: string
              pane_id: string
              tab_id: string
              revision: number
              attempt_epoch: number
              durable_intent: string
              hibernation_state: string | null
            }
          | undefined
        if (
          !agent ||
          agent.workspace_id !== binding.workspaceId ||
          agent.pane_id !== binding.paneId ||
          agent.tab_id !== binding.tabId ||
          agent.revision !== binding.sessionRevision ||
          agent.attempt_epoch !== binding.attemptEpoch ||
          agent.durable_intent !== 'hibernate' ||
          agent.hibernation_state !== 'processDispositionPending'
        )
          throw new StateStoreError('stale_revision', 'Agent disposition intent changed')
        const current = this.readSnapshot()
        if (current.revision >= Number.MAX_SAFE_INTEGER)
          throw new StateStoreError('stale_revision', 'Application revision limit reached')
        const workspace = current.workspaces.find((item) => item.id === binding.workspaceId)
        const tab = workspace?.tabs[binding.tabId]
        if (
          !workspace?.panes[binding.paneId]?.tabs.includes(binding.tabId) ||
          tab?.paneId !== binding.paneId ||
          tab.content.kind !== 'terminal'
        )
          throw new StateStoreError('stale_revision', 'Exact terminal binding changed')
        const at = this.now()
        if (!Number.isSafeInteger(at) || at < 0)
          throw new StateStoreError('stale_revision', 'Terminal detach clock is invalid')
        const next = durableApplicationStateSchema.parse({
          ...current,
          revision: current.revision + 1,
          workspaces: current.workspaces.map((item) =>
            item.id === binding.workspaceId
              ? { ...item, updatedAt: Math.max(item.updatedAt, at) }
              : item
          )
        })
        const changed = this.database
          .prepare(
            `UPDATE application_snapshot SET revision = ?, json_payload = ?, saved_at_ms = ?
          WHERE singleton = 1 AND revision = ?`
          )
          .run(String(next.revision), JSON.stringify(next), at, String(current.revision))
        if (changed.changes !== 1)
          throw new StateStoreError('stale_revision', 'Application state changed during detach')
        return next.revision
      })
      .immediate()
  }

  public currentIdempotencyEpoch(): string {
    this.requireOpen()
    return this.epoch
  }

  public createWindow(input: WindowCreateParams) {
    this.requireOpen()
    const request = windowCreateParamsSchema.parse(input)
    const windowId = randomUUID()
    return this.commit(
      'node.window.create',
      request.mutation,
      request,
      (state) =>
        createWindowPlacement(state, {
          sourceWindowId: request.sourceWindow.windowId,
          sourceRevision: request.sourceWindow.expectedRevision,
          workspaceId: request.workspaceId,
          windowId,
          label: request.label
        }),
      windowMutationResultSchema,
      (next) => ({
        revision: next.revision,
        idempotencyEpoch: this.epoch,
        window: projectWindowList(next, this.epoch).windows.find(
          (item) => item.windowId === windowId
        )!,
        replayed: false
      })
    )
  }

  public focusWindow(input: WindowFocusParams) {
    this.requireOpen()
    const request = windowFocusParamsSchema.parse(input)
    return this.commit(
      'node.window.focus',
      request.mutation,
      request,
      (state) =>
        focusWindowPlacement(state, {
          windowId: request.window.windowId,
          expectedRevision: request.window.expectedRevision
        }),
      windowMutationResultSchema,
      (next) => ({
        revision: next.revision,
        idempotencyEpoch: this.epoch,
        window: projectWindowList(next, this.epoch).windows.find(
          (item) => item.windowId === request.window.windowId
        )!,
        replayed: false
      })
    )
  }

  public navigateFocusHistory(input: z.infer<typeof focusHistoryNavigateParamsSchema>) {
    this.requireOpen()
    const request = focusHistoryNavigateParamsSchema.parse(input)
    return this.commit(
      'node.focusHistory.navigate',
      request.mutation,
      request,
      (state) => navigateFocusHistory(state, request.direction).state,
      focusHistoryNavigateResultSchema,
      (next) => ({
        revision: next.revision,
        idempotencyEpoch: this.epoch,
        target: next.focusHistory.entries[next.focusHistory.cursor]!,
        replayed: false
      })
    )
  }

  public closeWindow(input: WindowCloseParams) {
    this.requireOpen()
    const request = windowCloseParamsSchema.parse(input)
    if (request.policy !== 'rehome' || !request.rehomeTarget) {
      throw new WindowMutationError('policy_denied', 'Node window closeWorkspaces is unavailable')
    }
    return this.commit(
      'node.window.close',
      request.mutation,
      request,
      (state) =>
        closeWindowPlacement(state, {
          windowId: request.window.windowId,
          expectedRevision: request.window.expectedRevision,
          targetWindowId: request.rehomeTarget!.windowId,
          targetRevision: request.rehomeTarget!.expectedRevision
        }),
      windowCloseResultSchema,
      (next) => ({
        revision: next.revision,
        idempotencyEpoch: this.epoch,
        closedWindowId: request.window.windowId,
        rehomeTarget: projectWindowList(next, this.epoch).windows.find(
          (item) => item.windowId === request.rehomeTarget!.windowId
        )!,
        replayed: false
      })
    )
  }

  public closeWindowWorkspaces(
    input: WindowCloseParams,
    closedItemIds: readonly string[],
    now: number
  ) {
    this.requireOpen()
    const request = windowCloseParamsSchema.parse(input)
    if (request.policy !== 'closeWorkspaces' || request.rehomeTarget)
      throw new WindowMutationError('policy_denied', 'Window close policy is invalid')
    return this.commit(
      'node.window.close',
      request.mutation,
      request,
      (state) => {
        const created = this.database
          .prepare('SELECT 1 FROM node_window_provenance WHERE window_id = ?')
          .get(request.window.windowId)
        if (!created)
          throw new WindowMutationError(
            'policy_denied',
            'Rust base window deletion requires reconciliation'
          )
        return closeWindowWorkspaces(state, {
          windowId: request.window.windowId,
          expectedRevision: request.window.expectedRevision,
          closedItemIds,
          now
        })
      },
      windowCloseResultSchema,
      (next) => ({
        revision: next.revision,
        idempotencyEpoch: this.epoch,
        closedWindowId: request.window.windowId,
        replayed: false
      })
    )
  }

  /** Atomic Tier A action commit: the action namespace and exact public result share one fence. */
  public commitServiceAction(input: {
    actionId: 'workspace.card.pin' | 'workspace.group.rename' | 'workspace.group.collapse'
    parameters:
      | { workspaceId: string; pinned: boolean }
      | { groupId: string; name: string }
      | { groupId: string; collapsed: boolean }
    expectedRevision: number
    idempotencyEpoch: string
    idempotencyKey: string
    requestHash: string
    result: z.infer<typeof actionInvokeResultSchema>
  }): z.infer<typeof actionInvokeResultSchema> {
    this.requireOpen()
    const namespace = `action.service.${input.actionId}.v1`
    return this.database
      .transaction(() => {
        if (input.idempotencyEpoch !== this.epoch) {
          throw new StateStoreError('epoch_expired', 'Idempotency epoch has expired')
        }
        const prior = this.database
          .prepare(
            'SELECT request_hash, result_json FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ?'
          )
          .get(namespace, input.idempotencyEpoch, input.idempotencyKey) as
          { request_hash: string; result_json: string | null } | undefined
        if (prior) {
          if (prior.request_hash !== input.requestHash) {
            throw new StateStoreError(
              'idempotency_conflict',
              'Idempotency key was used for another request'
            )
          }
          if (prior.result_json === null) {
            throw new StateStoreError('result_expired', 'Idempotency result has expired')
          }
          return actionInvokeResultSchema.parse(JSON.parse(prior.result_json) as unknown)
        }
        this.requireIdempotencyCapacity(namespace, input.idempotencyEpoch)
        const current = readLegacySnapshotConnection(this.database)
        if (current.revision !== input.expectedRevision) {
          throw new StateStoreError(
            'stale_revision',
            'Application state changed since this request'
          )
        }
        const next =
          input.actionId === 'workspace.card.pin'
            ? setWorkspacePinned(
                current,
                (input.parameters as { workspaceId: string }).workspaceId,
                (input.parameters as { pinned: boolean }).pinned
              )
            : input.actionId === 'workspace.group.rename'
              ? renameGroup(
                  current,
                  (input.parameters as { groupId: string }).groupId,
                  (input.parameters as { name: string }).name
                )
              : collapseGroup(
                  current,
                  (input.parameters as { groupId: string }).groupId,
                  (input.parameters as { collapsed: boolean }).collapsed
                )
        if (next.revision === current.revision + 1) {
          const updated = this.database
            .prepare(
              'UPDATE application_snapshot SET revision = ?, json_payload = ?, saved_at_ms = ? WHERE singleton = 1 AND revision = ?'
            )
            .run(String(next.revision), JSON.stringify(next), this.now(), String(current.revision))
          if (updated.changes !== 1) {
            throw new StateStoreError(
              'stale_revision',
              'Application state changed during this request'
            )
          }
        } else if (next !== current || next.revision !== current.revision) {
          throw new Error('State mutation returned an invalid revision transition')
        }
        const result = actionInvokeResultSchema.parse(input.result)
        const serialized = JSON.stringify(result)
        if (Buffer.byteLength(serialized) > 256 * 1024) {
          throw new Error('Action result exceeds the durable result bound')
        }
        this.database
          .prepare(
            'INSERT INTO idempotency_results (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(
            namespace,
            input.idempotencyEpoch,
            input.idempotencyKey,
            input.requestHash,
            serialized,
            this.now()
          )
        this.database
          .prepare(
            `UPDATE idempotency_results SET result_json = NULL
        WHERE namespace = ? AND epoch = ? AND sequence NOT IN (
          SELECT sequence FROM idempotency_results WHERE namespace = ? AND epoch = ?
            AND result_json IS NOT NULL ORDER BY completed_at_ms DESC, sequence DESC LIMIT 4096
        )`
          )
          .run(namespace, input.idempotencyEpoch, namespace, input.idempotencyEpoch)
        return result
      })
      .immediate()
  }

  public listRemoteTargets(params: unknown) {
    this.requireOpen()
    return this.remoteCatalog.listTargets(params)
  }

  public getRemoteTarget(targetId: string) {
    this.requireOpen()
    return this.remoteCatalog.getTarget(targetId)
  }

  public listRemoteSessions(params: unknown) {
    this.requireOpen()
    return this.remoteCatalog.listSessions(params)
  }

  public getRemoteSession(sessionId: string) {
    this.requireOpen()
    return this.remoteCatalog.getSession(sessionId)
  }

  public listAgentCatalog(input: unknown) {
    this.requireOpen()
    return new AgentCatalog(this.database).list(input)
  }

  public getAgentSession(sessionId: string) {
    this.requireOpen()
    return new AgentCatalog(this.database).get(sessionId)
  }

  public createRemoteTarget(input: RemoteTargetCreateParams) {
    this.requireOpen()
    return this.remoteCatalog.createTarget(input)
  }

  public commitEnrolledRemoteTarget(input: RemoteTargetCreateParams, enrollmentId: string) {
    this.requireOpen()
    return this.remoteCatalog.commitEnrolledTarget(input, enrollmentId)
  }

  public beginRemoteTargetDeletion(input: RemoteTargetDeleteParams) {
    this.requireOpen()
    return this.remoteCatalog.beginTargetDeletion(input)
  }

  public finishRemoteTargetDeletion(input: RemoteTargetDeleteParams) {
    this.requireOpen()
    return this.remoteCatalog.finishTargetDeletion(input)
  }

  public remoteSessionsForTargetDeletion(targetId: string) {
    this.requireOpen()
    return this.remoteCatalog.sessionsForTargetDeletion(targetId)
  }

  public pendingRemoteTargetDeletions() {
    this.requireOpen()
    return this.remoteCatalog.pendingTargetDeletions()
  }

  public prepareRemoteSession(input: RemoteSessionConnectParams) {
    this.requireOpen()
    return this.remoteCatalog.prepareSession(input)
  }

  public detachRemoteSession(input: RemoteSessionDetachParams) {
    this.requireOpen()
    return this.remoteCatalog.detachSession(input)
  }

  public closeRemoteSession(input: RemoteSessionCloseParams) {
    this.requireOpen()
    return this.remoteCatalog.closeSession(input)
  }

  public beginRemoteSessionActivation(sessionId: string, mutation: RemoteOperationMutation) {
    this.requireOpen()
    return this.remoteCatalog.beginActivation(sessionId, mutation)
  }

  public completeRemoteSessionActivation(
    sessionId: string,
    generation: number,
    connectingRevision: number,
    mutation: RemoteOperationMutation,
    outcome: 'connected' | 'failed' | 'reconnecting',
    targetId: string,
    targetRevision: number,
    knownHostsVersion: number,
    errorCode?: string
  ) {
    this.requireOpen()
    return this.remoteCatalog.completeActivation(
      sessionId,
      generation,
      connectingRevision,
      mutation,
      outcome,
      targetId,
      targetRevision,
      knownHostsVersion,
      errorCode
    )
  }

  public recordRemoteLocalTransportExit(sessionId: string, generation: number): boolean {
    this.requireOpen()
    return this.remoteCatalog.recordLocalTransportExit(sessionId, generation)
  }

  public markRemoteTargetHostKeyChanged(targetId: string, expectedRevision: number): boolean {
    this.requireOpen()
    return this.remoteCatalog.markTargetHostKeyChanged(targetId, expectedRevision)
  }

  public failRemoteReconnectIfCurrent(
    sessionId: string,
    generation: number,
    revision: number
  ): boolean {
    this.requireOpen()
    return this.remoteCatalog.failReconnectIfCurrent(sessionId, generation, revision)
  }

  public getRemoteSessionPrepareReplay(mutation: RemoteOperationMutation) {
    this.requireOpen()
    return this.remoteCatalog.getPrepareReplay(mutation)
  }

  public reserveHostKeyOperation(
    operation: HostKeyOperation,
    id: string,
    mutation: RemoteOperationMutation
  ) {
    this.requireOpen()
    return this.remoteCatalog.reserveHostKeyOperation(operation, id, mutation)
  }

  public completeHostKeyOperation(
    operation: HostKeyOperation,
    mutation: RemoteOperationMutation,
    result: unknown
  ): void {
    this.requireOpen()
    this.remoteCatalog.completeHostKeyOperation(operation, mutation, result)
  }

  public commitHostKeyDecision(
    targetId: string,
    mutation: RemoteOperationMutation,
    decision: 'reject' | 'trust',
    result: unknown
  ): void {
    this.requireOpen()
    this.remoteCatalog.commitHostKeyDecision(targetId, mutation, decision, result)
  }

  /** Serializes async terminal lifecycle work with all HTTP workspace mutations. */
  public async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      this.requireOpen()
      return await operation()
    } finally {
      release()
    }
  }

  public preflightWorkspaceCreate(
    input: WorkspaceCreateRequest,
    ids: NewWorkspaceIds,
    createdAt: number
  ): WorkspaceCreateCommitResult | null {
    this.requireOpen()
    const request = workspaceCreateRequestSchema.parse(input)
    const hash = this.requestHash(request, request)
    const replay = this.findReplay(
      'node.workspace.create',
      request,
      hash,
      workspaceCreateCommitResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.workspace.create', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    createWorkspace(current, workspaceCreateParams(request), ids, createdAt, request.windowId)
    return null
  }

  public commitWorkspaceCreate(
    input: WorkspaceCreateRequest,
    ids: NewWorkspaceIds,
    createdAt: number
  ): WorkspaceCreateCommitResult {
    this.requireOpen()
    const request = workspaceCreateRequestSchema.parse(input)
    return this.commit(
      'node.workspace.create',
      request,
      request,
      (state) =>
        createWorkspace(state, workspaceCreateParams(request), ids, createdAt, request.windowId),
      workspaceCreateCommitResultSchema,
      (next) => ({
        revision: next.revision,
        replayed: false,
        workspaceId: ids.workspaceId,
        paneId: ids.paneId,
        tabId: ids.tabId
      })
    )
  }

  public preflightWorkspaceClose(
    input: WorkspaceCloseRequest,
    replacementIds: NewWorkspaceIds,
    createdAt: number
  ): WorkspaceCloseCommitResult | null {
    this.requireOpen()
    const request = workspaceCloseRequestSchema.parse(input)
    const hash = this.requestHash(request, { workspaceId: request.workspaceId })
    const replay = this.findReplay(
      'node.workspace.close',
      request,
      hash,
      workspaceCloseCommitResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.workspace.close', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    closeWorkspace(
      current,
      request.workspaceId,
      current.workspaces.length === 1 ? replacementIds : undefined,
      createdAt
    )
    return null
  }

  public commitWorkspaceClose(
    input: WorkspaceCloseRequest,
    replacementIds: NewWorkspaceIds,
    createdAt: number
  ): WorkspaceCloseCommitResult {
    this.requireOpen()
    const request = workspaceCloseRequestSchema.parse(input)
    return this.commit(
      'node.workspace.close',
      request,
      { workspaceId: request.workspaceId },
      (state) =>
        closeWorkspace(
          state,
          request.workspaceId,
          state.workspaces.length === 1 ? replacementIds : undefined,
          createdAt
        ),
      workspaceCloseCommitResultSchema,
      (next) => {
        const replacement = next.workspaces.find((item) => item.id === replacementIds.workspaceId)
        return {
          revision: next.revision,
          replayed: false,
          replacementWorkspaceId: replacement?.id ?? null,
          replacementPaneId: replacement?.selectedPaneId ?? null,
          replacementTabId: replacement?.panes[replacement.selectedPaneId]?.selectedTabId ?? null
        }
      }
    )
  }

  public preflightTerminalRestart(
    input: TerminalRestartRequest,
    updatedAt: number
  ): WorkspaceMutationResult | null {
    this.requireOpen()
    const request = terminalRestartRequestSchema.parse(input)
    const payload = { workspaceId: request.workspaceId, tabId: request.tabId }
    const replay = this.findReplay(
      'node.terminal.restart',
      request,
      this.requestHash(request, payload),
      workspaceMutationResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.terminal.restart', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    restartTerminal(current, request.workspaceId, request.tabId, updatedAt)
    return null
  }

  public commitTerminalRestart(
    input: TerminalRestartRequest,
    updatedAt: number
  ): WorkspaceMutationResult {
    this.requireOpen()
    const request = terminalRestartRequestSchema.parse(input)
    return this.commit(
      'node.terminal.restart',
      request,
      { workspaceId: request.workspaceId, tabId: request.tabId },
      (state) => restartTerminal(state, request.workspaceId, request.tabId, updatedAt),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public preflightTabClose(
    input: TabCloseRequest,
    closedItemId: string,
    replacementTabId: string,
    now: number
  ): TabCloseCommitResult | null {
    this.requireOpen()
    const request = tabCloseRequestSchema.parse(input)
    const payload = { workspaceId: request.workspaceId, tabId: request.tabId }
    const replay = this.findReplay(
      'node.tab.close',
      request,
      this.requestHash(request, payload),
      tabCloseCommitResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.tab.close', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    assertTabUnbound(this.database, request.tabId)
    const workspace = current.workspaces.find((item) => item.id === request.workspaceId)
    closeTab(
      current,
      request.workspaceId,
      request.tabId,
      closedItemId,
      workspace && Object.keys(workspace.tabs).length === 1 ? replacementTabId : null,
      now
    )
    return null
  }

  public commitTabClose(
    input: TabCloseRequest,
    closedItemId: string,
    replacementTabId: string,
    now: number
  ): TabCloseCommitResult {
    this.requireOpen()
    const request = tabCloseRequestSchema.parse(input)
    return this.commit(
      'node.tab.close',
      request,
      { workspaceId: request.workspaceId, tabId: request.tabId },
      (state) => {
        assertTabUnbound(this.database, request.tabId)
        const workspace = state.workspaces.find((item) => item.id === request.workspaceId)
        return closeTab(
          state,
          request.workspaceId,
          request.tabId,
          closedItemId,
          workspace && Object.keys(workspace.tabs).length === 1 ? replacementTabId : null,
          now
        )
      },
      tabCloseCommitResultSchema,
      (next) => ({
        revision: next.revision,
        replayed: false,
        closedItemId,
        replacementTabId: next.workspaces.some((item) => item.tabs[replacementTabId])
          ? replacementTabId
          : null
      })
    )
  }

  /** Recover an exact committed reopen before a short-lived sidebar descriptor expires. */
  public findTabReopenReplay(input: TabReopenRequest) {
    this.requireOpen()
    const request = tabReopenRequestSchema.parse(input)
    return this.findReplay(
      'node.tab.reopen',
      request,
      this.requestHash(request, { closedItemId: request.closedItemId, target: request.target }),
      tabReopenResultSchema
    )
  }

  /** Build the exact candidate before an external terminal runtime is started. */
  public preflightTabReopen(
    input: TabReopenRequest,
    ids: TabReopenIds,
    createdAt: number
  ):
    | { replay: z.infer<typeof tabReopenResultSchema>; candidate?: never }
    | { replay: null; candidate: DurableApplicationState } {
    this.requireOpen()
    const request = tabReopenRequestSchema.parse(input)
    const payload = { closedItemId: request.closedItemId, target: request.target }
    const replay = this.findReplay(
      'node.tab.reopen',
      request,
      this.requestHash(request, payload),
      tabReopenResultSchema
    )
    if (replay) return { replay }
    this.requireIdempotencyCapacity('node.tab.reopen', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision)
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    return {
      replay: null,
      candidate: reopenClosedTab(
        current,
        request.closedItemId,
        request.target,
        ids.tabId,
        ids.browserSessionId,
        createdAt
      )
    }
  }

  /** Atomic v15 snapshot restore with the existing epoch/revision/idempotency transaction. */
  public commitTabReopen(input: TabReopenRequest, ids: TabReopenIds, createdAt: number) {
    this.requireOpen()
    const request = tabReopenRequestSchema.parse(input)
    const payload = { closedItemId: request.closedItemId, target: request.target }
    return this.commit(
      'node.tab.reopen',
      request,
      payload,
      (state) =>
        reopenClosedTab(
          state,
          request.closedItemId,
          request.target,
          ids.tabId,
          ids.browserSessionId,
          createdAt
        ),
      tabReopenResultSchema,
      (next) => {
        const workspace = next.workspaces.find((item) => item.id === request.target.workspaceId)!
        const tab = workspace.tabs[ids.tabId]!
        const pane = workspace.panes[tab.paneId]!
        const placement = next.windowPlacements.find((item) =>
          item.workspaceIds.includes(workspace.id)
        )!
        return {
          revision: next.revision,
          replayed: false,
          idempotencyEpoch: request.idempotencyEpoch,
          tabId: ids.tabId,
          ...(tab.content.kind === 'browser'
            ? { runtimeSessionId: tab.content.metadata.browserSessionId }
            : {}),
          ownershipKind: tab.content.kind,
          placement: {
            windowId: placement.id,
            workspaceId: workspace.id,
            paneId: pane.id,
            index: pane.tabs.indexOf(ids.tabId),
            windowRevision: placement.revision
          },
          transferEpoch: next.revision
        }
      }
    )
  }

  public preflightTabOpenTerminal(
    input: TabOpenTerminalRequest,
    tabId: string,
    createdAt: number
  ): TabOpenTerminalCommitResult | null {
    this.requireOpen()
    const request = tabOpenTerminalRequestSchema.parse(input)
    const replay = this.findReplay(
      'node.tab.openTerminal',
      request,
      this.requestHash(request, tabOpenTerminalParams(request)),
      tabOpenTerminalCommitResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.tab.openTerminal', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    openTerminalTab(current, tabOpenTerminalParams(request), tabId, createdAt)
    return null
  }

  public commitTabOpenTerminal(
    input: TabOpenTerminalRequest,
    tabId: string,
    createdAt: number
  ): TabOpenTerminalCommitResult {
    this.requireOpen()
    const request = tabOpenTerminalRequestSchema.parse(input)
    return this.commit(
      'node.tab.openTerminal',
      request,
      tabOpenTerminalParams(request),
      (state) => openTerminalTab(state, tabOpenTerminalParams(request), tabId, createdAt),
      tabOpenTerminalCommitResultSchema,
      (next) => ({ revision: next.revision, replayed: false, tabId })
    )
  }

  public openBrowserTab(input: TabOpenBrowserRequest): TabOpenBrowserResult {
    this.requireOpen()
    const request = tabOpenBrowserRequestSchema.parse(input)
    const tabId = randomUUID()
    const browserSessionId = randomUUID()
    const createdAt = this.now()
    return this.commit(
      'node.tab.openBrowser',
      request,
      tabOpenBrowserParams(request),
      (state) =>
        openBrowserTab(state, tabOpenBrowserParams(request), tabId, browserSessionId, createdAt),
      tabOpenBrowserResultSchema,
      (next) => ({ revision: next.revision, replayed: false, tabId, browserSessionId })
    )
  }

  public preflightTabDuplicate(
    input: TabDuplicateParams,
    ids: { tabId: string; browserSessionId: string },
    createdAt: number
  ) {
    this.requireOpen()
    const request = tabDuplicateParamsSchema.parse(input)
    const replay = this.findReplay(
      'node.tab.duplicate',
      request.mutation,
      this.requestHash(request.mutation, request),
      advancedTabMutationResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.tab.duplicate', request.mutation.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.mutation.expectedRevision)
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    duplicateTabExact(current, request, ids, createdAt)
    return null
  }

  public commitTabDuplicate(
    input: TabDuplicateParams,
    ids: { tabId: string; browserSessionId: string },
    createdAt: number,
    terminalId?: string
  ) {
    this.requireOpen()
    const request = tabDuplicateParamsSchema.parse(input)
    return this.commit(
      'node.tab.duplicate',
      request.mutation,
      request,
      (state) => duplicateTabExact(state, request, ids, createdAt),
      advancedTabMutationResultSchema,
      (next) => {
        const workspace = next.workspaces.find((item) => item.id === request.target.workspaceId)!
        const pane = workspace.panes[request.target.paneId]!
        const tab = workspace.tabs[ids.tabId]!
        const placement = next.windowPlacements.find((item) => item.id === request.target.windowId)!
        return {
          revision: next.revision,
          idempotencyEpoch: this.epoch,
          tabId: ids.tabId,
          ownershipKind: tab.content.kind,
          ...(tab.content.kind === 'browser'
            ? { runtimeSessionId: ids.browserSessionId }
            : terminalId
              ? { runtimeSessionId: terminalId }
              : {}),
          placement: {
            windowId: placement.id,
            workspaceId: workspace.id,
            paneId: pane.id,
            index: pane.tabs.indexOf(ids.tabId),
            windowRevision: placement.revision
          },
          transferEpoch: next.revision,
          replayed: false
        }
      }
    )
  }

  public moveTabExact(input: z.infer<typeof tabMoveExactParamsSchema>) {
    this.requireOpen()
    const request = tabMoveExactParamsSchema.parse(input)
    return this.commit(
      'node.tab.moveExact',
      request.mutation,
      request,
      (state) => {
        const next = moveExactTab(state, request, this.now())
        transferTabBindings(this.database, request.source, request.target, this.now())
        return next
      },
      advancedTabMutationResultSchema,
      (next) => {
        const workspace = next.workspaces.find((item) => item.id === request.target.workspaceId)!
        const pane = workspace.panes[request.target.paneId]!
        const placement = next.windowPlacements.find((item) => item.id === request.target.windowId)!
        const tab = workspace.tabs[request.source.tabId]!
        return {
          revision: next.revision,
          idempotencyEpoch: this.epoch,
          tabId: request.source.tabId,
          ownershipKind: tab.content.kind,
          ...(tab.content.kind === 'browser'
            ? { runtimeSessionId: tab.content.metadata.browserSessionId }
            : {}),
          placement: {
            windowId: placement.id,
            workspaceId: workspace.id,
            paneId: pane.id,
            index: pane.tabs.indexOf(request.source.tabId),
            windowRevision: placement.revision
          },
          transferEpoch: next.revision,
          replayed: false
        }
      }
    )
  }

  public preflightTabDetach(
    input: z.infer<typeof tabDetachParamsSchema>,
    ids: { windowId: string; workspaceId: string; paneId: string; replacementTabId: string },
    createdAt: number
  ) {
    this.requireOpen()
    const request = tabDetachParamsSchema.parse(input)
    const replay = this.findReplay(
      'node.tab.detach',
      request.mutation,
      this.requestHash(request.mutation, request),
      advancedTabMutationResultSchema
    )
    if (replay) return { replay, replacement: false }
    this.requireIdempotencyCapacity('node.tab.detach', request.mutation.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.mutation.expectedRevision)
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    assertTabBindingsTransferable(this.database, request.source)
    const source = current.workspaces.find((item) => item.id === request.source.workspaceId)
    const replacement = source !== undefined && Object.keys(source.tabs).length === 1
    detachExactTab(current, request, ids, createdAt)
    return { replay: null, replacement }
  }

  public commitTabDetach(
    input: z.infer<typeof tabDetachParamsSchema>,
    ids: { windowId: string; workspaceId: string; paneId: string; replacementTabId: string },
    createdAt: number
  ) {
    this.requireOpen()
    const request = tabDetachParamsSchema.parse(input)
    return this.commit(
      'node.tab.detach',
      request.mutation,
      request,
      (state) => {
        const next = detachExactTab(state, request, ids, createdAt)
        transferTabBindings(
          this.database,
          request.source,
          { workspaceId: ids.workspaceId, paneId: ids.paneId },
          createdAt
        )
        return next
      },
      advancedTabMutationResultSchema,
      (next) => {
        const workspace = next.workspaces.find((item) => item.id === ids.workspaceId)!
        const tab = workspace.tabs[request.source.tabId]!
        return {
          revision: next.revision,
          idempotencyEpoch: this.epoch,
          tabId: tab.id,
          ownershipKind: tab.content.kind,
          ...(tab.content.kind === 'browser'
            ? { runtimeSessionId: tab.content.metadata.browserSessionId }
            : {}),
          placement: {
            windowId: ids.windowId,
            workspaceId: ids.workspaceId,
            paneId: ids.paneId,
            index: 0,
            windowRevision: 0
          },
          transferEpoch: next.revision,
          replayed: false
        }
      }
    )
  }

  public navigateBrowser(input: BrowserNavigateRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = browserNavigateRequestSchema.parse(input)
    const payload = {
      browserSessionId: request.browserSessionId,
      url: request.url,
      expectedStateRevision: request.expectedStateRevision,
      correlationId: request.correlationId
    }
    return this.commit(
      'node.browser.navigate',
      request,
      payload,
      (state) => navigateBrowser(state, payload, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public browserAction(
    action: BrowserAction,
    input: BrowserActionRequest
  ): WorkspaceMutationResult {
    this.requireOpen()
    const schema = {
      back: browserBackRequestSchema,
      forward: browserForwardRequestSchema,
      reload: browserReloadRequestSchema,
      stop: browserStopRequestSchema,
      openDevTools: browserOpenDevToolsRequestSchema
    }[action]
    const request = schema.parse(input)
    const payload = {
      browserSessionId: request.browserSessionId,
      expectedStateRevision: request.expectedStateRevision,
      correlationId: request.correlationId
    }
    return this.commit(
      `node.browser.${action}`,
      request,
      payload,
      (state) => requestBrowserAction(state, action, payload, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public observeBrowser(input: BrowserObserveRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = browserObserveRequestSchema.parse(input)
    const payload = { workspaceId: request.workspaceId, tabId: request.tabId, state: request.state }
    return this.commit(
      'node.browser.observe',
      request,
      payload,
      (state) => observeBrowser(state, payload, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public focusPane(input: PaneFocusRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = paneFocusRequestSchema.parse(input)
    return this.commit(
      'node.pane.focus',
      request,
      { workspaceId: request.workspaceId, paneId: request.paneId },
      (state) => focusPane(state, request.workspaceId, request.paneId, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public resizePane(input: PaneResizeRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = paneResizeRequestSchema.parse(input)
    return this.commit(
      'node.pane.resize',
      request,
      { workspaceId: request.workspaceId, splitId: request.splitId, ratio: request.ratio },
      (state) => resizePane(state, request.workspaceId, request.splitId, request.ratio, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public preflightPaneSplit(
    input: PaneSplitRequest,
    ids: NewPaneSplitIds,
    createdAt: number
  ): PaneSplitCommitResult | null {
    this.requireOpen()
    const request = paneSplitRequestSchema.parse(input)
    const params = paneSplitParams(request)
    const replay = this.findReplay(
      'node.pane.split',
      request,
      this.requestHash(request, params),
      paneSplitCommitResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.pane.split', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    splitPane(current, params, ids, createdAt)
    return null
  }

  public commitPaneSplit(
    input: PaneSplitRequest,
    ids: NewPaneSplitIds,
    createdAt: number
  ): PaneSplitCommitResult {
    this.requireOpen()
    const request = paneSplitRequestSchema.parse(input)
    return this.commit(
      'node.pane.split',
      request,
      paneSplitParams(request),
      (state) => splitPane(state, paneSplitParams(request), ids, createdAt),
      paneSplitCommitResultSchema,
      (next) => {
        const tabId = request.content.kind === 'existingTab' ? request.content.tabId : ids.tabId
        const tab = next.workspaces.find((item) => item.id === request.workspaceId)?.tabs[tabId]
        return {
          revision: next.revision,
          replayed: false,
          paneId: ids.paneId,
          splitId: ids.splitId,
          tabId,
          browserSessionId:
            tab?.content.kind === 'browser' ? (tab.content.metadata.browserSessionId ?? null) : null
        }
      }
    )
  }

  public preflightPaneClose(
    input: PaneCloseRequest,
    replacementTabId: string,
    updatedAt: number
  ): PaneCloseCommitResult | null {
    this.requireOpen()
    const request = paneCloseRequestSchema.parse(input)
    const params = { workspaceId: request.workspaceId, paneId: request.paneId }
    const replay = this.findReplay(
      'node.pane.close',
      request,
      this.requestHash(request, params),
      paneCloseCommitResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.pane.close', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    const workspace = current.workspaces.find((item) => item.id === request.workspaceId)
    closePane(
      current,
      request.workspaceId,
      request.paneId,
      workspace && Object.keys(workspace.panes).length === 1 ? replacementTabId : null,
      updatedAt
    )
    return null
  }

  public commitPaneClose(
    input: PaneCloseRequest,
    replacementTabId: string,
    updatedAt: number
  ): PaneCloseCommitResult {
    this.requireOpen()
    const request = paneCloseRequestSchema.parse(input)
    return this.commit(
      'node.pane.close',
      request,
      { workspaceId: request.workspaceId, paneId: request.paneId },
      (state) => {
        const workspace = state.workspaces.find((item) => item.id === request.workspaceId)
        return closePane(
          state,
          request.workspaceId,
          request.paneId,
          workspace && Object.keys(workspace.panes).length === 1 ? replacementTabId : null,
          updatedAt
        )
      },
      paneCloseCommitResultSchema,
      (next) => ({
        revision: next.revision,
        replayed: false,
        replacementTabId: next.workspaces.some((item) => item.tabs[replacementTabId])
          ? replacementTabId
          : null
      })
    )
  }

  public pinWorkspace(input: WorkspacePinRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = workspacePinRequestSchema.parse(input)
    const params = { workspaceId: request.workspaceId, pinned: request.pinned }
    return this.commit(
      'node.workspace.pin',
      request,
      params,
      (state) => setWorkspacePinned(state, request.workspaceId, request.pinned),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public selectWorkspaces(input: WorkspaceSelectionReplaceRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = workspaceSelectionReplaceRequestSchema.parse(input)
    const params = {
      selection: request.selection,
      focusedWorkspaceId: request.focusedWorkspaceId
    }
    return this.commit(
      'node.workspace.selectMany',
      request,
      params,
      (state) => replaceWorkspaceSelection(state, request.selection, request.focusedWorkspaceId),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public reorderWorkspace(input: WorkspaceCanonicalMoveRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = workspaceCanonicalMoveRequestSchema.parse(input)
    return this.commit(
      'node.workspace.reorder',
      request,
      { workspaceId: request.workspaceId, destinationIndex: request.destinationIndex },
      (state) => moveWorkspace(state, request.workspaceId, request.destinationIndex),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public preflightWorkspaceBatchClose(
    input: WorkspaceBatchCloseRequest,
    ids: NewWorkspaceIds,
    createdAt: number
  ): WorkspaceCloseCommitResult | null {
    this.requireOpen()
    const request = workspaceBatchCloseRequestSchema.parse(input)
    const payload = request.replacement ? { replacement: request.replacement } : {}
    const replay = this.findReplay(
      'node.workspace.closeSelected',
      request,
      this.requestHash(request, payload),
      workspaceCloseCommitResultSchema
    )
    if (replay) return replay
    this.requireIdempotencyCapacity('node.workspace.closeSelected', request.idempotencyEpoch)
    const current = this.readSnapshot()
    if (current.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    closeSelectedWorkspaces(
      current,
      request.replacement ? { params: request.replacement, ids, createdAt } : undefined
    )
    return null
  }

  public commitWorkspaceBatchClose(
    input: WorkspaceBatchCloseRequest,
    ids: NewWorkspaceIds,
    createdAt: number
  ): WorkspaceCloseCommitResult {
    this.requireOpen()
    const request = workspaceBatchCloseRequestSchema.parse(input)
    const payload = request.replacement ? { replacement: request.replacement } : {}
    return this.commit(
      'node.workspace.closeSelected',
      request,
      payload,
      (state) =>
        closeSelectedWorkspaces(
          state,
          request.replacement ? { params: request.replacement, ids, createdAt } : undefined
        ),
      workspaceCloseCommitResultSchema,
      (next) => {
        const replaced = next.workspaces.some((workspace) => workspace.id === ids.workspaceId)
        return {
          revision: next.revision,
          replayed: false,
          replacementWorkspaceId: replaced ? ids.workspaceId : null,
          replacementPaneId: replaced ? ids.paneId : null,
          replacementTabId: replaced ? ids.tabId : null
        }
      }
    )
  }

  public createGroup(input: GroupCreateRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = groupCreateRequestSchema.parse(input)
    const params = { groupId: request.groupId, name: request.name }
    return this.commit(
      'node.group.create',
      request,
      params,
      (state) => createGroup(state, request.groupId, request.name),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public renameGroup(input: GroupRenameRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = groupRenameRequestSchema.parse(input)
    const params = { groupId: request.groupId, name: request.name }
    return this.commit(
      'node.group.rename',
      request,
      params,
      (state) => renameGroup(state, request.groupId, request.name),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public deleteGroup(input: GroupDeleteRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = groupDeleteRequestSchema.parse(input)
    const params = { groupId: request.groupId }
    return this.commit(
      'node.group.delete',
      request,
      params,
      (state) => deleteGroup(state, request.groupId),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public moveGroup(input: GroupMoveRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = groupMoveRequestSchema.parse(input)
    const params = { groupId: request.groupId, destinationIndex: request.destinationIndex }
    return this.commit(
      'node.group.move',
      request,
      params,
      (state) => moveGroup(state, request.groupId, request.destinationIndex),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public assignGroup(input: GroupAssignRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = groupAssignRequestSchema.parse(input)
    const params = {
      workspaceId: request.workspaceId,
      ...(request.groupId === undefined ? {} : { groupId: request.groupId })
    }
    return this.commit(
      'node.group.assign',
      request,
      params,
      (state) => assignGroup(state, request.workspaceId, request.groupId),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public collapseGroup(input: GroupCollapseRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = groupCollapseRequestSchema.parse(input)
    const params = { groupId: request.groupId, collapsed: request.collapsed }
    return this.commit(
      'node.group.collapse',
      request,
      params,
      (state) => collapseGroup(state, request.groupId, request.collapsed),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public saveLayout(input: LayoutSaveRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = layoutSaveRequestSchema.parse(input)
    const params = {
      layoutId: request.layoutId,
      name: request.name,
      workspaceIds: request.workspaceIds
    }
    return this.commit(
      'node.layout.save',
      request,
      params,
      (state) =>
        saveLayout(state, request.layoutId, request.name, request.workspaceIds, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public deleteLayout(input: LayoutDeleteRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = layoutDeleteRequestSchema.parse(input)
    return this.commit(
      'node.layout.delete',
      request,
      { layoutId: request.layoutId },
      (state) => deleteLayout(state, request.layoutId),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public importLayout(input: LayoutImportRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = layoutImportRequestSchema.parse(input)
    const params = { layoutId: request.layoutId, envelope: request.envelope }
    return this.commit(
      'node.layout.import',
      request,
      params,
      (state) => importLayout(state, request.layoutId, request.envelope, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public preflightLayoutApply(
    input: LayoutApplyRequest
  ):
    | { replay: WorkspaceMutationResult; before?: never; candidate?: never }
    | { replay: null; before: DurableApplicationState; candidate: DurableApplicationState } {
    this.requireOpen()
    const request = layoutApplyRequestSchema.parse(input)
    const replay = this.findReplay(
      'node.layout.apply',
      request,
      this.requestHash(request, {
        layoutId: request.layoutId,
        targetWindowId: request.targetWindowId,
        expectedWindowRevision: request.expectedWindowRevision
      }),
      workspaceMutationResultSchema
    )
    if (replay) return { replay }
    this.requireIdempotencyCapacity('node.layout.apply', request.idempotencyEpoch)
    const before = this.readSnapshot()
    if (before.revision !== request.expectedRevision) {
      throw new StateStoreError('stale_revision', 'Application state changed since this request')
    }
    const placement = before.windowPlacements.find((item) => item.id === request.targetWindowId)
    if (!placement || placement.hostingState !== 'hosted') {
      throw new StateStoreError('stale_revision', 'Target window is no longer hosted')
    }
    if (placement.revision !== request.expectedWindowRevision) {
      throw new StateStoreError('stale_revision', 'Target window changed since this request')
    }
    const candidate = planLayoutApplication(
      before,
      request.layoutId,
      randomUUID,
      request.targetWindowId
    )
    this.assertCurrentLayoutBindings(before, candidate)
    return { replay: null, before, candidate }
  }

  public commitLayoutApply(
    input: LayoutApplyRequest,
    candidate: DurableApplicationState
  ): WorkspaceMutationResult {
    this.requireOpen()
    const request = layoutApplyRequestSchema.parse(input)
    // commit rereads the global revision under SQLite's immediate transaction.
    // Hosting reconciliation advances it, so a revoke during PTY preparation
    // rejects this candidate and the runtime rolls back new sessions.
    return this.commit(
      'node.layout.apply',
      request,
      {
        layoutId: request.layoutId,
        targetWindowId: request.targetWindowId,
        expectedWindowRevision: request.expectedWindowRevision
      },
      (current) => {
        // This runs inside commit's immediate transaction, after its global
        // revision fence. Catalog writes do not necessarily advance that revision.
        this.assertCurrentLayoutBindings(current, candidate)
        return candidate.revision === current.revision ? current : candidate
      },
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public selectWorkspace(input: WorkspaceSelectRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = workspaceSelectRequestSchema.parse(input)
    return this.commit(
      'node.workspace.select',
      request,
      { workspaceId: request.workspaceId },
      (state) => selectWorkspace(state, request.workspaceId),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public selectTab(input: TabSelectRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = tabSelectRequestSchema.parse(input)
    return this.commit(
      'node.tab.select',
      request,
      { workspaceId: request.workspaceId, tabId: request.tabId },
      (state) => selectTab(state, request.workspaceId, request.tabId, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public moveTab(input: TabMoveRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = tabMoveRequestSchema.parse(input)
    return this.commit(
      'node.tab.move',
      request,
      {
        workspaceId: request.workspaceId,
        tabId: request.tabId,
        destinationPaneId: request.destinationPaneId,
        destinationIndex: request.destinationIndex
      },
      (state) =>
        moveTab(
          state,
          {
            workspaceId: request.workspaceId,
            tabId: request.tabId,
            destinationPaneId: request.destinationPaneId,
            destinationIndex: request.destinationIndex
          },
          this.now()
        ),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public updateTab(input: TabUpdateRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = tabUpdateRequestSchema.parse(input)
    return this.commit(
      'node.tab.update',
      request,
      {
        workspaceId: request.workspaceId,
        tabId: request.tabId,
        title: request.title,
        customTitle: request.customTitle
      },
      (state) =>
        updateTab(
          state,
          {
            workspaceId: request.workspaceId,
            tabId: request.tabId,
            ...(request.title === undefined ? {} : { title: request.title }),
            ...(request.customTitle === undefined ? {} : { customTitle: request.customTitle })
          },
          this.now()
        ),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public moveWorkspace(input: WorkspaceMoveRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = workspaceMoveRequestSchema.parse(input)
    return this.commit(
      'node.workspace.move',
      request,
      { workspaceId: request.workspaceId, destinationIndex: request.destinationIndex },
      (state) => moveWorkspace(state, request.workspaceId, request.destinationIndex),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  public updateWorkspace(input: WorkspaceUpdateRequest): WorkspaceMutationResult {
    this.requireOpen()
    const request = workspaceUpdateRequestSchema.parse(input)
    return this.commit(
      'node.workspace.update',
      request,
      request,
      (state) => updateWorkspace(state, request, this.now()),
      workspaceMutationResultSchema,
      (next) => ({ revision: next.revision, replayed: false })
    )
  }

  private requestHash(request: MutationIdentity, payload: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify({ expectedRevision: request.expectedRevision, payload }))
      .digest('hex')
  }

  private findReplay<Result extends WorkspaceMutationResult>(
    namespace: string,
    request: MutationIdentity,
    requestHash: string,
    schema: ZodType<Result>
  ): Result | null {
    if (request.idempotencyEpoch !== this.epoch) {
      throw new StateStoreError('epoch_expired', 'Idempotency epoch has expired')
    }
    const stored = this.database
      .prepare(
        'SELECT request_hash, result_json FROM idempotency_results WHERE namespace = ? AND epoch = ? AND idempotency_key = ?'
      )
      .get(namespace, request.idempotencyEpoch, request.idempotencyKey) as
      { request_hash: string; result_json: string | null } | undefined
    if (!stored) return null
    if (stored.request_hash !== requestHash) {
      throw new StateStoreError(
        'idempotency_conflict',
        'Idempotency key was used for another request'
      )
    }
    if (stored.result_json === null) {
      throw new StateStoreError('result_expired', 'Idempotency result has expired')
    }
    const previous: unknown = JSON.parse(stored.result_json)
    return schema.parse({ ...schema.parse(previous), replayed: true })
  }

  private requireIdempotencyCapacity(namespace: string, epoch: string): void {
    const retainedCount = this.database
      .prepare(
        'SELECT COUNT(*) AS count FROM idempotency_results WHERE namespace = ? AND epoch = ?'
      )
      .get(namespace, epoch) as { count: number }
    if (retainedCount.count >= IDEMPOTENCY_TOMBSTONE_CAP) {
      throw new StateStoreError('idempotency_capacity', 'Idempotency epoch capacity reached')
    }
  }

  private assertCurrentLayoutBindings(
    before: DurableApplicationState,
    candidate: DurableApplicationState
  ): void {
    const bindings = this.database
      .prepare(
        `SELECT workspace_id AS workspaceId, pane_id AS paneId, tab_id AS tabId FROM agent_sessions
         UNION ALL
         SELECT workspace_id AS workspaceId, pane_id AS paneId, tab_id AS tabId FROM remote_sessions`
      )
      .all() as { workspaceId: string; paneId: string; tabId: string }[]
    assertLayoutBindingsPreserved(before, candidate, bindings)
  }

  private commit<Result extends WorkspaceMutationResult>(
    namespace: string,
    request: MutationIdentity,
    payload: unknown,
    mutate: (state: DurableApplicationState) => DurableApplicationState,
    schema: ZodType<Result>,
    makeResult: (state: DurableApplicationState) => Result
  ): Result {
    const requestHash = this.requestHash(request, payload)
    const transaction = this.database.transaction(() => {
      const replay = this.findReplay(namespace, request, requestHash, schema)
      if (replay) return replay

      this.requireIdempotencyCapacity(namespace, request.idempotencyEpoch)

      const current = readLegacySnapshotConnection(this.database)
      if (request.expectedRevision !== current.revision) {
        throw new StateStoreError('stale_revision', 'Application state changed since this request')
      }
      const next = mutate(current)
      if (next.revision === current.revision + 1) {
        const updated = this.database
          .prepare(
            'UPDATE application_snapshot SET revision = ?, json_payload = ?, saved_at_ms = ? WHERE singleton = 1 AND revision = ?'
          )
          .run(String(next.revision), JSON.stringify(next), this.now(), String(current.revision))
        if (updated.changes !== 1) {
          throw new StateStoreError(
            'stale_revision',
            'Application state changed during this request'
          )
        }
      } else if (next !== current || next.revision !== current.revision) {
        throw new Error('State mutation returned an invalid revision transition')
      }
      const ownedWindows = next.windowPlacements.map((placement) => placement.id)
      this.database
        .prepare(
          `DELETE FROM window_state WHERE window_id NOT IN (${ownedWindows.map(() => '?').join(', ')})`
        )
        .run(...ownedWindows)
      const result = schema.parse(makeResult(next))
      if (namespace === 'node.window.create' || namespace === 'node.tab.detach') {
        this.database
          .prepare('INSERT INTO node_window_provenance (window_id) VALUES (?)')
          .run(
            namespace === 'node.window.create'
              ? windowMutationResultSchema.parse(result).window.windowId
              : advancedTabMutationResultSchema.parse(result).placement.windowId
          )
      }
      this.database
        .prepare(
          `DELETE FROM node_window_provenance WHERE window_id NOT IN (${ownedWindows.map(() => '?').join(', ')})`
        )
        .run(...ownedWindows)
      this.database
        .prepare(
          'INSERT INTO idempotency_results (namespace, epoch, idempotency_key, request_hash, result_json, completed_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(
          namespace,
          request.idempotencyEpoch,
          request.idempotencyKey,
          requestHash,
          JSON.stringify(result),
          this.now()
        )
      this.database
        .prepare(
          `UPDATE idempotency_results SET result_json = NULL
           WHERE namespace = ? AND epoch = ? AND sequence NOT IN (
             SELECT sequence FROM idempotency_results WHERE namespace = ? AND epoch = ?
             AND result_json IS NOT NULL ORDER BY completed_at_ms DESC, sequence DESC LIMIT ?
           )`
        )
        .run(
          namespace,
          request.idempotencyEpoch,
          namespace,
          request.idempotencyEpoch,
          IDEMPOTENCY_RESULT_RETENTION
        )
      return result
    })
    return transaction.immediate()
  }

  public close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.database.close()
    } finally {
      this.ownerLock.close()
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('State store is closed')
  }
}
