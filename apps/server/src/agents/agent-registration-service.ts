import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import Database from 'better-sqlite3'

import { CodexAdapter, CodexAdapterError } from './codex-adapter'
import { codexCheckpoint, type CodexCheckpoint } from './codex-checkpoint'
import { sealedLaunchAvailable, withSealedExecutable } from './sealed-executable'
import type { WorkspaceTerminalRuntime } from '../domain/workspace-terminal-runtime'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import {
  AgentMutationError,
  AgentMutations,
  type AgentCatalogRegisterParams
} from '../persistence/agent-mutations'
import { AgentLifecycleMutations } from '../persistence/agent-lifecycle-mutations'
import { AgentForkMutations } from '../persistence/agent-fork-mutations'
import type { AgentHibernationAuthority } from '../persistence/agent-hibernation-challenges'
import type { TerminalService } from '../terminal/terminal-service'
import { AgentHibernationService } from './agent-hibernation-service'
import { supportsAuditedCodexFork } from './codex-versions'
import type { PrivateCodexProfile, PrivateCodexThreadRecord } from './private-codex-profile'

/** Binds a schema-v15 registration to one live terminal and one audited provider thread. */
const TRUSTED_CODEX_VERSIONS = new Set(['0.142.4', '0.156.1'])

export class AgentRegistrationService {
  private readonly database: Database.Database
  private readonly mutations: AgentMutations
  private readonly lifecycle: AgentLifecycleMutations
  private readonly forks: AgentForkMutations
  private readonly hibernation?: AgentHibernationService
  private readonly verifiedTerminals = new Map<string, string>()
  private privateProviderEvidence: PrivateCodexThreadRecord | undefined
  private liveProviderHome: string | undefined
  private liveProviderIdentity: string | undefined
  private qualifiedAdapterVersion: string | undefined
  private forkProviderReady = false

  constructor(
    databasePath: string,
    private readonly state: ApplicationStateStore,
    private readonly runtime: WorkspaceTerminalRuntime,
    private readonly terminals: TerminalService,
    hibernationAuthority?: AgentHibernationAuthority,
    private readonly options: {
      isolatedCopy?: boolean
      privateProfile?: PrivateCodexProfile
    } = {}
  ) {
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      let file: ReturnType<typeof lstatSync>
      try {
        file = lstatSync(path)
      } catch (error) {
        if (path !== databasePath && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new AgentMutationError('runtime_unavailable', 'Agent database is unavailable')
      }
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
        throw new AgentMutationError(
          'runtime_unavailable',
          'Agent database must be a private regular file'
        )
      }
    }
    this.database = new Database(databasePath, { fileMustExist: true, timeout: 5_000 })
    try {
      this.database.pragma('foreign_keys = ON')
      if (this.database.pragma('user_version', { simple: true }) !== 15) {
        throw new AgentMutationError(
          'runtime_unavailable',
          'Agent database requires Rust schema-v15'
        )
      }
      this.database.prepare('SELECT revision FROM agent_catalog_state WHERE singleton = 1').get()
      this.mutations = new AgentMutations(this.database, {
        prepareRegistration: (params) => this.prepare(params)
      })
      this.lifecycle = new AgentLifecycleMutations(this.database, {
        live: (session) => this.liveBinding(session),
        canResume: (session) => this.canResume(session),
        resume: (session) => this.resume(session)
      })
      this.forks = new AgentForkMutations(this.database, databasePath, {
        destinationLive: (binding) => this.destinationLive(binding),
        prepare: (source, version, destination) => this.prepareFork(source, version, destination),
        archive: (destination, version) => this.archiveFork(destination, version)
      })
      if (hibernationAuthority) {
        this.hibernation = new AgentHibernationService(
          this.database,
          this.state,
          this.runtime,
          hibernationAuthority,
          (session) =>
            this.liveBinding(session) ? this.runtime.sessionForTab(session.tab_id) : undefined,
          (session) => this.verifyCheckpoint(session)
        )
      }
      this.lifecycle.interruptPendingRestores()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  close(): void {
    this.verifiedTerminals.clear()
    this.privateProviderEvidence = undefined
    this.liveProviderHome = undefined
    this.liveProviderIdentity = undefined
    this.qualifiedAdapterVersion = undefined
    this.database.close()
  }

  /** Qualify the connected default Codex profile without reading or copying credentials. */
  async initializeLiveProvider(): Promise<boolean> {
    this.liveProviderHome = undefined
    this.liveProviderIdentity = undefined
    this.qualifiedAdapterVersion = undefined
    if (this.options.isolatedCopy) return false
    const qualified = await AgentRegistrationService.probeConnectedLiveProvider()
    if (!qualified) return false
    this.liveProviderHome = qualified.home
    this.liveProviderIdentity = qualified.identity
    this.qualifiedAdapterVersion = qualified.version
    return true
  }

  /** Read-only startup gate, usable before the first live SQLite write. */
  static async probeConnectedLiveProvider(): Promise<
    | {
        home: string
        identity: string
        version: string
      }
    | undefined
  > {
    const home = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
    let adapter: CodexAdapter | undefined
    try {
      const directory = lstatSync(home)
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.uid !== process.getuid?.() ||
        (directory.mode & 0o022) !== 0 ||
        realpathSync(home) !== home
      ) {
        return undefined
      }
      adapter = await CodexAdapter.fromExecutable('codex', home)
      if (
        !TRUSTED_CODEX_VERSIONS.has(adapter.descriptor.version) ||
        !(await adapter.privateLoginReady()) ||
        !sealedLaunchAvailable()
      ) {
        return undefined
      }
      return {
        home,
        identity: `${directory.dev}:${directory.ino}`,
        version: adapter.descriptor.version
      }
    } catch {
      return undefined
    } finally {
      adapter?.close()
    }
  }

