import { useEffect, useState, type FormEvent } from 'react'

import type { RemoteSessionSnapshot, RemoteTargetSnapshot } from '@agent-workspace/protocol-client'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { messages } from '../messages'
import { RemoteSessionActions } from './RemoteSessionActions'

export interface RemoteWorkspaceContext {
  workspaceId: string
  paneId: string
  tabId: string
}

function formText(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : ''
}

export function RemoteSessionsSettings({
  context,
  open,
  manageTargets = true,
  allowEnrollment = false,
  allowReplacement = false,
  allowDeletion = false
}: {
  context: RemoteWorkspaceContext | null
  open: boolean
  manageTargets?: boolean
  allowEnrollment?: boolean
  allowReplacement?: boolean
  allowDeletion?: boolean
}): React.JSX.Element {
  const [targets, setTargets] = useState<readonly RemoteTargetSnapshot[]>([])
  const [sessions, setSessions] = useState<readonly RemoteSessionSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [tmuxName, setTmuxName] = useState('main')

  const loadRemote = () =>
    Promise.all([
      window.desktopBridge.listRemoteTargets!(),
      window.desktopBridge.listRemoteSessions!()
    ])

  const refresh = async (): Promise<void> => {
    const [targetResult, sessionResult] = await loadRemote()
    setTargets(targetResult.targets)
    setSessions(sessionResult.sessions)
  }

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    void loadRemote()
      .then(([targetResult, sessionResult]) => {
        if (!active) return
        setTargets(targetResult.targets)
        setSessions(sessionResult.sessions)
        setLoading(false)
      })
      .catch(() => {
        if (active) {
          setStatus(messages.remoteSessions.loadFailed)
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (!open || busy !== null) return
    let active = true
    let pending = false
    const timer = window.setInterval(() => {
      if (pending) return
      pending = true
      void loadRemote()
        .then(([targetResult, sessionResult]) => {
          if (!active) return
          setTargets(targetResult.targets)
          setSessions(sessionResult.sessions)
          setStatus((current) => (current === messages.remoteSessions.loadFailed ? '' : current))
        })
        .catch(() => {
          if (active) setStatus(messages.remoteSessions.loadFailed)
        })
        .finally(() => {
          pending = false
        })
    }, 2_500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [open, busy])

  const run = async (key: string, operation: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(key)
    setStatus('')
    try {
      await operation()
      await refresh()
    } catch (error) {
      setStatus(
        error instanceof Error && error.message
          ? error.message
          : messages.remoteSessions.operationFailed
      )
    } finally {
      setBusy(null)
    }
  }

  const enroll = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void run('enroll', async () => {
      const result = await window.desktopBridge.enrollRemoteTarget!({
        label: formText(form.get('label')).trim(),
        host: formText(form.get('host')).trim().toLowerCase(),
        port: Number(form.get('port')),
        user: formText(form.get('user')).trim()
      })
      setStatus(
        result ? messages.remoteSessions.added : messages.remoteSessions.keySelectionCanceled
      )
    })
  }

  const sessionsForTarget = (targetId: string): readonly RemoteSessionSnapshot[] =>
    sessions.filter((session) => session.remoteTargetId === targetId && session.state !== 'closed')

  return (
    <section aria-labelledby="remote-sessions-heading" className="configuration-settings">
      <div className="settings-content-heading">
        <h2 id="remote-sessions-heading">{messages.remoteSessions.title}</h2>
        <p>{messages.remoteSessions.description}</p>
      </div>
      {status ? <p role="status">{status}</p> : null}
      {!manageTargets && !allowEnrollment && !allowReplacement && !allowDeletion ? (
        <p role="status">{messages.remoteSessions.targetManagementUnavailable}</p>
      ) : null}
      {manageTargets || allowEnrollment ? (
        <form onSubmit={enroll}>
          <fieldset disabled={busy !== null}>
            <legend>{messages.remoteSessions.addLegend}</legend>
            <label>
              {messages.remoteSessions.label}
              <Input name="label" required maxLength={128} />
            </label>
            <label>
              {messages.remoteSessions.host}
              <Input name="host" required maxLength={253} spellCheck={false} />
            </label>
            <label>
              {messages.remoteSessions.port}
              <Input name="port" required min={1} max={65535} type="number" defaultValue={22} />
            </label>
            <label>
              {messages.remoteSessions.user}
              <Input name="user" required maxLength={64} autoComplete="username" />
            </label>
            <Button type="submit" variant="primary">
              {messages.remoteSessions.add}
            </Button>
          </fieldset>
        </form>
      ) : null}
      <ul aria-label={messages.remoteSessions.targets}>
        {targets.map((target) => {
          const targetSessions = sessionsForTarget(target.remoteTargetId)
          return (
            <li key={target.remoteTargetId}>
              <strong>{target.label}</strong>{' '}
              <span>
                {target.user}@{target.host}:{target.port}
              </span>
              <small> {messages.remoteSessions.hostKeyState(target.hostKeyState)}</small>
              <div>
                {manageTargets || allowReplacement ? (
                  <Button
                    disabled={busy !== null}
                    size="small"
                    onClick={() =>
                      void run(`replace-${target.remoteTargetId}`, async () => {
                        const replaced = await window.desktopBridge.replaceRemoteCredential!(
                          target.remoteTargetId
                        )
                        setStatus(
                          replaced
                            ? messages.remoteSessions.credentialReplaced
                            : messages.remoteSessions.keySelectionCanceled
                        )
                      })
                    }
                  >
                    {messages.remoteSessions.replaceCredential}
                  </Button>
                ) : null}
                {manageTargets || allowDeletion ? (
                  <Button
                    disabled={busy !== null}
                    size="small"
                    variant="destructive"
                    onClick={() =>
                      void run(`delete-${target.remoteTargetId}`, async () => {
                        const deleted = await window.desktopBridge.deleteRemoteTarget!({
                          remoteTargetId: target.remoteTargetId,
                          expectedRevision: target.revision
                        })
                        setStatus(
                          deleted
                            ? messages.remoteSessions.deleted
                            : messages.remoteSessions.deleteCanceled
                        )
                      })
                    }
                  >
                    {messages.remoteSessions.delete}
                  </Button>
                ) : null}
                {targetSessions.length === 0 && context ? (
                  <Button
                    disabled={busy !== null}
                    size="small"
                    onClick={() =>
                      void run(`connect-${target.remoteTargetId}`, async () => {
                        await window.desktopBridge.connectRemoteSession!({
                          remoteTargetId: target.remoteTargetId,
                          ...context,
                          tmux: { mode: 'create', sessionName: tmuxName },
                          reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 }
                        })
                      })
                    }
                  >
                    {messages.remoteSessions.connect}
                  </Button>
                ) : null}
              </div>
              {targetSessions.map((session) => (
                <RemoteSessionActions
                  key={session.remoteSessionId}
                  session={session}
                  hostKeyState={target.hostKeyState}
                  busy={busy !== null}
                  run={run}
                  onDiscovery={setStatus}
                />
              ))}
            </li>
          )
        })}
      </ul>
      {loading ? <p role="status">{messages.remoteSessions.loading}</p> : null}
      {!loading && targets.length === 0 ? <p>{messages.remoteSessions.noTargets}</p> : null}
      {targets.length > 0 ? (
        <label>
          {messages.remoteSessions.tmuxName}
          <Input
            value={tmuxName}
            pattern={'[A-Za-z0-9_.\\-]+'}
            maxLength={64}
            onChange={(event) => setTmuxName(event.currentTarget.value)}
          />
        </label>
      ) : null}
    </section>
  )
}
