/** Commands exposed by the native application menu. Destructive commands stay renderer-only. */
export const APPLICATION_MENU_COMMAND_IDS = [
  'workspace.new',
  'terminal.new',
  'pane.splitRight',
  'pane.splitDown',
  'sidebar.toggle',
  'commandPalette.toggle',
  'terminal.search',
  'browser.openSplit',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.stop',
  'browser.openDevTools',
  'notifications.toggle',
  'notifications.latestUnread',
  'settings.open'
] as const

export type ApplicationMenuCommandId = (typeof APPLICATION_MENU_COMMAND_IDS)[number]
export type ApplicationMenuLogicalModifier = 'Primary' | 'Secondary' | 'Shift' | 'Control'

export interface ApplicationMenuShortcut {
  modifiers: readonly ApplicationMenuLogicalModifier[]
  key: string
}

export interface ApplicationMenuCommandState {
  commandId: ApplicationMenuCommandId
  enabled: boolean
  shortcut: ApplicationMenuShortcut | null
}

export interface ApplicationMenuState {
  commands: readonly ApplicationMenuCommandState[]
}

const COMMAND_ID_SET = new Set<string>(APPLICATION_MENU_COMMAND_IDS)
const MODIFIER_ORDER: readonly ApplicationMenuLogicalModifier[] = [
  'Primary',
  'Secondary',
  'Control',
  'Shift'
]
const NAMED_KEYS = new Set([
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Minus',
  'Equal',
  'Backquote'
])

export function parseApplicationMenuCommandId(value: unknown): ApplicationMenuCommandId {
  if (typeof value !== 'string' || !COMMAND_ID_SET.has(value)) {
    throw new Error('Invalid application menu command')
  }
  return value as ApplicationMenuCommandId
}

export function parseApplicationMenuState(value: unknown): ApplicationMenuState {
  const record = strictRecord(value, ['commands'], 'Invalid application menu state')
  if (
    !Array.isArray(record.commands) ||
    record.commands.length > APPLICATION_MENU_COMMAND_IDS.length
  ) {
    throw new Error('Invalid application menu state')
  }
  const seen = new Set<ApplicationMenuCommandId>()
  const commands = record.commands.map((rawCommand) => {
    const command = strictRecord(
      rawCommand,
      ['commandId', 'enabled', 'shortcut'],
      'Invalid application menu command state'
    )
    const commandId = parseApplicationMenuCommandId(command.commandId)
    if (seen.has(commandId)) throw new Error('Duplicate application menu command state')
    seen.add(commandId)
    if (typeof command.enabled !== 'boolean') {
      throw new Error('Invalid application menu command state')
    }
    return {
      commandId,
      enabled: command.enabled,
      shortcut: command.shortcut === null ? null : parseShortcut(command.shortcut)
    }
  })
  return { commands }
}

function parseShortcut(value: unknown): ApplicationMenuShortcut {
  const record = strictRecord(value, ['modifiers', 'key'], 'Invalid application menu shortcut')
  if (!Array.isArray(record.modifiers) || record.modifiers.length > MODIFIER_ORDER.length) {
    throw new Error('Invalid application menu shortcut')
  }
  const modifiers = record.modifiers.map((modifier) => {
    if (
      typeof modifier !== 'string' ||
      !MODIFIER_ORDER.includes(modifier as ApplicationMenuLogicalModifier)
    ) {
      throw new Error('Invalid application menu shortcut')
    }
    return modifier as ApplicationMenuLogicalModifier
  })
  if (
    new Set(modifiers).size !== modifiers.length ||
    modifiers.some(
      (modifier, index) =>
        MODIFIER_ORDER.indexOf(modifier) <= MODIFIER_ORDER.indexOf(modifiers[index - 1]!)
    )
  ) {
    throw new Error('Invalid application menu shortcut')
  }
  if (typeof record.key !== 'string' || !isSupportedKey(record.key)) {
    throw new Error('Invalid application menu shortcut')
  }
  return { modifiers, key: record.key }
}

function isSupportedKey(value: string): boolean {
  return (
    /^[A-Z0-9]$/u.test(value) || /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(value) || NAMED_KEYS.has(value)
  )
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  message: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(message)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    throw new Error(message)
  }
  return record
}
