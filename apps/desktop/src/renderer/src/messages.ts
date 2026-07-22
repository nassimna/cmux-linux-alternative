import type { AttentionState } from '@agent-workspace/protocol-client'

export type NotificationReadStatus = 'read' | 'unread'

export type PaneDropDirection = 'left' | 'right' | 'top' | 'bottom'

export type WorkspaceShutdownReason = 'service_shutdown'

export interface CommandDefinitionMessages {
  readonly title: string
  readonly description: string
  readonly aliases: readonly string[]
  readonly unavailable?: string
}

export interface RendererCommandMessages {
  readonly workspace: { readonly new: CommandDefinitionMessages }
  readonly terminal: {
    readonly new: CommandDefinitionMessages
    readonly search: CommandDefinitionMessages
  }
  readonly tab: {
    readonly close: CommandDefinitionMessages
    readonly duplicate: CommandDefinitionMessages
    readonly moveToWindow: CommandDefinitionMessages
    readonly detach: CommandDefinitionMessages
    readonly reopen: CommandDefinitionMessages
  }
  readonly window: {
    readonly new: CommandDefinitionMessages
    readonly close: CommandDefinitionMessages
    readonly focusNext: CommandDefinitionMessages
  }
  readonly focusHistory: {
    readonly back: CommandDefinitionMessages
    readonly forward: CommandDefinitionMessages
  }
  readonly pane: {
    readonly splitRight: CommandDefinitionMessages
    readonly splitDown: CommandDefinitionMessages
  }
  readonly sidebar: { readonly toggle: CommandDefinitionMessages }
  readonly commandPalette: { readonly toggle: CommandDefinitionMessages }
  readonly notifications: {
    readonly toggle: CommandDefinitionMessages
    readonly latestUnread: CommandDefinitionMessages
  }
  readonly settings: { readonly open: CommandDefinitionMessages }
}

export function attentionSummaryPhrase(state: AttentionState, unreadCount: number): string {
  const phrase =
    state === 'none'
      ? 'no attention'
      : state === 'informational'
        ? 'informational attention'
        : state === 'completed'
          ? 'completed attention'
          : state === 'waiting'
            ? 'waiting for input'
            : 'urgent attention'
  return `${phrase}${unreadCount > 0 ? `, ${String(unreadCount)} unread notification${unreadCount === 1 ? '' : 's'}` : ''}`
}

