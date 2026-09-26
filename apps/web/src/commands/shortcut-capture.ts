import type { CommandRegistry } from './registry'
import { effectiveShortcut, shortcutMatchesEvent } from './shortcuts'
import type { ShortcutOverrides, ShortcutPlatform } from './shortcuts'

/**
 * Registered-shortcut lookup for embedded key consumers. The terminal must
 * decline keydown events that match an application shortcut so the
 * window-level dispatcher executes the command instead of the shell receiving
 * a control character.
 */
interface ShortcutCapture {
  registry: CommandRegistry
  overrides: ShortcutOverrides
  platform: ShortcutPlatform
}

let capture: ShortcutCapture | null = null

export function setShortcutCapture(
  registry: CommandRegistry,
  overrides: ShortcutOverrides,
  platform: ShortcutPlatform
): void {
  capture = { registry, overrides, platform }
}

export function clearShortcutCapture(): void {
  capture = null
}

export function eventMatchesRegisteredShortcut(event: KeyboardEvent): boolean {
  if (capture === null) return false
  const { registry, overrides, platform } = capture
  return registry.list().some((command) => {
    const shortcut = effectiveShortcut(command, overrides)
    return shortcut !== undefined && shortcutMatchesEvent(shortcut, event, platform)
  })
}
