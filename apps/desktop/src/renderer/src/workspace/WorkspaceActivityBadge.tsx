import { CheckCircle2, Circle, CircleX, Clock3, LoaderCircle } from 'lucide-react'
import type { AgentStatus, WorkspaceCardSlotsSnapshot } from '@agent-workspace/protocol-client'

import { messages } from '../messages'
import type { WorkspaceCardSlotsV2 } from './WorkspaceCardSlotsV2'

export interface WorkspaceActivity {
  readonly label: string | null
  readonly state: AgentStatus
}

export function workspaceActivity(
  slots: WorkspaceCardSlotsSnapshot | undefined,
  slotsV2: WorkspaceCardSlotsV2 | undefined
): WorkspaceActivity | null {
  const v2Status = slotsV2?.agentStatus?.payload
  if (v2Status?.kind === 'agentStatus') {
    return { state: v2Status.value.status, label: v2Status.value.label }
  }
  if (slots?.agentStatus) {
    return { state: slots.agentStatus.status, label: slots.agentStatus.label }
  }

  const v2Progress = slotsV2?.progress?.payload
  if (v2Progress?.kind === 'progress') {
    return activityFromProgress(v2Progress.value)
  }
  if (slots?.progress) return activityFromProgress(slots.progress)
  return null
}

export function WorkspaceActivityBadge({
  activity,
  workspaceName
}: {
  activity: WorkspaceActivity | null
  workspaceName: string
}): React.JSX.Element | null {
  if (!activity) return null
  const status = messages.workspaceCardSlots.agentStatus[activity.state]
  const accessible = `${workspaceName}: ${status}${activity.label ? ` — ${activity.label}` : ''}`
  const iconProps = { 'aria-hidden': true as const, size: 12, strokeWidth: 2 }

  return (
    <span
      aria-label={accessible}
      className="workspace-activity"
      data-state={activity.state}
      role="status"
      title={accessible}
    >
      {activity.state === 'running' ? <LoaderCircle {...iconProps} /> : null}
      {activity.state === 'waiting' ? <Clock3 {...iconProps} /> : null}
      {activity.state === 'completed' ? <CheckCircle2 {...iconProps} /> : null}
      {activity.state === 'failed' ? <CircleX {...iconProps} /> : null}
      {activity.state === 'idle' ? <Circle {...iconProps} /> : null}
      <span>{status}</span>
    </span>
  )
}

function activityFromProgress(
  progress:
    | NonNullable<WorkspaceCardSlotsSnapshot['progress']>
    | Extract<
        NonNullable<WorkspaceCardSlotsV2['progress']>['payload'],
        { kind: 'progress' }
      >['value']
): WorkspaceActivity {
  return {
    state: progress.mode === 'determinate' && progress.value === 100 ? 'completed' : 'running',
    label: progress.label
  }
}
