import {
  COMMAND_CATALOG,
  settingsGetResultSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'

/** Rust's settings.get projection from the authoritative application snapshot. */
export function projectSettings(state: DurableApplicationState) {
  const shortcuts = COMMAND_CATALOG.map(([commandId, defaultShortcut]) => {
    const hasOverride = Object.prototype.hasOwnProperty.call(state.shortcutOverrides, commandId)
    const override = state.shortcutOverrides[commandId]
    return {
      commandId,
      defaultShortcut,
      overrideState: !hasOverride
        ? { kind: 'default' as const }
        : override === null
          ? { kind: 'cleared' as const }
          : { kind: 'set' as const, shortcut: override },
      effectiveShortcut: !hasOverride ? defaultShortcut : override
    }
  })
  return settingsGetResultSchema.parse({
    revision: state.revision,
    shortcuts,
    notifications: state.notificationSettings
  })
}
