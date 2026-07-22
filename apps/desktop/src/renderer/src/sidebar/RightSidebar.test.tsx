// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '../../../shared/desktop-bridge'
import { RightSidebar, SafeMarkdown } from './RightSidebar'

const placement = {
  windowId: '00000000-0000-4000-8000-000000000001',
  revision: 3,
  side: 'right' as const,
  width: 360,
  enabled: [
    'textBox',
    'vault',
    'taskManager',
    'files',
    'markdown',
    'diff',
    'search',
    'recentlyClosed'
  ] as const,
  order: [
    'textBox',
    'vault',
    'taskManager',
    'files',
    'markdown',
    'diff',
    'search',
    'recentlyClosed'
  ] as const,
  selected: 'textBox' as const
}

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  type SaveSidebarPlacementParams = Parameters<
    NonNullable<DesktopBridge['saveSidebarPlacement']>
  >[0]
  return {
    getSidebarPlacement: vi.fn().mockResolvedValue(placement),
    saveSidebarPlacement: vi
      .fn()
      .mockImplementation(({ selected, width }: SaveSidebarPlacementParams) =>
        Promise.resolve({
          ...placement,
          selected,
          width,
          revision: placement.revision + 1
        })
      ),
    listTextBoxes: vi.fn().mockResolvedValue({ documents: [], nextCursor: null }),
    ...overrides
  } as unknown as DesktopBridge
}

describe('RightSidebar', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'desktopBridge', { configurable: true, value: bridge() })
  })
  afterEach(cleanup)

  it('is absent when the capability gate is off', () => {
    render(
      <RightSidebar enabled={false} paneId={placement.windowId} workspaceId={placement.windowId} />
    )
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('restores service placement and persists keyboard resizing', async () => {
    const saveSidebarPlacement = vi.fn().mockResolvedValue(placement)
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({ saveSidebarPlacement })
    })
    render(<RightSidebar enabled paneId={placement.windowId} workspaceId={placement.windowId} />)
    const separator = await screen.findByRole('separator', { name: 'Resize tools sidebar' })
    expect(screen.getByRole('complementary')).toHaveStyle({ width: '360px' })
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(saveSidebarPlacement).toHaveBeenCalledWith({
        selected: 'textBox',
        width: 372,
        expectedRevision: 3
      })
    )
  })

  it('preserves the saved width when the sidebar uses the narrow-window overlay', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
    render(<RightSidebar enabled paneId={placement.windowId} workspaceId={placement.windowId} />)

    const separator = await screen.findByRole('separator', { name: 'Resize tools sidebar' })
    expect(separator).toHaveAttribute('aria-valuenow', '360')
    expect(screen.getByRole('complementary')).toHaveStyle({ width: '360px' })

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  })

  it('moves between enabled surfaces with tablist keyboard navigation', async () => {
    const saveSidebarPlacement = vi.fn().mockResolvedValue(placement)
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({ saveSidebarPlacement })
    })
    render(<RightSidebar enabled paneId={placement.windowId} workspaceId={placement.windowId} />)
    const textBoxTab = await screen.findByRole('tab', { name: 'Text Box' })
    const vaultTab = screen.getByRole('tab', { name: 'Vault' })

    textBoxTab.focus()
    fireEvent.keyDown(textBoxTab, { key: 'ArrowRight' })

    expect(vaultTab).toHaveFocus()
    await waitFor(() =>
      expect(saveSidebarPlacement).toHaveBeenCalledWith({
        selected: 'vault',
        width: 360,
        expectedRevision: 3
      })
    )
  })

  it('shows a TextBox conflict without replacing the editor contents', async () => {
    const document = {
      textBoxDocumentId: placement.windowId,
      workspaceId: placement.windowId,
      windowId: placement.windowId,
      title: 'Draft',
      text: 'keep me',
      contentRevision: 2,
      createdAtMs: 1,
      updatedAtMs: 1
    }
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({
        listTextBoxes: vi.fn().mockResolvedValue({ documents: [document], nextCursor: null }),
        saveTextBox: vi.fn().mockRejectedValue(new Error('stale_revision'))
      })
    })
    render(<RightSidebar enabled paneId={placement.windowId} workspaceId={placement.windowId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }))
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'unsaved text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('status')).toHaveTextContent('stale_revision')
    expect(screen.getByLabelText('Text')).toHaveValue('unsaved text')
  })

  it('exports a Vault source without supplying a confirmation or path', async () => {
    const exportSearchSource = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({ exportSearchSource })
    })
    render(<RightSidebar enabled paneId={placement.windowId} workspaceId={placement.windowId} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Vault' }))
    fireEvent.change(await screen.findByLabelText('Authorized source ID'), {
      target: { value: placement.windowId }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() =>
      expect(exportSearchSource).toHaveBeenCalledWith({ sourceAuthorizationId: placement.windowId })
    )
    expect(screen.getByRole('status')).toHaveTextContent('Search data exported.')
  })
})

describe('SafeMarkdown', () => {
  it('renders service AST text as inert text without HTML injection', () => {
    const { container } = render(
      <SafeMarkdown node={{ kind: 'text', text: '<img src=x onerror=alert(1)>' }} />
    )
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(container.querySelector('img')).toBeNull()
  })
})
