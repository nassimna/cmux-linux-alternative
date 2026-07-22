// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/unbound-method */

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ApplicationSnapshot,
  ConfigurationSnapshot,
  MutationResult,
  NotificationSnapshot,
  SettingsGetResult,
  WorkspaceCardSlotV2GetParams,
  WorkspaceCardSlotV2Snapshot
} from '@agent-workspace/protocol-client'

import type { DesktopBridge, DesktopLifecycleState } from '../../shared/desktop-bridge'

import projection from '../../../../../crates/protocol/fixtures/milestone2-projection.json'
import settings from '../../../../../crates/protocol/fixtures/milestone2-settings.json'
import { App } from './App'
import { resetConfigurationStoreForTests } from './configuration-store'
import { messages } from './messages'
import { resetProjectionStoreForTests } from './workspace/projection-store'
import {
  duplicateWorkspaceName,
  duplicateWorkspaceParams,
  normalizeWorkspaceColor,
  workspaceDirectoryBasename,
  workspaceDirectoryDisplayPath
} from './workspace/WorkspaceShell'

vi.mock('./terminal/TerminalPane', () => ({
  TerminalPane: ({
    onMutation,
    onProcessTitleChange,
    tabId,
    workspaceId
  }: {
    onMutation: (operation: Promise<MutationResult>) => Promise<boolean>
    onProcessTitleChange: (title: string) => void
    tabId: string
    workspaceId: string
  }) => (
    <button
      onClick={() => {
        onProcessTitleChange('bash')
        void onMutation(window.desktopBridge.restartTerminal({ workspaceId, tabId }))
      }}
      type="button"
    >
      Terminal ready
    </button>
  )
}))

vi.mock('./browser/BrowserHost', () => ({
  BrowserHost: ({ browserSessionId, visible }: { browserSessionId: string; visible: boolean }) => (
    <div data-browser-session-id={browserSessionId} data-visible={String(visible)}>
      Browser content ready
    </div>
  )
}))

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div role="separator" />
}))

