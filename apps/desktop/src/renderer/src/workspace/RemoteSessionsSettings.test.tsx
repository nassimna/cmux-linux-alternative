// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '../../../shared/desktop-bridge'
import { RemoteSessionsSettings } from './RemoteSessionsSettings'

afterEach(cleanup)
const listRemoteTargets = vi.fn()

describe('RemoteSessionsSettings', () => {
  beforeEach(() => {
    listRemoteTargets.mockReset().mockResolvedValue({ targets: [] })
    window.desktopBridge = {
      listRemoteTargets,
      listRemoteSessions: vi.fn().mockResolvedValue({ sessions: [] })
    } as unknown as DesktopBridge
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
    fireEvent.click(await screen.findByRole('button', { name: 'Scan host key' }))

    await waitFor(() =>
      expect(confirmRemoteHostKey).toHaveBeenCalledWith({
        remoteSessionId: '30000000-0000-4000-8000-000000000010',
        expectedRevision: 4
      })
    )
    expect(window.desktopBridge).not.toHaveProperty('decideRemoteHostKey')
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
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
  })
})