  private currentLiveProviderHome(): string {
    return resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  }

  private liveProviderStillCurrent(): boolean {
    if (!this.liveProviderHome || this.liveProviderHome !== this.currentLiveProviderHome()) {
      return false
    }
    try {
      const directory = lstatSync(this.liveProviderHome)
      return (
        directory.isDirectory() &&
        !directory.isSymbolicLink() &&
        directory.uid === process.getuid?.() &&
        (directory.mode & 0o022) === 0 &&
        realpathSync(this.liveProviderHome) === this.liveProviderHome &&
        `${directory.dev}:${directory.ino}` === this.liveProviderIdentity
      )
    } catch {
      return false
    }
  }

  /** Read-only preparation. A login and thread/read do not prove an authenticated PTY resume. */
  async inspectPrivateProvider(threadId: string): Promise<boolean> {
    this.privateProviderEvidence = undefined
    this.qualifiedAdapterVersion = undefined
    const profile = this.options.isolatedCopy ? this.options.privateProfile : undefined
    if (!profile || process.env.CODEX_HOME !== profile.home) return false
    let adapter: CodexAdapter | undefined
    try {
      const record = profile.findThreadRecord(threadId)
      if (!record) return false
      adapter = await CodexAdapter.fromExecutable('codex', profile.home)
      if (
        !TRUSTED_CODEX_VERSIONS.has(adapter.descriptor.version) ||
        !(await adapter.privateLoginReady())
      ) {
        return false
      }
      await adapter.prepareResume(record.threadId)
      profile.assertThreadRecord(record)
      this.privateProviderEvidence = record
      this.qualifiedAdapterVersion = adapter.descriptor.version
      return true
    } catch {
      return false
    } finally {
      adapter?.close()
    }
  }

  privateProviderEvidenceAvailable(): boolean {
    const evidence = this.privateProviderEvidence
    const profile = this.options.privateProfile
    if (!evidence || !profile || process.env.CODEX_HOME !== profile.home) return false
    try {
      profile.assertThreadRecord(evidence)
      return true
    } catch {
      this.privateProviderEvidence = undefined
      this.qualifiedAdapterVersion = undefined
      return false
    }
  }

  /** Only the version proven by the private profile probe may be advertised. */
  qualifiedProviderVersion(): string | undefined {
    return this.providerProfileQualified() ? this.qualifiedAdapterVersion : undefined
  }

  register(params: AgentCatalogRegisterParams) {
    this.requireProviderProfile()
    return this.state.exclusive(() => this.mutations.register(params))
  }

  assessRestore(input: unknown) {
    return this.state.exclusive(() => this.lifecycle.assess(input))
  }

  /** Dispatches only a verified in-process PTY or an audited, sealed provider resume. */
  restore(input: unknown) {
    this.requireProviderProfile()
    return this.state.exclusive(() => this.lifecycle.restore(input))
  }

  /** Startup recovery must complete before the route or capability can expose fork. */
  async initializeFork(): Promise<boolean> {
    if (!this.providerProfileQualified()) return false
    try {
      await this.recoverForkOrphans()
      this.forkProviderReady =
        sealedLaunchAvailable() && supportsAuditedCodexFork(await CodexAdapter.installedVersion())
    } catch {
      this.forkProviderReady = false
    }
    return this.forkAvailable()
  }

