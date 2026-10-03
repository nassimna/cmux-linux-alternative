import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  ConfigurationSnapshot,
  DiagnosticBundlePreview
} from '@agent-workspace/protocol-client'
import type { DesktopLifecycleState } from '@agent-workspace/contracts/desktop/desktop-bridge'

import { useConfigurationStore } from './configuration-store'
import { formatBytes, messages, recoveryAttempt } from './messages'
import { Button } from './ui/button'
import { WorkspaceShell } from './workspace/WorkspaceShell'
import { useProjectionStore } from './workspace/projection-store'

type LifecycleAction = 'restart' | 'database' | 'preview' | 'diagnostics' | 'quit'

export function App(): React.JSX.Element {
  const projection = useProjectionStore()
  const configuration = useConfigurationStore()
  const [lifecycle, setLifecycle] = useState<DesktopLifecycleState>({ status: 'starting' })
  const [pendingAction, setPendingAction] = useState<LifecycleAction | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [diagnosticPreview, setDiagnosticPreview] = useState<DiagnosticBundlePreview | null>(null)
  const lifecycleGeneration = useRef(0)
  const actionPending = useRef(false)

  useApplyAppearanceConfiguration(configuration.config?.appearance)

  useEffect(() => {
    const bridge = window.desktopBridge
    if (!bridge.getLifecycleState) {
      queueMicrotask(() => setLifecycle({ status: 'ready' }))
      return
    }
    const generation = ++lifecycleGeneration.current
    let requestVersion = 0
    const applyState = (state: DesktopLifecycleState): void => {
      if (generation !== lifecycleGeneration.current) return
      requestVersion += 1
      setLifecycle(state)
      setActionMessage(null)
      if (
        (state.status !== 'recoveryRequired' && state.status !== 'failed') ||
        (state.status === 'failed' && state.availableActions?.diagnostics === false)
      ) {
        setDiagnosticPreview(null)
      }
    }
    const remove = bridge.onLifecycleState?.(applyState)
    const initialRequest = requestVersion
    void bridge
      .getLifecycleState()
      .then((state) => {
        if (generation === lifecycleGeneration.current && requestVersion === initialRequest) {
          setLifecycle(state)
        }
      })
      .catch(() => {
        if (generation === lifecycleGeneration.current && requestVersion === initialRequest) {
          setLifecycle({ status: 'failed', message: messages.lifecycle.actionFailed })
        }
      })
    return () => {
      lifecycleGeneration.current += 1
      remove?.()
    }
  }, [])

  useEffect(() => {
    if (lifecycle.status !== 'ready') return
    void useProjectionStore.getState().initialize(window.desktopBridge)
    void useConfigurationStore.getState().initialize(window.desktopBridge)
  }, [lifecycle.status])

  useEffect(() => {
    if (lifecycle.status !== 'ready') return
    return window.desktopBridge.onDesktopBindingRebind?.(() => {
      // Both paths increment their store generation synchronously before the first
      // await, fencing every request started under the replaced client.
      void useProjectionStore.getState().initialize(window.desktopBridge)
      void useConfigurationStore.getState().reinitialize(window.desktopBridge)
    })
  }, [lifecycle.status])

  const runAction = useCallback(
    async (action: LifecycleAction, operation: () => Promise<string | null>): Promise<void> => {
      if (actionPending.current) return
      actionPending.current = true
      const focusTarget =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setPendingAction(action)
      setActionMessage(null)
      try {
        setActionMessage(await operation())
      } catch {
        setActionMessage(messages.lifecycle.actionFailed)
      } finally {
        actionPending.current = false
        setPendingAction(null)
        queueMicrotask(() => focusTarget?.focus())
      }
    },
    []
  )

  const restart = (): void => {
    if (!window.desktopBridge.restartService) return
    void runAction('restart', async () => {
      setLifecycle({ status: 'starting' })
      await window.desktopBridge.restartService?.()
      return null
    })
  }
  const previewDiagnostics = (): void => {
    if (!window.desktopBridge.previewDiagnostics) return
    void runAction('preview', async () => {
      const preview = await window.desktopBridge.previewDiagnostics!()
      setDiagnosticPreview(preview)
      return null
    })
  }
  const exportDiagnostics = (): void => {
    if (!window.desktopBridge.exportDiagnostics || !diagnosticPreview) return
    void runAction('diagnostics', async () => {
      const result = await window.desktopBridge.exportDiagnostics!(diagnosticPreview)
      return result === null
        ? messages.lifecycle.diagnosticsExportCancelled
        : messages.lifecycle.diagnosticsExported
    })
  }
  const exportDatabase = (): void => {
    if (!window.desktopBridge.exportRecoveryDatabase) return
    void runAction('database', async () => {
      const result = await window.desktopBridge.exportRecoveryDatabase!()
      return result === null
        ? messages.lifecycle.databaseExportCancelled
        : lifecycle.status === 'failed'
          ? messages.lifecycle.recoveryFilesExported
          : messages.lifecycle.databaseExported
    })
  }
  const quit = (): void => {
    if (!window.desktopBridge.quitApplication) return
    void runAction('quit', async () => {
      await window.desktopBridge.quitApplication?.()
      return null
    })
  }

  if (lifecycle.status === 'starting') {
    return <LifecycleLoading label={messages.lifecycle.starting} />
  }
  if (lifecycle.status === 'recovering') {
    return (
      <main className="lifecycle-shell" aria-live="polite">
        <span className="mark" aria-hidden="true" />
        <h1>{messages.lifecycle.recoveringTitle}</h1>
        <p>{messages.lifecycle.recoveringBody}</p>
        <strong>{recoveryAttempt(lifecycle.attempt, lifecycle.maxAttempts)}</strong>
        <p className="lifecycle-detail">{lifecycle.message}</p>
      </main>
    )
  }
  if (lifecycle.status === 'recoveryRequired' || lifecycle.status === 'failed') {
    const isRecovery = lifecycle.status === 'recoveryRequired'
    const failedActions = lifecycle.status === 'failed' ? lifecycle.availableActions : undefined
    const canExportDatabase = isRecovery || failedActions?.recoveryExport === true
    const canPreviewDiagnostics = isRecovery || failedActions?.diagnostics !== false
    return (
      <main className="lifecycle-shell lifecycle-recovery">
        <span className="mark" aria-hidden="true" />
        <h1>
          {isRecovery ? messages.lifecycle.recoveryRequiredTitle : messages.lifecycle.failedTitle}
        </h1>
        {isRecovery ? (
          <>
            <p className="lifecycle-category">
              {messages.lifecycle.recoveryCategories[lifecycle.recovery.category]}
            </p>
            <p>{lifecycle.recovery.message}</p>
            <p>
              {lifecycle.recovery.migrationBackupAvailable
                ? messages.lifecycle.backupAvailable
                : messages.lifecycle.backupUnavailable}
            </p>
          </>
        ) : (
          <>
            <p>{lifecycle.message}</p>
            {canExportDatabase ? <p>{messages.lifecycle.recoveryFilesDescription}</p> : null}
          </>
        )}
        <div className="lifecycle-actions">
          <Button disabled={pendingAction !== null} onClick={restart} variant="primary">
            {messages.lifecycle.retry}
          </Button>
          {canExportDatabase ? (
            <Button disabled={pendingAction !== null} onClick={exportDatabase}>
              {isRecovery
                ? messages.lifecycle.exportDatabase
                : messages.lifecycle.exportRecoveryFiles}
            </Button>
          ) : null}
          {canPreviewDiagnostics ? (
            <>
              <Button disabled={pendingAction !== null} onClick={previewDiagnostics}>
                {messages.lifecycle.previewDiagnostics}
              </Button>
              <Button
                disabled={pendingAction !== null || diagnosticPreview === null}
                onClick={exportDiagnostics}
              >
                {messages.lifecycle.exportDiagnostics}
              </Button>
            </>
          ) : null}
          <Button disabled={pendingAction !== null} onClick={quit} variant="ghost">
            {messages.lifecycle.quit}
          </Button>
        </div>
        {actionMessage ? <p role="status">{actionMessage}</p> : null}
        {canPreviewDiagnostics && diagnosticPreview ? (
          <DiagnosticPreview preview={diagnosticPreview} />
        ) : null}
      </main>
    )
  }

  if (
    projection.status !== 'ready' ||
    configuration.status === 'idle' ||
    configuration.status === 'loading'
  ) {
    return projection.status === 'error' ? (
      <main className="startup-shell" aria-live="polite">
        <div className="startup-error">
          <h1>{messages.lifecycle.failedTitle}</h1>
          <p>{projection.error ?? messages.lifecycle.actionFailed}</p>
        </div>
      </main>
    ) : (
      <LifecycleLoading label={messages.lifecycle.starting} />
    )
  }

  const workspace =
    projection.snapshot?.workspaces.find(
      ({ id }) => id === projection.snapshot?.selectedWorkspaceId
    ) ?? null
  return <WorkspaceShell workspace={workspace} />
}

