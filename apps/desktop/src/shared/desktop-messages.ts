export interface DesktopMessages {
  readonly applicationName: string
  readonly applicationMenu: {
    readonly file: string
    readonly edit: string
    readonly view: string
    readonly window: string
    readonly browser: string
    readonly notifications: string
    readonly newWorkspace: string
    readonly newTerminal: string
    readonly settings: string
    readonly exit: string
    readonly quit: string
    readonly findInTerminal: string
    readonly toggleSidebar: string
    readonly commandPalette: string
    readonly browserBack: string
    readonly browserForward: string
    readonly browserReload: string
    readonly browserStop: string
    readonly openDeveloperTools: string
    readonly showNotifications: string
    readonly latestUnread: string
    readonly splitRight: string
    readonly splitDown: string
    readonly openBrowserSplit: string
  }
  readonly exportDialogs: {
    readonly recovery: {
      readonly title: string
      readonly button: string
      readonly filter: string
      readonly overwriteRejected: string
    }
    readonly diagnostics: {
      readonly title: string
      readonly button: string
      readonly filter: string
      readonly overwriteRejected: string
    }
  }
  readonly lifecycleController: {
    readonly recovering: string
    readonly restartFailed: string
    readonly unsafeShutdown: string
    readonly recoveryRequired: string
  }
  readonly remoteConfirmations: {
    readonly cancel: string
    readonly trustHostKey: {
      readonly title: string
      readonly reject: string
      readonly trust: string
      readonly message: string
    }
    readonly replaceHostKey: {
      readonly title: string
      readonly reject: string
      readonly trust: string
      readonly message: string
    }
    readonly deleteTarget: {
      readonly title: string
      readonly button: string
      readonly message: string
      readonly detail: string
    }
    readonly closeSession: {
      readonly title: string
      readonly button: string
      readonly message: string
      readonly detail: string
    }
  }
  readonly agentHibernation: {
    readonly title: string
    readonly cancel: string
    readonly confirm: string
    readonly message: string
    readonly detail: string
    readonly checkpointDetail: string
  }
  readonly updater: { readonly failure: string }
}

export const desktopMessages: DesktopMessages = {
  applicationName: 'Agent Workspace',
  applicationMenu: {
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
  },
  exportDialogs: {
    recovery: {
      title: 'Export a private workspace recovery copy',
      button: 'Export private copy',
      filter: 'SQLite database',
      overwriteRejected: 'Choose a new destination; recovery exports never overwrite existing files'
    },
    diagnostics: {
      title: 'Export approved diagnostics',
      button: 'Export diagnostics',
      filter: 'JSON diagnostic bundle',
      overwriteRejected:
        'Choose a new destination; diagnostic exports never overwrite existing files'
    }
  },
  lifecycleController: {
    recovering:
      'The local service stopped. Live terminal processes were lost; durable workspace metadata will be restored.',
    restartFailed: 'The local service could not be restarted. You can try again or quit safely.',
    unsafeShutdown:
      'The local service could not be stopped safely. Try again, or wait for recovery before quitting.',
    recoveryRequired: 'The local workspace database requires recovery before the service can start.'
  },
  remoteConfirmations: {
    cancel: 'Cancel',
    trustHostKey: {
      title: 'Confirm remote host key',
      reject: 'Reject',
      trust: 'Trust and save this key',
      message: 'Verify this exact host key using an independent trusted channel.'
    },
    replaceHostKey: {
      title: 'Replace changed remote host key?',
      reject: 'Keep blocked',
      trust: 'Replace trusted key',
      message:
        'The saved host key changed or was revoked. Verify this replacement using an independent trusted channel.'
    },
    deleteTarget: {
      title: 'Delete remote target?',
      button: 'Delete target',
      message: 'Delete this remote target and its trusted SSH artifacts?',
      detail: 'Active sessions will be closed. Secure cleanup is retried if it cannot finish.'
    },
    closeSession: {
      title: 'Close remote session?',
      button: 'Close session',
      message: 'Close this exact remote session?',
      detail: 'The current transport will be terminated. This cannot be undone.'
    }
  },
  agentHibernation: {
    title: 'Hibernate agent session?',
    cancel: 'Leave running',
    confirm: 'Hibernate and terminate',
    message: 'Hibernate this exact agent session and terminate its current process?',
    detail:
      'The trusted service will preserve only verified recovery state. Unverified work may be lost.',
    checkpointDetail: 'A verified checkpoint is available for this session.'
  },
  updater: {
    failure: 'The update operation failed. Try again later.'
  }
}
