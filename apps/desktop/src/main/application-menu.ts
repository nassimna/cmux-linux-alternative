import {
  Menu,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'

import {
  APPLICATION_MENU_COMMAND_IDS,
  parseApplicationMenuCommandId,
  parseApplicationMenuState,
  type ApplicationMenuCommandId,
  type ApplicationMenuCommandState,
  type ApplicationMenuShortcut,
  type ApplicationMenuState
} from '../shared/application-menu'
import { DESKTOP_IPC } from '../shared/desktop-bridge'
import { desktopMessages } from '../shared/desktop-messages'
import type { SenderBoundIpcRouter } from './sender-bound-ipc-router'

export interface ApplicationMenuStateSink {
  update(state: ApplicationMenuState): void
}

export interface SenderBoundApplicationMenuStateSink extends ApplicationMenuStateSink {
  updateForWindow(window: BrowserWindow, state: ApplicationMenuState): void
}

export class NativeApplicationMenu implements ApplicationMenuStateSink {
  readonly #platform: NodeJS.Platform
  readonly #applicationName: string
  #window: BrowserWindow | undefined
  #state = emptyApplicationMenuState()
  readonly #windowBindings = new Map<
    BrowserWindow,
    { state: ApplicationMenuState; removeListeners: () => void }
  >()
  #quitting = false

  constructor(
    platform: NodeJS.Platform = process.platform,
    applicationName = desktopMessages.applicationName
  ) {
    this.#platform = platform
    this.#applicationName = applicationName
  }

  bindWindow(window: BrowserWindow): () => void {
    this.#windowBindings.get(window)?.removeListeners()
    this.#window = window
    const resetForRenderer = (): void => {
      const binding = this.#windowBindings.get(window)
      if (binding) binding.state = emptyApplicationMenuState()
      if (this.#window !== window) return
      this.#state = emptyApplicationMenuState()
      this.#render()
    }
    const selectWindow = (): void => {
      this.#window = window
      this.#state = this.#windowBindings.get(window)?.state ?? emptyApplicationMenuState()
      this.#render()
    }
    window.webContents.on('did-start-loading', resetForRenderer)
    window.on('focus', selectWindow)
    const removeListeners = (): void => {
      // Electron's BrowserWindow.webContents getter throws after the native `closed` event.
      // The destroyed WebContents cannot emit another load event, so only the BrowserWindow
      // listener still needs explicit removal in that state.
      if (!window.isDestroyed()) {
        window.webContents.removeListener('did-start-loading', resetForRenderer)
      }
      window.removeListener('focus', selectWindow)
    }
    this.#windowBindings.set(window, { state: emptyApplicationMenuState(), removeListeners })
    this.reset()

    let active = true
    return () => {
      if (!active) return
      active = false
      removeListeners()
      this.#windowBindings.delete(window)
      if (this.#window === window) {
        const fallback = [...this.#windowBindings.keys()].at(-1)
        this.#window = fallback
        this.#state = fallback
          ? (this.#windowBindings.get(fallback)?.state ?? emptyApplicationMenuState())
          : emptyApplicationMenuState()
        // macOS keeps its global application menu when the last window closes. On Windows and
        // Linux the final-window close immediately enters application shutdown, where installing
        // a replacement native menu races Electron's teardown.
        if (this.#platform === 'darwin') this.#render()
      }
    }
  }

  prepareForApplicationQuit(): void {
    this.#quitting = true
    for (const binding of this.#windowBindings.values()) binding.removeListeners()
    this.#windowBindings.clear()
    this.#window = undefined
    this.#state = emptyApplicationMenuState()
  }

  update(state: ApplicationMenuState): void {
    this.#state = parseApplicationMenuState(state)
    if (this.#window) {
      const binding = this.#windowBindings.get(this.#window)
      if (binding) binding.state = this.#state
    }
    this.#render()
  }

  updateForWindow(window: BrowserWindow, state: ApplicationMenuState): void {
    const parsed = parseApplicationMenuState(state)
    const binding = this.#windowBindings.get(window)
    if (binding) binding.state = parsed
    if (this.#window !== window) return
    this.#state = parsed
    this.#render()
  }

  reset(): void {
    this.#state = emptyApplicationMenuState()
    if (this.#window) {
      const binding = this.#windowBindings.get(this.#window)
      if (binding) binding.state = this.#state
    }
    this.#render()
  }

  #render(): void {
    if (this.#quitting) return
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenuTemplate(
          this.#platform,
          this.#applicationName,
          this.#state,
          (commandId) => this.#dispatch(commandId)
        )
      )
    )
  }

  #dispatch(commandId: ApplicationMenuCommandId): void {
    const window = this.#window
    if (
      !window ||
      window.isDestroyed() ||
      this.#state.commands.find((command) => command.commandId === commandId)?.enabled !== true
    ) {
      return
    }
    window.webContents.send(
      DESKTOP_IPC.applicationMenuCommand,
      parseApplicationMenuCommandId(commandId)
    )
  }
}

export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  applicationName: string,
  state: ApplicationMenuState,
  dispatch: (commandId: ApplicationMenuCommandId) => void
): MenuItemConstructorOptions[] {
  const labels = desktopMessages.applicationMenu
  const byId = new Map(state.commands.map((command) => [command.commandId, command]))
  const command = (
    commandId: ApplicationMenuCommandId,
    label: string
  ): MenuItemConstructorOptions => {
    const item = byId.get(commandId)
    return {
      id: `command:${commandId}`,
      label,
      enabled: item?.enabled === true,
      ...(item?.shortcut ? { accelerator: shortcutToAccelerator(item.shortcut, platform) } : {}),
      click: () => dispatch(commandId)
    }
  }
  const separator = (): MenuItemConstructorOptions => ({ type: 'separator' })

  const fileMenu: MenuItemConstructorOptions = {
    label: labels.file,
    submenu: [
      command('workspace.new', labels.newWorkspace),
      command('terminal.new', labels.newTerminal),
      ...(platform === 'darwin'
        ? []
        : [
            separator(),
            command('settings.open', labels.settings),
            separator(),
            {
              role: 'quit' as const,
              label: platform === 'win32' ? labels.exit : labels.quit
            }
          ])
    ]
  }
  const editMenu: MenuItemConstructorOptions = {
    label: labels.edit,
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      separator(),
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(platform === 'darwin'
        ? [{ role: 'pasteAndMatchStyle' as const }, { role: 'delete' as const }]
        : [{ role: 'delete' as const }]),
      { role: 'selectAll' },
      separator(),
      command('terminal.search', labels.findInTerminal)
    ]
  }
  const viewMenu: MenuItemConstructorOptions = {
    label: labels.view,
    submenu: [
      command('sidebar.toggle', labels.toggleSidebar),
      command('commandPalette.toggle', labels.commandPalette),
      separator(),
      {
        label: labels.browser,
        submenu: [
          command('browser.back', labels.browserBack),
          command('browser.forward', labels.browserForward),
          command('browser.reload', labels.browserReload),
          command('browser.stop', labels.browserStop),
          separator(),
          command('browser.openDevTools', labels.openDeveloperTools)
        ]
      },
      {
        label: labels.notifications,
        submenu: [
          command('notifications.toggle', labels.showNotifications),
          command('notifications.latestUnread', labels.latestUnread)
        ]
      }
    ]
  }
  const windowMenu: MenuItemConstructorOptions = {
    label: labels.window,
    role: 'windowMenu',
    submenu: [
      command('pane.splitRight', labels.splitRight),
      command('pane.splitDown', labels.splitDown),
      command('browser.openSplit', labels.openBrowserSplit),
      separator(),
      { role: 'minimize' },
      ...(platform === 'darwin'
        ? [{ role: 'zoom' as const }, separator(), { role: 'front' as const }]
        : [])
    ]
  }
  const template = [fileMenu, editMenu, viewMenu, windowMenu]

  if (platform === 'darwin') {
    template.unshift({
      label: applicationName,
      submenu: [
        { role: 'about' },
        separator(),
        command('settings.open', labels.settings),
        separator(),
        { role: 'services' },
        separator(),
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        separator(),
        { role: 'quit' }
      ]
    })
  }
  return template
}

export function shortcutToAccelerator(
  shortcut: ApplicationMenuShortcut,
  platform: NodeJS.Platform
): string {
  const modifiers = new Set<string>()
  for (const modifier of shortcut.modifiers) {
    if (modifier === 'Primary') modifiers.add(platform === 'darwin' ? 'Command' : 'Control')
    else if (modifier === 'Secondary') modifiers.add('Alt')
    else modifiers.add(modifier)
  }
  const modifierOrder =
    platform === 'darwin' ? ['Command', 'Control', 'Alt', 'Shift'] : ['Control', 'Alt', 'Shift']
  const keyAliases: Readonly<Record<string, string>> = {
    Space: 'Space',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }
  return [
    ...modifierOrder.filter((modifier) => modifiers.has(modifier)),
    keyAliases[shortcut.key] ?? shortcut.key
  ].join('+')
}

export const APPLICATION_MENU_INVOKE_CHANNELS = [DESKTOP_IPC.applicationMenuUpdate] as const
let activeHandlerRegistration: symbol | undefined

export function registerApplicationMenuHandlers(
  window: BrowserWindow,
  menu: ApplicationMenuStateSink
): () => void {
  removeApplicationMenuHandlers()
  const registration = Symbol('application-menu-handler')
  activeHandlerRegistration = registration
  ipcMain.handle(
    DESKTOP_IPC.applicationMenuUpdate,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      validateSender(event, window.webContents)
      if (args.length !== 1) throw new Error('Invalid application menu IPC payload')
      menu.update(parseApplicationMenuState(args[0]))
    }
  )
  return () => {
    if (activeHandlerRegistration !== registration) return
    removeApplicationMenuHandlers()
  }
}

export function removeApplicationMenuHandlers(): void {
  activeHandlerRegistration = undefined
  for (const channel of APPLICATION_MENU_INVOKE_CHANNELS) ipcMain.removeHandler(channel)
}

/** Registers the application-menu mutation globally and derives authority from its sender. */
export function registerSenderBoundApplicationMenuHandlers(
  router: SenderBoundIpcRouter,
  menu: SenderBoundApplicationMenuStateSink
): void {
  router.handle(DESKTOP_IPC.applicationMenuUpdate, (entry, _event, ...args: unknown[]) => {
    if (args.length !== 1) throw new Error('Invalid application menu IPC payload')
    menu.updateForWindow(entry.window, parseApplicationMenuState(args[0]))
  })
}

function validateSender(event: IpcMainInvokeEvent, webContents: WebContents): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new Error('Unauthorized application menu IPC sender')
  }
}

function emptyApplicationMenuState(): ApplicationMenuState {
  return {
    commands: APPLICATION_MENU_COMMAND_IDS.map<ApplicationMenuCommandState>((commandId) => ({
      commandId,
      enabled: false,
      shortcut: null
    }))
  }
}
