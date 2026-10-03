// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { useState } from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ApplicationSnapshot,
  ConfigurationSnapshot,
  MutationResult
} from '@agent-workspace/protocol-client'
import { terminalTheme } from '@agent-workspace/design-tokens/terminal-theme'

import type { DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'

import { defaultCommandRegistry } from '../commands/registry'
import { clearShortcutCapture, setShortcutCapture } from '../commands/shortcut-capture'
import { resetConfigurationStoreForTests, useConfigurationStore } from '../configuration-store'
import { messages } from '../messages'
import { TerminalPane } from './TerminalPane'

const terminalFontStack = (fontFamily: string): string =>
  `${fontFamily}, "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", "Symbols Nerd Font", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"`

const terminalSpies = vi.hoisted(() => ({
  constructorOptions: undefined as Record<string, unknown> | undefined,
  customKeyEventHandler: undefined as ((event: KeyboardEvent) => boolean) | undefined,
  fit: undefined as (() => void) | undefined,
  hasSelection: false,
  instance: undefined as
    | {
        cols: number
        buffer: { active: { baseY: number; type: string; viewportY: number } }
        options: {
          cursorBlink?: boolean
          fontFamily?: string
          fontSize?: number
          screenReaderMode?: boolean
          scrollback?: number
        }
        rows: number
      }
    | undefined,
  linkActivate: undefined as ((event: MouseEvent, text: string) => void) | undefined,
  linkHover: undefined as ((event: MouseEvent, text: string) => void) | undefined,
  linkLeave: undefined as (() => void) | undefined,
  onData: undefined as ((data: string) => void) | undefined,
  onTitleChange: undefined as ((title: string) => void) | undefined,
  reset: vi.fn(),
  resizeObserver: undefined as ResizeObserverCallback | undefined,
  scrollToLine: vi.fn(),
  selection: ''
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    public buffer = { active: { baseY: 0, type: 'normal', viewportY: 0 } }
    public cols = 120
    public options: {
      cursorBlink?: boolean
      fontFamily?: string
      fontSize?: number
      screenReaderMode?: boolean
      scrollback?: number
    } = {}
    public rows = 30
    public unicode = { activeVersion: '' }

    public constructor(options: Record<string, unknown>) {
      terminalSpies.constructorOptions = options
      this.options = { ...options }
      terminalSpies.instance = this
    }

    public attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      terminalSpies.customKeyEventHandler = handler
    }

    public dispose(): void {}
    public focus(): void {}
    public getSelection(): string {
      return terminalSpies.selection
    }
    public hasSelection(): boolean {
      return terminalSpies.hasSelection
    }
    public loadAddon(): void {}
    public onData(listener: (data: string) => void): { dispose(): void } {
      terminalSpies.onData = listener
      return { dispose: () => undefined }
    }
    public onSelectionChange(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    public onTitleChange(listener: (title: string) => void): { dispose(): void } {
      terminalSpies.onTitleChange = listener
      return { dispose: () => undefined }
    }
    public open(): void {}
    public reset(): void {
      terminalSpies.reset()
    }
    public scrollToLine(line: number): void {
      terminalSpies.scrollToLine(line)
      this.buffer.active.viewportY = line
    }
    public resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }
    public write(_data: string | Uint8Array, callback?: () => void): void {
      callback?.()
    }
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    public fit(): void {
      terminalSpies.fit?.()
    }
  }
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    public findNext(): void {}
    public findPrevious(): void {}
  }
}))
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    public serialize(): string {
      return ''
    }
  }
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    public constructor(
      handler: (event: MouseEvent, uri: string) => void,
      options: { hover: (event: MouseEvent, text: string) => void; leave: () => void }
    ) {
      terminalSpies.linkActivate = handler
      terminalSpies.linkHover = options.hover
      terminalSpies.linkLeave = options.leave
    }
  }
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    public dispose(): void {}
    public onContextLoss(): void {}
  }
}))

class ResizeObserverMock {
  public constructor(callback: ResizeObserverCallback) {
    terminalSpies.resizeObserver = callback
  }
  public disconnect(): void {}
  public observe(): void {}
}

