import { useEffect, useRef, useState } from 'react'

import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { X } from 'lucide-react'
import { terminalTheme } from '@agent-workspace/design-tokens/terminal-theme'
import { MAX_TERMINAL_CHECKPOINT_WIRE_BYTES } from '@agent-workspace/protocol-client'
import type { MutationResult, TerminalConfiguration } from '@agent-workspace/protocol-client'

import { eventMatchesRegisteredShortcut } from '../commands/shortcut-capture'
import { useConfigurationStore } from '../configuration-store'
import { messages } from '../messages'
import { CheckpointScheduler } from './CheckpointScheduler'
import { TerminalReconciler } from './TerminalReconciler'
import { DENY_OSC52_CLIPBOARD_PROVIDER } from './clipboard-policy'
import { withTerminalGlyphFallbacks } from './terminal-fonts'

const RESIZE_DEBOUNCE_MS = 50
const DEFAULT_TERMINAL_CONFIGURATION: TerminalConfiguration = Object.freeze({
  shellPath: null,
  fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
  fontSize: 13,
  scrollback: 10_000,
  multilinePasteProtection: true
})
const attachmentTransitions = new Map<string, Promise<void>>()

interface TerminalScrollAnchor {
  readonly distanceFromBottom: number
}

function captureScrollAnchor(terminal: Terminal): TerminalScrollAnchor {
  const buffer = terminal.buffer.active
  return { distanceFromBottom: Math.max(0, buffer.baseY - buffer.viewportY) }
}

function restoreScrollAnchor(terminal: Terminal, anchor: TerminalScrollAnchor): void {
  if (anchor.distanceFromBottom === 0) return
  terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - anchor.distanceFromBottom))
}

function isTerminalCopyShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  return (
    event.type === 'keydown' &&
    key === 'c' &&
    !event.altKey &&
    ((event.ctrlKey && event.shiftKey && !event.metaKey) ||
      (event.metaKey && !event.ctrlKey && !event.shiftKey))
  )
}