  forkAvailable(): boolean {
    return (
      this.providerProfileQualified() &&
      this.forkProviderReady &&
      !this.forks.hasUnresolvedOrphans()
    )
  }

  forkSession(input: unknown) {
    this.requireProviderProfile()
    return this.state.exclusive(() => {
      if (!this.forkAvailable())
        throw new AgentMutationError('provider_unavailable', 'Audited Codex fork is unavailable')
      return this.forks.fork(input)
    })
  }

  recoverForkOrphans() {
    this.requireProviderProfile()
    return this.state.exclusive(() => this.forks.recoverOrphans())
  }

  /** A copied profile needs a private login, exact thread probe, and sealed PTY support. */
  providerProfileQualified(): boolean {
    return this.options.isolatedCopy
      ? this.privateProviderEvidenceAvailable() && sealedLaunchAvailable()
      : this.liveProviderStillCurrent() && sealedLaunchAvailable()
  }

  private requireProviderProfile(): void {
    if (!this.providerProfileQualified()) {
      throw new AgentMutationError(
        'provider_unavailable',
        'Agent provider profile is not qualified'
      )
    }
  }

  private privateThreadRecord(threadId: string): PrivateCodexThreadRecord | undefined {
    if (!this.options.isolatedCopy) return undefined
    const profile = this.options.privateProfile
    if (!profile || process.env.CODEX_HOME !== profile.home) {
      throw new AgentMutationError('provider_unavailable', 'Isolated Codex profile is unavailable')
    }
    try {
      const record = profile.findThreadRecord(threadId)
      if (!record) {
        throw new AgentMutationError('provider_unavailable', 'Private Codex thread is unavailable')
      }
      profile.assertThreadRecord(record)
      return record
    } catch (error) {
      if (error instanceof AgentMutationError) throw error
      throw new AgentMutationError('provider_unavailable', 'Private Codex thread is unavailable')
    }
  }

  private async requirePrivateLogin(adapter: CodexAdapter): Promise<void> {
    if (this.options.isolatedCopy && !(await adapter.privateLoginReady())) {
      throw new AgentMutationError('provider_unavailable', 'Private Codex login is unavailable')
    }
  }

  hibernationAvailable(): boolean {
    return this.hibernation !== undefined
  }

  hibernatePreflight(input: unknown) {
    return this.requireHibernation().preflight(input)
  }

  hibernateCancel(input: unknown) {
    return this.requireHibernation().cancel(input)
  }

  hibernateConfirm(input: unknown) {
    return this.requireHibernation().confirm(input)
  }

  private requireHibernation(): AgentHibernationService {
    if (!this.hibernation)
      throw new AgentMutationError('provider_unavailable', 'Hibernation authority is unavailable')
    return this.hibernation
  }

  private destinationLive(binding: {
    workspaceId: string
    paneId: string
    tabId: string
  }): boolean {
    const workspace = this.state
      .readSnapshot()
      .workspaces.find((item) => item.id === binding.workspaceId)
    const pane = workspace?.panes[binding.paneId]
    const tab = workspace?.tabs[binding.tabId]
    if (
      !pane?.tabs.includes(binding.tabId) ||
      tab?.paneId !== binding.paneId ||
      tab.content.kind !== 'terminal'
    )
      return false
    const id = this.runtime.sessionForTab(binding.tabId)
    if (!id) return false
    try {
      return !this.terminals.attach(id).terminal.exited
    } catch {
      return false
    }
  }