const terminalId = '10000000-0000-4000-8000-000000000001'
const workspaceId = '10000000-0000-4000-8000-000000000002'
const tabId = '10000000-0000-4000-8000-000000000003'

afterEach(() => {
  cleanup()
  resetConfigurationStoreForTests()
  terminalSpies.constructorOptions = undefined
  terminalSpies.instance = undefined
  terminalSpies.fit = undefined
  terminalSpies.hasSelection = false
  terminalSpies.linkActivate = undefined
  terminalSpies.linkHover = undefined
  terminalSpies.linkLeave = undefined
  terminalSpies.onData = undefined
  terminalSpies.onTitleChange = undefined
  terminalSpies.reset.mockReset()
  terminalSpies.resizeObserver = undefined
  terminalSpies.scrollToLine.mockReset()
  terminalSpies.selection = ''
  vi.unstubAllGlobals()
})

describe('TerminalPane', () => {
  it('wires catalog copy to the pane, toolbar controls, process metadata, and link target', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    window.desktopBridge = terminalBridge({
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane()

    await screen.findByText(messages.terminalPane.status.connected, {
      selector: '.terminal-statusbar span'
    })
    expect(screen.getByRole('region', { name: messages.terminalPane.label })).toBeVisible()
    expect(
      screen.getByRole('textbox', { name: messages.terminalPane.search.label })
    ).toHaveAttribute('placeholder', messages.terminalPane.search.placeholder)
    expect(
      screen.getByRole('button', { name: messages.terminalPane.controls.decreaseFontSize })
    ).toHaveTextContent(messages.terminalPane.controls.decreaseFontSizeIndicator)
    expect(
      screen.getByRole('checkbox', { name: messages.terminalPane.controls.copySelection })
    ).not.toBeChecked()
    expect(screen.getByText(messages.terminalPane.processId(42))).toBeVisible()

    terminalSpies.linkHover?.(new MouseEvent('mouseenter'), 'https://example.test/docs')
    expect(
      await screen.findByText(messages.terminalPane.openLink('https://example.test/docs'))
    ).toBeVisible()
    terminalSpies.linkLeave?.()
    await waitFor(() =>
      expect(
        screen.queryByText(messages.terminalPane.openLink('https://example.test/docs'))
      ).not.toBeInTheDocument()
    )
  })

  it('opens plain and OSC 8 links through the safe desktop bridge', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const bridge = terminalBridge({
      openExternal,
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })
    window.desktopBridge = bridge
    renderTerminalPane()
    await screen.findByText(messages.terminalPane.status.connected, {
      selector: '.terminal-statusbar span'
    })

    const plainEvent = new MouseEvent('mouseup', { bubbles: true })
    const preventPlainDefault = vi.spyOn(plainEvent, 'preventDefault')
    terminalSpies.linkActivate?.(plainEvent, 'https://example.test/plain')

    const oscHandler = terminalSpies.constructorOptions?.linkHandler as
      | {
          activate(event: MouseEvent, uri: string): void
          allowNonHttpProtocols: boolean
          hover(event: MouseEvent, uri: string): void
          leave(): void
        }
      | undefined
    expect(oscHandler?.allowNonHttpProtocols).toBe(false)
    const oscEvent = new MouseEvent('mouseup', { bubbles: true })
    const preventOscDefault = vi.spyOn(oscEvent, 'preventDefault')
    oscHandler?.activate(oscEvent, 'https://example.test/osc')

    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2))
    expect(openExternal).toHaveBeenNthCalledWith(1, 'https://example.test/plain')
    expect(openExternal).toHaveBeenNthCalledWith(2, 'https://example.test/osc')
    expect(preventPlainDefault).toHaveBeenCalledOnce()
    expect(preventOscDefault).toHaveBeenCalledOnce()

    oscHandler?.hover(new MouseEvent('mouseenter'), 'https://example.test/osc')
    expect(
      await screen.findByText(messages.terminalPane.openLink('https://example.test/osc'))
    ).toBeVisible()
    oscHandler?.leave()
  })

  it('reports terminal link launch failures without an unhandled rejection', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    window.desktopBridge = terminalBridge({
      openExternal: vi.fn().mockRejectedValue(new Error('No default browser')),
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })
    renderTerminalPane()
    await screen.findByText(messages.terminalPane.status.connected, {
      selector: '.terminal-statusbar span'
    })

    terminalSpies.linkActivate?.(new MouseEvent('mouseup'), 'https://example.test/unavailable')

    expect(
      await screen.findByText(messages.terminalPane.errors.openLinkFailed, {
        selector: '.terminal-statusbar span'
      })
    ).toBeVisible()
  })

  it('checkpoints a clean recovery boundary immediately after a truncated attach', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const checkpointTerminal = vi.fn<DesktopBridge['checkpointTerminal']>().mockResolvedValue()
    const attachTerminal = vi.fn<DesktopBridge['attachTerminal']>().mockResolvedValue({
      ...terminalAttachResult(false),
      output: [{ sequence: 7, data: 'G1szMW0=', byteLength: 5 }],
      lastSequence: 7,
      reconstructionComplete: false
    })
    window.desktopBridge = terminalBridge({
      attachTerminal,
      checkpointTerminal,
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane()

    await screen.findByText(messages.terminalPane.status.connectedWithTruncatedScrollback, {
      selector: '.terminal-statusbar span'
    })
    await waitFor(() =>
      expect(checkpointTerminal).toHaveBeenCalledWith(
        terminalId,
        expect.objectContaining({ sequence: 7, data: '' })
      )
    )
  })

  it('opens terminal tools with the find shortcut and closes them with Escape', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    window.desktopBridge = terminalBridge({
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })
    const onToolsOpenChange = vi.fn()
    const props = {
      onMutation: async (operation: Promise<MutationResult>) => {
        await operation
        return true
      },
      onToolsOpenChange,
      tabId,
      terminalId,
      title: 'Shell',
      workspaceId
    }
    const view = render(<TerminalPane {...props} toolsOpen={false} />)
    await screen.findByText(messages.terminalPane.status.connected, {
      selector: '.terminal-statusbar span'
    })

    fireEvent.keyDown(screen.getByRole('region', { name: messages.terminalPane.label }), {
      ctrlKey: true,
      key: 'f'
    })
    expect(onToolsOpenChange).toHaveBeenLastCalledWith(true)

    view.rerender(<TerminalPane {...props} toolsOpen />)
    fireEvent.keyDown(screen.getByRole('region', { name: messages.terminalPane.label }), {
      key: 'Escape'
    })
    expect(onToolsOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('declines keydown events that match a registered application shortcut', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    window.desktopBridge = terminalBridge({
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })
    render(
      <TerminalPane
        onMutation={async (operation: Promise<MutationResult>) => {
          await operation
          return true
        }}
        onToolsOpenChange={vi.fn()}
        tabId={tabId}
        terminalId={terminalId}
        title="Shell"
        toolsOpen={false}
        workspaceId={workspaceId}
      />
    )
    await screen.findByText(messages.terminalPane.status.connected, {
      selector: '.terminal-statusbar span'
    })
    const handler = terminalSpies.customKeyEventHandler
    expect(handler).toBeDefined()

    setShortcutCapture(defaultCommandRegistry, {}, 'other')
    try {
      const newTabShortcut = new KeyboardEvent('keydown', { ctrlKey: true, key: 't' })
      expect(handler!(newTabShortcut)).toBe(false)
      const plainTyping = new KeyboardEvent('keydown', { key: 'a' })
      expect(handler!(plainTyping)).toBe(true)
      const terminalInterrupt = new KeyboardEvent('keydown', { ctrlKey: true, key: 'c' })
      expect(handler!(terminalInterrupt)).toBe(true)
    } finally {
      clearShortcutCapture()
    }
  })

  it('copies the selected terminal text with Ctrl+Shift+C without sending an interrupt', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const writeText = vi.fn().mockResolvedValue(undefined)
    const previousClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    window.desktopBridge = terminalBridge({
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })
    terminalSpies.hasSelection = true
    terminalSpies.selection = 'selected output'

    renderTerminalPane()
    await screen.findByText(messages.terminalPane.status.connected, {
      selector: '.terminal-statusbar span'
    })

    const handler = terminalSpies.customKeyEventHandler
    expect(handler).toBeDefined()
    expect(
      handler!(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'c' }))
    ).toBe(false)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('selected output'))
    expect(handler!(new KeyboardEvent('keydown', { ctrlKey: true, key: 'c' }))).toBe(true)

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: previousClipboard
    })
  })

  it('reports the attached command basename and sanitized xterm title as process metadata', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const onProcessTitleChange = vi.fn()
    window.desktopBridge = terminalBridge({
      attachTerminal: vi
        .fn<DesktopBridge['attachTerminal']>()
        .mockResolvedValue(
          terminalAttachResult(false, ['C:\\Program Files\\PowerShell\\pwsh.exe'])
        ),
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane(onProcessTitleChange)

    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    expect(onProcessTitleChange).toHaveBeenCalledWith('pwsh.exe')

    terminalSpies.onTitleChange?.(' \u001bPowerShell\u007f ')
    await waitFor(() => expect(onProcessTitleChange).toHaveBeenLastCalledWith('PowerShell'))
  })

  it('retains the last process title when the terminal unmounts during a workspace switch', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const onProcessTitleChange = vi.fn()
    window.desktopBridge = terminalBridge({
      attachTerminal: vi
        .fn<DesktopBridge['attachTerminal']>()
        .mockResolvedValue(terminalAttachResult(false, ['/usr/bin/codex'])),
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    const terminal = renderTerminalPane(onProcessTitleChange)

    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    terminalSpies.onTitleChange?.('Running implementation')
    await waitFor(() =>
      expect(onProcessTitleChange).toHaveBeenLastCalledWith('Running implementation')
    )

    terminal.unmount()

    expect(onProcessTitleChange).not.toHaveBeenCalledWith('')
    expect(onProcessTitleChange).toHaveBeenLastCalledWith('Running implementation')
  })

  it('hydrates terminal options once and applies live option and paste-policy updates', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const sendTerminalInput = vi
      .fn<DesktopBridge['sendTerminalInput']>()
      .mockResolvedValue(undefined)
    const confirm = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirm)
    const initial = configuration({
      fontFamily: 'Iosevka',
      fontSize: 16,
      scrollback: 42_000,
      multilinePasteProtection: false
    })
    useConfigurationStore.setState({ config: initial, status: 'ready' })
    window.desktopBridge = terminalBridge({
      restartTerminal: vi.fn().mockResolvedValue(mutationResult()),
      sendTerminalInput
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    expect(terminalSpies.constructorOptions).toMatchObject({
      fontFamily: terminalFontStack('Iosevka'),
      fontSize: 16,
      scrollback: 42_000
    })

    terminalSpies.onData?.('first\nsecond')
    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(sendTerminalInput).toHaveBeenCalledWith(terminalId, 'first\nsecond')
    )

    useConfigurationStore.getState().apply(
      configuration({
        fontFamily: 'Berkeley Mono',
        fontSize: 18,
        scrollback: 8_000,
        multilinePasteProtection: true
      })
    )
    await waitFor(() =>
      expect(terminalSpies.instance?.options).toMatchObject({
        fontFamily: terminalFontStack('Berkeley Mono'),
        fontSize: 18,
        scrollback: 8_000
      })
    )
    terminalSpies.onData?.('blocked\nlines')
    expect(confirm).toHaveBeenCalledWith(messages.terminalPane.pasteLinesPrompt(2))
    expect(sendTerminalInput).toHaveBeenCalledTimes(1)
  })

  it('sends rapid terminal input in order', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    let releaseFirst: (() => void) | undefined
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const sendTerminalInput = vi.fn<DesktopBridge['sendTerminalInput']>((_id, data) =>
      data === 'e' ? firstSend : Promise.resolve()
    )
    window.desktopBridge = terminalBridge({
      restartTerminal: vi.fn().mockResolvedValue(mutationResult()),
      sendTerminalInput
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    for (const character of ['e', 'c', 'h', 'o', '\r']) terminalSpies.onData?.(character)

    await waitFor(() => expect(sendTerminalInput).toHaveBeenCalledTimes(1))
    releaseFirst?.()
    await waitFor(() => expect(sendTerminalInput).toHaveBeenCalledTimes(5))
    expect(sendTerminalInput.mock.calls.map(([, data]) => data)).toEqual([
      'e',
      'c',
      'h',
      'o',
      '\r'
    ])
  })

  it('keeps xterm screen-reader output opt-in and under direct user control', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    window.desktopBridge = terminalBridge({
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })

    const control = screen.getByRole('checkbox', { name: 'Screen reader mode' })
    expect(control).not.toBeChecked()
    expect(terminalSpies.constructorOptions).toMatchObject({ screenReaderMode: false })
    expect(terminalSpies.constructorOptions).toMatchObject({ cursorBlink: false })
    expect(terminalSpies.constructorOptions).toMatchObject({ reflowCursorLine: true })
    expect(terminalSpies.constructorOptions).toMatchObject({ theme: terminalTheme })
    expect(terminalSpies.instance?.options.screenReaderMode).toBe(false)

    control.focus()
    expect(control).toHaveFocus()

    fireEvent.click(control)
    await waitFor(() => expect(terminalSpies.instance?.options.screenReaderMode).toBe(true))

    fireEvent.click(control)
    await waitFor(() => expect(terminalSpies.instance?.options.screenReaderMode).toBe(false))
  })

  it('reports a rejected restart, stays retryable, and applies a successful retry once', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const result = mutationResult()
    const restartTerminal = vi
      .fn<DesktopBridge['restartTerminal']>()
      .mockRejectedValueOnce(new Error('restart was rejected'))
      .mockResolvedValueOnce(result)
    window.desktopBridge = terminalBridge({ restartTerminal, exited: true })
    const applyMutation = vi.fn()

    function Harness(): React.JSX.Element {
      const [mutationError, setMutationError] = useState<string | null>(null)
      return (
        <>
          {mutationError ? <div role="alert">{mutationError}</div> : null}
          <TerminalPane
            onMutation={async (operation) => {
              try {
                applyMutation(await operation)
                setMutationError(null)
                return true
              } catch (error) {
                setMutationError(error instanceof Error ? error.message : 'Restart failed')
                return false
              }
            }}
            onToolsOpenChange={() => undefined}
            tabId={tabId}
            terminalId={terminalId}
            title="Shell"
            toolsOpen={false}
            workspaceId={workspaceId}
          />
        </>
      )
    }

    render(<Harness />)

    const restart = await screen.findByRole('button', { name: 'Restart terminal' })
    expect(screen.getByText(messages.terminalPane.exit.withCode(1))).toBeVisible()
    fireEvent.click(restart)

    expect(await screen.findByRole('alert')).toHaveTextContent('restart was rejected')
    expect(
      screen.getByText('Process exited', { selector: '.terminal-statusbar span' })
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Restart terminal' })).toBeEnabled()
    expect(applyMutation).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }))

    await waitFor(() => expect(applyMutation).toHaveBeenCalledOnce())
    expect(applyMutation).toHaveBeenCalledWith(result)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restart terminal' })).not.toBeInTheDocument()
    expect(screen.getByText('Connected', { selector: '.terminal-statusbar span' })).toBeVisible()
    expect(restartTerminal).toHaveBeenCalledTimes(2)
  })

  it('offers pane-local recovery when the authoritative terminal can no longer attach', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const result = mutationResult()
    const applyMutation = vi.fn()
    const restartTerminal = vi.fn<DesktopBridge['restartTerminal']>().mockResolvedValue(result)
    window.desktopBridge = terminalBridge({
      attachTerminal: vi.fn().mockRejectedValue(new Error('NotFound: terminal was pruned')),
      restartTerminal
    })

    render(
      <TerminalPane
        onMutation={async (operation) => {
          applyMutation(await operation)
          return true
        }}
        onToolsOpenChange={() => undefined}
        tabId={tabId}
        terminalId={terminalId}
        title="Shell"
        toolsOpen={false}
        workspaceId={workspaceId}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Terminal attach failed. NotFound: terminal was pruned'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }))

    await waitFor(() => expect(applyMutation).toHaveBeenCalledOnce())
    expect(applyMutation).toHaveBeenCalledWith(result)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Connected', { selector: '.terminal-statusbar span' })).toBeVisible()
  })

  it('catches and reports terminal input rejection without an unhandled promise', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    const sendTerminalInput = vi
      .fn<DesktopBridge['sendTerminalInput']>()
      .mockRejectedValue(new Error('terminal already exited'))
    window.desktopBridge = terminalBridge({
      restartTerminal: vi.fn().mockResolvedValue(mutationResult()),
      sendTerminalInput
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    terminalSpies.onData?.('echo hello')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Terminal input failed. terminal already exited'
    )
    expect(unhandled).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', unhandled)
  })

  it('catches and reports observer-driven resize rejection without an unhandled promise', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    const resizeTerminal = vi
      .fn<DesktopBridge['resizeTerminal']>()
      .mockRejectedValue(new Error('terminal session unavailable'))
    window.desktopBridge = terminalBridge({
      resizeTerminal,
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    if (terminalSpies.instance) {
      terminalSpies.instance.cols = 121
    }
    terminalSpies.resizeObserver?.([], {} as ResizeObserver)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Terminal resize failed. terminal session unavailable'
    )
    expect(resizeTerminal).toHaveBeenCalledWith(terminalId, 30, 121)
    expect(unhandled).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', unhandled)
  })

  it('serializes resizes and sends the latest dimensions after an in-flight resize', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    let finishFirst: (() => void) | undefined
    const resizeTerminal = vi
      .fn<DesktopBridge['resizeTerminal']>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve
          })
      )
      .mockResolvedValue(undefined)
    window.desktopBridge = terminalBridge({
      resizeTerminal,
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    const terminal = terminalSpies.instance
    if (!terminal) throw new Error('Expected the xterm instance')

    terminal.cols = 121
    terminalSpies.resizeObserver?.([], {} as ResizeObserver)
    await waitFor(() => expect(resizeTerminal).toHaveBeenCalledWith(terminalId, 30, 121))

    terminal.cols = 122
    terminalSpies.resizeObserver?.([], {} as ResizeObserver)
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(resizeTerminal).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishFirst?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(resizeTerminal).toHaveBeenCalledWith(terminalId, 30, 122))
    expect(resizeTerminal).toHaveBeenCalledTimes(2)
  })

  it('corrects a late resize event that reports old service dimensions', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    let onTerminalEvent: Parameters<DesktopBridge['onTerminalEvent']>[0] | undefined
    const resizeTerminal = vi.fn<DesktopBridge['resizeTerminal']>().mockResolvedValue(undefined)
    window.desktopBridge = terminalBridge({
      onTerminalEvent: (listener) => {
        onTerminalEvent = listener
        return () => undefined
      },
      resizeTerminal,
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    const terminal = terminalSpies.instance
    if (!terminal) throw new Error('Expected the xterm instance')
    terminal.cols = 122
    terminalSpies.resizeObserver?.([], {} as ResizeObserver)
    await waitFor(() => expect(resizeTerminal).toHaveBeenCalledWith(terminalId, 30, 122))

    onTerminalEvent?.({
      event: 'terminal.resized',
      data: { terminalId, rows: 30, cols: 121 }
    })
    await waitFor(() => expect(resizeTerminal).toHaveBeenCalledTimes(2))
    expect(resizeTerminal).toHaveBeenLastCalledWith(terminalId, 30, 122)
  })

  it('preserves the scroll distance from the bottom while fitting a resized terminal', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const resizeTerminal = vi.fn<DesktopBridge['resizeTerminal']>().mockResolvedValue(undefined)
    window.desktopBridge = terminalBridge({
      resizeTerminal,
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    const terminal = terminalSpies.instance
    if (!terminal) throw new Error('Expected the xterm instance')
    terminal.buffer.active.baseY = 120
    terminal.buffer.active.viewportY = 80
    terminal.cols = 121
    terminalSpies.fit = () => {
      terminal.buffer.active.baseY = 150
      terminal.buffer.active.viewportY = 150
    }

    terminalSpies.resizeObserver?.([], {} as ResizeObserver)

    await waitFor(() => expect(resizeTerminal).toHaveBeenCalledWith(terminalId, 30, 121))
    expect(terminalSpies.scrollToLine).toHaveBeenCalledWith(110)
    expect(terminal.buffer.active.viewportY).toBe(110)
  })

  it('does not reapply a stale scroll anchor after an asynchronous resize', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    let resolveResize: (() => void) | undefined
    const resizeTerminal = vi.fn<DesktopBridge['resizeTerminal']>(
      () =>
        new Promise<void>((resolve) => {
          resolveResize = resolve
        })
    )
    window.desktopBridge = terminalBridge({
      resizeTerminal,
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    renderTerminalPane()
    await screen.findByText('Connected', { selector: '.terminal-statusbar span' })
    const terminal = terminalSpies.instance
    if (!terminal) throw new Error('Expected the xterm instance')
    terminal.buffer.active.baseY = 120
    terminal.buffer.active.viewportY = 80
    terminal.cols = 121
    terminalSpies.fit = () => {
      terminal.buffer.active.baseY = 150
      terminal.buffer.active.viewportY = 150
    }

    terminalSpies.resizeObserver?.([], {} as ResizeObserver)

    await waitFor(() => expect(resizeTerminal).toHaveBeenCalledWith(terminalId, 30, 121))
    expect(terminalSpies.scrollToLine).toHaveBeenCalledOnce()
    expect(terminal.buffer.active.viewportY).toBe(110)

    // A PTY commonly emits output while handling SIGWINCH. xterm keeps a user-scrolled
    // viewport stationary; resolving the resize must not overwrite that with the old anchor.
    terminal.buffer.active.baseY = 160
    await act(async () => {
      resolveResize?.()
      await Promise.resolve()
    })

    expect(terminalSpies.scrollToLine).toHaveBeenCalledOnce()
    expect(terminal.buffer.active.viewportY).toBe(110)
  })

  it('finishes old checkpoint and detach before a remount attaches the same terminal', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    let releaseCheckpoint: (() => void) | undefined
    const checkpointTerminal = vi
      .fn<DesktopBridge['checkpointTerminal']>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseCheckpoint = resolve
          })
      )
      .mockResolvedValue(undefined)
    const attachTerminal = vi
      .fn<DesktopBridge['attachTerminal']>()
      .mockResolvedValue(terminalAttachResult(false))
    const detachTerminal = vi.fn<DesktopBridge['detachTerminal']>().mockResolvedValue(undefined)
    window.desktopBridge = terminalBridge({
      attachTerminal,
      checkpointTerminal,
      detachTerminal,
      restartTerminal: vi.fn().mockResolvedValue(mutationResult())
    })

    const first = renderTerminalPane()
    await waitFor(() => expect(checkpointTerminal).toHaveBeenCalledOnce())
    first.unmount()
    renderTerminalPane()

    expect(attachTerminal).toHaveBeenCalledOnce()
    expect(detachTerminal).not.toHaveBeenCalled()

    releaseCheckpoint?.()

    await waitFor(() => expect(attachTerminal).toHaveBeenCalledTimes(2))
    expect(detachTerminal).toHaveBeenCalledOnce()
    const checkpointOrder = checkpointTerminal.mock.invocationCallOrder[0]
    const detachOrder = detachTerminal.mock.invocationCallOrder[0]
    const secondAttachOrder = attachTerminal.mock.invocationCallOrder[1]
    if (
      checkpointOrder === undefined ||
      detachOrder === undefined ||
      secondAttachOrder === undefined
    ) {
      throw new Error('Expected checkpoint, detach, and remount attach call order entries.')
    }
    expect(checkpointOrder).toBeLessThan(detachOrder)
    expect(detachOrder).toBeLessThan(secondAttachOrder)
  })
})

