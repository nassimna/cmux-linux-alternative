import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Bell,
  Code2,
  Command,
  FolderOpen,
  GitBranch,
  Globe2,
  GripVertical,
  Layers,
  Keyboard,
  MoreHorizontal,
  Pencil,
  Palette,
  PanelLeft,
  Plus,
  Pin,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  SplitSquareHorizontal,
  SplitSquareVertical,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels'

import type {
  ActionDefinition,
  AgentSessionBinding,
  MutationResult,
  LayoutListResult,
  ExactTabPlacement,
  MultiWindowMutationToken,
  NotificationSnapshot,
  PaneSnapshot,
  PaneTreeNode,
  ShortcutSetting,
  TabSource,
  TabSnapshot,
  WorkspaceCreateParams,
  WorkspaceCardSlotsSnapshot,
  WorkspaceAttentionSnapshot,
  WorkspaceOrganizationSnapshot,
  WorkspaceSnapshot,
  WindowListResult,
  WindowCloseParams,
  WindowPlacementSnapshot
} from '@agent-workspace/protocol-client'
import { displayTabTitle } from '../../../shared/browser-messages'
import type {
  DesktopActionInvokeRequest,
  DesktopWorkspacePathOpener,
  DesktopWorkspacePathOpenerId,
  WorkspaceGitStatus,
  WorkspaceRuntimeMetadata
} from '../../../shared/desktop-bridge'

import { searchCommands } from '../commands/palette'
import {
  bindApplicationMenuCommands,
  buildApplicationMenuState
} from '../commands/application-menu'
import {
  DEFAULT_COMMANDS,
  CommandRegistry,
  defaultCommandRegistry,
  dispatchKeyboardCommand
} from '../commands/registry'
import { clearShortcutCapture, setShortcutCapture } from '../commands/shortcut-capture'
import { publicActionCommands } from '../commands/public-actions'
import {
  effectiveShortcut,
  findShortcutConflicts,
  formatShortcut,
  parseShortcut,
  type Shortcut,
  type ShortcutOverrides,
  type ShortcutPlatform
} from '../commands/shortcuts'
import {
  workspaceCardActionRegistry,
  type CommandContext,
  type CommandDefinition,
  type CommandId
} from '../commands/types'
import { BrowserPane, browserBridge, browserCommandParams } from '../browser'
import {
  resolveTabMutationCommand,
  rovingFocusIndex,
  tabActionToMutation,
  type SplitDirection,
  type TabDropAction,
  type TabMutationSource
} from '../interactions'
import { TerminalPane } from '../terminal/TerminalPane'
import { AttentionBadge } from '../notifications/AttentionBadge'
import { NotificationCenter } from '../notifications/NotificationCenter'
import { NotificationToasts } from '../notifications/NotificationToasts'
import { jumpToNotification, waitForVisibleTarget } from '../notifications/jump'
import { runAfterNotificationCenterClose } from '../notifications/notification-center-close'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { IconButton } from '../ui/icon-button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '../ui/context-menu'
import { messages } from '../messages'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { useProjectionStore, type WorkspaceCardSlotsV2Projection } from './projection-store'
import { ConfigurationSettings, type ConfigurationSettingsSection } from './ConfigurationSettings'
import { AgentSessionsSettings, type AgentWorkspaceContext } from './AgentSessionsSettings'
import { navigateToAgentBinding } from './agent-session-navigation'
import { RemoteSessionsSettings, type RemoteWorkspaceContext } from './RemoteSessionsSettings'
import { WorkspaceCardSlots } from './WorkspaceCardSlots'
import { WorkspaceCardSlotsV2 } from './WorkspaceCardSlotsV2'
import { WorkspaceActivityBadge, workspaceActivity } from './WorkspaceActivityBadge'
import { LegacyOverLimitNotice } from './LegacyOverLimitNotice'
import {
  parseSshWorkspace,
  readSshWorkspaces,
  saveSshWorkspaces,
  sshCommand,
  type SavedSshWorkspace
} from './ssh-workspaces'
import {
  workspacePresentationSections,
  workspaceBatchCloseReplacement,
  workspaceCardSelectionState,
  workspaceSelectionReplacement,
  type SelectionModifiers
} from './organization'

const DEFAULT_ROWS = 30

interface WindowMoveDialogState {
  readonly topology: WindowListResult
  readonly source: TabSource
}
const DEFAULT_COLS = 120
// Git/port discovery launches native probes and port discovery scans the host process/socket
// tables. A one-minute cadence keeps cards current without making shared-host process counts a
// predictable idle-CPU regression.
const WORKSPACE_METADATA_REFRESH_MS = 60_000
const SIDEBAR_WIDTH_STORAGE_KEY = 'agent-workspace.sidebar.width'
const DEFAULT_SIDEBAR_WIDTH = 292
const MIN_SIDEBAR_WIDTH = 190
const MAX_SIDEBAR_WIDTH = 430

interface CachedWorkspaceRuntimeMetadata extends WorkspaceRuntimeMetadata {
  selectionKey: string
}
const MAX_WORKSPACE_NAME_CHARS = 128
const MAX_WORKSPACE_GROUP_NAME_CHARS = 80
const WORKSPACE_COLOR_PALETTE = [
  { label: messages.workspaceContextMenu.colors.blue, value: '#5B8DEF' },
  { label: messages.workspaceContextMenu.colors.violet, value: '#9B7EDE' },
  { label: messages.workspaceContextMenu.colors.green, value: '#48A868' },
  { label: messages.workspaceContextMenu.colors.amber, value: '#D08B32' },
  { label: messages.workspaceContextMenu.colors.rose, value: '#CF6679' }
] as const

interface ShellProps {
  workspace: WorkspaceSnapshot | null
}

