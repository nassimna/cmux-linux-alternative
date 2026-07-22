import { BrowserHost } from './BrowserHost'
import { BrowserToolbar } from './BrowserToolbar'
import { browserBridge, type BrowserSessionState } from './types'
import { useState } from 'react'
import { browserMessages, type BrowserMessages } from '../../../shared/browser-messages'
import type { MutationResult } from '@agent-workspace/protocol-client'

export function BrowserPane({
  messages = browserMessages,
  onError,
  onMutation,
  state,
  tabId,
  visible,
  workspaceId
}: {
  messages?: BrowserMessages
  onError: (error: unknown) => void
  onMutation: (operation: Promise<MutationResult>) => Promise<boolean>
  state: BrowserSessionState
  tabId: string
  visible: boolean
  workspaceId: string
}): React.JSX.Element {
  const bridge = browserBridge(window.desktopBridge)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <section className="browser-pane" aria-label={messages.pane.label(state.navigationTitle)}>
      <BrowserToolbar
        bridge={bridge}
        messages={messages}
        onError={onError}
        onMenuOpenChange={setMenuOpen}
        onMutation={onMutation}
        state={state}
      />
      <BrowserHost
        bridge={bridge}
        browserSessionId={state.browserSessionId}
        messages={messages}
        tabId={tabId}
        visible={visible && !menuOpen}
        workspaceId={workspaceId}
      />
      <div className="browser-status" aria-live="polite">
        <span>{messages.pane.status(state.loading)}</span>
        <span title={messages.pane.profilePartitionLabel(state.profilePartition)}>
          {state.profilePartition}
        </span>
      </div>
    </section>
  )
}
