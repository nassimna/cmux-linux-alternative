import { messages } from '../messages'

export interface NotificationCenterCloseFailure {
  message: string
  ok: false
}

interface NotificationNavigationFailure {
  message: string
  ok: false
}

interface WaitForNotificationCenterCloseOptions {
  attempts?: number
  nextFrame?: () => Promise<void>
  root?: ParentNode
}

const NOTIFICATION_CENTER_SELECTOR = '[data-notification-center="true"]'

export async function waitForNotificationCenterClose({
  attempts = 24,
  nextFrame = animationFrame,
  root = document
}: WaitForNotificationCenterCloseOptions = {}): Promise<
  { ok: true } | NotificationCenterCloseFailure
> {
  if (!root.querySelector(NOTIFICATION_CENTER_SELECTOR)) return { ok: true }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await nextFrame()
    if (!root.querySelector(NOTIFICATION_CENTER_SELECTOR)) return { ok: true }
  }

  return {
    ok: false,
    message: messages.notificationJump.centerCloseFailed
  }
}

export async function runAfterNotificationCenterClose<
  T extends { ok: true } | NotificationNavigationFailure
>(
  operation: () => Promise<T>,
  onFailure: (failure: NotificationNavigationFailure) => void,
  waitForClose: () => Promise<
    { ok: true } | NotificationCenterCloseFailure
  > = waitForNotificationCenterClose
): Promise<T | NotificationCenterCloseFailure> {
  const closeResult = await waitForClose()
  if (!closeResult.ok) {
    onFailure(closeResult)
    return closeResult
  }

  const result = await operation()
  if (!result.ok) onFailure(result)
  return result
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}
