import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { TabDuplicateParams, WindowCloseParams } from '@agent-workspace/protocol-client'

import {
  durableApplicationStateSchema,
  type DurableApplicationState,
  type WorkspaceCreateRequest,
  type WorkspaceCreateResult,
  type WorkspaceCloseRequest,
  type WorkspaceCloseResult,
  type WorkspaceBatchCloseRequest,
  type TerminalRestartRequest,
  type TerminalRestartResult,
  type TabCloseRequest,
  type TabCloseResult,
  type TabOpenTerminalRequest,
  type TabOpenTerminalResult,
  type PaneSplitRequest,
  type PaneSplitResult,
  type PaneCloseRequest,
  type PaneCloseResult,
  type LayoutApplyRequest
} from '@agent-workspace/contracts'

import {
  closePane,
  closeTab,
  closeWorkspace,
  closeSelectedWorkspaces,
  WorkspaceMutationError
} from './workspace-mutations'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { serviceLogger } from '../logging/service-logger'
import type { TerminalReopenAdapter } from '../persistence/recently-closed-service'
import { RecentlyClosedError } from './recently-closed-mutations'
import { TerminalServiceError, type TerminalService } from '../terminal/terminal-service'

/** Owns the ephemeral terminal identities rebuilt from durable tab launch specs. */
export class WorkspaceTerminalRuntime {
  private readonly sessions = new Map<string, string>()
  private started = false
  private starting = false

  public constructor(
    private readonly terminals: TerminalService,
    private readonly now: () => number = Date.now
  ) {}

  public uses(terminals: TerminalService): boolean {
    return this.terminals === terminals
  }

  public isReady(): boolean {
    return this.started
  }

