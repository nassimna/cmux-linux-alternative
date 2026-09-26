import type { TabSnapshot } from '@agent-workspace/protocol-client'

export type BrowserAddressValidationReason = 'credentials' | 'empty' | 'host' | 'invalid' | 'scheme'

export type BrowserSecurityState = 'secure' | 'insecure' | 'invalid'

export interface BrowserCommandMessages {
  readonly title: string
  readonly description: string
  readonly aliases: readonly string[]
  readonly unavailable: string
}

export interface BrowserMessages {
  readonly toolbar: {
    readonly label: string
    readonly back: string
    readonly forward: string
    readonly reload: string
    readonly stopLoading: string
    readonly address: string
    readonly loading: string
    readonly openExternally: string
    readonly openDeveloperTools: string
    readonly focusDeveloperTools: string
    readonly browserMenu: string
    readonly developerTools: string
    readonly securityLabel: (state: BrowserSecurityState) => string
  }
  readonly pane: {
    readonly defaultTabTitle: string
    readonly label: (navigationTitle: string) => string
    readonly status: (loading: boolean) => string
    readonly profilePartitionLabel: (partition: string) => string
    readonly content: string
  }
  readonly validation: (reason: BrowserAddressValidationReason) => string
  readonly commands: {
    readonly openSplit: BrowserCommandMessages
    readonly back: BrowserCommandMessages
    readonly forward: BrowserCommandMessages
    readonly reload: BrowserCommandMessages
    readonly stop: BrowserCommandMessages
    readonly openDeveloperTools: BrowserCommandMessages
  }
  readonly native: {
    readonly fallbackDownloadFilename: string
    readonly saveDownloadTitle: string
    readonly save: string
    readonly externalTitle: string
    readonly externalMessage: string
    readonly cancel: string
    readonly open: string
    readonly permissionTitle: string
    readonly permissionRequest: (origin: string, permission: string) => string
    readonly deny: string
    readonly allow: string
    readonly status: {
      readonly navigationFailed: string
      readonly permissionPromptFailed: string
      readonly popupNavigationFailed: string
      readonly externalProtocolFailed: string
      readonly downloadPauseFailed: string
      readonly downloadDialogFailed: string
      readonly reconciliationFailed: string
      readonly observationRevisionOverflow: string
      readonly observationUpdateFailed: string
      readonly applicationReconciliationFailed: string
      readonly paneFocusFailed: string
    }
  }
}

export const browserMessages: BrowserMessages = {
  toolbar: {
    label: 'Browser navigation',
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    stopLoading: 'Stop loading',
    address: 'Address',
    loading: 'Loading',
    openExternally: 'Open externally',
    openDeveloperTools: 'Open developer tools',
    focusDeveloperTools: 'Focus developer tools',
    browserMenu: 'Browser menu',
    developerTools: 'Developer tools',
    securityLabel: (state) => {
      if (state === 'secure') return 'Secure HTTPS connection'
      if (state === 'insecure') return 'Insecure HTTP connection'
      return 'Address status unavailable'
    }
  },
  pane: {
    defaultTabTitle: 'Browser',
    label: (navigationTitle) => navigationTitle || 'Browser',
    status: (loading) => (loading ? 'Loading…' : 'Ready'),
    profilePartitionLabel: (partition) => `Browser profile: ${partition}`,
    content: 'Browser content'
  },
  validation: (reason) => {
    switch (reason) {
      case 'empty':
        return 'Enter a web address.'
      case 'invalid':
        return 'Enter a valid web address.'
      case 'scheme':
        return 'Only HTTP and HTTPS addresses are supported.'
      case 'host':
        return 'The address must include a host.'
      case 'credentials':
        return 'Addresses containing credentials are not allowed.'
    }
  },
  commands: {
    openSplit: {
      title: 'Open browser split',
      description: 'Open a browser in a split pane.',
      aliases: ['browser pane', 'web split'],
      unavailable: 'Embedded browsing is not supported by this service.'
    },
    back: {
      title: 'Browser back',
      description: 'Navigate the active browser backward.',
      aliases: ['previous page'],
      unavailable: 'The active browser cannot go back.'
    },
    forward: {
      title: 'Browser forward',
      description: 'Navigate the active browser forward.',
      aliases: ['next page'],
      unavailable: 'The active browser cannot go forward.'
    },
    reload: {
      title: 'Reload browser',
      description: 'Reload the active browser page.',
      aliases: ['refresh page'],
      unavailable: 'No active browser can be reloaded.'
    },
    stop: {
      title: 'Stop browser loading',
      description: 'Stop loading the active browser page.',
      aliases: ['cancel page load'],
      unavailable: 'The active browser is not loading.'
    },
    openDeveloperTools: {
      title: 'Browser developer tools',
      description: 'Open developer tools for the active browser.',
      aliases: ['inspect browser'],
      unavailable: 'Developer tools are unavailable for the active browser.'
    }
  },
  native: {
    fallbackDownloadFilename: 'download',
    saveDownloadTitle: 'Save download',
    save: 'Save',
    externalTitle: 'Open external application?',
    externalMessage: 'This page wants to open another application.',
    cancel: 'Cancel',
    open: 'Open',
    permissionTitle: 'Allow browser permission?',
    permissionRequest: (origin, permission) => `${origin} requests ${permission} permission.`,
    deny: 'Deny',
    allow: 'Allow',
    status: {
      navigationFailed: 'Browser navigation failed',
      permissionPromptFailed: 'Browser permission prompt failed',
      popupNavigationFailed: 'Same-view popup navigation failed',
      externalProtocolFailed: 'External browser protocol failed',
      downloadPauseFailed: 'Browser download could not be paused',
      downloadDialogFailed: 'Browser download dialog failed',
      reconciliationFailed: 'Browser state reconciliation failed',
      observationRevisionOverflow: 'Browser observation revision overflow',
      observationUpdateFailed: 'Browser observation update failed',
      applicationReconciliationFailed: 'Browser application reconciliation failed',
      paneFocusFailed: 'Browser pane focus synchronization failed'
    }
  }
}

export function displayTabTitle(tab: TabSnapshot): string {
  return (
    tab.customTitle ??
    (tab.content.kind === 'browser' ? browserMessages.pane.defaultTabTitle : tab.title)
  )
}