const projectionFixture = projection as ApplicationSnapshot
const settingsFixture = settings as SettingsGetResult

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetConfigurationStoreForTests()
  resetProjectionStoreForTests()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('loads the authoritative workspace projection through the preload bridge', async () => {
    window.desktopBridge = createBridge()
    render(<App />)

    expect(await screen.findByText('Browser content ready')).toBeInTheDocument()
    expect(screen.getByText('protocol 1 · 0.1.0')).toBeInTheDocument()
    expect(screen.getAllByText('Fixture workspace').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Working directory /tmp/fixture-workspace')).toHaveTextContent(
      'fixture-workspace'
    )
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveAttribute('data-density', 'comfortable')
    expect(window.desktopBridge.getConfiguration).toHaveBeenCalledOnce()
  })

  it('reinitializes renderer projections when the main desktop binding is replaced', async () => {
    const bridge = createBridge()
    let rebind: (() => void) | undefined
    const onDesktopBindingRebind: NonNullable<DesktopBridge['onDesktopBindingRebind']> = (
      listener
    ) => {
      rebind = listener
      return () => undefined
    }
    bridge.onDesktopBindingRebind = vi.fn(onDesktopBindingRebind)
    window.desktopBridge = bridge
    render(<App />)

    await screen.findByText('Browser content ready')
    if (!bridge.getConfiguration) throw new Error('Configuration bridge is unavailable')
    const getConfiguration = vi.mocked(bridge.getConfiguration)
    const identityReadsBeforeRebind = vi.mocked(bridge.identify).mock.calls.length
    const workspaceReadsBeforeRebind = vi.mocked(bridge.listWorkspaces).mock.calls.length
    const configurationReadsBeforeRebind = getConfiguration.mock.calls.length
    rebind?.()

    await waitFor(() =>
      expect(vi.mocked(bridge.identify).mock.calls.length).toBeGreaterThan(
        identityReadsBeforeRebind
      )
    )
    expect(vi.mocked(bridge.listWorkspaces).mock.calls.length).toBeGreaterThan(
      workspaceReadsBeforeRebind
    )
    expect(getConfiguration.mock.calls.length).toBeGreaterThan(configurationReadsBeforeRebind)
  })

  it.each([
    ['/home/alex/project', 'project'],
    ['/home/alex/project/', 'project'],
    ['/', '/'],
    ['C:\\Users\\Alex\\project', 'project'],
    ['C:\\', 'C:\\'],
    ['C:/', 'C:/'],
    ['\\\\server\\share\\project\\', 'project']
  ])('renders the cross-platform directory basename for %s', (workingDirectory, expected) => {
    expect(workspaceDirectoryBasename(workingDirectory)).toBe(expected)
  })

  it.each([
    ['/home/alex/project', '~/project'],
    ['C:\\Users\\Alex\\project', '~\\project'],
    ['/opt/project', '/opt/project']
  ])('renders a compact workspace path for %s', (workingDirectory, expected) => {
    expect(workspaceDirectoryDisplayPath(workingDirectory)).toBe(expected)
  })

  it('opens workspace actions on right click and duplicates metadata without replaying commands', async () => {
    const bridge = createBridge()
    window.desktopBridge = bridge
    render(<App />)

    const row = (await screen.findByText('Fixture workspace', { selector: 'strong' })).closest(
      '.workspace-row'
    )
    expect(row).not.toBeNull()
    fireEvent.contextMenu(row as HTMLElement)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate workspace' }))

    await waitFor(() =>
      expect(bridge.createWorkspace).toHaveBeenCalledWith({
        name: 'Fixture workspace copy',
        description: 'Shared Rust and TypeScript projection fixture',
        workingDirectory: '/tmp/fixture-workspace',
        initialTerminal: {
          cwd: '/tmp/fixture-workspace',
          rows: 30,
          cols: 120
        }
      })
    )
  })

  it.each(['compact', 'comfortable', 'expanded'] as const)(
    'keeps card semantics and keyboard-reachable action order stable at %s density',
    async (density) => {
      const bridge = createBridge()
      bridge.getConfiguration = vi.fn().mockResolvedValue({
        config: {
          ...configurationFixture,
          appearance: { ...configurationFixture.appearance, density }
        }
      })
      window.desktopBridge = bridge
      render(<App />)

      const selection = (
        await screen.findByText('Fixture workspace', { selector: 'strong' })
      ).closest('.workspace-row') as HTMLButtonElement
      const card = selection.closest('.workspace-card') as HTMLDivElement
      expect(document.documentElement).toHaveAttribute('data-density', density)
      expect(
        [...card.querySelector('.workspace-copy')!.children].map((element) => element.className)
      ).toEqual(['workspace-directory', 'workspace-runtime-metadata'])
      expect(
        [...card.closest('.workspace-row-wrap')!.querySelectorAll('button')].map((button) =>
          button.getAttribute('data-workspace-action')
        )
      ).toEqual(['workspace.card.select', 'workspace.card.reorder', 'workspace.card.close'])

      selection.focus()
      fireEvent.keyDown(selection, {
        code: 'F10',
        key: 'F10',
        shiftKey: true
      })
      const rename = await screen.findByRole('menuitem', { name: 'Rename workspace…' })
      expect(rename).toBeVisible()
      expect(rename).toHaveAttribute('data-workspace-action', 'workspace.card.rename')
      expect(
        screen
          .getAllByRole('menuitem')
          .map((item) => [item.textContent, item.getAttribute('data-workspace-action')])
      ).toEqual([
        ['Rename workspace…', 'workspace.card.rename'],
        ['Workspace color', 'workspace.card.color'],
        ['Duplicate workspace', 'workspace.card.duplicate'],
        ['Move up', 'workspace.card.move.up'],
        ['Move down', 'workspace.card.move.down'],
        ['Close workspace', 'workspace.card.close']
      ])
      const color = screen.getByRole('menuitem', { name: 'Workspace color' })
      color.focus()
      fireEvent.keyDown(color, { key: 'ArrowRight' })
      expect(await screen.findByRole('menuitem', { name: 'Blue' })).toHaveAttribute(
        'data-workspace-action',
        'workspace.card.color.set'
      )
      expect(screen.getByRole('menuitem', { name: 'Choose custom color…' })).toHaveAttribute(
        'data-workspace-action',
        'workspace.card.color.custom'
      )
      expect(screen.getByRole('menuitem', { name: 'Clear color' })).toHaveAttribute(
        'data-workspace-action',
        'workspace.card.color.clear'
      )
    }
  )

  it('selects an unselected workspace from its non-interactive card details', async () => {
    const snapshot = projectionWithSecondWorkspace()
    const bridge = createBridge(undefined, snapshot)
    const secondWorkspace = snapshot.workspaces[1]!
    vi.mocked(bridge.selectWorkspace).mockResolvedValueOnce(
      mutationAt(43, snapshot, secondWorkspace.id)
    )
    window.desktopBridge = bridge
    render(<App />)

    const card = (await screen.findByText('Second workspace', { selector: 'strong' })).closest(
      '.workspace-card'
    )
    const details = card?.querySelector('.workspace-directory')
    expect(details).not.toBeNull()
    fireEvent.click(details as HTMLElement)

    await waitFor(() =>
      expect(bridge.selectWorkspace).toHaveBeenCalledWith({ workspaceId: secondWorkspace.id })
    )
  })

  it('composes rich card details outside the workspace selection button in stable focus order', async () => {
    const bridge = createBridge()
    bridge.identify = vi.fn().mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: ['configuration-v2', 'card-slots-v2']
    })
    bridge.getWorkspaceCardSlotV2 = vi.fn(
      ({ workspaceId, kind }: WorkspaceCardSlotV2GetParams): Promise<WorkspaceCardSlotV2Snapshot> =>
        Promise.resolve({
          workspaceId,
          kind,
          slotRevision: 1,
          payload:
            kind === 'pullRequest'
              ? {
                  kind: 'pullRequest',
                  value: {
                    provider: 'GitHub',
                    number: 42,
                    title: 'Accessible details',
                    lifecycle: 'open',
                    checks: 'passing',
                    url: 'https://example.test/pr/42'
                  }
                }
              : null
        })
    )
    window.desktopBridge = bridge
    render(<App />)

    const selection = (
      await screen.findByText('Fixture workspace', { selector: 'strong' })
    ).closest('.workspace-row') as HTMLButtonElement
    const card = selection.closest('.workspace-card')
    const wrapper = selection.closest('.workspace-row-wrap')
    const link = await screen.findByRole('link', { name: /Accessible details/u })
    expect(card?.tagName).toBe('DIV')
    expect(selection.querySelector('a, button, input, select, textarea')).toBeNull()
    expect(link.closest('button')).toBeNull()
    expect(card).toContainElement(link)
    expect(
      [...wrapper!.querySelectorAll<HTMLElement>('button, a[href]')].map((element) =>
        element.matches('a') ? 'workspace.card.details' : element.dataset.workspaceAction
      )
    ).toEqual([
      'workspace.card.select',
      'workspace.card.details',
      'workspace.card.reorder',
      'workspace.card.close'
    ])
  })

  it('opens a native folder immediately and keeps manual path entry available', async () => {
    const bridge = createBridge()
    vi.mocked(bridge.pickWorkspaceDirectory!).mockResolvedValueOnce('/home/alex/native-project')
    window.desktopBridge = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder as workspace' }))
    fireEvent.click(
      await screen.findByRole('button', {
        name: messages.workspaceShell.createWorkspace.chooseFolder
      })
    )
    await waitFor(() =>
      expect(bridge.createWorkspace).toHaveBeenCalledWith({
        name: 'native-project',
        workingDirectory: '/home/alex/native-project',
        initialTerminal: { cwd: '/home/alex/native-project', rows: 30, cols: 120 }
      })
    )
    expect(
      screen.queryByRole('dialog', { name: 'Open a folder as a workspace' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open folder as workspace' }))
    const manualPath = await screen.findByRole('textbox', { name: 'Workspace folder path' })
    fireEvent.change(manualPath, { target: { value: '/home/alex/manual-project' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    await waitFor(() =>
      expect(bridge.createWorkspace).toHaveBeenLastCalledWith({
        name: 'manual-project',
        workingDirectory: '/home/alex/manual-project',
        initialTerminal: { cwd: '/home/alex/manual-project', rows: 30, cols: 120 }
      })
    )
  })

  it('resizes the sidebar from the keyboard and persists the chosen width', async () => {
    window.desktopBridge = createBridge()
    render(<App />)

    const separator = await screen.findByRole('separator', { name: 'Resize workspace sidebar' })
    fireEvent.keyDown(separator, { key: 'ArrowRight' })

    expect(document.querySelector('.workspace-shell')).toHaveStyle('--sidebar-width: 304px')
    expect(localStorage.getItem('agent-workspace.sidebar.width')).toBe('304')
  })

  it('keeps terminal tools out of the canvas until explicitly opened', async () => {
    window.desktopBridge = createBridge()
    render(<App />)

    const openTools = await screen.findByRole('button', { name: 'Open terminal tools' })
    expect(openTools).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(openTools)

    const closeTools = screen.getByRole('button', { name: 'Close terminal tools' })
    expect(closeTools).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(closeTools)
    expect(screen.getByRole('button', { name: 'Open terminal tools' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('uses a fresh authoritative topology for advanced Ctrl+W close', async () => {
    const workspace = projectionFixture.workspaces[0]!
    const pane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)!
    const bridge = createBridge(
      vi.fn().mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['configuration-v2', 'multi-window-v1']
      })
    )
    bridge.listWindows = vi.fn().mockResolvedValue({
      revision: 12,
      idempotencyEpoch: 2,
      focusedWindowId: '70000000-0000-4000-8000-000000000001',
      windows: [
        {
          windowId: '70000000-0000-4000-8000-000000000001',
          label: 'Main',
          workspaceIds: [workspace.id],
          focusedWorkspaceId: workspace.id,
          hostingState: 'ready',
          revision: 7
        }
      ]
    })
    bridge.closeTabAdvanced = vi.fn().mockResolvedValue({
      revision: 13,
      placement: null,
      closedItemId: '80000000-0000-4000-8000-000000000001'
    })
    bridge.getSettings = vi.fn().mockResolvedValue({
      ...settingsFixture,
      shortcuts: settingsFixture.shortcuts.map((shortcut) =>
        shortcut.commandId === 'tab.close'
          ? {
              ...shortcut,
              overrideState: { kind: 'default' as const },
              effectiveShortcut: 'Primary+W'
            }
          : shortcut
      )
    })
    window.desktopBridge = bridge
    render(<App />)
    await screen.findAllByRole('tab', { selected: true })
    await waitFor(() => expect(bridge.getSettings).toHaveBeenCalledOnce())
    await waitFor(() => expect(bridge.listWindows).toHaveBeenCalled())
    vi.mocked(bridge.listWindows).mockResolvedValue({
      revision: 18,
      idempotencyEpoch: 'epoch-3',
      focusedWindowId: '70000000-0000-4000-8000-000000000001',
      windows: [
        {
          windowId: '70000000-0000-4000-8000-000000000001',
          label: 'Main',
          workspaceIds: [workspace.id],
          focusedWorkspaceId: workspace.id,
          hostingState: 'hosted',
          defaultTabDestination: {
            workspaceId: workspace.id,
            paneId: pane.id,
            destinationIndex: pane.tabIds.length
          },
          revision: 11
        }
      ]
    })

    const topologyReadsBeforeClose = vi.mocked(bridge.listWindows).mock.calls.length
    fireEvent.keyDown(document, { key: 'w', ctrlKey: true })

    if (!bridge.closeTabAdvanced) throw new Error('Advanced close bridge is unavailable')
    const closeTabAdvanced = vi.mocked(bridge.closeTabAdvanced)
    await waitFor(() => expect(closeTabAdvanced).toHaveBeenCalledOnce())
    expect(closeTabAdvanced.mock.calls[0]?.[0]).toMatchObject({
      mutation: { expectedRevision: 18, idempotencyEpoch: 'epoch-3' },
      source: {
        windowId: '70000000-0000-4000-8000-000000000001',
        workspaceId: workspace.id,
        paneId: pane.id,
        tabId: pane.selectedTabId,
        expectedWindowRevision: 11
      }
    })
    expect(vi.mocked(bridge.listWindows).mock.calls.length).toBeGreaterThan(
      topologyReadsBeforeClose
    )
    expect(bridge.closeTab).not.toHaveBeenCalled()
  })

  it('announces a failed menu command, refreshes, and preserves focus', async () => {
    const workspace = projectionFixture.workspaces[0]!
    const bridge = createBridge(
      vi.fn().mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['configuration-v2', 'multi-window-v1']
      })
    )
    bridge.listWindows = vi.fn().mockResolvedValue({
      revision: 12,
      idempotencyEpoch: 2,
      focusedWindowId: '70000000-0000-4000-8000-000000000001',
      windows: [
        {
          windowId: '70000000-0000-4000-8000-000000000001',
          label: 'Main',
          workspaceIds: [workspace.id],
          focusedWorkspaceId: workspace.id,
          hostingState: 'ready',
          revision: 7
        }
      ]
    })
    bridge.closeTabAdvanced = vi.fn().mockRejectedValue(new Error('topology changed'))
    let invokeMenuCommand: ((commandId: 'tab.close') => void) | undefined
    bridge.onApplicationMenuCommand = vi.fn((listener) => {
      invokeMenuCommand = listener as (commandId: 'tab.close') => void
      return () => undefined
    })
    window.desktopBridge = bridge
    render(<App />)
    const selectedTab = (await screen.findAllByRole('tab', { selected: true }))[0]!
    selectedTab.focus()
    await waitFor(() => expect(bridge.listWindows).toHaveBeenCalled())
    vi.mocked(bridge.listWindows).mockClear()

    invokeMenuCommand?.('tab.close')

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some((alert) => /topology changed/u.test(alert.textContent ?? ''))
      ).toBe(true)
    )
    await waitFor(() => expect(selectedTab).toHaveFocus())
    expect(bridge.listWindows).toHaveBeenCalled()
    expect(bridge.listWorkspaces).toHaveBeenCalledTimes(2)
  })

  it('routes an async move-dialog failure through the alert, refresh, and focus path', async () => {
    const workspace = projectionFixture.workspaces[0]!
    const pane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)!
    const sourceWindowId = '70000000-0000-4000-8000-000000000001'
    const targetWindowId = '70000000-0000-4000-8000-000000000002'
    const bridge = createBridge(
      vi.fn().mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['configuration-v2', 'multi-window-v1']
      })
    )
    bridge.listWindows = vi.fn().mockResolvedValue({
      revision: 12,
      idempotencyEpoch: 2,
      focusedWindowId: sourceWindowId,
      windows: [
        {
          windowId: sourceWindowId,
          label: 'Main',
          workspaceIds: [workspace.id],
          focusedWorkspaceId: workspace.id,
          hostingState: 'hosted',
          defaultTabDestination: {
            workspaceId: workspace.id,
            paneId: pane.id,
            destinationIndex: 0
          },
          revision: 7
        },
        {
          windowId: targetWindowId,
          label: 'Second',
          workspaceIds: [workspace.id],
          focusedWorkspaceId: workspace.id,
          hostingState: 'hosted',
          defaultTabDestination: {
            workspaceId: workspace.id,
            paneId: pane.id,
            destinationIndex: 0
          },
          revision: 8
        }
      ]
    })
    bridge.moveTabExact = vi.fn().mockRejectedValue(new Error('target generation changed'))
    window.desktopBridge = bridge
    render(<App />)
    const selectedTab = (await screen.findAllByRole('tab', { selected: true }))[0]!
    selectedTab.focus()
    await waitFor(() => expect(bridge.listWindows).toHaveBeenCalled())
    vi.mocked(bridge.listWindows).mockClear()

    fireEvent.keyDown(document, { key: 'm', ctrlKey: true, shiftKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Move tab to window' })
    vi.mocked(bridge.listWindows).mockResolvedValueOnce({
      revision: 15,
      idempotencyEpoch: 'epoch-4',
      focusedWindowId: sourceWindowId,
      windows: [
        {
          windowId: sourceWindowId,
          label: 'Main',
          workspaceIds: [workspace.id],
          focusedWorkspaceId: workspace.id,
          hostingState: 'hosted',
          defaultTabDestination: {
            workspaceId: workspace.id,
            paneId: pane.id,
            destinationIndex: 0
          },
          revision: 10
        },
        {
          windowId: targetWindowId,
          label: 'Second',
          workspaceIds: [workspace.id],
          focusedWorkspaceId: workspace.id,
          hostingState: 'hosted',
          defaultTabDestination: {
            workspaceId: workspace.id,
            paneId: pane.id,
            destinationIndex: 1
          },
          revision: 11
        }
      ]
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move tab' }))

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some((alert) => /target generation changed/u.test(alert.textContent ?? ''))
      ).toBe(true)
    )
    expect(screen.queryByRole('dialog', { name: 'Move tab to window' })).not.toBeInTheDocument()
    await waitFor(() => expect(selectedTab).toHaveFocus())
    if (!bridge.moveTabExact) throw new Error('Exact tab move bridge is unavailable')
    expect(vi.mocked(bridge.moveTabExact).mock.calls[0]?.[0]).toMatchObject({
      mutation: { expectedRevision: 15, idempotencyEpoch: 'epoch-4' },
      source: { expectedWindowRevision: 10 },
      target: {
        windowId: targetWindowId,
        destinationIndex: 1,
        expectedWindowRevision: 11
      }
    })
    expect(bridge.listWindows).toHaveBeenCalled()
    expect(bridge.listWorkspaces).toHaveBeenCalledTimes(2)
  })

  it('consumes focus-history target without issuing a duplicate native focus command', async () => {
    const workspace = projectionFixture.workspaces[0]!
    const sourceWindowId = '70000000-0000-4000-8000-000000000001'
    const targetWindowId = '70000000-0000-4000-8000-000000000002'
    const bridge = createBridge(
      vi.fn().mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['configuration-v2', 'multi-window-v1']
      })
    )
    bridge.listWindows = vi.fn().mockResolvedValue({
      revision: 12,
      idempotencyEpoch: 2,
      focusedWindowId: targetWindowId,
      windows: [
        {
          windowId: sourceWindowId,
          label: 'Main',
          workspaceIds: [workspace.id],
          focusedWorkspaceId: workspace.id,
          hostingState: 'hosted',
          revision: 7
        },
        {
          windowId: targetWindowId,
          label: 'Second',
          workspaceIds: [],
          focusedWorkspaceId: null,
          hostingState: 'hosted',
          revision: 8
        }
      ]
    })
    bridge.navigateFocusHistory = vi.fn().mockResolvedValue({
      revision: 13,
      idempotencyEpoch: 2,
      target: {
        windowId: targetWindowId,
        workspaceId: workspace.id,
        paneId: workspace.selectedPaneId,
        tabId: workspace.panes[0]!.selectedTabId
      },
      replayed: false
    })
    bridge.focusWindow = vi.fn()
    window.desktopBridge = bridge
    render(<App />)
    await screen.findAllByRole('tab', { selected: true })
    await waitFor(() => expect(bridge.listWindows).toHaveBeenCalled())
    vi.mocked(bridge.listWindows).mockClear()

    fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })

    await waitFor(() => expect(bridge.navigateFocusHistory).toHaveBeenCalledOnce())
    expect(bridge.focusWindow).not.toHaveBeenCalled()
    expect(bridge.listWindows).toHaveBeenCalled()
    expect(bridge.listWorkspaces).toHaveBeenCalledTimes(2)
  })

  it('routes workspace context rename, move, and close actions through existing mutations', async () => {
    const snapshot = projectionWithSecondWorkspace()
    const bridge = createBridge(undefined, snapshot)
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('Renamed workspace'))
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    window.desktopBridge = bridge
    render(<App />)

    const firstRow = (await screen.findByText('Fixture workspace', { selector: 'strong' })).closest(
      '.workspace-row'
    ) as HTMLButtonElement
    fireEvent.contextMenu(firstRow)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename workspace…' }))
    await waitFor(() =>
      expect(bridge.updateWorkspace).toHaveBeenCalledWith({
        workspaceId: snapshot.workspaces[0]!.id,
        name: 'Renamed workspace'
      })
    )

    fireEvent.contextMenu(firstRow)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }))
    await waitFor(() =>
      expect(bridge.moveWorkspace).toHaveBeenCalledWith({
        workspaceId: snapshot.workspaces[0]!.id,
        destinationIndex: 1
      })
    )

    fireEvent.contextMenu(firstRow)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close workspace' }))
    await waitFor(() =>
      expect(bridge.closeWorkspace).toHaveBeenCalledWith({
        workspaceId: snapshot.workspaces[0]!.id
      })
    )
  })

  it('applies a workspace palette color through the context submenu', async () => {
    const bridge = createBridge()
    window.desktopBridge = bridge
    render(<App />)

    const row = (await screen.findByText('Fixture workspace', { selector: 'strong' })).closest(
      '.workspace-row'
    ) as HTMLButtonElement
    fireEvent.contextMenu(row)
    const color = await screen.findByRole('menuitem', { name: 'Workspace color' })
    color.focus()
    fireEvent.keyDown(color, { key: 'ArrowRight' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Blue' }))

    await waitFor(() =>
      expect(bridge.updateWorkspace).toHaveBeenCalledWith({
        workspaceId: projectionFixture.workspaces[0]!.id,
        color: { value: '#5B8DEF' }
      })
    )
  })

  it('bounds duplicate names and permits only canonical hex workspace colors', () => {
    expect([...duplicateWorkspaceName('x'.repeat(128))]).toHaveLength(128)
    expect(duplicateWorkspaceName('x'.repeat(128))).toMatch(/ copy$/u)
    expect(normalizeWorkspaceColor(' #a0B1c2 ')).toBe('#A0B1C2')
    expect(normalizeWorkspaceColor('url(https://example.com/tracker)')).toBeNull()

    const workspace = projectionFixture.workspaces[0]!
    expect(
      duplicateWorkspaceParams({
        ...workspace,
        description: 'Copied description',
        color: '#a0b1c2'
      })
    ).toMatchObject({
      description: 'Copied description',
      color: '#A0B1C2'
    })
    expect(
      duplicateWorkspaceParams({ ...workspace, color: 'url(https://invalid)' })
    ).not.toHaveProperty('color')
  })

  it('keeps selected browsers visible in every split and localizes their default tab title', async () => {
    const snapshot = projectionWithTwoSelectedBrowsers()
    window.desktopBridge = createBridge(undefined, snapshot)
    render(<App />)

    const hosts = await screen.findAllByText('Browser content ready')
    expect(hosts).toHaveLength(2)
    expect(hosts.every((host) => host.dataset.visible === 'true')).toBe(true)
    const browserTabs = screen.getAllByRole('tab', { name: 'Browser' })
    expect(browserTabs).toHaveLength(2)
    expect(browserTabs.every((tab) => tab.querySelector('[data-tab-kind-icon="browser"]'))).toBe(
      true
    )
    expect(browserTabs.every((tab) => !tab.querySelector('.tab-drag'))).toBe(true)
    expect(
      screen.queryByRole('tab', { name: 'Backend-owned English title' })
    ).not.toBeInTheDocument()
  })

  it('shows an actionable connection failure', async () => {
    window.desktopBridge = createBridge(vi.fn().mockRejectedValue(new Error('connection refused')))
    render(<App />)

    expect(
      await screen.findByText(messages.workspaceProjection.errors.initializationFailed)
    ).toBeInTheDocument()
  })

  it('reports a rejected mutation without an unhandled rejection and clears it on success', async () => {
    const snapshot = projectionWithSecondWorkspace()
    const bridge = createBridge(undefined, snapshot)
    vi.mocked(bridge.selectWorkspace)
      .mockRejectedValueOnce(new Error('selection was rejected'))
      .mockResolvedValueOnce(mutationAt(43, snapshot, snapshot.workspaces[1]!.id))
    window.desktopBridge = bridge
    render(<App />)

    const secondWorkspace = (
      await screen.findByText('Second workspace', { selector: 'strong' })
    ).closest('.workspace-row') as HTMLButtonElement
    fireEvent.click(secondWorkspace)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Change not saved. ${messages.workspaceProjection.errors.changeFailed} Try the action again.`
    )

    fireEvent.click(secondWorkspace)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('routes terminal restart rejection through the shared mutation alert and accepts retry', async () => {
    const snapshot = projectionWithSelectedShell()
    const bridge = createBridge(undefined, snapshot)
    vi.mocked(bridge.restartTerminal)
      .mockRejectedValueOnce(new Error('restart was rejected'))
      .mockResolvedValueOnce(mutationAt(44, snapshot))
    window.desktopBridge = bridge
    render(<App />)

    const restart = await screen.findByRole('button', { name: 'Terminal ready' })
    fireEvent.click(restart)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Change not saved. ${messages.workspaceProjection.errors.changeFailed} Try the action again.`
    )
    fireEvent.click(restart)

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(bridge.restartTerminal).toHaveBeenCalledTimes(2)
    expect(bridge.listWorkspaces).toHaveBeenCalledOnce()
  })

  it('shows authoritative branch and selected terminal process metadata in the workspace row', async () => {
    const snapshot = projectionWithSelectedShell()
    const bridge = createBridge(undefined, snapshot)
    vi.mocked(bridge.getWorkspaceRuntimeMetadata!).mockResolvedValue({
      gitBranch: 'feature/sidebar-metadata',
      gitStatus: {
        clean: false,
        staged: true,
        unstaged: true,
        untracked: false,
        conflicted: false,
        ahead: 2,
        behind: 1
      },
      listeningPorts: [3000, 5173]
    })
    window.desktopBridge = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Terminal ready' }))

    const runtimeMetadata = await screen.findByLabelText(
      'Git branch feature/sidebar-metadata; Git status staged, unstaged, ahead 2, behind 1; process bash; listening ports 3000, 5173'
    )
    expect(runtimeMetadata).toHaveTextContent('Branch: feature/sidebar-metadata')
    expect(runtimeMetadata).toHaveTextContent('staged, unstaged, ahead 2, behind 1')
    expect(runtimeMetadata).toHaveTextContent('Process: bash')
    expect(runtimeMetadata).toHaveTextContent('Ports: 3000, 5173')
    expect(bridge.getWorkspaceRuntimeMetadata).toHaveBeenCalledWith({
      workspaceId: snapshot.workspaces[0]!.id
    })

    const workspace = snapshot.workspaces[0]!
    const terminalPane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)!
    const withoutRuntime = {
      ...snapshot,
      workspaces: [
        {
          ...workspace,
          panes: workspace.panes.map((pane) =>
            pane.id === terminalPane.id ? { ...pane, selectedTabId: pane.tabIds[1]! } : pane
          )
        }
      ]
    }
    vi.mocked(bridge.selectTab).mockResolvedValueOnce(mutationAt(43, withoutRuntime))
    vi.mocked(bridge.getWorkspaceRuntimeMetadata!).mockResolvedValueOnce({
      gitBranch: 'feature/sidebar-metadata',
      gitStatus: {
        clean: true,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
        ahead: 0,
        behind: 0
      },
      listeningPorts: []
    })
    fireEvent.click(screen.getByRole('tab', { name: 'M2 tests' }))

    expect(await screen.findByText('Ports: —')).toBeInTheDocument()
    await waitFor(() => expect(bridge.getWorkspaceRuntimeMetadata).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Clean')).toBeInTheDocument()
  })

  it('uses one workspace tab stop and selects the row reached by roving focus', async () => {
    const snapshot = projectionWithSecondWorkspace()
    const bridge = createBridge(undefined, snapshot)
    vi.mocked(bridge.selectWorkspace).mockResolvedValueOnce(
      mutationAt(43, snapshot, snapshot.workspaces[1]!.id)
    )
    window.desktopBridge = bridge
    render(<App />)

    const first = (await screen.findByText('Fixture workspace', { selector: 'strong' })).closest(
      '.workspace-row'
    ) as HTMLButtonElement
    const second = screen
      .getByText('Second workspace', { selector: 'strong' })
      .closest('.workspace-row') as HTMLButtonElement
    expect(first).toHaveAttribute('tabindex', '0')
    expect(second).toHaveAttribute('tabindex', '-1')

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(second).toHaveFocus()
    await waitFor(() =>
      expect(bridge.selectWorkspace).toHaveBeenCalledWith({
        workspaceId: snapshot.workspaces[1]!.id
      })
    )
  })

  it('links roving tabs to their tabpanel and activates the focused tab', async () => {
    const bridge = createBridge()
    window.desktopBridge = bridge
    render(<App />)

    const selected = await screen.findByRole('tab', { name: 'M2 tests' })
    const shell = screen.getByRole('tab', { name: 'Shell' })
    const moveLeft = screen.getByRole('button', { name: 'Move M2 tests left' })
    const moveRight = screen.getByRole('button', { name: 'Move M2 tests right' })
    expect(selected).toHaveAttribute('tabindex', '0')
    expect(shell).toHaveAttribute('tabindex', '-1')
    expect(moveLeft.querySelector('svg')).not.toBeNull()
    expect(moveRight.querySelector('svg')).not.toBeNull()
    expect(moveLeft).not.toHaveTextContent('‹')
    expect(moveRight).not.toHaveTextContent('›')
    expect(screen.getByRole('tabpanel', { name: 'M2 tests' })).toHaveAttribute(
      'id',
      selected.getAttribute('aria-controls')
    )

    selected.focus()
    fireEvent.keyDown(selected, { key: 'ArrowLeft' })
    expect(shell).toHaveFocus()
    await waitFor(() =>
      expect(bridge.selectTab).toHaveBeenCalledWith({
        workspaceId: projectionFixture.workspaces[0]!.id,
        tabId: projectionFixture.workspaces[0]!.tabs[0]!.id
      })
    )
  })

  it('tracks and executes the active command-palette option', async () => {
    window.desktopBridge = createBridge()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open command palette' }))

    const search = await screen.findByRole('combobox', { name: 'Search commands' })
    expect(search).toHaveAttribute('aria-activedescendant')
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Open folder')

    fireEvent.keyDown(search, { key: 'End' })
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Settings')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeVisible()
  })

  it('discovers and invokes parameterless project actions through the public registry', async () => {
    const bridge = createBridge(
      vi.fn().mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['actions-v1', 'configuration-v2']
      })
    )
    bridge.listPublicActions = vi.fn().mockResolvedValue({
      registryRevision: 2,
      idempotencyEpoch: '20000000-0000-4000-8000-000000000001',
      definitions: [
        {
          actionId: 'project.example.build',
          actionVersion: 1,
          localizedTitleKey: 'actions.project_example_build',
          displayTitle: 'Build verified project',
          defaultShortcut: 'Primary+Shift+B',
          category: 'custom',
          owner: 'service',
          parameterSchemaVersion: 1,
          resultSchemaVersion: 1,
          authorizationClass: 'owner',
          interactionClass: 'confirmationRequired',
          limits: { maxParameterBytes: 2, maxResultBytes: 1024, timeoutMs: 30_000 }
        }
      ]
    })
    bridge.invokePublicAction = vi.fn().mockResolvedValue({
      invocationId: '20000000-0000-4000-8000-000000000002',
      correlationId: '20000000-0000-4000-8000-000000000003',
      state: 'acknowledged',
      terminalCode: 'succeeded',
      result: {},
      updatedAtMs: 4
    })
    window.desktopBridge = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open command palette' }))
    const search = await screen.findByRole('combobox', { name: 'Search commands' })
    fireEvent.change(search, { target: { value: 'project example build' } })
    const option = await screen.findByRole('option', { name: /Build verified project/u })
    expect(option).toHaveTextContent('API')
    fireEvent.click(option)

    await waitFor(() =>
      expect(bridge.invokePublicAction).toHaveBeenCalledWith({
        actionId: 'project.example.build',
        actionVersion: 1,
        parameters: {}
      })
    )

    vi.mocked(bridge.invokePublicAction).mockClear()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(bridge.invokePublicAction).toHaveBeenCalledTimes(1))
  })

  it('routes pin, group collapse, and group rename UI through the same typed public actions', async () => {
    const workspace = projectionFixture.workspaces[0]!
    const groupId = '30000000-0000-4000-8000-000000000001'
    const bridge = createBridge(
      vi.fn().mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['actions-v1', 'workspace-groups-v1', 'configuration-v2']
      })
    )
    const definition = (actionId: string) => ({
      actionId,
      actionVersion: 1,
      localizedTitleKey: `actions.${actionId.replaceAll('.', '_')}`,
      category: 'organization',
      owner: 'service' as const,
      parameterSchemaVersion: 1,
      resultSchemaVersion: 1,
      authorizationClass: 'owner' as const,
      interactionClass: 'headless' as const,
      limits: { maxParameterBytes: 4096, maxResultBytes: 1024, timeoutMs: 30_000 }
    })
    bridge.listPublicActions = vi.fn().mockResolvedValue({
      registryRevision: 3,
      idempotencyEpoch: '20000000-0000-4000-8000-000000000001',
      definitions: [
        definition('workspace.card.pin'),
        definition('workspace.group.rename'),
        definition('workspace.group.collapse')
      ]
    })
    bridge.invokePublicAction = vi.fn().mockImplementation(() =>
      Promise.resolve({
        invocationId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        state: 'acknowledged' as const,
        terminalCode: 'succeeded' as const,
        result: {},
        updatedAtMs: 4
      })
    )
    bridge.getWorkspaceOrganization = vi.fn().mockResolvedValue({
      organization: {
        revision: 9,
        selection: [workspace.id],
        focusedWorkspaceId: workspace.id,
        pins: [],
        groups: [{ id: groupId, name: 'Agents', collapsed: false, order: 0 }],
        assignments: [{ workspaceId: workspace.id, groupId }]
      }
    })
    bridge.pinWorkspace = vi.fn()
    bridge.renameGroup = vi.fn()
    bridge.collapseGroup = vi.fn()
    bridge.selectWorkspaces = vi.fn()
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('Renamed agents'))
    window.desktopBridge = bridge
    render(<App />)

    await screen.findByRole('button', { name: 'Collapse Agents' })
    const row = (await screen.findByText('Fixture workspace', { selector: 'strong' })).closest(
      '.workspace-row'
    ) as HTMLButtonElement
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }))
    await waitFor(() =>
      expect(bridge.invokePublicAction).toHaveBeenCalledWith({
        actionId: 'workspace.card.pin',
        actionVersion: 1,
        parameters: { workspaceId: workspace.id, pinned: true, expectedRevision: 9 }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Agents' }))
    await waitFor(() =>
      expect(bridge.invokePublicAction).toHaveBeenCalledWith({
        actionId: 'workspace.group.collapse',
        actionVersion: 1,
        parameters: { groupId, collapsed: true, expectedRevision: 9 }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename Agents' }))
    await waitFor(() =>
      expect(bridge.invokePublicAction).toHaveBeenCalledWith({
        actionId: 'workspace.group.rename',
        actionVersion: 1,
        parameters: { groupId, name: 'Renamed agents', expectedRevision: 9 }
      })
    )
    expect(bridge.pinWorkspace).not.toHaveBeenCalled()
    expect(bridge.collapseGroup).not.toHaveBeenCalled()
    expect(bridge.renameGroup).not.toHaveBeenCalled()
  })

  it('blocks physical shortcut conflicts while preserving set, clear, and reset mutations', async () => {
    const bridge = createBridge()
    window.desktopBridge = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))

    const input = await screen.findByRole('textbox', { name: 'Open folder shortcut' })
    const row = input.closest('.shortcut-row')
    expect(row).not.toBeNull()
    const rowQueries = within(row as HTMLElement)
    fireEvent.change(input, { target: { value: 'Primary+D' } })
    expect(rowQueries.getByRole('status')).toHaveTextContent('Conflicts with Split right.')
    expect(rowQueries.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(bridge.updateSettings).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'Primary+G' } })
    fireEvent.click(rowQueries.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledTimes(1))
    expect(bridge.updateSettings).toHaveBeenLastCalledWith({
      shortcutOverrides: [{ commandId: 'workspace.new', shortcut: 'Primary+G' }]
    })

    fireEvent.click(rowQueries.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledTimes(2))
    expect(bridge.updateSettings).toHaveBeenLastCalledWith({
      shortcutOverrides: [{ commandId: 'workspace.new', shortcut: null }]
    })

    fireEvent.click(rowQueries.getByRole('button', { name: 'Reset workspace.new' }))
    await waitFor(() =>
      expect(bridge.resetSettingKey).toHaveBeenCalledWith({ commandId: 'workspace.new' })
    )
  })

  it('shows derived attention, manages notification history, and updates privacy settings', async () => {
    const notice: NotificationSnapshot = {
      id: '60000000-0000-4000-8000-000000000001',
      workspaceId: projectionFixture.workspaces[0]!.id,
      source: 'cli',
      level: 'warning',
      title: 'Agent needs input',
      body: 'Permission required',
      createdAt: Date.now()
    }
    const attention = {
      unreadCount: 1,
      highestLevel: 'warning' as const,
      latestUnread: {
        notificationId: notice.id,
        title: notice.title,
        bodyExcerpt: notice.body ?? null,
        source: notice.source,
        createdAt: notice.createdAt
      }
    }
    const snapshot = {
      ...projectionFixture,
      attention,
      workspaces: projectionFixture.workspaces.map((workspace, index) =>
        index === 0 ? { ...workspace, attention } : workspace
      )
    }
    const bridge = createBridge(undefined, snapshot)
    bridge.listNotifications = vi.fn().mockResolvedValue({
      revision: snapshot.revision,
      notifications: [notice],
      total: 1,
      unreadCount: 1
    })
    window.desktopBridge = bridge
    render(<App />)

    expect(await screen.findByText('Agent needs input')).toHaveClass('workspace-attention-excerpt')
    const trigger = await screen.findByRole('button', { name: /Open notifications, 1 unread/ })
    fireEvent.click(trigger)
    const center = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(center).toBeVisible()
    expect(within(center).getByText('Agent needs input')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Mark notification read' }))
    await waitFor(() =>
      expect(bridge.markNotificationRead).toHaveBeenCalledWith({ notificationId: notice.id })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    const includeBody = await screen.findByRole('checkbox', { name: /Include notification body/ })
    fireEvent.click(includeBody)
    fireEvent.click(
      within(includeBody.closest('.configuration-section') as HTMLElement).getByRole('button', {
        name: 'Save section'
      })
    )
    await waitFor(() =>
      expect(bridge.updateConfiguration).toHaveBeenCalledWith({
        expectedRevision: 4,
        update: { notifications: { systemEnabled: true, includeBody: true } }
      })
    )
  })

  it('jumps to an authoritative unread notification older than retained history', async () => {
    const workspace = projectionFixture.workspaces[0]!
    const olderUnread: NotificationSnapshot = {
      id: '60000000-0000-4000-8000-000000000999',
      workspaceId: workspace.id,
      source: 'agentHook',
      level: 'warning',
      title: 'Older unread notification',
      createdAt: 1
    }
    const newerRead = Array.from({ length: 200 }, (_, index): NotificationSnapshot => ({
      ...olderUnread,
      id: `newer-read-${String(index)}`,
      title: `Newer read ${String(index)}`,
      createdAt: 201 - index,
      readAt: 300
    }))
    const bridge = createBridge()
    vi.mocked(bridge.listNotifications!).mockImplementation((params = {}) =>
      Promise.resolve(
        params.unreadOnly
          ? {
              revision: projectionFixture.revision,
              notifications: [olderUnread],
              total: 1,
              unreadCount: 1
            }
          : {
              revision: projectionFixture.revision,
              notifications: newerRead.slice(params.offset ?? 0, (params.offset ?? 0) + 200),
              total: 201,
              unreadCount: 1
            }
      )
    )
    window.desktopBridge = bridge
    render(<App />)

    await screen.findByText('Browser content ready')
    expect(screen.queryByText(olderUnread.title)).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'u', ctrlKey: true, shiftKey: true })

    await waitFor(() =>
      expect(bridge.listNotifications).toHaveBeenCalledWith({
        unreadOnly: true,
        offset: 0,
        limit: 1
      })
    )
    await waitFor(() =>
      expect(bridge.markNotificationRead).toHaveBeenCalledWith({
        notificationId: olderUnread.id
      })
    )
    expect(screen.getByRole('region', { name: 'Workspace content' })).toHaveFocus()
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument()
  })

  it('closes the command palette before jumping to the authoritative latest unread target', async () => {
    const workspace = projectionFixture.workspaces[0]!
    const targetTab = workspace.tabs.find((tab) => tab.id === workspace.panes[1]!.selectedTabId)!
    const latestUnread: NotificationSnapshot = {
      id: '60000000-0000-4000-8000-000000000998',
      workspaceId: workspace.id,
      paneId: targetTab.paneId,
      tabId: targetTab.id,
      source: 'agentHook',
      level: 'warning',
      title: 'Palette unread notification',
      createdAt: 2
    }
    const bridge = createBridge()
    vi.mocked(bridge.listNotifications!).mockImplementation((params = {}) =>
      Promise.resolve(
        params.unreadOnly
          ? {
              revision: projectionFixture.revision,
              notifications: [latestUnread],
              total: 1,
              unreadCount: 1
            }
          : {
              revision: projectionFixture.revision,
              notifications: [],
              total: 1,
              unreadCount: 1
            }
      )
    )
    window.desktopBridge = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open command palette' }))
    const search = await screen.findByRole('combobox', { name: 'Search commands' })
    fireEvent.change(search, { target: { value: 'latest unread' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    await waitFor(() =>
      expect(bridge.listNotifications).toHaveBeenCalledWith({
        unreadOnly: true,
        offset: 0,
        limit: 1
      })
    )
    await waitFor(() =>
      expect(bridge.markNotificationRead).toHaveBeenCalledWith({
        notificationId: latestUnread.id
      })
    )
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    expect(document.querySelector(`[data-tab-id="${targetTab.id}"]`)).toHaveFocus()
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument()
    expect(
      screen.queryByText('The notification target could not be made visible.')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('The notification target could not be opened.')
    ).not.toBeInTheDocument()
  })

  it('blocks palette reopen while command execution is in flight and releases it afterward', async () => {
    const workspace = projectionFixture.workspaces[0]!
    const targetTab = workspace.tabs.find((tab) => tab.id === workspace.panes[1]!.selectedTabId)!
    const latestUnread: NotificationSnapshot = {
      id: '60000000-0000-4000-8000-000000000997',
      workspaceId: workspace.id,
      paneId: targetTab.paneId,
      tabId: targetTab.id,
      source: 'agentHook',
      level: 'warning',
      title: 'Deferred palette unread notification',
      createdAt: 3
    }
    let resolveLatestUnread!: (value: {
      revision: number
      notifications: NotificationSnapshot[]
      total: number
      unreadCount: number
    }) => void
    const latestUnreadLookup = new Promise<{
      revision: number
      notifications: NotificationSnapshot[]
      total: number
      unreadCount: number
    }>((resolve) => {
      resolveLatestUnread = resolve
    })
    const bridge = createBridge()
    vi.mocked(bridge.listNotifications!).mockImplementation((params = {}) =>
      params.unreadOnly
        ? latestUnreadLookup
        : Promise.resolve({
            revision: projectionFixture.revision,
            notifications: [],
            total: 1,
            unreadCount: 1
          })
    )
    window.desktopBridge = bridge
    render(<App />)

    const openPalette = await screen.findByRole('button', { name: 'Open command palette' })
    fireEvent.click(openPalette)
    const search = await screen.findByRole('combobox', { name: 'Search commands' })
    fireEvent.change(search, { target: { value: 'latest unread' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(bridge.listNotifications).toHaveBeenCalledWith({
        unreadOnly: true,
        offset: 0,
        limit: 1
      })
    )

    fireEvent.click(openPalette)
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true })

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    expect(
      vi.mocked(bridge.listNotifications!).mock.calls.filter(([params]) => params?.unreadOnly)
    ).toHaveLength(1)
    expect(bridge.focusPane).not.toHaveBeenCalled()
    expect(bridge.selectTab).not.toHaveBeenCalled()
    expect(bridge.markNotificationRead).not.toHaveBeenCalled()

    resolveLatestUnread({
      revision: projectionFixture.revision,
      notifications: [latestUnread],
      total: 1,
      unreadCount: 1
    })

    await waitFor(() =>
      expect(bridge.markNotificationRead).toHaveBeenCalledWith({
        notificationId: latestUnread.id
      })
    )
    expect(bridge.markNotificationRead).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(bridge.listNotifications!).mock.calls.filter(([params]) => params?.unreadOnly)
    ).toHaveLength(1)
    expect(document.querySelector(`[data-tab-id="${targetTab.id}"]`)).toHaveFocus()
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(openPalette)
    const reopenedPalette = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(reopenedPalette).toBeVisible()
    const reopenedSearch = within(reopenedPalette).getByRole('combobox', {
      name: 'Search commands'
    })
    fireEvent.change(reopenedSearch, { target: { value: 'command palette' } })
    fireEvent.keyDown(reopenedSearch, { key: 'Enter' })
    await waitFor(() => expect(reopenedPalette).not.toBeInTheDocument())
  })

  it('reports an authoritative unread lookup failure without opening notifications', async () => {
    const bridge = createBridge()
    vi.mocked(bridge.listNotifications!).mockImplementation((params = {}) =>
      params.unreadOnly
        ? Promise.reject(new Error('notification lookup failed'))
        : Promise.resolve({
            revision: projectionFixture.revision,
            notifications: [],
            total: 1,
            unreadCount: 1
          })
    )
    window.desktopBridge = bridge
    render(<App />)

    await screen.findByText('Browser content ready')
    fireEvent.keyDown(document, { key: 'u', ctrlKey: true, shiftKey: true })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      messages.workspaceProjection.errors.changeFailed
    )
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument()
    expect(bridge.markNotificationRead).not.toHaveBeenCalled()
  })

  it('gates projection loading on lifecycle readiness and accepts a newer event', async () => {
    const bridge = createBridge()
    let emitLifecycle: ((state: DesktopLifecycleState) => void) | undefined
    bridge.getLifecycleState = vi.fn().mockReturnValue(new Promise(() => undefined))
    bridge.onLifecycleState = vi.fn((listener: (state: DesktopLifecycleState) => void) => {
      emitLifecycle = listener
      return () => undefined
    })
    window.desktopBridge = bridge
    render(<App />)

    expect(screen.getByText('Starting local workspace service…')).toBeVisible()
    expect(bridge.listWorkspaces).not.toHaveBeenCalled()
    emitLifecycle?.({ status: 'ready' })

    expect(await screen.findByText('Browser content ready')).toBeVisible()
    expect(bridge.listWorkspaces).toHaveBeenCalledOnce()
  })

  it('shows bounded recovery progress without claiming terminal continuity', async () => {
    const bridge = createBridge()
    bridge.getLifecycleState = vi.fn().mockResolvedValue({
      status: 'recovering',
      attempt: 2,
      maxAttempts: 4,
      message: 'Restarting the local service.'
    })
    window.desktopBridge = bridge
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Restoring your workspace' })).toBeVisible()
    expect(screen.getByText('Recovery attempt 2 of 4')).toBeVisible()
    expect(screen.getByText(/Live terminal processes were interrupted/)).toBeVisible()
    expect(bridge.listWorkspaces).not.toHaveBeenCalled()
  })

  it('retries a failed service once and initializes after the ready event', async () => {
    const bridge = createBridge()
    let emitLifecycle: ((state: DesktopLifecycleState) => void) | undefined
    bridge.getLifecycleState = vi.fn().mockResolvedValue({
      status: 'failed',
      message: 'The local service stopped unexpectedly.'
    })
    bridge.restartService = vi.fn().mockResolvedValue(undefined)
    bridge.onLifecycleState = vi.fn((listener: (state: DesktopLifecycleState) => void) => {
      emitLifecycle = listener
      return () => undefined
    })
    window.desktopBridge = bridge
    render(<App />)

    const retry = await screen.findByRole('button', { name: 'Retry service' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    await waitFor(() => expect(bridge.restartService).toHaveBeenCalledOnce())
    emitLifecycle?.({ status: 'ready' })

    expect(await screen.findByText('Browser content ready')).toBeVisible()
  })

  it('renders migration backup unavailability from the path-free lifecycle signal', async () => {
    const bridge = createBridge()
    bridge.getLifecycleState = vi.fn().mockResolvedValue({
      status: 'recoveryRequired',
      recovery: {
        event: 'service.recoveryRequired',
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        category: 'corruptDatabase',
        message: 'The database could not be read safely.',
        migrationBackupAvailable: false
      }
    })
    window.desktopBridge = bridge

    render(<App />)

    expect(await screen.findByText('No migration backup is available.')).toBeVisible()
  })

  it('requires an exact diagnostics preview and handles recovery export cancellation safely', async () => {
    const bridge = createBridge()
    const preview = {
      entries: [
        { name: 'service.log', bytes: 42 },
        { name: 'configuration.json', bytes: 1000 }
      ],
      totalBytes: 1042,
      redactionCount: 3,
      createdAt: 5
    }
    bridge.getLifecycleState = vi.fn().mockResolvedValue({
      status: 'recoveryRequired',
      recovery: {
        event: 'service.recoveryRequired',
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        category: 'migrationFailed',
        message: 'The database upgrade could not be completed.',
        migrationBackupAvailable: true
      }
    })
    bridge.previewDiagnostics = vi.fn().mockResolvedValue(preview)
    bridge.exportDiagnostics = vi.fn().mockResolvedValue(null)
    bridge.exportRecoveryDatabase = vi.fn().mockResolvedValue(null)
    bridge.restartService = vi.fn()
    bridge.quitApplication = vi.fn()
    window.desktopBridge = bridge
    render(<App />)

    expect(await screen.findByText('Database upgrade problem')).toBeVisible()
    expect(screen.getByText('A migration backup is available for recovery.')).toBeVisible()
    expect(screen.queryByText('/private/never-display-this.backup')).not.toBeInTheDocument()
    const exportDiagnostics = screen.getByRole('button', { name: 'Export diagnostic bundle' })
    expect(exportDiagnostics).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Preview diagnostics' }))
    expect(await screen.findByText('service.log')).toBeVisible()
    expect(screen.getByText('configuration.json')).toBeVisible()
    expect(screen.getByText('1.0 KB')).toBeVisible()
    expect(exportDiagnostics).toBeEnabled()
    fireEvent.click(exportDiagnostics)
    await waitFor(() => expect(bridge.exportDiagnostics).toHaveBeenCalledWith(preview))
    expect(await screen.findByText('Diagnostic bundle export cancelled.')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Export database' }))
    expect(await screen.findByText('Database export cancelled.')).toBeVisible()
  })

  it('loads protocol settings and saves only the edited section with CAS revision', async () => {
    const bridge = createBridge()
    bridge.getConfiguration = vi.fn().mockResolvedValue({ config: configurationFixture })
    bridge.updateConfiguration = vi.fn().mockResolvedValue({
      config: {
        ...configurationFixture,
        revision: 5,
        appearance: { ...configurationFixture.appearance, theme: 'dark', density: 'expanded' }
      }
    })
    window.desktopBridge = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))

    const theme = await screen.findByRole('combobox', { name: 'Theme' })
    fireEvent.change(theme, { target: { value: 'dark' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Density' }), {
      target: { value: 'expanded' }
    })
    const appearance = theme.closest('.configuration-section')
    expect(appearance).not.toBeNull()
    fireEvent.click(within(appearance as HTMLElement).getByRole('button', { name: 'Save section' }))

    await waitFor(() =>
      expect(bridge.updateConfiguration).toHaveBeenCalledWith({
        expectedRevision: 4,
        update: {
          appearance: {
            theme: 'dark',
            density: 'expanded',
            fontFamily: configurationFixture.appearance.fontFamily
          }
        }
      })
    )
    expect(await screen.findByText('Setting saved.')).toBeVisible()
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveAttribute('data-density', 'expanded')
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(screen.getByRole('textbox', { name: 'Shell path' })).toBeEnabled()
    expect(
      screen.getByText(
        'Applies to new and restarted terminals. Existing terminal processes keep their current shell.'
      )
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByRole('textbox', { name: 'Profile name' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Enable agent integrations' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Log level' })).toBeEnabled()
    expect(screen.getByText('Applies immediately to subsequent service log events.')).toBeVisible()
    expect(
      screen.getByText('Agent integrations are not connected to a runtime in this version.')
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
    expect(screen.getByRole('combobox', { name: 'Update channel' })).toBeEnabled()
  })

  it('gates expanded density on the configuration-v2 capability', async () => {
    const identify = vi.fn().mockResolvedValue({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: []
    })
    window.desktopBridge = createBridge(identify)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByRole('combobox', { name: 'Density' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Expanded' })).not.toBeInTheDocument()
  })

  it('saves the native select value when a packaged selection precedes the React commit', async () => {
    const bridge = createBridge()
    bridge.getConfiguration = vi.fn().mockResolvedValue({ config: configurationFixture })
    bridge.updateConfiguration = vi.fn().mockResolvedValue({
      config: {
        ...configurationFixture,
        revision: 5,
        appearance: { ...configurationFixture.appearance, theme: 'light' }
      }
    })
    window.desktopBridge = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))

    const theme = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Theme' })
    theme.value = 'light'
    const appearance = theme.closest('.configuration-section')
    expect(appearance).not.toBeNull()
    fireEvent.click(within(appearance as HTMLElement).getByRole('button', { name: 'Save section' }))

    await waitFor(() =>
      expect(bridge.updateConfiguration).toHaveBeenCalledWith({
        expectedRevision: 4,
        update: {
          appearance: {
            density: configurationFixture.appearance.density,
            fontFamily: configurationFixture.appearance.fontFamily,
            theme: 'light'
          }
        }
      })
    )
    expect(await screen.findByText('Setting saved.')).toBeVisible()
  })

  it('saves and clears the configured shell with the authoritative terminal section', async () => {
    const bridge = createBridge()
    const configured = {
      ...configurationFixture,
      revision: 5,
      terminal: { ...configurationFixture.terminal, shellPath: '/bin/false' }
    }
    const cleared = {
      ...configured,
      revision: 6,
      terminal: { ...configured.terminal, shellPath: null }
    }
    bridge.getConfiguration = vi.fn().mockResolvedValue({ config: configurationFixture })
    bridge.updateConfiguration = vi
      .fn()
      .mockResolvedValueOnce({ config: configured })
      .mockResolvedValueOnce({ config: cleared })
    window.desktopBridge = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))

    const shellPath = await screen.findByRole('textbox', { name: 'Shell path' })
    const terminalSection = shellPath.closest('.configuration-section')
    expect(terminalSection).not.toBeNull()
    fireEvent.change(shellPath, { target: { value: '/bin/false' } })
    fireEvent.click(
      within(terminalSection as HTMLElement).getByRole('button', { name: 'Save section' })
    )
    await waitFor(() =>
      expect(bridge.updateConfiguration).toHaveBeenNthCalledWith(1, {
        expectedRevision: 4,
        update: {
          terminal: { ...configurationFixture.terminal, shellPath: '/bin/false' }
        }
      })
    )
    await waitFor(() => expect(shellPath).toHaveValue('/bin/false'))

    fireEvent.change(shellPath, { target: { value: '' } })
    fireEvent.click(
      within(terminalSection as HTMLElement).getByRole('button', { name: 'Save section' })
    )
    await waitFor(() =>
      expect(bridge.updateConfiguration).toHaveBeenNthCalledWith(2, {
        expectedRevision: 5,
        update: { terminal: { ...configured.terminal, shellPath: null } }
      })
    )
    await waitFor(() => expect(shellPath).toHaveValue(''))
  })

  it('saves the live logging level as a complete revision-checked section', async () => {
    const bridge = createBridge()
    const configured = {
      ...configurationFixture,
      revision: 5,
      logging: { level: 'debug' as const }
    }
    bridge.getConfiguration = vi.fn().mockResolvedValue({ config: configurationFixture })
    bridge.updateConfiguration = vi.fn().mockResolvedValue({ config: configured })
    window.desktopBridge = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    const logLevel = await screen.findByRole('combobox', { name: 'Log level' })
    const loggingSection = logLevel.closest('.configuration-section')
    expect(loggingSection).not.toBeNull()
    fireEvent.change(logLevel, { target: { value: 'debug' } })
    fireEvent.click(
      within(loggingSection as HTMLElement).getByRole('button', { name: 'Save section' })
    )

    await waitFor(() =>
      expect(bridge.updateConfiguration).toHaveBeenCalledWith({
        expectedRevision: 4,
        update: { logging: { level: 'debug' } }
      })
    )
    await waitFor(() => expect(logLevel).toHaveValue('debug'))
  })

  it('persists the update channel and requires separate update action clicks', async () => {
    const bridge = createBridge()
    bridge.getUpdateState = vi.fn().mockResolvedValue({
      status: 'idle',
      channel: 'stable',
      packageType: 'appimage'
    })
    bridge.checkForUpdate = vi.fn().mockResolvedValue({
      status: 'available',
      channel: 'beta',
      packageType: 'appimage',
      version: '1.2.3-beta.1'
    })
    bridge.downloadUpdate = vi.fn().mockResolvedValue({
      status: 'downloaded',
      channel: 'beta',
      packageType: 'appimage',
      version: '1.2.3-beta.1'
    })
    bridge.installUpdate = vi.fn().mockResolvedValue(undefined)
    bridge.onUpdateState = vi.fn(() => () => undefined)
    window.desktopBridge = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Updates' }))

    const channel = await screen.findByRole('combobox', { name: 'Update channel' })
    fireEvent.change(channel, { target: { value: 'beta' } })
    fireEvent.click(
      within(channel.closest('.configuration-section') as HTMLElement).getByRole('button', {
        name: 'Save section'
      })
    )
    await waitFor(() =>
      expect(bridge.updateConfiguration).toHaveBeenCalledWith({
        expectedRevision: 4,
        update: { updates: { channel: 'beta' } }
      })
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
    expect(bridge.checkForUpdate).toHaveBeenCalledOnce()
    expect(bridge.downloadUpdate).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Download update' }))
    expect(bridge.downloadUpdate).toHaveBeenCalledOnce()
    expect(bridge.installUpdate).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Install and restart' }))
    expect(bridge.installUpdate).toHaveBeenCalledOnce()
  })

  it('reloads authoritative configuration after a CAS conflict and retains legacy controls', async () => {
    const bridge = createBridge()
    const latest = {
      ...configurationFixture,
      revision: 8,
      appearance: { ...configurationFixture.appearance, theme: 'light' as const }
    }
    bridge.getConfiguration = vi
      .fn()
      .mockResolvedValueOnce({ config: configurationFixture })
      .mockResolvedValueOnce({ config: latest })
    bridge.updateConfiguration = vi.fn().mockRejectedValue(new Error('revision conflict'))
    window.desktopBridge = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))

    const theme = await screen.findByRole('combobox', { name: 'Theme' })
    fireEvent.change(theme, { target: { value: 'dark' } })
    fireEvent.click(
      within(theme.closest('.configuration-section') as HTMLElement).getByRole('button', {
        name: 'Save section'
      })
    )

    expect(
      await screen.findByText(
        'Settings changed elsewhere. The latest configuration has been reloaded.'
      )
    ).toBeVisible()
    await waitFor(() => expect(theme).toHaveValue('light'))
    expect(bridge.getConfiguration).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByRole('checkbox', { name: /Include notification body/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(screen.getByRole('textbox', { name: 'Open folder shortcut' })).toBeVisible()
  })
})

const configurationFixture: ConfigurationSnapshot = {
  schemaVersion: 2,
  revision: 4,
  appearance: { theme: 'system', density: 'comfortable', fontFamily: 'system-ui' },
  terminal: {
    shellPath: '/bin/sh',
    fontFamily: 'monospace',
    fontSize: 13,
    scrollback: 10_000,
    multilinePasteProtection: true
  },
  browser: { profileName: 'Default', partition: 'default', privacy: 'standard' },
  notifications: { systemEnabled: true, includeBody: false },
  keyboardShortcuts: { overrides: {} },
  agentIntegration: { enabled: true, notificationsEnabled: true, browserEnabled: true },
  updates: { channel: 'stable' },
  logging: { level: 'info' }
}

function createBridge(
  identify: DesktopBridge['identify'] | undefined = undefined,
  snapshot: ApplicationSnapshot = projectionFixture
): DesktopBridge {
  const resolvedMutation = (): Promise<MutationResult> => Promise.resolve(mutationAt(43, snapshot))
  return {
    identify:
      identify ??
      vi.fn().mockResolvedValue({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['configuration-v2']
      }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot }),
    getWorkspaceRuntimeMetadata: vi
      .fn()
      .mockResolvedValue({ gitBranch: null, gitStatus: null, listeningPorts: [] }),
    pickWorkspaceDirectory: vi.fn().mockResolvedValue(null),
    snapshotWorkspace: vi.fn(),
    createWorkspace: vi.fn(resolvedMutation),
    updateWorkspace: vi.fn(resolvedMutation),
    selectWorkspace: vi.fn(resolvedMutation),
    moveWorkspace: vi.fn(resolvedMutation),
    closeWorkspace: vi.fn(resolvedMutation),
    splitPane: vi.fn(resolvedMutation),
    focusPane: vi.fn(resolvedMutation),
    resizePane: vi.fn(resolvedMutation),
    closePane: vi.fn(resolvedMutation),
    moveTabToPane: vi.fn(resolvedMutation),
    openTerminalTab: vi.fn(resolvedMutation),
    openBrowserTab: vi.fn(resolvedMutation),
    navigateBrowser: vi.fn(resolvedMutation),
    browserBack: vi.fn(resolvedMutation),
    browserForward: vi.fn(resolvedMutation),
    reloadBrowser: vi.fn(resolvedMutation),
    stopBrowser: vi.fn(resolvedMutation),
    openBrowserDevTools: vi.fn(resolvedMutation),
    mountBrowserView: vi.fn(),
    unmountBrowserView: vi.fn(),
    setBrowserBounds: vi.fn(),
    focusBrowserView: vi.fn(),
    selectTab: vi.fn(resolvedMutation),
    updateTab: vi.fn(resolvedMutation),
    moveTab: vi.fn(resolvedMutation),
    closeTab: vi.fn(resolvedMutation),
    restartTerminal: vi.fn(resolvedMutation),
    listNotifications: vi.fn().mockResolvedValue({
      revision: snapshot.revision,
      notifications: [],
      total: 0,
      unreadCount: 0
    }),
    markNotificationRead: vi.fn(resolvedMutation),
    markNotificationUnread: vi.fn(resolvedMutation),
    clearNotifications: vi.fn(resolvedMutation),
    getSettings: vi.fn().mockResolvedValue(settingsFixture),
    getConfiguration: vi.fn().mockResolvedValue({ config: configurationFixture }),
    updateConfiguration: vi
      .fn<NonNullable<DesktopBridge['updateConfiguration']>>()
      .mockImplementation(({ update }) =>
        Promise.resolve({ config: { ...configurationFixture, revision: 5, ...update } })
      ),
    updateSettings: vi.fn(resolvedMutation),
    resetSettingKey: vi.fn(resolvedMutation),
    attachTerminal: vi.fn(),
    detachTerminal: vi.fn(),
    sendTerminalInput: vi.fn(),
    resizeTerminal: vi.fn(),
    checkpointTerminal: vi.fn(),
    openExternal: vi.fn(),
    onTerminalEvent: vi.fn(() => () => undefined),
    onDomainEvent: vi.fn(() => () => undefined),
    onDomainResyncRequired: vi.fn(() => () => undefined),
    onServiceEvent: vi.fn(() => () => undefined)
  }
}

