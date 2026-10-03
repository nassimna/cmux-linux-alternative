// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'
import { RemoteSessionsSettings } from './RemoteSessionsSettings'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const listRemoteTargets = vi.fn()

describe('RemoteSessionsSettings', () => {
  beforeEach(() => {
    listRemoteTargets.mockReset().mockResolvedValue({ targets: [] })
    window.desktopBridge = {
      listRemoteTargets,
      listRemoteSessions: vi.fn().mockResolvedValue({ sessions: [] })
    } as unknown as DesktopBridge
  })

  it('refreshes a visible session after its transport changes state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    listRemoteTargets.mockResolvedValue({
      targets: [
        {
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          label: 'Build host',
          host: 'example.com',
          port: 22,
          user: 'builder',
          hostKeyState: 'trusted',
          revision: 1
        }
      ]
    })
    const session = {
      remoteSessionId: '30000000-0000-4000-8000-000000000010',
      remoteTargetId: '30000000-0000-4000-8000-000000000001',
      observation: 'lastVerified',
      revision: 4
    }
    window.desktopBridge.listRemoteSessions = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [{ ...session, state: 'connected' }] })
      .mockResolvedValue({
        sessions: [{ ...session, state: 'failed', observation: 'unknown', revision: 5 }]
      })
    render(<RemoteSessionsSettings context={null} open />)
    expect(await screen.findByRole('group', { name: 'Session connected' })).toBeVisible()
    await act(async () => {
      vi.advanceTimersByTime(2_500)
    })
    expect(await screen.findByRole('group', { name: 'Session failed' })).toBeVisible()
  })

  it('exposes a labeled, keyboard-operable enrollment form without credential inputs', async () => {
    render(<RemoteSessionsSettings context={null} open />)

    expect(screen.getByRole('heading', { name: 'Remote sessions' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'Add a remote target' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Label' })).toBeRequired()
    expect(screen.getByRole('textbox', { name: 'Host' })).toBeRequired()
    expect(screen.getByRole('spinbutton', { name: 'Port' })).toHaveValue(22)
    expect(screen.getByRole('textbox', { name: 'User' })).toHaveAttribute(
      'autocomplete',
      'username'
    )
    expect(screen.queryByLabelText(/private key|credential path|secret/i)).not.toBeInTheDocument()
    await waitFor(() => expect(listRemoteTargets).toHaveBeenCalledOnce())
  })

  it('requests one main-owned host-key confirmation without receiving challenge authority', async () => {
    const confirmRemoteHostKey = vi.fn().mockResolvedValue({ session: {} })
    listRemoteTargets.mockResolvedValue({
      targets: [
        {
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          label: 'Build host',
          host: 'example.com',
          port: 22,
          user: 'builder',
          hostKeyState: 'untrusted',
          revision: 2
        }
      ]
    })
    window.desktopBridge.listRemoteSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          remoteSessionId: '30000000-0000-4000-8000-000000000010',
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          state: 'trustRequired',
          observation: 'unknown',
          revision: 4
        }
      ]
    })
    window.desktopBridge.confirmRemoteHostKey = confirmRemoteHostKey

    render(<RemoteSessionsSettings context={null} open />)
    expect(await screen.findByRole('button', { name: 'Discover tmux' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled()
    expect(screen.getByText('Scan and trust the host key, then reconnect.')).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: 'Scan host key' }))

    await waitFor(() =>
      expect(confirmRemoteHostKey).toHaveBeenCalledWith({
        remoteSessionId: '30000000-0000-4000-8000-000000000010',
        expectedRevision: 4
      })
    )
    expect(window.desktopBridge).not.toHaveProperty('decideRemoteHostKey')
  })

  it('offers reconnect after host trust and keeps discovery unavailable until connected', async () => {
    listRemoteTargets.mockResolvedValue({
      targets: [
        {
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          label: 'Build host',
          host: 'example.com',
          port: 22,
          user: 'builder',
          hostKeyState: 'trusted',
          revision: 2
        }
      ]
    })
    window.desktopBridge.listRemoteSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          remoteSessionId: '30000000-0000-4000-8000-000000000010',
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          state: 'trustRequired',
          observation: 'unknown',
          revision: 4
        }
      ]
    })
    const reconnectRemoteSession = vi.fn().mockResolvedValue({ session: {} })
    window.desktopBridge.reconnectRemoteSession = reconnectRemoteSession

    render(<RemoteSessionsSettings context={null} open />)

    expect(
      await screen.findByText('Host key trusted. Reconnect to start the SSH session.')
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Scan host key' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discover tmux' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() =>
      expect(reconnectRemoteSession).toHaveBeenCalledWith({
        remoteSessionId: '30000000-0000-4000-8000-000000000010',
        expectedRevision: 4
      })
    )
  })

  it('offers close and fresh connect after a failed attempt', async () => {
    listRemoteTargets.mockResolvedValue({
      targets: [
        {
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          label: 'Build host',
          host: 'example.com',
          port: 22,
          user: 'builder',
          hostKeyState: 'trusted',
          revision: 2
        }
      ]
    })
    window.desktopBridge.listRemoteSessions = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          {
            remoteSessionId: '30000000-0000-4000-8000-000000000010',
            remoteTargetId: '30000000-0000-4000-8000-000000000001',
            state: 'failed',
            observation: 'unknown',
            revision: 4
          }
        ]
      })
      .mockResolvedValue({ sessions: [] })
    const closeRemoteSession = vi.fn().mockResolvedValue(true)
    window.desktopBridge.closeRemoteSession = closeRemoteSession

    render(<RemoteSessionsSettings context={{ workspaceId: 'w', paneId: 'p', tabId: 't' }} open />)

    expect(
      await screen.findByText('This attempt failed. Close it, then connect again.')
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Discover tmux' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Detach' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(closeRemoteSession).toHaveBeenCalledWith({
        remoteSessionId: '30000000-0000-4000-8000-000000000010',
        expectedRevision: 4
      })
    )
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('renders every active session for a target and does not offer a duplicate connect', async () => {
    listRemoteTargets.mockResolvedValue({
      targets: [
        {
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          label: 'Build host',
          host: 'example.com',
          port: 22,
          user: 'builder',
          hostKeyState: 'trusted',
          revision: 1
        }
      ]
    })
    window.desktopBridge.listRemoteSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          remoteSessionId: '30000000-0000-4000-8000-000000000010',
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          state: 'connected',
          observation: 'reachable',
          revision: 1
        },
        {
          remoteSessionId: '30000000-0000-4000-8000-000000000011',
          remoteTargetId: '30000000-0000-4000-8000-000000000001',
          state: 'detached',
          observation: 'unknown',
          revision: 2
        }
      ]
    })

    render(<RemoteSessionsSettings context={{ workspaceId: 'w', paneId: 'p', tabId: 't' }} open />)

    expect(await screen.findByRole('group', { name: 'Session connected' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'Session detached' })).toBeVisible()
    expect(
      within(screen.getByRole('group', { name: 'Session connected' })).getByRole('button', {
        name: 'Discover tmux'
      })
    ).toBeEnabled()
    expect(
      within(screen.getByRole('group', { name: 'Session detached' })).getByRole('button', {
        name: 'Reconnect'
      })
    ).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
  })
})
