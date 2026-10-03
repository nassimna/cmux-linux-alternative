// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'
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

  it('browses and previews authorized files in read-only mode without sidebar placement', async () => {
    const getSidebarPlacement = vi.fn()
    const listContentDirectory = vi.fn().mockResolvedValue({
      entries: [{ entryDescriptorId: 'file-1', kind: 'file', label: 'notes.txt', generation: 1 }],
      nextCursor: null
    })
    const issueContentDocument = vi.fn().mockResolvedValue({
      document: { documentId: 'document-1', identityVersion: 1 },
      displayName: 'notes.txt'
    })
    const readContent = vi.fn().mockResolvedValue({
      kind: 'text',
      chunk: { displayName: 'notes.txt', text: 'Hello from Files', eof: true }
    })
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({
        getSidebarPlacement,
        listContentRoots: vi.fn().mockResolvedValue({
          roots: [
            {
              rootId: 'root-1',
              directoryDescriptorId: 'directory-1',
              workspaceId: 'workspace-1',
              label: 'Project',
              generation: 1
            }
          ],
          nextCursor: null
        }),
        listContentDirectory,
        issueContentDocument,
        readContent
      })
    })
    const onClose = vi.fn()
    render(
      <RightSidebar
        enabled
        mode="files"
        onClose={onClose}
        paneId="pane-1"
        workspaceId="workspace-1"
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Project' }))
    fireEvent.click(await screen.findByRole('button', { name: 'notes.txt' }))

    expect(await screen.findByText('Hello from Files')).toBeVisible()
    expect(getSidebarPlacement).not.toHaveBeenCalled()
    expect(issueContentDocument).toHaveBeenCalledWith({
      authorizedDescriptorId: 'file-1',
      descriptorGeneration: 1,
      expectedKind: 'plainText'
    })
    expect(readContent).toHaveBeenCalledWith({
      document: { documentId: 'document-1', identityVersion: 1 },
      offset: 0,
      maxBytes: 65536
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close tools' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows opt-in Recently Closed in Files tools and preserves dirty-file navigation', async () => {
    const getSidebarPlacement = vi.fn()
    const listRecentlyClosed = vi.fn().mockResolvedValue({
      records: [
        {
          recentlyClosedId: '00000000-0000-4000-8000-000000000011',
          authorizedDescriptorId: '00000000-0000-4000-8000-000000000012',
          action: 'reopenTerminal',
          label: 'Previous shell',
          closedAtMs: 1,
          revision: 2
        }
      ],
      nextCursor: null
    })
    const reopenRecentlyClosed = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({
        getSidebarPlacement,
        listRecentlyClosed,
        reopenRecentlyClosed,
        listContentRoots: vi.fn().mockResolvedValue({
          roots: [
            {
              rootId: 'root-1',
              directoryDescriptorId: 'directory-1',
              workspaceId: 'workspace-1',
              label: 'Project',
              generation: 1
            }
          ],
          nextCursor: null
        }),
        listContentDirectory: vi.fn().mockResolvedValue({
          entries: [
            { entryDescriptorId: 'file-1', kind: 'file', label: 'notes.txt', generation: 1 }
          ],
          nextCursor: null
        }),
        issueContentDocument: vi.fn().mockResolvedValue({
          document: { documentId: 'document-1', identityVersion: 1 },
          displayName: 'notes.txt'
        }),
        readContent: vi.fn().mockResolvedValue({
          kind: 'text',
          chunk: {
            displayName: 'notes.txt',
            text: 'original',
            document: { documentId: 'document-1', identityVersion: 1 },
            contentRevision: 1,
            eof: true
          }
        })
      })
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
    const onFileDirtyChange = vi.fn()
    render(
      <RightSidebar
        enabled
        mode="files"
        onFileDirtyChange={onFileDirtyChange}
        paneId="pane-1"
        recentlyClosedEnabled
        workspaceId="workspace-1"
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Project' }))
    fireEvent.click(await screen.findByRole('button', { name: 'notes.txt' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes.txt' }), {
      target: { value: 'unsaved' }
    })
    await waitFor(() => expect(onFileDirtyChange).toHaveBeenLastCalledWith(true))
    const recentlyClosed = screen.getByRole('tab', { name: 'Recently Closed' })
    fireEvent.click(recentlyClosed)
    expect(confirm).toHaveBeenCalledWith('Discard unsaved file changes?')
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    expect(listRecentlyClosed).not.toHaveBeenCalled()

    fireEvent.click(recentlyClosed)
    expect(await screen.findByText('Previous shell')).toBeVisible()
    expect(getSidebarPlacement).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() =>
      expect(reopenRecentlyClosed).toHaveBeenCalledWith({
        record: {
          recentlyClosedId: '00000000-0000-4000-8000-000000000011',
          authorizedDescriptorId: '00000000-0000-4000-8000-000000000012',
          action: 'reopenTerminal',
          expectedRevision: 2
        },
        workspaceId: 'workspace-1',
        paneId: 'pane-1'
      })
    )
    recentlyClosed.focus()
    fireEvent.keyDown(recentlyClosed, { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveFocus()
    confirm.mockRestore()
  })

  it('does not offer Recently Closed in Files tools by default', () => {
    render(<RightSidebar enabled mode="files" paneId="pane-1" workspaceId="workspace-1" />)
    expect(screen.queryByRole('tab', { name: 'Recently Closed' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Task Manager' })).not.toBeInTheDocument()
  })

  it('shows Node tasks read-only when detach is unavailable', async () => {
    const listTasks = vi.fn().mockResolvedValue({
      tasks: [
        {
          target: { sessionId: placement.windowId, generation: 1, revision: 2 },
          kind: 'remoteSession',
          label: 'Remote shell',
          lifecycle: 'running',
          observation: 'lastVerified',
          ownerLabel: 'remote',
          resourceSummary: null
        }
      ],
      nextCursor: null
    })
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({
        listTasks,
        listContentRoots: vi.fn().mockResolvedValue({ roots: [], nextCursor: null })
      })
    })
    render(
      <RightSidebar
        enabled
        mode="files"
        nodeTaskListEnabled
        paneId="pane-1"
        workspaceId="workspace-1"
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Task Manager' }))
    expect(await screen.findByText('Remote shell')).toBeVisible()
    expect(screen.getByText('Review running tasks.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Detach' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Terminate' })).not.toBeInTheDocument()
    expect(screen.queryByText('More actions')).not.toBeInTheDocument()
    expect(listTasks).toHaveBeenCalledOnce()
  })

  it('offers only remote detach for actionable Node tasks', async () => {
    const remote = {
      target: { sessionId: placement.windowId, generation: 1, revision: 2 },
      kind: 'remoteSession' as const,
      label: 'Remote shell',
      lifecycle: 'running' as const,
      observation: 'lastVerified' as const,
      ownerLabel: 'remote',
      resourceSummary: null
    }
    const agent = {
      ...remote,
      target: { sessionId: '00000000-0000-4000-8000-000000000002', generation: 1, revision: 1 },
      kind: 'agent' as const,
      label: 'Agent task'
    }
    const listTasks = vi.fn().mockResolvedValue({ tasks: [remote, agent], nextCursor: null })
    const actOnTask = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({
        listTasks,
        actOnTask,
        listContentRoots: vi.fn().mockResolvedValue({ roots: [], nextCursor: null })
      })
    })
    render(
      <RightSidebar
        enabled
        mode="files"
        nodeTaskListEnabled
        nodeTaskDetachEnabled
        paneId="pane-1"
        workspaceId="workspace-1"
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Task Manager' }))
    expect(await screen.findByText('Remote shell')).toBeVisible()
    expect(screen.getByText('Agent task')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Detach' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Terminate' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Detach' }))
    await waitFor(() =>
      expect(actOnTask).toHaveBeenCalledWith({ action: 'detach', target: remote.target })
    )
  })

  it('pages the Node task list and clears stale rows when refresh fails', async () => {
    const first = {
      target: { sessionId: placement.windowId, generation: 1, revision: 2 },
      kind: 'remoteSession' as const,
      label: 'First remote',
      lifecycle: 'detached' as const,
      observation: 'lastVerified' as const,
      ownerLabel: 'remote',
      resourceSummary: null
    }
    const second = {
      ...first,
      target: { sessionId: '00000000-0000-4000-8000-000000000002', generation: 1, revision: 2 },
      label: 'Second remote'
    }
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [first], nextCursor: first.target.sessionId })
      .mockResolvedValueOnce({ tasks: [second], nextCursor: null })
      .mockRejectedValueOnce(new Error('The Node task list is unavailable'))
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({
        listTasks,
        listContentRoots: vi.fn().mockResolvedValue({ roots: [], nextCursor: null })
      })
    })
    render(
      <RightSidebar
        enabled
        mode="files"
        nodeTaskListEnabled
        nodeTaskDetachEnabled
        paneId="pane-1"
        workspaceId="workspace-1"
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Task Manager' }))
    expect(await screen.findByText('First remote')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Detach' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more tasks' }))
    expect(await screen.findByText('Second remote')).toBeVisible()
    expect(listTasks).toHaveBeenNthCalledWith(2, {
      limit: 100,
      cancellationId: expect.any(String),
      cursor: first.target.sessionId
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }))
    expect(await screen.findByRole('status')).toHaveTextContent('The Node task list is unavailable')
    expect(screen.queryByText('First remote')).not.toBeInTheDocument()
    expect(screen.queryByText('Second remote')).not.toBeInTheDocument()
  })

  it('refreshes Recently Closed on demand and after a stale reopen', async () => {
    const record = {
      recentlyClosedId: '00000000-0000-4000-8000-000000000011',
      authorizedDescriptorId: '00000000-0000-4000-8000-000000000012',
      action: 'reopenTerminal' as const,
      label: 'Previous shell',
      closedAtMs: 1,
      revision: 1
    }
    const listRecentlyClosed = vi
      .fn()
      .mockResolvedValueOnce({ records: [record], nextCursor: null })
      .mockResolvedValueOnce({
        records: [{ ...record, label: 'Updated shell', revision: 2 }],
        nextCursor: null
      })
      .mockResolvedValue({
        records: [{ ...record, label: 'Newest shell', revision: 3 }],
        nextCursor: null
      })
    const reopenRecentlyClosed = vi
      .fn()
      .mockRejectedValue(
        new Error('[agent-workspace-protocol-error:stale_revision] Record changed')
      )
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({ listRecentlyClosed, reopenRecentlyClosed })
    })
    render(
      <RightSidebar
        enabled
        mode="files"
        paneId="pane-1"
        recentlyClosedEnabled
        workspaceId="workspace-1"
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Recently Closed' }))
    expect(await screen.findByText('Previous shell')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh recently closed' }))
    expect(await screen.findByText('Updated shell')).toBeVisible()
    expect(listRecentlyClosed).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() =>
      expect(reopenRecentlyClosed).toHaveBeenCalledWith(
        expect.objectContaining({
          record: expect.objectContaining({ expectedRevision: 2 })
        })
      )
    )
    await waitFor(() => expect(listRecentlyClosed).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('Newest shell')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Recently closed changed. Choose an item again.'
    )
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

  it('explains the selected tool and supports vertical arrow navigation', async () => {
    render(<RightSidebar enabled paneId={placement.windowId} workspaceId={placement.windowId} />)
    const textBoxTab = await screen.findByRole('tab', { name: 'Text Box' })

    expect(screen.getByRole('heading', { name: 'Text Box' })).toBeVisible()
    expect(screen.getByText('Keep lightweight notes connected to this workspace.')).toBeVisible()

    textBoxTab.focus()
    fireEvent.keyDown(textBoxTab, { key: 'ArrowDown' })

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Vault' })).toHaveFocus())
  })

  it('presents task state clearly and keeps force termination behind more actions', async () => {
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: bridge({
        listTasks: vi.fn().mockResolvedValue({
          tasks: [
            {
              target: { sessionId: placement.windowId, generation: 1, revision: 2 },
              kind: 'agent',
              label: 'Implement sidebar UX',
              lifecycle: 'running',
              observation: 'lastVerified',
              ownerLabel: 'local',
              resourceSummary: null
            }
          ],
          nextCursor: null
        })
      })
    })
    render(<RightSidebar enabled paneId={placement.windowId} workspaceId={placement.windowId} />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Task Manager' }))

    expect(await screen.findByText('1 active task')).toBeVisible()
    expect(screen.getByText('Implement sidebar UX')).toBeVisible()
    expect(screen.getByText('running', { selector: '.task-state' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Terminate' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Force terminate' })).not.toBeVisible()

    fireEvent.click(screen.getByText('More actions'))
    expect(screen.getByRole('button', { name: 'Force terminate' })).toBeVisible()
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
