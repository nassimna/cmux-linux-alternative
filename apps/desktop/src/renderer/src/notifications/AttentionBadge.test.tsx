// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AttentionSummary, WorkspaceAttentionSnapshot } from '@agent-workspace/protocol-client'

import { AttentionBadge } from './AttentionBadge'

afterEach(cleanup)

function attention(overrides: Partial<AttentionSummary> = {}): AttentionSummary {
  return {
    unreadCount: 1,
    highestLevel: 'warning',
    latestUnread: null,
    ...overrides
  }
}

describe('AttentionBadge', () => {
  it('uses one restrained live region when the same target attention is repeated', () => {
    const authoritative: WorkspaceAttentionSnapshot = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      revision: 2,
      state: 'waiting',
      reason: 'agentWaiting',
      unreadCount: 0
    }
    render(
      <>
        <AttentionBadge attention={authoritative} compact label="Application" />
        <AttentionBadge announce={false} attention={authoritative} compact label="Pane" />
        <AttentionBadge announce={false} attention={authoritative} compact label="Tab" />
      </>
    )

    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(document.querySelectorAll('.attention-badge[aria-hidden="true"]')).toHaveLength(2)
  })

  it('uses authoritative localized state text and can be decorative inside a labeled card', () => {
    const authoritative: WorkspaceAttentionSnapshot = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      revision: 2,
      state: 'waiting',
      reason: 'agentWaiting',
      unreadCount: 0
    }
    render(
      <button aria-label="Workspace; waiting for input" type="button">
        <AttentionBadge announce={false} attention={authoritative} compact label="Workspace" />
      </button>
    )

    expect(screen.getByRole('button', { name: 'Workspace; waiting for input' })).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('Wait').closest('.attention-badge')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
  })

  it('announces the unread count and default severity', () => {
    render(<AttentionBadge attention={attention({ highestLevel: null })} label="Pane" />)

    const badge = screen.getByRole('status', {
      name: 'Pane: 1 unread, highest severity info'
    })
    expect(badge).toHaveAttribute('title', 'Pane: 1 unread, highest severity info')
    expect(badge).toHaveClass('severity-info')
    expect(badge).toHaveTextContent('!1')
  })

  it('includes the latest title and highest severity in the accessible summary', () => {
    render(
      <AttentionBadge
        attention={attention({
          unreadCount: 4,
          highestLevel: 'error',
          latestUnread: {
            notificationId: 'notification-a',
            title: 'Build failed',
            bodyExcerpt: null,
            source: 'cli',
            createdAt: 1
          }
        })}
        compact
        label="Workspace"
      />
    )

    const badge = screen.getByRole('status', {
      name: 'Workspace: 4 unread, highest severity error, latest Build failed'
    })
    expect(badge).toHaveClass('severity-error', 'compact')
  })

  it('caps the visible count without changing the announced count', () => {
    render(<AttentionBadge attention={attention({ unreadCount: 100 })} label="Tab" />)

    const badge = screen.getByRole('status', {
      name: 'Tab: 100 unread, highest severity warning'
    })
    expect(badge).toHaveTextContent('!99+')
  })

  it('renders nothing when there are no unread notifications', () => {
    const { container } = render(
      <AttentionBadge attention={attention({ unreadCount: 0 })} label="Pane" />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