export function WorkspaceShell({ workspace }: ShellProps): React.JSX.Element {
  const projection = useProjectionStore()
  const [createOpen, setCreateOpen] = useState(false)
  const [createMode, setCreateMode] = useState<'folder' | 'ssh'>('folder')
  const [sshWorkspaces, setSshWorkspaces] = useState(readSshWorkspaces)
  const [editingSshWorkspaceId, setEditingSshWorkspaceId] = useState<string | null>(null)
  useEffect(() => {
    const syncSshWorkspaces = (): void => setSshWorkspaces(readSshWorkspaces())
    window.addEventListener('storage', syncSshWorkspaces)
    return () => window.removeEventListener('storage', syncSshWorkspaces)
  }, [])
  const [windowMove, setWindowMove] = useState<WindowMoveDialogState | null>(null)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [preserveNotificationTargetFocus, setPreserveNotificationTargetFocus] = useState(false)
  const [notificationNavigationError, setNotificationNavigationError] = useState<string | null>(
    null
  )
  const [recentCommands, setRecentCommands] = useState<readonly string[]>([])
  const [, setWindowTopology] = useState<WindowListResult | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [publicActions, setPublicActions] = useState<readonly ActionDefinition[]>([])
  const [publicActionRegistryRevision, setPublicActionRegistryRevision] = useState(0)
  const [processTitles, setProcessTitles] = useState<Record<string, string>>({})
  const [workspaceRuntimeMetadata, setWorkspaceRuntimeMetadata] = useState<
    Record<string, CachedWorkspaceRuntimeMetadata>
  >({})
  const commandPaletteExecution = useRef(false)
  const mutationSequence = useRef(0)
  const shellRef = useRef<HTMLElement>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null)
  const windowMoveReturnFocusRef = useRef<HTMLElement | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const sidebarWidthRef = useRef(sidebarWidth)
  const updateSidebarWidth = (width: number, persist = false): void => {
    const next = clampSidebarWidth(width)
    sidebarWidthRef.current = next
    setSidebarWidth(next)
    if (persist) persistSidebarWidth(next)
  }

  const openSettings = useCallback(() => {
    const activeElement = document.activeElement
    settingsReturnFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : settingsTriggerRef.current
    projection.setSettingsOpen(true)
  }, [projection])

  const selectedPane = workspace?.panes.find((pane) => pane.id === workspace.selectedPaneId)
  const selectedTab = workspace?.tabs.find((tab) => tab.id === selectedPane?.selectedTabId)
  const selectedBrowserState =
    selectedTab?.content.kind === 'browser' ? selectedTab.content.state : null
  const metadataWorkspaceId = workspace?.id
  const multiWindowEnabled =
    projection.identity?.capabilities.includes('multi-window-v1') === true &&
    window.desktopBridge.listWindows !== undefined
  const publicActionsEnabled =
    projection.identity?.capabilities.includes('actions-v1') === true &&
    window.desktopBridge.listPublicActions !== undefined &&
    window.desktopBridge.invokePublicAction !== undefined
  const browserTabsEnabled = projection.identity?.capabilities.includes('tab.openBrowser') === true
  useEffect(() => {
    if (!publicActionsEnabled) {
      queueMicrotask(() => setPublicActions([]))
      return
    }
    let active = true
    void window.desktopBridge.listPublicActions!()
      .then(({ definitions }) => {
        if (active) setPublicActions(definitions)
      })
      .catch((error: unknown) => {
        if (!active) return
        setPublicActions([])
        setCommandError(
          error instanceof Error ? error.message : 'The public action registry is unavailable'
        )
      })
    return () => {
      active = false
    }
  }, [publicActionsEnabled, publicActionRegistryRevision])

  useEffect(() => {
    if (!publicActionsEnabled || !window.desktopBridge.onActionRegistryChanged) return
    return window.desktopBridge.onActionRegistryChanged(() => {
      setPublicActionRegistryRevision((revision) => revision + 1)
    })
  }, [publicActionsEnabled])

  const invokePublicAction = useCallback(
    async (
      definition: ActionDefinition,
      parameters: DesktopActionInvokeRequest['parameters'] = {}
    ): Promise<void> => {
      setCommandError(null)
      try {
        const invokeAction = window.desktopBridge.invokePublicAction?.bind(window.desktopBridge)
        if (!invokeAction) throw new Error('The public action service is unavailable')
        const invocation = await invokeAction({
          actionId: definition.actionId,
          actionVersion: definition.actionVersion,
          parameters
        })
        if (invocation.state !== 'acknowledged') {
          throw new Error(
            invocation.errorCode
              ? `The public action failed (${invocation.errorCode}).`
              : `The public action ended as ${invocation.state}.`
          )
        }
        await projection.refresh()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The public action failed'
        setCommandError(message)
        projection.reportMutationError(error)
        throw error
      }
    },
    [projection]
  )
  const invokePublicActionById = useCallback(
    async (
      actionId: string,
      parameters: DesktopActionInvokeRequest['parameters']
    ): Promise<boolean> => {
      if (!publicActionsEnabled) return false
      const definition = publicActions.find(
        (candidate) => candidate.actionId === actionId && candidate.actionVersion === 1
      )
      if (!definition) return false
      await invokePublicAction(definition, parameters)
      return true
    },
    [invokePublicAction, publicActions, publicActionsEnabled]
  )
  const refreshWindowTopology = useCallback(async (): Promise<WindowListResult | null> => {
    if (!window.desktopBridge.listWindows) return null
    const topology = await window.desktopBridge.listWindows()
    setWindowTopology(topology)
    return topology
  }, [])
  const freshWindowContext = useCallback(
    async (
      workspaceId: string | undefined
    ): Promise<{ topology: WindowListResult; current: WindowPlacementSnapshot }> => {
      const topology = await refreshWindowTopology()
      if (!topology) throw new Error('Multi-window topology is unavailable')
      const current = currentPlacement(topology, workspaceId)
      if (!current) throw new Error('Current window placement is unavailable')
      return { topology, current }
    },
    [refreshWindowTopology]
  )

  useEffect(() => {
    if (!multiWindowEnabled) return
    let active = true
    queueMicrotask(() => {
      if (active)
        void refreshWindowTopology().catch((error) => projection.reportMutationError(error))
    })
    return () => {
      active = false
    }
  }, [multiWindowEnabled, projection, refreshWindowTopology])

  useEffect(() => {
    if (!window.desktopBridge.onMultiWindowEvent) return
    return window.desktopBridge.onMultiWindowEvent(() => {
      void refreshWindowTopology().catch((error) => projection.reportMutationError(error))
    })
  }, [projection, refreshWindowTopology])
  const metadataWorkingDirectory = workspace?.workingDirectory
  const metadataSelectedTabId = selectedTab?.id
  const metadataRuntimeSessionId =
    selectedTab?.content.kind === 'terminal' ? selectedTab.content.runtimeSessionId : undefined
  const metadataSelectionKey = `${metadataSelectedTabId ?? ''}:${metadataRuntimeSessionId ?? ''}`

  const recordProcessTitle = useCallback((tabId: string, title: string): void => {
    setProcessTitles((current) => {
      if (!title) {
        if (!(tabId in current)) return current
        const next = { ...current }
        delete next[tabId]
        return next
      }
      return current[tabId] === title ? current : { ...current, [tabId]: title }
    })
  }, [])

  useEffect(() => {
    const getMetadata = window.desktopBridge.getWorkspaceRuntimeMetadata?.bind(window.desktopBridge)
    if (!metadataWorkspaceId || !getMetadata) return
    let disposed = false
    let pending = false
    let outputRefreshTimer: number | undefined
    const refresh = async (): Promise<void> => {
      if (pending) return
      pending = true
      let metadata: WorkspaceRuntimeMetadata
      try {
        metadata = await getMetadata({ workspaceId: metadataWorkspaceId })
      } catch {
        metadata = { gitBranch: null, gitStatus: null, listeningPorts: [] }
      } finally {
        pending = false
      }
      if (!disposed) {
        setWorkspaceRuntimeMetadata((current) =>
          current[metadataWorkspaceId]?.gitBranch === metadata.gitBranch &&
          gitStatusesEqual(current[metadataWorkspaceId]?.gitStatus, metadata.gitStatus) &&
          arraysEqual(current[metadataWorkspaceId]?.listeningPorts, metadata.listeningPorts) &&
          current[metadataWorkspaceId]?.selectionKey === metadataSelectionKey
            ? current
            : {
                ...current,
                [metadataWorkspaceId]: { ...metadata, selectionKey: metadataSelectionKey }
              }
        )
      }
    }
    void refresh()
    const timer = globalThis.setInterval(() => void refresh(), WORKSPACE_METADATA_REFRESH_MS)
    const removeTerminalListener = window.desktopBridge.onTerminalEvent?.((event) => {
      if (event.event !== 'terminal.output' || event.data.terminalId !== metadataRuntimeSessionId) {
        return
      }
      if (outputRefreshTimer !== undefined) globalThis.clearTimeout(outputRefreshTimer)
      outputRefreshTimer = globalThis.setTimeout(() => {
        outputRefreshTimer = undefined
        void refresh()
      }, 1_000)
    })
    return () => {
      disposed = true
      globalThis.clearInterval(timer)
      if (outputRefreshTimer !== undefined) globalThis.clearTimeout(outputRefreshTimer)
      removeTerminalListener?.()
    }
  }, [
    metadataRuntimeSessionId,
    metadataSelectionKey,
    metadataSelectedTabId,
    metadataWorkspaceId,
    metadataWorkingDirectory
  ])

  const runMutation = useCallback(
    async (operation: MutationOperation): Promise<boolean> => {
      const requestId = ++mutationSequence.current
      try {
        projection.applyMutation(await operation, requestId === mutationSequence.current)
        return true
      } catch (error) {
        if (requestId === mutationSequence.current) projection.reportMutationError(error)
        return false
      }
    },
    [projection]
  )

  const createSshWorkspace = async (
    name: string,
    directory: string,
    profile: SavedSshWorkspace
  ): Promise<boolean> => {
    let workspaceCreated = false
    try {
      saveSshWorkspaces(readSshWorkspaces())
      const before = new Set(useProjectionStore.getState().snapshot?.workspaces.map(({ id }) => id))
      const result = await window.desktopBridge.createWorkspace({
        name,
        workingDirectory: directory,
        initialTerminal: { ...terminalLaunch(directory), command: sshCommand(profile) }
      })
      projection.applyMutation(result)
      const created = result.snapshot.workspaces.find(({ id }) => !before.has(id))
      if (!created) throw new Error('The new SSH workspace could not be identified.')
      workspaceCreated = true
      const next = { ...readSshWorkspaces(), [created.id]: profile }
      saveSshWorkspaces(next)
      setSshWorkspaces(next)
      const organization = await window.desktopBridge.getWorkspaceOrganization?.()
      if (!organization || !window.desktopBridge.pinWorkspace) {
        throw new Error('SSH workspace created, but pinning is unavailable.')
      }
      projection.applyMutation(
        await window.desktopBridge.pinWorkspace({
          workspaceId: created.id,
          pinned: true,
          expectedRevision: organization.organization.revision,
          idempotencyKey: crypto.randomUUID()
        })
      )
      await projection.refreshOrganization()
      return true
    } catch (error) {
      projection.reportMutationError(error)
      return workspaceCreated
    }
  }

  const updateSshWorkspace = (workspaceId: string, profile: SavedSshWorkspace): boolean => {
    try {
      const next = { ...readSshWorkspaces(), [workspaceId]: profile }
      saveSshWorkspaces(next)
      setSshWorkspaces(next)
      return true
    } catch (error) {
      projection.reportMutationError(error)
      return false
    }
  }

  const forgetSshWorkspace = (workspaceId: string): void => {
    if (
      !window.confirm(
        'Forget the saved SSH connection? The workspace and its open tabs stay available.'
      )
    ) {
      return
    }
    try {
      const next = { ...readSshWorkspaces() }
      delete next[workspaceId]
      saveSshWorkspaces(next)
      setSshWorkspaces(next)
    } catch (error) {
      projection.reportMutationError(error)
    }
  }

  const jumpNotification = useCallback(
    async (notification: NotificationSnapshot): Promise<void> => {
      setPreserveNotificationTargetFocus(true)
      setNotificationsOpen(false)
      const result = await runAfterNotificationCenterClose(
        () =>
          jumpToNotification(notification, {
            getSnapshot: () => useProjectionStore.getState().snapshot,
            applyMutation: (mutation) => projection.applyMutation(mutation),
            selectWorkspace: (params) => window.desktopBridge.selectWorkspace(params),
            focusPane: (params) => window.desktopBridge.focusPane(params),
            selectTab: (params) => window.desktopBridge.selectTab(params),
            waitUntilVisible: waitForVisibleTarget,
            markRead: (notificationId) => projection.markNotificationRead({ notificationId })
          }),
        ({ message }) => {
          setPreserveNotificationTargetFocus(false)
          setNotificationNavigationError(message)
          setNotificationsOpen(true)
        }
      )
      if (!result.ok) return
      setNotificationNavigationError(null)
      setPreserveNotificationTargetFocus(false)
    },
    [projection]
  )

  const openWorkspaceAttention = useCallback(
    async (attention: WorkspaceAttentionSnapshot): Promise<void> => {
      try {
        let snapshot = useProjectionStore.getState().snapshot
        if (snapshot?.selectedWorkspaceId !== attention.workspaceId) {
          const result = await window.desktopBridge.selectWorkspace({
            workspaceId: attention.workspaceId
          })
          projection.applyMutation(result)
          snapshot = result.snapshot
        }
        if (attention.paneId) {
          const workspace = snapshot?.workspaces.find(({ id }) => id === attention.workspaceId)
          if (!workspace) throw new Error('attention target unavailable')
          if (workspace.selectedPaneId !== attention.paneId) {
            const result = await window.desktopBridge.focusPane({
              workspaceId: attention.workspaceId,
              paneId: attention.paneId
            })
            projection.applyMutation(result)
            snapshot = result.snapshot
          }
        }
        if (attention.tabId) {
          const workspace = snapshot?.workspaces.find(({ id }) => id === attention.workspaceId)
          const pane = workspace?.panes.find(({ id }) => id === attention.paneId)
          if (!pane) throw new Error('attention target unavailable')
          if (pane.selectedTabId !== attention.tabId) {
            const result = await window.desktopBridge.selectTab({
              workspaceId: attention.workspaceId,
              tabId: attention.tabId
            })
            projection.applyMutation(result)
          }
        }
        const visible = await waitForVisibleTarget({
          workspaceId: attention.workspaceId,
          ...(attention.paneId ? { paneId: attention.paneId } : {}),
          ...(attention.tabId ? { tabId: attention.tabId } : {})
        })
        if (!visible) throw new Error('attention target not visible')
        if (attention.notificationId) {
          await projection.acknowledgeAttention({
            notificationId: attention.notificationId,
            expectedRevision: attention.revision,
            idempotencyKey: crypto.randomUUID(),
            mode: 'focused'
          })
        }
      } catch (error) {
        projection.reportMutationError(error)
      }
    },
    [projection]
  )

  const openAgentSession = useCallback(
    async (binding: AgentSessionBinding): Promise<void> => {
      try {
        await navigateToAgentBinding(binding, {
          getSelectedWorkspaceId: () => useProjectionStore.getState().snapshot?.selectedWorkspaceId,
          selectWorkspace: (params) => window.desktopBridge.selectWorkspace(params),
          focusPane: (params) => window.desktopBridge.focusPane(params),
          selectTab: (params) => window.desktopBridge.selectTab(params),
          applyMutation: (result) => projection.applyMutation(result),
          waitUntilVisible: waitForVisibleTarget
        })
      } catch (error) {
        projection.reportMutationError(error)
      }
    },
    [projection]
  )

  const invoke = useCallback(
    async (commandId: CommandId): Promise<void> => {
      if (commandId === 'sidebar.toggle') {
        projection.toggleSidebar()
        return
      }
      if (commandId === 'commandPalette.toggle') {
        // Opening must never be swallowed by an in-flight execution: the guard
        // only protects against concurrent command execution, not against the
        // user asking for the palette while a slow command finishes.
        projection.setPaletteOpen(!projection.paletteOpen)
        return
      }
      if (commandId === 'settings.open') {
        openSettings()
        return
      }
      if (commandId === 'notifications.toggle') {
        setNotificationNavigationError(null)
        setNotificationsOpen((open) => !open)
        return
      }
      if (commandId === 'notifications.latestUnread') {
        try {
          const latest = await projection.latestUnreadNotification()
          if (latest) await jumpNotification(latest)
          else setNotificationsOpen(true)
        } catch (error) {
          projection.reportMutationError(error)
        }
        return
      }
      if (commandId === 'workspace.new') {
        setCreateMode('folder')
        setCreateOpen(true)
        return
      }
      if (commandId.startsWith('window.') || commandId.startsWith('focusHistory.')) {
        const { topology, current } = await freshWindowContext(workspace?.id)
        const mutation = multiWindowMutation(topology)
        if (commandId === 'window.new') {
          if (!workspace || !window.desktopBridge.createWindow) return
          await window.desktopBridge.createWindow({
            mutation,
            label: 'Workspace window',
            workspaceId: workspace.id,
            sourceWindow: { windowId: current.windowId, expectedRevision: current.revision }
          })
        } else if (commandId === 'window.close') {
          if (!window.desktopBridge.closeWindow) return
          const target = topology.windows.find(({ windowId }) => windowId !== current.windowId)
          if (!target) throw new Error('The last workspace window cannot be closed here')
          await window.desktopBridge.closeWindow({
            mutation,
            window: { windowId: current.windowId, expectedRevision: current.revision },
            policy: 'rehome',
            rehomeTarget: { windowId: target.windowId, expectedRevision: target.revision }
          } as unknown as WindowCloseParams)
        } else if (commandId === 'window.focusNext') {
          if (!window.desktopBridge.focusWindow) return
          const index = topology.windows.findIndex(({ windowId }) => windowId === current.windowId)
          const target = topology.windows[(index + 1) % topology.windows.length]
          if (target)
            await window.desktopBridge.focusWindow({
              mutation,
              window: { windowId: target.windowId, expectedRevision: target.revision }
            })
        } else if (window.desktopBridge.navigateFocusHistory) {
          const navigation = await window.desktopBridge.navigateFocusHistory({
            mutation,
            direction: commandId === 'focusHistory.back' ? 'back' : 'forward'
          })
          if (!topology.windows.some(({ windowId }) => windowId === navigation.target.windowId)) {
            throw new Error('Focus-history target is unavailable')
          }
        }
        await refreshWindowTopology()
        await projection.refresh()
        return
      }
      if (!workspace || !selectedPane) return
      if (commandId.startsWith('tab.') && commandId !== 'tab.close' && multiWindowEnabled) {
        if (commandId === 'tab.reopen') {
          const closed = await window.desktopBridge.listClosedItems?.()
          const item = closed?.items.find(
            ({ itemKind, restored }) => itemKind === 'tab' && !restored
          )
          if (!item || !window.desktopBridge.reopenTab)
            throw new Error('No closed tab is available')
          const { topology, current } = await freshWindowContext(workspace.id)
          await window.desktopBridge.reopenTab({
            mutation: multiWindowMutation(topology),
            closedItemId: item.closedItemId,
            target: exactPlacement(current, workspace, selectedPane)
          })
        } else {
          if (!selectedTab) return
          const { topology, current } = await freshWindowContext(workspace.id)
          const source = {
            windowId: current.windowId,
            workspaceId: workspace.id,
            paneId: selectedPane.id,
            tabId: selectedTab.id,
            expectedWindowRevision: current.revision
          }
          if (commandId === 'tab.duplicate' && window.desktopBridge.duplicateTab) {
            await window.desktopBridge.duplicateTab({
              mutation: multiWindowMutation(topology),
              source,
              target: exactPlacement(current, workspace, selectedPane)
            })
          } else if (commandId === 'tab.detach' && window.desktopBridge.detachTab) {
            await window.desktopBridge.detachTab({
              mutation: multiWindowMutation(topology),
              source,
              windowLabel: 'Detached tab'
            })
          } else if (commandId === 'tab.moveToWindow') {
            windowMoveReturnFocusRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null
            setWindowMove({ topology, source })
            return
          }
        }
        await refreshWindowTopology()
        await projection.refresh()
        return
      }
      if (commandId === 'terminal.new') {
        await runMutation(
          window.desktopBridge.openTerminalTab({
            workspaceId: workspace.id,
            paneId: selectedPane.id,
            launch: terminalLaunch(workspace.workingDirectory)
          })
        )
        return
      }
      if (commandId === 'tab.close' && selectedTab) {
        if (multiWindowEnabled && window.desktopBridge.closeTabAdvanced) {
          const { topology, current } = await freshWindowContext(workspace.id)
          await window.desktopBridge.closeTabAdvanced({
            mutation: multiWindowMutation(topology),
            source: {
              windowId: current.windowId,
              workspaceId: workspace.id,
              paneId: selectedPane.id,
              tabId: selectedTab.id,
              expectedWindowRevision: current.revision
            }
          })
          await refreshWindowTopology()
          await projection.refresh()
          return
        }
        await runMutation(
          window.desktopBridge.closeTab({ workspaceId: workspace.id, tabId: selectedTab.id })
        )
        return
      }
      if (commandId === 'pane.splitRight' || commandId === 'pane.splitDown') {
        await splitWithTerminal(
          workspace,
          selectedPane.id,
          commandId === 'pane.splitRight' ? 'horizontal' : 'vertical',
          runMutation
        )
        return
      }
      if (commandId === 'browser.openSplit') {
        await splitWithBrowser(workspace, selectedPane.id, runMutation)
        return
      }
      if (selectedBrowserState) {
        const bridge = browserBridge(window.desktopBridge)
        const params = browserCommandParams(selectedBrowserState)
        if (commandId === 'browser.back') await runMutation(bridge.browserBack(params))
        else if (commandId === 'browser.forward') await runMutation(bridge.browserForward(params))
        else if (commandId === 'browser.reload') await runMutation(bridge.reloadBrowser(params))
        else if (commandId === 'browser.stop') await runMutation(bridge.stopBrowser(params))
        else if (commandId === 'browser.openDevTools')
          await runMutation(bridge.openBrowserDevTools(params))
        if (commandId.startsWith('browser.')) return
      }
      if (commandId === 'terminal.search') {
        Array.from(document.querySelectorAll<HTMLInputElement>('[aria-label]'))
          .find(
            (element) => element.getAttribute('aria-label') === messages.terminalPane.search.label
          )
          ?.focus()
      }
    },
    [
      jumpNotification,
      openSettings,
      projection,
      freshWindowContext,
      multiWindowEnabled,
      refreshWindowTopology,
      runMutation,
      selectedBrowserState,
      selectedPane,
      selectedTab,
      workspace
    ]
  )

  const commandContext = useMemo<CommandContext>(
    () => ({
      invoke: async (commandId) => {
        setCommandError(null)
        try {
          await invoke(commandId)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The command failed'
          setCommandError(message)
          projection.reportMutationError(error)
          await Promise.allSettled([refreshWindowTopology(), projection.refresh()])
        }
      },
      capabilities: projection.identity?.capabilities ?? [],
      browser: selectedBrowserState
        ? {
            canBack: selectedBrowserState.canBack,
            canForward: selectedBrowserState.canForward,
            loading: selectedBrowserState.loading
          }
        : null,
      selection: {
        workspace: workspace !== null,
        pane: selectedPane !== undefined,
        tab: selectedTab !== undefined,
        terminal: selectedTab?.content.kind === 'terminal'
      }
    }),
    [
      invoke,
      projection,
      refreshWindowTopology,
      selectedBrowserState,
      selectedPane,
      selectedTab,
      workspace
    ]
  )
  const overrides = useMemo(
    () => shortcutOverrides(projection.settings?.shortcuts ?? []),
    [projection.settings]
  )
  const platform: ShortcutPlatform = navigator.platform.toLowerCase().includes('mac')
    ? 'macos'
    : 'other'
  const publicCommandEntries = useMemo(
    () => publicActionCommands(publicActionsEnabled ? publicActions : [], invokePublicAction),
    [invokePublicAction, publicActions, publicActionsEnabled]
  )
  const shortcutConflicts = useMemo(
    () =>
      findShortcutConflicts(
        [...DEFAULT_COMMANDS, ...publicCommandEntries.map(({ command }) => command)],
        overrides,
        platform
      ),
    [overrides, platform, publicCommandEntries]
  )
  const publicShortcutConflictMessage = useMemo(() => {
    const conflicts = shortcutConflicts.filter(({ commandIds }) =>
      commandIds.some((commandId) => commandId.toString().startsWith('public-action:'))
    )
    if (conflicts.length === 0) return null
    return `Public action shortcut conflict: ${conflicts
      .map(({ commandIds }) => commandIds.join(' and '))
      .join('; ')}. Conflicting public shortcuts are disabled.`
  }, [shortcutConflicts])
  const shortcutCommandRegistry = useMemo(() => {
    const candidates = [...DEFAULT_COMMANDS, ...publicCommandEntries.map(({ command }) => command)]
    const conflicted = new Set(shortcutConflicts.flatMap(({ commandIds }) => commandIds))
    return new CommandRegistry(
      candidates.map((command) =>
        command.id.toString().startsWith('public-action:') && conflicted.has(command.id)
          ? withoutDefaultShortcut(command)
          : command
      )
    )
  }, [publicCommandEntries, shortcutConflicts])
  const commandTooltip = (commandId: CommandId, label: string): string => {
    const command = defaultCommandRegistry.get(commandId)
    if (!command) return label
    const shortcut = effectiveShortcut(command, overrides)
    return shortcut ? `${label} · ${formatShortcut(shortcut, platform)}` : label
  }
  const commandContextRef = useRef(commandContext)

  useEffect(() => {
    commandContextRef.current = commandContext
  }, [commandContext])

  useEffect(() => {
    setShortcutCapture(shortcutCommandRegistry, overrides, platform)
    return () => {
      clearShortcutCapture()
    }
  }, [overrides, platform, shortcutCommandRegistry])

  useEffect(
    () =>
      bindApplicationMenuCommands(
        window.desktopBridge,
        () => commandContextRef.current,
        (commandId) =>
          setRecentCommands((current) =>
            [commandId, ...current.filter((id) => id !== commandId)].slice(0, 8)
          )
      ),
    []
  )

  useEffect(() => {
    if (!window.desktopBridge.setApplicationMenuState) return
    void window.desktopBridge
      .setApplicationMenuState(
        buildApplicationMenuState(defaultCommandRegistry, commandContext, overrides, platform)
      )
      .catch(() => undefined)
  }, [commandContext, overrides, platform])

  useEffect(
    () => () => {
      void window.desktopBridge.setApplicationMenuState?.({ commands: [] }).catch(() => undefined)
    },
    []
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      void dispatchKeyboardCommand(
        event,
        shortcutCommandRegistry,
        commandContext,
        overrides,
        platform
      ).then((result) => {
        if (result.status === 'matched' && result.execution.status === 'executed') {
          setRecentCommands((current) =>
            [result.commandId, ...current.filter((id) => id !== result.commandId)].slice(0, 8)
          )
        }
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commandContext, overrides, platform, shortcutCommandRegistry])

  return (
    <main
      className={projection.sidebarOpen ? 'workspace-shell' : 'workspace-shell sidebar-collapsed'}
      ref={shellRef}
      style={{ '--sidebar-width': `${String(sidebarWidth)}px` } as React.CSSProperties}
    >
      <header className="titlebar">
        <span className="mark" aria-hidden="true" />
        <span className="app-title">{messages.workspaceShell.titlebar.applicationTitle}</span>
        <span className="workspace-title">
          {workspace?.name ?? messages.workspaceShell.titlebar.noWorkspaceSelected}
        </span>
        <div className="titlebar-actions">
          <IconButton
            aria-label={messages.workspaceShell.titlebar.toggleSidebar}
            onClick={() => projection.toggleSidebar()}
            tooltip={commandTooltip(
              'sidebar.toggle',
              messages.workspaceShell.titlebar.toggleSidebar
            )}
          >
            {projection.sidebarOpen ? <ChevronsLeft size={14} /> : <PanelLeft size={14} />}
          </IconButton>
          <IconButton
            aria-label={messages.workspaceShell.titlebar.openCommandPalette}
            onClick={() => projection.setPaletteOpen(true)}
            tooltip={commandTooltip(
              'commandPalette.toggle',
              messages.workspaceShell.titlebar.openCommandPalette
            )}
          >
            <Command size={14} />
          </IconButton>
          <IconButton
            aria-label={messages.workspaceShell.titlebar.openNotifications(
              projection.snapshot?.attention.unreadCount ?? 0
            )}
            className="notification-trigger"
            onClick={() => {
              setNotificationNavigationError(null)
              setNotificationsOpen(true)
            }}
            tooltip={commandTooltip(
              'notifications.toggle',
              messages.workspaceShell.titlebar.notifications
            )}
          >
            <Bell size={14} />
            <AttentionBadge
              attention={projection.snapshot?.attention ?? EMPTY_ATTENTION}
              compact
              label={messages.workspaceShell.titlebar.notifications}
            />
          </IconButton>
          <IconButton
            aria-label={messages.workspaceShell.titlebar.openSettings}
            onClick={openSettings}
            ref={settingsTriggerRef}
            tooltip={commandTooltip('settings.open', messages.workspaceShell.titlebar.openSettings)}
          >
            <Settings size={14} />
          </IconButton>
          <span className="service-version">
            {messages.workspaceShell.titlebar.version(
              projection.identity
                ? String(projection.identity.protocolVersion)
                : messages.workspaceShell.titlebar.unavailableVersion,
              projection.identity?.version ?? messages.workspaceShell.titlebar.unavailableVersion
            )}
          </span>
        </div>
      </header>

      {projection.mutationError ? (
        <div className="mutation-error" role="alert">
          <span>
            <strong>{messages.workspaceShell.mutation.notSaved}</strong> {projection.mutationError}{' '}
            {messages.workspaceShell.mutation.tryAgain}
          </span>
          <button onClick={() => projection.clearMutationError()} type="button">
            {messages.workspaceShell.mutation.dismiss}
          </button>
        </div>
      ) : null}

      {commandError ? (
        <div aria-live="assertive" className="mutation-error" role="alert">
          <span>{commandError}</span>
          <button onClick={() => setCommandError(null)} type="button">
            {messages.workspaceShell.mutation.dismiss}
          </button>
        </div>
      ) : null}

      {publicShortcutConflictMessage ? (
        <div aria-live="polite" className="mutation-error" role="status">
          <span>{publicShortcutConflictMessage}</span>
        </div>
      ) : null}

      {projection.sidebarOpen ? (
        <WorkspaceSidebar
          attention={projection.attention}
          cardSlots={projection.cardSlots}
          cardSlotsV2={projection.cardSlotsV2}
          metadata={workspaceRuntimeMetadata}
          onCreate={() => {
            setCreateMode('folder')
            setCreateOpen(true)
          }}
          onCreateSsh={() => {
            setCreateMode('ssh')
            setCreateOpen(true)
          }}
          onEditSsh={setEditingSshWorkspaceId}
          onForgetSsh={forgetSshWorkspace}
          onMutation={runMutation}
          onLayoutMutation={(operation) => {
            void operation
              .then(async () => projection.refresh())
              .catch((error: unknown) => projection.reportMutationError(error))
          }}
          onPublicAction={invokePublicActionById}
          onOpenAttention={openWorkspaceAttention}
          processTitles={processTitles}
          organization={projection.organization}
          savedLayouts={projection.savedLayouts}
          sshWorkspaces={sshWorkspaces}
          shortcutLabel={commandShortcutLabel('workspace.new', overrides, platform)}
          selectedWorkspaceId={projection.snapshot?.selectedWorkspaceId ?? null}
          workspaces={projection.snapshot?.workspaces ?? []}
        />
      ) : null}
      {projection.sidebarOpen ? (
        <div
          aria-label="Resize workspace sidebar"
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className="sidebar-resize-handle"
          onDoubleClick={() => {
            updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH, true)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const direction = event.key === 'ArrowRight' ? 12 : -12
            updateSidebarWidth(sidebarWidthRef.current + direction, true)
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.dataset.resizing = 'true'
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.dataset.resizing !== 'true') return
            const shellLeft = shellRef.current?.getBoundingClientRect().left ?? 0
            updateSidebarWidth(event.clientX - shellLeft)
          }}
          onPointerUp={(event) => {
            delete event.currentTarget.dataset.resizing
            event.currentTarget.releasePointerCapture(event.pointerId)
            persistSidebarWidth(sidebarWidthRef.current)
          }}
          role="separator"
          tabIndex={0}
        />
      ) : null}

      <section
        aria-label={messages.workspaceShell.contentLabel}
        className="workspace-content"
        data-selected={workspace ? 'true' : 'false'}
        data-workspace-content-id={workspace?.id}
        tabIndex={-1}
      >
        {workspace ? (
          <PaneWorkspace
            browserTabsEnabled={browserTabsEnabled}
            browserViewsVisible={
              !createOpen &&
              !notificationsOpen &&
              !windowMove &&
              !projection.paletteOpen &&
              !projection.settingsOpen
            }
            onMutation={runMutation}
            onProcessTitleChange={recordProcessTitle}
            workspace={workspace}
          />
        ) : (
          <EmptyWorkspace
            onCreate={() => {
              setCreateMode('folder')
              setCreateOpen(true)
            }}
          />
        )}
      </section>
      <CreateWorkspaceDialog
        fallbackDirectory={workspace?.workingDirectory ?? '/'}
        mode={createMode}
        onCreated={runMutation}
        onCreateSsh={createSshWorkspace}
        onForgetSsh={forgetSshWorkspace}
        onOpenChange={setCreateOpen}
        open={createOpen}
        savedSshWorkspaces={sshWorkspaces}
        workspaceIds={projection.snapshot?.workspaces.map(({ id }) => id) ?? []}
      />
      <EditSshWorkspaceDialog
        key={editingSshWorkspaceId ?? 'closed'}
        onOpenChange={(open) => {
          if (!open) setEditingSshWorkspaceId(null)
        }}
        onSave={updateSshWorkspace}
        open={editingSshWorkspaceId !== null}
        profile={editingSshWorkspaceId ? sshWorkspaces[editingSshWorkspaceId] : undefined}
        workspaceId={editingSshWorkspaceId}
      />
      <MoveTabToWindowDialog
        getFreshTopology={refreshWindowTopology}
        key={windowMove?.source.tabId ?? 'closed'}
        onMoved={async (operation) => {
          try {
            await operation
            setWindowMove(null)
            requestAnimationFrame(() => windowMoveReturnFocusRef.current?.focus())
            await refreshWindowTopology()
            await projection.refresh()
          } catch (error) {
            // Close the modal so its focus-restoration path runs and the existing
            // assertive command alert is exposed rather than trapped behind it.
            setWindowMove(null)
            requestAnimationFrame(() => windowMoveReturnFocusRef.current?.focus())
            const message = error instanceof Error ? error.message : 'The command failed'
            setCommandError(message)
            projection.reportMutationError(error)
            await Promise.allSettled([refreshWindowTopology(), projection.refresh()])
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setWindowMove(null)
            requestAnimationFrame(() => windowMoveReturnFocusRef.current?.focus())
          }
        }}
        request={windowMove}
      />
      <CommandPalette
        context={commandContext}
        executionGuardRef={commandPaletteExecution}
        onExecuted={(commandId) => {
          setRecentCommands((current) =>
            [commandId, ...current.filter((id) => id !== commandId)].slice(0, 8)
          )
        }}
        key={projection.paletteOpen ? 'palette-open' : 'palette-closed'}
        onOpenChange={(open) => projection.setPaletteOpen(open)}
        open={projection.paletteOpen}
        publicActions={publicActionsEnabled ? publicActions : []}
        onInvokePublicAction={invokePublicAction}
        recentCommandIds={recentCommands}
      />
      <SettingsDialog
        agentSessionsEnabled={
          projection.identity?.capabilities.includes('agent-sessions-v1') ?? false
        }
        agentWorkspaceContext={
          workspace && selectedPane && selectedTab
            ? {
                workspaceId: workspace.id,
                paneId: selectedPane.id,
                tabId: selectedTab.id,
                workingDirectory: workspace.workingDirectory
              }
            : null
        }
        configurationV2={projection.identity?.capabilities.includes('configuration-v2') ?? false}
        remoteSessionsEnabled={
          projection.identity?.capabilities.includes('remote-sessions-v1') ?? false
        }
        remoteWorkspaceContext={
          workspace && selectedPane && selectedTab
            ? {
                workspaceId: workspace.id,
                paneId: selectedPane.id,
                tabId: selectedTab.id
              }
            : null
        }
        onAgentNavigate={openAgentSession}
        onMutation={async (operation) => {
          const succeeded = await runMutation(operation)
          if (!succeeded) return false
          await projection.refresh()
          return true
        }}
        key={projection.settingsOpen ? 'settings-open' : 'settings-closed'}
        onOpenChange={(open) => {
          projection.setSettingsOpen(open)
          if (!open) {
            globalThis.requestAnimationFrame(() => {
              const requestedReturnFocus = settingsReturnFocusRef.current
              const returnFocus = requestedReturnFocus?.isConnected
                ? requestedReturnFocus
                : settingsTriggerRef.current
              returnFocus?.focus()
            })
          }
        }}
        open={projection.settingsOpen}
        shortcuts={projection.settings?.shortcuts ?? []}
      />
      <NotificationCenter
        error={notificationNavigationError}
        historyLoading={projection.notificationHistoryLoading}
        notifications={projection.notifications?.notifications ?? []}
        onError={(error) => projection.reportMutationError(error)}
        onClearAll={() => projection.clearNotifications({ scope: { kind: 'all' } })}
        onClearNotification={(notificationId) =>
          projection.clearNotifications({ scope: { kind: 'notification', notificationId } })
        }
        onClearRead={() => projection.clearNotifications({ scope: { kind: 'read' } })}
        onJump={jumpNotification}
        onLoadMore={() => projection.loadMoreNotifications()}
        onMarkRead={(notificationId) => projection.markNotificationRead({ notificationId })}
        onMarkUnread={(notificationId) => projection.markNotificationUnread({ notificationId })}
        onOpenChange={setNotificationsOpen}
        open={notificationsOpen}
        preserveTargetFocusOnClose={preserveNotificationTargetFocus}
        snapshot={projection.snapshot}
        total={projection.notifications?.total ?? 0}
        unreadCount={projection.notifications?.unreadCount ?? 0}
      />
      <NotificationToasts notifications={projection.recentNotificationEvents} />
    </main>
  )
}

