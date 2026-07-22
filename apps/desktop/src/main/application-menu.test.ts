import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

import type { ApplicationMenuState } from '../shared/application-menu'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  templates: [] as unknown[][],
  menus: [] as unknown[]
}))

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: vi.fn((template: unknown[]) => {
      electron.templates.push(template)
      return { template }
    }),
    setApplicationMenu: vi.fn((menu: unknown) => electron.menus.push(menu))
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel)
  }
}))

import { DESKTOP_IPC } from '../shared/desktop-bridge'
import { desktopMessages } from '../shared/desktop-messages'
import {
  NativeApplicationMenu,
  buildApplicationMenuTemplate,
  registerApplicationMenuHandlers,
  registerSenderBoundApplicationMenuHandlers,
  shortcutToAccelerator
} from './application-menu'

const state: ApplicationMenuState = {
  commands: [
    {
      commandId: 'workspace.new',
      enabled: true,
      shortcut: { modifiers: ['Primary'], key: 'N' }
    },
    {
      commandId: 'settings.open',
      enabled: true,
      shortcut: { modifiers: ['Primary'], key: 'Comma' }
    },
    { commandId: 'terminal.new', enabled: false, shortcut: null }
  ]
}

describe('native application menu template', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.templates.length = 0
    electron.menus.length = 0
    vi.clearAllMocks()
  })

  it('uses macOS application, Edit, and Window conventions with Command accelerators', () => {
    const dispatch = vi.fn()
    const template = buildApplicationMenuTemplate(
      'darwin',
      desktopMessages.applicationName,
      state,
      dispatch
    )
    const labels = desktopMessages.applicationMenu

    expect(template.map(({ label }) => label)).toEqual([
      desktopMessages.applicationName,
      labels.file,
      labels.edit,
      labels.view,
      labels.window
    ])
    expect(findByLabel(template, labels.browser)).toBeDefined()
    expect(findByLabel(template, labels.notifications)).toBeDefined()
    expect(
      Object.fromEntries(
        [
          'workspace.new',
          'terminal.new',
          'settings.open',
          'terminal.search',
          'sidebar.toggle',
          'commandPalette.toggle',
          'browser.back',
          'browser.forward',
          'browser.reload',
          'browser.stop',
          'browser.openDevTools',
          'notifications.toggle',
          'notifications.latestUnread',
          'pane.splitRight',
          'pane.splitDown',
          'browser.openSplit'
        ].map((commandId) => [commandId, findById(template, `command:${commandId}`)?.label])
      )
    ).toEqual({
      'workspace.new': labels.newWorkspace,
      'terminal.new': labels.newTerminal,
      'settings.open': labels.settings,
      'terminal.search': labels.findInTerminal,
      'sidebar.toggle': labels.toggleSidebar,
      'commandPalette.toggle': labels.commandPalette,
      'browser.back': labels.browserBack,
      'browser.forward': labels.browserForward,
      'browser.reload': labels.browserReload,
      'browser.stop': labels.browserStop,
      'browser.openDevTools': labels.openDeveloperTools,
      'notifications.toggle': labels.showNotifications,
      'notifications.latestUnread': labels.latestUnread,
      'pane.splitRight': labels.splitRight,
      'pane.splitDown': labels.splitDown,
      'browser.openSplit': labels.openBrowserSplit
    })
    expect(findByRole(template, 'services')).toBeDefined()
    expect(findByRole(template, 'hideOthers')).toBeDefined()
    expect(findByRole(template, 'pasteAndMatchStyle')).toBeDefined()
    expect(findByRole(template, 'front')).toBeDefined()
    expect(findById(template, 'command:settings.open')).toMatchObject({
      accelerator: 'Command+,',
      enabled: true
    })
    const terminal = findById(template, 'command:terminal.new')
    expect(terminal).toMatchObject({ enabled: false })
    expect(terminal).not.toHaveProperty('accelerator')

    ;(findById(template, 'command:workspace.new')?.click as (() => void) | undefined)?.()
    expect(dispatch).toHaveBeenCalledWith('workspace.new')
  })

  it('uses Windows/Linux File behavior and Control Primary accelerators', () => {
    const windows = buildApplicationMenuTemplate(
      'win32',
      desktopMessages.applicationName,
      state,
      vi.fn()
    )
    const linux = buildApplicationMenuTemplate(
      'linux',
      desktopMessages.applicationName,
      state,
      vi.fn()
    )
    const labels = desktopMessages.applicationMenu

    expect(windows.map(({ label }) => label)).toEqual([
      labels.file,
      labels.edit,
      labels.view,
      labels.window
    ])
    expect(findByRole(windows, 'quit')).toMatchObject({ label: labels.exit })
    expect(findByRole(linux, 'quit')).toMatchObject({ label: labels.quit })
    expect(findById(windows, 'command:settings.open')).toMatchObject({
      accelerator: 'Control+,'
    })
    expect(
      shortcutToAccelerator({ modifiers: ['Primary', 'Control', 'Shift'], key: 'P' }, 'linux')
    ).toBe('Control+Shift+P')
  })
})

