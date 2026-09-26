import { describe, expect, it } from 'vitest'

import { desktopMessages } from './desktop-messages'

describe('desktop message catalog', () => {
  it('centralizes the application identity and explicit native menu labels', () => {
    expect(desktopMessages.applicationName).toBe('Agent Workspace')
    expect(desktopMessages.applicationMenu).toEqual({
      file: 'File',
      edit: 'Edit',
      view: 'View',
      window: 'Window',
      browser: 'Browser',
      notifications: 'Notifications',
      newWorkspace: 'Open Folder…',
      newTerminal: 'New Terminal',
      settings: 'Settings',
      exit: 'Exit',
      quit: 'Quit',
      findInTerminal: 'Find in Terminal',
      toggleSidebar: 'Toggle Sidebar',
      commandPalette: 'Command Palette',
      browserBack: 'Back',
      browserForward: 'Forward',
      browserReload: 'Reload',
      browserStop: 'Stop',
      openDeveloperTools: 'Open Developer Tools',
      showNotifications: 'Show Notifications',
      latestUnread: 'Latest Unread',
      splitRight: 'Split Right',
      splitDown: 'Split Down',
      openBrowserSplit: 'Open Browser Split'
    })
  })

  it('centralizes recovery and diagnostic export dialog copy', () => {
    expect(desktopMessages.exportDialogs.recovery).toEqual({
      title: 'Export a private workspace recovery copy',
      button: 'Export private copy',
      filter: 'SQLite database',
      overwriteRejected: 'Choose a new destination; recovery exports never overwrite existing files'
    })
    expect(desktopMessages.exportDialogs.diagnostics).toEqual({
      title: 'Export approved diagnostics',
      button: 'Export diagnostics',
      filter: 'JSON diagnostic bundle',
      overwriteRejected:
        'Choose a new destination; diagnostic exports never overwrite existing files'
    })
  })

  it('centralizes lifecycle and updater failure state copy', () => {
    expect(desktopMessages.lifecycleController.recovering).toContain(
      'durable workspace metadata will be restored'
    )
    expect(desktopMessages.lifecycleController.restartFailed).toBe(
      'The local service could not be restarted. You can try again or quit safely.'
    )
    expect(desktopMessages.lifecycleController.unsafeShutdown).toBe(
      'The local service could not be stopped safely. Try again, or wait for recovery before quitting.'
    )
    expect(desktopMessages.lifecycleController.recoveryRequired).toBe(
      'The local workspace database requires recovery before the service can start.'
    )
    expect(desktopMessages.updater.failure).toBe('The update operation failed. Try again later.')
  })
})
