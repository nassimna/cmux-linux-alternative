import { useEffect, useRef } from 'react'
import { Toaster, toast } from 'sonner'

import type { NotificationSnapshot } from '@agent-workspace/protocol-client'

const MAX_REMEMBERED_TOASTS = 100
export const MAX_VISIBLE_TOASTS = 3

export function NotificationToasts({
  notifications
}: {
  notifications: readonly NotificationSnapshot[]
}): React.JSX.Element {
  const shown = useRef(new Set<string>())

  useEffect(() => {
    for (const notification of [...notifications].reverse()) {
      if (shown.current.has(notification.id)) continue
      shown.current.add(notification.id)
      toast(notification.title, {
        id: notification.id,
        description: notification.body,
        duration: 5_000
      })
    }
    if (shown.current.size > MAX_REMEMBERED_TOASTS) {
      shown.current = new Set([...shown.current].slice(-MAX_REMEMBERED_TOASTS))
    }
  }, [notifications])

  return (
    <Toaster
      closeButton
      expand={false}
      position="bottom-right"
      richColors
      visibleToasts={MAX_VISIBLE_TOASTS}
    />
  )
}