interface TerminalBridgeOptions {
  attachTerminal?: DesktopBridge['attachTerminal']
  checkpointTerminal?: DesktopBridge['checkpointTerminal']
  detachTerminal?: DesktopBridge['detachTerminal']
  exited?: boolean
  openExternal?: DesktopBridge['openExternal']
  onTerminalEvent?: DesktopBridge['onTerminalEvent']
  resizeTerminal?: DesktopBridge['resizeTerminal']
  restartTerminal: DesktopBridge['restartTerminal']
  sendTerminalInput?: DesktopBridge['sendTerminalInput']
}

function terminalBridge({
  attachTerminal,
  checkpointTerminal,
  detachTerminal,
  exited = false,
  openExternal,
  onTerminalEvent,
  resizeTerminal,
  restartTerminal,
  sendTerminalInput
}: TerminalBridgeOptions): DesktopBridge {
  return {
    attachTerminal: attachTerminal ?? vi.fn().mockResolvedValue(terminalAttachResult(exited)),
    checkpointTerminal: checkpointTerminal ?? vi.fn().mockResolvedValue(undefined),
    detachTerminal: detachTerminal ?? vi.fn().mockResolvedValue(undefined),
    onTerminalEvent: onTerminalEvent ?? vi.fn(() => () => undefined),
    openExternal: openExternal ?? vi.fn().mockResolvedValue(undefined),
    resizeTerminal: resizeTerminal ?? vi.fn().mockResolvedValue(undefined),
    restartTerminal,
    sendTerminalInput: sendTerminalInput ?? vi.fn().mockResolvedValue(undefined)
  } as unknown as DesktopBridge
}

