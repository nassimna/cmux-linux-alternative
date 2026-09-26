import { createHash, randomUUID } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import Database from 'better-sqlite3'

import { createNodeSessionFile } from '@agent-workspace/client-runtime'

import { ContentCatalog } from './content/content-catalog'
import { FilesService } from './content/files-service'
import { VaultSearch } from './content/vault-search'
import { EncryptedVaultSearch } from './content/encrypted-vault-search'
import { EncryptedIndex } from './content/encrypted-index'
import { loadExistingIndexKey, loadOrCreateIndexKey } from './content/encrypted-index-key'
import { isolatedIndexProfile } from './content/encrypted-index-profile'
import { ContentMutations } from './content/content-mutations'
import { TaskCatalog } from './content/task-catalog'
import { TaskActions } from './content/task-actions'
import { WorkspaceTerminalRuntime } from './domain/workspace-terminal-runtime'
import { CardSlotAttentionService } from './domain/card-slot-attention'
import { ConfigurationQualification } from './configuration/configuration-qualification'
import {
  preflightLiveSettings,
  readArtifact,
  type LiveRuntimeSettings
} from './configuration/live-settings-preflight'
import { stageLiveSettings } from './configuration/live-settings-stage'
import { stageNativeProfileSettings } from './configuration/native-profile-settings'
import { RotatingDiagnosticLog } from './diagnostics/rotating-log'
import { serviceLogger } from './logging/service-logger'
import { startServer } from './http/server'
import { WindowOwnerChannel } from './http/window-owner-channel'
import { ApplicationStateStore, type LiveBackupProof } from './persistence/application-state-store'
import type { LiveOwnerLock } from './persistence/live-owner-lock'
import {
  LIVE_FEATURES,
  preflightLiveCutover,
  type LiveFeaturePolicy
} from './persistence/live-cutover-preflight'
import { assertDisposableLivePreview } from './persistence/live-preview-policy'
import { AgentTeamMutations } from './persistence/agent-team-mutations'
import { AgentRegistrationService } from './agents/agent-registration-service'
import { PrivateCodexProfile } from './agents/private-codex-profile'
import { NotificationMutations } from './persistence/notification-mutations'
import { SettingsMutations } from './persistence/settings-mutations'
import { RecentlyClosedService } from './persistence/recently-closed-service'
import { HostKeyAuthority } from './remote/host-key-authority'
import { migrateApprovedKnownHosts } from './remote/known-hosts-migration'
import { SecretServiceCredentialProvider } from './remote/credential-secret-service'
import { IsolatedCredentialScope } from './remote/credential-scope'
import { LiveCredentialOriginStore } from './remote/live-credential-origin'
import { qualifyLiveCredentialOrigins } from './remote/live-credential-qualification'
import { RemoteInteractiveRuntime } from './remote/remote-interactive-runtime'
import { RemoteSessionActivationService } from './remote/remote-session-activation-service'
import { RemoteTargetDeletionService } from './remote/remote-target-deletion-service'
import { RemoteCredentialEnrollmentService } from './remote/remote-credential-enrollment-service'
import { RemoteTmuxDiscoveryService } from './remote/remote-tmux-discovery-service'
import { NodePtyAdapter } from './terminal/node-pty-adapter'
import { TerminalService } from './terminal/terminal-service'

