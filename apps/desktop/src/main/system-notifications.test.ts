import { describe, expect, it, vi } from 'vitest'

import type {
  DomainEventMessage,
  NotificationSnapshot,
  SettingsGetResult
} from '@agent-workspace/protocol-client'

import type { ControlClient } from './control-client'
import settings from '../../../../crates/protocol/fixtures/milestone2-settings.json'
import {
  forwardSystemNotifications,
  shouldShowSystemNotification,
  systemNotificationPayload
} from './system-notifications'

const settingsFixture = settings as SettingsGetResult

const notification: NotificationSnapshot = {
  id: '60000000-0000-4000-8000-000000000001',
  workspaceId: '10000000-0000-4000-8000-000000000001',
  source: 'osc',
  level: 'warning',
  title: 'Agent needs input',
  body: 'Sensitive terminal content',
  createdAt: 1
}

function settingsChangedAt(revision: number): DomainEventMessage {
  return {
    event: 'settings.changed',
    revision,
    data: {
      revision,
      workspaceIds: [],
      paneIds: [],
      tabIds: [],
      commandIds: [],
      reason: 'notification settings changed'
    }
  }
}

function notificationCreatedAt(revision: number): DomainEventMessage {
  return {
    event: 'notification.created',
    revision,
    data: { notification }
  }
}

describe('system notification privacy', () => {
  it('redacts bodies by default and includes them only after opt-in', () => {
    expect(
      systemNotificationPayload(notification, { systemEnabled: true, includeBody: false })
    ).toEqual({ title: 'Agent needs input' })
    expect(
      systemNotificationPayload(notification, { systemEnabled: true, includeBody: true })
    ).toEqual({ title: 'Agent needs input', body: 'Sensitive terminal content' })
  })

  it('suppresses system notifications when disabled', () => {
    expect(
      systemNotificationPayload(notification, { systemEnabled: false, includeBody: true })
    ).toBeNull()
  })

  it('fails closed after a settings refresh error and recovers on an authoritative refresh', async () => {
    let listener: ((event: DomainEventMessage) => void) | undefined
    const getSettings = vi
      .fn<ControlClient['getSettings']>()
      .mockResolvedValueOnce({
        ...settingsFixture,
        notifications: { systemEnabled: true, includeBody: true }
      })
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockResolvedValueOnce({
        ...settingsFixture,
        notifications: { systemEnabled: true, includeBody: false }
      })
    const client = {
      getSettings,
      onDomainEvent: vi.fn((nextListener: (event: DomainEventMessage) => void) => {
        listener = nextListener
        return vi.fn()
      })
    } as unknown as ControlClient
    const show = vi.fn()

    const dispose = await forwardSystemNotifications(client, show)
    listener?.(settingsChangedAt(2))
    listener?.(notificationCreatedAt(3))

    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(show).not.toHaveBeenCalled()

    listener?.(settingsChangedAt(4))
    listener?.(notificationCreatedAt(5))

    await vi.waitFor(() => expect(show).toHaveBeenCalledWith({ title: 'Agent needs input' }))
    expect(show).toHaveBeenCalledTimes(1)
    dispose()
  })
})

describe('system notification display', () => {
  it('shows native notifications only in a supported background window', () => {
    expect(shouldShowSystemNotification(true, false)).toBe(true)
    expect(shouldShowSystemNotification(true, true)).toBe(false)
    expect(shouldShowSystemNotification(false, false)).toBe(false)
  })
})
