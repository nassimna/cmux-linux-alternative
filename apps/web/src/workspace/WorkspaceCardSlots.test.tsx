// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceCardSlotsSnapshot } from '@agent-workspace/protocol-client'

import { WorkspaceCardSlots } from './WorkspaceCardSlots'

const workspaceId = '10000000-0000-4000-8000-000000000001'

afterEach(cleanup)

function slots(
  value: Omit<WorkspaceCardSlotsSnapshot, 'workspaceId' | 'revision'>
): WorkspaceCardSlotsSnapshot {
  return { workspaceId, revision: 1, ...value }
}

describe('WorkspaceCardSlots', () => {
  it('renders no slot DOM when both fixed slots are absent', () => {
    const { container } = render(
      <WorkspaceCardSlots slots={slots({ agentStatus: null, progress: null })} />
    )
    expect(container.childElementCount).toBe(0)
  })

  it('renders textual agent status and determinate progress semantics', () => {
    render(
      <WorkspaceCardSlots
        slots={slots({
          agentStatus: { status: 'running', label: 'Reviewing changes' },
          progress: { mode: 'determinate', value: 42, label: 'Tests' }
        })}
      />
    )
    expect(screen.getByText(/Running — Reviewing changes/u).getAttribute('aria-live')).toBe(
      'polite'
    )
    const progress = screen.getByRole('progressbar', { name: 'Tests, 42 percent complete' })
    expect(progress.getAttribute('aria-valuenow')).toBe('42')
    expect(progress.getAttribute('aria-valuemin')).toBe('0')
    expect(progress.getAttribute('aria-valuemax')).toBe('100')
    expect(progress.hasAttribute('aria-live')).toBe(false)
  })

  it('renders indeterminate progress semantics without a false numeric value', () => {
    render(
      <WorkspaceCardSlots
        slots={slots({
          agentStatus: { status: 'waiting', label: null },
          progress: { mode: 'indeterminate', label: 'Awaiting approval' }
        })}
      />
    )
    const progress = screen.getByRole('progressbar', {
      name: 'Awaiting approval, progress indeterminate'
    })
    expect(progress.hasAttribute('aria-valuenow')).toBe(false)
    expect(progress.hasAttribute('aria-valuemin')).toBe(false)
    expect(progress.hasAttribute('aria-valuemax')).toBe(false)
    expect(progress.textContent).toContain('Awaiting approval · In progress')
  })
})
