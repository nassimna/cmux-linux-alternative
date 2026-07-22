// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentSessionSnapshot, AgentTeamSnapshot } from '@agent-workspace/protocol-client'

import { AgentSessionCard } from './AgentSessionCard'
import { AgentTeamCard } from './AgentTeamCard'

afterEach(cleanup)

const binding = (seed: string) => ({
  workspaceId: `${seed}0000000-0000-4000-8000-000000000001`,
  paneId: `${seed}0000000-0000-4000-8000-000000000002`,
  tabId: `${seed}0000000-0000-4000-8000-000000000003`,
  agentSessionId: `${seed}0000000-0000-4000-8000-000000000004`
})

const session = (seed = '1'): AgentSessionSnapshot => ({
  catalogVersion: 1,
  binding: binding(seed),
  adapterId: 'codex',
  adapterVersion: '0.142.4',
  title: `session ${seed}`,
  lifecycle: 'hibernated',
  hibernationState: 'hibernated',
  restore: { level: 'toolResume', assessedAtMs: 1, evidenceEpoch: 1 },
  revision: 2,
  attemptEpoch: 3,
  lastVerifiedAtMs: 1
})

describe('agent session settings cards', () => {
  it('renders hibernation and forces same-terminal forks to a new destination', () => {
    render(
      <AgentSessionCard
        attention={undefined}
        busy={false}
        existingDestinationAvailable={false}
        onAssess={vi.fn()}
        onAttention={vi.fn()}
        onFork={vi.fn()}
        onHibernate={vi.fn()}
        onNavigate={vi.fn()}
        onRestore={vi.fn()}
        session={session()}
      />
    )

    expect(screen.getByText(/Hibernation state: hibernated/)).toBeVisible()
    expect(screen.getByLabelText('Use another selected terminal')).toBeDisabled()
    expect(screen.getByLabelText('Create a new terminal')).toBeChecked()
  })

  it('represents parent membership and exposes exact update and move mutations', () => {
    const first = session('1')
    const second = session('2')
    const rootId = '30000000-0000-4000-8000-000000000001'
    const childId = '30000000-0000-4000-8000-000000000002'
    const team: AgentTeamSnapshot = {
      teamId: '30000000-0000-4000-8000-000000000003',
      title: 'workers',
      revision: 2,
      members: [
        { memberId: rootId, role: 'lead', target: first.binding, revision: 1 },
        {
          memberId: childId,
          role: 'worker',
          target: second.binding,
          parentMemberId: rootId,
          revision: 1
        }
      ]
    }
    const onUpdateMember = vi.fn()
    const onMoveMember = vi.fn()
    const third = session('4')
    render(
      <AgentTeamCard
        busy={false}
        onAddMember={vi.fn()}
        onDelete={vi.fn()}
        onMoveMember={onMoveMember}
        onNavigate={vi.fn()}
        onRemoveMember={vi.fn()}
        onUpdateMember={onUpdateMember}
        sessions={[first, second, third]}
        team={team}
      />
    )

    expect(screen.getByText('Child of lead')).toBeVisible()
    const child = screen.getByText('Child of lead').closest('li')!
    fireEvent.change(within(child).getByLabelText('Member role'), { target: { value: 'reviewer' } })
    fireEvent.submit(within(child).getByRole('button', { name: 'Update member' }).closest('form')!)
    expect(onUpdateMember).toHaveBeenCalledWith(team.members[1], 'reviewer', rootId)

    fireEvent.change(within(child).getByLabelText('Move member to session'), {
      target: { value: third.binding.agentSessionId }
    })
    fireEvent.submit(
      within(child).getByRole('button', { name: 'Move member to session' }).closest('form')!
    )
    expect(onMoveMember).toHaveBeenCalledWith(team.members[1], third.binding.agentSessionId)
  })
})
