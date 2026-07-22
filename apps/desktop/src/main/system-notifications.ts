import type { DomainEventMessage, NotificationSettings } from '@agent-workspace/protocol-client'

import type { ControlClient } from './control-client'

export interface SystemNotificationPayload {
  body?: string
  title: string
}

interface SystemNotificationInput {
  body?: string | undefined
  title: string
}

export function systemNotificationPayload(
  notification: SystemNotificationInput,
  settings: NotificationSettings
): SystemNotificationPayload | null {
  if (!settings.systemEnabled) return null
  return {
    title: notification.title,
    ...(settings.includeBody && notification.body ? { body: notification.body } : {})
  }
}

export function shouldShowSystemNotification(
  notificationSupported: boolean,
  windowFocused: boolean
): boolean {
  return notificationSupported && !windowFocused
}

export async function forwardSystemNotifications(
  client: ControlClient,
  show: (payload: SystemNotificationPayload) => void
): Promise<() => void> {
  let settingsRequest: Promise<NotificationSettings | null> = Promise.resolve(
    (await client.getSettings()).notifications
  )
  let disposed = false
  const remove = client.onDomainEvent((event: DomainEventMessage) => {
    if (event.event === 'settings.changed') {
      settingsRequest = settingsRequest.then(() =>
        client
          .getSettings()
          .then((result) => result.notifications)
          .catch(() => null)
      )
      return
    }
    if (event.event !== 'notification.created') return
    void settingsRequest.then((settings) => {
      if (disposed || !settings) return
      const payload = systemNotificationPayload(event.data.notification, settings)
      if (payload) show(payload)
    })
  })
  return () => {
    disposed = true
    remove()
  }
}
