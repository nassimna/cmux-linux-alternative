import {
  effectiveShortcut,
  parseShortcut,
  shortcutMatchesEvent,
  type KeyboardEventLike,
  type Shortcut,
  type ShortcutOverrides,
  type ShortcutPlatform
} from './shortcuts'
import {
  resolveCommandAvailability,
  type CommandContext,
  type CommandDefinition,
  type CommandExecutionResult,
  type CommandId
} from './types'
import { browserMessages } from '../../../shared/browser-messages'
import { messages } from '../messages'

export class CommandRegistry {
  readonly #commands: readonly CommandDefinition[]
  readonly #byId: ReadonlyMap<CommandId, CommandDefinition>

  constructor(commands: readonly CommandDefinition[]) {
    const byId = new Map<CommandId, CommandDefinition>()
    for (const command of commands) {
      if (byId.has(command.id)) throw new Error(`Duplicate command ID: ${command.id}`)
      byId.set(command.id, command)
    }
    this.#commands = [...commands]
    this.#byId = byId
  }

  list(): readonly CommandDefinition[] {
    return this.#commands
  }

  get(commandId: CommandId): CommandDefinition | undefined {
    return this.#byId.get(commandId)
  }

  async execute(commandId: CommandId, context: CommandContext): Promise<CommandExecutionResult> {
    const command = this.get(commandId)
    if (command === undefined) return { status: 'not-found', commandId }

    const availability = resolveCommandAvailability(command, context)
    if (!availability.available) {
      return availability.reason === undefined
        ? { status: 'unavailable', commandId }
        : { status: 'unavailable', commandId, reason: availability.reason }
    }

    try {
      await command.handler(context)
      return { status: 'executed', commandId }
    } catch (error) {
      return { status: 'failed', commandId, error }
    }
  }
}

export type KeyboardCommandResult =
  | { readonly status: 'unmatched'; readonly consumed: false }
  | { readonly status: 'composing'; readonly consumed: false }
  | { readonly status: 'repeated'; readonly commandId: CommandId; readonly consumed: true }
  | {
      readonly status: 'matched'
      readonly commandId: CommandId
      readonly consumed: true
      readonly execution: CommandExecutionResult
    }

export async function dispatchKeyboardCommand(
  event: KeyboardEventLike,
  registry: CommandRegistry,
  context: CommandContext,
  overrides: ShortcutOverrides,
  platform: ShortcutPlatform
): Promise<KeyboardCommandResult> {
  if (event.isComposing === true) return { status: 'composing', consumed: false }

  const command = registry.list().find((candidate) => {
    const shortcut = effectiveShortcut(candidate, overrides)
    return shortcut !== undefined && shortcutMatchesEvent(shortcut, event, platform)
  })

  if (command === undefined) return { status: 'unmatched', consumed: false }

  event.preventDefault?.()
  if (event.repeat === true && command.allowRepeat !== true) {
    return { status: 'repeated', commandId: command.id, consumed: true }
  }

  return {
    status: 'matched',
    commandId: command.id,
    consumed: true,
    execution: await registry.execute(command.id, context)
  }
}

function shortcut(value: string): Shortcut {
  const parsed = parseShortcut(value)
  if (!parsed.valid) throw new Error(`Invalid built-in shortcut ${value}: ${parsed.reason}`)
  return parsed.shortcut
}

const handler = (commandId: CommandId) => (context: CommandContext) => context.invoke(commandId)
const activeBrowser = (capabilityName: string, reason: string) => (context: CommandContext) => ({
  available:
    context.capabilities?.includes(capabilityName) === true &&
    context.browser !== null &&
    context.browser !== undefined,
  reason
})
const selected =
  (key: keyof NonNullable<CommandContext['selection']>, reason: string) =>
  (context: CommandContext) => ({
    available: context.selection?.[key] !== false,
    reason
  })
const activePaneWithCapability = (name: string, reason: string) => (context: CommandContext) => ({
  available: context.selection?.pane !== false && context.capabilities?.includes(name) === true,
  reason
})
const multiWindow = (reason: string) => (context: CommandContext) => ({
  available: context.capabilities?.includes('multi-window-v1') === true,
  reason
})
const selectedTabWithMultiWindow = (reason: string) => (context: CommandContext) => ({
  available:
    context.capabilities?.includes('multi-window-v1') === true && context.selection?.tab === true,
  reason
})