describe('native application menu lifecycle and IPC', () => {
  it('rebinds after renderer load, dispatches only enabled IDs, and removes listeners', () => {
    const listeners = new Map<string, () => void>()
    const webContents = {
      mainFrame: {},
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      removeListener: vi.fn((event: string) => listeners.delete(event)),
      send: vi.fn()
    }
    const window = {
      isDestroyed: vi.fn(() => false),
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      removeListener: vi.fn((event: string) => listeners.delete(event)),
      webContents
    } as unknown as Electron.BrowserWindow
    const menu = new NativeApplicationMenu('linux', desktopMessages.applicationName)
    const dispose = menu.bindWindow(window)
    menu.update(state)

    const activeTemplate = electron.templates.at(-1) as MenuItemConstructorOptions[]
    ;(findById(activeTemplate, 'command:workspace.new')?.click as (() => void) | undefined)?.()
    ;(findById(activeTemplate, 'command:terminal.new')?.click as (() => void) | undefined)?.()
    expect(webContents.send).toHaveBeenCalledOnce()
    expect(webContents.send).toHaveBeenCalledWith(
      DESKTOP_IPC.applicationMenuCommand,
      'workspace.new'
    )

    listeners.get('did-start-loading')?.()
    expect(
      findById(electron.templates.at(-1) as MenuItemConstructorOptions[], 'command:workspace.new')
    ).toMatchObject({
      enabled: false
    })
    dispose()
    expect(webContents.removeListener).toHaveBeenCalledWith(
      'did-start-loading',
      expect.any(Function)
    )
  })

  it('keeps a newer window binding active when stale cleanup completes', () => {
    const first = windowFixture()
    const second = windowFixture()
    const menu = new NativeApplicationMenu('linux', desktopMessages.applicationName)
    const disposeFirst = menu.bindWindow(first.window)
    const disposeSecond = menu.bindWindow(second.window)
    menu.update(state)

    disposeFirst()
    const activeTemplate = electron.templates.at(-1) as MenuItemConstructorOptions[]
    ;(findById(activeTemplate, 'command:workspace.new')?.click as (() => void) | undefined)?.()
    expect(first.webContents.send).not.toHaveBeenCalled()
    expect(second.webContents.send).toHaveBeenCalledWith(
      DESKTOP_IPC.applicationMenuCommand,
      'workspace.new'
    )

    disposeSecond()
  })

  it('restores the focused window menu state and dispatch target', () => {
    const first = windowFixture()
    const second = windowFixture()
    const menu = new NativeApplicationMenu('linux', desktopMessages.applicationName)
    const disposeFirst = menu.bindWindow(first.window)
    menu.updateForWindow(first.window, state)
    const disposeSecond = menu.bindWindow(second.window)
    menu.updateForWindow(second.window, { commands: [] })

    first.windowListeners.get('focus')?.()
    const activeTemplate = electron.templates.at(-1) as MenuItemConstructorOptions[]
    ;(findById(activeTemplate, 'command:workspace.new')?.click as (() => void) | undefined)?.()

    expect(first.webContents.send).toHaveBeenCalledWith(
      DESKTOP_IPC.applicationMenuCommand,
      'workspace.new'
    )
    expect(second.webContents.send).not.toHaveBeenCalled()
    disposeFirst()
    disposeSecond()
  })

  it('does not reset the focused menu when a background renderer reloads', () => {
    const first = windowFixture()
    const second = windowFixture()
    const menu = new NativeApplicationMenu('linux', desktopMessages.applicationName)
    const disposeFirst = menu.bindWindow(first.window)
    menu.updateForWindow(first.window, state)
    const disposeSecond = menu.bindWindow(second.window)
    first.windowListeners.get('focus')?.()

    second.webContentsListeners.get('did-start-loading')?.()
    const activeTemplate = electron.templates.at(-1) as MenuItemConstructorOptions[]
    ;(findById(activeTemplate, 'command:workspace.new')?.click as (() => void) | undefined)?.()

    expect(first.webContents.send).toHaveBeenCalledWith(
      DESKTOP_IPC.applicationMenuCommand,
      'workspace.new'
    )
    disposeFirst()
    disposeSecond()
  })

  it('routes global menu updates to the exact sender window', () => {
    let routed:
      | ((entry: { window: Electron.BrowserWindow }, event: unknown, ...args: unknown[]) => unknown)
      | undefined
    type SenderHandler = NonNullable<typeof routed>
    const router = {
      handle: vi.fn((_channel: string, handler: SenderHandler): void => {
        routed = handler
      })
    }
    const window = windowFixture().window
    const sink = { update: vi.fn(), updateForWindow: vi.fn() }
    registerSenderBoundApplicationMenuHandlers(router as never, sink)

    routed?.({ window }, {}, state)
    expect(sink.updateForWindow).toHaveBeenCalledWith(window, state)
    expect(() => routed?.({ window }, {}, state, state)).toThrow(/payload/iu)
  })

  it('does not install a replacement menu while a non-macOS final window closes', () => {
    const fixture = windowFixture()
    const menu = new NativeApplicationMenu('linux', desktopMessages.applicationName)
    const dispose = menu.bindWindow(fixture.window)
    menu.update(state)
    const renderCount = electron.templates.length

    dispose()

    expect(electron.templates).toHaveLength(renderCount)
    expect(fixture.webContents.removeListener).toHaveBeenCalledWith(
      'did-start-loading',
      expect.any(Function)
    )
  })

  it('cleans up a destroyed native window without dereferencing WebContents', () => {
    const fixture = windowFixture()
    const menu = new NativeApplicationMenu('linux', desktopMessages.applicationName)
    const dispose = menu.bindWindow(fixture.window)
    fixture.isDestroyed.mockReturnValue(true)
    Object.defineProperty(fixture.window, 'webContents', {
      get: () => {
        throw new TypeError('Object has been destroyed')
      }
    })

    expect(dispose).not.toThrow()
    expect(fixture.webContents.removeListener).not.toHaveBeenCalled()
    expect(fixture.removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function))
  })

  it('keeps a disabled global menu after a normal macOS no-window transition', () => {
    const fixture = windowFixture()
    const menu = new NativeApplicationMenu('darwin')
    const dispose = menu.bindWindow(fixture.window)
    menu.update(state)
    const renderCount = electron.templates.length

    dispose()

    expect(electron.templates).toHaveLength(renderCount + 1)
    expect((electron.templates.at(-1) as MenuItemConstructorOptions[])[0]?.label).toBe(
      desktopMessages.applicationName
    )
    expect(
      findById(electron.templates.at(-1) as MenuItemConstructorOptions[], 'command:workspace.new')
    ).toMatchObject({ enabled: false })
  })

  it('detaches without rendering when application quit begins', () => {
    const fixture = windowFixture()
    const menu = new NativeApplicationMenu('darwin', desktopMessages.applicationName)
    const dispose = menu.bindWindow(fixture.window)
    menu.update(state)
    const activeTemplate = electron.templates.at(-1) as MenuItemConstructorOptions[]
    const renderCount = electron.templates.length

    menu.prepareForApplicationQuit()
    dispose()
    menu.update(state)
    menu.reset()
    ;(findById(activeTemplate, 'command:workspace.new')?.click as (() => void) | undefined)?.()

    expect(electron.templates).toHaveLength(renderCount)
    expect(fixture.webContents.removeListener).toHaveBeenCalledWith(
      'did-start-loading',
      expect.any(Function)
    )
    expect(fixture.webContents.send).not.toHaveBeenCalled()
  })

  it('validates sender, arity, allow-list, and state before updating', () => {
    const mainFrame = {}
    const webContents = { mainFrame }
    const window = { webContents } as unknown as Electron.BrowserWindow
    const sink = { update: vi.fn() }
    const dispose = registerApplicationMenuHandlers(window, sink)
    const handler = electron.handlers.get(DESKTOP_IPC.applicationMenuUpdate)
    const event = { sender: webContents, senderFrame: mainFrame }

    expect(handler?.(event, state)).toBeUndefined()
    expect(sink.update).toHaveBeenCalledWith(state)
    expect(() => handler?.(event, state, {})).toThrow(/payload/iu)
    expect(() =>
      handler?.(event, {
        commands: [{ commandId: 'tab.close', enabled: true, shortcut: null }]
      })
    ).toThrow(/command/iu)
    expect(() => handler?.({ sender: {}, senderFrame: mainFrame }, state)).toThrow(/Unauthorized/iu)

    dispose()
    expect(electron.handlers.size).toBe(0)
  })

  it('ignores stale IPC cleanup after a newer window registers', () => {
    const firstFrame = {}
    const firstContents = { mainFrame: firstFrame }
    const secondFrame = {}
    const secondContents = { mainFrame: secondFrame }
    const firstSink = { update: vi.fn() }
    const secondSink = { update: vi.fn() }
    const disposeFirst = registerApplicationMenuHandlers(
      { webContents: firstContents } as unknown as Electron.BrowserWindow,
      firstSink
    )
    const disposeSecond = registerApplicationMenuHandlers(
      { webContents: secondContents } as unknown as Electron.BrowserWindow,
      secondSink
    )

    disposeFirst()
    const handler = electron.handlers.get(DESKTOP_IPC.applicationMenuUpdate)
    expect(handler?.({ sender: secondContents, senderFrame: secondFrame }, state)).toBeUndefined()
    expect(firstSink.update).not.toHaveBeenCalled()
    expect(secondSink.update).toHaveBeenCalledWith(state)

    disposeSecond()
    expect(electron.handlers.size).toBe(0)
  })
})

