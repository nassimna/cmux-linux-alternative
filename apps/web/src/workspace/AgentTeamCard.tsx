import { useState, type FormEvent } from 'react'

import type { AgentSessionSnapshot, AgentTeamSnapshot } from '@agent-workspace/protocol-client'

import { messages } from '../messages'
import { Button } from '../ui/button'

export function AgentTeamCard({
  busy,
  onAddMember,
  onDelete,
  onMoveMember,
  onNavigate,
  onRemoveMember,
  onUpdateMember,
  sessions,
  team
}: {
  busy: boolean
  onAddMember: (agentSessionId: string, role: string, parentMemberId?: string) => void
  onDelete: () => void
  onMoveMember: (member: AgentTeamSnapshot['members'][number], agentSessionId: string) => void
  onNavigate: (member: AgentTeamSnapshot['members'][number]) => void
  onRemoveMember: (member: AgentTeamSnapshot['members'][number]) => void
  onUpdateMember: (
    member: AgentTeamSnapshot['members'][number],
    role: string,
    parentMemberId?: string
  ) => void
  sessions: readonly AgentSessionSnapshot[]
  team: AgentTeamSnapshot
}): React.JSX.Element {
  const available = sessions.filter(
    (session) =>
      !team.members.some(
        (member) => member.target.agentSessionId === session.binding.agentSessionId
      )
  )
  const [agentSessionId, setAgentSessionId] = useState('')
  const [role, setRole] = useState('member')
  const [parentMemberId, setParentMemberId] = useState('')
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (agentSessionId) onAddMember(agentSessionId, role.trim(), parentMemberId || undefined)
  }
  return (
    <li>
      <article aria-labelledby={`agent-team-${team.teamId}`}>
        <h3 id={`agent-team-${team.teamId}`}>{team.title}</h3>
        <Button disabled={busy} onClick={onDelete} size="small" variant="destructive">
          {messages.agentSessions.deleteTeam}
        </Button>
        {team.members.length ? (
          <ul aria-label={messages.agentSessions.membersFor(team.title)}>
            {team.members.map((member) => (
              <li key={member.memberId}>
                <span>{member.role}</span>{' '}
                {member.parentMemberId ? (
                  <small>
                    {messages.agentSessions.childOf(
                      team.members.find(({ memberId }) => memberId === member.parentMemberId)
                        ?.role ?? member.parentMemberId
                    )}
                  </small>
                ) : null}{' '}
                <code>{member.target.agentSessionId}</code>
                <Button disabled={busy} onClick={() => onNavigate(member)} size="small">
                  {messages.agentSessions.navigate}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => onRemoveMember(member)}
                  size="small"
                  variant="destructive"
                >
                  {messages.agentSessions.removeMember}
                </Button>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    const form = new FormData(event.currentTarget)
                    const roleValue = form.get('role')
                    const parentValue = form.get('parentMemberId')
                    const nextRole = typeof roleValue === 'string' ? roleValue.trim() : ''
                    const parent = typeof parentValue === 'string' ? parentValue : ''
                    if (nextRole) onUpdateMember(member, nextRole, parent || undefined)
                  }}
                >
                  <label>
                    {messages.agentSessions.role}
                    <input defaultValue={member.role} maxLength={80} name="role" required />
                  </label>
                  <label>
                    {messages.agentSessions.parentMember}
                    <select defaultValue={member.parentMemberId ?? ''} name="parentMemberId">
                      <option value="">{messages.agentSessions.rootMember}</option>
                      {team.members
                        .filter(({ memberId }) => memberId !== member.memberId)
                        .map((candidate) => (
                          <option key={candidate.memberId} value={candidate.memberId}>
                            {candidate.role} · {candidate.target.agentSessionId}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Button disabled={busy} size="small" type="submit">
                    {messages.agentSessions.updateMember}
                  </Button>
                </form>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    const targetValue = new FormData(event.currentTarget).get('agentSessionId')
                    const target = typeof targetValue === 'string' ? targetValue : ''
                    if (target) onMoveMember(member, target)
                  }}
                >
                  <label>
                    {messages.agentSessions.moveMember}
                    <select name="agentSessionId" required>
                      <option value="">{messages.agentSessions.chooseSession}</option>
                      {available.map((session) => (
                        <option
                          key={session.binding.agentSessionId}
                          value={session.binding.agentSessionId}
                        >
                          {session.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button disabled={busy || available.length === 0} size="small" type="submit">
                    {messages.agentSessions.moveMember}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p>{messages.agentSessions.noMembers}</p>
        )}
        <form onSubmit={submit}>
          <label>
            {messages.agentSessions.memberSession}
            <select
              onChange={(event) => setAgentSessionId(event.currentTarget.value)}
              required
              value={agentSessionId}
            >
              <option value="">{messages.agentSessions.chooseSession}</option>
              {available.map((session) => (
                <option key={session.binding.agentSessionId} value={session.binding.agentSessionId}>
                  {session.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            {messages.agentSessions.role}
            <input
              maxLength={80}
              onChange={(event) => setRole(event.currentTarget.value)}
              required
              value={role}
            />
          </label>
          <label>
            {messages.agentSessions.parentMember}
            <select
              onChange={(event) => setParentMemberId(event.currentTarget.value)}
              value={parentMemberId}
            >
              <option value="">{messages.agentSessions.rootMember}</option>
              {team.members.map((member) => (
                <option key={member.memberId} value={member.memberId}>
                  {member.role} · {member.target.agentSessionId}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy || !agentSessionId || !role.trim()} size="small" type="submit">
            {messages.agentSessions.addMember}
          </Button>
        </form>
      </article>
    </li>
  )
}
