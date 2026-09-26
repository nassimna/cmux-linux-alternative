import { describe, expect, it } from 'vitest'

import { parseApplicationMenuCommandId, parseApplicationMenuState } from './application-menu'

describe('application menu boundary', () => {
  it('accepts bounded command state with canonical logical shortcuts', () => {
    expect(
      parseApplicationMenuState({
        commands: [
          {
            commandId: 'workspace.new',
            enabled: true,
            shortcut: { modifiers: ['Primary', 'Shift'], key: 'N' }
          },
          { commandId: 'terminal.new', enabled: false, shortcut: null }
        ]
      })
    ).toEqual({
      commands: [
        {
          commandId: 'workspace.new',
          enabled: true,
          shortcut: { modifiers: ['Primary', 'Shift'], key: 'N' }
        },
        { commandId: 'terminal.new', enabled: false, shortcut: null }
      ]
    })
    expect(parseApplicationMenuCommandId('settings.open')).toBe('settings.open')
  })

  it.each([
    { commands: [{ commandId: 'tab.close', enabled: true, shortcut: null }] },
    { commands: [{ commandId: 'shell.exec', enabled: true, shortcut: null }] },
    {
      commands: [
        { commandId: 'workspace.new', enabled: true, shortcut: null },
        { commandId: 'workspace.new', enabled: false, shortcut: null }
      ]
    },
    {
      commands: [
        {
          commandId: 'workspace.new',
          enabled: true,
          shortcut: { modifiers: ['Shift', 'Primary'], key: 'N' }
        }
      ]
    },
    {
      commands: [
        {
          commandId: 'workspace.new',
          enabled: true,
          shortcut: { modifiers: ['Primary'], key: 'LaunchShell' }
        }
      ]
    },
    { commands: [], extra: true }
  ])('rejects unknown, destructive, duplicate, or non-canonical state %#', (value) => {
    expect(() => parseApplicationMenuState(value)).toThrow()
  })
})
