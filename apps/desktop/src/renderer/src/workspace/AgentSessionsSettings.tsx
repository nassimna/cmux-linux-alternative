import { useEffect, useState, type FormEvent } from 'react'

import type {
  AgentAttentionSetResult,
  AgentAttentionState,
  AgentCatalogListResult,
  AgentSessionBinding,
  AgentSessionSnapshot,
  AgentTeamMemberSnapshot,
  MutationResult
} from '@agent-workspace/protocol-client'

import { messages } from '../messages'
import { Button } from '../ui/button'
import { AgentSessionCard } from './AgentSessionCard'
import { AgentTeamCard } from './AgentTeamCard'

export interface AgentWorkspaceContext {
  workspaceId: string
  paneId: string
  tabId: string
  workingDirectory: string
}

const EMPTY_CATALOG: AgentCatalogListResult = {
  catalogVersion: 1,
  revision: 0,
  sessions: [],
  teams: [],
  attention: []
}

export function AgentSessionsSettings({
  context,
  onNavigate,
  onWorkspaceMutation,
  open
}: {
  context: AgentWorkspaceContext | null
  onNavigate: (binding: AgentSessionBinding) => Promise<void>
  onWorkspaceMutation: (operation: Promise<MutationResult>) => Promise<boolean>
  open: boolean
}): React.JSX.Element {
  const [catalog, setCatalog] = useState(EMPTY_CATALOG)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')

  const refresh = async (): Promise<void> => {
    const result = await window.desktopBridge.listAgentSessions!()
    setCatalog(result)
  }

  useEffect(() => {
    if (!open) return
    let active = true
    void window.desktopBridge.listAgentSessions!()
      .then((result) => {
        if (active) setCatalog(result)
      })
      .catch(() => {
        if (active) setStatus(messages.agentSessions.loadFailed)
      })
    return () => {
      active = false
    }
  }, [open])

  const run = async (key: string, operation: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(key)
    setStatus('')
    try {
      await operation()
      await refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : messages.agentSessions.operationFailed)
    } finally {
      setBusy(null)
    }
  }

  const register = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!context) return
    const form = new FormData(event.currentTarget)
    void run('register', async () => {
      await window.desktopBridge.registerAgentSession!({
        agentSessionId: formText(form.get('agentSessionId')).trim(),
        title: formText(form.get('title')).trim(),
        workspaceId: context.workspaceId,
        paneId: context.paneId,
        tabId: context.tabId
      })
    })
  }

  const createTeam = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void run('team-create', async () => {
      await window.desktopBridge.createAgentTeam!({ title: formText(form.get('title')).trim() })
    })
  }

  const destinationForFork = async (
    destinationKind: 'existingTerminal' | 'newTerminal'
  ): Promise<AgentWorkspaceContext> => {
    if (!context) throw new Error(messages.agentSessions.noTerminal)
    if (destinationKind === 'existingTerminal') return context
    const result = await window.desktopBridge.openTerminalTab({
      workspaceId: context.workspaceId,
      paneId: context.paneId,
      launch: { cwd: context.workingDirectory, rows: 24, cols: 80 }
    })
    await onWorkspaceMutation(Promise.resolve(result))
    const workspace = result.snapshot.workspaces.find(({ id }) => id === context.workspaceId)
    const pane = workspace?.panes.find(({ id }) => id === context.paneId)
    if (!workspace || !pane) throw new Error(messages.agentSessions.noTerminal)
    return {
      workspaceId: workspace.id,
      paneId: pane.id,
      tabId: pane.selectedTabId,
      workingDirectory: workspace.workingDirectory
    }
  }

  const attentionFor = (session: AgentSessionSnapshot): AgentAttentionSetResult | undefined =>
    catalog.attention.find(
      ({ target }) => target.target.agentSessionId === session.binding.agentSessionId
    )

  return (
    <section aria-labelledby="agent-sessions-heading" className="configuration-settings">
      <div className="settings-content-heading">
        <h2 id="agent-sessions-heading">{messages.agentSessions.title}</h2>
        <p>{messages.agentSessions.description}</p>
      </div>
      {status ? (
        <p aria-live="polite" role="status">
          {status}
        </p>
      ) : null}
      <form onSubmit={register}>
        <fieldset disabled={Boolean(busy) || !context}>
          <legend>{messages.agentSessions.register}</legend>
          <label>
            {messages.agentSessions.threadId}
            <input name="agentSessionId" required type="text" />
          </label>
          <label>
            {messages.agentSessions.sessionTitle}
            <input maxLength={160} name="title" required type="text" />
          </label>
          <Button type="submit">{messages.agentSessions.register}</Button>
        </fieldset>
      </form>
      {!context ? <p>{messages.agentSessions.noTerminal}</p> : null}
      <h3>{messages.agentSessions.sessions}</h3>
      {catalog.sessions.length ? (
        <ul aria-label={messages.agentSessions.sessions}>
          {catalog.sessions.map((session) => {
            const attention = attentionFor(session)
            const sessionId = session.binding.agentSessionId
            return (
              <AgentSessionCard
                attention={attention}
                busy={Boolean(busy)}
                existingDestinationAvailable={Boolean(
                  context &&
                  (context.workspaceId !== session.binding.workspaceId ||
                    context.paneId !== session.binding.paneId ||
                    context.tabId !== session.binding.tabId)
                )}
                key={sessionId}
                onAssess={() =>
                  void run(`assess:${sessionId}`, async () => {
                    const result = await window.desktopBridge.assessAgentRestore!({
                      agentSessionId: sessionId,
                      expectedRevision: session.revision
                    })
                    setStatus(messages.agentSessions.assessed(result.assessment.level))
                  })
                }
                onAttention={(state: AgentAttentionState) =>
                  void run(`attention:${sessionId}`, async () => {
                    await window.desktopBridge.setAgentAttention!({
                      agentSessionId: sessionId,
                      state,
                      expectedAttentionRevision: attention?.revision ?? null,
                      expectedSessionRevision: session.revision
                    })
                  })
                }
                onFork={(title, destinationKind) =>
                  void run(`fork:${sessionId}`, async () => {
                    const destination = await destinationForFork(destinationKind)
                    await window.desktopBridge.forkAgentSession!({
                      agentSessionId: sessionId,
                      expectedRevision: session.revision,
                      destinationKind,
                      workspaceId: destination.workspaceId,
                      paneId: destination.paneId,
                      tabId: destination.tabId,
                      title
                    })
                  })
                }
                onHibernate={() =>
                  void run(`hibernate:${sessionId}`, async () => {
                    const result = await window.desktopBridge.hibernateAgentSession!({
                      agentSessionId: sessionId,
                      expectedRevision: session.revision
                    })
                    if (result === null) setStatus(messages.agentSessions.hibernateCanceled)
                  })
                }
                onNavigate={() => void onNavigate(session.binding)}
                onRestore={() =>
                  void run(`restore:${sessionId}`, async () => {
                    const result = await window.desktopBridge.restoreAgentSession!({
                      agentSessionId: sessionId,
                      expectedRevision: session.revision
                    })
                    setStatus(messages.agentSessions.restored(result.outcome))
                  })
                }
                session={session}
              />
            )
          })}
        </ul>
      ) : (
        <p>{messages.agentSessions.noSessions}</p>
      )}
      <h3>{messages.agentSessions.teams}</h3>
      <form onSubmit={createTeam}>
        <label>
          {messages.agentSessions.teamTitle}
          <input maxLength={160} name="title" required type="text" />
        </label>
        <Button disabled={Boolean(busy)} type="submit">
          {messages.agentSessions.createTeam}
        </Button>
      </form>
      {catalog.teams.length ? (
        <ul aria-label={messages.agentSessions.teams}>
          {catalog.teams.map((team) => (
            <AgentTeamCard
              busy={Boolean(busy)}
              key={team.teamId}
              onAddMember={(agentSessionId, role, parentMemberId) =>
                void run(`member-add:${team.teamId}`, async () => {
                  await window.desktopBridge.createAgentTeamMember!({
                    teamId: team.teamId,
                    agentSessionId,
                    role,
                    ...(parentMemberId ? { parentMemberId } : {}),
                    expectedCatalogRevision: catalog.revision,
                    expectedTeamRevision: team.revision
                  })
                })
              }
              onDelete={() =>
                void run(`team-delete:${team.teamId}`, async () => {
                  await window.desktopBridge.deleteAgentTeam!({
                    teamId: team.teamId,
                    expectedCatalogRevision: catalog.revision,
                    expectedTeamRevision: team.revision
                  })
                })
              }
              onNavigate={(member: AgentTeamMemberSnapshot) => void onNavigate(member.target)}
              onMoveMember={(member, agentSessionId) =>
                void run(`member-move:${member.memberId}`, async () => {
                  await window.desktopBridge.moveAgentTeamMember!({
                    teamId: team.teamId,
                    memberId: member.memberId,
                    agentSessionId,
                    expectedCatalogRevision: catalog.revision,
                    expectedTeamRevision: team.revision,
                    expectedMemberRevision: member.revision
                  })
                })
              }
              onRemoveMember={(member: AgentTeamMemberSnapshot) =>
                void run(`member-delete:${member.memberId}`, async () => {
                  await window.desktopBridge.deleteAgentTeamMember!({
                    teamId: team.teamId,
                    memberId: member.memberId,
                    expectedCatalogRevision: catalog.revision,
                    expectedTeamRevision: team.revision,
                    expectedMemberRevision: member.revision
                  })
                })
              }
              onUpdateMember={(member, role, parentMemberId) =>
                void run(`member-update:${member.memberId}`, async () => {
                  await window.desktopBridge.updateAgentTeamMember!({
                    teamId: team.teamId,
                    memberId: member.memberId,
                    role,
                    ...(parentMemberId ? { parentMemberId } : {}),
                    expectedCatalogRevision: catalog.revision,
                    expectedTeamRevision: team.revision,
                    expectedMemberRevision: member.revision
                  })
                })
              }
              sessions={catalog.sessions}
              team={team}
            />
          ))}
        </ul>
      ) : (
        <p>{messages.agentSessions.noTeams}</p>
      )}
    </section>
  )
}

function formText(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : ''
}