function renderTerminalPane(
  onProcessTitleChange?: (title: string) => void
): ReturnType<typeof render> {
  return render(
    <TerminalPane
      onMutation={async (operation) => {
        await operation
        return true
      }}
      {...(onProcessTitleChange ? { onProcessTitleChange } : {})}
      onToolsOpenChange={() => undefined}
      tabId={tabId}
      terminalId={terminalId}
      title="Shell"
      toolsOpen
      workspaceId={workspaceId}
    />
  )
}

function terminalAttachResult(exited: boolean, command: string[] = ['/bin/sh']) {
  return {
    terminal: {
      id: terminalId,
      processId: 42,
      command,
      cwd: '/',
      rows: 30,
      cols: 120,
      exited,
      ...(exited ? { exitCode: 1 } : {})
    },
    output: [],
    lastSequence: 0,
    reconstructionComplete: true
  }
}

function mutationResult(): MutationResult {
  const snapshot: ApplicationSnapshot = {
    revision: 2,
    workspaces: [],
    selectedWorkspaceId: workspaceId,
    shortcutOverrides: [],
    attention: { unreadCount: 0, highestLevel: null, latestUnread: null }
  }
  return { revision: snapshot.revision, snapshot }
}

function configuration(
  terminal: Omit<ConfigurationSnapshot['terminal'], 'shellPath'>
): ConfigurationSnapshot {
  return {
    schemaVersion: 1,
    revision: 4,
    appearance: { theme: 'system', density: 'comfortable', fontFamily: 'system-ui' },
    terminal: { shellPath: null, ...terminal },
    browser: { profileName: 'Default', partition: 'default', privacy: 'standard' },
    notifications: { systemEnabled: true, includeBody: false },
    keyboardShortcuts: { overrides: {} },
    agentIntegration: { enabled: true, notificationsEnabled: true, browserEnabled: true },
    updates: { channel: 'stable' },
    logging: { level: 'info' }
  }
}
