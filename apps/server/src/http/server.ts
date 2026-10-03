import { serve, type WebSocketServerLike } from '@hono/node-server'
import { WebSocketServer } from 'ws'

import { createApp } from './app'
import { serviceLogger } from '../logging/service-logger'
import type { LegacyStateReader } from '../persistence/legacy-state-reader'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import type { RecentlyClosedService } from '../persistence/recently-closed-service'
import type { TerminalService } from '../terminal/terminal-service'
import type { WorkspaceTerminalRuntime } from '../domain/workspace-terminal-runtime'
import type { HostKeyAuthority } from '../remote/host-key-authority'
import type { RemoteTmuxDiscoveryService } from '../remote/remote-tmux-discovery-service'
import type { RemoteInteractiveRuntime } from '../remote/remote-interactive-runtime'
import type { RemoteSessionActivationService } from '../remote/remote-session-activation-service'
import type { RemoteTargetDeletionService } from '../remote/remote-target-deletion-service'
import type { RemoteCredentialEnrollmentService } from '../remote/remote-credential-enrollment-service'
import type { ContentCatalog } from '../content/content-catalog'
import type { FilesService } from '../content/files-service'
import type { VaultSearch } from '../content/vault-search'
import type { EncryptedVaultSearch } from '../content/encrypted-vault-search'
import type { ContentMutations } from '../content/content-mutations'
import type { TaskCatalog } from '../content/task-catalog'
import type { TaskActions } from '../content/task-actions'
import type { WindowBindingRegistry } from './window-binding-registry'
import type { AgentTeamMutations } from '../persistence/agent-team-mutations'
import type { AgentRegistrationService } from '../agents/agent-registration-service'
import type { NotificationMutations } from '../persistence/notification-mutations'
import type { SettingsMutations } from '../persistence/settings-mutations'
import type { CardSlotAttentionService } from '../domain/card-slot-attention'
import type { ConfigurationQualification } from '../configuration/configuration-qualification'
import type { BrowserAutomationProviderAuthority } from '../browser-automation/provider-authority'
import type { BrowserAutomationDurableRecords } from '../browser-automation/durable-records'
import type { BrowserAutomationRuntime } from '../browser-automation/runtime'

export function startServer(options: {
  service: TerminalService
  token: string
  port: number
  /** The executable owns services separately so startup failures use the same cleanup path. */
  closeOwnedResources?: boolean
  hostname?: string
  stateReader?: LegacyStateReader
  stateStore?: ApplicationStateStore
  workspaceRuntime?: WorkspaceTerminalRuntime
  recentlyClosed?: RecentlyClosedService
  hostKeyAuthority?: HostKeyAuthority
  remoteTmux?: RemoteTmuxDiscoveryService
  contentCatalog?: ContentCatalog
  filesService?: FilesService
  vaultSearch?: VaultSearch | EncryptedVaultSearch
  contentMutations?: ContentMutations
  taskCatalog?: TaskCatalog
  taskActions?: TaskActions
  windowBindings?: WindowBindingRegistry
  remoteInteractive?: RemoteInteractiveRuntime
  remoteActivation?: RemoteSessionActivationService
  remoteTargetDeletion?: RemoteTargetDeletionService
  remoteCredentialEnrollment?: RemoteCredentialEnrollmentService
  remoteCredentialV1Replacement?: RemoteCredentialEnrollmentService
  remoteCredentialLiveReplacement?: RemoteCredentialEnrollmentService
  agentTeamMutations?: AgentTeamMutations
  agentRegistration?: AgentRegistrationService
  notificationMutations?: NotificationMutations
  settingsMutations?: SettingsMutations
  cardSlotAttention?: CardSlotAttentionService
  configurationQualification?: ConfigurationQualification
  diagnosticLogDirectory?: string
  browserAutomation?: {
    authority: BrowserAutomationProviderAuthority
    records: BrowserAutomationDurableRecords
    runtime?: BrowserAutomationRuntime
  }
}) {
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const app = createApp(
    options.service,
    options.token,
    options.stateReader,
    options.stateStore,
    options.workspaceRuntime,
    options.hostKeyAuthority,
    options.remoteTmux,
    options.contentCatalog,
    options.contentMutations,
    options.remoteInteractive,
    options.remoteActivation,
    options.agentTeamMutations,
    options.notificationMutations,
    options.settingsMutations,
    options.recentlyClosed,
    options.taskCatalog,
    options.windowBindings,
    options.filesService,
    options.agentRegistration,
    options.taskActions,
    options.vaultSearch,
    options.cardSlotAttention,
    options.configurationQualification,
    options.remoteTargetDeletion,
    options.remoteCredentialEnrollment,
    options.remoteCredentialV1Replacement,
    options.remoteCredentialLiveReplacement,
    options.diagnosticLogDirectory,
    options.browserAutomation
  )
  const server = serve({
    fetch: app.fetch,
    // ws models `noServer` as optional under exactOptionalPropertyTypes.
    // Hono checks that it is true at runtime; the constructor above sets it.
    websocket: { server: websocket as unknown as WebSocketServerLike },
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port
  })
  const attentionPoll =
    options.cardSlotAttention && options.stateStore
      ? setInterval(() => {
          try {
            if (
              options.stateStore!.readRevision() >
              options.cardSlotAttention!.installedApplicationRevision
            ) {
              options.cardSlotAttention!.refreshAttention()
            }
          } catch {
            serviceLogger.emit('error', 'attentionRefreshFailed')
          }
        }, 500)
      : undefined
  attentionPoll?.unref()

  return {
    server,
    async close(): Promise<void> {
      if (attentionPoll) clearInterval(attentionPoll)
      for (const client of websocket.clients) client.terminate()
      const errors: unknown[] = []
      const cleanup: Array<() => void | Promise<void>> = [
        () =>
          new Promise<void>((resolve, reject) => {
            websocket.close((error) => (error ? reject(error) : resolve()))
          }),
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          }),
        ...(options.closeOwnedResources === false
          ? []
          : [
              () => options.remoteActivation?.dispose(),
              () => options.remoteInteractive?.dispose(),
              () => options.remoteCredentialEnrollment?.close(),
              () => options.remoteCredentialV1Replacement?.close(),
              () => options.service.dispose(),
              () => options.stateReader?.close(),
              () => options.contentCatalog?.close(),
              () => options.filesService?.close(),
              () => options.vaultSearch?.close(),
              () => options.contentMutations?.close(),
              () => options.taskCatalog?.close(),
              () => options.taskActions?.close(),
              () => options.agentTeamMutations?.close(),
              () => options.agentRegistration?.close(),
              () => options.notificationMutations?.close(),
              () => options.settingsMutations?.close(),
              () => options.stateStore?.close()
            ])
      ]
      for (const close of cleanup) {
        try {
          await close()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw errors[0]
    }
  }
}
