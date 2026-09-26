import type { RemoteSessionSnapshot, RemoteTargetSnapshot } from '@agent-workspace/protocol-client'
import { Button } from '../ui/button'
import { messages } from '../messages'

function sessionGuidance(state: RemoteSessionSnapshot['state'], trusted: boolean): string | null {
  if (state === 'trustRequired') {
    return trusted
      ? 'Host key trusted. Reconnect to start the SSH session.'
      : 'Scan and trust the host key, then reconnect.'
  }
  if (state === 'credentialRequired') return 'Reconnect to start the SSH session.'
  if (state === 'failed') return 'This attempt failed. Close it, then connect again.'
  if (state === 'detached' && !trusted) {
    return 'Host key trust changed. Close this session and connect again to review it.'
  }
  return null
}

export function RemoteSessionActions({
  busy,
  onDiscovery,
  run,
  session,
  hostKeyState
}: {
  busy: boolean
  onDiscovery: (message: string) => void
  run: (key: string, operation: () => Promise<void>) => Promise<void>
  session: RemoteSessionSnapshot
  hostKeyState: RemoteTargetSnapshot['hostKeyState']
}): React.JSX.Element {
  const action = { remoteSessionId: session.remoteSessionId, expectedRevision: session.revision }
  const trusted = hostKeyState === 'trusted'
  const canDiscover = trusted && (session.state === 'connected' || session.state === 'detached')
  const canReconnect = trusted &&
    (session.state === 'trustRequired' ||
      session.state === 'credentialRequired' ||
      session.state === 'detached')
  const canDetach = session.state === 'connected' || session.state === 'reconnecting'
  const guidance = sessionGuidance(session.state, trusted)
  return (
    <div aria-label={`Session ${session.state}`} role="group">
      <span aria-live="polite" role="status">
        {messages.remoteSessions.sessionState(session.state, session.observation)}
      </span>
      {guidance ? <p>{guidance}</p> : null}
      {session.state === 'trustRequired' && !trusted ? (
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
        disabled={busy || !canDiscover}
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
      {(session.state === 'trustRequired' || session.state === 'credentialRequired' ||
        session.state === 'detached') ? (
          <Button
            disabled={busy || !canReconnect}
            size="small"
            onClick={() =>
              void run('reconnect', async () => {
                await window.desktopBridge.reconnectRemoteSession!(action)
              })
            }
          >
            {messages.remoteSessions.reconnect}
          </Button>
        ) : null}
      {canDetach ? (
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
      ) : null}
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
