import { useState, type FormEvent } from 'react'

import type {
  AgentAttentionSetResult,
  AgentAttentionState,
  AgentSessionSnapshot
} from '@agent-workspace/protocol-client'

import { messages } from '../messages'
import { Button } from '../ui/button'

export interface AgentForkDestination {
  destinationKind: 'existingTerminal' | 'newTerminal'
  workspaceId: string
  paneId: string
  tabId: string
}

export function AgentSessionCard({
  attention,
  busy,
  existingDestinationAvailable,
  onAssess,
  onAttention,
  onFork,
  onHibernate,
  onNavigate,
  onRestore,
  session
}: {
  attention: AgentAttentionSetResult | undefined
  busy: boolean
  existingDestinationAvailable: boolean
  onAssess: () => void
  onAttention: (state: AgentAttentionState) => void
  onFork: (title: string, destination: 'existingTerminal' | 'newTerminal') => void
  onHibernate: () => void
  onNavigate: () => void
  onRestore: () => void
  session: AgentSessionSnapshot
}): React.JSX.Element {
  const [forkTitle, setForkTitle] = useState(`${session.title} fork`)
  const [destination, setDestination] = useState<'existingTerminal' | 'newTerminal'>(
    existingDestinationAvailable ? 'existingTerminal' : 'newTerminal'
  )
  const [attentionState, setAttentionState] = useState<AgentAttentionState>(
    attention?.state ?? 'informational'
  )
  const selectedDestination = existingDestinationAvailable ? destination : 'newTerminal'
  const submitFork = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onFork(forkTitle.trim(), selectedDestination)
  }
  return (
    <li>
      <article aria-labelledby={`agent-session-${session.binding.agentSessionId}`}>
        <h3 id={`agent-session-${session.binding.agentSessionId}`}>{session.title}</h3>
        <p>
          {messages.agentSessions.lifecycle}: {session.lifecycle}
        </p>
        {session.hibernationState ? (
          <p>
            {messages.agentSessions.hibernationState}: {session.hibernationState}
          </p>
        ) : null}
        <p>
          {messages.agentSessions.restoreLevel}:{' '}
          {messages.agentSessions.restoreLevels[session.restore.level]}
        </p>
        <code>{session.binding.agentSessionId}</code>
        {session.forkedFrom ? (
          <p>
            {messages.agentSessions.provenance}: {session.forkedFrom.forkedFromAgentSessionId} ·{' '}
            {session.forkedFrom.artifact.kind} · {session.forkedFrom.artifact.digestSha256}
          </p>
        ) : null}
        <div role="group" aria-label={messages.agentSessions.sessionActions(session.title)}>
          <Button disabled={busy} onClick={onNavigate} size="small">
            {messages.agentSessions.navigate}
          </Button>
          <Button disabled={busy} onClick={onAssess} size="small">
            {messages.agentSessions.assess}
          </Button>
          <Button
            disabled={busy || session.restore.level === 'unavailable'}
            onClick={onRestore}
            size="small"
          >
            {messages.agentSessions.restore}
          </Button>
          <Button disabled={busy} onClick={onHibernate} size="small" variant="destructive">
            {messages.agentSessions.hibernate}
          </Button>
        </div>
        <form onSubmit={submitFork}>
          <label>
            {messages.agentSessions.forkTitle}
            <input
              maxLength={160}
              onChange={(event) => setForkTitle(event.currentTarget.value)}
              required
              value={forkTitle}
            />
          </label>
          <fieldset>
            <legend>{messages.agentSessions.forkDestination}</legend>
            <label>
              <input
                checked={selectedDestination === 'existingTerminal'}
                disabled={!existingDestinationAvailable}
                name={`fork-destination-${session.binding.agentSessionId}`}
                onChange={() => setDestination('existingTerminal')}
                type="radio"
              />
              {messages.agentSessions.existingTerminal}
            </label>
            <label>
              <input
                checked={selectedDestination === 'newTerminal'}
                name={`fork-destination-${session.binding.agentSessionId}`}
                onChange={() => setDestination('newTerminal')}
                type="radio"
              />
              {messages.agentSessions.newTerminal}
            </label>
          </fieldset>
          {!existingDestinationAvailable ? (
            <small>{messages.agentSessions.sourceDestinationBlocked}</small>
          ) : null}
          <Button disabled={busy || !forkTitle.trim()} size="small" type="submit">
            {messages.agentSessions.fork}
          </Button>
        </form>
        <div role="group" aria-label={messages.agentSessions.attentionFor(session.title)}>
          <label>
            {messages.agentSessions.attention}
            <select
              onChange={(event) =>
                setAttentionState(event.currentTarget.value as AgentAttentionState)
              }
              value={attentionState}
            >
              <option value="informational">{messages.agentSessions.informational}</option>
              <option value="completed">{messages.agentSessions.completed}</option>
              <option value="waiting">{messages.agentSessions.waiting}</option>
              <option value="urgent">{messages.agentSessions.urgent}</option>
            </select>
          </label>
          <Button disabled={busy} onClick={() => onAttention(attentionState)} size="small">
            {messages.agentSessions.setAttention}
          </Button>
        </div>
      </article>
    </li>
  )
}