function windowFixture(): {
  isDestroyed: ReturnType<typeof vi.fn>
  removeWindowListener: ReturnType<typeof vi.fn>
  window: Electron.BrowserWindow
  webContents: {
    mainFrame: object
    on: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
  }
  windowListeners: Map<string, () => void>
  webContentsListeners: Map<string, () => void>
} {
  const windowListeners = new Map<string, () => void>()
  const webContentsListeners = new Map<string, () => void>()
  const webContents = {
    mainFrame: {},
    on: vi.fn((event: string, listener: () => void) => webContentsListeners.set(event, listener)),
    removeListener: vi.fn((event: string) => webContentsListeners.delete(event)),
    send: vi.fn()
  }
  const isDestroyed = vi.fn(() => false)
  const removeWindowListener = vi.fn((event: string) => windowListeners.delete(event))
  return {
    isDestroyed,
    removeWindowListener,
    window: {
      isDestroyed,
      on: vi.fn((event: string, listener: () => void) => windowListeners.set(event, listener)),
      removeListener: removeWindowListener,
      webContents
    } as unknown as Electron.BrowserWindow,
    webContents,
    windowListeners,
    webContentsListeners
  }
}

function findById(
  items: readonly MenuItemConstructorOptions[],
  id: string
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.id === id) return item
    const nested = Array.isArray(item.submenu) ? findById(item.submenu, id) : undefined
    if (nested) return nested
  }
  return undefined
}

function findByRole(
  items: readonly MenuItemConstructorOptions[],
  role: string
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.role === role) return item
    const nested = Array.isArray(item.submenu) ? findByRole(item.submenu, role) : undefined
    if (nested) return nested
  }
  return undefined
}

function findByLabel(
  items: readonly MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.label === label) return item
    const nested = Array.isArray(item.submenu) ? findByLabel(item.submenu, label) : undefined
    if (nested) return nested
  }
  return undefined
}
