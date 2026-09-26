import { describe, expect, it, vi } from 'vitest'

import { CommandRegistry, dispatchKeyboardCommand } from './registry'
import {
  deserializeShortcutOverrides,
  findShortcutConflicts,
  formatShortcut,
  parseShortcut,
  serializeShortcut,
  serializeShortcutOverrides,
  shortcutMatchesEvent,
  type KeyboardEventLike,
  type Shortcut
} from './shortcuts'
import type { CommandContext, CommandDefinition } from './types'
import { messages } from '../messages'

function parsed(value: string): Shortcut {
  const result = parseShortcut(value)
  if (!result.valid) throw new Error(result.reason)
  return result.shortcut
}

function event(
  key: string,
  modifiers: Partial<Omit<KeyboardEventLike, 'key'>> = {}
): KeyboardEventLike {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers
  }
}

const commands: readonly CommandDefinition[] = [
  {
    id: 'workspace.new',
    title: messages.commands.workspace.new.title,
    description: messages.commands.workspace.new.description,
    category: 'workspace',
    defaultShortcut: parsed('Primary+O'),
    handler: (context) => context.invoke('workspace.new')
  },
  {
    id: 'terminal.new',
    title: messages.commands.terminal.new.title,
    description: messages.commands.terminal.new.description,
    category: 'terminal',
    defaultShortcut: parsed('Primary+T'),
    handler: (context) => context.invoke('terminal.new')
  }
]

describe('logical shortcuts', () => {
  it('maps Primary and Secondary to macOS and non-macOS event modifiers', () => {
    const chord = parsed('Primary+Secondary+Shift+P')

    expect(
      shortcutMatchesEvent(
        chord,
        event('P', { metaKey: true, altKey: true, shiftKey: true }),
        'macos'
      )
    ).toBe(true)
    expect(
      shortcutMatchesEvent(
        chord,
        event('p', { ctrlKey: true, altKey: true, shiftKey: true }),
        'other'
      )
    ).toBe(true)
    expect(
      shortcutMatchesEvent(chord, event('p', { ctrlKey: true, shiftKey: true }), 'other')
    ).toBe(false)
  })

  it('formats shortcuts using platform conventions', () => {
    const chord = parsed('Shift+Primary+,')

    expect(serializeShortcut(chord)).toBe('Primary+Shift+Comma')
    expect(formatShortcut(chord, 'macos')).toBe('⌘⇧,')
    expect(formatShortcut(chord, 'other')).toBe('Ctrl+Shift+,')
  })

  it('normalizes aliases, modifier order, case, and named keys', () => {
    expect(parsed('shift+primary+p')).toEqual({ modifiers: ['Primary', 'Shift'], key: 'P' })
    expect(parsed('Ctrl+esc')).toEqual({ modifiers: ['Control'], key: 'Escape' })
    expect(parsed('Primary+F12')).toEqual({ modifiers: ['Primary'], key: 'F12' })
    expect(parseShortcut('Primary+Primary+N')).toEqual({
      valid: false,
      reason: messages.shortcutValidation.duplicateLogicalModifier('Primary')
    })
    expect(parseShortcut('Primary+')).toEqual({
      valid: false,
      reason: messages.shortcutValidation.emptyKeyOrModifier
    })
    expect(parseShortcut('Primary+Hyper+N')).toEqual({
      valid: false,
      reason: messages.shortcutValidation.unknownLogicalModifier('Hyper')
    })
    expect(parseShortcut('Primary+Shift')).toEqual({
      valid: false,
      reason: messages.shortcutValidation.missingNonModifierKey
    })
    expect(parseShortcut('Primary+?')).toEqual({
      valid: false,
      reason: messages.shortcutValidation.unsupportedNonModifierKey
    })
  })

  it('detects default and edited conflicts deterministically and removes cleared conflicts', () => {
    expect(findShortcutConflicts(commands, { 'terminal.new': parsed('Primary+O') })).toEqual([
      {
        shortcut: parsed('Primary+O'),
        commandIds: ['workspace.new', 'terminal.new']
      }
    ])
    expect(
      findShortcutConflicts(commands, {
        'workspace.new': null,
        'terminal.new': parsed('Primary+O')
      })
    ).toEqual([])
  })

  it('detects physical Primary and Control collisions on non-macOS', () => {
    expect(
      findShortcutConflicts(
        commands,
        {
          'workspace.new': parsed('Primary+K'),
          'terminal.new': parsed('Control+K')
        },
        'other'
      )
    ).toEqual([
      {
        shortcut: parsed('Primary+K'),
        commandIds: ['workspace.new', 'terminal.new']
      }
    ])
  })

  it('keeps Primary and Control distinct on macOS', () => {
    expect(
      findShortcutConflicts(
        commands,
        {
          'workspace.new': parsed('Primary+K'),
          'terminal.new': parsed('Control+K')
        },
        'macos'
      )
    ).toEqual([])
  })

  it('collapses duplicate physical modifiers when finding non-macOS conflicts', () => {
    const collapsedChord = parsed('Primary+Control+K')

    expect(
      findShortcutConflicts(commands, {
        'workspace.new': collapsedChord,
        'terminal.new': parsed('Primary+K')
      })
    ).toEqual([
      {
        shortcut: collapsedChord,
        commandIds: ['workspace.new', 'terminal.new']
      }
    ])
    expect(shortcutMatchesEvent(collapsedChord, event('k', { ctrlKey: true }), 'other')).toBe(true)
    expect(
      shortcutMatchesEvent(collapsedChord, event('k', { ctrlKey: true, metaKey: true }), 'macos')
    ).toBe(true)
  })

  it('serializes overrides using logical, platform-neutral chords and preserves explicit clears', () => {
    const serialized = serializeShortcutOverrides({
      'terminal.new': null,
      'workspace.new': parsed('Shift+Primary+N')
    })

    expect(serialized).toEqual({
      'terminal.new': null,
      'workspace.new': 'Primary+Shift+N'
    })
    expect(deserializeShortcutOverrides(serialized)).toEqual({
      overrides: {
        'terminal.new': null,
        'workspace.new': parsed('Primary+Shift+N')
      },
      errors: {}
    })
  })

  it('reports invalid serialized overrides without applying them', () => {
    expect(deserializeShortcutOverrides({ 'workspace.new': 'Primary+Hyper+N' })).toEqual({
      overrides: {},
      errors: {
        'workspace.new': messages.shortcutValidation.unknownLogicalModifier('Hyper')
      }
    })
  })
})

