import { describe, expect, it, vi } from 'vitest'

import { CommandRegistry, DEFAULT_COMMANDS, defaultCommandRegistry } from './registry'
import {
  WORKSPACE_CARD_ACTION_DEFINITIONS,
  WORKSPACE_CARD_ACTION_IDS,
  WorkspaceCardActionRegistry,
  workspaceCardActionRegistry,
  type CommandContext,
  type CommandDefinition,
  type CommandId
} from './types'
import { browserMessages } from '@agent-workspace/contracts/desktop/browser-messages'
import { messages } from '../messages'

describe('CommandRegistry', () => {
  it('contains every required default command exactly once', () => {
    expect(DEFAULT_COMMANDS.map((command) => command.id)).toEqual([
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
    ])
  })

  it('owns canonical action IDs for every workspace card interaction', () => {
    expect(WORKSPACE_CARD_ACTION_IDS).toEqual([
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
    ])
    expect(
      WORKSPACE_CARD_ACTION_DEFINITIONS.map(({ actionId, commandId, key }) => [
        key,
        actionId,
        commandId
      ])
    ).toEqual([
      ['select', 'workspace.card.select', 'workspace.select'],
      ['openPath', 'workspace.card.openPath', 'workspace.openPath'],
      ['reorder', 'workspace.card.reorder', 'workspace.move'],
      ['close', 'workspace.card.close', 'workspace.close'],
      ['rename', 'workspace.card.rename', 'workspace.update'],
      ['color', 'workspace.card.color', 'workspace.update'],
      ['colorSet', 'workspace.card.color.set', 'workspace.update'],
      ['colorChoose', 'workspace.card.color.custom', 'workspace.update'],
      ['colorClear', 'workspace.card.color.clear', 'workspace.update'],
      ['duplicate', 'workspace.card.duplicate', 'workspace.create'],
      ['moveUp', 'workspace.card.move.up', 'workspace.move'],
      ['moveDown', 'workspace.card.move.down', 'workspace.move'],
      ['pin', 'workspace.card.pin', 'workspace.pin'],
      ['assignGroup', 'workspace.card.assignGroup', 'group.assign'],
      ['attention', 'workspace.card.attention', 'attention.acknowledge'],
      ['closeSelected', 'workspace.card.closeSelected', 'workspace.closeSelected'],
      ['groupCreate', 'workspace.group.create', 'group.create'],
      ['groupRename', 'workspace.group.rename', 'group.rename'],
      ['groupDelete', 'workspace.group.delete', 'group.delete'],
      ['groupMove', 'workspace.group.move', 'group.move'],
      ['groupCollapse', 'workspace.group.collapse', 'group.collapse'],
      ['layoutSave', 'workspace.layout.save', 'layout.save'],
      ['layoutImport', 'workspace.layout.import', 'layout.import'],
      ['layoutApply', 'workspace.layout.apply', 'layout.apply'],
      ['layoutExport', 'workspace.layout.export', 'layout.export'],
      ['layoutDelete', 'workspace.layout.delete', 'layout.delete']
    ])
    for (const definition of WORKSPACE_CARD_ACTION_DEFINITIONS) {
      expect(workspaceCardActionRegistry.resolve(definition.key)).toEqual(definition)
    }
    expect(
      () =>
        new WorkspaceCardActionRegistry([
          {
            key: 'duplicate-key',
            actionId: 'workspace.card.select',
            commandId: 'workspace.select'
          },
          {
            key: 'duplicate-key',
            actionId: 'workspace.card.reorder',
            commandId: 'workspace.move'
          }
        ])
    ).toThrow('Duplicate workspace card action key: duplicate-key')
    expect(
      () =>
        new WorkspaceCardActionRegistry([
          {
            key: 'first-key',
            actionId: 'workspace.card.select',
            commandId: 'workspace.select'
          },
          {
            key: 'second-key',
            actionId: 'workspace.card.select',
            commandId: 'workspace.move'
          }
        ])
    ).toThrow('Duplicate workspace card action ID: workspace.card.select')
  })

  it('executes available commands through the shared action path', async () => {
    const invoke = vi.fn()

    await expect(defaultCommandRegistry.execute('workspace.new', { invoke })).resolves.toEqual({
      status: 'executed',
      commandId: 'workspace.new'
    })
    expect(invoke).toHaveBeenCalledWith('workspace.new')
  })

  it('gates browser splits on the negotiated tab.openBrowser capability', async () => {
    const invoke = vi.fn()

    await expect(defaultCommandRegistry.execute('browser.openSplit', { invoke })).resolves.toEqual({
      status: 'unavailable',
      commandId: 'browser.openSplit',
      reason: 'Embedded browsing is not supported by this service.'
    })
    expect(invoke).not.toHaveBeenCalled()

    await expect(
      defaultCommandRegistry.execute('browser.openSplit', {
        invoke,
        capabilities: ['tab.openBrowser']
      })
    ).resolves.toEqual({ status: 'executed', commandId: 'browser.openSplit' })
    expect(invoke).toHaveBeenCalledWith('browser.openSplit')
  })

  it('sources all browser command copy from the shared catalog', () => {
    const commands = new Map(DEFAULT_COMMANDS.map((command) => [command.id, command]))
    const pairs = [
      ['browser.openSplit', browserMessages.commands.openSplit],
      ['browser.back', browserMessages.commands.back],
      ['browser.forward', browserMessages.commands.forward],
      ['browser.reload', browserMessages.commands.reload],
      ['browser.stop', browserMessages.commands.stop],
      ['browser.openDevTools', browserMessages.commands.openDeveloperTools]
    ] as const
    for (const [commandId, messages] of pairs) {
      expect(commands.get(commandId)).toMatchObject({
        title: messages.title,
        description: messages.description,
        aliases: messages.aliases
      })
    }
  })

  it('sources all renderer command copy from the renderer catalog', () => {
    const commands = new Map(DEFAULT_COMMANDS.map((command) => [command.id, command]))
    const pairs = [
      ['workspace.new', messages.commands.workspace.new],
      ['terminal.new', messages.commands.terminal.new],
      ['tab.close', messages.commands.tab.close],
      ['pane.splitRight', messages.commands.pane.splitRight],
      ['pane.splitDown', messages.commands.pane.splitDown],
      ['sidebar.toggle', messages.commands.sidebar.toggle],
      ['commandPalette.toggle', messages.commands.commandPalette.toggle],
      ['terminal.search', messages.commands.terminal.search],
      ['notifications.toggle', messages.commands.notifications.toggle],
      ['notifications.latestUnread', messages.commands.notifications.latestUnread],
      ['settings.open', messages.commands.settings.open]
    ] as const

    for (const [commandId, commandMessages] of pairs) {
      expect(commands.get(commandId)).toMatchObject({
        title: commandMessages.title,
        description: commandMessages.description,
        aliases: commandMessages.aliases
      })
    }
  })

  it('uses catalog-derived renderer command unavailable reasons', async () => {
    const selection = { workspace: true, pane: true, tab: true, terminal: true }

    await expect(
      defaultCommandRegistry.execute('terminal.new', {
        invoke: vi.fn(),
        selection: { ...selection, pane: false }
      })
    ).resolves.toMatchObject({ reason: messages.commands.terminal.new.unavailable })
    await expect(
      defaultCommandRegistry.execute('tab.close', {
        invoke: vi.fn(),
        selection: { ...selection, tab: false }
      })
    ).resolves.toMatchObject({ reason: messages.commands.tab.close.unavailable })
    await expect(
      defaultCommandRegistry.execute('pane.splitRight', {
        invoke: vi.fn(),
        selection: { ...selection, pane: false }
      })
    ).resolves.toMatchObject({ reason: messages.commands.pane.splitRight.unavailable })
    await expect(
      defaultCommandRegistry.execute('pane.splitDown', {
        invoke: vi.fn(),
        selection: { ...selection, pane: false }
      })
    ).resolves.toMatchObject({ reason: messages.commands.pane.splitDown.unavailable })
    await expect(
      defaultCommandRegistry.execute('terminal.search', {
        invoke: vi.fn(),
        selection: { ...selection, terminal: false }
      })
    ).resolves.toMatchObject({ reason: messages.commands.terminal.search.unavailable })
  })

  it('gates browser navigation on capability and active browser state', async () => {
    const invoke = vi.fn()
    const context = {
      invoke,
      capabilities: ['browser.back', 'browser.forward', 'browser.reload', 'browser.stop'],
      browser: { canBack: false, canForward: true, loading: true }
    }
    await expect(defaultCommandRegistry.execute('browser.back', context)).resolves.toMatchObject({
      status: 'unavailable'
    })
    await expect(defaultCommandRegistry.execute('browser.forward', context)).resolves.toMatchObject(
      {
        status: 'executed'
      }
    )
    await expect(defaultCommandRegistry.execute('browser.stop', context)).resolves.toMatchObject({
      status: 'executed'
    })
  })

  it('enables implemented window actions and gates detach separately', async () => {
    const invoke = vi.fn<CommandContext['invoke']>()
    const ids = [
      'tab.duplicate',
      'tab.moveToWindow',
      'tab.detach',
      'tab.reopen',
      'window.new',
      'window.close',
      'window.focusNext',
      'focusHistory.back',
      'focusHistory.forward'
    ] as const
    for (const id of ids) {
      await expect(
        defaultCommandRegistry.execute(id, {
          invoke,
          selection: { workspace: true, pane: true, tab: true, terminal: true }
        })
      ).resolves.toMatchObject({ status: 'unavailable' })
      await expect(
        defaultCommandRegistry.execute(id, {
          invoke,
          capabilities: [
            'multi-window-v1',
            'tab.duplicateExact',
            'tab.moveExact',
            'tab.reopen',
            'focusHistory.navigate',
            ...(id === 'tab.detach' ? ['tab.detachExact'] : [])
          ],
          selection: { workspace: true, pane: true, tab: true, terminal: true }
        })
      ).resolves.toMatchObject({ status: 'executed' })
    }
    expect(invoke.mock.calls.map(([id]) => id)).toEqual(ids)
    await expect(
      defaultCommandRegistry.execute('tab.detach', {
        invoke,
        capabilities: ['multi-window-v1', 'tab.duplicateExact', 'tab.moveExact'],
        selection: { workspace: true, pane: true, tab: true, terminal: true }
      })
    ).resolves.toMatchObject({ status: 'unavailable' })
  })

  it('returns handler failures as UI-friendly results', async () => {
    const error = new Error('action failed')
    const command: CommandDefinition = {
      id: 'workspace.new',
      title: messages.commands.workspace.new.title,
      description: messages.commands.workspace.new.description,
      category: 'workspace',
      handler: () => {
        throw error
      }
    }

    await expect(
      new CommandRegistry([command]).execute(command.id, { invoke: vi.fn() })
    ).resolves.toEqual({ status: 'failed', commandId: 'workspace.new', error })
  })

  it('rejects duplicate IDs and reports unknown IDs without throwing', async () => {
    const command = DEFAULT_COMMANDS[0]
    expect(command).toBeDefined()
    expect(() => new CommandRegistry([command!, command!])).toThrow(
      'Duplicate command ID: workspace.new'
    )

    const unknown = 'unknown.command' as CommandId
    await expect(defaultCommandRegistry.execute(unknown, { invoke: vi.fn() })).resolves.toEqual({
      status: 'not-found',
      commandId: unknown
    })
  })
})