  private async prepareFork(
    source: string,
    version: string,
    destination: { workspaceId: string; paneId: string; tabId: string }
  ) {
    const record = this.privateThreadRecord(source)
    const adapter = await CodexAdapter.fromExecutable('codex', this.options.privateProfile?.home)
    try {
      if (!supportsAuditedCodexFork(version) || adapter.descriptor.version !== version)
        throw new AgentMutationError('provider_unavailable', 'Audited Codex fork is unavailable')
      await this.requirePrivateLogin(adapter)
      await adapter.verifyThread(source)
      if (record) this.options.privateProfile?.assertThreadRecord(record)
      const result = await adapter.forkThread(source)
      return {
        destinationAgentSessionId: result.destinationThreadId,
        launch: async () => {
          this.options.privateProfile?.secureForkThreadRecord(result.destinationThreadId)
          this.privateThreadRecord(result.destinationThreadId)
          const workspace = this.state
            .readSnapshot()
            .workspaces.find((item) => item.id === destination.workspaceId)
          const tab = workspace?.tabs[destination.tabId]
          if (
            !workspace?.panes[destination.paneId]?.tabs.includes(destination.tabId) ||
            tab?.paneId !== destination.paneId ||
            tab.content.kind !== 'terminal'
          )
            throw new AgentMutationError(
              'runtime_unavailable',
              'Fork destination binding disappeared'
            )
          const launch = tab.content.launch
          await withSealedExecutable(result.launch, (command) =>
            this.runtime.replaceAgentTerminal(
              this.state,
              destination.workspaceId,
              destination.paneId,
              destination.tabId,
              launch,
              command
            )
          )
          const terminalId = this.runtime.sessionForTab(destination.tabId)
          if (!terminalId)
            throw new AgentMutationError('runtime_unavailable', 'Forked terminal is unavailable')
          this.verifiedTerminals.set(result.destinationThreadId, terminalId)
        },
        archive: () => adapter.archiveThread(result.destinationThreadId),
        close: () => adapter.close()
      }
    } catch (error) {
      adapter.close()
      throw error
    }
  }

  private async archiveFork(destination: string, version: string): Promise<void> {
    const adapter = await CodexAdapter.fromExecutable('codex', this.options.privateProfile?.home)
    try {
      if (!supportsAuditedCodexFork(version) || adapter.descriptor.version !== version)
        throw new AgentMutationError(
          'provider_unavailable',
          'Audited Codex fork cleanup is unavailable'
        )
      await adapter.archiveThread(destination)
    } finally {
      adapter.close()
    }
  }

  private liveBinding(binding: {
    agent_session_id: string
    workspace_id: string
    pane_id: string
    tab_id: string
  }): boolean {
    const workspace = this.state
      .readSnapshot()
      .workspaces.find((item) => item.id === binding.workspace_id)
    const pane = workspace?.panes[binding.pane_id]
    const tab = workspace?.tabs[binding.tab_id]
    if (
      !pane?.tabs.includes(binding.tab_id) ||
      tab?.paneId !== binding.pane_id ||
      tab.content.kind !== 'terminal'
    )
      return false
    const terminalId = this.runtime.sessionForTab(binding.tab_id)
    if (!terminalId || this.verifiedTerminals.get(binding.agent_session_id) !== terminalId)
      return false
    try {
      return !this.terminals.attach(terminalId).terminal.exited
    } catch {
      return false
    }
  }

  private async prepare(params: AgentCatalogRegisterParams): Promise<void> {
    this.requireProviderProfile()
    const binding = params.binding
    const record = this.privateThreadRecord(binding.agentSessionId)
    const workspace = this.state
      .readSnapshot()
      .workspaces.find((item) => item.id === binding.workspaceId)
    const pane = workspace?.panes[binding.paneId]
    const tab = workspace?.tabs[binding.tabId]
    if (
      !pane?.tabs.includes(binding.tabId) ||
      tab?.paneId !== binding.paneId ||
      tab.content.kind !== 'terminal'
    ) {
      throw new AgentMutationError('runtime_unavailable', 'The exact terminal binding is not live')
    }
    const terminalId = this.runtime.sessionForTab(binding.tabId)
    if (!terminalId || this.terminals.attach(terminalId).terminal.exited) {
      throw new AgentMutationError('runtime_unavailable', 'The exact terminal binding is not live')
    }
    if (params.adapterId !== 'codex' || !TRUSTED_CODEX_VERSIONS.has(params.adapterVersion)) {
      throw new AgentMutationError('provider_unavailable', 'The trusted adapter is unavailable')
    }
    let adapter: CodexAdapter | undefined
    try {
      adapter = await CodexAdapter.fromExecutable('codex', this.options.privateProfile?.home)
      if (adapter.descriptor.version !== params.adapterVersion)
        throw new AgentMutationError(
          'provider_unavailable',
          'The recorded Codex version is unavailable'
        )
      await this.requirePrivateLogin(adapter)
      await adapter.prepareResume(binding.agentSessionId)
      if (record) this.options.privateProfile?.assertThreadRecord(record)
      // A resumable thread and a live PTY do not prove that this PTY runs that thread.
      // Live ownership is granted only after our sealed resume or fork starts the PTY.
    } catch (error) {
      if (error instanceof CodexAdapterError) {
        throw new AgentMutationError('provider_unavailable', `Codex adapter: ${error.code}`)
      }
      throw error
    } finally {
      adapter?.close()
    }
  }

