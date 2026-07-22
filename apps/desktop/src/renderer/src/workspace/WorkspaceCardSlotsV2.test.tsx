// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceCardSlotV2Snapshot } from '@agent-workspace/protocol-client'

import type { DesktopBridge } from '../../../shared/desktop-bridge'
import { WorkspaceCardSlotsV2, type WorkspaceCardSlotsV2 as Slots } from './WorkspaceCardSlotsV2'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const openExternal = vi.fn().mockResolvedValue(undefined)

afterEach(cleanup)
beforeEach(() => {
  openExternal.mockClear()
  window.desktopBridge = { openExternal } as unknown as DesktopBridge
})

const slot = <K extends WorkspaceCardSlotV2Snapshot['kind']>(
  kind: K,
  payload: Extract<NonNullable<WorkspaceCardSlotV2Snapshot['payload']>, { kind: K }>
): WorkspaceCardSlotV2Snapshot => ({ workspaceId, kind, slotRevision: 1, payload })

describe('WorkspaceCardSlotsV2', () => {
  it('creates no DOM or focus stop for absent slots', () => {
    const { container } = render(<WorkspaceCardSlotsV2 slots={{}} />)
    expect(container.childElementCount).toBe(0)
  })

  it('renders the fixed slot order with textual progress and public state only', () => {
    const slots: Slots = {
      progress: slot('progress', {
        kind: 'progress',
        value: { mode: 'determinate', value: 73, label: 'Tests' }
      }),
      pullRequest: slot('pullRequest', {
        kind: 'pullRequest',
        value: {
          provider: 'GitHub',
          number: 42,
          title: 'Bounded card slots',
          lifecycle: 'open',
          checks: 'passing',
          url: null
        }
      }),
      ssh: slot('ssh', {
        kind: 'ssh',
        value: { label: 'Production bastion', state: 'connected' }
      })
    }
    render(<WorkspaceCardSlotsV2 slots={slots} />)
    expect(
      screen
        .getByRole('progressbar', { name: 'Tests, 73 percent complete' })
        .getAttribute('aria-valuenow')
    ).toBe('73')
    const summary = screen.getByRole('region', { name: 'Workspace card details' })
    expect(summary.textContent).toMatch(/Progress.*Pull request.*SSH/u)
    expect(summary.textContent).not.toMatch(/password|username|\/home\//iu)
  })

  it.each(['compact', 'comfortable', 'expanded'])(
    'preserves every payload kind and semantic order at %s density',
    (density) => {
      const slots: Slots = {
        agentStatus: slot('agentStatus', {
          kind: 'agentStatus',
          value: { status: 'running', label: 'Reviewing' }
        }),
        progress: slot('progress', {
          kind: 'progress',
          value: { mode: 'indeterminate', label: 'Waiting for checks' }
        }),
        pullRequest: slot('pullRequest', {
          kind: 'pullRequest',
          value: {
            provider: 'GitHub',
            number: 42,
            title: 'Qualify cards',
            lifecycle: 'open',
            checks: 'passing',
            url: 'https://example.com/pull/42'
          }
        }),
        metadata: slot('metadata', {
          kind: 'metadata',
          value: { rows: [{ key: 'Owner', value: 'Desktop' }] }
        }),
        markdown: slot('markdown', {
          kind: 'markdown',
          value: { source: '**Safe** summary' }
        }),
        logTail: slot('logTail', {
          kind: 'logTail',
          value: { lines: ['static output'], truncated: true }
        }),
        task: slot('task', {
          kind: 'task',
          value: {
            title: 'Checklist',
            items: [
              {
                id: '20000000-0000-4000-8000-000000000001',
                label: 'Audit',
                state: 'completed'
              }
            ]
          }
        }),
        ssh: slot('ssh', {
          kind: 'ssh',
          value: { label: 'Build host', state: 'connected' }
        }),
        media: slot('media', {
          kind: 'media',
          value: { label: 'Alert', mediaKind: 'audio', state: 'playing' }
        })
      }
      render(
        <div data-density={density}>
          <WorkspaceCardSlotsV2 slots={slots} />
        </div>
      )
      const summary = screen.getByRole('region', { name: 'Workspace card details' })
      expect([...summary.children].map((element) => element.textContent)).toEqual([
        'Agent: Running — Reviewing',
        'Progress: Waiting for checks · In progress',
        'Pull request: GitHub #42 · Qualify cards · open · passing',
        'OwnerDesktop',
        'Safe summary',
        'static outputEarlier log lines omitted',
        'Checklist✓ Audit (completed)',
        'SSH: Build host · connected',
        'Media: Alert · audio · playing'
      ])
    }
  )

  it('exposes log tail as a static named region without live-log announcements', () => {
    render(
      <WorkspaceCardSlotsV2
        slots={{
          logTail: slot('logTail', {
            kind: 'logTail',
            value: { lines: ['tests passed'], truncated: false }
          })
        }}
      />
    )
    const region = screen.getByRole('region', { name: 'Recent log output' })
    expect(region.hasAttribute('aria-live')).toBe(false)
    expect(region.hasAttribute('aria-atomic')).toBe(false)
    expect(region.getAttribute('tabindex')).toBe('0')
    expect(region.textContent).toContain('tests passed')
  })

  it('does not expose a pull-request href when defense-in-depth URL validation fails', () => {
    render(
      <WorkspaceCardSlotsV2
        slots={{
          pullRequest: slot('pullRequest', {
            kind: 'pullRequest',
            value: {
              provider: 'GitHub',
              number: 42,
              title: 'Credentialed link',
              lifecycle: 'open',
              checks: 'pending',
              url: 'https://user:secret@example.com/pr/42'
            }
          })
        }}
      />
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/Credentialed link/u)).not.toBeNull()
  })

  it('keeps hostile Markdown inert, omits images, and opens only validated links', () => {
    const slots: Slots = {
      markdown: slot('markdown', {
        kind: 'markdown',
        value: {
          source:
            '# Notes\n\n<script>alert(1)</script> ![tracking](https://evil.invalid/a.png)\n\n[Safe](https://example.com) [Data](data:text/html,boom)'
        }
      })
    }
    const { container } = render(<WorkspaceCardSlotsV2 slots={slots} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/<script>alert\(1\)<\/script>/u)).not.toBeNull()
    expect(screen.getByText('Data').closest('a')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'Safe' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    const safe = screen.getByRole('link', { name: 'Safe' })
    safe.focus()
    expect(document.activeElement).toBe(safe)
    expect(safe.getAttribute('rel')).toBe('noreferrer noopener')
  })

  it.each([
    'https://user:secret@example.com/',
    'HTTPS://example.com/',
    ' https://example.com/',
    'https://example.com/bad\npath',
    'file:///etc/passwd',
    'javascript:alert(1)'
  ])('does not expose or activate unsafe Markdown URL %s', (url) => {
    const slots: Slots = {
      markdown: slot('markdown', {
        kind: 'markdown',
        value: { source: `[Unsafe](${url})` }
      })
    }
    const { container } = render(<WorkspaceCardSlotsV2 slots={slots} />)
    expect(container.querySelector('a')).toBeNull()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