function withoutDefaultShortcut(command: CommandDefinition): CommandDefinition {
  const { defaultShortcut, ...withoutShortcut } = command
  void defaultShortcut
  return withoutShortcut
}

const EMPTY_ATTENTION = { unreadCount: 0, highestLevel: null, latestUnread: null } as const
type MutationOperation = Promise<MutationResult>

interface MutationOwner {
  onMutation: (operation: MutationOperation) => Promise<boolean>
}

function clampSidebarWidth(width: number): number {
  return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width)))
}

function readSidebarWidth(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? clampSidebarWidth(value) : DEFAULT_SIDEBAR_WIDTH
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

function persistSidebarWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // Persistence is an enhancement; resizing must continue when storage is unavailable.
  }
}

function commandShortcutLabel(
  commandId: CommandId,
  overrides: ShortcutOverrides,
  platform: ShortcutPlatform
): string | null {
  const command = defaultCommandRegistry.get(commandId)
  if (!command) return null
  const shortcut = effectiveShortcut(command, overrides)
  return shortcut ? formatShortcut(shortcut, platform) : null
}

function terminalLaunch(cwd: string) {
  return { cwd, rows: DEFAULT_ROWS, cols: DEFAULT_COLS }
}

async function splitWithTerminal(
  workspace: WorkspaceSnapshot,
  targetPaneId: string,
  axis: 'horizontal' | 'vertical',
  mutate: (operation: MutationOperation) => Promise<boolean>
): Promise<void> {
  await mutate(
    window.desktopBridge.splitPane({
      workspaceId: workspace.id,
      targetPaneId,
      axis,
      ratio: 0.5,
      placement: 'after',
      content: { kind: 'newTerminal', launch: terminalLaunch(workspace.workingDirectory) }
    })
  )
}

async function splitWithBrowser(
  workspace: WorkspaceSnapshot,
  targetPaneId: string,
  mutate: (operation: MutationOperation) => Promise<boolean>
): Promise<void> {
  await mutate(
    window.desktopBridge.splitPane({
      workspaceId: workspace.id,
      targetPaneId,
      axis: 'horizontal',
      ratio: 0.5,
      placement: 'after',
      content: {
        kind: 'newBrowser',
        url: messages.workspaceShell.defaultBrowserUrl
      }
    })
  )
}

