// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConfigurationSnapshot } from '@agent-workspace/protocol-client'
import type { DesktopBridge } from '../../shared/desktop-bridge'

import { resetConfigurationStoreForTests, useConfigurationStore } from './configuration-store'

type ConfigurationBridge = DesktopBridge & {
  getConfiguration: NonNullable<DesktopBridge['getConfiguration']>
}

const configuration: ConfigurationSnapshot = {
  schemaVersion: 2,
  revision: 1,
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

afterEach(() => resetConfigurationStoreForTests())

describe('configuration store binding generations', () => {
  it('preserves ordinary initialize idempotence once ready', async () => {
    const bridge = configurationBridge()

    await useConfigurationStore.getState().initialize(bridge)
    await useConfigurationStore.getState().initialize(bridge)

    expect(bridge.getConfiguration).toHaveBeenCalledOnce()
  })

  it('forces a fresh binding read and prevents an old initialize from winning', async () => {
    const stale = deferred<{ config: ConfigurationSnapshot }>()
    const latest = { ...configuration, revision: 3 }
    const bridge = configurationBridge()
    vi.mocked(bridge.getConfiguration)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ config: latest })

    const oldInitialization = useConfigurationStore.getState().initialize(bridge)
    const replacement = useConfigurationStore.getState().reinitialize(bridge)
    await replacement
    stale.resolve({ config: { ...configuration, revision: 2 } })
    await oldInitialization

    expect(bridge.getConfiguration).toHaveBeenCalledTimes(2)
    expect(useConfigurationStore.getState().config?.revision).toBe(3)
  })

  it('prevents a deferred old-binding refresh from overwriting forced reinitialization', async () => {
    const staleRefresh = deferred<{ config: ConfigurationSnapshot }>()
    const latest = { ...configuration, revision: 4 }
    const bridge = configurationBridge()
    await useConfigurationStore.getState().initialize(bridge)
    vi.mocked(bridge.getConfiguration)
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce({ config: latest })

    const refresh = useConfigurationStore.getState().refresh()
    await useConfigurationStore.getState().reinitialize(bridge)
    staleRefresh.resolve({ config: { ...configuration, revision: 2 } })
    await refresh

    expect(useConfigurationStore.getState().config?.revision).toBe(4)
  })
})

function configurationBridge(): ConfigurationBridge {
  return {
    getConfiguration: vi.fn().mockResolvedValue({ config: configuration })
  } as unknown as ConfigurationBridge
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