function useApplyAppearanceConfiguration(
  appearance: ConfigurationSnapshot['appearance'] | undefined
): void {
  useEffect(() => {
    if (!appearance) return
    const root = document.documentElement
    root.dataset.density = appearance.density
    root.style.setProperty('--aw-font-ui', appearance.fontFamily)
    let removeSystemThemeListener: (() => void) | undefined
    if (appearance.theme !== 'system') {
      root.dataset.theme = appearance.theme
    } else {
      const media = window.matchMedia?.('(prefers-color-scheme: light)')
      const applySystemTheme = (): void => {
        root.dataset.theme = media?.matches ? 'light' : 'dark'
      }
      applySystemTheme()
      media?.addEventListener('change', applySystemTheme)
      removeSystemThemeListener = () => media?.removeEventListener('change', applySystemTheme)
    }
    return () => {
      removeSystemThemeListener?.()
      root.style.removeProperty('--aw-font-ui')
    }
  }, [appearance])
}

function LifecycleLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <main className="startup-shell" aria-live="polite">
      <span className="mark" aria-hidden="true" />
      <p>{label}</p>
    </main>
  )
}

function DiagnosticPreview({ preview }: { preview: DiagnosticBundlePreview }): React.JSX.Element {
  return (
    <section className="diagnostic-preview" aria-labelledby="diagnostic-preview-title">
      <h2 id="diagnostic-preview-title">{messages.lifecycle.diagnosticsTitle}</h2>
      <p>{messages.lifecycle.diagnosticsPrivacy}</p>
      <ul>
        {preview.entries.map((entry, index) => (
          <li key={`${entry.name}-${String(index)}`}>
            <span>{entry.name}</span>
            <span>{formatBytes(entry.bytes)}</span>
          </li>
        ))}
      </ul>
      <dl>
        <div>
          <dt>{messages.lifecycle.diagnosticsTotal}</dt>
          <dd>{formatBytes(preview.totalBytes)}</dd>
        </div>
        <div>
          <dt>{messages.lifecycle.diagnosticsRedactions}</dt>
          <dd>{preview.redactionCount}</dd>
        </div>
      </dl>
    </section>
  )
}
