import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DESKTOP_IPC, type DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'
import projection from '../../../../packages/protocol-client/fixtures/milestone2-projection.json'

const electron = vi.hoisted(() => ({
  exposed: undefined as DesktopBridge | undefined,
  invoke: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: DesktopBridge) => {
      electron.exposed = bridge
    }
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      electron.listeners.set(channel, listener),
    removeListener: (channel: string) => electron.listeners.delete(channel)
  }
}))

await import('./index')

describe('notification preload bridge', () => {
  beforeEach(() => {
    electron.invoke.mockReset()
  })

  it('normalizes list defaults and validates results before returning them', async () => {
    electron.invoke.mockResolvedValue({
      revision: 42,
      notifications: [],
      total: 0,
      unreadCount: 0
    })

    await expect(electron.exposed?.listNotifications?.()).resolves.toMatchObject({ revision: 42 })
    expect(electron.invoke).toHaveBeenCalledWith('notification:list', {
      unreadOnly: false,
      offset: 0,
      limit: 50
    })

    electron.invoke.mockResolvedValueOnce({
      revision: 42,
      notifications: [],
      total: -1,
      unreadCount: 0
    })
    await expect(electron.exposed?.listNotifications?.()).rejects.toThrow()
  })

  it('preserves capability-transition sentinels for optional projection reads', async () => {
    electron.invoke.mockResolvedValue(null)

    await expect(electron.exposed?.getWorkspaceOrganization?.()).resolves.toBeNull()
    await expect(electron.exposed?.listSavedLayouts?.()).resolves.toBeNull()
    expect(electron.invoke).toHaveBeenNthCalledWith(1, DESKTOP_IPC.workspaceOrganizationGet)
    expect(electron.invoke).toHaveBeenNthCalledWith(2, DESKTOP_IPC.layoutList)
  })

  it('exposes only data-bearing public action calls and preserves stable failures', async () => {
    const invocationId = '20000000-0000-4000-8000-000000000001'
    const correlationId = '20000000-0000-4000-8000-000000000002'
    electron.invoke.mockResolvedValue({
      invocationId,
      correlationId,
      state: 'acknowledged',
      terminalCode: 'succeeded',
      result: {},
      updatedAtMs: 4
    })
    const params = { actionId: 'desktop.window.focus', actionVersion: 1, parameters: {} }

    await expect(electron.exposed?.invokePublicAction?.(params)).resolves.toMatchObject({
      invocationId,
      state: 'acknowledged'
    })
    expect(electron.invoke).toHaveBeenCalledWith(DESKTOP_IPC.actionInvoke, params)
    await expect(
      electron.exposed?.invokePublicAction?.({ ...params, actionVersion: 0 })
    ).rejects.toThrow()
    expect(electron.invoke).toHaveBeenCalledTimes(1)

    electron.invoke.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: [agent-workspace-protocol-error:provider_unavailable] No eligible desktop provider'
      )
    )
    await expect(electron.exposed?.invokePublicAction?.(params)).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'No eligible desktop provider'
    })
  })

  it('strictly validates public action registry invalidations before exposing them', () => {
    const listener = vi.fn()
    const remove = electron.exposed?.onActionRegistryChanged?.(listener)
    const forward = electron.listeners.get(DESKTOP_IPC.actionRegistryChanged)
    const event = {
      event: 'action.registryChanged',
      registryRevision: 8,
      reason: 'definitionsChanged'
    }

    forward?.({}, event)
    expect(listener).toHaveBeenCalledWith(event)
    expect(() => forward?.({}, { ...event, executable: '/bin/sh' })).toThrow()
    remove?.()
    expect(electron.listeners.has(DESKTOP_IPC.actionRegistryChanged)).toBe(false)
  })

  it('validates workspace runtime metadata input and output across preload', async () => {
    const params = { workspaceId: '10000000-0000-4000-8000-000000000001' }
    electron.invoke.mockResolvedValue({
      gitBranch: 'feature/sidebar',
      gitStatus: {
        clean: true,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
        ahead: 0,
        behind: 0
      },
      listeningPorts: [3000]
    })

    await expect(electron.exposed?.getWorkspaceRuntimeMetadata?.(params)).resolves.toEqual({
      gitBranch: 'feature/sidebar',
      gitStatus: {
        clean: true,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
        ahead: 0,
        behind: 0
      },
      listeningPorts: [3000]
    })
    expect(electron.invoke).toHaveBeenCalledWith('workspace:runtimeMetadata', params)

    await expect(
      electron.exposed?.getWorkspaceRuntimeMetadata?.({ workspaceId: 'invalid' })
    ).rejects.toThrow()
    electron.invoke.mockResolvedValueOnce({
      gitBranch: 'unsafe\nbranch',
      gitStatus: null,
      listeningPorts: []
    })
    await expect(electron.exposed?.getWorkspaceRuntimeMetadata?.(params)).rejects.toThrow()
  })

  it('exposes fixed card-slot fetch and targeted event validation', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const snapshot = {
      workspaceId,
      revision: 2,
      agentStatus: { status: 'running' as const, label: 'Reviewing' },
      progress: { mode: 'determinate' as const, value: 50, label: null }
    }
    electron.invoke.mockResolvedValue(snapshot)
    await expect(electron.exposed?.getWorkspaceCardSlots?.({ workspaceId })).resolves.toEqual(
      snapshot
    )
    expect(electron.invoke).toHaveBeenCalledWith('workspace:cardSlots:get', { workspaceId })

    const listener = vi.fn()
    electron.exposed?.onWorkspaceCardSlotsEvent?.(listener)
    electron.listeners.get('workspace:cardSlots:event')?.(
      {},
      {
        event: 'workspace.cardSlotsChanged',
        data: { workspaceId, slotRevision: 3, reason: 'slotsReplaced' }
      }
    )
    expect(listener).toHaveBeenCalledOnce()
    expect(() =>
      electron.listeners.get('workspace:cardSlots:event')?.(
        {},
        {
          event: 'workspace.cardSlotsChanged',
          revision: 43,
          data: { workspaceId, slotRevision: 3, reason: 'slotsReplaced' }
        }
      )
    ).toThrow()
  })

  it('preserves an optimistic card-slot conflict code across IPC', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    electron.invoke.mockRejectedValue(
      new Error(
        'Error invoking remote method: [agent-workspace-protocol-error:revision_conflict] Use a fresh revision'
      )
    )

    await expect(
      electron.exposed?.replaceWorkspaceCardSlots?.({
        workspaceId,
        expectedRevision: 0,
        agentStatus: null,
        progress: null
      })
    ).rejects.toMatchObject({ code: 'revision_conflict', message: 'Use a fresh revision' })
  })

  it('validates the native workspace directory result', async () => {
    electron.invoke.mockResolvedValue('/home/alex/project')
    await expect(electron.exposed?.pickWorkspaceDirectory?.()).resolves.toBe('/home/alex/project')
    expect(electron.invoke).toHaveBeenCalledWith('workspace:pickDirectory')

    electron.invoke.mockResolvedValueOnce('unsafe\npath')
    await expect(electron.exposed?.pickWorkspaceDirectory?.()).rejects.toThrow()
  })

  it('rejects malformed mutation input before IPC and routes valid input', async () => {
    await expect(
      electron.exposed?.markNotificationRead?.({ notificationId: 'invalid' })
    ).rejects.toThrow()
    expect(electron.invoke).not.toHaveBeenCalled()

    const params = { notificationId: '60000000-0000-4000-8000-000000000001' }
    electron.invoke.mockResolvedValue({
      revision: 43,
      snapshot: { ...projection, revision: 43 }
    })
    await expect(electron.exposed?.markNotificationRead?.(params)).resolves.toMatchObject({
      revision: 43
    })
    expect(electron.invoke).toHaveBeenCalledWith('notification:markRead', params)
  })

  it('schema-validates browser mutations and native view payloads before IPC', async () => {
    const browserSessionId = '50000000-0000-4000-8000-000000000001'
    const lifecycleId = '70000000-0000-4000-8000-000000000001'
    const mutation = { revision: 43, snapshot: { ...projection, revision: 43 } }
    electron.invoke.mockResolvedValue(mutation)

    await expect(
      electron.exposed?.navigateBrowser({
        browserSessionId,
        url: 'file:///etc/passwd',
        expectedStateRevision: 0,
        correlationId: 'browser:test'
      })
    ).rejects.toThrow()
    expect(electron.invoke).not.toHaveBeenCalled()

    const navigate = {
      browserSessionId,
      url: 'https://example.test/next',
      expectedStateRevision: 0,
      correlationId: 'browser:test'
    }
    await expect(electron.exposed?.navigateBrowser(navigate)).resolves.toMatchObject({
      revision: 43
    })
    expect(electron.invoke).toHaveBeenLastCalledWith('browser:navigate', navigate)

    await expect(
      electron.exposed?.mountBrowserView({
        workspaceId: '10000000-0000-4000-8000-000000000001',
        tabId: '40000000-0000-4000-8000-000000000003',
        browserSessionId,
        lifecycleId,
        url: 'https://renderer-controlled.invalid'
      } as never)
    ).rejects.toThrow()

    electron.invoke.mockResolvedValueOnce(undefined)
    const bounds = {
      browserSessionId,
      lifecycleId,
      revision: 1,
      x: 10.25,
      y: 20.75,
      width: 300.5,
      height: 200.5,
      visible: true
    }
    await expect(electron.exposed?.setBrowserBounds(bounds)).resolves.toBeUndefined()
    expect(electron.invoke).toHaveBeenLastCalledWith('browser:setBounds', bounds)
    await expect(
      electron.exposed?.setBrowserBounds({
        ...bounds,
        revision: 2,
        width: Number.POSITIVE_INFINITY
      })
    ).rejects.toThrow()
  })

  it('rejects unsafe external URLs before they reach main', async () => {
    for (const unsafe of [
      'https://user:secret@example.test/',
      'HTTPS://example.test/',
      ' https://example.test/',
      'https://example.test/bad\npath',
      'file:///etc/passwd',
      'javascript:alert(1)'
    ]) {
      await expect(electron.exposed?.openExternal(unsafe)).rejects.toThrow()
    }
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('validates workspace opener discovery and sends only workspace and opener IDs', async () => {
    electron.invoke.mockResolvedValue([
      { id: 'fileManager', label: 'File Explorer', kind: 'fileManager' },
      { id: 'vscode', label: 'Visual Studio Code', kind: 'ide' }
    ])
    await expect(electron.exposed?.listWorkspacePathOpeners?.()).resolves.toHaveLength(2)
    expect(electron.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.workspacePathOpeners)

    electron.invoke.mockResolvedValueOnce(undefined)
    const request = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      openerId: 'vscode' as const
    }
    await expect(electron.exposed?.openWorkspacePath?.(request)).resolves.toBeUndefined()
    expect(electron.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.workspacePathOpen, request)

    await expect(
      electron.exposed?.openWorkspacePath?.({ ...request, openerId: '/bin/sh' } as never)
    ).rejects.toThrow()
    expect(electron.invoke).toHaveBeenCalledTimes(2)
  })

  it('strictly validates lifecycle snapshots and event ingress', async () => {
    electron.invoke.mockResolvedValue({
      status: 'recovering',
      attempt: 1,
      maxAttempts: 3,
      message: 'Restarting the service.'
    })
    await expect(electron.exposed?.getLifecycleState?.()).resolves.toMatchObject({
      status: 'recovering',
      attempt: 1
    })

    electron.invoke.mockResolvedValueOnce({ status: 'ready', unexpected: true })
    await expect(electron.exposed?.getLifecycleState?.()).rejects.toThrow()

    const listener = vi.fn()
    electron.exposed?.onLifecycleState?.(listener)
    expect(() =>
      electron.listeners.get('lifecycle:changed')?.({}, { status: 'failed', message: '' })
    ).toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('exposes only bounded updater actions and validates update events', async () => {
    electron.invoke.mockResolvedValue({
      status: 'idle',
      channel: 'stable',
      packageType: 'appimage'
    })
    await expect(electron.exposed?.getUpdateState?.()).resolves.toMatchObject({ status: 'idle' })
    await expect(electron.exposed?.checkForUpdate?.()).resolves.toMatchObject({ status: 'idle' })
    expect(electron.invoke).toHaveBeenNthCalledWith(1, 'update:getState')
    expect(electron.invoke).toHaveBeenNthCalledWith(2, 'update:check')

    const listener = vi.fn()
    const remove = electron.exposed?.onUpdateState?.(listener)
    electron.listeners.get('update:stateChanged')?.(
      {},
      {
        status: 'available',
        channel: 'beta',
        packageType: 'rpm',
        version: '1.2.3-beta.1'
      }
    )
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'available' }))
    expect(() =>
      electron.listeners.get('update:stateChanged')?.(
        {},
        {
          status: 'available',
          channel: 'beta',
          packageType: 'rpm',
          version: '1.2.3',
          feedUrl: 'https://private.invalid/'
        }
      )
    ).toThrow()
    remove?.()
    expect(electron.listeners.has('update:stateChanged')).toBe(false)
  })

  it('validates native menu state and command events without exposing raw IPC', async () => {
    electron.invoke.mockResolvedValue(undefined)
    const state = {
      commands: [
        {
          commandId: 'workspace.new' as const,
          enabled: true,
          shortcut: { modifiers: ['Primary' as const], key: 'N' }
        }
      ]
    }
    await expect(electron.exposed?.setApplicationMenuState?.(state)).resolves.toBeUndefined()
    expect(electron.invoke).toHaveBeenCalledWith('applicationMenu:update', state)

    await expect(
      electron.exposed?.setApplicationMenuState?.({
        commands: [{ commandId: 'tab.close', enabled: true, shortcut: null }]
      } as never)
    ).rejects.toThrow()
    expect(electron.invoke).toHaveBeenCalledOnce()

    const listener = vi.fn()
    const remove = electron.exposed?.onApplicationMenuCommand?.(listener)
    electron.listeners.get('applicationMenu:command')?.({}, 'settings.open')
    expect(listener).toHaveBeenCalledWith('settings.open')
    expect(() => electron.listeners.get('applicationMenu:command')?.({}, 'shell.exec')).toThrow()
    remove?.()
    expect(electron.listeners.has('applicationMenu:command')).toBe(false)
  })

  it('schema-validates multi-window events and removes the typed listener', () => {
    const listener = vi.fn()
    const remove = electron.exposed?.onMultiWindowEvent?.(listener)
    const event = {
      event: 'window.topologyChanged' as const,
      revision: 8,
      idempotencyEpoch: '10000000-0000-4000-8000-000000000001',
      windowIds: ['20000000-0000-4000-8000-000000000001'],
      reason: 'windowCreated' as const
    }
    electron.listeners.get('multiWindow:event')?.({}, event)
    expect(listener).toHaveBeenCalledWith(event)
    expect(() =>
      electron.listeners.get('multiWindow:event')?.({}, { ...event, windowIds: ['invalid'] })
    ).toThrow()
    remove?.()
    expect(electron.listeners.has('multiWindow:event')).toBe(false)
  })

  it('exposes a removable native browser rebind listener without renderer-controlled payload', () => {
    const listener = vi.fn()
    const remove = electron.exposed?.onBrowserViewsRebind?.(listener)
    electron.listeners.get('browser:viewsRebind')?.({}, { ignored: true })
    expect(listener).toHaveBeenCalledWith()
    remove?.()
    expect(electron.listeners.has('browser:viewsRebind')).toBe(false)
  })

  it('exposes a removable desktop-binding rebind listener without renderer-controlled payload', () => {
    const listener = vi.fn()
    const remove = electron.exposed?.onDesktopBindingRebind?.(listener)
    electron.listeners.get('desktop:bindingRebind')?.({}, { ignored: true })
    expect(listener).toHaveBeenCalledWith()
    remove?.()
    expect(electron.listeners.has('desktop:bindingRebind')).toBe(false)
  })

  it('validates configuration input and output on both sides of IPC', async () => {
    const config = {
      schemaVersion: 1,
      revision: 4,
      appearance: { theme: 'system', density: 'comfortable', fontFamily: 'system-ui' },
      terminal: {
        shellPath: '/bin/sh',
        fontFamily: 'monospace',
        fontSize: 13,
        scrollback: 10_000,
        multilinePasteProtection: true
      },
      browser: { profileName: 'Default', partition: 'default', privacy: 'standard' },
      notifications: { systemEnabled: true, includeBody: false },
      keyboardShortcuts: { overrides: {} },
      agentIntegration: { enabled: true, notificationsEnabled: true, browserEnabled: true },
      updates: { channel: 'stable' },
      logging: { level: 'info' }
    }
    electron.invoke.mockResolvedValue({ config })
    await expect(electron.exposed?.getConfiguration?.()).resolves.toMatchObject({ config })

    await expect(
      electron.exposed?.updateConfiguration?.({
        expectedRevision: 4,
        update: {
          appearance: { theme: 'dark', density: 'comfortable', fontFamily: 'system-ui' }
        },
        unexpected: true
      } as never)
    ).rejects.toThrow()
    expect(electron.invoke).toHaveBeenCalledTimes(1)

    electron.invoke.mockResolvedValueOnce({ config: { ...config, revision: -1 } })
    await expect(
      electron.exposed?.updateConfiguration?.({
        expectedRevision: 4,
        update: {
          appearance: { theme: 'dark', density: 'comfortable', fontFamily: 'system-ui' }
        }
      })
    ).rejects.toThrow()
  })

  it('requires an exact diagnostic preview before export and parses cancellation', async () => {
    const preview = {
      entries: [{ name: 'service.log', bytes: 42 }],
      totalBytes: 42,
      redactionCount: 2,
      createdAt: 5
    }
    electron.invoke.mockResolvedValue(preview)
    await expect(electron.exposed?.previewDiagnostics?.()).resolves.toEqual(preview)

    await expect(
      electron.exposed?.exportDiagnostics?.({ ...preview, totalBytes: 41 })
    ).rejects.toThrow()
    expect(electron.invoke).toHaveBeenCalledTimes(1)

    electron.invoke.mockResolvedValueOnce(null)
    await expect(electron.exposed?.exportDiagnostics?.(preview)).resolves.toBeNull()
    expect(electron.invoke).toHaveBeenLastCalledWith('diagnostics:export', preview)
  })

  it('keeps remote credential paths and bytes outside the renderer bridge', async () => {
    const remoteTargetId = '30000000-0000-4000-8000-000000000001'
    const target = {
      remoteTargetId,
      label: 'dev',
      host: 'example.com',
      port: 22,
      user: 'alice',
      authentication: 'publicKey',
      hostKeyState: 'untrusted',
      knownHostsVersion: 1,
      revision: 1
    }
    electron.invoke.mockResolvedValue({ targets: [target] })
    await expect(electron.exposed?.listRemoteTargets?.()).resolves.toEqual({
      targets: [target]
    })
    expect(electron.invoke).toHaveBeenCalledWith(DESKTOP_IPC.remoteTargetList)

    await expect(
      electron.exposed?.enrollRemoteTarget?.({
        label: 'dev',
        host: 'example.com',
        port: 22,
        user: 'alice',
        privateKey: 'secret bytes'
      } as never)
    ).rejects.toThrow()
    await expect(
      electron.exposed?.enrollRemoteTarget?.({
        label: 'dev',
        host: '[2001:db8::1]',
        port: 22,
        user: 'alice'
      })
    ).rejects.toThrow()
    expect(electron.invoke).toHaveBeenCalledTimes(1)
  })
})
