import type {
  DesktopProviderIdentityParams,
  DesktopProviderWindowClaim
} from '@agent-workspace/protocol-client'

import type { ControlClient } from './control-client'
import type { WindowRegistry, WindowRegistryEntry } from './window-registry'

export interface AdditionalControlClientConnector {
  connectAdditionalClient(): Promise<ControlClient>
}

/** Rebinds a ready service generation across the complete live native-window snapshot. */
export async function rebindRegisteredWindows(
  registry: WindowRegistry,
  providerClient: ControlClient,
  bind: (window: Electron.BrowserWindow, providerClient: ControlClient) => Promise<void>
): Promise<void> {
  await Promise.all(registry.list().map(({ window }) => bind(window, providerClient)))
}

/** Opens and authenticates a child connection before it can be exposed to a renderer binding. */
export async function connectWindowScopedClient(
  connector: AdditionalControlClientConnector,
  identity: DesktopProviderIdentityParams,
  entry: Pick<WindowRegistryEntry, 'windowId' | 'generation'>
): Promise<ControlClient> {
  const child = await connector.connectAdditionalClient()
  const window: DesktopProviderWindowClaim = {
    windowId: entry.windowId,
    generation: entry.generation
  }
  try {
    await child.bindWindow({ identity, window })
    return child
  } catch (error) {
    child.close()
    throw error
  }
}