function projectionWithSecondWorkspace(): ApplicationSnapshot {
  const first = projectionFixture.workspaces[0]!
  return {
    ...projectionFixture,
    workspaces: [
      first,
      {
        ...first,
        id: '10000000-0000-4000-8000-000000000099',
        name: 'Second workspace'
      }
    ]
  }
}

function projectionWithSelectedShell(): ApplicationSnapshot {
  const workspace = projectionFixture.workspaces[0]!
  const terminalPane = workspace.panes[0]!
  return {
    ...projectionFixture,
    workspaces: [
      {
        ...workspace,
        selectedPaneId: terminalPane.id,
        panes: workspace.panes.map((pane) =>
          pane.id === terminalPane.id ? { ...pane, selectedTabId: pane.tabIds[0]! } : pane
        )
      }
    ]
  }
}

function projectionWithTwoSelectedBrowsers(): ApplicationSnapshot {
  const workspace = projectionFixture.workspaces[0]!
  const firstPane = workspace.panes[0]!
  const firstTabId = firstPane.selectedTabId
  const browserTemplate = workspace.tabs.find(({ content }) => content.kind === 'browser')!
  if (browserTemplate.content.kind !== 'browser') throw new Error('Missing browser fixture')
  const browserContent = browserTemplate.content
  return {
    ...projectionFixture,
    workspaces: [
      {
        ...workspace,
        tabs: workspace.tabs.map((tab) =>
          tab.id === firstTabId
            ? {
                ...browserTemplate,
                id: firstTabId,
                paneId: firstPane.id,
                title: 'Backend-owned English title',
                customTitle: null,
                content: {
                  ...browserContent,
                  state: {
                    ...browserContent.state,
                    browserSessionId: '50000000-0000-4000-8000-000000000099'
                  }
                }
              }
            : tab
        )
      }
    ]
  }
}

function mutationAt(
  revision: number,
  snapshot: ApplicationSnapshot,
  selectedWorkspaceId = snapshot.selectedWorkspaceId
): MutationResult {
  return {
    revision,
    snapshot: { ...snapshot, revision, selectedWorkspaceId }
  }
}
