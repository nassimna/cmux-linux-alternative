import type { RemoteSessionSnapshot } from '@agent-workspace/protocol-client'
import { Button } from '../ui/button'
import { messages } from '../messages'

export function RemoteSessionActions({
  busy,
  onDiscovery,
  run,
  session
}: {
  busy: boolean
  onDiscovery: (message: string) => void
  run: (key: string, operation: () => Promise<void>) => Promise<void>
  session: RemoteSessionSnapshot
}): React.JSX.Element {
  const action = { remoteSessionId: session.remoteSessionId, expectedRevision: session.revision }
  return (
    <div aria-label={`Session ${session.state}`} role="group">
      <span aria-live="polite" role="status">
        {messages.remoteSessions.sessionState(session.state, session.observation)}
      </span>
      {session.state === 'trustRequired' ? (
        <Button
          disabled={busy}
          size="small"
          onClick={() =>
            void run(`trust-${session.remoteSessionId}`, async () => {
              await window.desktopBridge.confirmRemoteHostKey!(action)
            })
          }
        >
          {messages.remoteSessions.scanHostKey}
        </Button>
      ) : null}
      <Button
        disabled={busy}
        size="small"
        onClick={() =>
          void run('tmux', async () => {
            const result = await window.desktopBridge.discoverRemoteTmux!(action)
            onDiscovery(
              result.sessions.length
                ? messages.remoteSessions.tmuxAvailable(result.sessions)
                : messages.remoteSessions.noTmux
            )
          })
        }
      >
        {messages.remoteSessions.discoverTmux}
      </Button>
      <Button
        disabled={busy}
        size="small"
        onClick={() =>
          void run('reconnect', async () => {
            await window.desktopBridge.reconnectRemoteSession!(action)
          })
        }
      >
        {messages.remoteSessions.reconnect}
      </Button>
      <Button
        disabled={busy}
        size="small"
        onClick={() =>
          void run('detach', async () => {
            await window.desktopBridge.detachRemoteSession!(action)
          })
        }
      >
        {messages.remoteSessions.detach}
      </Button>
      <Button
        disabled={busy}
        size="small"
        variant="destructive"
        onClick={() =>
          void run('close', async () => {
            const closed = await window.desktopBridge.closeRemoteSession!(action)
            if (!closed) onDiscovery(messages.remoteSessions.closeCanceled)
          })
        }
      >
        {messages.remoteSessions.close}
      </Button>
    </div>
  )
}
