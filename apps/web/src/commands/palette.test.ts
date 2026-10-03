import { describe, expect, it, vi } from 'vitest'

import { searchCommands } from './palette'
import { DEFAULT_COMMANDS } from './registry'
import type { CommandContext } from './types'

const context: CommandContext = { invoke: vi.fn() }

describe('command palette search', () => {
  it('ranks exact titles ahead of aliases, prefixes, and fuzzy matches', () => {
    const matches = searchCommands(DEFAULT_COMMANDS, 'settings', [], context)
    expect(matches[0]?.command.id).toBe('settings.open')
    expect(matches[0]?.matchedField).toBe('title')

    const aliasMatches = searchCommands(DEFAULT_COMMANDS, 'preferences', [], context)
    expect(aliasMatches[0]?.command.id).toBe('settings.open')
    expect(aliasMatches[0]?.matchedField).toBe('alias')

    const fuzzyMatches = searchCommands(DEFAULT_COMMANDS, 'splt rght', [], context)
    expect(fuzzyMatches[0]?.command.id).toBe('pane.splitRight')
  })

  it('searches category and stable command ID fields', () => {
    expect(searchCommands(DEFAULT_COMMANDS, 'browser split', [], context)[0]?.command.id).toBe(
      'browser.openSplit'
    )
    expect(
      searchCommands(DEFAULT_COMMANDS, 'notifications latest', [], context)[0]?.command.id
    ).toBe('notifications.latestUnread')
  })

  it('uses recency deterministically while retaining registry order for stable ties', () => {
    const recent = searchCommands(
      DEFAULT_COMMANDS,
      '',
      ['terminal.search', 'workspace.new', 'terminal.search'],
      context
    )
    expect(recent.slice(0, 3).map((match) => match.command.id)).toEqual([
      'terminal.search',
      'workspace.new',
      'terminal.new'
    ])

    const stable = searchCommands(DEFAULT_COMMANDS, '', [], context)
    expect(stable.map((match) => match.command.id)).toEqual(
      DEFAULT_COMMANDS.map((command) => command.id)
    )
  })

  it('keeps unavailable commands visible with a reason', () => {
    const match = searchCommands(DEFAULT_COMMANDS, 'browser split', [], context)[0]

    expect(match?.command.id).toBe('browser.openSplit')
    expect(match?.available).toBe(false)
    expect(match?.unavailableReason).toBe('Embedded browsing is not supported by this service.')
  })
})
