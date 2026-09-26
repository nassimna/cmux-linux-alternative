import {
  APPLICATION_MENU_COMMAND_IDS,
  type ApplicationMenuCommandId,
  type ApplicationMenuState
} from '@agent-workspace/contracts/desktop/application-menu'
import type { DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'

import { defaultCommandRegistry, type CommandRegistry } from './registry'
import {
  effectiveShortcut,
  findShortcutConflicts,
  parseShortcut,
  shortcutPhysicalIdentity,
  type ShortcutOverrides,
  type ShortcutPlatform
} from './shortcuts'
import { resolveCommandAvailability, type CommandContext } from './types'

export function buildApplicationMenuState(
  registry: CommandRegistry,
  context: CommandContext,
  overrides: ShortcutOverrides,
  platform: ShortcutPlatform
): ApplicationMenuState {
  const conflicted = new Set(
    findShortcutConflicts(registry.list(), overrides, platform).flatMap(
      (conflict) => conflict.commandIds
    )
  )
  const reserved = standardNativeRoleShortcutIdentities(platform)
  return {
    commands: APPLICATION_MENU_COMMAND_IDS.map((commandId) => {
      const command = registry.get(commandId)
      const shortcut = command ? effectiveShortcut(command, overrides) : undefined
      const reservedByNativeRole =
        shortcut !== undefined && reserved.has(shortcutPhysicalIdentity(shortcut, platform))
      return {
        commandId,
        enabled: command ? resolveCommandAvailability(command, context).available : false,
        shortcut: shortcut && !conflicted.has(commandId) && !reservedByNativeRole ? shortcut : null
      }
    })
  }
}

function standardNativeRoleShortcutIdentities(platform: ShortcutPlatform): ReadonlySet<string> {
  const editRoleShortcuts =
    platform === 'macos'
      ? [
          'Primary+Z',
          'Primary+Shift+Z',
          'Primary+X',
          'Primary+C',
          'Primary+V',
          'Primary+Shift+V',
          'Primary+A'
        ]
      : ['Primary+Z', 'Primary+Y', 'Primary+X', 'Primary+C', 'Primary+V', 'Primary+A']
  const applicationAndWindowRoleShortcuts = [
    'Primary+Q',
    'Primary+M',
    ...(platform === 'macos' ? ['Primary+H', 'Primary+Secondary+H'] : [])
  ]
  return new Set(
    [...editRoleShortcuts, ...applicationAndWindowRoleShortcuts].map((value) => {
      const parsed = parseShortcut(value)
      if (!parsed.valid) throw new Error(parsed.reason)
      return shortcutPhysicalIdentity(parsed.shortcut, platform)
    })
  )
}

export function bindApplicationMenuCommands(
  bridge: DesktopBridge,
  getContext: () => CommandContext,
  onExecuted: (commandId: ApplicationMenuCommandId) => void,
  registry: CommandRegistry = defaultCommandRegistry
): () => void {
  return (
    bridge.onApplicationMenuCommand?.((commandId) => {
      void registry.execute(commandId, getContext()).then((result) => {
        if (result.status === 'executed') onExecuted(commandId)
      })
    }) ?? (() => undefined)
  )
}
