import { Check, CornerDownRight, Inbox, Trash2, Undo2 } from 'lucide-react'
import { useState } from 'react'

import type { ApplicationSnapshot, NotificationSnapshot } from '@agent-workspace/protocol-client'
import { displayTabTitle } from '@agent-workspace/contracts/desktop/browser-messages'

import { messages } from '../messages'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

interface NotificationCenterProps {
  error: string | null
  historyLoading: boolean
  notifications: readonly NotificationSnapshot[]
  onClearAll: () => Promise<void>
  onClearNotification: (notificationId: string) => Promise<void>
  onClearRead: () => Promise<void>
  onError: (error: unknown) => void
  onJump: (notification: NotificationSnapshot) => Promise<void>
  onLoadMore: () => Promise<void>
  onMarkRead: (notificationId: string) => Promise<void>
  onMarkUnread: (notificationId: string) => Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
  preserveTargetFocusOnClose: boolean
  snapshot: ApplicationSnapshot | null
  total: number
  unreadCount: number
}

interface NotificationGroup {
  key: string
  label: string
  notifications: NotificationSnapshot[]
}

export function NotificationCenter({
  error,
  historyLoading,
  notifications,
  onClearAll,
  onClearNotification,
  onClearRead,
  onError,
  onJump,
  onLoadMore,
  onMarkRead,
  onMarkUnread,
  onOpenChange,
  open,
  preserveTargetFocusOnClose,
  snapshot,
  total,
  unreadCount
}: NotificationCenterProps): React.JSX.Element {
  const [pending, setPending] = useState<string | null>(null)
  const groups = groupNotifications(notifications)
  const read = total - unreadCount
  const remaining = Math.max(0, total - notifications.length)

  const run = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setPending(key)
    try {
      await operation()
    } catch (error) {
      onError(error)
    } finally {
      setPending(null)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="notification-center"
        data-notification-center="true"
        onCloseAutoFocus={(event) => {
          if (preserveTargetFocusOnClose) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{messages.notifications.title}</DialogTitle>
          <DialogDescription>{messages.notifications.unreadSummary(unreadCount)}</DialogDescription>
        </DialogHeader>
        <div className="notification-center-toolbar">
          <Button
            disabled={pending !== null || read === 0}
            onClick={() => void run('read', onClearRead)}
            size="small"
            variant="ghost"
          >
            <Trash2 size={13} /> {messages.notifications.clearRead}
          </Button>
          <Button
            disabled={pending !== null || total === 0}
            onClick={() => void run('all', onClearAll)}
            size="small"
            variant="ghost"
          >
            {messages.notifications.clearAll}
          </Button>
        </div>
        {error ? (
          <p className="notification-navigation-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="notification-groups" aria-label={messages.notifications.history}>
          {groups.length === 0 ? (
            <div className="notification-empty">
              <Inbox aria-hidden="true" size={24} />
              <strong>{messages.notifications.emptyTitle}</strong>
              <span>{messages.notifications.emptyBody}</span>
            </div>
          ) : (
            groups.map((group) => (
              <section className="notification-group" key={group.key}>
                <h3>{group.label}</h3>
                <div className="notification-list">
                  {group.notifications.map((notification) => {
                    const isUnread = notification.readAt === undefined
                    const target = targetLabel(notification, snapshot)
                    const itemPending = pending?.endsWith(notification.id) ?? false
                    return (
                      <article
                        className={`notification-item severity-${notification.level}${isUnread ? ' unread' : ''}`}
                        data-notification-id={notification.id}
                        key={notification.id}
                      >
                        <div className="notification-item-copy">
                          <div className="notification-item-heading">
                            <span className="notification-severity">
                              <span aria-hidden="true">!</span> {notification.level}
                            </span>
                            <time dateTime={new Date(notification.createdAt).toISOString()}>
                              {formatTime(notification.createdAt)}
                            </time>
                          </div>
                          <strong>{notification.title}</strong>
                          {notification.body ? <p>{notification.body}</p> : null}
                          <small>
                            {messages.notifications.sourceAndTarget(
                              notification.source,
                              target.label
                            )}
                          </small>
                        </div>
                        <div className="notification-item-actions">
                          <Button
                            disabled={pending !== null || !target.available}
                            onClick={() =>
                              void run(`jump:${notification.id}`, () => onJump(notification))
                            }
                            size="small"
                            title={
                              target.available
                                ? messages.notifications.openTarget
                                : messages.notifications.targetNoLongerAvailable
                            }
                          >
                            <CornerDownRight size={13} /> {messages.notifications.jump}
                          </Button>
                          <Button
                            aria-label={
                              isUnread
                                ? messages.notifications.markRead
                                : messages.notifications.markUnread
                            }
                            disabled={pending !== null}
                            onClick={() =>
                              void run(
                                `read:${notification.id}`,
                                isUnread
                                  ? () => onMarkRead(notification.id)
                                  : () => onMarkUnread(notification.id)
                              )
                            }
                            size="icon"
                            variant="ghost"
                          >
                            {isUnread ? <Check size={13} /> : <Undo2 size={13} />}
                          </Button>
                          <Button
                            aria-label={messages.notifications.clearNotification}
                            disabled={pending !== null || itemPending}
                            onClick={() =>
                              void run(`clear:${notification.id}`, () =>
                                onClearNotification(notification.id)
                              )
                            }
                            size="icon"
                            variant="ghost"
                          >
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>
            ))
          )}
          {remaining > 0 ? (
            <div className="notification-history-footer">
              <span>{messages.notifications.showingCount(notifications.length, total)}</span>
              <Button
                disabled={pending !== null || historyLoading}
                onClick={() => void run('more', onLoadMore)}
                size="small"
                variant="ghost"
              >
                {historyLoading
                  ? messages.notifications.loading
                  : messages.notifications.loadMore(Math.min(200, remaining))}
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function groupNotifications(
  notifications: readonly NotificationSnapshot[],
  now = Date.now()
): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>()
  const ordered = [...notifications].sort((left, right) => {
    const status = Number(left.readAt !== undefined) - Number(right.readAt !== undefined)
    return status === 0 ? right.createdAt - left.createdAt : status
  })
  for (const notification of ordered) {
    const status = notification.readAt === undefined ? 'unread' : 'read'
    const day = relativeDay(notification.createdAt, now)
    const key = `${status}:${day}`
    const group = groups.get(key) ?? {
      key,
      label: messages.notifications.groupLabel(status, day),
      notifications: []
    }
    group.notifications.push(notification)
    groups.set(key, group)
  }
  return [...groups.values()]
}

export function targetLabel(
  notification: NotificationSnapshot,
  snapshot: ApplicationSnapshot | null
): { available: boolean; label: string } {
  const workspace = snapshot?.workspaces.find(({ id }) => id === notification.workspaceId)
  if (!workspace) return { available: false, label: messages.notifications.targetUnavailable }
  if (notification.tabId) {
    const tab = workspace.tabs.find(({ id }) => id === notification.tabId)
    if (!tab) return { available: false, label: messages.notifications.targetUnavailable }
    return {
      available: true,
      label: messages.notifications.workspaceTabTarget(workspace.name, displayTabTitle(tab))
    }
  }
  if (notification.paneId && !workspace.panes.some(({ id }) => id === notification.paneId)) {
    return { available: false, label: messages.notifications.targetUnavailable }
  }
  return { available: true, label: workspace.name }
}

function relativeDay(timestamp: number, now: number): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  if (day === start) return messages.notifications.relativeDay.today
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === yesterday.getTime()) return messages.notifications.relativeDay.yesterday
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(timestamp)
  )
}