function WorkspaceSidebar({
  attention,
  cardSlots,
  cardSlotsV2,
  metadata,
  onCreate,
  onCreateSsh,
  onEditSsh,
  onForgetSsh,
  onMutation,
  onLayoutMutation,
  onOpenAttention,
  onPublicAction,
  organization,
  processTitles,
  savedLayouts,
  sshWorkspaces,
  shortcutLabel,
  selectedWorkspaceId,
  workspaces
}: MutationOwner & {
  attention: Readonly<Record<string, WorkspaceAttentionSnapshot>>
  cardSlots: Readonly<Record<string, WorkspaceCardSlotsSnapshot>>
  cardSlotsV2: WorkspaceCardSlotsV2Projection
  metadata: Readonly<Record<string, CachedWorkspaceRuntimeMetadata>>
  onCreate: () => void
  onCreateSsh: () => void
  onEditSsh: (workspaceId: string) => void
  onForgetSsh: (workspaceId: string) => void
  onOpenAttention: (attention: WorkspaceAttentionSnapshot) => Promise<void>
  onLayoutMutation: (operation: Promise<unknown>) => void
  onPublicAction: (
    actionId: string,
    parameters: DesktopActionInvokeRequest['parameters']
  ) => Promise<boolean>
  organization: WorkspaceOrganizationSnapshot | null
  processTitles: Readonly<Record<string, string>>
  savedLayouts: LayoutListResult | null
  sshWorkspaces: Readonly<Record<string, SavedSshWorkspace>>
  shortcutLabel: string | null
  selectedWorkspaceId: string | null
  workspaces: readonly WorkspaceSnapshot[]
}): React.JSX.Element {
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const organizationEnabled = organization !== null && !!window.desktopBridge.selectWorkspaces
  const canonicalIds = useMemo(() => workspaces.map(({ id }) => id), [workspaces])
  const sections = useMemo(
    () =>
      organization
        ? workspacePresentationSections(canonicalIds, organization)
        : [
            {
              id: 'legacy',
              kind: 'ungrouped' as const,
              name: null,
              collapsed: false,
              workspaceIds: canonicalIds
            }
          ],
    [canonicalIds, organization]
  )
  const presentationIds = useMemo(
    () => sections.flatMap(({ workspaceIds }) => workspaceIds),
    [sections]
  )
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace] as const)),
    [workspaces]
  )
  const groupWorkspaceCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (!organization) return counts
    const existing = new Set(canonicalIds)
    for (const { workspaceId, groupId } of organization.assignments) {
      if (!existing.has(workspaceId)) continue
      counts.set(groupId, (counts.get(groupId) ?? 0) + 1)
    }
    return counts
  }, [organization, canonicalIds])
  const selectedIds = organizationEnabled
    ? new Set(organization.selection)
    : new Set(selectedWorkspaceId ? [selectedWorkspaceId] : [])
  const focusedWorkspaceId = organizationEnabled
    ? organization.focusedWorkspaceId
    : selectedWorkspaceId
  const batchCloseReplacement = organizationEnabled
    ? workspaceBatchCloseReplacement(workspaces, organization)
    : undefined
  const hasFocusedWorkspace = presentationIds.includes(focusedWorkspaceId ?? '')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const onDragEnd = (event: DragEndEvent): void => {
    if (!event.over || event.active.id === event.over.id) return
    const oldIndex = canonicalIds.indexOf(String(event.active.id))
    const overIndex = canonicalIds.indexOf(String(event.over.id))
    if (oldIndex < 0 || overIndex < 0) return
    const destinationIndex = arrayMove([...canonicalIds], oldIndex, overIndex).indexOf(
      String(event.active.id)
    )
    if (organizationEnabled && window.desktopBridge.reorderWorkspace) {
      void onMutation(
        window.desktopBridge.reorderWorkspace({
          workspaceId: String(event.active.id),
          destinationIndex,
          expectedRevision: organization.revision,
          idempotencyKey: globalThis.crypto.randomUUID()
        })
      )
      return
    }
    void onMutation(
      window.desktopBridge.moveWorkspace({ workspaceId: String(event.active.id), destinationIndex })
    )
  }

  const selectWorkspace = (workspaceId: string, modifiers: SelectionModifiers): void => {
    if (organizationEnabled && window.desktopBridge.selectWorkspaces) {
      const replacement = workspaceSelectionReplacement(
        canonicalIds,
        organization,
        workspaceId,
        modifiers
      )
      if (!replacement) return
      void onMutation(
        window.desktopBridge.selectWorkspaces({
          ...replacement,
          expectedRevision: organization.revision,
          idempotencyKey: globalThis.crypto.randomUUID()
        })
      )
      return
    }
    if (workspaceId !== selectedWorkspaceId) {
      void onMutation(window.desktopBridge.selectWorkspace({ workspaceId }))
    }
  }

  const createGroup = async (name: string): Promise<boolean> => {
    if (!organization || !window.desktopBridge.createGroup) return false
    return onMutation(
      window.desktopBridge.createGroup({
        groupId: globalThis.crypto.randomUUID(),
        name,
        expectedRevision: organization.revision,
        idempotencyKey: globalThis.crypto.randomUUID()
      })
    )
  }

  return (
    <aside className="workspace-sidebar" aria-label={messages.workspaceShell.sidebar.label}>
      <div className="sidebar-heading">
        <span>{messages.workspaceShell.sidebar.label}</span>
        {organizationEnabled ? (
          <button
            aria-label="Create workspace group"
            className="sidebar-heading-action"
            data-workspace-action={workspaceCardActionRegistry.resolve('groupCreate').actionId}
            disabled={!organization}
            onClick={() => setCreateGroupOpen(true)}
            type="button"
          >
            <Layers aria-hidden="true" size={13} />
            <span>New group</span>
          </button>
        ) : null}
      </div>
      <Button
        aria-label={messages.workspaceShell.sidebar.createWorkspace}
        className="sidebar-open-folder"
        disabled={!!organization?.legacyOverLimit}
        onClick={onCreate}
        title={
          organization?.legacyOverLimit
            ? 'Close workspaces, panes, or tabs until the legacy counts are within limits.'
            : undefined
        }
      >
        <FolderOpen size={14} />
        <span>{messages.workspaceShell.sidebar.openFolder}</span>
        {shortcutLabel ? <kbd>{shortcutLabel}</kbd> : null}
      </Button>
      <Button
        aria-label="Create SSH workspace"
        className="sidebar-open-folder sidebar-open-ssh"
        disabled={!!organization?.legacyOverLimit}
        onClick={onCreateSsh}
      >
        <TerminalSquare size={14} />
        <span>SSH workspace</span>
      </Button>
      {organization?.legacyOverLimit ? (
        <LegacyOverLimitNotice
          legacy={organization.legacyOverLimit}
          {...(savedLayouts
            ? {
                onReviewExports: () => {
                  document.getElementById('saved-layouts-panel')?.focus()
                }
              }
            : {})}
        />
      ) : null}
      {savedLayouts ? (
        <SavedLayoutsPanel
          legacyOverLimit={!!organization?.legacyOverLimit}
          onLayoutMutation={onLayoutMutation}
          organization={organization}
          savedLayouts={savedLayouts}
          selectedWorkspaceId={selectedWorkspaceId}
        />
      ) : null}
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
        <SortableContext items={presentationIds} strategy={verticalListSortingStrategy}>
          <div
            aria-label={messages.workspaceShell.sidebar.listLabel}
            className="workspace-list"
            role="list"
          >
            {sections.map((section) => (
              <div className="workspace-section" data-section-kind={section.kind} key={section.id}>
                {section.kind === 'group' && organization ? (
                  <WorkspaceGroupHeader
                    group={organization.groups.find(({ id }) => id === section.id)!}
                    groupCount={organization.groups.length}
                    groupIndex={organization.groups
                      .slice()
                      .sort((left, right) => left.order - right.order)
                      .findIndex(({ id }) => id === section.id)}
                    onMutation={onMutation}
                    onPublicAction={onPublicAction}
                    organizationRevision={organization.revision}
                    workspaceCount={groupWorkspaceCounts.get(section.id) ?? 0}
                  />
                ) : section.kind === 'pinned' ? (
                  <div className="workspace-section-heading" role="listitem">
                    <Pin aria-hidden="true" size={12} /> Pinned
                  </div>
                ) : section.kind === 'ungrouped' &&
                  section.workspaceIds.length > 0 &&
                  sections.some(({ kind }) => kind !== 'ungrouped') ? (
                  <div className="workspace-section-heading" role="listitem">
                    {messages.workspaceShell.sidebar.recentHeading}
                  </div>
                ) : null}
                {section.workspaceIds.map((workspaceId) => {
                  const workspace = workspaceById.get(workspaceId)
                  if (!workspace) return null
                  const index = canonicalIds.indexOf(workspace.id)
                  const selectionState = organizationEnabled
                    ? workspaceCardSelectionState(workspace.id, organization)
                    : {
                        selected: workspace.id === selectedWorkspaceId,
                        focused: workspace.id === selectedWorkspaceId
                      }
                  return (
                    <SortableWorkspace
                      attention={attention[workspace.id]}
                      batchCloseReplacement={batchCloseReplacement}
                      cardSlots={cardSlots[workspace.id]}
                      cardSlotsV2={cardSlotsV2[workspace.id]}
                      count={workspaces.length}
                      focused={selectionState.focused}
                      index={index}
                      key={workspace.id}
                      metadata={metadata[workspace.id]}
                      onMutation={onMutation}
                      onEditSsh={onEditSsh}
                      onForgetSsh={onForgetSsh}
                      onOpenAttention={onOpenAttention}
                      onPublicAction={onPublicAction}
                      onSelectWorkspace={selectWorkspace}
                      organization={organizationEnabled ? organization : null}
                      processTitle={workspaceProcessTitle(workspace, processTitles)}
                      sshProfile={sshWorkspaces[workspace.id]}
                      selected={selectionState.selected}
                      selectedWorkspaceNames={workspaces
                        .filter(({ id }) => selectedIds.has(id))
                        .map(({ name }) => name)}
                      tabStop={
                        workspace.id === focusedWorkspaceId ||
                        (!hasFocusedWorkspace && presentationIds[0] === workspace.id)
                      }
                      workspace={workspace}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <div className="sidebar-footer">
        {organization && organization.groups.length > 0
          ? `${messages.workspaceShell.sidebar.workspaceCount(workspaces.length)} ${messages.workspaceShell.sidebar.metadataSeparator} ${messages.workspaceShell.sidebar.groupCount(organization.groups.length)}`
          : messages.workspaceShell.sidebar.workspaceCount(workspaces.length)}
      </div>
      {createGroupOpen ? (
        <WorkspaceGroupNameDialog
          description="Group related workspaces together so projects are easier to scan and reorder."
          onOpenChange={setCreateGroupOpen}
          onSubmit={createGroup}
          submitLabel="Create group"
          submittingLabel="Creating…"
          title="Create workspace group"
        />
      ) : null}
    </aside>
  )
}

function WorkspaceGroupNameDialog({
  description,
  initialName = '',
  onOpenChange,
  onSubmit,
  submitLabel,
  submittingLabel,
  title
}: {
  description: string
  initialName?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<boolean>
  submitLabel: string
  submittingLabel: string
  title: string
}): React.JSX.Element {
  const [name, setName] = useState(initialName)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter a group name.')
      return
    }
    setSubmitting(true)
    setError(null)
    const saved = await onSubmit(trimmed)
    setSubmitting(false)
    if (saved) onOpenChange(false)
    else setError('The group could not be saved. Try again.')
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen)
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>Group name</span>
            <input
              aria-describedby={error ? 'create-group-error' : undefined}
              autoFocus
              maxLength={MAX_WORKSPACE_GROUP_NAME_CHARS}
              onChange={(event) => {
                setName(event.target.value)
                if (error) setError(null)
              }}
              onFocus={(event) => event.currentTarget.select()}
              placeholder="For example, Client projects"
              value={name}
            />
          </label>
          {error ? (
            <p className="dialog-field-error" id="create-group-error" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button">
              Cancel
            </Button>
            <Button disabled={submitting || !name.trim()} type="submit" variant="primary">
              {submitting ? submittingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SavedLayoutsPanel({
  legacyOverLimit,
  onLayoutMutation,
  organization,
  savedLayouts,
  selectedWorkspaceId
}: {
  legacyOverLimit: boolean
  onLayoutMutation: (operation: Promise<unknown>) => void
  organization: WorkspaceOrganizationSnapshot | null
  savedLayouts: LayoutListResult
  selectedWorkspaceId: string | null
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const mutationBase = (): { expectedRevision: number; idempotencyKey: string } => ({
    expectedRevision: savedLayouts.revision,
    idempotencyKey: globalThis.crypto.randomUUID()
  })
  const save = (): void => {
    if (!window.desktopBridge.saveLayout) return
    const workspaceIds =
      organization?.selection ?? (selectedWorkspaceId ? [selectedWorkspaceId] : [])
    if (workspaceIds.length < 1 || workspaceIds.length > 32) {
      window.alert('Select between 1 and 32 workspaces to save a layout.')
      return
    }
    const name = window.prompt('Save selected workspaces as a layout')?.trim()
    if (!name) return
    onLayoutMutation(
      window.desktopBridge.saveLayout({
        layoutId: globalThis.crypto.randomUUID(),
        name,
        workspaceIds: [...workspaceIds],
        ...mutationBase()
      })
    )
  }
  const importLayout = (): void => {
    if (legacyOverLimit || !window.desktopBridge.importSavedLayoutFromFile) return
    onLayoutMutation(
      window.desktopBridge.importSavedLayoutFromFile({
        layoutId: globalThis.crypto.randomUUID(),
        ...mutationBase()
      })
    )
  }
  return (
    <section
      aria-label="Saved layouts"
      className="saved-layouts-panel"
      id="saved-layouts-panel"
      onFocus={(event) => {
        if (event.target === event.currentTarget) setExpanded(true)
      }}
      tabIndex={-1}
    >
      <div className="saved-layouts-heading">
        <button
          aria-expanded={expanded}
          className="saved-layouts-toggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <ChevronDown aria-hidden="true" data-collapsed={expanded ? 'false' : 'true'} size={12} />
          <strong>Saved layouts</strong>
        </button>
        {expanded ? (
          <>
            <button
              data-workspace-action={workspaceCardActionRegistry.resolve('layoutSave').actionId}
              onClick={save}
              type="button"
            >
              Save selection
            </button>
            <button
              data-workspace-action={workspaceCardActionRegistry.resolve('layoutImport').actionId}
              disabled={legacyOverLimit}
              onClick={importLayout}
              type="button"
            >
              Import
            </button>
          </>
        ) : (
          <span className="workspace-group-count">{savedLayouts.layouts.length}</span>
        )}
      </div>
      {!expanded ? null : savedLayouts.layouts.length > 0 ? (
        <ul>
          {savedLayouts.layouts.map((layout) => (
            <li key={layout.id}>
              <span title={`${String(layout.workspaceCount)} workspaces`}>{layout.name}</span>
              <button
                data-workspace-action={workspaceCardActionRegistry.resolve('layoutApply').actionId}
                onClick={() => {
                  if (legacyOverLimit || !window.desktopBridge.applyLayout) return
                  if (
                    !window.confirm(`Apply “${layout.name}” and replace the current workspace set?`)
                  )
                    return
                  onLayoutMutation(
                    window.desktopBridge.applyLayout({ layoutId: layout.id, ...mutationBase() })
                  )
                }}
                disabled={legacyOverLimit}
                type="button"
              >
                Apply
              </button>
              <button
                data-workspace-action={workspaceCardActionRegistry.resolve('layoutExport').actionId}
                onClick={() => {
                  if (window.desktopBridge.exportSavedLayoutToFile) {
                    onLayoutMutation(
                      window.desktopBridge.exportSavedLayoutToFile({ layoutId: layout.id })
                    )
                  }
                }}
                type="button"
              >
                Export
              </button>
              <button
                aria-label={`Delete saved layout ${layout.name}`}
                data-workspace-action={workspaceCardActionRegistry.resolve('layoutDelete').actionId}
                onClick={() => {
                  if (
                    !window.desktopBridge.deleteLayout ||
                    !window.confirm(`Delete “${layout.name}”?`)
                  )
                    return
                  onLayoutMutation(
                    window.desktopBridge.deleteLayout({ layoutId: layout.id, ...mutationBase() })
                  )
                }}
                type="button"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <small>No saved layouts</small>
      )}
    </section>
  )
}

function WorkspaceGroupHeader({
  group,
  groupCount,
  groupIndex,
  onMutation,
  onPublicAction,
  organizationRevision,
  workspaceCount
}: MutationOwner & {
  group: WorkspaceOrganizationSnapshot['groups'][number]
  groupCount: number
  groupIndex: number
  organizationRevision: number
  workspaceCount: number
  onPublicAction: (
    actionId: string,
    parameters: DesktopActionInvokeRequest['parameters']
  ) => Promise<boolean>
}): React.JSX.Element {
  const [renameOpen, setRenameOpen] = useState(false)
  const mutationBase = (): { expectedRevision: number; idempotencyKey: string } => ({
    expectedRevision: organizationRevision,
    idempotencyKey: globalThis.crypto.randomUUID()
  })
  const rename = async (name: string): Promise<boolean> => {
    if (name === group.name) return true
    try {
      const invoked = await onPublicAction('workspace.group.rename', {
        groupId: group.id,
        name,
        expectedRevision: organizationRevision
      })
      if (invoked) return true
      if (!window.desktopBridge.renameGroup) return false
      return onMutation(
        window.desktopBridge.renameGroup({ groupId: group.id, name, ...mutationBase() })
      )
    } catch {
      return false
    }
  }
  const remove = (): void => {
    if (
      !window.desktopBridge.deleteGroup ||
      !window.confirm(`Delete the “${group.name}” group? Workspaces will become ungrouped.`)
    )
      return
    void onMutation(window.desktopBridge.deleteGroup({ groupId: group.id, ...mutationBase() }))
  }
  const move = (destinationIndex: number): void => {
    if (
      !window.desktopBridge.moveGroup ||
      destinationIndex < 0 ||
      destinationIndex >= groupCount ||
      destinationIndex === groupIndex
    )
      return
    void onMutation(
      window.desktopBridge.moveGroup({ groupId: group.id, destinationIndex, ...mutationBase() })
    )
  }
  return (
    <div className="workspace-group-heading" role="listitem">
      <button
        aria-expanded={!group.collapsed}
        aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} ${group.name}`}
        data-workspace-action={workspaceCardActionRegistry.resolve('groupCollapse').actionId}
        onClick={() => {
          void onPublicAction('workspace.group.collapse', {
            groupId: group.id,
            collapsed: !group.collapsed,
            expectedRevision: organizationRevision
          })
            .then((invoked) =>
              invoked
                ? undefined
                : window.desktopBridge.collapseGroup
                  ? onMutation(
                      window.desktopBridge.collapseGroup({
                        groupId: group.id,
                        collapsed: !group.collapsed,
                        ...mutationBase()
                      })
                    )
                  : undefined
            )
            .catch(() => undefined)
        }}
        type="button"
      >
        <ChevronDown
          aria-hidden="true"
          data-collapsed={group.collapsed ? 'true' : 'false'}
          size={12}
        />
        <span>{group.name}</span>
      </button>
      {group.collapsed ? (
        <span
          aria-label={messages.workspaceShell.sidebar.workspaceCount(workspaceCount)}
          className="workspace-group-count"
          title={messages.workspaceShell.sidebar.workspaceCount(workspaceCount)}
        >
          {workspaceCount}
        </span>
      ) : null}
      <button
        aria-label={`Rename ${group.name}`}
        data-workspace-action={workspaceCardActionRegistry.resolve('groupRename').actionId}
        onClick={() => setRenameOpen(true)}
        title={`Rename ${group.name}`}
        type="button"
      >
        <Pencil aria-hidden="true" size={12} />
      </button>
      <button
        aria-label={`Move ${group.name} up`}
        data-workspace-action={workspaceCardActionRegistry.resolve('groupMove').actionId}
        disabled={groupIndex <= 0}
        onClick={() => move(groupIndex - 1)}
        title={`Move ${group.name} up`}
        type="button"
      >
        <ArrowUp aria-hidden="true" size={12} />
      </button>
      <button
        aria-label={`Move ${group.name} down`}
        data-workspace-action={workspaceCardActionRegistry.resolve('groupMove').actionId}
        disabled={groupIndex >= groupCount - 1}
        onClick={() => move(groupIndex + 1)}
        title={`Move ${group.name} down`}
        type="button"
      >
        <ArrowDown aria-hidden="true" size={12} />
      </button>
      <button
        aria-label={`Delete ${group.name}`}
        data-workspace-action={workspaceCardActionRegistry.resolve('groupDelete').actionId}
        onClick={remove}
        title={`Delete ${group.name}`}
        type="button"
      >
        <Trash2 aria-hidden="true" size={12} />
      </button>
      {renameOpen ? (
        <WorkspaceGroupNameDialog
          description="Choose a short name that makes this workspace collection easy to recognize."
          initialName={group.name}
          onOpenChange={setRenameOpen}
          onSubmit={rename}
          submitLabel="Save changes"
          submittingLabel="Saving…"
          title="Rename workspace group"
        />
      ) : null}
    </div>
  )
}

function SortableWorkspace({
  attention,
  batchCloseReplacement,
  cardSlots,
  cardSlotsV2,
  count,
  focused,
  index,
  metadata,
  onMutation,
  onEditSsh,
  onForgetSsh,
  onOpenAttention,
  onPublicAction,
  onSelectWorkspace,
  organization,
  processTitle,
  sshProfile,
  selected,
  selectedWorkspaceNames,
  tabStop,
  workspace
}: MutationOwner & {
  attention: WorkspaceAttentionSnapshot | undefined
  batchCloseReplacement: WorkspaceCreateParams | undefined
  cardSlots: WorkspaceCardSlotsSnapshot | undefined
  cardSlotsV2: WorkspaceCardSlotsV2Projection[string] | undefined
  count: number
  focused: boolean
  index: number
  metadata: CachedWorkspaceRuntimeMetadata | undefined
  onEditSsh: (workspaceId: string) => void
  onForgetSsh: (workspaceId: string) => void
  onOpenAttention: (attention: WorkspaceAttentionSnapshot) => Promise<void>
  onSelectWorkspace: (workspaceId: string, modifiers: SelectionModifiers) => void
  onPublicAction: (
    actionId: string,
    parameters: DesktopActionInvokeRequest['parameters']
  ) => Promise<boolean>
  organization: WorkspaceOrganizationSnapshot | null
  processTitle: string
  sshProfile: SavedSshWorkspace | undefined
  selected: boolean
  selectedWorkspaceNames: readonly string[]
  tabStop: boolean
  workspace: WorkspaceSnapshot
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id
  })
  const activity = workspaceActivity(cardSlots, cardSlotsV2)
  const rename = (): void => {
    const name = window.prompt(messages.workspaceContextMenu.rename, workspace.name)?.trim()
    if (name && name !== workspace.name)
      void onMutation(window.desktopBridge.updateWorkspace({ workspaceId: workspace.id, name }))
  }
  const move = (destinationIndex: number): void => {
    if (destinationIndex < 0 || destinationIndex >= count || destinationIndex === index) return
    if (organization && window.desktopBridge.reorderWorkspace) {
      void onMutation(
        window.desktopBridge.reorderWorkspace({
          workspaceId: workspace.id,
          destinationIndex,
          expectedRevision: organization.revision,
          idempotencyKey: globalThis.crypto.randomUUID()
        })
      )
      return
    }
    void onMutation(
      window.desktopBridge.moveWorkspace({ workspaceId: workspace.id, destinationIndex })
    )
  }
  const setColor = (color: string | null): void => {
    void onMutation(
      window.desktopBridge.updateWorkspace({
        workspaceId: workspace.id,
        color: { value: color }
      })
    )
  }
  const chooseCustomColor = (): void => {
    const color = window.prompt(
      messages.workspaceContextMenu.chooseColor,
      safeWorkspaceColor(workspace.color) ?? '#5B8DEF'
    )
    if (color === null) return
    const normalized = normalizeWorkspaceColor(color)
    if (!normalized) {
      window.alert(messages.workspaceContextMenu.invalidColor)
      return
    }
    setColor(normalized)
  }
  const duplicate = (): void => {
    void onMutation(window.desktopBridge.createWorkspace(duplicateWorkspaceParams(workspace)))
  }
  const close = (): void => {
    if (
      organization &&
      organization.selection.length > 1 &&
      organization.selection.includes(workspace.id) &&
      window.desktopBridge.closeSelectedWorkspaces
    ) {
      const confirmation = `Close ${String(organization.selection.length)} selected workspaces (${selectedWorkspaceNames.join(', ')})?`
      if (!window.confirm(confirmation)) return
      void onMutation(
        window.desktopBridge.closeSelectedWorkspaces({
          ...(batchCloseReplacement ? { replacement: batchCloseReplacement } : {}),
          expectedRevision: organization.revision,
          idempotencyKey: globalThis.crypto.randomUUID()
        })
      )
    } else {
      if (!window.confirm(messages.workspaceShell.sidebar.closeConfirmation(workspace.name))) return
      void onMutation(window.desktopBridge.closeWorkspace({ workspaceId: workspace.id }))
    }
  }
  const pinned = organization?.pins.includes(workspace.id) ?? false
  const newSshShell = (): void => {
    if (!sshProfile) return
    const pane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)
    if (!pane) return
    void (async () => {
      if (useProjectionStore.getState().snapshot?.selectedWorkspaceId !== workspace.id) {
        const selected = await onMutation(
          window.desktopBridge.selectWorkspace({ workspaceId: workspace.id })
        )
        if (!selected) return
      }
      await onMutation(
        window.desktopBridge.openTerminalTab({
          workspaceId: workspace.id,
          paneId: pane.id,
          launch: { ...terminalLaunch(workspace.workingDirectory), command: sshCommand(sshProfile) }
        })
      )
    })()
  }
  const togglePin = (): void => {
    if (!organization) return
    void onPublicAction('workspace.card.pin', {
      workspaceId: workspace.id,
      pinned: !pinned,
      expectedRevision: organization.revision
    })
      .then((invoked) =>
        invoked
          ? undefined
          : window.desktopBridge.pinWorkspace
            ? onMutation(
                window.desktopBridge.pinWorkspace({
                  workspaceId: workspace.id,
                  pinned: !pinned,
                  expectedRevision: organization.revision,
                  idempotencyKey: globalThis.crypto.randomUUID()
                })
              )
            : undefined
      )
      .catch(() => undefined)
  }
  const assignGroup = (groupId: string | undefined): void => {
    if (!organization || !window.desktopBridge.assignWorkspaceGroup) return
    void onMutation(
      window.desktopBridge.assignWorkspaceGroup({
        workspaceId: workspace.id,
        ...(groupId ? { groupId } : {}),
        expectedRevision: organization.revision,
        idempotencyKey: globalThis.crypto.randomUUID()
      })
    )
  }
  const listeningPorts =
    selected && metadata?.selectionKey === workspaceRuntimeMetadataSelectionKey(workspace)
      ? metadata.listeningPorts
      : []
  const activateWorkspace = (additive: boolean, range: boolean): void => {
    if (!organization && attention && attention.state !== 'none') {
      void onOpenAttention(attention)
      return
    }
    onSelectWorkspace(workspace.id, { additive, range })
  }
  const [pathOpeners, setPathOpeners] = useState<readonly DesktopWorkspacePathOpener[]>([
    { id: 'fileManager', label: 'File Explorer', kind: 'fileManager' }
  ])
  const [pathOpenerStatus, setPathOpenerStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    'idle'
  )
  const loadPathOpeners = (open: boolean): void => {
    if (!open || pathOpenerStatus !== 'idle' || !window.desktopBridge.listWorkspacePathOpeners)
      return
    setPathOpenerStatus('loading')
    void window.desktopBridge
      .listWorkspacePathOpeners()
      .then((openers) => {
        setPathOpeners(openers)
        setPathOpenerStatus('ready')
      })
      .catch(() => setPathOpenerStatus('failed'))
  }
  const openWorkspacePath = (openerId: DesktopWorkspacePathOpenerId): void => {
    if (!window.desktopBridge.openWorkspacePath) return
    void window.desktopBridge
      .openWorkspacePath({ workspaceId: workspace.id, openerId })
      .catch(() => window.alert(messages.workspaceContextMenu.openFailed))
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          className="workspace-row-wrap"
          role="listitem"
          style={{
            transform: transform
              ? `translate3d(${String(transform.x)}px, ${String(transform.y)}px, 0) scaleX(${String(transform.scaleX)}) scaleY(${String(transform.scaleY)})`
              : undefined,
            transition,
            opacity: isDragging ? 0.55 : 1
          }}
        >
          <div
            className="workspace-card"
            data-attention={attention?.state ?? 'none'}
            data-selected={selected ? 'true' : 'false'}
            data-workspace-id={workspace.id}
            {...pointerDragListeners(listeners)}
            onClick={(event) => {
              const target = event.target
              if (
                target instanceof Element &&
                target.closest('button, a, input, select, textarea, [role="button"], [role="link"]')
              ) {
                return
              }
              activateWorkspace(event.ctrlKey || event.metaKey, event.shiftKey)
            }}
          >
            <button
              aria-current={focused ? 'page' : undefined}
              aria-label={messages.workspaceShell.sidebar.cardAccessibleName(
                workspace.name,
                attention?.state ?? 'none',
                attention?.unreadCount ?? 0
              )}
              className="workspace-row"
              data-workspace-action={workspaceCardActionRegistry.resolve('select').actionId}
              aria-pressed={organization ? selected : undefined}
              onClick={(event) => {
                activateWorkspace(event.ctrlKey || event.metaKey, event.shiftKey)
              }}
              onDoubleClick={rename}
              onKeyDown={(event) => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  const bounds = event.currentTarget.getBoundingClientRect()
                  event.currentTarget.dispatchEvent(
                    new MouseEvent('contextmenu', {
                      bubbles: true,
                      cancelable: true,
                      clientX: bounds.left + bounds.width / 2,
                      clientY: bounds.top + bounds.height / 2
                    })
                  )
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activateWorkspace(event.ctrlKey || event.metaKey, event.shiftKey)
                  return
                }
                const action =
                  event.key === 'ArrowDown'
                    ? 'next'
                    : event.key === 'ArrowUp'
                      ? 'previous'
                      : event.key === 'Home'
                        ? 'home'
                        : event.key === 'End'
                          ? 'end'
                          : undefined
                if (!action) return
                const options = [
                  ...(event.currentTarget
                    .closest('[role="list"]')
                    ?.querySelectorAll<HTMLButtonElement>('.workspace-row') ?? [])
                ]
                const nextIndex = rovingFocusIndex(
                  options.indexOf(event.currentTarget),
                  options.length,
                  action
                )
                const next = options[nextIndex]
                if (!next) return
                event.preventDefault()
                next.focus()
                next.dispatchEvent(
                  new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                    shiftKey: event.shiftKey
                  })
                )
              }}
              tabIndex={tabStop ? 0 : -1}
              type="button"
            >
              <span className="workspace-name-line">
                <span
                  className="workspace-indicator"
                  style={
                    attention?.state === 'waiting' || attention?.state === 'urgent'
                      ? undefined
                      : { background: safeWorkspaceColor(workspace.color) }
                  }
                  aria-hidden="true"
                />
                <strong>{workspace.name}</strong>
                <WorkspaceActivityBadge activity={activity} workspaceName={workspace.name} />
                {attention ? (
                  <AttentionBadge
                    announce={false}
                    attention={attention}
                    compact
                    label={workspace.name}
                  />
                ) : null}
                <span
                  aria-hidden="true"
                  className="workspace-when"
                  title={messages.workspaceShell.sidebar.lastActivity(
                    new Date(workspace.updatedAt).toLocaleString()
                  )}
                >
                  {workspaceRelativeTime(workspace.updatedAt)}
                </span>
              </span>
            </button>
            <div className="workspace-copy workspace-details">
              <small
                aria-label={messages.workspaceRuntimeMetadata.workingDirectory(
                  workspace.workingDirectory
                )}
                className="workspace-directory"
                title={workspace.workingDirectory}
              >
                <FolderOpen aria-hidden="true" size={11} />
                <span className="workspace-meta-value">
                  {workspaceDirectoryDisplayPath(workspace.workingDirectory)}
                </span>
                {metadata?.gitBranch ? (
                  <span className="workspace-branch" title={metadata.gitBranch}>
                    <GitBranch aria-hidden="true" size={11} />
                    <span>{metadata.gitBranch}</span>
                  </span>
                ) : null}
              </small>
              <small
                aria-label={messages.workspaceRuntimeMetadata.accessibilityLabel(
                  metadata?.gitBranch ?? messages.workspaceRuntimeMetadata.unavailable,
                  workspaceGitStatusLabel(metadata?.gitStatus),
                  processTitle,
                  workspaceListeningPortsAccessibilityLabel(listeningPorts)
                )}
                className="workspace-runtime-metadata"
                tabIndex={0}
              >
                {workspaceGitStatusDirty(metadata?.gitStatus) ? (
                  <span
                    className="workspace-git-status"
                    title={workspaceGitStatusLabel(metadata?.gitStatus)}
                  >
                    {workspaceGitStatusLabel(metadata?.gitStatus)}
                  </span>
                ) : null}
                <span className="workspace-chips">
                  <span className="workspace-chip" title={processTitle}>
                    <span className="workspace-runtime-metadata-label">
                      {messages.workspaceRuntimeMetadata.process}:{' '}
                    </span>
                    {processTitle}
                  </span>
                  <span
                    className="workspace-runtime-metadata-label"
                    title={workspaceListeningPortsTitle(listeningPorts)}
                  >
                    {messages.workspaceRuntimeMetadata.ports}:{' '}
                    {workspaceListeningPortsLabel(listeningPorts)}
                  </span>
                  {listeningPorts.map((port) => (
                    <span
                      aria-hidden="true"
                      className="workspace-chip workspace-chip-port"
                      key={port}
                    >
                      :{port}
                    </span>
                  ))}
                  {workspaceBrowserHosts(workspace).map((host) => (
                    <span className="workspace-chip" key={host} title={host}>
                      <Globe2 aria-hidden="true" size={10} />
                      {host}
                    </span>
                  ))}
                </span>
              </small>
              <WorkspaceCardSlots slots={cardSlots} />
              {sshProfile ? (
                <div className="workspace-ssh-target">
                  <small title={sshProfile.host}>
                    SSH · {sshProfile.user ? `${sshProfile.user}@` : ''}
                    {sshProfile.host}
                    {sshProfile.port === 22 ? '' : `:${sshProfile.port}`}
                  </small>
                  <button
                    aria-label={`New SSH shell in ${workspace.name}`}
                    onClick={newSshShell}
                    title="Open a fresh SSH shell; existing remote processes are not resumed"
                    type="button"
                  >
                    New shell
                  </button>
                </div>
              ) : null}
              <WorkspaceCardSlotsV2 slots={cardSlotsV2} />
              {workspace.attention.latestUnread ? (
                <span className="workspace-attention-excerpt">
                  {workspace.attention.latestUnread.title}
                </span>
              ) : null}
            </div>
          </div>
          <DropdownMenu onOpenChange={loadPathOpeners}>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={`${messages.workspaceContextMenu.openWith} ${workspace.name}`}
                className="workspace-open-path"
                data-workspace-action={workspaceCardActionRegistry.resolve('openPath').actionId}
                disabled={!window.desktopBridge.openWorkspacePath}
                title={messages.workspaceContextMenu.openWith}
                type="button"
              >
                <FolderOpen aria-hidden="true" size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="right" sideOffset={6}>
              <DropdownMenuItem onSelect={() => openWorkspacePath('fileManager')}>
                <FolderOpen aria-hidden="true" size={14} />
                {messages.workspaceContextMenu.openInFileExplorer}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {pathOpeners
                .filter(({ kind }) => kind === 'ide')
                .map((opener) => (
                  <DropdownMenuItem key={opener.id} onSelect={() => openWorkspacePath(opener.id)}>
                    <Code2 aria-hidden="true" size={14} />
                    {messages.workspaceContextMenu.openInIde(opener.label)}
                  </DropdownMenuItem>
                ))}
              {pathOpenerStatus === 'loading' ? (
                <DropdownMenuItem disabled>
                  {messages.workspaceContextMenu.detectingIdes}
                </DropdownMenuItem>
              ) : null}
              {pathOpenerStatus === 'ready' && pathOpeners.length === 1 ? (
                <DropdownMenuItem disabled>{messages.workspaceContextMenu.noIdes}</DropdownMenuItem>
              ) : null}
              {pathOpenerStatus === 'failed' ? (
                <DropdownMenuItem disabled>
                  {messages.workspaceContextMenu.openerDetectionFailed}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {organization ? (
            <button
              aria-label={`${pinned ? 'Unpin' : 'Pin'} ${workspace.name}`}
              aria-pressed={pinned}
              className="workspace-pin"
              data-pinned={pinned}
              onClick={togglePin}
              title={pinned ? 'Unpin workspace' : 'Pin workspace'}
              type="button"
            >
              <Pin aria-hidden="true" size={13} />
            </button>
          ) : null}
          <button
            className="workspace-drag"
            aria-label={messages.workspaceShell.sidebar.reorder(workspace.name)}
            data-workspace-action={workspaceCardActionRegistry.resolve('reorder').actionId}
            {...attributes}
            {...listeners}
            title={messages.workspaceShell.sidebar.reorderTitle}
            onKeyDown={(event) => {
              if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
              event.preventDefault()
              move(index + (event.key === 'ArrowUp' ? -1 : 1))
            }}
            type="button"
          >
            <GripVertical size={13} />
          </button>
          <button
            className="workspace-remove"
            aria-label={messages.workspaceShell.sidebar.close(workspace.name)}
            data-workspace-action={
              workspaceCardActionRegistry.resolve(
                organization &&
                  organization.selection.length > 1 &&
                  organization.selection.includes(workspace.id)
                  ? 'closeSelected'
                  : 'close'
              ).actionId
            }
            onClick={close}
            type="button"
          >
            <X size={12} />
          </button>
          {organization && attention && attention.state !== 'none' ? (
            <button
              aria-label={`Open attention for ${workspace.name}`}
              className="workspace-attention-open"
              data-workspace-action={workspaceCardActionRegistry.resolve('attention').actionId}
              onClick={() => void onOpenAttention(attention)}
              type="button"
            >
              <Bell aria-hidden="true" size={12} />
            </button>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={messages.workspaceShell.sidebar.actions(workspace.name)}>
        {sshProfile ? (
          <>
            <ContextMenuItem onSelect={newSshShell}>New SSH shell</ContextMenuItem>
            <ContextMenuItem onSelect={() => onEditSsh(workspace.id)}>
              Edit SSH connection
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onForgetSsh(workspace.id)}>
              Forget SSH connection
            </ContextMenuItem>
          </>
        ) : null}
        {organization ? (
          <>
            <ContextMenuItem
              data-workspace-action={workspaceCardActionRegistry.resolve('pin').actionId}
              onSelect={togglePin}
            >
              {pinned ? 'Unpin' : 'Pin'}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger
                data-workspace-action={workspaceCardActionRegistry.resolve('assignGroup').actionId}
              >
                Move to group
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => assignGroup(undefined)}>Ungrouped</ContextMenuItem>
                {organization.groups
                  .slice()
                  .sort((left, right) => left.order - right.order)
                  .map((group) => (
                    <ContextMenuItem key={group.id} onSelect={() => assignGroup(group.id)}>
                      {group.name}
                    </ContextMenuItem>
                  ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem
          data-workspace-action={workspaceCardActionRegistry.resolve('rename').actionId}
          onSelect={rename}
        >
          {messages.workspaceContextMenu.rename}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger
            data-workspace-action={workspaceCardActionRegistry.resolve('color').actionId}
          >
            {messages.workspaceContextMenu.color}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {WORKSPACE_COLOR_PALETTE.map(({ label, value }) => (
              <ContextMenuItem
                data-workspace-action={workspaceCardActionRegistry.resolve('colorSet').actionId}
                key={value}
                onSelect={() => setColor(value)}
              >
                <span
                  aria-hidden="true"
                  className="workspace-color-swatch"
                  style={{ background: value }}
                />
                {label}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem
              data-workspace-action={workspaceCardActionRegistry.resolve('colorChoose').actionId}
              onSelect={chooseCustomColor}
            >
              {messages.workspaceContextMenu.chooseColor}
            </ContextMenuItem>
            <ContextMenuItem
              data-workspace-action={workspaceCardActionRegistry.resolve('colorClear').actionId}
              disabled={!workspace.color}
              onSelect={() => setColor(null)}
            >
              {messages.workspaceContextMenu.clearColor}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          data-workspace-action={workspaceCardActionRegistry.resolve('duplicate').actionId}
          onSelect={duplicate}
        >
          {messages.workspaceContextMenu.duplicate}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-workspace-action={workspaceCardActionRegistry.resolve('moveUp').actionId}
          disabled={index === 0}
          onSelect={() => move(index - 1)}
        >
          {messages.workspaceContextMenu.moveUp}
        </ContextMenuItem>
        <ContextMenuItem
          data-workspace-action={workspaceCardActionRegistry.resolve('moveDown').actionId}
          disabled={index >= count - 1}
          onSelect={() => move(index + 1)}
        >
          {messages.workspaceContextMenu.moveDown}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-workspace-action={workspaceCardActionRegistry.resolve('close').actionId}
          destructive
          onSelect={close}
        >
          {messages.workspaceContextMenu.close}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function workspaceProcessTitle(
  workspace: WorkspaceSnapshot,
  processTitles: Readonly<Record<string, string>>
): string {
  const pane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)
  const tab = workspace.tabs.find(({ id }) => id === pane?.selectedTabId)
  if (!tab) return messages.workspaceRuntimeMetadata.noActiveProcess
  if (tab.content.kind === 'browser') return messages.workspaceRuntimeMetadata.browser
  return processTitles[tab.id] ?? displayTabTitle(tab)
}

function workspaceListeningPortsLabel(ports: readonly number[] | undefined): string {
  return ports?.length ? ports.join(', ') : messages.workspaceShell.sidebar.unavailableMetadata
}

function workspaceListeningPortsAccessibilityLabel(ports: readonly number[] | undefined): string {
  return messages.workspaceRuntimeMetadata.listeningPortsAccessibility(
    ports?.length ? ports.join(', ') : null
  )
}

function workspaceListeningPortsTitle(ports: readonly number[] | undefined): string {
  return ports?.length
    ? messages.workspaceRuntimeMetadata.listeningPorts(ports.join(', '))
    : messages.workspaceRuntimeMetadata.noListeningPorts
}

function arraysEqual(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  )
}

function gitStatusesEqual(
  left: WorkspaceGitStatus | null | undefined,
  right: WorkspaceGitStatus | null | undefined
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.clean === right.clean &&
      left.staged === right.staged &&
      left.unstaged === right.unstaged &&
      left.untracked === right.untracked &&
      left.conflicted === right.conflicted &&
      left.ahead === right.ahead &&
      left.behind === right.behind)
  )
}

function workspaceGitStatusLabel(status: WorkspaceGitStatus | null | undefined): string {
  if (!status) return messages.workspaceRuntimeMetadata.statusUnavailable
  const parts = status.clean
    ? [messages.workspaceRuntimeMetadata.clean]
    : [
        ...(status.conflicted ? ['conflicts'] : []),
        ...(status.staged ? ['staged'] : []),
        ...(status.unstaged ? ['unstaged'] : []),
        ...(status.untracked ? ['untracked'] : [])
      ]
  if (status.ahead > 0) parts.push(`ahead ${String(status.ahead)}`)
  if (status.behind > 0) parts.push(`behind ${String(status.behind)}`)
  return parts.join(', ')
}

export function workspaceGitStatusDirty(status: WorkspaceGitStatus | null | undefined): boolean {
  if (!status) return false
  return !status.clean || status.ahead > 0 || status.behind > 0
}

export function workspaceRelativeTime(updatedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${String(days)}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${String(weeks)}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${String(months)}mo`
  return `${String(Math.floor(days / 365))}y`
}

export function workspaceBrowserHosts(workspace: WorkspaceSnapshot): string[] {
  const hosts = new Set<string>()
  for (const tab of workspace.tabs) {
    if (tab.content.kind !== 'browser') continue
    try {
      const url = new URL(tab.content.state.url)
      if (url.host) hosts.add(url.host)
    } catch {
      // Placeholder or invalid URLs contribute no chip.
    }
  }
  return [...hosts].slice(0, 3)
}

function workspaceRuntimeMetadataSelectionKey(workspace: WorkspaceSnapshot): string {
  const pane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)
  const tab = workspace.tabs.find(({ id }) => id === pane?.selectedTabId)
  const runtimeSessionId =
    tab?.content.kind === 'terminal' ? tab.content.runtimeSessionId : undefined
  return `${tab?.id ?? ''}:${runtimeSessionId ?? ''}`
}

export function workspaceDirectoryBasename(workingDirectory: string): string {
  if (/^[A-Za-z]:[\\/]*$/u.test(workingDirectory)) return workingDirectory
  const withoutTrailingSeparators = workingDirectory.replace(/[\\/]+$/u, '')
  if (!withoutTrailingSeparators) return workingDirectory
  return withoutTrailingSeparators.split(/[\\/]/u).pop() || workingDirectory
}

export function workspaceDirectoryDisplayPath(workingDirectory: string): string {
  return workingDirectory
    .replace(/^\/home\/[^/]+(?=\/|$)/u, '~')
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/iu, '~')
}

export function duplicateWorkspaceParams(workspace: WorkspaceSnapshot): WorkspaceCreateParams {
  const color = safeWorkspaceColor(workspace.color)
  return {
    name: duplicateWorkspaceName(workspace.name),
    workingDirectory: workspace.workingDirectory,
    initialTerminal: terminalLaunch(workspace.workingDirectory),
    ...(workspace.description === null ? {} : { description: workspace.description }),
    ...(color ? { color } : {})
  }
}

function currentPlacement(
  topology: WindowListResult,
  workspaceId: string | undefined
): WindowPlacementSnapshot | undefined {
  return (
    topology.windows.find(
      ({ workspaceIds }) => workspaceId && workspaceIds.includes(workspaceId)
    ) ?? topology.windows.find(({ windowId }) => windowId === topology.focusedWindowId)
  )
}

function multiWindowMutation(topology: WindowListResult): MultiWindowMutationToken {
  return {
    expectedRevision: topology.revision,
    idempotencyEpoch: topology.idempotencyEpoch,
    idempotencyKey: crypto.randomUUID()
  }
}

function exactPlacement(
  placement: WindowPlacementSnapshot,
  workspace: WorkspaceSnapshot,
  pane: PaneSnapshot
): ExactTabPlacement {
  return {
    windowId: placement.windowId,
    workspaceId: workspace.id,
    paneId: pane.id,
    destinationIndex: pane.tabIds.length,
    expectedWindowRevision: placement.revision
  }
}

export function duplicateWorkspaceName(name: string): string {
  const suffix = messages.workspaceShell.sidebar.copySuffix
  const available = MAX_WORKSPACE_NAME_CHARS - [...suffix].length
  return `${[...name].slice(0, available).join('').trimEnd()}${suffix}`
}

export function normalizeWorkspaceColor(value: string): string | null {
  const normalized = value.trim().toUpperCase()
  return /^#[0-9A-F]{6}$/u.test(normalized) ? normalized : null
}

function safeWorkspaceColor(value: string | null | undefined): string | undefined {
  return value ? (normalizeWorkspaceColor(value) ?? undefined) : undefined
}

function PaneWorkspace({
  browserTabsEnabled,
  browserViewsVisible,
  onMutation,
  onProcessTitleChange,
  workspace
}: MutationOwner & {
  browserTabsEnabled: boolean
  browserViewsVisible: boolean
  onProcessTitleChange: ProcessTitleHandler
  workspace: WorkspaceSnapshot
}): React.JSX.Element {
  const [draggedTab, setDraggedTab] = useState<TabMutationSource | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const executeTabAction = useCallback(
    (source: TabMutationSource, action: TabDropAction): void => {
      const intent = tabActionToMutation(source, action)
      if (intent === null) return
      const command = resolveTabMutationCommand(workspace, intent)
      if (command === null) return
      const operation =
        command.method === 'moveTab'
          ? window.desktopBridge.moveTab(command.params)
          : command.method === 'moveTabToPane'
            ? window.desktopBridge.moveTabToPane(command.params)
            : window.desktopBridge.splitPane(command.params)
      void onMutation(operation)
    },
    [onMutation, workspace]
  )
  const onDragEnd = (event: DragEndEvent): void => {
    setDraggedTab(null)
    const source = tabSourceFromDrag(event.active.data.current)
    const target = event.over?.data.current
    if (!source || !target) return
    if (target.type === 'tab' && typeof target.paneId === 'string') {
      const targetPane = workspace.panes.find((pane) => pane.id === target.paneId)
      const targetTabId = typeof target.tabId === 'string' ? target.tabId : ''
      const targetIndex = targetPane?.tabIds.indexOf(targetTabId) ?? -1
      if (targetIndex >= 0)
        executeTabAction(source, { kind: 'move', targetPaneId: target.paneId, targetIndex })
      return
    }
    if (
      target.type !== 'pane-drop-zone' ||
      typeof target.paneId !== 'string' ||
      !isDropZone(target.zone)
    ) {
      return
    }
    const targetPane = workspace.panes.find((pane) => pane.id === target.paneId)
    if (!targetPane) return
    executeTabAction(
      source,
      target.zone === 'move'
        ? {
            kind: 'move',
            targetPaneId: targetPane.id,
            targetIndex:
              targetPane.id === source.sourcePaneId
                ? Math.max(0, targetPane.tabIds.length - 1)
                : targetPane.tabIds.length
          }
        : { kind: 'split', targetPaneId: targetPane.id, direction: target.zone }
    )
  }
  return (
    <DndContext
      collisionDetection={tabCollisionDetection}
      onDragCancel={() => setDraggedTab(null)}
      onDragEnd={onDragEnd}
      onDragStart={(event) => setDraggedTab(tabSourceFromDrag(event.active.data.current))}
      sensors={sensors}
    >
      <PaneTree
        browserTabsEnabled={browserTabsEnabled}
        browserViewsVisible={browserViewsVisible && draggedTab === null}
        draggedTab={draggedTab}
        node={workspace.layout}
        onMutation={onMutation}
        onProcessTitleChange={onProcessTitleChange}
        onTabAction={executeTabAction}
        workspace={workspace}
      />
    </DndContext>
  )
}

type PaneDropZone = 'move' | SplitDirection
type TabActionHandler = (source: TabMutationSource, action: TabDropAction) => void
type ProcessTitleHandler = (tabId: string, title: string) => void

const tabCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args)
  const tabHit = pointerHits.find((collision) => String(collision.id).startsWith('workspace-tab:'))
  if (tabHit) return [tabHit]
  if (pointerHits.length > 0) return [pointerHits[0]!]
  return closestCenter(args)
}

function tabSourceFromDrag(data: Record<string, unknown> | undefined): TabMutationSource | null {
  return data?.type === 'tab' && typeof data.tabId === 'string' && typeof data.paneId === 'string'
    ? { tabId: data.tabId, sourcePaneId: data.paneId }
    : null
}

function isDropZone(value: unknown): value is PaneDropZone {
  return (
    value === 'move' ||
    value === 'left' ||
    value === 'right' ||
    value === 'top' ||
    value === 'bottom'
  )
}

function PaneTree({
  browserTabsEnabled,
  browserViewsVisible,
  draggedTab,
  node,
  onMutation,
  onProcessTitleChange,
  onTabAction,
  workspace
}: MutationOwner & {
  browserTabsEnabled: boolean
  browserViewsVisible: boolean
  draggedTab: TabMutationSource | null
  node: PaneTreeNode
  onProcessTitleChange: ProcessTitleHandler
  onTabAction: TabActionHandler
  workspace: WorkspaceSnapshot
}): React.JSX.Element {
  if (node.kind === 'leaf') {
    const pane = workspace.panes.find((candidate) => candidate.id === node.paneId)
    return pane ? (
      <PaneView
        browserTabsEnabled={browserTabsEnabled}
        browserViewsVisible={browserViewsVisible}
        draggedTab={draggedTab}
        onMutation={onMutation}
        onProcessTitleChange={onProcessTitleChange}
        onTabAction={onTabAction}
        pane={pane}
        workspace={workspace}
      />
    ) : (
      <div className="pane-error">{messages.workspaceShell.pane.unavailable}</div>
    )
  }
  const firstId = `${node.splitId}-first`
  const secondId = `${node.splitId}-second`
  return (
    <Group
      className="pane-group"
      defaultLayout={{ [firstId]: node.ratio * 100, [secondId]: (1 - node.ratio) * 100 }}
      id={node.splitId}
      onLayoutChanged={(layout: Layout, meta) => {
        if (!meta.isUserInteraction) return
        const ratio = layout[firstId]
        if (ratio !== undefined)
          void onMutation(
            window.desktopBridge.resizePane({
              workspaceId: workspace.id,
              splitId: node.splitId,
              ratio: ratio / 100
            })
          )
      }}
      orientation={node.axis}
    >
      <Panel id={firstId} minSize="12%">
        <PaneTree
          browserTabsEnabled={browserTabsEnabled}
          browserViewsVisible={browserViewsVisible}
          draggedTab={draggedTab}
          node={node.first}
          onMutation={onMutation}
          onProcessTitleChange={onProcessTitleChange}
          onTabAction={onTabAction}
          workspace={workspace}
        />
      </Panel>
      <Separator className="pane-separator">
        <span />
      </Separator>
      <Panel id={secondId} minSize="12%">
        <PaneTree
          browserTabsEnabled={browserTabsEnabled}
          browserViewsVisible={browserViewsVisible}
          draggedTab={draggedTab}
          node={node.second}
          onMutation={onMutation}
          onProcessTitleChange={onProcessTitleChange}
          onTabAction={onTabAction}
          workspace={workspace}
        />
      </Panel>
    </Group>
  )
}

function PaneView({
  browserTabsEnabled,
  browserViewsVisible,
  draggedTab,
  onMutation,
  onProcessTitleChange,
  onTabAction,
  pane,
  workspace
}: MutationOwner & {
  browserTabsEnabled: boolean
  browserViewsVisible: boolean
  draggedTab: TabMutationSource | null
  onTabAction: TabActionHandler
  onProcessTitleChange: ProcessTitleHandler
  pane: PaneSnapshot
  workspace: WorkspaceSnapshot
}): React.JSX.Element {
  const [terminalToolsTabId, setTerminalToolsTabId] = useState<string | null>(null)
  const tabs = pane.tabIds.flatMap((id) => {
    const tab = workspace.tabs.find((candidate) => candidate.id === id)
    return tab ? [tab] : []
  })
  const selectedTab = tabs.find((tab) => tab.id === pane.selectedTabId) ?? tabs[0]
  const terminalToolsOpen = terminalToolsTabId === selectedTab?.id
  return (
    <section
      className={workspace.selectedPaneId === pane.id ? 'pane-view selected' : 'pane-view'}
      data-pane-id={pane.id}
      data-selected={workspace.selectedPaneId === pane.id ? 'true' : 'false'}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest('button, select, input, [role="separator"]'))
          return
        if (workspace.selectedPaneId !== pane.id)
          void onMutation(
            window.desktopBridge.focusPane({ workspaceId: workspace.id, paneId: pane.id })
          )
      }}
      tabIndex={-1}
    >
      <div className="pane-tabbar">
        <SortableContext
          items={tabs.map(({ id }) => tabDragId(id))}
          strategy={horizontalListSortingStrategy}
        >
          <div
            aria-label={pane.title ?? messages.workspaceShell.pane.tabs}
            className="pane-tabs"
            role="tablist"
          >
            {tabs.map((tab) => (
              <PaneTab
                key={tab.id}
                onMutation={onMutation}
                pane={pane}
                selected={tab.id === selectedTab?.id}
                tab={tab}
                workspace={workspace}
              />
            ))}
          </div>
        </SortableContext>
        {selectedTab ? (
          <PaneTabUtilities
            onMutation={onMutation}
            onTabAction={onTabAction}
            pane={pane}
            tab={selectedTab}
            workspace={workspace}
          />
        ) : null}
        <div className="pane-actions">
          <AttentionBadge
            announce={false}
            attention={pane.attention}
            compact
            label={pane.title ?? messages.workspaceShell.pane.attentionLabel}
          />
          {selectedTab?.content.kind === 'terminal' ? (
            <IconButton
              aria-label={
                terminalToolsOpen
                  ? messages.terminalPane.controls.closeTools
                  : messages.terminalPane.controls.openTools
              }
              aria-pressed={terminalToolsOpen}
              onClick={() => setTerminalToolsTabId(terminalToolsOpen ? null : selectedTab.id)}
              tooltip={`${messages.terminalPane.controls.openTools} · Ctrl+F`}
            >
              <Search size={14} />
            </IconButton>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={messages.workspaceShell.pane.addTab}
                className="pane-add-tab"
                type="button"
              >
                <Plus aria-hidden="true" size={14} />
                <span>{messages.workspaceShell.pane.addTab}</span>
                <ChevronDown aria-hidden="true" size={12} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  void onMutation(
                    window.desktopBridge.openTerminalTab({
                      workspaceId: workspace.id,
                      paneId: pane.id,
                      launch: terminalLaunch(workspace.workingDirectory)
                    })
                  )
                }
              >
                <TerminalSquare aria-hidden="true" size={14} />
                {messages.workspaceShell.pane.terminalTab}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!browserTabsEnabled}
                onSelect={() =>
                  void onMutation(
                    window.desktopBridge.openBrowserTab({
                      workspaceId: workspace.id,
                      paneId: pane.id,
                      metadata: { url: messages.workspaceShell.defaultBrowserUrl }
                    })
                  )
                }
              >
                <Globe2 aria-hidden="true" size={14} />
                {messages.workspaceShell.pane.browserTab}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton
            aria-label={messages.workspaceShell.pane.splitRight}
            onClick={() => void splitWithTerminal(workspace, pane.id, 'horizontal', onMutation)}
            tooltip={`${messages.workspaceShell.pane.splitRight} · Ctrl+D`}
          >
            <SplitSquareHorizontal size={14} />
          </IconButton>
          <IconButton
            aria-label={messages.workspaceShell.pane.splitDown}
            onClick={() => void splitWithTerminal(workspace, pane.id, 'vertical', onMutation)}
            tooltip={`${messages.workspaceShell.pane.splitDown} · Ctrl+Shift+D`}
          >
            <SplitSquareVertical size={14} />
          </IconButton>
          {workspace.panes.length > 1 ? (
            <IconButton
              aria-label={messages.workspaceShell.pane.close}
              onClick={() =>
                void onMutation(
                  window.desktopBridge.closePane({ workspaceId: workspace.id, paneId: pane.id })
                )
              }
              tooltip={messages.workspaceShell.pane.close}
            >
              <Trash2 size={13} />
            </IconButton>
          ) : null}
        </div>
      </div>
      <div
        aria-labelledby={selectedTab ? tabDomId(selectedTab.id) : undefined}
        className="pane-content"
        id={panePanelDomId(pane.id)}
        role={selectedTab ? 'tabpanel' : undefined}
      >
        {selectedTab ? (
          <TabContent
            browserVisible={browserViewsVisible}
            onMutation={onMutation}
            onProcessTitleChange={onProcessTitleChange}
            onTerminalToolsOpenChange={(open) =>
              setTerminalToolsTabId(open ? selectedTab.id : null)
            }
            tab={selectedTab}
            terminalToolsOpen={terminalToolsOpen}
            workspace={workspace}
          />
        ) : (
          <EmptyPane
            onAdd={() =>
              void onMutation(
                window.desktopBridge.openTerminalTab({
                  workspaceId: workspace.id,
                  paneId: pane.id,
                  launch: terminalLaunch(workspace.workingDirectory)
                })
              )
            }
          />
        )}
      </div>
      <PaneDropTargets active={draggedTab !== null} pane={pane} source={draggedTab} />
    </section>
  )
}

function PaneTab({
  onMutation,
  pane,
  selected,
  tab,
  workspace
}: MutationOwner & {
  pane: PaneSnapshot
  selected: boolean
  tab: TabSnapshot
  workspace: WorkspaceSnapshot
}): React.JSX.Element {
  const title = displayTabTitle(tab)
  const [renaming, setRenaming] = useState(false)
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tabDragId(tab.id),
    data: { type: 'tab', tabId: tab.id, paneId: pane.id }
  })
  const commitRename = (value: string): void => {
    setRenaming(false)
    const customTitle = value.trim()
    if (customTitle && customTitle !== title)
      void onMutation(
        window.desktopBridge.updateTab({
          workspaceId: workspace.id,
          tabId: tab.id,
          customTitle: { value: customTitle }
        })
      )
  }
  return (
    <div
      ref={setNodeRef}
      className={selected ? 'pane-tab active' : 'pane-tab'}
      role="presentation"
      {...pointerDragListeners(listeners)}
      style={{
        transform: transform
          ? `translate3d(${String(transform.x)}px, ${String(transform.y)}px, 0)`
          : undefined,
        transition,
        opacity: isDragging ? 0.55 : 1
      }}
    >
      {renaming ? (
        <input
          aria-label={messages.workspaceShell.tab.rename}
          autoFocus
          className="pane-tab-rename"
          defaultValue={title}
          onBlur={(event) => commitRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(false)
            }
          }}
          type="text"
        />
      ) : (
        <>
          <button
            aria-controls={panePanelDomId(pane.id)}
            className="pane-tab-select"
            data-selected={selected ? 'true' : 'false'}
            data-tab-id={tab.id}
            id={tabDomId(tab.id)}
            onClick={() => {
              if (!selected)
                void onMutation(
                  window.desktopBridge.selectTab({ workspaceId: workspace.id, tabId: tab.id })
                )
            }}
            onDoubleClick={() => {
              setRenaming(true)
            }}
            onKeyDown={(event) => {
              const action =
                event.key === 'ArrowRight'
                  ? 'next'
                  : event.key === 'ArrowLeft'
                    ? 'previous'
                    : event.key === 'Home'
                      ? 'home'
                      : event.key === 'End'
                        ? 'end'
                        : undefined
              if (!action) return
              const tabs = [
                ...(event.currentTarget
                  .closest('[role="tablist"]')
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
              ]
              const nextIndex = rovingFocusIndex(
                tabs.indexOf(event.currentTarget),
                tabs.length,
                action
              )
              const next = tabs[nextIndex]
              if (!next) return
              event.preventDefault()
              next.focus()
              next.click()
            }}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {tab.content.kind === 'terminal' ? (
              <TerminalSquare size={12} />
            ) : (
              <Globe2 aria-hidden="true" data-tab-kind-icon="browser" size={12} />
            )}
            <span className="pane-tab-title">{title}</span>
            <AttentionBadge announce={false} attention={tab.attention} compact label={title} />
          </button>
          {/* Mouse affordance only: the accessible close control lives in the
              tab utilities toolbar, because a tablist may only own tabs. */}
          <button
            aria-hidden="true"
            className="tab-close"
            onClick={() =>
              void onMutation(
                window.desktopBridge.closeTab({ workspaceId: workspace.id, tabId: tab.id })
              )
            }
            tabIndex={-1}
            title={messages.workspaceShell.tab.close(title)}
            type="button"
          >
            <X size={11} />
          </button>
        </>
      )}
    </div>
  )
}

function PaneTabUtilities({
  onMutation,
  onTabAction,
  pane,
  tab,
  workspace
}: MutationOwner & {
  onTabAction: TabActionHandler
  pane: PaneSnapshot
  tab: TabSnapshot
  workspace: WorkspaceSnapshot
}): React.JSX.Element {
  const title = displayTabTitle(tab)
  const index = pane.tabIds.indexOf(tab.id)
  const move = (delta: number): void => {
    const desiredIndex = Math.max(0, Math.min(pane.tabIds.length - 1, index + delta))
    if (desiredIndex !== index)
      onTabAction(
        { tabId: tab.id, sourcePaneId: pane.id },
        { kind: 'move', targetPaneId: pane.id, targetIndex: desiredIndex }
      )
  }
  return (
    <div
      aria-label={messages.workspaceShell.tab.actions(title)}
      className="pane-tab-utilities"
      role="toolbar"
    >
      <button
        aria-label={messages.workspaceShell.tab.moveLeft(title)}
        className="tab-keyboard-move"
        onClick={() => move(-1)}
        type="button"
      >
        <ChevronLeft aria-hidden="true" size={14} />
      </button>
      <button
        aria-label={messages.workspaceShell.tab.moveRight(title)}
        className="tab-keyboard-move"
        onClick={() => move(1)}
        type="button"
      >
        <ChevronRight aria-hidden="true" size={14} />
      </button>
      <span
        className="tab-drop-actions-control"
        title={messages.workspaceShell.tab.keyboardDestinations}
      >
        <MoreHorizontal aria-hidden="true" size={13} />
        <select
          aria-label={messages.workspaceShell.tab.moveOrSplit(title)}
          className="tab-drop-actions"
          defaultValue=""
          onChange={(event) => {
            const [kind, targetPaneId, direction] = event.currentTarget.value.split(':')
            event.currentTarget.value = ''
            const targetPane = workspace.panes.find((candidate) => candidate.id === targetPaneId)
            if (!targetPane) return
            const source = { tabId: tab.id, sourcePaneId: pane.id }
            if (kind === 'move') {
              onTabAction(source, {
                kind: 'move',
                targetPaneId: targetPane.id,
                targetIndex:
                  targetPaneId === pane.id
                    ? Math.max(0, targetPane.tabIds.length - 1)
                    : targetPane.tabIds.length
              })
            } else if (kind === 'split' && isDropZone(direction) && direction !== 'move') {
              onTabAction(source, { kind: 'split', targetPaneId: targetPane.id, direction })
            }
          }}
          title={messages.workspaceShell.tab.keyboardDestinations}
        >
          <option value="">{messages.workspaceShell.tab.destinations}</option>
          {workspace.panes.map((targetPane) => (
            <option key={`move:${targetPane.id}`} value={`move:${targetPane.id}`}>
              {messages.workspaceShell.tab.moveToPane(paneLabel(targetPane, workspace))}
            </option>
          ))}
          {workspace.panes.flatMap((targetPane) =>
            targetPane.id === pane.id && pane.tabIds.length === 1
              ? []
              : (['left', 'right', 'top', 'bottom'] as const).map((direction) => (
                  <option
                    key={`split:${targetPane.id}:${direction}`}
                    value={`split:${targetPane.id}:${direction}`}
                  >
                    {messages.workspaceShell.tab.splitPane(
                      paneLabel(targetPane, workspace),
                      direction
                    )}
                  </option>
                ))
          )}
        </select>
      </span>
      <button
        aria-label={messages.workspaceShell.tab.close(title)}
        className="tab-close"
        onClick={() =>
          void onMutation(
            window.desktopBridge.closeTab({ workspaceId: workspace.id, tabId: tab.id })
          )
        }
        type="button"
      >
        <X size={11} />
      </button>
    </div>
  )
}

type SortableListeners = ReturnType<typeof useSortable>['listeners']

/**
 * Whole-surface drag activation. Only pointer activators are forwarded so
 * Enter/Space keep their click semantics on rows and tabs; the dedicated grip
 * keeps the full listener set for keyboard-driven dragging.
 */
function pointerDragListeners(listeners: SortableListeners): NonNullable<SortableListeners> {
  if (!listeners) return {}
  const pointer = { ...listeners }
  delete pointer.onKeyDown
  return pointer
}

function tabDragId(tabId: string): string {
  return `workspace-tab:${tabId}`
}

function tabDomId(tabId: string): string {
  return `workspace-tab-control-${tabId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function panePanelDomId(paneId: string): string {
  return `workspace-tab-panel-${paneId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function paneDropId(paneId: string, zone: PaneDropZone): string {
  return `pane-drop:${paneId}:${zone}`
}

function paneLabel(pane: PaneSnapshot, workspace: WorkspaceSnapshot): string {
  return (
    pane.title ??
    messages.workspaceShell.pane.unnamed(
      workspace.panes.findIndex((candidate) => candidate.id === pane.id) + 1
    )
  )
}

function PaneDropTargets({
  active,
  pane,
  source
}: {
  active: boolean
  pane: PaneSnapshot
  source: TabMutationSource | null
}): React.JSX.Element {
  const invalidSelfSplit = source?.sourcePaneId === pane.id && pane.tabIds.length === 1
  return (
    <div className={active ? 'pane-drop-targets active' : 'pane-drop-targets'} aria-hidden="true">
      <PaneDropTarget active={active} paneId={pane.id} zone="move" />
      {(['left', 'right', 'top', 'bottom'] as const).map((zone) => (
        <PaneDropTarget
          active={active && !invalidSelfSplit}
          disabled={invalidSelfSplit}
          key={zone}
          paneId={pane.id}
          zone={zone}
        />
      ))}
    </div>
  )
}

function PaneDropTarget({
  active,
  disabled = false,
  paneId,
  zone
}: {
  active: boolean
  disabled?: boolean
  paneId: string
  zone: PaneDropZone
}): React.JSX.Element {
  const { isOver, setNodeRef } = useDroppable({
    id: paneDropId(paneId, zone),
    data: { type: 'pane-drop-zone', paneId, zone },
    disabled
  })
  return (
    <div
      className={`pane-drop-target ${zone}${active ? ' available' : ''}${isOver ? ' over' : ''}`}
      ref={setNodeRef}
    >
      <span>{messages.workspaceShell.pane.dropTarget(zone)}</span>
    </div>
  )
}

function TabContent({
  browserVisible,
  onMutation,
  onProcessTitleChange,
  onTerminalToolsOpenChange,
  tab,
  terminalToolsOpen,
  workspace
}: MutationOwner & {
  browserVisible: boolean
  onProcessTitleChange: ProcessTitleHandler
  onTerminalToolsOpenChange: (open: boolean) => void
  tab: TabSnapshot
  terminalToolsOpen: boolean
  workspace: WorkspaceSnapshot
}): React.JSX.Element {
  if (tab.content.kind === 'browser') {
    return (
      <BrowserPane
        onError={(error) => useProjectionStore.getState().reportMutationError(error)}
        onMutation={onMutation}
        state={tab.content.state}
        tabId={tab.id}
        visible={browserVisible}
        workspaceId={workspace.id}
      />
    )
  }
  const terminalId = tab.content.runtimeSessionId
  return terminalId ? (
    <TerminalPane
      key={terminalId}
      onMutation={onMutation}
      onProcessTitleChange={(title) => onProcessTitleChange(tab.id, title)}
      onToolsOpenChange={onTerminalToolsOpenChange}
      tabId={tab.id}
      terminalId={terminalId}
      title={tab.customTitle ?? tab.title}
      toolsOpen={terminalToolsOpen}
      workspaceId={workspace.id}
    />
  ) : (
    <div className="browser-placeholder">
      <TerminalSquare size={28} />
      <h2>{messages.workspaceShell.unavailableTerminal.title}</h2>
      <p>{messages.workspaceShell.unavailableTerminal.body}</p>
      <Button
        onClick={() =>
          void onMutation(
            window.desktopBridge.restartTerminal({ workspaceId: workspace.id, tabId: tab.id })
          )
        }
      >
        {messages.workspaceShell.unavailableTerminal.restart}
      </Button>
    </div>
  )
}

function EmptyWorkspace({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div className="empty-state">
      <span className="mark large" aria-hidden="true" />
      <h1>{messages.workspaceShell.emptyWorkspace.title}</h1>
      <p>{messages.workspaceShell.emptyWorkspace.body}</p>
      <Button onClick={onCreate} variant="primary">
        <Plus size={15} /> {messages.workspaceShell.emptyWorkspace.create}
      </Button>
    </div>
  )
}

function EmptyPane({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <div className="empty-pane">
      <TerminalSquare size={24} />
      <span>{messages.workspaceShell.emptyPane.title}</span>
      <Button onClick={onAdd} size="small">
        {messages.workspaceShell.emptyPane.newTerminal}
      </Button>
    </div>
  )
}

function MoveTabToWindowDialog({
  getFreshTopology,
  onMoved,
  onOpenChange,
  request
}: {
  getFreshTopology: () => Promise<WindowListResult | null>
  onMoved: (operation: Promise<unknown>) => Promise<void>
  onOpenChange: (open: boolean) => void
  request: WindowMoveDialogState | null
}): React.JSX.Element {
  const destinations =
    request?.topology.windows.filter(({ windowId }) => windowId !== request.source.windowId) ?? []
  const [windowId, setWindowId] = useState(destinations[0]?.windowId ?? '')
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const moveTabExact = window.desktopBridge.moveTabExact?.bind(window.desktopBridge)
    if (!request || !moveTabExact) return
    void onMoved(
      (async () => {
        const topology = await getFreshTopology()
        if (!topology) throw new Error('Multi-window topology is unavailable')
        const sourceWindow = topology.windows.find(
          ({ windowId: candidate }) => candidate === request.source.windowId
        )
        const targetWindow = topology.windows.find(
          ({ windowId: candidate }) => candidate === windowId
        )
        if (!sourceWindow || !targetWindow) {
          throw new Error('Tab move placement is unavailable')
        }
        const destination = targetWindow.defaultTabDestination
        return moveTabExact({
          mutation: multiWindowMutation(topology),
          source: { ...request.source, expectedWindowRevision: sourceWindow.revision },
          target: {
            windowId: targetWindow.windowId,
            workspaceId: destination.workspaceId,
            paneId: destination.paneId,
            destinationIndex: destination.destinationIndex,
            expectedWindowRevision: targetWindow.revision
          }
        })
      })()
    ).catch(() => undefined)
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={request !== null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move tab to window</DialogTitle>
          <DialogDescription>Choose the exact destination window for this tab.</DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={submit}>
          <label>
            <span>Destination window</span>
            <select
              autoFocus
              onChange={(event) => setWindowId(event.target.value)}
              value={windowId}
            >
              {destinations.map((destination) => (
                <option key={destination.windowId} value={destination.windowId}>
                  {destination.label}
                </option>
              ))}
            </select>
          </label>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button">
              Cancel
            </Button>
            <Button disabled={!windowId} type="submit" variant="primary">
              Move tab
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CreateWorkspaceDialog({
  fallbackDirectory,
  mode,
  onCreated,
  onCreateSsh,
  onForgetSsh,
  onOpenChange,
  open,
  savedSshWorkspaces,
  workspaceIds
}: {
  fallbackDirectory: string
  mode: 'folder' | 'ssh'
  onCreated: MutationOwner['onMutation']
  onCreateSsh: (name: string, directory: string, profile: SavedSshWorkspace) => Promise<boolean>
  onForgetSsh: (workspaceId: string) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  savedSshWorkspaces: Readonly<Record<string, SavedSshWorkspace>>
  workspaceIds: readonly string[]
}): React.JSX.Element {
  const [directory, setDirectory] = useState('')
  const [sshName, setSshName] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshUser, setSshUser] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshError, setSshError] = useState<string | null>(null)
  const [choosingDirectory, setChoosingDirectory] = useState(false)
  const closedSshWorkspaces = Object.entries(savedSshWorkspaces).filter(
    ([workspaceId]) => !workspaceIds.includes(workspaceId)
  )
  const openDirectory = async (selectedDirectory: string): Promise<void> => {
    const normalizedDirectory = selectedDirectory.trim()
    if (!normalizedDirectory) return
    const created = await onCreated(
      window.desktopBridge.createWorkspace({
        name: workspaceDirectoryBasename(normalizedDirectory),
        workingDirectory: normalizedDirectory,
        initialTerminal: terminalLaunch(normalizedDirectory)
      })
    )
    if (!created) return
    setDirectory('')
    onOpenChange(false)
  }
  const chooseDirectory = async (): Promise<void> => {
    if (!window.desktopBridge.pickWorkspaceDirectory || choosingDirectory) return
    setChoosingDirectory(true)
    try {
      const selectedDirectory = await window.desktopBridge.pickWorkspaceDirectory()
      if (selectedDirectory) await openDirectory(selectedDirectory)
    } catch (error) {
      useProjectionStore.getState().reportMutationError(error)
    } finally {
      setChoosingDirectory(false)
    }
  }
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (mode === 'ssh') {
      try {
        const profile = parseSshWorkspace(sshHost, sshUser, Number(sshPort))
        const name = sshName.trim() || profile.host
        if (name.length > MAX_WORKSPACE_NAME_CHARS) {
          throw new Error('Workspace name is too long.')
        }
        setSshError(null)
        if (await onCreateSsh(name, fallbackDirectory, profile)) {
          setSshName('')
          setSshHost('')
          setSshUser('')
          setSshPort('22')
          onOpenChange(false)
        }
      } catch (error) {
        setSshError(error instanceof Error ? error.message : 'Invalid SSH workspace')
      }
      return
    }
    await openDirectory(directory)
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'ssh'
              ? 'Create SSH workspace'
              : messages.workspaceShell.createWorkspace.title}
          </DialogTitle>
          <DialogDescription>
            {mode === 'ssh'
              ? 'Create a pinned workspace with a fresh OpenSSH shell. Existing keys and host verification stay with OpenSSH. For managed tmux resume, use Settings > Remote sessions.'
              : messages.workspaceShell.createWorkspace.description}
          </DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={(event) => void submit(event)}>
          {mode === 'ssh' ? (
            <>
              <label>
                <span>Workspace name</span>
                <input
                  autoFocus
                  maxLength={MAX_WORKSPACE_NAME_CHARS}
                  onChange={(event) => setSshName(event.target.value)}
                  placeholder="Production server"
                  value={sshName}
                />
              </label>
              <label>
                <span>SSH host or alias</span>
                <input
                  autoComplete="off"
                  maxLength={253}
                  onChange={(event) => setSshHost(event.target.value)}
                  placeholder="my-server"
                  required
                  spellCheck={false}
                  value={sshHost}
                />
              </label>
              <label>
                <span>Username (optional)</span>
                <input
                  autoComplete="username"
                  maxLength={64}
                  onChange={(event) => setSshUser(event.target.value)}
                  placeholder="Use SSH config or local username"
                  spellCheck={false}
                  value={sshUser}
                />
              </label>
              <label>
                <span>Port</span>
                <input
                  max={65535}
                  min={1}
                  onChange={(event) => setSshPort(event.target.value)}
                  required
                  type="number"
                  value={sshPort}
                />
              </label>
              {sshError ? <p role="alert">{sshError}</p> : null}
            </>
          ) : (
            <>
              <Button
                className="workspace-folder-picker"
                disabled={choosingDirectory || !window.desktopBridge.pickWorkspaceDirectory}
                onClick={() => void chooseDirectory()}
                variant="primary"
              >
                <FolderOpen size={16} />
                {choosingDirectory
                  ? messages.workspaceShell.createWorkspace.choosingFolder
                  : messages.workspaceShell.createWorkspace.chooseFolder}
              </Button>
              <div className="workspace-path-divider">
                {messages.workspaceShell.createWorkspace.manualDivider}
              </div>
              <label>
                <span>{messages.workspaceShell.createWorkspace.workingDirectory}</span>
                <input
                  autoFocus={!window.desktopBridge.pickWorkspaceDirectory}
                  onChange={(event) => setDirectory(event.target.value)}
                  placeholder={
                    fallbackDirectory === '/'
                      ? messages.workspaceShell.createWorkspace.workingDirectoryPlaceholder
                      : fallbackDirectory
                  }
                  spellCheck={false}
                  value={directory}
                />
              </label>
            </>
          )}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button">
              {messages.workspaceShell.createWorkspace.cancel}
            </Button>
            <Button
              disabled={mode === 'ssh' ? !sshHost.trim() : !directory.trim()}
              type="submit"
              variant="primary"
            >
              {mode === 'ssh' ? 'Create and pin' : messages.workspaceShell.createWorkspace.create}
            </Button>
          </DialogFooter>
        </form>
        {mode === 'ssh' && closedSshWorkspaces.length > 0 ? (
          <section aria-label="Previously saved SSH connections" className="saved-ssh-connections">
            <h3>Previously saved connections</h3>
            <p>
              Closing a workspace keeps its connection details so you can reuse or remove them here.
            </p>
            <ul>
              {closedSshWorkspaces.map(([workspaceId, profile]) => (
                <li key={workspaceId}>
                  <span>
                    {profile.user ? `${profile.user}@` : ''}
                    {profile.host}:{profile.port}
                  </span>
                  <Button
                    onClick={() => {
                      setSshName(profile.host)
                      setSshHost(profile.host)
                      setSshUser(profile.user)
                      setSshPort(String(profile.port))
                    }}
                    size="small"
                    type="button"
                  >
                    Use details
                  </Button>
                  <Button
                    aria-label={`Remove saved SSH details for ${profile.host}`}
                    onClick={() => onForgetSsh(workspaceId)}
                    size="small"
                    type="button"
                    variant="destructive"
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EditSshWorkspaceDialog({
  onOpenChange,
  onSave,
  open,
  profile,
  workspaceId
}: {
  onOpenChange: (open: boolean) => void
  onSave: (workspaceId: string, profile: SavedSshWorkspace) => boolean
  open: boolean
  profile: SavedSshWorkspace | undefined
  workspaceId: string | null
}): React.JSX.Element {
  const [host, setHost] = useState(profile?.host ?? '')
  const [user, setUser] = useState(profile?.user ?? '')
  const [port, setPort] = useState(String(profile?.port ?? 22))
  const [error, setError] = useState<string | null>(null)
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!workspaceId) return
    try {
      const next = parseSshWorkspace(host, user, Number(port))
      setError(null)
      if (onSave(workspaceId, next)) onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid SSH connection')
    }
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit SSH connection</DialogTitle>
          <DialogDescription>
            New shells use these details. Existing SSH tabs keep running with their original
            command.
          </DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={submit}>
          <label>
            <span>SSH host or alias</span>
            <input
              autoFocus
              maxLength={253}
              onChange={(event) => setHost(event.target.value)}
              required
              spellCheck={false}
              value={host}
            />
          </label>
          <label>
            <span>Username (optional)</span>
            <input
              autoComplete="username"
              maxLength={64}
              onChange={(event) => setUser(event.target.value)}
              spellCheck={false}
              value={user}
            />
          </label>
          <label>
            <span>Port</span>
            <input
              max={65535}
              min={1}
              onChange={(event) => setPort(event.target.value)}
              required
              type="number"
              value={port}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button">
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Save connection
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CommandPalette({
  context,
  executionGuardRef,
  onExecuted,
  onInvokePublicAction,
  onOpenChange,
  open,
  publicActions,
  recentCommandIds
}: {
  context: CommandContext
  executionGuardRef: { current: boolean }
  onExecuted: (commandId: string) => void
  onInvokePublicAction: (definition: ActionDefinition) => Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
  publicActions: readonly ActionDefinition[]
  recentCommandIds: readonly string[]
}): React.JSX.Element {
  const releaseClose = useRef<(() => void) | undefined>(undefined)
  // The palette is keyed by open state, so an execution's close-wait must not
  // outlive this instance: resolve any pending close on unmount or execute()
  // would await a callback that can no longer fire.
  useEffect(() => () => releaseClose.current?.(), [])
  const [query, setQuery] = useState('')
  const publicCommands = useMemo(
    () => publicActionCommands(publicActions, onInvokePublicAction),
    [onInvokePublicAction, publicActions]
  )
  const matches = searchCommands(
    [...DEFAULT_COMMANDS, ...publicCommands.map(({ command }) => command)],
    query,
    recentCommandIds,
    context
  )
  const publicCommandIds = new Set(publicCommands.map(({ command }) => command.id))
  const availableIndices = matches.flatMap((match, index) => (match.available ? [index] : []))
  const [requestedActiveIndex, setRequestedActiveIndex] = useState(0)
  const activeIndex = matches[requestedActiveIndex]?.available
    ? requestedActiveIndex
    : (availableIndices[0] ?? -1)
  const activeCommandId = matches[activeIndex]?.command.id ?? null
  const moveActive = (action: 'next' | 'previous' | 'home' | 'end'): void => {
    if (availableIndices.length === 0) return
    const currentAvailableIndex = availableIndices.indexOf(activeIndex)
    const nextAvailableIndex = rovingFocusIndex(
      currentAvailableIndex,
      availableIndices.length,
      action
    )
    const nextIndex = availableIndices[nextAvailableIndex]
    if (nextIndex !== undefined) setRequestedActiveIndex(nextIndex)
  }
  const execute = async (commandId: string): Promise<void> => {
    if (executionGuardRef.current) return
    executionGuardRef.current = true

    try {
      if (commandId === 'commandPalette.toggle') {
        onOpenChange(false)
        onExecuted(commandId)
        return
      }

      const close = new Promise<void>((resolve) => {
        releaseClose.current = resolve
      })
      onOpenChange(false)
      await close

      const publicCommand = publicCommands.find(({ command }) => command.id === commandId)
      const result = publicCommand
        ? await Promise.resolve(publicCommand.command.handler(context))
            .then(() => ({ status: 'executed' as const }))
            .catch(() => ({ status: 'failed' as const }))
        : await defaultCommandRegistry.execute(commandId as CommandId, context)
      if (result.status === 'executed') {
        onExecuted(commandId)
      } else {
        onOpenChange(true)
      }
    } finally {
      releaseClose.current = undefined
      executionGuardRef.current = false
    }
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="command-dialog"
        data-command-palette="true"
        onCloseAutoFocus={(event) => {
          if (!releaseClose.current) return
          event.preventDefault()
          releaseClose.current()
        }}
        showClose={false}
      >
        <DialogTitle className="sr-only">
          {messages.workspaceShell.commandPalette.title}
        </DialogTitle>
        <div className="command-search">
          <Command size={16} />
          <input
            aria-activedescendant={
              activeCommandId ? commandOptionDomId(activeCommandId) : undefined
            }
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-expanded={open}
            aria-label={messages.workspaceShell.commandPalette.search}
            autoFocus
            onChange={(event) => {
              setRequestedActiveIndex(0)
              setQuery(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                moveActive(event.key === 'ArrowDown' ? 'next' : 'previous')
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                moveActive(event.key === 'Home' ? 'home' : 'end')
              } else if (event.key === 'Enter' && activeCommandId) {
                event.preventDefault()
                void execute(activeCommandId)
              }
            }}
            placeholder={messages.workspaceShell.commandPalette.placeholder}
            role="combobox"
            value={query}
          />
        </div>
        <div
          aria-label={messages.workspaceShell.commandPalette.results}
          className="command-results"
          id="command-palette-results"
          role="listbox"
        >
          {matches.map((match, index) => (
            <button
              aria-disabled={!match.available}
              aria-selected={match.command.id === activeCommandId}
              className="command-result"
              disabled={!match.available}
              id={commandOptionDomId(match.command.id)}
              key={match.command.id}
              onClick={() => void execute(match.command.id)}
              onMouseMove={() => {
                if (match.available) setRequestedActiveIndex(index)
              }}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <span>
                <strong>{match.command.title}</strong>
                <small>{match.unavailableReason ?? match.command.description}</small>
              </span>
              <kbd>
                {publicCommandIds.has(match.command.id)
                  ? 'API'
                  : match.command.defaultShortcut
                    ? shortcutLabel(match.command.defaultShortcut)
                    : ''}
              </kbd>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function commandOptionDomId(commandId: string): string {
  return `command-palette-option-${commandId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

type SettingsSectionId = ConfigurationSettingsSection | 'shortcuts' | 'agents-sessions' | 'remote'

const SETTINGS_SECTIONS: readonly {
  id: SettingsSectionId
  label: string
  keywords: string
}[] = [
  {
    id: 'appearance',
    label: messages.settings.appearance,
    keywords: 'theme density color font family system'
  },
  { id: 'terminal', label: messages.settings.terminal, keywords: 'shell font scrollback paste' },
  {
    id: 'notifications',
    label: messages.settings.notifications,
    keywords: 'alerts system body unread'
  },
  { id: 'shortcuts', label: messages.settings.keyboard, keywords: 'keys commands hotkeys' },
  { id: 'updates', label: messages.settings.updates, keywords: 'version stable beta download' },
  {
    id: 'agents-sessions',
    label: messages.agentSessions.title,
    keywords: 'codex agent thread restore hibernate fork team attention'
  },
  { id: 'remote', label: 'Remote sessions', keywords: 'ssh tmux host key credential' },
  {
    id: 'advanced',
    label: messages.settings.advanced,
    keywords: 'browser agents integrations logging privacy profile'
  }
] as const

export function SettingsDialog({
  agentSessionsEnabled,
  agentWorkspaceContext,
  configurationV2,
  onAgentNavigate,
  onMutation,
  onOpenChange,
  open,
  remoteSessionsEnabled,
  remoteWorkspaceContext,
  shortcuts
}: {
  agentSessionsEnabled: boolean
  agentWorkspaceContext: AgentWorkspaceContext | null
  configurationV2: boolean
  onAgentNavigate: (binding: AgentSessionBinding) => Promise<void>
  onMutation: (operation: MutationOperation) => Promise<boolean>
  onOpenChange: (open: boolean) => void
  open: boolean
  remoteSessionsEnabled: boolean
  remoteWorkspaceContext: RemoteWorkspaceContext | null
  shortcuts: readonly ShortcutSetting[]
}): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance')
  const [settingsQuery, setSettingsQuery] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(shortcuts.map((item) => [item.commandId, item.effectiveShortcut ?? '']))
  )
  const platform: ShortcutPlatform = navigator.platform.toLowerCase().includes('mac')
    ? 'macos'
    : 'other'
  const draftOverrides = shortcutDraftOverrides(drafts)
  const conflicts = findShortcutConflicts(DEFAULT_COMMANDS, draftOverrides, platform)
  const conflictByCommand = new Map(
    conflicts.flatMap((conflict) =>
      conflict.commandIds.map((commandId) => [commandId, conflict.commandIds] as const)
    )
  )
  const save = async (setting: ShortcutSetting): Promise<void> => {
    const value = drafts[setting.commandId]?.trim() ?? ''
    if (value && !parseShortcut(value).valid) return
    if (conflictByCommand.has(setting.commandId as CommandId)) return
    await onMutation(
      window.desktopBridge.updateSettings({
        shortcutOverrides: [{ commandId: setting.commandId, shortcut: value || null }]
      })
    )
  }
  const availableSettingsSections = SETTINGS_SECTIONS.filter(
    ({ id }) =>
      (id !== 'remote' || remoteSessionsEnabled) &&
      (id !== 'agents-sessions' || agentSessionsEnabled)
  )
  const visibleSettingsSections = availableSettingsSections.filter(({ keywords, label }) => {
    const query = settingsQuery.trim().toLocaleLowerCase()
    return !query || `${label} ${keywords}`.toLocaleLowerCase().includes(query)
  })
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="settings-dialog" showClose={false}>
        <aside className="settings-navigation">
          <DialogHeader>
            <DialogTitle>{messages.workspaceShell.settingsShortcuts.title}</DialogTitle>
            <DialogDescription>{messages.settings.description}</DialogDescription>
          </DialogHeader>
          <label className="settings-search">
            <Search aria-hidden="true" size={14} />
            <input
              aria-label={messages.settings.search}
              onChange={(event) => {
                const query = event.currentTarget.value
                setSettingsQuery(query)
                const normalized = query.trim().toLocaleLowerCase()
                const firstMatch = availableSettingsSections.find(({ keywords, label }) =>
                  `${label} ${keywords}`.toLocaleLowerCase().includes(normalized)
                )
                if (normalized && firstMatch) setActiveSection(firstMatch.id)
              }}
              placeholder={messages.settings.search}
              value={settingsQuery}
            />
          </label>
          <nav aria-label={messages.workspaceShell.settingsShortcuts.title}>
            {visibleSettingsSections.map((section) => (
              <button
                aria-current={activeSection === section.id ? 'page' : undefined}
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                type="button"
              >
                <SettingsSectionIcon section={section.id} />
                {section.label}
              </button>
            ))}
          </nav>
        </aside>
        <div className="settings-content">
          <IconButton
            aria-label={messages.ui.closeDialog}
            className="settings-close"
            onClick={() => onOpenChange(false)}
            tooltip={messages.ui.closeDialog}
          >
            <X size={16} />
          </IconButton>
          {visibleSettingsSections.length === 0 ? (
            <p className="settings-empty-search">{messages.settings.noSearchResults}</p>
          ) : activeSection === 'agents-sessions' ? (
            <AgentSessionsSettings
              context={agentWorkspaceContext}
              onNavigate={onAgentNavigate}
              onWorkspaceMutation={onMutation}
              open={open}
            />
          ) : activeSection === 'remote' ? (
            <RemoteSessionsSettings context={remoteWorkspaceContext} open={open} />
          ) : activeSection === 'shortcuts' ? (
            <>
              <div className="settings-content-heading">
                <h2>{messages.workspaceShell.settingsShortcuts.sectionTitle}</h2>
                <p>{messages.settings.description}</p>
              </div>
              <div className="shortcut-list">
                {shortcuts.map((setting) => {
                  const draft = drafts[setting.commandId] ?? ''
                  const parsed = draft ? parseShortcut(draft) : undefined
                  const valid = parsed?.valid ?? true
                  const conflictingCommands = conflictByCommand.get(setting.commandId as CommandId)
                  const conflictMessage =
                    valid && conflictingCommands
                      ? messages.workspaceShell.settingsShortcuts.conflict(
                          conflictingCommands
                            .filter((commandId) => commandId !== setting.commandId)
                            .map(commandTitle)
                        )
                      : undefined
                  const validationId = `shortcut-validation-${setting.commandId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
                  return (
                    <div className="shortcut-row" key={setting.commandId}>
                      <span>
                        <strong>{commandTitle(setting.commandId)}</strong>
                        <small>
                          {messages.workspaceShell.settingsShortcuts.summary(
                            setting.commandId,
                            setting.defaultShortcut
                          )}
                        </small>
                      </span>
                      <input
                        aria-describedby={!valid || conflictMessage ? validationId : undefined}
                        aria-invalid={!valid || Boolean(conflictMessage)}
                        aria-label={messages.workspaceShell.settingsShortcuts.inputLabel(
                          commandTitle(setting.commandId)
                        )}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [setting.commandId]: event.target.value
                          }))
                        }
                        onKeyDown={(event) => {
                          const recorded = shortcutFromKeyboardEvent(event.nativeEvent, platform)
                          if (!recorded) return
                          event.preventDefault()
                          setDrafts((current) => ({
                            ...current,
                            [setting.commandId]: recorded
                          }))
                        }}
                        placeholder="Press shortcut"
                        value={draft}
                      />
                      <Button
                        disabled={!valid || Boolean(conflictMessage)}
                        onClick={() => void save(setting)}
                        size="small"
                      >
                        {messages.workspaceShell.settingsShortcuts.save}
                      </Button>
                      <Button
                        onClick={() => {
                          setDrafts((current) => ({ ...current, [setting.commandId]: '' }))
                          void onMutation(
                            window.desktopBridge.updateSettings({
                              shortcutOverrides: [{ commandId: setting.commandId, shortcut: null }]
                            })
                          )
                        }}
                        size="small"
                        variant="ghost"
                      >
                        {messages.workspaceShell.settingsShortcuts.clear}
                      </Button>
                      <Button
                        aria-label={messages.workspaceShell.settingsShortcuts.reset(
                          setting.commandId
                        )}
                        onClick={() => {
                          setDrafts((current) => ({
                            ...current,
                            [setting.commandId]: setting.defaultShortcut
                          }))
                          void onMutation(
                            window.desktopBridge.resetSettingKey({ commandId: setting.commandId })
                          )
                        }}
                        size="icon"
                        variant="ghost"
                      >
                        <MoreHorizontal size={14} />
                      </Button>
                      {!valid || conflictMessage ? (
                        <small className="shortcut-validation" id={validationId} role="status">
                          {conflictMessage ?? (parsed && !parsed.valid ? parsed.reason : '')}
                        </small>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <>
              <div className="settings-content-heading">
                <h2>{SETTINGS_SECTIONS.find(({ id }) => id === activeSection)?.label}</h2>
                <p>{messages.settings.description}</p>
              </div>
              <ConfigurationSettings
                activeSection={activeSection}
                configurationV2={configurationV2}
                open={open}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SettingsSectionIcon({ section }: { section: SettingsSectionId }): React.JSX.Element {
  if (section === 'appearance') return <Palette aria-hidden="true" size={15} />
  if (section === 'terminal') return <TerminalSquare aria-hidden="true" size={15} />
  if (section === 'notifications') return <Bell aria-hidden="true" size={15} />
  if (section === 'shortcuts') return <Keyboard aria-hidden="true" size={15} />
  if (section === 'updates') return <RefreshCw aria-hidden="true" size={15} />
  if (section === 'agents-sessions') return <Command aria-hidden="true" size={15} />
  if (section === 'remote') return <TerminalSquare aria-hidden="true" size={15} />
  return <SlidersHorizontal aria-hidden="true" size={15} />
}

function shortcutFromKeyboardEvent(
  event: KeyboardEvent,
  platform: ShortcutPlatform
): string | null {
  if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return null
  const modifiers: string[] = []
  if (platform === 'macos' ? event.metaKey : event.ctrlKey) modifiers.push('Primary')
  if (event.altKey) modifiers.push('Secondary')
  if (platform === 'macos' && event.ctrlKey) modifiers.push('Control')
  if (event.shiftKey) modifiers.push('Shift')
  if (modifiers.length === 0) return null
  const parsed = parseShortcut([...modifiers, event.key].join('+'))
  return parsed.valid ? [...parsed.shortcut.modifiers, parsed.shortcut.key].join('+') : null
}

function shortcutDraftOverrides(drafts: Readonly<Record<string, string>>): ShortcutOverrides {
  const overrides: ShortcutOverrides = {}
  for (const command of DEFAULT_COMMANDS) {
    const value = drafts[command.id]?.trim()
    if (!value) {
      overrides[command.id] = null
      continue
    }
    const parsed = parseShortcut(value)
    if (parsed.valid) overrides[command.id] = parsed.shortcut
  }
  return overrides
}

function commandTitle(commandId: string): string {
  return DEFAULT_COMMANDS.find((command) => command.id === commandId)?.title ?? commandId
}

function shortcutOverrides(settings: readonly ShortcutSetting[]): ShortcutOverrides {
  const entries: [string, Shortcut | null][] = []
  for (const setting of settings) {
    if (setting.overrideState.kind === 'default') continue
    if (setting.overrideState.kind === 'cleared') {
      entries.push([setting.commandId, null])
      continue
    }
    const parsed = parseShortcut(setting.overrideState.shortcut)
    if (parsed.valid) entries.push([setting.commandId, parsed.shortcut])
  }
  return Object.fromEntries(entries)
}

function shortcutLabel(shortcut: { modifiers: readonly string[]; key: string }): string {
  return [...shortcut.modifiers, shortcut.key].join('+')
}
