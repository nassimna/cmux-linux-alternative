// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutationResult } from '@agent-workspace/protocol-client'

import { BrowserToolbar } from './BrowserToolbar'
import type { BrowserBridge, BrowserSessionState } from './types'
import {
  browserMessages,
  type BrowserMessages
} from '@agent-workspace/contracts/desktop/browser-messages'

afterEach(cleanup)

describe('BrowserToolbar', () => {
  it('exposes disabled navigation state and switches reload to stop while loading', () => {
    const bridge = createBridge()
    const owner = createOwner()
    const { rerender } = render(<BrowserToolbar bridge={bridge} {...owner} state={state()} />)

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Browser menu' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(bridge.reloadBrowser).toHaveBeenCalledWith(commandParams())

    rerender(<BrowserToolbar bridge={bridge} {...owner} state={state({ loading: true })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop loading' }))
    expect(bridge.stopBrowser).toHaveBeenCalledWith(commandParams())
  })

  it('normalizes an address on Enter and restores authoritative state on Escape', () => {
    const bridge = createBridge()
    render(<BrowserToolbar bridge={bridge} {...createOwner()} state={state()} />)
    const address = screen.getByRole('textbox', { name: 'Address' })

    fireEvent.change(address, { target: { value: 'docs.example.com/guide' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(bridge.navigateBrowser).toHaveBeenCalledWith({
      ...commandParams(),
      url: 'https://docs.example.com/guide'
    })

    fireEvent.change(address, { target: { value: 'unfinished' } })
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(address).toHaveValue('https://example.com/')
  })

  it('shows the observed URL after navigating back to the address that was edited', () => {
    const bridge = createBridge()
    const owner = createOwner()
    const { rerender } = render(<BrowserToolbar bridge={bridge} {...owner} state={state()} />)
    const address = screen.getByRole('textbox', { name: 'Address' })

    fireEvent.change(address, { target: { value: 'https://example.com/?node=3' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    rerender(
      <BrowserToolbar
        bridge={bridge}
        {...owner}
        state={state({ url: 'https://example.com/?node=3', stateRevision: 8 })}
      />
    )
    expect(address).toHaveValue('https://example.com/?node=3')

    rerender(<BrowserToolbar bridge={bridge} {...owner} state={state({ stateRevision: 9 })} />)
    expect(address).toHaveValue('https://example.com/')
  })

  it('shows inline validation and never navigates unsafe or credentialed URLs', () => {
    const bridge = createBridge()
    render(<BrowserToolbar bridge={bridge} {...createOwner()} state={state()} />)
    const address = screen.getByRole('textbox', { name: 'Address' })

    fireEvent.change(address, { target: { value: 'https://user:secret@example.com' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('credentials are not allowed')
    expect(address).toHaveAttribute('aria-invalid', 'true')
    expect(bridge.navigateBrowser).not.toHaveBeenCalled()
  })

  it('routes enabled navigation, external open, and developer tools through the bridge', () => {
    const bridge = createBridge()
    const owner = createOwner()
    render(
      <BrowserToolbar
        bridge={bridge}
        {...owner}
        state={state({ canBack: true, canForward: true, devToolsOpen: true })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    const external = screen.getByRole('button', { name: 'Open externally' })
    const developerTools = screen.getByRole('button', { name: 'Focus developer tools' })
    expect(external).toHaveClass('browser-toolbar-secondary')
    expect(developerTools).toHaveClass('browser-toolbar-secondary')
    expect(screen.getByRole('button', { name: 'Browser menu' })).toHaveClass('browser-menu-trigger')
    fireEvent.click(external)
    fireEvent.click(developerTools)

    expect(bridge.browserBack).toHaveBeenCalledWith(commandParams())
    expect(bridge.browserForward).toHaveBeenCalledWith(commandParams())
    expect(bridge.openExternal).toHaveBeenCalledWith('https://example.com/')
    expect(bridge.openBrowserDevTools).toHaveBeenCalledWith(commandParams())
  })

  it('uses a replaceable message catalog for accessible, validation, and menu copy', () => {
    const messages: BrowserMessages = {
      ...browserMessages,
      toolbar: {
        ...browserMessages.toolbar,
        label: 'Localized navigation',
        address: 'Localized address',
        browserMenu: 'Localized menu',
        openExternally: 'Localized external',
        developerTools: 'Localized tools',
        securityLabel: () => 'Localized security'
      },
      validation: () => 'Localized validation'
    }
    render(
      <BrowserToolbar
        bridge={createBridge()}
        messages={messages}
        {...createOwner()}
        state={state()}
      />
    )

    expect(screen.getByRole('toolbar', { name: 'Localized navigation' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Localized security' })).toBeVisible()
    const address = screen.getByRole('textbox', { name: 'Localized address' })
    fireEvent.change(address, { target: { value: '' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('Localized validation')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Localized menu' }), {
      button: 0,
      ctrlKey: false
    })
    expect(screen.getByRole('menuitem', { name: /Localized external/ })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /Localized tools/ })).toBeVisible()
  })

  it('applies successful browser mutations and contains backend rejections', async () => {
    const result = { kind: 'authoritative-browser-mutation' }
    const bridge = createBridge()
    vi.mocked(bridge.reloadBrowser).mockResolvedValueOnce(result as never)
    vi.mocked(bridge.stopBrowser).mockRejectedValueOnce(new Error('stale browser state'))
    const applied = vi.fn()
    const owner = createOwner(applied)
    const view = render(<BrowserToolbar bridge={bridge} {...owner} state={state()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(applied).toHaveBeenCalledWith(result))

    view.rerender(<BrowserToolbar bridge={bridge} {...owner} state={state({ loading: true })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop loading' }))
    await waitFor(() =>
      expect(owner.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'stale browser state' })
      )
    )
  })

  it('reports external-open failures through the shared error path', async () => {
    const bridge = createBridge()
    vi.mocked(bridge.openExternal).mockRejectedValueOnce(new Error('external open denied'))
    const owner = createOwner()
    render(<BrowserToolbar bridge={bridge} {...owner} state={state()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open externally' }))
    await waitFor(() =>
      expect(owner.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'external open denied' })
      )
    )
  })
})

function createOwner(applied = vi.fn()) {
  const onError = vi.fn()
  return {
    onError,
    onMutation: vi.fn(async (operation: Promise<MutationResult>) => {
      try {
        applied(await operation)
        return true
      } catch (error) {
        onError(error)
        return false
      }
    })
  }
}

function commandParams(): object {
  return {
    browserSessionId: 'browser-1',
    expectedStateRevision: 7,
    correlationId: expect.any(String)
  }
}

function state(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    browserSessionId: 'browser-1',
    url: 'https://example.com/',
    navigationTitle: 'Example',
    canBack: false,
    canForward: false,
    loading: false,
    devToolsOpen: false,
    profilePartition: 'persist:workspace-1',
    stateRevision: 7,
    correlationId: null,
    ...overrides
  }
}

function createBridge(): BrowserBridge {
  const method = () => vi.fn().mockResolvedValue(undefined)
  return {
    mountBrowserView: method(),
    unmountBrowserView: method(),
    setBrowserBounds: method(),
    focusBrowserView: method(),
    navigateBrowser: method(),
    browserBack: method(),
    browserForward: method(),
    reloadBrowser: method(),
    stopBrowser: method(),
    openBrowserDevTools: method(),
    openExternal: method()
  }
}