async function main(): Promise<void> {
  const token = process.env.AGENT_WORKSPACE_SERVER_TOKEN
  if (!token) throw new Error('AGENT_WORKSPACE_SERVER_TOKEN is required')

  const port = Number(process.env.AGENT_WORKSPACE_SERVER_PORT ?? '3774')
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('AGENT_WORKSPACE_SERVER_PORT must be between 0 and 65535')
  }

  const source = process.env.AGENT_WORKSPACE_STATE_SOURCE
  const backup = process.env.AGENT_WORKSPACE_STATE_BACKUP
  const working = process.env.AGENT_WORKSPACE_STATE_WORKING
  const live = process.env.AGENT_WORKSPACE_STATE_LIVE
  const native = process.env.AGENT_WORKSPACE_STATE_NATIVE
  if (native && (live || source || working)) {
    throw new Error('Native ownership cannot be combined with copy or live handoff mode')
  }
  if (native && !backup) throw new Error('Native ownership requires a backup path')
  if (live) assertDisposableLivePreview(live, process.env.AGENT_WORKSPACE_LIVE_PREVIEW === '1')
  if (live !== undefined && (source !== undefined || working !== undefined)) {
    throw new Error('Live ownership and isolated copy mode are mutually exclusive')
  }
  if (live !== undefined && !backup) {
    throw new Error('Live ownership requires an explicit private backup path')
  }
  const copyRequested =
    source !== undefined || working !== undefined || (backup !== undefined && !live && !native)
  if (copyRequested && (!source || !backup || !working)) {
    throw new Error('State copy mode requires source, backup, and working paths together')
  }
  const resumeCopy = process.env.AGENT_WORKSPACE_STATE_RESUME === '1'
  const resumeLive = process.env.AGENT_WORKSPACE_STATE_LIVE_RESUME === '1'
  if (live && resumeCopy) throw new Error('Live ownership cannot resume an isolated copy')
  if (resumeLive && !live) throw new Error('Live resume requires live state ownership')
  if (resumeLive && resumeCopy) throw new Error('Live resume cannot resume an isolated copy')
  if (resumeCopy && !copyRequested) {
    throw new Error('State copy resume requires source, backup, and working paths')
  }
  const liveResumeProof: LiveBackupProof | undefined =
    resumeLive && live && backup
      ? {
          liveStatePath: live,
          backupStatePath: backup,
          liveStateIdentity: process.env.AGENT_WORKSPACE_LIVE_STATE_IDENTITY ?? '',
          backupStateIdentity: process.env.AGENT_WORKSPACE_LIVE_BACKUP_IDENTITY ?? '',
          backupSha256: process.env.AGENT_WORKSPACE_LIVE_BACKUP_SHA256 ?? ''
        }
      : undefined
  const replacementEnvPresent = [
    process.env.AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID,
    process.env.AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID,
    process.env.AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION
  ].some((value) => value !== undefined)
  const liveResumeReplacement =
    resumeLive && replacementEnvPresent
      ? {
          targetId: process.env.AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID ?? '',
          enrollmentId: process.env.AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID ?? '',
          expectedRevision: Number(process.env.AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION)
        }
      : undefined
  const newEnvPresent = [
    process.env.AGENT_WORKSPACE_LIVE_NEW_TARGET_ID,
    process.env.AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID
  ].some((value) => value !== undefined)
  const liveResumeNew =
    resumeLive && newEnvPresent
      ? {
          targetId: process.env.AGENT_WORKSPACE_LIVE_NEW_TARGET_ID ?? '',
          enrollmentId: process.env.AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID ?? ''
        }
      : undefined
  const exactUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
  if (resumeLive && !liveResumeProof) {
    throw new Error('Live resume requires a pinned backup proof')
  }
  if (
    replacementEnvPresent &&
    (!liveResumeReplacement ||
      !exactUuid.test(liveResumeReplacement.targetId) ||
      !exactUuid.test(liveResumeReplacement.enrollmentId) ||
      !Number.isSafeInteger(liveResumeReplacement.expectedRevision) ||
      liveResumeReplacement.expectedRevision < 1 ||
      liveResumeReplacement.expectedRevision >= Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Live replacement resume requires an exact intent')
  }
  if (liveResumeReplacement && process.env.AGENT_WORKSPACE_REMOTE_TRANSPORT !== '1') {
    throw new Error('Live credential resume requires remote transport recovery')
  }
  if (
    newEnvPresent &&
    (!liveResumeNew ||
      liveResumeReplacement ||
      !exactUuid.test(liveResumeNew.targetId) ||
      !exactUuid.test(liveResumeNew.enrollmentId) ||
      liveResumeNew.targetId === liveResumeNew.enrollmentId ||
      process.env.AGENT_WORKSPACE_REMOTE_TRANSPORT !== '1')
  ) {
    throw new Error('Live new credential resume requires an exact intent and remote transport')
  }
  const statePath = working ?? live ?? native
  if (process.env.AGENT_WORKSPACE_REMOTE_HOST_KEYS === '1' && !statePath) {
    throw new Error('Remote host-key preparation requires state ownership')
  }
  if (process.env.AGENT_WORKSPACE_EXPERIMENTAL_VOLATILE_SEARCH === '1' && !working) {
    throw new Error('Experimental volatile search requires an isolated working copy')
  }
  if (process.env.AGENT_WORKSPACE_ENCRYPTED_SEARCH === '1' && !statePath) {
    throw new Error('Encrypted search requires state ownership')
  }
  if (process.env.AGENT_WORKSPACE_CONFIG_QUALIFICATION === '1' && !statePath) {
    throw new Error('Configuration qualification requires state ownership')
  }
  if (
    process.env.AGENT_WORKSPACE_CONFIG_WRITE === '1' &&
    (process.env.AGENT_WORKSPACE_CONFIG_QUALIFICATION !== '1' || !statePath)
  ) {
    throw new Error('Configuration writes require explicit qualification and state ownership')
  }
  const indexProfile =
    process.env.AGENT_WORKSPACE_ENCRYPTED_SEARCH === '1'
      ? source && working
        ? isolatedIndexProfile(source, working)
        : live || native
          ? dirname((live ?? native)!)
          : undefined
      : undefined
  if (
    process.env.AGENT_WORKSPACE_REMOTE_TRANSPORT === '1' &&
    (process.env.AGENT_WORKSPACE_REMOTE_HOST_KEYS !== '1' || !statePath)
  ) {
    throw new Error('Remote transport requires state ownership and host-key authority')
  }
  if (live && !(await AgentRegistrationService.probeConnectedLiveProvider())) {
    throw new Error('Connected default Codex profile is not qualified for live ownership')
  }

  const service = new TerminalService(new NodePtyAdapter())
  let stateStore: ApplicationStateStore | undefined
  let contentCatalog: ContentCatalog | undefined
  let filesService: FilesService | undefined
  let vaultSearch: VaultSearch | EncryptedVaultSearch | undefined
  let contentMutations: ContentMutations | undefined
  let taskCatalog: TaskCatalog | undefined
  let taskActions: TaskActions | undefined
  let agentTeamMutations: AgentTeamMutations | undefined
  let agentRegistration: AgentRegistrationService | undefined
  let notificationMutations: NotificationMutations | undefined
  let cardSlotAttention: CardSlotAttentionService | undefined
  let settingsMutations: SettingsMutations | undefined
  let remoteInteractive: RemoteInteractiveRuntime | undefined
  let remoteActivation: RemoteSessionActivationService | undefined
  let remoteTargetDeletion: RemoteTargetDeletionService | undefined
  let remoteCredentialEnrollment: RemoteCredentialEnrollmentService | undefined
  let configurationQualification: ConfigurationQualification | undefined
  let diagnosticLog: RotatingDiagnosticLog | undefined
  let releaseDiagnosticSink: (() => void) | undefined
  let ownerChannel: WindowOwnerChannel | undefined
  let credentialOriginDatabase: Database.Database | undefined
  let resourcesClosed = false
  async function closeResources(): Promise<void> {
    if (resourcesClosed) return
    resourcesClosed = true
    const cleanup: Array<() => void | Promise<void>> = [
      () => ownerChannel?.close(),
      () => {
        releaseDiagnosticSink?.()
        diagnosticLog?.close()
      },
      () => remoteActivation?.dispose(),
      () => remoteInteractive?.dispose(),
      () => remoteCredentialEnrollment?.close(),
      () => service.dispose(),
      () => contentCatalog?.close(),
      () => filesService?.close(),
      () => vaultSearch?.close(),
      () => contentMutations?.close(),
      () => taskCatalog?.close(),
      () => taskActions?.close(),
      () => agentTeamMutations?.close(),
      () => agentRegistration?.close(),
      () => credentialOriginDatabase?.close(),
      () => notificationMutations?.close(),
      () => settingsMutations?.close(),
      () => stateStore?.close()
    ]
    for (const close of cleanup) {
      try {
        await close()
      } catch {
        serviceLogger.emit('error', 'shutdownFailed')
      }
    }
  }
  try {
    let workspaceRuntime: WorkspaceTerminalRuntime | undefined
    let recentlyClosed: RecentlyClosedService | undefined
    let hostKeyAuthority: HostKeyAuthority | undefined
    let remoteTmux: RemoteTmuxDiscoveryService | undefined
    if (statePath) {
      let qualifiedLiveSettings: LiveRuntimeSettings | undefined
      if (live && backup) {
        const livePreflight = async (
          owner: Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'>
        ) => {
          const rustDesktopConfig = process.env.AGENT_WORKSPACE_RUST_DESKTOP_CONFIG
          if (!rustDesktopConfig) {
            throw new Error('Live ownership requires the explicit Rust desktop settings path')
          }
          const features = Object.fromEntries(
            LIVE_FEATURES.map((feature) => [feature, 'required'])
          ) as LiveFeaturePolicy
          const preflight = await preflightLiveCutover({
            databasePath: live,
            rustDesktopPath: rustDesktopConfig,
            features,
            owner
          })
          const allowedPreviewGaps = new Set([
            'encrypted_index_or_locator_missing',
            'agent_session_migration_unverified',
            'browser_automation_parity_unverified',
            'desktop_integration_unverified'
          ])
          const blockers = preflight.blockers.filter(
            (blocker) =>
              !allowedPreviewGaps.has(blocker) &&
              !(resumeLive && blocker.startsWith('settings_')) &&
              !(
                process.env.AGENT_WORKSPACE_REMOTE_TRANSPORT !== '1' &&
                blocker.startsWith('remote_credential_')
              ) &&
              !(
                process.env.AGENT_WORKSPACE_REMOTE_TRANSPORT !== '1' &&
                blocker.startsWith('trusted_remote_host_key_unavailable:')
              )
          )
          if (blockers.length > 0 || !preflight.runtimeSettings) {
            throw new Error(`Live external preflight failed: ${blockers.join(', ')}`)
          }
          qualifiedLiveSettings = preflight.runtimeSettings
          if (resumeLive) {
            const node = await readArtifact(join(dirname(live), 'config.json'), 'config.json')
            const config = node.config
            if (
              !config ||
              config.notifications.systemEnabled !==
                qualifiedLiveSettings.notificationSettings.systemEnabled ||
              config.notifications.includeBody !==
                qualifiedLiveSettings.notificationSettings.includeBody ||
              JSON.stringify(Object.entries(config.keyboardShortcuts.overrides).sort()) !==
                JSON.stringify(Object.entries(qualifiedLiveSettings.shortcutOverrides).sort())
            ) {
              throw new Error('Live Node settings do not match current state')
            }
            return
          }
          const observed = await preflightLiveSettings(
            rustDesktopConfig,
            join(dirname(live), 'config.json'),
            qualifiedLiveSettings
          )
          if (
            observed.blockers.length > 0 &&
            !(observed.blockers.length === 1 && observed.blockers[0] === 'node_config_missing')
          ) {
            throw new Error(`Live settings are not qualified: ${observed.blockers.join(', ')}`)
          }
        }
        stateStore = resumeLive
          ? await ApplicationStateStore.resumeLive(
              live,
              backup,
              liveResumeProof!,
              Date.now,
              livePreflight
            )
          : await ApplicationStateStore.openLive(
              live,
              backup,
              Date.now,
              livePreflight,
              async (owner) => {
                const rustDesktopConfig = process.env.AGENT_WORKSPACE_RUST_DESKTOP_CONFIG
                if (!rustDesktopConfig || !qualifiedLiveSettings) {
                  throw new Error('Live settings preflight did not complete')
                }
                const nodeConfig = join(dirname(live), 'config.json')
                const observed = await preflightLiveSettings(
                  rustDesktopConfig,
                  nodeConfig,
                  qualifiedLiveSettings
                )
                const settings =
                  observed.blockers.length === 1 && observed.blockers[0] === 'node_config_missing'
                    ? await stageLiveSettings(
                        rustDesktopConfig,
                        nodeConfig,
                        qualifiedLiveSettings,
                        owner
                      )
                    : observed
                if (settings.blockers.length > 0) {
                  throw new Error(
                    `Live settings are not qualified: ${settings.blockers.join(', ')}`
                  )
                }
              }
            )
      } else if (native && backup) {
        stateStore = await ApplicationStateStore.openNative(
          native,
          backup,
          process.env.AGENT_WORKSPACE_DEFAULT_WORKING_DIRECTORY ?? homedir()
        )
      } else if (source && backup && working) {
        stateStore = resumeCopy
          ? await ApplicationStateStore.resumeCopy(source, backup, working)
          : await ApplicationStateStore.prepareCopy(source, backup, working)
      }
      if (!stateStore) throw new Error('State ownership mode is incomplete')
      if (native) await stageNativeProfileSettings(native, stateStore)
      const privateCodexProfile =
        source && working
          ? await PrivateCodexProfile.prepare(source, working, process.env.CODEX_HOME)
          : undefined
      if (privateCodexProfile) {
        process.env.CODEX_HOME = privateCodexProfile.home
        privateCodexProfile.assertCurrent()
      }
      const log = new RotatingDiagnosticLog(join(dirname(statePath), 'logs'))
      diagnosticLog = log
      releaseDiagnosticSink = serviceLogger.addSink((line) => log.writeLine(line))
      if (live || native || process.env.AGENT_WORKSPACE_CONFIG_QUALIFICATION === '1') {
        configurationQualification = live
          ? await ConfigurationQualification.createLive(live, stateStore, service)
          : await ConfigurationQualification.create(
              (working ?? native)!,
              stateStore,
              native !== undefined || process.env.AGENT_WORKSPACE_CONFIG_WRITE === '1',
              service
            )
        await configurationQualification.initializeTerminalRuntime()
      }
      contentCatalog = new ContentCatalog(statePath)
      if (process.platform === 'linux') {
        filesService = new FilesService(stateStore)
        if (process.env.AGENT_WORKSPACE_EXPERIMENTAL_VOLATILE_SEARCH === '1') {
          vaultSearch = new VaultSearch(filesService)
        } else if (indexProfile) {
          let key: Buffer | undefined
          try {
            key = live
              ? await loadExistingIndexKey(indexProfile)
              : await loadOrCreateIndexKey(indexProfile)
            vaultSearch = new EncryptedVaultSearch(
              live
                ? EncryptedIndex.openExisting(indexProfile, key)
                : EncryptedIndex.open(indexProfile, key),
              filesService,
              stateStore
            )
          } catch {
            if (live) throw new Error('Live encrypted search could not be qualified')
            serviceLogger.emit('warn', 'encryptedIndexUnavailable')
          } finally {
            key?.fill(0)
          }
        }
      }
      contentMutations = new ContentMutations(statePath)
      agentTeamMutations = new AgentTeamMutations(statePath)
      cardSlotAttention = new CardSlotAttentionService(() => stateStore!.readSnapshot())
      notificationMutations = new NotificationMutations(statePath, () =>
        cardSlotAttention!.refreshAttention()
      )
      settingsMutations = new SettingsMutations(statePath, 'nonMac')
      if (process.env.AGENT_WORKSPACE_WINDOW_OWNER_CHANNEL === '1') {
        if (!fstatSync(3).isSocket()) {
          throw new Error('Window owner channel requires an inherited private socket')
        }
        ownerChannel = new WindowOwnerChannel(
          new Socket({ fd: 3, readable: true, writable: true }),
          stateStore,
          {
            databasePath: statePath,
            digestKey: createHash('sha256')
              .update('node-browser-automation-v1\0')
              .update(token)
              .digest()
          }
        )
      }
      workspaceRuntime = new WorkspaceTerminalRuntime(service)
      await workspaceRuntime.restore(stateStore.readSnapshot())
      agentRegistration = new AgentRegistrationService(
        statePath,
        stateStore,
        workspaceRuntime,
        service,
        ownerChannel?.agentHibernationAuthority,
        privateCodexProfile
          ? { isolatedCopy: true, privateProfile: privateCodexProfile }
          : { isolatedCopy: false }
      )
      if (live) {
        if (!(await agentRegistration.initializeLiveProvider())) {
          throw new Error('Connected default Codex profile changed during live startup')
        }
      } else if (native) {
        await agentRegistration.initializeLiveProvider()
      } else {
        const privateThreadId = process.env.AGENT_WORKSPACE_PRIVATE_CODEX_THREAD_ID
        if (privateThreadId) await agentRegistration.inspectPrivateProvider(privateThreadId)
      }
      await agentRegistration.initializeFork()
      recentlyClosed = new RecentlyClosedService(
        stateStore,
        Date.now,
        workspaceRuntime.recentlyClosedAdapter()
      )
      if (process.env.AGENT_WORKSPACE_REMOTE_HOST_KEYS === '1') {
        if (live) {
          const { targets, nextCursor } = stateStore.listRemoteTargets({ limit: 128 })
          if (nextCursor) throw new Error('Remote target catalog exceeds the Rust target bound')
          const pending = new Set(
            stateStore.pendingRemoteTargetDeletions().map((request) => request.remoteTargetId)
          )
          hostKeyAuthority = await HostKeyAuthority.openLive(
            live,
            targets.filter((target) => !pending.has(target.remoteTargetId))
          )
        } else if (native) {
          const { targets, nextCursor } = stateStore.listRemoteTargets({ limit: 128 })
          if (nextCursor) throw new Error('Remote target catalog exceeds the target bound')
          const pending = new Set(
            stateStore.pendingRemoteTargetDeletions().map((request) => request.remoteTargetId)
          )
          hostKeyAuthority = await HostKeyAuthority.openLive(
            native,
            targets.filter((target) => !pending.has(target.remoteTargetId))
          )
        } else if (source && working) {
          const sourceDirectory = await realpath(dirname(source))
          const workingDirectory = await realpath(dirname(working))
          if (sourceDirectory !== dirname(source) || workingDirectory !== dirname(working)) {
            throw new Error(
              'Remote host-key mode requires canonical source and working directories'
            )
          }
          if (sourceDirectory === workingDirectory) {
            throw new Error('Remote host-key mode requires separate source and working directories')
          }
          const knownHostsRoot = join(workingDirectory, 'remote-known-hosts')
          let rootExists = true
          try {
            await lstat(knownHostsRoot)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            rootExists = false
          }
          if (!rootExists) {
            const { targets, nextCursor } = stateStore.listRemoteTargets({ limit: 128 })
            if (nextCursor) throw new Error('Remote target catalog exceeds the Rust target bound')
            await migrateApprovedKnownHosts({
              sourceStatePath: source,
              destinationStatePath: working,
              targets
            })
          }
          hostKeyAuthority = await HostKeyAuthority.create(knownHostsRoot)
        }
        if (process.env.AGENT_WORKSPACE_REMOTE_TRANSPORT === '1') {
          if (!hostKeyAuthority) throw new Error('Remote host-key authority is unavailable')
          const brokerRoot = join(
            process.env.XDG_RUNTIME_DIR ?? tmpdir(),
            `aw-ssh-${process.getuid?.()}-${createHash('sha256').update(statePath).digest('hex').slice(0, 16)}`
          )
          let credentials: SecretServiceCredentialProvider
          let liveCredentialOwner:
            Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'> | undefined
          if (live) {
            const owner = stateStore.liveOwnerEvidence(live)
            liveCredentialOwner = owner
            credentialOriginDatabase = new Database(live, { fileMustExist: true, timeout: 5_000 })
            credentialOriginDatabase.pragma('foreign_keys = ON')
            const origins = new LiveCredentialOriginStore(credentialOriginDatabase)
            credentials = await SecretServiceCredentialProvider.createLive(
              brokerRoot,
              live,
              origins,
              owner
            )
          } else if (working || native) {
            credentials = await SecretServiceCredentialProvider.create(
              brokerRoot,
              IsolatedCredentialScope.loadOrCreate((working ?? native)!)
            )
          } else {
            throw new Error('Remote credential state is unavailable')
          }
          remoteTmux = new RemoteTmuxDiscoveryService(stateStore, hostKeyAuthority, credentials)
          remoteInteractive = new RemoteInteractiveRuntime(service)
          remoteActivation = new RemoteSessionActivationService(
            stateStore,
            hostKeyAuthority,
            credentials,
            remoteInteractive
          )
          remoteTargetDeletion = new RemoteTargetDeletionService(
            stateStore,
            remoteActivation,
            hostKeyAuthority,
            credentials
          )
          await remoteTargetDeletion.recoverPending()
          if (live) {
            const origins = new LiveCredentialOriginStore(credentialOriginDatabase!)
            const { targets, nextCursor } = stateStore.listRemoteTargets({ limit: 128 })
            if (nextCursor) throw new Error('Remote target catalog exceeds the Rust target bound')
            const qualified = await qualifyLiveCredentialOrigins(targets, origins, credentials)
            if (qualified.missing.length > 0) {
              throw new Error('Live remote credentials are incomplete')
            }
            for (const target of targets) {
              const origin = origins.read(target.remoteTargetId)
              const present =
                origin === 'v1_eligible'
                  ? await credentials.hasV1(target.remoteTargetId)
                  : origin === 'v2_committed' && (await credentials.has(target.remoteTargetId))
              if (!present) throw new Error('Live remote credentials are incomplete')
            }
            liveCredentialOwner!.assertDatabaseUnchanged()
          }
          remoteCredentialEnrollment = await RemoteCredentialEnrollmentService.create({
            workingStatePath: statePath,
            keyring: credentials,
            liveMode: !!live,
            nativeMode: !!native,
            ...(liveResumeNew
              ? { preserveLiveNew: { ...liveResumeNew, owner: liveCredentialOwner! } }
              : {}),
            ...(liveResumeReplacement
              ? {
                  preserveLiveReplacement: {
                    ...liveResumeReplacement,
                    owner: liveCredentialOwner!
                  }
                }
              : {}),
            revokeTargetTransports: async (targetId) => {
              const sessions = stateStore!.remoteSessionsForTargetDeletion(targetId)
              for (const session of sessions) {
                await remoteActivation!.terminate(
                  session.remoteSessionId,
                  session.attemptGeneration
                )
              }
            }
          })
        }
      }
    }
    if (process.env.AGENT_WORKSPACE_WINDOW_OWNER_CHANNEL === '1' && !ownerChannel) {
      throw new Error('Window owner channel requires state ownership')
    }
    if (ownerChannel && statePath) {
      taskCatalog = new TaskCatalog(statePath, {
        agents: agentRegistration?.providerProfileQualified() ?? false,
        remotes: remoteActivation !== undefined
      })
      if (remoteActivation) taskActions = new TaskActions(statePath, stateStore!, remoteActivation)
    }

    const running = startServer({
      service,
      token,
      port,
      closeOwnedResources: false,
      ...(stateStore ? { stateStore } : {}),
      ...(workspaceRuntime ? { workspaceRuntime } : {}),
      ...(recentlyClosed ? { recentlyClosed } : {}),
      ...(hostKeyAuthority ? { hostKeyAuthority } : {}),
      ...(remoteTmux ? { remoteTmux } : {}),
      ...(remoteInteractive ? { remoteInteractive } : {}),
      ...(remoteActivation ? { remoteActivation } : {}),
      ...(remoteTargetDeletion ? { remoteTargetDeletion } : {}),
      // The live helper stores only a key; HTTP commit publishes target and origin together.
      ...(remoteCredentialEnrollment ? { remoteCredentialEnrollment } : {}),
      ...(remoteCredentialEnrollment && live
        ? { remoteCredentialLiveReplacement: remoteCredentialEnrollment }
        : {}),
      ...(contentCatalog ? { contentCatalog } : {}),
      ...(filesService ? { filesService } : {}),
      ...(vaultSearch ? { vaultSearch } : {}),
      ...(contentMutations ? { contentMutations } : {}),
      ...(taskCatalog ? { taskCatalog, windowBindings: ownerChannel!.registry } : {}),
      ...(ownerChannel?.automationRecords
        ? {
            browserAutomation: {
              authority: ownerChannel.automation,
              records: ownerChannel.automationRecords,
              ...(ownerChannel.automationRuntime ? { runtime: ownerChannel.automationRuntime } : {})
            }
          }
        : {}),
      ...(taskActions ? { taskActions } : {}),
      ...(agentTeamMutations ? { agentTeamMutations } : {}),
      ...(agentRegistration ? { agentRegistration } : {}),
      ...(notificationMutations ? { notificationMutations } : {}),
      ...(cardSlotAttention ? { cardSlotAttention } : {}),
      ...(settingsMutations ? { settingsMutations } : {}),
      ...(configurationQualification ? { configurationQualification } : {}),
      ...(diagnosticLog && configurationQualification && statePath
        ? { diagnosticLogDirectory: join(dirname(statePath), 'logs') }
        : {})
    })
    let sessionGuard: Awaited<ReturnType<typeof createNodeSessionFile>> | undefined
    let publication: Promise<void> | undefined
    let stopping = false
    async function stop(): Promise<void> {
      if (stopping) return
      stopping = true
      try {
        await publication?.catch(() => {})
        await sessionGuard?.remove()
      } finally {
        try {
          await running.close()
        } finally {
          await closeResources()
        }
      }
    }
    running.server.on('listening', () => {
      publication = (async () => {
        const address = running.server.address()
        if (typeof address !== 'object' || !address) throw new Error('Listener has no address')
        const sessionPath = process.env.AGENT_WORKSPACE_NODE_SESSION_FILE
        if (sessionPath) {
          sessionGuard = await createNodeSessionFile(sessionPath, {
            application: 'agent-workspace',
            apiVersion: 1,
            baseUrl: `http://127.0.0.1:${address.port}/`,
            token,
            sessionId: randomUUID()
          })
        }
        console.log(`[server] listening on 127.0.0.1:${address.port}`)
      })()
      void publication.catch(() => {
        serviceLogger.emit('error', 'cliDiscoveryFailed')
        process.exitCode = 1
        void stop().catch(() => serviceLogger.emit('error', 'shutdownFailed'))
      })
    })
    running.server.on('error', () => {
      serviceLogger.emit('error', 'listenerFailed')
      process.exitCode = 1
      void stop().catch(() => serviceLogger.emit('error', 'shutdownFailed'))
    })
    process.on(
      'SIGINT',
      () => void stop().catch(() => serviceLogger.emit('error', 'shutdownFailed'))
    )
    process.on(
      'SIGTERM',
      () => void stop().catch(() => serviceLogger.emit('error', 'shutdownFailed'))
    )
  } catch (error) {
    await closeResources()
    throw error
  }
}

void main().catch((error: unknown) => {
  if (process.env.AGENT_WORKSPACE_DEBUG_STARTUP === '1') console.error(error)
  if (error instanceof Error && error.message.startsWith('Live external preflight failed:')) {
    process.stderr.write(`${error.message}\n`)
  }
  serviceLogger.emit('error', 'startupFailed')
  process.exitCode = 1
})
