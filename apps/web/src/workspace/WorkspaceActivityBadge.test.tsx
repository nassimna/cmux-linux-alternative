// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  WorkspaceCardSlotsSnapshot,
  WorkspaceCardSlotV2Snapshot
} from '@agent-workspace/protocol-client'

import { WorkspaceActivityBadge, workspaceActivity } from './WorkspaceActivityBadge'
import type { WorkspaceCardSlotsV2 } from './WorkspaceCardSlotsV2'

const workspaceId = '10000000-0000-4000-8000-000000000001'

afterEach(cleanup)

const legacy = (
  value: Omit<WorkspaceCardSlotsSnapshot, 'workspaceId' | 'revision'>
): WorkspaceCardSlotsSnapshot => ({ workspaceId, revision: 1, ...value })

const slot = <K extends WorkspaceCardSlotV2Snapshot['kind']>(
  kind: K,
  payload: Extract<NonNullable<WorkspaceCardSlotV2Snapshot['payload']>, { kind: K }>
): WorkspaceCardSlotV2Snapshot => ({ workspaceId, kind, slotRevision: 1, payload })

describe('WorkspaceActivityBadge', () => {
  it('keeps a running state visible and explicitly labelled', () => {
    const activity = workspaceActivity(
      legacy({
        agentStatus: { status: 'running', label: 'Running tests' },
        progress: null
      }),
      undefined
    )
    render(<WorkspaceActivityBadge activity={activity} workspaceName="API" />)

    const badge = screen.getByRole('status', { name: 'API: Running — Running tests' })
    expect(badge.getAttribute('data-state')).toBe('running')
    expect(badge.textContent).toBe('Running')
  })

  it.each([
    ['waiting', 'Waiting'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['idle', 'Idle']
  ] as const)('renders the %s terminal task state without relying on motion', (state, label) => {
    const activity = workspaceActivity(
      legacy({ agentStatus: { status: state, label: null }, progress: null }),
      undefined
    )
    render(<WorkspaceActivityBadge activity={activity} workspaceName="Worker" />)

    expect(
      screen.getByRole('status', { name: `Worker: ${label}` }).getAttribute('data-state')
    ).toBe(state)
  })

  it('uses the v2 status as authoritative and falls back to progress state', () => {
    const slotsV2: WorkspaceCardSlotsV2 = {
      agentStatus: slot('agentStatus', {
        kind: 'agentStatus',
        value: { status: 'completed', label: 'Checks passed' }
      })
    }
    expect(
      workspaceActivity(
        legacy({ agentStatus: { status: 'running', label: null }, progress: null }),
        slotsV2
      )
    ).toEqual({ state: 'completed', label: 'Checks passed' })
  })

  it('maps incomplete and finished progress to running and completed', () => {
    expect(
      workspaceActivity(
        legacy({
          agentStatus: null,
          progress: { mode: 'determinate', value: 35, label: 'Build' }
        }),
        undefined
      )
    ).toEqual({ state: 'running', label: 'Build' })
    expect(
      workspaceActivity(
        legacy({
          agentStatus: null,
          progress: { mode: 'determinate', value: 100, label: 'Build' }
        }),
        undefined
      )
    ).toEqual({ state: 'completed', label: 'Build' })
  })
})
