import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MoreHorizontal,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Wrench
} from 'lucide-react'
import { useId, useState } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { browserSecurity, normalizeBrowserAddress } from './url-policy'
import { browserCommandParams, type BrowserBridge, type BrowserSessionState } from './types'
import {
  browserMessages,
  type BrowserMessages
} from '@agent-workspace/contracts/desktop/browser-messages'
import type { MutationResult } from '@agent-workspace/protocol-client'

export function BrowserToolbar({
  bridge,
  messages = browserMessages,
  onError,
  onMenuOpenChange,
  onMutation,
  state
}: {
  bridge: BrowserBridge
  messages?: BrowserMessages
  onError: (error: unknown) => void
  onMenuOpenChange?: (open: boolean) => void
  onMutation: (operation: Promise<MutationResult>) => Promise<boolean>
  state: BrowserSessionState
}): React.JSX.Element {
  const [draft, setDraft] = useState(state.url)
  const [editing, setEditing] = useState(false)
  const [validation, setValidation] = useState<{
    sourceUrl: string
    message: string
  } | null>(null)
  const errorId = useId()
  const address = editing ? draft : state.url
  const error = validation?.sourceUrl === state.url ? validation.message : null

  const navigate = (): void => {
    const normalized = normalizeBrowserAddress(address, messages)
    if (!normalized.valid) {
      setValidation({ sourceUrl: state.url, message: normalized.reason })
      return
    }
    setDraft(normalized.url)
    setEditing(false)
    setValidation(null)
    void onMutation(bridge.navigateBrowser({ ...browserCommandParams(state), url: normalized.url }))
  }
  const security = browserSecurity(state.url)
  const securityLabel = messages.toolbar.securityLabel(security)

  return (
    <div className="browser-toolbar" role="toolbar" aria-label={messages.toolbar.label}>
      <button
        aria-label={messages.toolbar.back}
        disabled={!state.canBack}
        onClick={() => void onMutation(bridge.browserBack(browserCommandParams(state)))}
        type="button"
      >
        <ArrowLeft size={15} />
      </button>
      <button
        aria-label={messages.toolbar.forward}
        disabled={!state.canForward}
        onClick={() => void onMutation(bridge.browserForward(browserCommandParams(state)))}
        type="button"
      >
        <ArrowRight size={15} />
      </button>
      <button
        aria-label={state.loading ? messages.toolbar.stopLoading : messages.toolbar.reload}
        onClick={() =>
          void onMutation(
            state.loading
              ? bridge.stopBrowser(browserCommandParams(state))
              : bridge.reloadBrowser(browserCommandParams(state))
          )
        }
        type="button"
      >
        {state.loading ? <Square size={12} /> : <RotateCw size={14} />}
      </button>
      <div className={`browser-address${error ? ' invalid' : ''}`}>
        <span aria-label={securityLabel} className={`browser-security ${security}`} role="img">
          {security === 'secure' ? (
            <ShieldCheck size={14} />
          ) : security === 'insecure' ? (
            <ShieldAlert size={14} />
          ) : (
            <Globe2 size={14} />
          )}
        </span>
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error)}
          aria-label={messages.toolbar.address}
          onBlur={() => setEditing(false)}
          onChange={(event) => {
            setDraft(event.currentTarget.value)
            setEditing(true)
            if (error) setValidation(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              navigate()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setDraft(state.url)
              setEditing(false)
              setValidation(null)
              event.currentTarget.select()
            }
          }}
          spellCheck={false}
          value={address}
        />
        {state.loading ? (
          <LoaderCircle
            aria-label={messages.toolbar.loading}
            className="browser-loading"
            role="status"
            size={14}
          />
        ) : null}
        {error ? (
          <span className="browser-address-error" id={errorId} role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <button
        aria-label={messages.toolbar.openExternally}
        className="browser-toolbar-secondary"
        data-browser-toolbar-action="open-external"
        onClick={() => void bridge.openExternal(state.url).catch(onError)}
        type="button"
      >
        <ExternalLink size={14} />
      </button>
      <button
        aria-label={
          state.devToolsOpen
            ? messages.toolbar.focusDeveloperTools
            : messages.toolbar.openDeveloperTools
        }
        aria-pressed={state.devToolsOpen}
        className="browser-toolbar-secondary"
        data-browser-toolbar-action="developer-tools"
        onClick={() => void onMutation(bridge.openBrowserDevTools(browserCommandParams(state)))}
        type="button"
      >
        <Wrench size={14} />
      </button>
      <DropdownMenu {...(onMenuOpenChange ? { onOpenChange: onMenuOpenChange } : {})}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={messages.toolbar.browserMenu}
            className="browser-menu-trigger"
            data-browser-toolbar-action="menu"
            type="button"
          >
            <MoreHorizontal size={15} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void bridge.openExternal(state.url).catch(onError)}>
            <ExternalLink size={14} /> {messages.toolbar.openExternally}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void onMutation(bridge.openBrowserDevTools(browserCommandParams(state)))
            }
          >
            <Wrench size={14} /> {messages.toolbar.developerTools}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
