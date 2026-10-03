// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { NotificationSnapshot } from '@agent-workspace/protocol-client'

import { NotificationCenter } from './NotificationCenter'

function notification(index: number): NotificationSnapshot {
  return {
    id: `notification-${String(index)}`,
    workspaceId: 'workspace-a',
    source: 'cli',
    level: 'info',
    title: `Notification ${String(index)}`,
    createdAt: 1_000 - index
  }
}

describe('notification center pagination', () => {
  it('surfaces retained history beyond 200 records and loads the next page', async () => {
    const onLoadMore = vi.fn().mockResolvedValue(undefined)
    const noop = vi.fn().mockResolvedValue(undefined)
    render(
      <NotificationCenter
        error={null}
        historyLoading={false}
        notifications={Array.from({ length: 200 }, (_, index) => notification(index))}
        onClearAll={noop}
        onClearNotification={noop}
        onClearRead={noop}
        onError={vi.fn()}
        onJump={noop}
        onLoadMore={onLoadMore}
        onMarkRead={noop}
        onMarkUnread={noop}
        onOpenChange={vi.fn()}
        open
        preserveTargetFocusOnClose={false}
        snapshot={null}
        total={250}
        unreadCount={250}
      />
    )

    expect(screen.getByText('250 unread notifications.')).toBeTruthy()
    expect(screen.getByText('Showing 200 of 250 notifications.')).toBeTruthy()
    expect(screen.getAllByText('cli · Target unavailable')).toHaveLength(200)
    fireEvent.click(screen.getByRole('button', { name: 'Load 50 more' }))
    await waitFor(() => expect(onLoadMore).toHaveBeenCalledOnce())
  })

  it('reports a rejected item mutation and releases pending state for retry', async () => {
    const error = new Error('mark read failed')
    const onError = vi.fn()
    const onMarkRead = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const noop = vi.fn().mockResolvedValue(undefined)
    render(
      <NotificationCenter
        error={null}
        historyLoading={false}
        notifications={[notification(1)]}
        onClearAll={noop}
        onClearNotification={noop}
        onClearRead={noop}
        onError={onError}
        onJump={noop}
        onLoadMore={noop}
        onMarkRead={onMarkRead}
        onMarkUnread={noop}
        onOpenChange={vi.fn()}
        open
        preserveTargetFocusOnClose={false}
        snapshot={null}
        total={1}
        unreadCount={1}
      />
    )

    expect(screen.getByText('1 unread notification.')).toBeTruthy()
    const markRead = screen.getByRole('button', { name: 'Mark notification read' })
    fireEvent.click(markRead)

    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(error))
    await waitFor(() => expect((markRead as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(markRead)
    await waitFor(() => expect(onMarkRead).toHaveBeenCalledTimes(2))
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected load-more action and releases pending state for retry', async () => {
    const error = new Error('load more failed')
    const onError = vi.fn()
    const onLoadMore = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const noop = vi.fn().mockResolvedValue(undefined)
    render(
      <NotificationCenter
        error={null}
        historyLoading={false}
        notifications={[notification(1)]}
        onClearAll={noop}
        onClearNotification={noop}
        onClearRead={noop}
        onError={onError}
        onJump={noop}
        onLoadMore={onLoadMore}
        onMarkRead={noop}
        onMarkUnread={noop}
        onOpenChange={vi.fn()}
        open
        preserveTargetFocusOnClose={false}
        snapshot={null}
        total={2}
        unreadCount={2}
      />
    )

    const loadMore = screen.getByRole('button', { name: 'Load 1 more' })
    fireEvent.click(loadMore)

    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(error))
    await waitFor(() => expect((loadMore as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(loadMore)
    await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(2))
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