  public async restore(snapshot: DurableApplicationState): Promise<void> {
    if (this.started || this.starting) throw new Error('Workspace terminals are already starting')
    this.starting = true
    const created: string[] = []
    try {
      const state = durableApplicationStateSchema.parse(snapshot)
      for (const workspace of state.workspaces) {
        for (const tab of Object.values(workspace.tabs).sort((a, b) => a.id.localeCompare(b.id))) {
          if (tab.content.kind !== 'terminal') continue
          const { terminal } = await this.terminals.create(tab.content.launch, {
            workspaceId: workspace.id,
            paneId: tab.paneId,
            tabId: tab.id
          })
          created.push(terminal.id)
          this.sessions.set(tab.id, terminal.id)
        }
      }
      this.started = true
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const id of created.reverse()) {
        try {
          this.terminals.close(id)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      this.sessions.clear()
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Terminal restore and rollback failed',
          {
            cause: error
          }
        )
      }
      throw error
    } finally {
      this.starting = false
    }
  }

  public sessionForTab(tabId: string): string | undefined {
    const id = this.sessions.get(tabId)
    if (!id) return undefined
    try {
      this.terminals.attach(id)
      return id
    } catch {
      this.sessions.delete(tabId)
      return undefined
    }
  }

  /** Caller holds the store mutation lock; a final source tab gets a live replacement PTY. */
  public async detachTabExact(
    store: ApplicationStateStore,
    request: Parameters<ApplicationStateStore['preflightTabDetach']>[0]
  ) {
    if (!this.started) throw new Error('Workspace terminals have not been restored')
    const ids = {
      windowId: randomUUID(),
      workspaceId: randomUUID(),
      paneId: randomUUID(),
      replacementTabId: randomUUID()
    }
    const createdAt = this.now()
    const plan = store.preflightTabDetach(request, ids, createdAt)
    if (plan.replay) return plan.replay
    let replacementSessionId: string | undefined
    if (plan.replacement) {
      const source = store
        .readSnapshot()
        .workspaces.find((workspace) => workspace.id === request.source.workspaceId)!
      const { terminal } = await this.terminals.create(
        { cwd: source.workingDirectory, rows: 24, cols: 80 },
        {
          workspaceId: source.id,
          paneId: request.source.paneId,
          tabId: ids.replacementTabId
        }
      )
      replacementSessionId = terminal.id
    }
    let result
    try {
      result = store.commitTabDetach(request, ids, createdAt)
    } catch (error) {
      if (replacementSessionId) this.terminals.close(replacementSessionId)
      throw error
    }
    if (result.replayed) {
      if (replacementSessionId) this.terminals.close(replacementSessionId)
      return result
    }
    if (replacementSessionId) this.sessions.set(ids.replacementTabId, replacementSessionId)
    return result
  }

  /** Caller holds the application mutation lock; a detached resume may have no PTY. */
  public async replaceAgentTerminal(
    store: ApplicationStateStore,
    workspaceId: string,
    paneId: string,
    tabId: string,
    launch: Extract<
      DurableApplicationState['workspaces'][number]['tabs'][string]['content'],
      { kind: 'terminal' }
    >['launch'],
    command: readonly string[],
    mode: 'replace' | 'resumeDetached' = 'replace'
  ): Promise<void> {
    if (!this.started) throw new Error('Workspace terminals have not been restored')
    const assertBinding = () => {
      const workspace = store.readSnapshot().workspaces.find((item) => item.id === workspaceId)
      const tab = workspace?.tabs[tabId]
      if (
        !workspace?.panes[paneId]?.tabs.includes(tabId) ||
        tab?.paneId !== paneId ||
        tab.content.kind !== 'terminal' ||
        !isDeepStrictEqual(tab.content.launch, launch)
      ) {
        throw new WorkspaceMutationError('runtime_not_bound', 'Exact terminal binding changed')
      }
    }
    assertBinding()
    const previous = this.sessions.get(tabId)
    if (!previous && mode === 'replace')
      throw new WorkspaceMutationError('runtime_not_bound', 'Terminal runtime is not attached')
    if (
      previous &&
      [...this.sessions].some(
        ([otherTabId, sessionId]) => otherTabId !== tabId && sessionId === previous
      )
    ) {
      throw new WorkspaceMutationError('runtime_not_bound', 'Terminal runtime has duplicate owners')
    }
    const { terminal } = await this.terminals.create(
      { ...launch, command: [...command] },
      { workspaceId, paneId, tabId }
    )
    try {
      assertBinding()
      if (
        this.sessions.get(tabId) !== previous ||
        [...this.sessions.values()].includes(terminal.id)
      ) {
        throw new WorkspaceMutationError('runtime_not_bound', 'Terminal runtime owner changed')
      }
      this.sessions.set(tabId, terminal.id)
    } catch (error) {
      try {
        this.terminals.close(terminal.id)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Agent terminal rollback failed', {
          cause: error
        })
      }
      throw error
    }
    if (previous) {
      try {
        this.terminals.close(previous)
      } catch {
        serviceLogger.emit('warn', 'terminalRetireFailed')
      }
    }
  }

  /** Exact runtime ID and durable snapshot revision are fenced before PTY disposition. */
  public detachAgentTerminal(
    store: ApplicationStateStore,
    binding: {
      agentSessionId: string
      sessionRevision: number
      attemptEpoch: number
      workspaceId: string
      paneId: string
      tabId: string
    },
    expectedTerminalId: string
  ): Promise<{
    revision: number
    terminationFailures: { terminalId: string; code: string }[]
  }> {
    return store.exclusive(async () => {
      if (!this.started || this.sessions.get(binding.tabId) !== expectedTerminalId)
        throw new WorkspaceMutationError('runtime_not_bound', 'Exact terminal runtime changed')
      const terminal = this.terminals.attach(expectedTerminalId).terminal
      if (terminal.exited)
        throw new WorkspaceMutationError('runtime_not_bound', 'Exact terminal already exited')
      const revision = store.commitAgentTerminalDetach(binding)
      this.sessions.delete(binding.tabId)
      try {
        await this.terminals.terminateObserved(expectedTerminalId)
        return { revision, terminationFailures: [] }
      } catch (error) {
        return {
          revision,
          terminationFailures: [
            {
              terminalId: expectedTerminalId,
              code: error instanceof TerminalServiceError ? error.code : 'termination_unverified'
            }
          ]
        }
      }
    })
  }

  public ownsTerminal(id: string): boolean {
    return [...this.sessions.values()].includes(id)
  }

  /** Supplies the runtime-first terminal half of a recently closed tab reopen. */
  public recentlyClosedAdapter(): TerminalReopenAdapter {
    return {
      prepare: async ({ workspaceId, paneId, tabId, launch }) => {
        if (!this.started) throw new Error('Workspace terminals have not been restored')
        if (this.sessions.has(tabId)) throw new Error('Terminal tab already has a live session')
        const { terminal } = await this.terminals.create(launch, { workspaceId, paneId, tabId })
        let adopted = false
        let closed = false
        return {
          terminalId: terminal.id,
          adopt: () => {
            if (closed || adopted || this.sessions.has(tabId)) {
              throw new Error('Terminal reopen ownership changed')
            }
            this.sessions.set(tabId, terminal.id)
            adopted = true
          },
          close: () => {
            if (closed) return
            closed = true
            if (adopted && this.sessions.get(tabId) === terminal.id) this.sessions.delete(tabId)
            this.terminals.close(terminal.id)
          }
        }
      }
    }
  }

  /** Starts replacement PTYs before the durable layout swap, then retires removed sessions. */
  public applyLayout(
    store: ApplicationStateStore,
    request: LayoutApplyRequest
  ): Promise<{ revision: number; replayed: boolean }> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const plan = store.preflightLayoutApply(request)
      if (plan.replay) return plan.replay

      const beforeTabs = new Map(
        plan.before.workspaces.flatMap((workspace) => Object.entries(workspace.tabs))
      )
      const layout = plan.before.savedLayouts.find((item) => item.id === request.layoutId)!
      const templateTabs = new Map(
        layout.template.workspaces.flatMap((workspace) => Object.entries(workspace.tabs))
      )
      const preserved = new Map<string, string>()
      const created = new Map<string, string>()
      const rollback = (failure: unknown): never => {
        const failures: unknown[] = [failure]
        for (const sessionId of [...created.values()].reverse()) {
          try {
            this.terminals.close(sessionId)
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Layout apply rollback failed', { cause: failure })
        }
        throw failure
      }

      let result: { revision: number; replayed: boolean }
      try {
        for (const workspace of plan.candidate.workspaces) {
          for (const tab of Object.values(workspace.tabs).sort((a, b) =>
            a.id.localeCompare(b.id)
          )) {
            if (tab.content.kind !== 'terminal') continue
            const previous = beforeTabs.get(tab.id)
            const template = templateTabs.get(tab.id)
            const oldSessionId = this.sessionForTab(tab.id)
            if (
              previous?.content.kind === 'terminal' &&
              template?.content.kind === 'terminal' &&
              isDeepStrictEqual(previous.content.launch, template.content.launch) &&
              oldSessionId
            ) {
              preserved.set(tab.id, oldSessionId)
              continue
            }
            const { terminal } = await this.terminals.create(tab.content.launch, {
              workspaceId: workspace.id,
              paneId: tab.paneId,
              tabId: tab.id
            })
            created.set(tab.id, terminal.id)
          }
        }
        result = store.commitLayoutApply(request, plan.candidate)
      } catch (error) {
        return rollback(error)
      }

      if (result.replayed) {
        const failures: unknown[] = []
        for (const sessionId of created.values()) {
          try {
            this.terminals.close(sessionId)
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Layout replay cleanup failed')
        return result
      }

      const previousSessions = new Map(this.sessions)
      this.sessions.clear()
      for (const [tabId, sessionId] of preserved) this.sessions.set(tabId, sessionId)
      for (const [tabId, sessionId] of created) this.sessions.set(tabId, sessionId)
      const retainedSessionIds = new Set(this.sessions.values())
      for (const sessionId of previousSessions.values()) {
        if (retainedSessionIds.has(sessionId)) continue
        try {
          this.terminals.close(sessionId)
        } catch {
          serviceLogger.emit('warn', 'layoutTerminalCleanupFailed')
        }
      }
      return result
    })
  }

  /** Preflight, spawn, and commit are serialized; a failed commit tears down its new PTY. */
  public createWorkspace(
    store: ApplicationStateStore,
    request: WorkspaceCreateRequest
  ): Promise<WorkspaceCreateResult> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const ids = { workspaceId: randomUUID(), paneId: randomUUID(), tabId: randomUUID() }
      const createdAt = this.now()
      const replay = store.preflightWorkspaceCreate(request, ids, createdAt)
      if (replay) return { ...replay, terminalId: this.sessionForTab(replay.tabId) ?? null }

      const launch = request.initialTerminal
      const { terminal } = await this.terminals.create(
        {
          cwd: launch.cwd,
          rows: launch.rows,
          cols: launch.cols,
          ...(launch.command === undefined ? {} : { command: launch.command })
        },
        { workspaceId: ids.workspaceId, paneId: ids.paneId, tabId: ids.tabId }
      )
      let result
      try {
        result = store.commitWorkspaceCreate(request, ids, createdAt)
      } catch (error) {
        try {
          this.terminals.close(terminal.id)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Workspace create rollback failed', {
            cause: rollbackError
          })
        }
        throw error
      }
      if (result.replayed) {
        this.terminals.close(terminal.id)
        return { ...result, terminalId: this.sessionForTab(result.tabId) ?? null }
      }
      this.sessions.set(ids.tabId, terminal.id)
      return { ...result, terminalId: terminal.id }
    })
  }

  /** Launches a PTY before committing its new tab; failed commits stop that PTY. */
  public openTerminalTab(
    store: ApplicationStateStore,
    request: TabOpenTerminalRequest
  ): Promise<TabOpenTerminalResult> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const tabId = randomUUID()
      const createdAt = this.now()
      const replay = store.preflightTabOpenTerminal(request, tabId, createdAt)
      if (replay) return { ...replay, terminalId: this.sessionForTab(replay.tabId) ?? null }

      const { terminal } = await this.terminals.create(
        {
          cwd: request.launch.cwd,
          rows: request.launch.rows,
          cols: request.launch.cols,
          ...(request.launch.command === undefined ? {} : { command: request.launch.command })
        },
        { workspaceId: request.workspaceId, paneId: request.paneId, tabId }
      )
      let result
      try {
        result = store.commitTabOpenTerminal(request, tabId, createdAt)
      } catch (error) {
        try {
          this.terminals.close(terminal.id)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Terminal tab open rollback failed', {
            cause: rollbackError
          })
        }
        throw error
      }
      if (result.replayed) {
        this.terminals.close(terminal.id)
        return { ...result, terminalId: this.sessionForTab(result.tabId) ?? null }
      }
      this.sessions.set(tabId, terminal.id)
      return { ...result, terminalId: terminal.id }
    })
  }

  /** A duplicate gets a separate PTY; the source terminal is never reused. */
  public duplicateTabExact(
    store: ApplicationStateStore,
    request: TabDuplicateParams,
    binding: { isCurrent(): boolean }
  ) {
    return store.exclusive(async () => {
      if (!binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const ids = { tabId: randomUUID(), browserSessionId: randomUUID() }
      const createdAt = this.now()
      const replay = store.preflightTabDuplicate(request, ids, createdAt)
      if (replay) return replay
      const snapshot = store.readSnapshot()
      const source = snapshot.workspaces.find((item) => item.id === request.source.workspaceId)!
        .tabs[request.source.tabId]!
      if (source.content.kind === 'browser') {
        if (!binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
        return store.commitTabDuplicate(request, ids, createdAt)
      }
      const { terminal } = await this.terminals.create(source.content.launch, {
        workspaceId: request.target.workspaceId,
        paneId: request.target.paneId,
        tabId: ids.tabId
      })
      try {
        if (!binding.isCurrent()) throw new RecentlyClosedError('unauthorized')
        const result = store.commitTabDuplicate(request, ids, createdAt, terminal.id)
        if (result.replayed) {
          this.terminals.close(terminal.id)
          return { ...result, runtimeSessionId: this.sessionForTab(result.tabId) }
        }
        this.sessions.set(ids.tabId, terminal.id)
        return result
      } catch (error) {
        this.terminals.close(terminal.id)
        throw error
      }
    })
  }

  /** Creates the split PTY before commit and closes it if the durable mutation fails. */
  public splitPane(
    store: ApplicationStateStore,
    request: PaneSplitRequest
  ): Promise<PaneSplitResult> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const ids = {
        paneId: randomUUID(),
        splitId: randomUUID(),
        tabId: randomUUID(),
        browserSessionId: randomUUID()
      }
      const createdAt = this.now()
      const replay = store.preflightPaneSplit(request, ids, createdAt)
      if (replay) return { ...replay, terminalId: this.sessionForTab(replay.tabId) ?? null }

      let terminalId: string | null = null
      if (request.content.kind === 'newTerminal') {
        const launch = request.content.launch
        const { terminal } = await this.terminals.create(
          {
            cwd: launch.cwd,
            rows: launch.rows,
            cols: launch.cols,
            ...(launch.command === undefined ? {} : { command: launch.command })
          },
          { workspaceId: request.workspaceId, paneId: ids.paneId, tabId: ids.tabId }
        )
        terminalId = terminal.id
      }
      let result
      try {
        result = store.commitPaneSplit(request, ids, createdAt)
      } catch (error) {
        if (terminalId) {
          try {
            this.terminals.close(terminalId)
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Pane split rollback failed', {
              cause: rollbackError
            })
          }
        }
        throw error
      }
      if (result.replayed) {
        if (terminalId) this.terminals.close(terminalId)
        return { ...result, terminalId: this.sessionForTab(result.tabId) ?? null }
      }
      if (terminalId) this.sessions.set(result.tabId, terminalId)
      return { ...result, terminalId: terminalId ?? this.sessionForTab(result.tabId) ?? null }
    })
  }

  /** Replaces the final pane before commit, then retires sessions removed by the pane close. */
  public closePane(
    store: ApplicationStateStore,
    request: PaneCloseRequest
  ): Promise<PaneCloseResult> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const replacementTabId = randomUUID()
      const updatedAt = this.now()
      const replay = store.preflightPaneClose(request, replacementTabId, updatedAt)
      if (replay) {
        return {
          ...replay,
          replacementTerminalId: replay.replacementTabId
            ? (this.sessionForTab(replay.replacementTabId) ?? null)
            : null
        }
      }

      const before = store.readSnapshot()
      const workspace = before.workspaces.find((item) => item.id === request.workspaceId)!
      const closingTabIds = [...workspace.panes[request.paneId]!.tabs]
      let replacementSessionId: string | undefined
      if (Object.keys(workspace.panes).length === 1) {
        const candidate = closePane(
          before,
          request.workspaceId,
          request.paneId,
          replacementTabId,
          updatedAt
        )
        const tab = candidate.workspaces.find((item) => item.id === request.workspaceId)!.tabs[
          replacementTabId
        ]!
        if (tab.content.kind !== 'terminal') throw new Error('Replacement must be a terminal')
        const { terminal } = await this.terminals.create(tab.content.launch, {
          workspaceId: request.workspaceId,
          paneId: request.paneId,
          tabId: replacementTabId
        })
        replacementSessionId = terminal.id
      }

      let result
      try {
        result = store.commitPaneClose(request, replacementTabId, updatedAt)
      } catch (error) {
        if (replacementSessionId) {
          try {
            this.terminals.close(replacementSessionId)
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Pane close rollback failed', {
              cause: rollbackError
            })
          }
        }
        throw error
      }
      if (result.replayed) {
        if (replacementSessionId) this.terminals.close(replacementSessionId)
        return {
          ...result,
          replacementTerminalId: result.replacementTabId
            ? (this.sessionForTab(result.replacementTabId) ?? null)
            : null
        }
      }
      if (replacementSessionId) this.sessions.set(replacementTabId, replacementSessionId)
      for (const tabId of closingTabIds) {
        const sessionId = this.sessions.get(tabId)
        this.sessions.delete(tabId)
        if (!sessionId) continue
        try {
          this.terminals.close(sessionId)
        } catch {
          serviceLogger.emit('warn', 'paneTerminalCleanupFailed')
        }
      }
      return { ...result, replacementTerminalId: replacementSessionId ?? null }
    })
  }

  /** Commits removal before stopping old PTYs; the final workspace gets a live replacement. */
  public closeWorkspace(
    store: ApplicationStateStore,
    request: WorkspaceCloseRequest
  ): Promise<WorkspaceCloseResult> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const replacementIds = {
        workspaceId: randomUUID(),
        paneId: randomUUID(),
        tabId: randomUUID()
      }
      const createdAt = this.now()
      const replay = store.preflightWorkspaceClose(request, replacementIds, createdAt)
      if (replay) {
        return {
          ...replay,
          replacementTerminalId: replay.replacementTabId
            ? (this.sessionForTab(replay.replacementTabId) ?? null)
            : null
        }
      }

      const before = store.readSnapshot()
      const closing = before.workspaces.find((item) => item.id === request.workspaceId)!
      let replacementSessionId: string | undefined
      if (before.workspaces.length === 1) {
        const candidate = closeWorkspace(before, request.workspaceId, replacementIds, createdAt)
        const replacement = candidate.workspaces[0]!
        const tab = replacement.tabs[replacementIds.tabId]!
        if (tab.content.kind !== 'terminal') throw new Error('Replacement must contain a terminal')
        const { terminal } = await this.terminals.create(tab.content.launch, {
          workspaceId: replacementIds.workspaceId,
          paneId: replacementIds.paneId,
          tabId: replacementIds.tabId
        })
        replacementSessionId = terminal.id
      }

      let result
      try {
        result = store.commitWorkspaceClose(request, replacementIds, createdAt)
      } catch (error) {
        if (replacementSessionId) {
          try {
            this.terminals.close(replacementSessionId)
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Workspace close rollback failed', {
              cause: rollbackError
            })
          }
        }
        throw error
      }
      if (result.replayed) {
        if (replacementSessionId) this.terminals.close(replacementSessionId)
        return {
          ...result,
          replacementTerminalId: result.replacementTabId
            ? (this.sessionForTab(result.replacementTabId) ?? null)
            : null
        }
      }
      if (replacementSessionId) this.sessions.set(replacementIds.tabId, replacementSessionId)
      for (const tab of Object.values(closing.tabs)) {
        if (tab.content.kind !== 'terminal') continue
        const sessionId = this.sessions.get(tab.id)
        this.sessions.delete(tab.id)
        if (!sessionId) continue
        try {
          this.terminals.close(sessionId)
        } catch {
          serviceLogger.emit('warn', 'workspaceTerminalCleanupFailed')
        }
      }
      return { ...result, replacementTerminalId: replacementSessionId ?? null }
    })
  }

  public closeWindowWorkspaces(store: ApplicationStateStore, request: WindowCloseParams) {
    return store.exclusive(() => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const before = store.readSnapshot()
      const placement = before.windowPlacements.find((item) => item.id === request.window.windowId)
      const closing = new Set(placement?.workspaceIds ?? [])
      const tabs = before.workspaces
        .filter((workspace) => closing.has(workspace.id))
        .flatMap((workspace) => Object.values(workspace.tabs))
      const result = store.closeWindowWorkspaces(
        request,
        tabs.map(() => randomUUID()),
        this.now()
      )
      if (!result.replayed)
        for (const tab of tabs) {
          if (tab.content.kind !== 'terminal') continue
          const sessionId = this.sessions.get(tab.id)
          this.sessions.delete(tab.id)
          if (!sessionId) continue
          try {
            this.terminals.close(sessionId)
          } catch {
            serviceLogger.emit('warn', 'workspaceTerminalCleanupFailed')
          }
        }
      return result
    })
  }

  /** Closes the authoritative selection after preparing any required replacement PTY. */
  public closeSelectedWorkspaces(
    store: ApplicationStateStore,
    request: WorkspaceBatchCloseRequest
  ): Promise<WorkspaceCloseResult> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const ids = { workspaceId: randomUUID(), paneId: randomUUID(), tabId: randomUUID() }
      const createdAt = this.now()
      const replay = store.preflightWorkspaceBatchClose(request, ids, createdAt)
      if (replay) {
        return {
          ...replay,
          replacementTerminalId: replay.replacementTabId
            ? (this.sessionForTab(replay.replacementTabId) ?? null)
            : null
        }
      }

      const before = store.readSnapshot()
      const closing = new Set(before.workspaceSelection)
      let replacementSessionId: string | undefined
      if (request.replacement) {
        const candidate = closeSelectedWorkspaces(before, {
          params: request.replacement,
          ids,
          createdAt
        })
        const tab = candidate.workspaces[0]!.tabs[ids.tabId]!
        if (tab.content.kind !== 'terminal') throw new Error('Replacement must contain a terminal')
        const command = request.replacement.initialTerminal.command
        const { terminal } = await this.terminals.create(
          { ...tab.content.launch, ...(command === undefined ? {} : { command }) },
          { workspaceId: ids.workspaceId, paneId: ids.paneId, tabId: ids.tabId }
        )
        replacementSessionId = terminal.id
      }

      let result
      try {
        result = store.commitWorkspaceBatchClose(request, ids, createdAt)
      } catch (error) {
        if (replacementSessionId) {
          try {
            this.terminals.close(replacementSessionId)
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Batch close rollback failed', {
              cause: rollbackError
            })
          }
        }
        throw error
      }
      if (result.replayed) {
        if (replacementSessionId) this.terminals.close(replacementSessionId)
        return {
          ...result,
          replacementTerminalId: result.replacementTabId
            ? (this.sessionForTab(result.replacementTabId) ?? null)
            : null
        }
      }
      if (replacementSessionId) this.sessions.set(ids.tabId, replacementSessionId)
      for (const workspace of before.workspaces) {
        if (!closing.has(workspace.id)) continue
        for (const tab of Object.values(workspace.tabs)) {
          const sessionId = this.sessions.get(tab.id)
          this.sessions.delete(tab.id)
          if (!sessionId) continue
          try {
            this.terminals.close(sessionId)
          } catch {
            serviceLogger.emit('warn', 'batchTerminalCleanupFailed')
          }
        }
      }
      return { ...result, replacementTerminalId: replacementSessionId ?? null }
    })
  }

  /** Records closure before retiring its PTY; the final tab gets a live replacement. */
  public closeTab(store: ApplicationStateStore, request: TabCloseRequest): Promise<TabCloseResult> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const closedItemId = randomUUID()
      const replacementTabId = randomUUID()
      const now = this.now()
      const replay = store.preflightTabClose(request, closedItemId, replacementTabId, now)
      if (replay) {
        return {
          ...replay,
          replacementTerminalId: replay.replacementTabId
            ? (this.sessionForTab(replay.replacementTabId) ?? null)
            : null
        }
      }

      const before = store.readSnapshot()
      const closing = before.workspaces.find((item) => item.id === request.workspaceId)!
      const closingTab = closing.tabs[request.tabId]!
      let replacementSessionId: string | undefined
      if (Object.keys(closing.tabs).length === 1) {
        const candidate = closeTab(
          before,
          request.workspaceId,
          request.tabId,
          closedItemId,
          replacementTabId,
          now
        )
        const replacement = candidate.workspaces.find((item) => item.id === request.workspaceId)!
        const tab = replacement.tabs[replacementTabId]!
        if (tab.content.kind !== 'terminal') throw new Error('Replacement must be a terminal')
        const { terminal } = await this.terminals.create(tab.content.launch, {
          workspaceId: request.workspaceId,
          paneId: tab.paneId,
          tabId: tab.id
        })
        replacementSessionId = terminal.id
      }

      let result
      try {
        result = store.commitTabClose(request, closedItemId, replacementTabId, now)
      } catch (error) {
        if (replacementSessionId) {
          try {
            this.terminals.close(replacementSessionId)
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Tab close rollback failed', {
              cause: rollbackError
            })
          }
        }
        throw error
      }
      if (result.replayed) {
        if (replacementSessionId) this.terminals.close(replacementSessionId)
        return {
          ...result,
          replacementTerminalId: result.replacementTabId
            ? (this.sessionForTab(result.replacementTabId) ?? null)
            : null
        }
      }
      if (replacementSessionId) this.sessions.set(replacementTabId, replacementSessionId)
      if (closingTab.content.kind === 'terminal') {
        const oldSessionId = this.sessions.get(request.tabId)
        this.sessions.delete(request.tabId)
        if (oldSessionId) {
          try {
            this.terminals.close(oldSessionId)
          } catch {
            serviceLogger.emit('warn', 'tabTerminalCleanupFailed')
          }
        }
      }
      return { ...result, replacementTerminalId: replacementSessionId ?? null }
    })
  }

  /** Starts a replacement PTY, commits a new revision, then stops the old session. */
  public restartTerminal(
    store: ApplicationStateStore,
    request: TerminalRestartRequest
  ): Promise<TerminalRestartResult> {
    return store.exclusive(async () => {
      if (!this.started) throw new Error('Workspace terminals have not been restored')
      const updatedAt = this.now()
      const replay = store.preflightTerminalRestart(request, updatedAt)
      if (replay) return { ...replay, terminalId: this.sessionForTab(request.tabId) ?? null }
      const oldSessionId = this.sessionForTab(request.tabId)
      if (!oldSessionId) {
        throw new WorkspaceMutationError('runtime_not_bound', 'Terminal runtime is not attached')
      }
      const workspace = store
        .readSnapshot()
        .workspaces.find((item) => item.id === request.workspaceId)!
      const tab = workspace.tabs[request.tabId]!
      if (tab.content.kind !== 'terminal') throw new Error('Validated tab is not a terminal')
      const { terminal } = await this.terminals.create(tab.content.launch, {
        workspaceId: request.workspaceId,
        paneId: tab.paneId,
        tabId: tab.id
      })
      let result
      try {
        result = store.commitTerminalRestart(request, updatedAt)
      } catch (error) {
        try {
          this.terminals.close(terminal.id)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Terminal restart rollback failed', {
            cause: rollbackError
          })
        }
        throw error
      }
      if (result.replayed) {
        this.terminals.close(terminal.id)
        return { ...result, terminalId: this.sessionForTab(request.tabId) ?? null }
      }
      this.sessions.set(request.tabId, terminal.id)
      try {
        this.terminals.close(oldSessionId)
      } catch {
        serviceLogger.emit('warn', 'restartTerminalCleanupFailed')
      }
      return { ...result, terminalId: terminal.id }
    })
  }
}
