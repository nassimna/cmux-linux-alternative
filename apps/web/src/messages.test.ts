import { describe, expect, it } from 'vitest'

import { messages } from './messages'

describe('renderer message catalog', () => {
  it('centralizes non-browser command definitions and availability reasons', () => {
    expect(messages.commands.workspace.new).toEqual({
      title: 'Open folder',
      description: 'Open a folder as a workspace.',
      aliases: ['create workspace', 'add workspace', 'open directory']
    })
    expect(messages.commands.pane.splitRight.unavailable).toBe('Select a workspace pane first.')
    expect(messages.commands.notifications.latestUnread.aliases).toEqual([
      'newest notification',
      'unread'
    ])
    expect(messages.commands.settings.open.description).toBe('Open application settings.')
  })

  it('formats shortcut validation and notification navigation copy', () => {
    expect(messages.shortcutValidation.unknownLogicalModifier('Hyper')).toBe(
      'Unknown logical modifier: Hyper'
    )
    expect(messages.shortcutValidation.duplicateLogicalModifier('Primary')).toBe(
      'Duplicate logical modifier: Primary'
    )
    expect(messages.shortcutValidation.unsupportedNonModifierKey).toBe(
      'Shortcut must contain one supported non-modifier key.'
    )
    expect(messages.shortcutValidation.emptyKeyOrModifier).toBe(
      'Shortcut contains an empty key or modifier.'
    )
    expect(messages.shortcutValidation.missingNonModifierKey).toBe(
      'Shortcut must contain a non-modifier key.'
    )
    expect(messages.notificationJump.notVisible).toBe(
      'The notification target could not be made visible.'
    )
    expect(messages.notificationJump.notOpened).toBe('The notification target could not be opened.')
    expect(messages.notificationJump.targetUnavailable).toBe(
      'This notification target is no longer available.'
    )
    expect(messages.notificationJump.centerCloseFailed).toBe(
      'The notification center did not close. Try opening the target again.'
    )
  })

  it('formats workspace projection errors without backend-owned copy', () => {
    expect(messages.workspaceProjection.errors.shuttingDown('service_shutdown')).toBe(
      'The workspace service is shutting down.'
    )
    expect(messages.workspaceProjection.errors.shuttingDown()).toBe(
      'The workspace service stopped unexpectedly.'
    )
    expect(messages.workspaceProjection.errors.revisionConflict).toBe(
      'The workspace changed elsewhere. Try the action again.'
    )
    expect(messages.workspaceProjection.errors.initializationFailed).toBe(
      'The workspace service could not be loaded. Try again.'
    )
  })

  it('formats attention summaries, plurals, overflow, and shared UI copy', () => {
    expect(messages.workspaceShell.sidebar.cardAccessibleName('Docs', 'none', 0)).toBe(
      'Docs; no attention'
    )
    expect(messages.workspaceShell.sidebar.cardAccessibleName('Docs', 'informational', 2)).toBe(
      'Docs; informational attention, 2 unread notifications'
    )
    expect(messages.workspaceShell.sidebar.cardAccessibleName('Docs', 'completed', 0)).toBe(
      'Docs; completed attention'
    )
    expect(messages.workspaceShell.sidebar.cardAccessibleName('Docs', 'waiting', 0)).toBe(
      'Docs; waiting for input'
    )
    expect(messages.workspaceShell.sidebar.cardAccessibleName('Docs', 'urgent', 1)).toBe(
      'Docs; urgent attention, 1 unread notification'
    )
    expect(messages.attentionBadge.accessibleSummary('Pane', 1, 'warning')).toBe(
      'Pane: 1 unread, highest severity warning'
    )
    expect(messages.attentionBadge.accessibleSummary('Workspace', 4, 'error', 'Build failed')).toBe(
      'Workspace: 4 unread, highest severity error, latest Build failed'
    )
    expect(messages.attentionBadge.displayCount(99)).toBe('99')
    expect(messages.attentionBadge.displayCount(100)).toBe('99+')
    expect(messages.notifications.unreadSummary(1)).toBe('1 unread notification.')
    expect(messages.notifications.unreadSummary(2)).toBe('2 unread notifications.')
    expect(messages.ui.closeDialog).toBe('Close dialog')
  })

  it('formats notification counts and grouping copy', () => {
    expect(messages.notifications.unreadSummary(0)).toBe('No unread notifications.')
    expect(messages.notifications.unreadSummary(1)).toBe('1 unread notification.')
    expect(messages.notifications.unreadSummary(2)).toBe('2 unread notifications.')
    expect(messages.notifications.groupLabel('unread', 'Today')).toBe('Unread · Today')
    expect(messages.notifications.showingCount(25, 240)).toBe('Showing 25 of 240 notifications.')
  })

  it('formats terminal prompts, errors, exits, links, and process identifiers', () => {
    expect(messages.terminalPane.pasteLinesPrompt(1)).toBe('Paste 1 line into the terminal?')
    expect(messages.terminalPane.pasteLinesPrompt(3)).toBe('Paste 3 lines into the terminal?')
    expect(
      messages.terminalPane.errors.withDetail(
        messages.terminalPane.errors.attachFailed,
        'connection refused'
      )
    ).toBe('Terminal attach failed. connection refused')
    expect(messages.terminalPane.exit.withSignal('SIGTERM')).toBe(
      'Process exited with signal SIGTERM'
    )
    expect(messages.terminalPane.exit.withCode(17)).toBe('Process exited with code 17')
    expect(messages.terminalPane.processId(1234)).toBe('PID 1234')
    expect(messages.terminalPane.openLink('https://example.test/')).toBe(
      'Open https://example.test/'
    )
  })

  it('formats workspace, pane, tab, notification, and shortcut copy', () => {
    expect(messages.workspaceShell.sidebar.workspaceCount(1)).toBe('1 workspace')
    expect(messages.workspaceShell.sidebar.workspaceCount(4)).toBe('4 workspaces')
    expect(messages.workspaceShell.sidebar.closeConfirmation('Docs')).toBe(
      'Close workspace “Docs”?'
    )
    expect(messages.workspaceShell.titlebar.openNotifications(0)).toBe('Open notifications')
    expect(messages.workspaceShell.titlebar.openNotifications(3)).toBe(
      'Open notifications, 3 unread'
    )
    expect(messages.workspaceShell.tab.splitPane('pane 2', 'right')).toBe('Split pane 2 right')
    expect(messages.workspaceShell.settingsShortcuts.conflict(['New workspace', 'New tab'])).toBe(
      'Conflicts with New workspace, New tab.'
    )
  })
})
