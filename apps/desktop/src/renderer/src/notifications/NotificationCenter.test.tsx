import { describe, expect, it } from 'vitest'

import type { ApplicationSnapshot, NotificationSnapshot } from '@agent-workspace/protocol-client'

import { groupNotifications, targetLabel } from './NotificationCenter'
import { MAX_VISIBLE_TOASTS } from './NotificationToasts'

function item(id: string, createdAt: number, readAt?: number): NotificationSnapshot {
  return {
    id,
    workspaceId: 'workspace-a',
    source: 'cli',
    level: 'info',
    title: id,
    createdAt,
    ...(readAt === undefined ? {} : { readAt })
  }
}

describe('notification presentation', () => {
  it('groups by unread status and relative day', () => {
    const now = new Date(2026, 6, 16, 12).getTime()
    const yesterday = now - 86_400_000
    expect(
      groupNotifications(
        [item('unread', now), item('read', now, now), item('old', yesterday)],
        now
      ).map(({ label, notifications }) => [label, notifications.map(({ id }) => id)])
    ).toEqual([
      ['Unread · Today', ['unread']],
      ['Unread · Yesterday', ['old']],
      ['Read · Today', ['read']]
    ])
  })

  it('caps the visible toast viewport', () => {
    expect(MAX_VISIBLE_TOASTS).toBe(3)
  })

  it('localizes an uncustomized browser tab in notification target labels', () => {
    const notification = { ...item('browser-target', 1), tabId: 'tab-a' }
    const snapshot = {
      workspaces: [
        {
          id: 'workspace-a',
          name: 'Workspace',
          tabs: [
            {
              id: 'tab-a',
              title: 'Backend-owned English title',
              customTitle: null,
              content: { kind: 'browser' }
            }
          ]
        }
      ]
    } as ApplicationSnapshot

    expect(targetLabel(notification, snapshot)).toEqual({
      available: true,
      label: 'Workspace / Browser'
    })
  })
})
