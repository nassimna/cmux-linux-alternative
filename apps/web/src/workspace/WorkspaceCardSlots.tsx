import type { WorkspaceCardSlotsSnapshot } from '@agent-workspace/protocol-client'
import type { JSX } from 'react'

import { messages } from '../messages'

export function WorkspaceCardSlots({
  slots
}: {
  slots: WorkspaceCardSlotsSnapshot | undefined
}): JSX.Element | null {
  if (!slots?.agentStatus && !slots?.progress) return null
  const agentStatus = slots.agentStatus
  const progress = slots.progress
  return (
    <span className="workspace-card-slots">
      {agentStatus ? (
        <small aria-atomic="true" aria-live="polite" className="workspace-agent-status">
          <span className="workspace-card-slot-label">{messages.workspaceCardSlots.agent}:</span>{' '}
          {messages.workspaceCardSlots.agentStatus[agentStatus.status]}
          {agentStatus.label ? ` — ${agentStatus.label}` : ''}
        </small>
      ) : null}
      {progress?.mode === 'determinate' ? (
        <span
          aria-label={messages.workspaceCardSlots.progressAccessible(
            progress.value,
            progress.label
          )}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress.value}
          aria-valuetext={messages.workspaceCardSlots.progressAccessible(
            progress.value,
            progress.label
          )}
          className="workspace-card-progress"
          role="progressbar"
        >
          <span className="workspace-card-progress-copy">
            {progress.label ? `${progress.label} · ` : ''}
            {String(progress.value)}%
          </span>
          <span aria-hidden="true" className="workspace-card-progress-track">
            <span style={{ width: `${String(progress.value)}%` }} />
          </span>
        </span>
      ) : null}
      {progress?.mode === 'indeterminate' ? (
        <small
          aria-label={messages.workspaceCardSlots.indeterminateAccessible(progress.label)}
          className="workspace-card-progress-indeterminate"
          role="progressbar"
        >
          <span className="workspace-card-slot-label">{messages.workspaceCardSlots.progress}:</span>{' '}
          {progress.label} · {messages.workspaceCardSlots.inProgress}
        </small>
      ) : null}
    </span>
  )
}
