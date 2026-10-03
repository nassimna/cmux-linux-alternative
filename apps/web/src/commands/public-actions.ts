import type { ActionDefinition } from '@agent-workspace/protocol-client'

import type { CommandDefinition, CommandId } from './types'
import { parseShortcut } from './shortcuts'

const PUBLIC_COMMAND_PREFIX = 'public-action:'
const PARAMETERLESS_ACTIONS = new Set(['desktop.window.focus'])

export interface PublicActionCommand {
  readonly action: ActionDefinition
  readonly command: CommandDefinition
  readonly callableFromPalette: boolean
}

/**
 * Adapts content-free public definitions to palette records without treating renderer state as
 * authority. Parameterized Tier-A actions stay discoverable but disabled until their typed UI
 * adapter supplies the required selection payload.
 */
export function publicActionCommands(
  definitions: readonly ActionDefinition[],
  invoke: (definition: ActionDefinition) => Promise<void>
): readonly PublicActionCommand[] {
  const commandIds = new Set<string>()
  return definitions.map((action) => {
    const id = publicActionCommandId(action)
    if (commandIds.has(id)) throw new Error('Duplicate public action command identity')
    commandIds.add(id)
    const callableFromPalette = isParameterlessPaletteAction(action)
    return {
      action,
      callableFromPalette,
      command: {
        id: id as CommandId,
        title: action.displayTitle ?? humanizeActionId(action.actionId),
        description: callableFromPalette
          ? `Run ${action.actionId} through the authenticated public action service.`
          : `Discoverable as ${action.actionId}; this action requires its typed UI or CLI parameters.`,
        category: commandCategory(action.category),
        aliases: [action.actionId, action.localizedTitleKey],
        ...(action.defaultShortcut === undefined
          ? {}
          : { defaultShortcut: requiredShortcut(action.defaultShortcut) }),
        isAvailable: () => ({
          available: callableFromPalette,
          ...(callableFromPalette
            ? {}
            : { reason: 'Use the action’s typed UI or CLI entry point.' })
        }),
        handler: () => invoke(action)
      }
    }
  })
}

function requiredShortcut(value: string): NonNullable<CommandDefinition['defaultShortcut']> {
  const parsed = parseShortcut(value)
  if (!parsed.valid) throw new Error('Public action contains an invalid default shortcut')
  return parsed.shortcut
}

export function publicActionCommandId(action: ActionDefinition): string {
  return `${PUBLIC_COMMAND_PREFIX}${action.actionId}@${String(action.actionVersion)}`
}

export function isPublicActionCommandId(value: string): boolean {
  return value.startsWith(PUBLIC_COMMAND_PREFIX)
}

function isParameterlessPaletteAction(action: ActionDefinition): boolean {
  return PARAMETERLESS_ACTIONS.has(action.actionId) || action.actionId.startsWith('project.')
}

function humanizeActionId(actionId: string): string {
  const words = actionId
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toLocaleUpperCase('en-US')}${word.slice(1)}`)
  return words.join(' ')
}

function commandCategory(category: string): CommandDefinition['category'] {
  switch (category) {
    case 'terminal':
    case 'tabs':
    case 'windows':
    case 'panes':
    case 'view':
    case 'browser':
    case 'notifications':
    case 'settings':
      return category
    default:
      return 'workspace'
  }
}
