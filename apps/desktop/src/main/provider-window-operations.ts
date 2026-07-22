import type { WindowRegistry, WindowRegistryEntry } from './window-registry'

/** Final provider close after the service's ordered per-resource rehome operations. */
export async function closeTransferredProviderWindow(
  registry: WindowRegistry,
  entry: WindowRegistryEntry
): Promise<void> {
  if (registry.get(entry.windowId) !== entry) {
    throw new Error('Desktop-provider close target generation is stale')
  }
  if (entry.terminalAttachments.size > 0 || entry.binding.browserViews.size > 0) {
    throw new Error('Desktop-provider close target still owns live resources')
  }
  await registry.remove(entry.windowId, 'closed')
  if (!entry.window.isDestroyed()) entry.window.destroy()
}

/** FocusWindow is provider-owned; renderers only consume its returned target. */
export function focusProviderWindow(entry: WindowRegistryEntry): void {
  if (entry.window.isMinimized()) entry.window.restore()
  entry.window.focus()
}