function serializeAttachmentTransition<T>(
  terminalId: string,
  transition: () => Promise<T>
): Promise<T> {
  const previous = attachmentTransitions.get(terminalId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(transition)
  const tail = current.then(
    () => undefined,
    () => undefined
  )
  attachmentTransitions.set(terminalId, tail)
  void tail.then(() => {
    if (attachmentTransitions.get(terminalId) === tail) {
      attachmentTransitions.delete(terminalId)
    }
  })
  return current
}

interface ExitState {
  code: number
  signal: string | null
}

interface TerminalIdentity {
  id: string
  processId: number | undefined
}

interface PaneError {
  message: string
  recoverable: boolean
}

export interface TerminalPaneProps {
  onMutation: (operation: Promise<MutationResult>) => Promise<boolean>
  onProcessTitleChange?: (title: string) => void
  onToolsOpenChange: (open: boolean) => void
  tabId: string
  terminalId: string
  title: string
  toolsOpen: boolean
  workspaceId: string
}

export function TerminalPane({
  onMutation,
  onProcessTitleChange,
  onToolsOpenChange,
  tabId,
  terminalId,
  title: initialTitle,
  toolsOpen,
  workspaceId
}: TerminalPaneProps): React.JSX.Element {
  const terminalConfiguration = useConfigurationStore(
    (state) => state.config?.terminal ?? DEFAULT_TERMINAL_CONFIGURATION
  )
  const terminalConfigurationRef = useRef(terminalConfiguration)
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const toolsOpenRef = useRef(toolsOpen)
  const syncSizeRef = useRef<(() => void) | null>(null)
  const terminalIdRef = useRef<string | undefined>(terminalId)
  const copyOnSelectRef = useRef(false)
  const multilinePasteProtectionRef = useRef(terminalConfiguration.multilinePasteProtection)
  const onProcessTitleChangeRef = useRef(onProcessTitleChange)
  const initialTitleRef = useRef(initialTitle)
  const [status, setStatus] = useState<string>(messages.terminalPane.status.startingShell)
  const [exit, setExit] = useState<ExitState | null>(null)
  const [fontSize, setFontSize] = useState(terminalConfiguration.fontSize)
  const [copyOnSelect, setCopyOnSelect] = useState(false)
  const [screenReaderMode, setScreenReaderMode] = useState(false)
  const [search, setSearch] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regularExpression, setRegularExpression] = useState(false)
  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [identity, setIdentity] = useState<TerminalIdentity | null>(null)
  const [paneError, setPaneError] = useState<PaneError | null>(null)

  useEffect(() => {
    copyOnSelectRef.current = copyOnSelect
  }, [copyOnSelect])

  useEffect(() => {
    terminalConfigurationRef.current = terminalConfiguration
  }, [terminalConfiguration])

  useEffect(() => {
    const wasOpen = toolsOpenRef.current
    toolsOpenRef.current = toolsOpen
    if (toolsOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    } else if (wasOpen) {
      requestAnimationFrame(() => terminalRef.current?.focus())
    }
  }, [toolsOpen])

  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal) terminal.options.screenReaderMode = screenReaderMode
  }, [screenReaderMode])

  useEffect(() => {
    multilinePasteProtectionRef.current = terminalConfiguration.multilinePasteProtection
    queueMicrotask(() => setFontSize(terminalConfiguration.fontSize))
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontFamily = withTerminalGlyphFallbacks(terminalConfiguration.fontFamily)
    terminal.options.fontSize = terminalConfiguration.fontSize
    terminal.options.scrollback = terminalConfiguration.scrollback
    requestAnimationFrame(() => syncSizeRef.current?.())
  }, [terminalConfiguration])

  useEffect(() => {
    onProcessTitleChangeRef.current = onProcessTitleChange
  }, [onProcessTitleChange])

  useEffect(() => {
    initialTitleRef.current = initialTitle
  }, [initialTitle])

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    let disposed = false

    const openTerminalLink = (event: MouseEvent, uri: string): void => {
      event.preventDefault()
      void window.desktopBridge.openExternal(uri).catch(() => {
        if (!disposed) setStatus(messages.terminalPane.errors.openLinkFailed)
      })
    }
    const showTerminalLink = (_event: MouseEvent, uri: string): void => setLinkTarget(uri)
    const clearTerminalLink = (): void => setLinkTarget(null)

    const initialConfiguration = terminalConfigurationRef.current
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      // Keep the block cursor visible without continuously repainting an otherwise idle window.
      cursorBlink: false,
      cursorStyle: 'block',
      drawBoldTextInBrightColors: true,
      fontFamily: withTerminalGlyphFallbacks(initialConfiguration.fontFamily),
      fontSize: initialConfiguration.fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      lineHeight: 1.1,
      linkHandler: {
        activate: openTerminalLink,
        hover: showTerminalLink,
        leave: clearTerminalLink,
        allowNonHttpProtocols: false
      },
      screenReaderMode: false,
      scrollback: initialConfiguration.scrollback,
      theme: terminalTheme
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (isTerminalCopyShortcut(event)) {
        if (terminal.hasSelection()) {
          void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {
            if (!disposed) setStatus(messages.terminalPane.errors.copyFailed)
          })
        }
        return false
      }
      return !(event.type === 'keydown' && eventMatchesRegisteredShortcut(event))
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    const serializeAddon = new SerializeAddon()
    const unicodeAddon = new Unicode11Addon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(serializeAddon)
    terminal.loadAddon(unicodeAddon)
    terminal.loadAddon(new ClipboardAddon(undefined, DENY_OSC52_CLIPBOARD_PROVIDER))
    terminal.loadAddon(
      new WebLinksAddon(openTerminalLink, {
        hover: showTerminalLink,
        leave: clearTerminalLink
      })
    )
    terminal.unicode.activeVersion = '11'
    terminal.open(host)
    fitAddon.fit()

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        setStatus(messages.terminalPane.status.webglUnavailable)
      })
      terminal.loadAddon(webgl)
    } catch {
      queueMicrotask(() => {
        if (!disposed) {
          setStatus(messages.terminalPane.status.canvasRenderer)
        }
      })
    }

    terminalRef.current = terminal
    searchRef.current = searchAddon
    terminalIdRef.current = terminalId
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let restoring: Promise<void> | undefined
    let serviceRows = terminal.rows
    let serviceCols = terminal.cols

    const isCurrent = (): boolean =>
      !disposed && terminalRef.current === terminal && terminalIdRef.current === terminalId
    const reportPaneError = (context: string, error: unknown, recoverable = false): void => {
      if (!isCurrent()) {
        return
      }
      const detail =
        error instanceof Error ? error.message : messages.terminalPane.errors.serviceUnavailable
      const message = messages.terminalPane.errors.withDetail(context, detail)
      setPaneError({ message, recoverable })
      setStatus(message)
    }

    const reconciler = new TerminalReconciler(terminal, () => {
      void (restoring ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          const id = terminalIdRef.current
          if (id) {
            return restore(id, true)
          }
          return undefined
        })
    })

    const buildCheckpoint = () => {
      const terminalId = terminalIdRef.current
      if (!terminalId || terminal.rows < 1 || terminal.cols < 1) {
        return undefined
      }
      for (const scrollback of [1000, 500, 200, 50, 0]) {
        const checkpoint = {
          sequence: reconciler.lastAppliedSequence,
          rows: terminal.rows,
          cols: terminal.cols,
          activeBuffer: terminal.buffer.active.type,
          data: serializeAddon.serialize({ scrollback })
        } as const
        if (
          new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength <=
          MAX_TERMINAL_CHECKPOINT_WIRE_BYTES
        ) {
          return { terminalId, checkpoint }
        }
      }
      if (!disposed) {
        setStatus(messages.terminalPane.status.checkpointTooLarge)
      }
      return undefined
    }
    const captureCheckpoint = async (): Promise<void> => {
      await reconciler.whenIdle()
      const projection = buildCheckpoint()
      if (!projection) {
        return
      }
      await window.desktopBridge.checkpointTerminal(projection.terminalId, projection.checkpoint)
    }
    const scheduler = new CheckpointScheduler(captureCheckpoint)
    const syncTerminalSize = async (checkpointAfterResize = true): Promise<boolean> => {
      const scrollAnchor = captureScrollAnchor(terminal)
      fitAddon.fit()
      restoreScrollAnchor(terminal, scrollAnchor)
      if (!isCurrent() || (terminal.rows === serviceRows && terminal.cols === serviceCols)) {
        return true
      }
      try {
        await window.desktopBridge.resizeTerminal(terminalId, terminal.rows, terminal.cols)
        if (isCurrent()) {
          serviceRows = terminal.rows
          serviceCols = terminal.cols
          if (checkpointAfterResize) {
            scheduler.afterResize()
          }
        }
        return true
      } catch (error) {
        reportPaneError(messages.terminalPane.errors.resizeFailed, error)
        return false
      }
    }
    syncSizeRef.current = () => void syncTerminalSize()

    async function restore(terminalId: string, reset: boolean): Promise<void> {
      if (restoring) {
        return restoring
      }
      restoring = (async () => {
        const snapshot = await serializeAttachmentTransition(terminalId, () =>
          window.desktopBridge.attachTerminal(terminalId)
        )
        if (!isCurrent()) {
          return
        }
        setPaneError(null)
        setIdentity({ id: snapshot.terminal.id, processId: snapshot.terminal.processId })
        onProcessTitleChangeRef.current?.(
          processTitleFromCommand(snapshot.terminal.command, initialTitleRef.current)
        )
        serviceRows = snapshot.terminal.rows
        serviceCols = snapshot.terminal.cols
        if (snapshot.checkpoint) {
          terminal.resize(snapshot.checkpoint.cols, snapshot.checkpoint.rows)
        }
        if (reset) {
          terminal.reset()
        }
        await reconciler.restore(snapshot)
        const sizeSynced = await syncTerminalSize(false)
        if (!isCurrent()) {
          return
        }
        // Establish a recovery boundary immediately. This also converts a deliberately
        // reset, incomplete projection into a safe checkpoint at the latest sequence.
        void serializeAttachmentTransition(terminalId, captureCheckpoint).catch(() => undefined)
        setExit(
          snapshot.terminal.exited ? { code: snapshot.terminal.exitCode ?? 1, signal: null } : null
        )
        if (sizeSynced) {
          setStatus(
            snapshot.reconstructionComplete
              ? messages.terminalPane.status.connected
              : messages.terminalPane.status.connectedWithTruncatedScrollback
          )
        }
      })()
        .catch((error: unknown) =>
          reportPaneError(messages.terminalPane.errors.attachFailed, error, true)
        )
        .finally(() => {
          restoring = undefined
        })
      return restoring
    }

    const removeEventListener = window.desktopBridge.onTerminalEvent((event) => {
      const terminalId = terminalIdRef.current
      if (event.event === 'terminal.resyncRequired') {
        if (terminalId) {
          void restore(terminalId, true)
        }
        return
      }
      if (event.data.terminalId !== terminalId) {
        return
      }
      if (event.event === 'terminal.output') {
        void reconciler.applyChunk(event.data.chunk)
        scheduler.recordOutput(event.data.chunk.byteLength)
      } else if (event.event === 'terminal.resized') {
        serviceRows = event.data.rows
        serviceCols = event.data.cols
      } else if (event.event === 'terminal.checkpointRequested') {
        scheduler.request()
      } else if (event.event === 'terminal.exited') {
        setExit({ code: event.data.exitCode, signal: event.data.signal })
        setStatus(messages.terminalPane.status.processExited)
      }
    })

    const dataDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current
      if (!terminalId) {
        return
      }
      if (multilinePasteProtectionRef.current && data.length > 1 && /[\r\n]/.test(data)) {
        const lines = data.split(/\r\n|\r|\n/).length
        if (!window.confirm(messages.terminalPane.pasteLinesPrompt(lines))) {
          return
        }
      }
      void window.desktopBridge
        .sendTerminalInput(terminalId, data)
        .catch((error: unknown) => reportPaneError(messages.terminalPane.errors.inputFailed, error))
    })
    const titleDisposable = terminal.onTitleChange((nextTitle) => {
      const sanitized = sanitizeTitle(nextTitle)
      onProcessTitleChangeRef.current?.(sanitized)
    })
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (copyOnSelectRef.current && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection())
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer)
      }
      resizeTimer = setTimeout(() => {
        void syncTerminalSize()
      }, RESIZE_DEBOUNCE_MS)
    })
    resizeObserver.observe(host)

    void restore(terminalId, false).then(() => {
      if (isCurrent()) {
        terminal.focus()
      }
    })

    return () => {
      disposed = true
      resizeObserver.disconnect()
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer)
      }
      removeEventListener()
      dataDisposable.dispose()
      titleDisposable.dispose()
      selectionDisposable.dispose()
      scheduler.dispose()
      const terminalId = terminalIdRef.current
      const projection = buildCheckpoint()
      reconciler.dispose()
      terminal.dispose()
      if (terminalId) {
        void serializeAttachmentTransition(terminalId, async () => {
          try {
            if (projection) {
              await window.desktopBridge.checkpointTerminal(
                projection.terminalId,
                projection.checkpoint
              )
            }
          } finally {
            await window.desktopBridge.detachTerminal(terminalId)
          }
        }).catch(() => undefined)
      }
      terminalRef.current = null
      searchRef.current = null
      syncSizeRef.current = null
      // Keep the last authoritative title in the workspace card while this terminal is
      // unmounted. Switching workspaces detaches the visible terminal pane, but the terminal
      // session and its foreground task continue running in the service.
    }
  }, [terminalId])

  const changeFontSize = (next: number): void => {
    const clamped = Math.min(24, Math.max(9, next))
    setFontSize(clamped)
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = clamped
      requestAnimationFrame(() => syncSizeRef.current?.())
    }
  }

  const find = (direction: 'next' | 'previous'): void => {
    if (!search) {
      return
    }
    const options = {
      caseSensitive,
      incremental: true,
      regex: regularExpression,
      wholeWord
    }
    if (direction === 'next') {
      searchRef.current?.findNext(search, options)
    } else {
      searchRef.current?.findPrevious(search, options)
    }
  }

  const restart = async (): Promise<void> => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    const restartingTerminalId = terminalIdRef.current
    setStatus(messages.terminalPane.status.restartingShell)
    let succeeded = false
    try {
      succeeded = await onMutation(window.desktopBridge.restartTerminal({ workspaceId, tabId }))
      if (
        succeeded &&
        terminalRef.current === terminal &&
        terminalIdRef.current === restartingTerminalId
      ) {
        terminal.reset()
        setExit(null)
        setPaneError(null)
      }
    } catch {
      // The mutation owner normally converts rejection to `false`; keep this handler non-rejecting
      // if a different owner violates that contract.
    } finally {
      if (terminalRef.current === terminal && terminalIdRef.current === restartingTerminalId) {
        setStatus(
          succeeded
            ? messages.terminalPane.status.connected
            : (paneError?.message ?? messages.terminalPane.status.processExited)
        )
      }
    }
  }

  return (
    <section
      className="terminal-pane"
      aria-label={messages.terminalPane.label}
      data-process-id={identity?.processId}
      data-terminal-id={identity?.id}
      data-tools-open={toolsOpen}
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          event.stopPropagation()
          onToolsOpenChange(true)
        } else if (event.key === 'Escape' && toolsOpen) {
          event.preventDefault()
          event.stopPropagation()
          onToolsOpenChange(false)
        }
      }}
    >
      <header className="terminal-toolbar" hidden={!toolsOpen}>
        <div className="terminal-search" role="search">
          <input
            aria-label={messages.terminalPane.search.label}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                find(event.shiftKey ? 'previous' : 'next')
              }
            }}
            placeholder={messages.terminalPane.search.placeholder}
            ref={searchInputRef}
            value={search}
          />
          <button
            aria-label={messages.terminalPane.search.matchCase}
            aria-pressed={caseSensitive}
            onClick={() => setCaseSensitive((value) => !value)}
            type="button"
          >
            {messages.terminalPane.search.matchCaseIndicator}
          </button>
          <button
            aria-label={messages.terminalPane.search.matchWholeWord}
            aria-pressed={wholeWord}
            onClick={() => setWholeWord((value) => !value)}
            type="button"
          >
            {messages.terminalPane.search.matchWholeWordIndicator}
          </button>
          <button
            aria-label={messages.terminalPane.search.useRegularExpression}
            aria-pressed={regularExpression}
            onClick={() => setRegularExpression((value) => !value)}
            type="button"
          >
            {messages.terminalPane.search.regularExpressionIndicator}
          </button>
          <button
            aria-label={messages.terminalPane.search.previousMatch}
            onClick={() => find('previous')}
            type="button"
          >
            {messages.terminalPane.search.previousMatchIndicator}
          </button>
          <button
            aria-label={messages.terminalPane.search.nextMatch}
            onClick={() => find('next')}
            type="button"
          >
            {messages.terminalPane.search.nextMatchIndicator}
          </button>
        </div>
        <div className="terminal-controls">
          <button
            aria-label={messages.terminalPane.controls.decreaseFontSize}
            onClick={() => changeFontSize(fontSize - 1)}
            type="button"
          >
            {messages.terminalPane.controls.decreaseFontSizeIndicator}
          </button>
          <output aria-label={messages.terminalPane.controls.fontSize}>{fontSize}</output>
          <button
            aria-label={messages.terminalPane.controls.increaseFontSize}
            onClick={() => changeFontSize(fontSize + 1)}
            type="button"
          >
            {messages.terminalPane.controls.increaseFontSizeIndicator}
          </button>
          <label className="copy-setting">
            <input
              aria-label={messages.terminalPane.controls.copySelection}
              checked={copyOnSelect}
              onChange={(event) => setCopyOnSelect(event.target.checked)}
              type="checkbox"
            />
            <span className="copy-setting-label">
              {messages.terminalPane.controls.copySelection}
            </span>
          </label>
          <label className="copy-setting">
            <input
              aria-label={messages.terminalPane.controls.screenReaderMode}
              checked={screenReaderMode}
              onChange={(event) => setScreenReaderMode(event.target.checked)}
              type="checkbox"
            />
            <span className="copy-setting-label">
              {messages.terminalPane.controls.screenReaderMode}
            </span>
          </label>
        </div>
        <button
          aria-label={messages.terminalPane.controls.closeTools}
          className="terminal-tools-close"
          onClick={() => onToolsOpenChange(false)}
          type="button"
        >
          <X aria-hidden="true" size={13} />
        </button>
      </header>
      <div className="terminal-stage">
        <div className="terminal-host" ref={hostRef} />
        {(paneError || exit) && (
          <div className="terminal-exit" role={paneError ? 'alert' : 'status'}>
            <span>
              {paneError
                ? paneError.message
                : exit?.signal
                  ? messages.terminalPane.exit.withSignal(exit.signal)
                  : messages.terminalPane.exit.withCode(exit?.code)}
            </span>
            {(paneError?.recoverable || exit) && (
              <button onClick={() => void restart()} type="button">
                {messages.terminalPane.exit.restart}
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="terminal-statusbar">
        <span className="status-dot" aria-hidden="true" />
        <span>{status}</span>
        {identity?.processId && (
          <span className="terminal-process">
            {messages.terminalPane.processId(identity.processId)}
          </span>
        )}
        {linkTarget && (
          <span className="link-target">{messages.terminalPane.openLink(linkTarget)}</span>
        )}
      </footer>
    </section>
  )
}

function sanitizeTitle(value: string): string {
  const sanitized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && codePoint !== 127
    })
    .join('')
    .trim()
  return sanitized.slice(0, 160) || messages.terminalPane.defaultTitle
}

function processTitleFromCommand(command: readonly string[], fallback: string): string {
  const executable = command[0]?.split(/[\\/]/u).pop()
  return sanitizeTitle(executable || fallback)
}