describe('keyboard dispatch', () => {
  it('lets an explicitly cleared shortcut fall through without consuming the event', async () => {
    const preventDefault = vi.fn()
    const invoke = vi.fn()
    const result = await dispatchKeyboardCommand(
      event('n', { ctrlKey: true, preventDefault }),
      new CommandRegistry(commands),
      { invoke },
      { 'workspace.new': null },
      'other'
    )

    expect(result).toEqual({ status: 'unmatched', consumed: false })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not consume composition events and consumes repeated project shortcuts without executing', async () => {
    const preventComposition = vi.fn()
    const preventRepeat = vi.fn()
    const context: CommandContext = { invoke: vi.fn() }
    const registry = new CommandRegistry(commands)

    await expect(
      dispatchKeyboardCommand(
        event('n', { ctrlKey: true, isComposing: true, preventDefault: preventComposition }),
        registry,
        context,
        {},
        'other'
      )
    ).resolves.toEqual({ status: 'composing', consumed: false })
    await expect(
      dispatchKeyboardCommand(
        event('o', { ctrlKey: true, repeat: true, preventDefault: preventRepeat }),
        registry,
        context,
        {},
        'other'
      )
    ).resolves.toEqual({ status: 'repeated', commandId: 'workspace.new', consumed: true })

    expect(preventComposition).not.toHaveBeenCalled()
    expect(preventRepeat).toHaveBeenCalledOnce()
    expect(context.invoke).not.toHaveBeenCalled()
  })
})