  private async canResume(session: {
    adapter_id: string
    adapter_version: string
    agent_session_id: string
  }): Promise<boolean> {
    if (!this.providerProfileQualified()) return false
    let privateRecord: PrivateCodexThreadRecord | undefined
    const profile = this.options.isolatedCopy ? this.options.privateProfile : undefined
    if (this.options.isolatedCopy) {
      if (!profile || process.env.CODEX_HOME !== profile.home) return false
      try {
        privateRecord = profile.findThreadRecord(session.agent_session_id)
        if (!privateRecord) return false
      } catch {
        return false
      }
    }
    if (
      session.adapter_id !== 'codex' ||
      !TRUSTED_CODEX_VERSIONS.has(session.adapter_version) ||
      !sealedLaunchAvailable()
    )
      return false
    let adapter: CodexAdapter | undefined
    try {
      adapter = await CodexAdapter.fromExecutable('codex', profile?.home)
      if (adapter.descriptor.version !== session.adapter_version) return false
      if (profile && !(await adapter.privateLoginReady())) return false
      await adapter.prepareResume(session.agent_session_id)
      if (privateRecord) profile?.assertThreadRecord(privateRecord)
      return true
    } catch {
      return false
    } finally {
      adapter?.close()
    }
  }

  private async verifyCheckpoint(session: {
    agent_session_id: string
    adapter_id: string
    adapter_version: string
  }): Promise<CodexCheckpoint | undefined> {
    if (
      !this.providerProfileQualified() ||
      session.adapter_id !== 'codex' ||
      !TRUSTED_CODEX_VERSIONS.has(session.adapter_version)
    )
      return undefined
    const record = this.privateThreadRecord(session.agent_session_id)
    let adapter: CodexAdapter | undefined
    try {
      adapter = await CodexAdapter.fromExecutable('codex', this.options.privateProfile?.home)
      if (adapter.descriptor.version !== session.adapter_version) return undefined
      await this.requirePrivateLogin(adapter)
      await adapter.verifyThread(session.agent_session_id)
      if (record) this.options.privateProfile?.assertThreadRecord(record)
      return codexCheckpoint(session.agent_session_id, Date.now())
    } finally {
      adapter?.close()
    }
  }

  private async resume(session: {
    workspace_id: string
    pane_id: string
    tab_id: string
    adapter_id: string
    adapter_version: string
    agent_session_id: string
  }): Promise<void> {
    this.requireProviderProfile()
    const record = this.privateThreadRecord(session.agent_session_id)
    if (session.adapter_id !== 'codex' || !TRUSTED_CODEX_VERSIONS.has(session.adapter_version)) {
      throw new AgentMutationError('provider_unavailable', 'The trusted adapter is unavailable')
    }
    const workspace = this.state
      .readSnapshot()
      .workspaces.find((item) => item.id === session.workspace_id)
    const tab = workspace?.tabs[session.tab_id]
    if (
      !workspace?.panes[session.pane_id]?.tabs.includes(session.tab_id) ||
      tab?.paneId !== session.pane_id ||
      tab.content.kind !== 'terminal'
    ) {
      throw new AgentMutationError(
        'runtime_unavailable',
        'The exact terminal binding is unavailable'
      )
    }
    const launch = tab.content.launch
    let adapter: CodexAdapter | undefined
    try {
      adapter = await CodexAdapter.fromExecutable('codex', this.options.privateProfile?.home)
      if (adapter.descriptor.version !== session.adapter_version)
        throw new AgentMutationError(
          'provider_unavailable',
          'The recorded Codex version is unavailable'
        )
      await this.requirePrivateLogin(adapter)
      const plan = await adapter.prepareResume(session.agent_session_id)
      if (record) this.options.privateProfile?.assertThreadRecord(record)
      await withSealedExecutable(plan, (command) =>
        this.runtime.replaceAgentTerminal(
          this.state,
          session.workspace_id,
          session.pane_id,
          session.tab_id,
          launch,
          command,
          'resumeDetached'
        )
      )
      const terminalId = this.runtime.sessionForTab(session.tab_id)
      if (!terminalId) {
        throw new AgentMutationError('runtime_unavailable', 'The resumed terminal is unavailable')
      }
      this.verifiedTerminals.set(session.agent_session_id, terminalId)
    } catch (error) {
      if (error instanceof CodexAdapterError) {
        throw new AgentMutationError('provider_unavailable', `Codex adapter: ${error.code}`)
      }
      throw error
    } finally {
      adapter?.close()
    }
  }
}
