export const COMMAND_IDS = [
  'workspace.new',
  'terminal.new',
  'tab.close',
  'tab.duplicate',
  'tab.moveToWindow',
  'tab.detach',
  'tab.reopen',
  'window.new',
  'window.close',
  'window.focusNext',
  'focusHistory.back',
  'focusHistory.forward',
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

export type CommandId = (typeof COMMAND_IDS)[number]

export const WORKSPACE_CARD_ACTION_IDS = [
  'workspace.card.select',
  'workspace.card.openPath',
  'workspace.card.reorder',
  'workspace.card.close',
  'workspace.card.rename',
  'workspace.card.color',
  'workspace.card.color.set',
  'workspace.card.color.custom',
  'workspace.card.color.clear',
  'workspace.card.duplicate',
  'workspace.card.move.up',
  'workspace.card.move.down',
  'workspace.card.pin',
  'workspace.card.assignGroup',
  'workspace.card.attention',
  'workspace.card.closeSelected',
  'workspace.group.create',
  'workspace.group.rename',
  'workspace.group.delete',
  'workspace.group.move',
  'workspace.group.collapse',
  'workspace.layout.save',
  'workspace.layout.import',
  'workspace.layout.apply',
  'workspace.layout.export',
  'workspace.layout.delete'
] as const

export type WorkspaceCardActionId = (typeof WORKSPACE_CARD_ACTION_IDS)[number]
export type WorkspaceCardCommandId =
  | 'workspace.select'
  | 'workspace.openPath'
  | 'workspace.move'
  | 'workspace.close'
  | 'workspace.update'
  | 'workspace.create'
  | 'workspace.pin'
  | 'workspace.closeSelected'
  | 'group.create'
  | 'group.rename'
  | 'group.delete'
  | 'group.move'
  | 'group.assign'
  | 'group.collapse'
  | 'attention.acknowledge'
  | 'layout.save'
  | 'layout.import'
  | 'layout.apply'
  | 'layout.export'
  | 'layout.delete'

interface WorkspaceCardActionDefinition {
  readonly key: string
  readonly actionId: WorkspaceCardActionId
  readonly commandId: WorkspaceCardCommandId
}

export const WORKSPACE_CARD_ACTION_DEFINITIONS = [
  { key: 'select', actionId: 'workspace.card.select', commandId: 'workspace.select' },
  { key: 'openPath', actionId: 'workspace.card.openPath', commandId: 'workspace.openPath' },
  { key: 'reorder', actionId: 'workspace.card.reorder', commandId: 'workspace.move' },
  { key: 'close', actionId: 'workspace.card.close', commandId: 'workspace.close' },
  { key: 'rename', actionId: 'workspace.card.rename', commandId: 'workspace.update' },
  { key: 'color', actionId: 'workspace.card.color', commandId: 'workspace.update' },
  { key: 'colorSet', actionId: 'workspace.card.color.set', commandId: 'workspace.update' },
  {
    key: 'colorChoose',
    actionId: 'workspace.card.color.custom',
    commandId: 'workspace.update'
  },
  { key: 'colorClear', actionId: 'workspace.card.color.clear', commandId: 'workspace.update' },
  { key: 'duplicate', actionId: 'workspace.card.duplicate', commandId: 'workspace.create' },
  { key: 'moveUp', actionId: 'workspace.card.move.up', commandId: 'workspace.move' },
  { key: 'moveDown', actionId: 'workspace.card.move.down', commandId: 'workspace.move' },
  { key: 'pin', actionId: 'workspace.card.pin', commandId: 'workspace.pin' },
  { key: 'assignGroup', actionId: 'workspace.card.assignGroup', commandId: 'group.assign' },
  { key: 'attention', actionId: 'workspace.card.attention', commandId: 'attention.acknowledge' },
  {
    key: 'closeSelected',
    actionId: 'workspace.card.closeSelected',
    commandId: 'workspace.closeSelected'
  },
  { key: 'groupCreate', actionId: 'workspace.group.create', commandId: 'group.create' },
  { key: 'groupRename', actionId: 'workspace.group.rename', commandId: 'group.rename' },
  { key: 'groupDelete', actionId: 'workspace.group.delete', commandId: 'group.delete' },
  { key: 'groupMove', actionId: 'workspace.group.move', commandId: 'group.move' },
  {
    key: 'groupCollapse',
    actionId: 'workspace.group.collapse',
    commandId: 'group.collapse'
  },
  { key: 'layoutSave', actionId: 'workspace.layout.save', commandId: 'layout.save' },
  { key: 'layoutImport', actionId: 'workspace.layout.import', commandId: 'layout.import' },
  { key: 'layoutApply', actionId: 'workspace.layout.apply', commandId: 'layout.apply' },
  { key: 'layoutExport', actionId: 'workspace.layout.export', commandId: 'layout.export' },
  { key: 'layoutDelete', actionId: 'workspace.layout.delete', commandId: 'layout.delete' }
] as const satisfies readonly WorkspaceCardActionDefinition[]

export type WorkspaceCardActionKey = (typeof WORKSPACE_CARD_ACTION_DEFINITIONS)[number]['key']

export class WorkspaceCardActionRegistry {
  readonly #byKey: ReadonlyMap<string, WorkspaceCardActionDefinition>

  constructor(definitions: readonly WorkspaceCardActionDefinition[]) {
    const byKey = new Map<string, WorkspaceCardActionDefinition>()
    const actionIds = new Set<WorkspaceCardActionId>()
    for (const definition of definitions) {
      if (byKey.has(definition.key)) {
        throw new Error(`Duplicate workspace card action key: ${definition.key}`)
      }
      if (actionIds.has(definition.actionId)) {
        throw new Error(`Duplicate workspace card action ID: ${definition.actionId}`)
      }
      byKey.set(definition.key, definition)
      actionIds.add(definition.actionId)
    }
    this.#byKey = byKey
  }

  resolve(key: WorkspaceCardActionKey): WorkspaceCardActionDefinition {
    const definition = this.#byKey.get(key)
    if (!definition) throw new Error(`Unknown workspace card action key: ${key}`)
    return definition
  }
}

export const workspaceCardActionRegistry = new WorkspaceCardActionRegistry(
  WORKSPACE_CARD_ACTION_DEFINITIONS
)

export const COMMAND_CATEGORIES = [
  'workspace',
  'terminal',
  'tabs',
  'windows',
  'panes',
  'view',
  'browser',
  'notifications',
  'settings'
] as const

export type CommandCategory = (typeof COMMAND_CATEGORIES)[number]

export type CommandAvailability =
  | boolean
  | {
      readonly available: boolean
      readonly reason?: string
    }

export interface CommandContext {
  /** Invokes the application's shared action path for the command. */
  readonly invoke: (commandId: CommandId) => void | Promise<void>
  readonly capabilities?: readonly string[]
  readonly browser?: {
    readonly canBack: boolean
    readonly canForward: boolean
    readonly loading: boolean
  } | null
  readonly selection?: {
    readonly workspace: boolean
    readonly pane: boolean
    readonly tab: boolean
    readonly terminal: boolean
  }
}

export type CommandAvailabilityPredicate = (context: CommandContext) => CommandAvailability
export type CommandHandler = (context: CommandContext) => void | Promise<void>

export interface CommandDefinition {
  readonly id: CommandId
  readonly title: string
  readonly description: string
  readonly category: CommandCategory
  readonly aliases?: readonly string[]
  readonly defaultShortcut?: Shortcut
  readonly isAvailable?: CommandAvailabilityPredicate
  readonly handler: CommandHandler
  /** Most application commands should not execute repeatedly while a key is held. */
  readonly allowRepeat?: boolean
}

export type CommandExecutionResult =
  | { readonly status: 'executed'; readonly commandId: CommandId }
  | { readonly status: 'not-found'; readonly commandId: CommandId }
  | {
      readonly status: 'unavailable'
      readonly commandId: CommandId
      readonly reason?: string
    }
  | { readonly status: 'failed'; readonly commandId: CommandId; readonly error: unknown }

export function resolveCommandAvailability(
  command: CommandDefinition,
  context: CommandContext
): { readonly available: boolean; readonly reason?: string } {
  const result = command.isAvailable?.(context) ?? true
  if (typeof result === 'boolean') {
    return { available: result }
  }
  return result.available || result.reason === undefined
    ? { available: result.available }
    : { available: result.available, reason: result.reason }
}
import type { Shortcut } from './shortcuts'