export const messages = {
  commands: {
    workspace: {
      new: {
        title: 'Open folder',
        description: 'Open a folder as a workspace.',
        aliases: ['create workspace', 'add workspace', 'open directory']
      }
    },
    terminal: {
      new: {
        title: 'New terminal',
        description: 'Open a terminal tab.',
        aliases: ['new terminal tab', 'shell'],
        unavailable: 'Select a workspace pane first.'
      },
      search: {
        title: 'Terminal search',
        description: 'Search the active terminal.',
        aliases: ['find in terminal'],
        unavailable: 'Select a terminal tab first.'
      }
    },
    tab: {
      close: {
        title: 'Close tab',
        description: 'Close the active tab.',
        aliases: ['remove tab'],
        unavailable: 'Select a tab first.'
      },
      duplicate: {
        title: 'Duplicate tab',
        description: 'Create a fresh tab from the active tab launch metadata.',
        aliases: ['clone tab', 'copy tab'],
        unavailable: 'Multi-window tab actions are unavailable.'
      },
      moveToWindow: {
        title: 'Move tab to window',
        description: 'Move the active tab and its live session to another window.',
        aliases: ['transfer tab', 'send tab to window'],
        unavailable: 'Multi-window tab actions are unavailable.'
      },
      detach: {
        title: 'Detach tab to new window',
        description: 'Move the active tab and its live session into a new window.',
        aliases: ['pop out tab', 'new window from tab'],
        unavailable: 'Multi-window tab actions are unavailable.'
      },
      reopen: {
        title: 'Reopen closed tab',
        description: 'Reopen the most recently closed eligible tab with a fresh runtime.',
        aliases: ['undo close tab', 'recently closed'],
        unavailable: 'No recently closed tab is available.'
      }
    },
    window: {
      new: {
        title: 'New window',
        description: 'Create another workspace window.',
        aliases: ['open window'],
        unavailable: 'Multi-window support is unavailable.'
      },
      close: {
        title: 'Close window',
        description: 'Close this window using the configured rehome policy.',
        aliases: ['remove window'],
        unavailable: 'Multi-window support is unavailable.'
      },
      focusNext: {
        title: 'Focus next window',
        description: 'Focus the next hosted workspace window.',
        aliases: ['switch window', 'cycle windows'],
        unavailable: 'Multi-window support is unavailable.'
      }
    },
    focusHistory: {
      back: {
        title: 'Go to previously focused tab',
        description: 'Navigate backward through recently focused tabs.',
        aliases: ['focus history back', 'previously focused'],
        unavailable: 'Recently focused navigation is unavailable.'
      },
      forward: {
        title: 'Go to next focused tab',
        description: 'Navigate forward through recently focused tabs.',
        aliases: ['focus history forward', 'next focused'],
        unavailable: 'Recently focused navigation is unavailable.'
      }
    },
    pane: {
      splitRight: {
        title: 'Split right',
        description: 'Split the active pane to the right.',
        aliases: ['vertical split', 'split pane right'],
        unavailable: 'Select a workspace pane first.'
      },
      splitDown: {
        title: 'Split down',
        description: 'Split the active pane downward.',
        aliases: ['horizontal split', 'split pane down'],
        unavailable: 'Select a workspace pane first.'
      }
    },
    sidebar: {
      toggle: {
        title: 'Toggle sidebar',
        description: 'Show or hide the workspace sidebar.',
        aliases: ['show sidebar', 'hide sidebar']
      }
    },
    commandPalette: {
      toggle: {
        title: 'Command palette',
        description: 'Open the command palette.',
        aliases: ['show commands', 'quick open']
      }
    },
    notifications: {
      toggle: {
        title: 'Notifications',
        description: 'Open the notification center.',
        aliases: ['notification center', 'inbox']
      },
      latestUnread: {
        title: 'Latest unread',
        description: 'Jump to the latest unread notification.',
        aliases: ['newest notification', 'unread']
      }
    },
    settings: {
      open: {
        title: 'Settings',
        description: 'Open application settings.',
        aliases: ['preferences', 'configuration']
      }
    }
  } satisfies RendererCommandMessages,
  shortcutValidation: {
    unsupportedNonModifierKey: 'Shortcut must contain one supported non-modifier key.',
    unknownLogicalModifier: (modifier: string) => `Unknown logical modifier: ${modifier}`,
    duplicateLogicalModifier: (modifier: string) => `Duplicate logical modifier: ${modifier}`,
    emptyKeyOrModifier: 'Shortcut contains an empty key or modifier.',
    missingNonModifierKey: 'Shortcut must contain a non-modifier key.'
  },
  notificationJump: {
    notVisible: 'The notification target could not be made visible.',
    notOpened: 'The notification target could not be opened.',
    targetUnavailable: 'This notification target is no longer available.',
    centerCloseFailed: 'The notification center did not close. Try opening the target again.'
  },
  workspaceProjection: {
    errors: {
      serviceNotConnected: 'The workspace service is not connected.',
      notificationOperationsUnavailable: 'Notification operations are unavailable.',
      connectionChanged: 'The workspace service connection changed. Try again.',
      latestUnreadUnavailable:
        'The latest unread notification could not be resolved from current workspace state.',
      initializationFailed: 'The workspace service could not be loaded. Try again.',
      refreshFailed: 'Workspace state could not be refreshed. Try again.',
      changeFailed: 'The workspace change could not be saved.',
      revisionConflict: 'The workspace changed elsewhere. Try the action again.',
      targetUnavailable: 'The requested workspace item is no longer available.',
      invalidRequest: 'The workspace service could not apply that request.',
      persistenceFailed: 'The workspace service could not save the change.',
      terminalOperationFailed: 'The terminal operation could not be completed.',
      serviceUnavailable: 'The workspace service is unavailable. Try again.',
      shuttingDown: (reason?: WorkspaceShutdownReason) =>
        reason === 'service_shutdown'
          ? 'The workspace service is shutting down.'
          : 'The workspace service stopped unexpectedly.'
    }
  },
  attentionBadge: {
    authoritativeSummary: (label: string, state: AttentionState, unreadCount: number) =>
      `${label}: ${attentionSummaryPhrase(state, unreadCount)}`,
    stateLabel: (state: AttentionState) =>
      state === 'informational'
        ? 'Info'
        : state === 'completed'
          ? 'Done'
          : state === 'waiting'
            ? 'Wait'
            : 'Urgent',
    accessibleSummary: (
      label: string,
      unreadCount: number,
      highestSeverity: string,
      latestTitle?: string
    ) =>
      `${label}: ${String(unreadCount)} unread, highest severity ${highestSeverity}${latestTitle ? `, latest ${latestTitle}` : ''}`,
    displayCount: (unreadCount: number) => (unreadCount > 99 ? '99+' : String(unreadCount))
  },
  ui: {
    closeDialog: 'Close dialog'
  },
  workspaceRuntimeMetadata: {
    workingDirectory: (directory: string) => `Working directory ${directory}`,
    accessibilityLabel: (branch: string, status: string, process: string, listeningPorts: string) =>
      `Git branch ${branch}; Git status ${status}; process ${process}; ${listeningPorts}`,
    unavailable: 'unavailable',
    noGitBranch: 'No Git branch',
    branch: 'Branch',
    clean: 'Clean',
    statusUnavailable: 'Status unavailable',
    process: 'Process',
    ports: 'Ports',
    noActiveProcess: 'No active process',
    browser: 'Browser',
    listeningPortsAccessibility: (ports: string | null) =>
      ports === null ? 'no listening ports' : `listening ports ${ports}`,
    listeningPorts: (ports: string) => `Listening ports ${ports}`,
    noListeningPorts: 'No listening ports'
  },
  workspaceCardSlots: {
    agent: 'Agent',
    progress: 'Progress',
    inProgress: 'In progress',
    agentStatus: {
      idle: 'Idle',
      running: 'Running',
      waiting: 'Waiting',
      completed: 'Completed',
      failed: 'Failed'
    },
    progressAccessible: (value: number, label: string | null) =>
      `${label ? `${label}, ` : ''}${String(value)} percent complete`,
    indeterminateAccessible: (label: string) => `${label}, progress indeterminate`
  },
  workspaceCardSlotsV2: {
    summary: 'Workspace card details',
    truncated: 'Earlier log lines omitted',
    names: {
      agentStatus: 'Agent',
      progress: 'Progress',
      pullRequest: 'Pull request',
      metadata: 'Metadata',
      markdown: 'Notes',
      logTail: 'Recent log output',
      task: 'Task checklist',
      ssh: 'SSH',
      media: 'Media'
    }
  },
  workspaceContextMenu: {
    rename: 'Rename workspace…',
    color: 'Workspace color',
    chooseColor: 'Choose custom color…',
    clearColor: 'Clear color',
    invalidColor: 'Enter a color in #RRGGBB format.',
    colors: {
      blue: 'Blue',
      violet: 'Violet',
      green: 'Green',
      amber: 'Amber',
      rose: 'Rose'
    },
    duplicate: 'Duplicate workspace',
    moveUp: 'Move up',
    moveDown: 'Move down',
    close: 'Close workspace'
  },
  notifications: {
    title: 'Notifications',
    unreadSummary: (count: number) => {
      if (count === 0) return 'No unread notifications.'
      return `${String(count)} unread notification${count === 1 ? '' : 's'}.`
    },
    clearRead: 'Clear read',
    clearAll: 'Clear all',
    history: 'Notification history',
    emptyTitle: 'Nothing needs your attention',
    emptyBody: 'CLI, agent, terminal, and process notices will appear here.',
    openTarget: 'Open target',
    targetNoLongerAvailable: 'Target no longer available',
    jump: 'Jump',
    markRead: 'Mark notification read',
    markUnread: 'Mark notification unread',
    clearNotification: 'Clear notification',
    sourceAndTarget: (source: string, target: string) => `${source} · ${target}`,
    showingCount: (shown: number, total: number) =>
      `Showing ${String(shown)} of ${String(total)} notifications.`,
    loading: 'Loading…',
    loadMore: (count: number) => `Load ${String(count)} more`,
    status: {
      unread: 'Unread',
      read: 'Read'
    },
    groupLabel: (status: NotificationReadStatus, day: string) =>
      `${status === 'unread' ? 'Unread' : 'Read'} · ${day}`,
    relativeDay: {
      today: 'Today',
      yesterday: 'Yesterday'
    },
    targetUnavailable: 'Target unavailable',
    workspaceTabTarget: (workspaceName: string, tabTitle: string) =>
      `${workspaceName} / ${tabTitle}`
  },
  terminalPane: {
    defaultTitle: 'Terminal',
    label: 'Terminal pane',
    status: {
      startingShell: 'Starting shell…',
      webglUnavailable: 'WebGL unavailable · canvas renderer active',
      canvasRenderer: 'Canvas renderer active',
      checkpointTooLarge: 'Checkpoint skipped because the visible projection is too large',
      connected: 'Connected',
      connectedWithTruncatedScrollback:
        'Connected · earlier scrollback was truncated; terminal view reset safely',
      processExited: 'Process exited',
      restartingShell: 'Restarting shell…'
    },
    errors: {
      serviceUnavailable: 'The terminal service is unavailable.',
      resizeFailed: 'Terminal resize failed',
      attachFailed: 'Terminal attach failed',
      inputFailed: 'Terminal input failed',
      withDetail: (context: string, detail: string) => `${context}. ${detail}`
    },
    pasteLinesPrompt: (lineCount: number) =>
      `Paste ${String(lineCount)} line${lineCount === 1 ? '' : 's'} into the terminal?`,
    search: {
      label: 'Find in terminal',
      placeholder: 'Find',
      matchCase: 'Match case',
      matchCaseIndicator: 'Aa',
      matchWholeWord: 'Match whole word',
      matchWholeWordIndicator: 'W',
      useRegularExpression: 'Use regular expression',
      regularExpressionIndicator: '.*',
      previousMatch: 'Previous match',
      previousMatchIndicator: '↑',
      nextMatch: 'Next match',
      nextMatchIndicator: '↓'
    },
    controls: {
      terminalIcon: '›_',
      openTools: 'Open terminal tools',
      closeTools: 'Close terminal tools',
      decreaseFontSize: 'Decrease terminal font size',
      decreaseFontSizeIndicator: 'A−',
      fontSize: 'Terminal font size',
      increaseFontSize: 'Increase terminal font size',
      increaseFontSizeIndicator: 'A+',
      copySelection: 'Copy selection',
      screenReaderMode: 'Screen reader mode'
    },
    exit: {
      withSignal: (signal: string) => `Process exited with signal ${signal}`,
      withCode: (code: number | undefined) => `Process exited with code ${String(code)}`,
      restart: 'Restart terminal'
    },
    processId: (processId: number) => `PID ${String(processId)}`,
    openLink: (target: string) => `Open ${target}`
  },
  workspaceShell: {
    titlebar: {
      applicationTitle: 'Agent Workspace',
      noWorkspaceSelected: 'No workspace selected',
      toggleSidebar: 'Toggle workspace sidebar',
      toggleToolsSidebar: 'Toggle tools sidebar',
      openCommandPalette: 'Open command palette',
      openNotifications: (unreadCount: number) =>
        `Open notifications${unreadCount ? `, ${String(unreadCount)} unread` : ''}`,
      notifications: 'Notifications',
      openSettings: 'Open settings',
      unavailableVersion: '—',
      version: (protocolVersion: string, applicationVersion: string) =>
        `protocol ${protocolVersion} · ${applicationVersion}`
    },
    mutation: {
      notSaved: 'Change not saved.',
      tryAgain: 'Try the action again.',
      dismiss: 'Dismiss'
    },
    contentLabel: 'Workspace content',
    sidebar: {
      label: 'Workspaces',
      createWorkspace: 'Open folder as workspace',
      openFolder: 'Open folder',
      listLabel: 'Workspace list',
      workspaceCount: (count: number) => `${String(count)} workspace${count === 1 ? '' : 's'}`,
      closeConfirmation: (workspaceName: string) => `Close workspace “${workspaceName}”?`,
      reorder: (workspaceName: string) => `Reorder ${workspaceName}`,
      reorderTitle: 'Drag to reorder · Alt+Up/Down',
      close: (workspaceName: string) => `Close ${workspaceName}`,
      actions: (workspaceName: string) => `${workspaceName} workspace actions`,
      unavailableMetadata: '—',
      metadataSeparator: '·',
      copySuffix: ' copy',
      cardAccessibleName: (workspaceName: string, state: AttentionState, unreadCount: number) =>
        `${workspaceName}; ${attentionSummaryPhrase(state, unreadCount)}`
    },
    pane: {
      unavailable: 'Pane unavailable',
      tabs: 'Pane tabs',
      attentionLabel: 'Pane',
      newTerminalTab: 'New terminal tab',
      splitRight: 'Split pane right',
      splitDown: 'Split pane down',
      close: 'Close pane',
      unnamed: (index: number) => `pane ${String(index)}`,
      dropTarget: (zone: 'move' | PaneDropDirection) => (zone === 'move' ? 'Move' : `Split ${zone}`)
    },
    tab: {
      rename: 'Rename tab',
      actions: (title: string) => `${title} tab actions`,
      moveLeft: (title: string) => `Move ${title} left`,
      moveRight: (title: string) => `Move ${title} right`,
      moveOrSplit: (title: string) => `Move or split ${title}`,
      keyboardDestinations: 'Keyboard tab destinations',
      destinations: 'Tab destinations…',
      moveToPane: (paneName: string) => `Move to ${paneName}`,
      splitPane: (paneName: string, direction: PaneDropDirection) =>
        `Split ${paneName} ${direction}`,
      close: (title: string) => `Close ${title}`
    },
    unavailableTerminal: {
      title: 'Terminal session unavailable',
      body: 'Restart this terminal from the tab or reopen the workspace.',
      restart: 'Restart terminal'
    },
    emptyWorkspace: {
      title: 'Build in focused workspaces',
      body: 'Open a folder to organize terminal tabs and resizable panes.',
      create: 'Open folder'
    },
    emptyPane: {
      title: 'This pane is empty',
      newTerminal: 'New terminal'
    },
    createWorkspace: {
      title: 'Open a folder as a workspace',
      description: 'The folder name becomes the workspace name. You can rename it later.',
      chooseFolder: 'Choose folder',
      choosingFolder: 'Opening picker…',
      manualDivider: 'Or enter a path manually',
      workingDirectory: 'Workspace folder path',
      workingDirectoryPlaceholder: '/home/you/projects/my-app',
      cancel: 'Cancel',
      create: 'Open workspace'
    },
    commandPalette: {
      title: 'Command palette',
      search: 'Search commands',
      placeholder: 'Type a command…',
      results: 'Commands'
    },
    settingsShortcuts: {
      title: 'Settings',
      sectionTitle: 'Keyboard shortcuts',
      conflict: (commandTitles: readonly string[]) => `Conflicts with ${commandTitles.join(', ')}.`,
      summary: (commandId: string, defaultShortcut: string) =>
        `${commandId} · default ${defaultShortcut}`,
      inputLabel: (commandTitle: string) => `${commandTitle} shortcut`,
      save: 'Save',
      clear: 'Clear',
      reset: (commandId: string) => `Reset ${commandId}`
    },
    defaultBrowserUrl: 'https://example.com/'
  },
  lifecycle: {
    starting: 'Starting local workspace service…',
    recoveringTitle: 'Restoring your workspace',
    recoveringBody:
      'Live terminal processes were interrupted. Saved workspace metadata will be restored when the service is ready.',
    recoveryRequiredTitle: 'Workspace recovery required',
    failedTitle: 'Workspace service unavailable',
    backupAvailable: 'A migration backup is available for recovery.',
    backupUnavailable: 'No migration backup is available.',
    retry: 'Retry service',
    exportDatabase: 'Export database',
    previewDiagnostics: 'Preview diagnostics',
    exportDiagnostics: 'Export diagnostic bundle',
    quit: 'Quit application',
    actionFailed: 'The requested action could not be completed. Try again.',
    databaseExported: 'The recovery database was exported.',
    databaseExportCancelled: 'Database export cancelled.',
    diagnosticsExported: 'The diagnostic bundle was exported.',
    diagnosticsExportCancelled: 'Diagnostic bundle export cancelled.',
    diagnosticsTitle: 'Diagnostic bundle preview',
    diagnosticsPrivacy:
      'Review the exact file names and sizes below. Sensitive values are redacted before export; raw terminal, browser, and agent content is not included here.',
    diagnosticsTotal: 'Total size',
    diagnosticsRedactions: 'Redactions applied',
    recoveryCategories: {
      futureSchema: 'Database created by a newer version',
      corruptDatabase: 'Database integrity problem',
      corruptSchema: 'Database schema problem',
      invalidSnapshot: 'Saved workspace data problem',
      migrationFailed: 'Database upgrade problem',
      permissions: 'Database permission problem',
      unknown: 'Database recovery problem'
    }
  },
  settings: {
    description: 'Configure this device and workspace experience.',
    configurationUnavailable: 'Advanced configuration is unavailable in this version.',
    loadFailed: 'Configuration could not be loaded. Try reopening settings.',
    conflict: 'Settings changed elsewhere. The latest configuration has been reloaded.',
    saveFailed: 'The setting could not be saved. The latest configuration has been reloaded.',
    saved: 'Setting saved.',
    search: 'Search settings',
    noSearchResults: 'No settings match your search.',
    advanced: 'Advanced',
    appearance: 'Appearance',
    terminal: 'Terminal',
    browser: 'Browser',
    notifications: 'Notifications',
    keyboard: 'Keyboard shortcuts',
    agents: 'Agent integrations',
    logging: 'Logging',
    updates: 'Updates',
    loading: 'Loading configuration…',
    saving: 'Saving…',
    saveSection: 'Save section',
    shellBehavior:
      'Applies to new and restarted terminals. Existing terminal processes keep their current shell.',
    interfaceFontBehavior:
      'Use system-ui for your operating system font, or enter the name of any installed font.',
    loggingBehavior: 'Applies immediately to subsequent service log events.',
    deferred: {
      browser:
        'Browser profiles and privacy modes are reserved for future browser sessions and do not change current tabs.',
      agents: 'Agent integrations are not connected to a runtime in this version.',
      updates: 'Update feeds are controlled by the trusted desktop build configuration.'
    },
    fields: {
      theme: 'Theme',
      density: 'Density',
      interfaceFontFamily: 'Interface font family',
      shellPath: 'Shell path',
      shellPlaceholder: 'Use system default',
      fontFamily: 'Font family',
      fontSize: 'Font size',
      scrollback: 'Scrollback lines',
      multilinePaste: 'Protect multiline paste',
      systemNotifications: 'Enable system notifications',
      notificationBody: 'Include notification body',
      profileName: 'Profile name',
      profilePartition: 'Profile partition',
      privacy: 'Privacy',
      enableAgents: 'Enable agent integrations',
      agentNotifications: 'Allow agent notifications',
      agentBrowser: 'Allow browser integration',
      logLevel: 'Log level',
      updateChannel: 'Update channel'
    },
    options: {
      system: 'System',
      dark: 'Dark',
      light: 'Light',
      comfortable: 'Comfortable',
      compact: 'Compact',
      expanded: 'Expanded',
      standard: 'Standard',
      strict: 'Strict',
      error: 'Error',
      warn: 'Warning',
      info: 'Info',
      debug: 'Debug',
      trace: 'Trace',
      stable: 'Stable',
      beta: 'Beta'
    },
    updater: {
      unconfigured:
        'Updates are disabled because trusted stable and beta feeds are not configured.',
      development: 'Updates are unavailable in development builds.',
      unsupported: 'This installation format cannot be updated by the desktop updater.',
      idle: 'Ready to check for updates.',
      checking: 'Checking for updates…',
      upToDate: 'This installation is up to date.',
      available: 'A new version is available:',
      downloading: 'Downloading update',
      downloaded: 'The update is downloaded and ready to install.',
      check: 'Check for updates',
      download: 'Download update',
      install: 'Install and restart',
      actionFailed: 'The update action could not be completed.'
    }
  },
  agentSessions: {
    title: 'Agent sessions',
    description:
      'Catalog exact Codex thread IDs, assess honest restore support, and manage forks, teams, and attention.',
    loadFailed: 'Agent sessions could not be loaded.',
    operationFailed: 'The agent session operation failed.',
    register: 'Register Codex thread',
    threadId: 'Exact Codex thread UUID',
    sessionTitle: 'Session title',
    noTerminal: 'Select a live terminal tab to register or fork an agent session.',
    sessions: 'Cataloged sessions',
    noSessions: 'No agent sessions are cataloged.',
    lifecycle: 'Lifecycle',
    hibernationState: 'Hibernation state',
    restoreLevel: 'Restore support',
    restoreLevels: {
      liveReattach: 'Live reattach — the exact terminal process is still running.',
      toolResume: 'Tool resume — Codex can resume the exact durable thread.',
      layoutRestart: 'Layout restart — only the terminal layout can be restarted.',
      unavailable: 'Unavailable — no verified restore path exists.'
    },
    provenance: 'Fork provenance',
    sessionActions: (title: string) => `Actions for ${title}`,
    navigate: 'Open exact tab',
    assess: 'Assess restore',
    assessed: (level: string) => `Restore assessment updated: ${level}.`,
    restore: 'Restore',
    restored: (outcome: string) => `Restore outcome: ${outcome}.`,
    hibernate: 'Hibernate',
    hibernateCanceled: 'Hibernation canceled; the agent was left running.',
    forkTitle: 'Fork title',
    forkDestination: 'Fork destination',
    existingTerminal: 'Use another selected terminal',
    newTerminal: 'Create a new terminal',
    sourceDestinationBlocked:
      'The source terminal cannot also be the fork destination. Create a new terminal or select another terminal.',
    retainedForkTerminal:
      'Forking failed and the newly created empty terminal could not be closed; it remains open.',
    fork: 'Fork conversation',
    attention: 'Attention state',
    attentionFor: (title: string) => `Attention for ${title}`,
    informational: 'Informational',
    completed: 'Completed',
    waiting: 'Waiting',
    urgent: 'Urgent',
    setAttention: 'Set attention',
    teams: 'Agent teams',
    noTeams: 'No agent teams are defined.',
    teamTitle: 'Team title',
    createTeam: 'Create team',
    deleteTeam: 'Delete team',
    membersFor: (title: string) => `Members of ${title}`,
    noMembers: 'This team has no members.',
    memberSession: 'Cataloged session',
    chooseSession: 'Choose a session',
    role: 'Member role',
    parentMember: 'Parent member',
    rootMember: 'No parent (root member)',
    addMember: 'Add member',
    childOf: (role: string) => `Child of ${role}`,
    updateMember: 'Update member',
    moveMember: 'Move member to session',
    removeMember: 'Remove member'
  },
  sidebarSurfaces: {
    title: 'Workspace tools',
    labels: {
      textBox: 'Text Box',
      vault: 'Vault',
      taskManager: 'Task Manager',
      files: 'Files',
      markdown: 'Markdown',
      diff: 'Diff',
      search: 'Search',
      recentlyClosed: 'Recently Closed'
    },
    resize: 'Resize tools sidebar',
    serviceUnavailable: 'The sidebar service is unavailable.',
    localPrivacy:
      'Index data stays in the service-owned encrypted local vault. Consent is per authorized source and can be revoked.'
  },
  remoteSessions: {
    title: 'Remote sessions',
    description: 'Use a trusted Ed25519 key and confirm the exact host key before connecting.',
    loadFailed: 'Remote sessions could not be loaded.',
    operationFailed: 'The remote session operation failed.',
    added: 'Remote target added.',
    keySelectionCanceled: 'SSH key selection canceled.',
    addLegend: 'Add a remote target',
    label: 'Label',
    host: 'Host',
    port: 'Port',
    user: 'User',
    add: 'Choose SSH key and add target',
    targets: 'Remote targets',
    replaceCredential: 'Replace credential',
    credentialReplaced: 'Credential replaced.',
    delete: 'Delete',
    deleted: 'Remote target and trusted artifacts deleted.',
    deleteCanceled: 'Remote target deletion canceled.',
    connect: 'Connect',
    tmuxName: 'Tmux session name',
    scanHostKey: 'Scan host key',
    discoverTmux: 'Discover tmux',
    reconnect: 'Reconnect',
    detach: 'Detach',
    close: 'Close',
    closeCanceled: 'Remote session close canceled.',
    noTmux: 'No tmux sessions found.',
    tmuxAvailable: (sessions: readonly string[]) =>
      `Available tmux sessions: ${sessions.join(', ')}`,
    hostKeyState: (state: string) => `Host key: ${state}`,
    sessionState: (state: string, observation: string) =>
      `Session ${state}; observation ${observation}`
  }
} as const

export function recoveryAttempt(attempt: number, maxAttempts: number): string {
  return `Recovery attempt ${String(attempt)} of ${String(maxAttempts)}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
