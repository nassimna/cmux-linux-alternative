import { randomUUID } from 'node:crypto'

import { durableApplicationStateSchema } from '@agent-workspace/contracts'
import { describe, expect, it } from 'vitest'

import { TerminalService, type PtyProcess } from '../terminal/terminal-service'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { WorkspaceTerminalRuntime } from './workspace-terminal-runtime'
import { duplicateTabExact } from './advanced-tab-duplicate'

class FakePty implements PtyProcess {
  public readonly pid = 123
  public killed = false

  public onData(): { dispose(): void } {
    return { dispose() {} }
  }

  public onExit(): { dispose(): void } {
    return { dispose() {} }
  }

  public write(): void {}
  public resize(): void {}
  public kill(): void {
    this.killed = true
  }
}

function snapshot() {
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const terminalIds = [randomUUID(), randomUUID()]
  const browserId = randomUUID()
  const tabs: Record<string, unknown> = Object.fromEntries(
    terminalIds.map((id) => [
      id,
      {
        id,
        paneId,
        title: 'Terminal',
        customTitle: null,
        content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } },
        createdAt: 1
      }
    ])
  )
  tabs[browserId] = {
    id: browserId,
    paneId,
    title: 'Browser',
    customTitle: null,
    content: { kind: 'browser', metadata: { url: 'https://example.com/' } },
    createdAt: 1
  }
  return {
    state: durableApplicationStateSchema.parse({
      revision: 0,
      workspaces: [
        {
          id: workspaceId,
          name: 'fixture',
          description: null,
          color: null,
          workingDirectory: '/tmp',
          layout: { kind: 'leaf', paneId },
          selectedPaneId: paneId,
          panes: {
            [paneId]: {
              id: paneId,
              tabs: [...terminalIds, browserId],
              selectedTabId: terminalIds[0],
              title: null
            }
          },
          tabs,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      selectedWorkspaceId: workspaceId,
      workspaceSelection: [workspaceId],
      workspacePins: [],
      workspaceGroups: [],
      workspaceGroupAssignments: {},
      savedLayouts: [],
      legacyOverLimit: null,
      shortcutOverrides: {},
      notifications: [],
      notificationSettings: { systemEnabled: true, includeBody: false },
      recentlyClosed: [],
      windowPlacements: [
        {
          id: workspaceId,
          label: 'Main',
          workspaceIds: [workspaceId],
          focusedWorkspaceId: workspaceId,
          hostingState: 'unhosted',
          revision: 0
        }
      ],
      focusedWindowId: workspaceId,
      focusHistory: { entries: [], cursor: 0 }
    }),
    workspaceId,
    paneId,
    terminalIds,
    browserId
  }
}

describe('WorkspaceTerminalRuntime', () => {
  it('duplicates a browser with a fresh runtime identity and preserves its source', () => {
    const fixture = snapshot()
    const state = durableApplicationStateSchema.parse({
      ...fixture.state,
      windowPlacements: fixture.state.windowPlacements.map((placement) => ({
        ...placement,
        hostingState: 'hosted' as const
      }))
    })
    const tabId = randomUUID()
    const browserSessionId = randomUUID()
    const request = {
      mutation: {
        expectedRevision: state.revision,
        idempotencyEpoch: randomUUID(),
        idempotencyKey: randomUUID()
      },
      source: {
        windowId: fixture.workspaceId,
        workspaceId: fixture.workspaceId,
        paneId: fixture.paneId,
        tabId: fixture.browserId,
        expectedWindowRevision: 0
      },
      target: {
        windowId: fixture.workspaceId,
        workspaceId: fixture.workspaceId,
        paneId: fixture.paneId,
        destinationIndex: 1,
        expectedWindowRevision: 0
      }
    }
    const next = duplicateTabExact(state, request, { tabId, browserSessionId }, 2)
    const workspace = next.workspaces[0]!
    expect(workspace.tabs[fixture.browserId]).toEqual(state.workspaces[0]!.tabs[fixture.browserId])
    expect(workspace.tabs[tabId]?.content).toMatchObject({
      kind: 'browser',
      metadata: { browserSessionId, url: 'https://example.com/' }
    })
    expect(next.windowPlacements[0]?.revision).toBe(1)
    expect(next.revision).toBe(state.revision + 1)
    expect(() =>
      duplicateTabExact(next, request, { tabId: randomUUID(), browserSessionId: randomUUID() }, 3)
    ).toThrow('Window placement changed')
  })
  it('restores only terminal tabs with their durable ownership context', async () => {
    const fixture = snapshot()
    const processes: FakePty[] = []
    const environments: NodeJS.ProcessEnv[] = []
    const service = new TerminalService({
      spawn: (_command, _args, options) => {
        environments.push(options.env)
        const pty = new FakePty()
        processes.push(pty)
        return Promise.resolve(pty)
      }
    })
    const runtime = new WorkspaceTerminalRuntime(service)
    await runtime.restore(fixture.state)
    expect(processes).toHaveLength(2)
    expect(runtime.sessionForTab(fixture.browserId)).toBeUndefined()
    for (const tabId of fixture.terminalIds) {
      const sessionId = runtime.sessionForTab(tabId)
      expect(sessionId).toBeDefined()
      expect(service.attach(sessionId!).terminal.cwd).toBe('/tmp')
      expect(environments).toContainEqual(
        expect.objectContaining({
          AGENT_WORKSPACE_WORKSPACE_ID: fixture.workspaceId,
          AGENT_WORKSPACE_PANE_ID: fixture.paneId,
          AGENT_WORKSPACE_TAB_ID: tabId
        })
      )
    }
    await expect(runtime.restore(fixture.state)).rejects.toThrow('already starting')
    service.dispose()
    expect(processes.every((pty) => pty.killed)).toBe(true)
  })

  it('terminates earlier PTYs if a later restore launch fails', async () => {
    const fixture = snapshot()
    const first = new FakePty()
    let attempts = 0
    const service = new TerminalService({
      spawn: () => {
        attempts += 1
        return attempts === 1 ? Promise.resolve(first) : Promise.reject(new Error('spawn failed'))
      }
    })
    const runtime = new WorkspaceTerminalRuntime(service)
    await expect(runtime.restore(fixture.state)).rejects.toThrow('spawn failed')
    expect(first.killed).toBe(true)
    expect(fixture.terminalIds.every((id) => runtime.sessionForTab(id) === undefined)).toBe(true)
    service.dispose()
  })

  it('rebinds a detached agent terminal and rolls back a staged PTY if the tab changes', async () => {
    const fixture = snapshot()
    let current = fixture.state
    let changeOnNextSpawn = false
    const processes: FakePty[] = []
    const service = new TerminalService({
      spawn: () => {
        const pty = new FakePty()
        processes.push(pty)
        if (changeOnNextSpawn) {
          current = {
            ...current,
            workspaces: current.workspaces.map((workspace) =>
              workspace.id === fixture.workspaceId
                ? {
                    ...workspace,
                    tabs: {
                      ...workspace.tabs,
                      [fixture.terminalIds[0]!]: {
                        ...workspace.tabs[fixture.terminalIds[0]!]!,
                        paneId: randomUUID()
                      }
                    }
                  }
                : workspace
            )
          }
        }
        return Promise.resolve(pty)
      }
    })
    const runtime = new WorkspaceTerminalRuntime(service)
    const store = { readSnapshot: () => current } as ApplicationStateStore
    const tabId = fixture.terminalIds[0]!
    const launch = fixture.state.workspaces[0]!.tabs[tabId]!.content
    if (launch.kind !== 'terminal') throw new Error('Expected terminal fixture')
    const resume = () =>
      runtime.replaceAgentTerminal(
        store,
        fixture.workspaceId,
        fixture.paneId,
        tabId,
        launch.launch,
        ['codex', 'resume'],
        'resumeDetached'
      )
    try {
      await runtime.restore(fixture.state)
      const detachedId = runtime.sessionForTab(tabId)!
      service.close(detachedId)
      expect(runtime.sessionForTab(tabId)).toBeUndefined()
      await expect(
        runtime.replaceAgentTerminal(
          store,
          fixture.workspaceId,
          fixture.paneId,
          tabId,
          launch.launch,
          ['codex', 'resume']
        )
      ).rejects.toThrow('Terminal runtime is not attached')
      await resume()
      const resumedId = runtime.sessionForTab(tabId)
      expect(resumedId).toBeDefined()
      expect(resumedId).not.toBe(detachedId)
      expect(runtime.sessionForTab(fixture.terminalIds[1]!)).toBeDefined()

      await resume()
      const replacedId = runtime.sessionForTab(tabId)
      expect(replacedId).toBeDefined()
      expect(replacedId).not.toBe(resumedId)
      expect(() => service.attach(resumedId!)).toThrow('Terminal does not exist')

      service.close(replacedId!)
      expect(runtime.sessionForTab(tabId)).toBeUndefined()
      const originalSpawn = processes.length
      changeOnNextSpawn = true
      await expect(resume()).rejects.toThrow('Exact terminal binding changed')
      expect(processes[originalSpawn]?.killed).toBe(true)
      expect(runtime.sessionForTab(tabId)).toBeUndefined()
    } finally {
      service.dispose()
    }
  })
})
