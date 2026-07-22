import { DesktopWindowBinding } from './desktop-window-binding'
import type { WindowRegistry } from './window-registry'

/** Revokes renderer privilege and native resource ownership after a provider lease is lost. */
export async function invalidateProviderWindowBindings(
  registry: WindowRegistry,
  rollbackTransfers: () => void
): Promise<void> {
  rollbackTransfers()
  for (const entry of registry.list()) entry.terminalAttachments.clear()
  await Promise.all(
    registry
      .list()
      .map(({ binding }) =>
        binding instanceof DesktopWindowBinding ? binding.clearReady() : Promise.resolve()
      )
  )
}