export const DEFAULT_COMMANDS: readonly CommandDefinition[] = [
  {
    id: 'workspace.new',
    title: messages.commands.workspace.new.title,
    description: messages.commands.workspace.new.description,
    category: 'workspace',
    aliases: messages.commands.workspace.new.aliases,
    defaultShortcut: shortcut('Primary+O'),
    handler: handler('workspace.new')
  },
  {
    id: 'terminal.new',
    title: messages.commands.terminal.new.title,
    description: messages.commands.terminal.new.description,
    category: 'terminal',
    aliases: messages.commands.terminal.new.aliases,
    defaultShortcut: shortcut('Primary+T'),
    isAvailable: selected('pane', messages.commands.terminal.new.unavailable),
    handler: handler('terminal.new')
  },
  {
    id: 'tab.close',
    title: messages.commands.tab.close.title,
    description: messages.commands.tab.close.description,
    category: 'tabs',
    aliases: messages.commands.tab.close.aliases,
    defaultShortcut: shortcut('Primary+W'),
    isAvailable: selected('tab', messages.commands.tab.close.unavailable),
    handler: handler('tab.close')
  },
  {
    id: 'tab.duplicate',
    title: messages.commands.tab.duplicate.title,
    description: messages.commands.tab.duplicate.description,
    category: 'tabs',
    aliases: messages.commands.tab.duplicate.aliases,
    defaultShortcut: shortcut('Primary+Shift+K'),
    isAvailable: selectedTabWithMultiWindow(messages.commands.tab.duplicate.unavailable),
    handler: handler('tab.duplicate')
  },
  {
    id: 'tab.moveToWindow',
    title: messages.commands.tab.moveToWindow.title,
    description: messages.commands.tab.moveToWindow.description,
    category: 'tabs',
    aliases: messages.commands.tab.moveToWindow.aliases,
    defaultShortcut: shortcut('Primary+Shift+M'),
    isAvailable: selectedTabWithMultiWindow(messages.commands.tab.moveToWindow.unavailable),
    handler: handler('tab.moveToWindow')
  },
  {
    id: 'tab.detach',
    title: messages.commands.tab.detach.title,
    description: messages.commands.tab.detach.description,
    category: 'tabs',
    aliases: messages.commands.tab.detach.aliases,
    defaultShortcut: shortcut('Primary+Shift+O'),
    isAvailable: selectedTabWithMultiWindow(messages.commands.tab.detach.unavailable),
    handler: handler('tab.detach')
  },
  {
    id: 'tab.reopen',
    title: messages.commands.tab.reopen.title,
    description: messages.commands.tab.reopen.description,
    category: 'tabs',
    aliases: messages.commands.tab.reopen.aliases,
    defaultShortcut: shortcut('Primary+Shift+T'),
    isAvailable: multiWindow(messages.commands.tab.reopen.unavailable),
    handler: handler('tab.reopen')
  },
  {
    id: 'window.new',
    title: messages.commands.window.new.title,
    description: messages.commands.window.new.description,
    category: 'windows',
    aliases: messages.commands.window.new.aliases,
    defaultShortcut: shortcut('Primary+Shift+N'),
    isAvailable: multiWindow(messages.commands.window.new.unavailable),
    handler: handler('window.new')
  },
  {
    id: 'window.close',
    title: messages.commands.window.close.title,
    description: messages.commands.window.close.description,
    category: 'windows',
    aliases: messages.commands.window.close.aliases,
    defaultShortcut: shortcut('Primary+Shift+W'),
    isAvailable: multiWindow(messages.commands.window.close.unavailable),
    handler: handler('window.close')
  },
  {
    id: 'window.focusNext',
    title: messages.commands.window.focusNext.title,
    description: messages.commands.window.focusNext.description,
    category: 'windows',
    aliases: messages.commands.window.focusNext.aliases,
    defaultShortcut: shortcut('Primary+`'),
    isAvailable: multiWindow(messages.commands.window.focusNext.unavailable),
    handler: handler('window.focusNext')
  },
  {
    id: 'focusHistory.back',
    title: messages.commands.focusHistory.back.title,
    description: messages.commands.focusHistory.back.description,
    category: 'tabs',
    aliases: messages.commands.focusHistory.back.aliases,
    defaultShortcut: shortcut('Secondary+ArrowLeft'),
    isAvailable: multiWindow(messages.commands.focusHistory.back.unavailable),
    handler: handler('focusHistory.back')
  },
  {
    id: 'focusHistory.forward',
    title: messages.commands.focusHistory.forward.title,
    description: messages.commands.focusHistory.forward.description,
    category: 'tabs',
    aliases: messages.commands.focusHistory.forward.aliases,
    defaultShortcut: shortcut('Secondary+ArrowRight'),
    isAvailable: multiWindow(messages.commands.focusHistory.forward.unavailable),
    handler: handler('focusHistory.forward')
  },
  {
    id: 'pane.splitRight',
    title: messages.commands.pane.splitRight.title,
    description: messages.commands.pane.splitRight.description,
    category: 'panes',
    aliases: messages.commands.pane.splitRight.aliases,
    defaultShortcut: shortcut('Primary+D'),
    isAvailable: selected('pane', messages.commands.pane.splitRight.unavailable),
    handler: handler('pane.splitRight')
  },
  {
    id: 'pane.splitDown',
    title: messages.commands.pane.splitDown.title,
    description: messages.commands.pane.splitDown.description,
    category: 'panes',
    aliases: messages.commands.pane.splitDown.aliases,
    defaultShortcut: shortcut('Primary+Shift+D'),
    isAvailable: selected('pane', messages.commands.pane.splitDown.unavailable),
    handler: handler('pane.splitDown')
  },
  {
    id: 'sidebar.toggle',
    title: messages.commands.sidebar.toggle.title,
    description: messages.commands.sidebar.toggle.description,
    category: 'view',
    aliases: messages.commands.sidebar.toggle.aliases,
    defaultShortcut: shortcut('Primary+B'),
    handler: handler('sidebar.toggle')
  },
  {
    id: 'commandPalette.toggle',
    title: messages.commands.commandPalette.toggle.title,
    description: messages.commands.commandPalette.toggle.description,
    category: 'view',
    aliases: messages.commands.commandPalette.toggle.aliases,
    defaultShortcut: shortcut('Primary+Shift+P'),
    handler: handler('commandPalette.toggle')
  },
  {
    id: 'terminal.search',
    title: messages.commands.terminal.search.title,
    description: messages.commands.terminal.search.description,
    category: 'terminal',
    aliases: messages.commands.terminal.search.aliases,
    defaultShortcut: shortcut('Primary+F'),
    isAvailable: selected('terminal', messages.commands.terminal.search.unavailable),
    handler: handler('terminal.search')
  },
  {
    id: 'browser.openSplit',
    title: browserMessages.commands.openSplit.title,
    description: browserMessages.commands.openSplit.description,
    category: 'browser',
    aliases: browserMessages.commands.openSplit.aliases,
    defaultShortcut: shortcut('Primary+Shift+L'),
    isAvailable: activePaneWithCapability(
      'tab.openBrowser',
      browserMessages.commands.openSplit.unavailable
    ),
    handler: handler('browser.openSplit')
  },
  {
    id: 'browser.back',
    title: browserMessages.commands.back.title,
    description: browserMessages.commands.back.description,
    category: 'browser',
    aliases: browserMessages.commands.back.aliases,
    isAvailable: (context) => ({
      available:
        context.capabilities?.includes('browser.back') === true &&
        context.browser?.canBack === true,
      reason: browserMessages.commands.back.unavailable
    }),
    handler: handler('browser.back')
  },
  {
    id: 'browser.forward',
    title: browserMessages.commands.forward.title,
    description: browserMessages.commands.forward.description,
    category: 'browser',
    aliases: browserMessages.commands.forward.aliases,
    isAvailable: (context) => ({
      available:
        context.capabilities?.includes('browser.forward') === true &&
        context.browser?.canForward === true,
      reason: browserMessages.commands.forward.unavailable
    }),
    handler: handler('browser.forward')
  },
  {
    id: 'browser.reload',
    title: browserMessages.commands.reload.title,
    description: browserMessages.commands.reload.description,
    category: 'browser',
    aliases: browserMessages.commands.reload.aliases,
    isAvailable: activeBrowser('browser.reload', browserMessages.commands.reload.unavailable),
    handler: handler('browser.reload')
  },
  {
    id: 'browser.stop',
    title: browserMessages.commands.stop.title,
    description: browserMessages.commands.stop.description,
    category: 'browser',
    aliases: browserMessages.commands.stop.aliases,
    isAvailable: (context) => ({
      available:
        context.capabilities?.includes('browser.stop') === true &&
        context.browser?.loading === true,
      reason: browserMessages.commands.stop.unavailable
    }),
    handler: handler('browser.stop')
  },
  {
    id: 'browser.openDevTools',
    title: browserMessages.commands.openDeveloperTools.title,
    description: browserMessages.commands.openDeveloperTools.description,
    category: 'browser',
    aliases: browserMessages.commands.openDeveloperTools.aliases,
    isAvailable: activeBrowser(
      'browser.openDevTools',
      browserMessages.commands.openDeveloperTools.unavailable
    ),
    handler: handler('browser.openDevTools')
  },
  {
    id: 'notifications.toggle',
    title: messages.commands.notifications.toggle.title,
    description: messages.commands.notifications.toggle.description,
    category: 'notifications',
    aliases: messages.commands.notifications.toggle.aliases,
    defaultShortcut: shortcut('Primary+I'),
    handler: handler('notifications.toggle')
  },
  {
    id: 'notifications.latestUnread',
    title: messages.commands.notifications.latestUnread.title,
    description: messages.commands.notifications.latestUnread.description,
    category: 'notifications',
    aliases: messages.commands.notifications.latestUnread.aliases,
    defaultShortcut: shortcut('Primary+Shift+U'),
    handler: handler('notifications.latestUnread')
  },
  {
    id: 'settings.open',
    title: messages.commands.settings.open.title,
    description: messages.commands.settings.open.description,
    category: 'settings',
    aliases: messages.commands.settings.open.aliases,
    defaultShortcut: shortcut('Primary+Comma'),
    handler: handler('settings.open')
  }
]

export const defaultCommandRegistry = new CommandRegistry(DEFAULT_COMMANDS)
