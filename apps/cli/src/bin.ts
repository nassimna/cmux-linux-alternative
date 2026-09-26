#!/usr/bin/env node

import { randomUUID } from 'node:crypto'

import {
  AgentWorkspaceClient,
  ServerError,
  readNodeSessionFile,
  resolveNodeSessionFile
} from '@agent-workspace/client-runtime'
import {
  searchQueryParamsSchema,
  searchCancelParamsSchema,
  searchSourcePolicyParamsSchema,
  searchSourceMutationParamsSchema,
  searchRebuildParamsSchema,
  searchExportParamsSchema,
  searchExportConfirmationIssueParamsSchema,
  remoteTargetDeleteParamsSchema,
  remoteSessionConnectParamsSchema,
  remoteSessionReconnectParamsSchema,
  remoteSessionDetachParamsSchema,
  remoteSessionCloseParamsSchema,
  remoteHostKeyScanParamsSchema,
  remoteHostKeyTrustParamsSchema,
  remoteTmuxDiscoverParamsSchema,
  workspaceDirectoryListParamsSchema,
  contentDocumentIssueParamsSchema,
  contentReadParamsSchema,
  contentSaveParamsSchema,
  contentMarkdownParamsSchema,
  contentDiffParamsSchema,
  taskListParamsSchema,
  taskConfirmationIssueParamsSchema,
  taskActionParamsSchema,
  notificationPublishRequestSchema
} from '@agent-workspace/contracts'
import { runJsonMutation, supportsJsonMutation } from './json-mutations'
import {
  parseBrowserAutomation,
  runBrowserAutomation,
  type BrowserAutomationCommand
} from './browser-automation'
import { flags, jsonParams, required } from './options'
import {
  parseClaudeNotice,
  parseCodexNotice,
  readClaudeHookInput,
  type HookNotice
} from './hook-notice'
import { hookInstall, hookStatus, hookUninstall, integration } from './hook-management'
import { parseLayoutCommand, runLayoutCommand, type LayoutCommand } from './layout-commands'
import {
  parseOrganizationCommand,
  runOrganizationCommand,
  type OrganizationCommand
} from './organization-commands'
import { parseParityCommand, runParityCommand, type ParityCommand } from './parity-commands'
import {
  parseRustNamedCommand,
  runRustNamedCommand,
  rustNamedNeedsWindowCapability,
  type RustNamedCommand
} from './rust-named-commands'

const HELP = `Agent Workspace CLI

Usage:
  agent-workspace-cli [--session-file PATH] identify
  agent-workspace-cli [--session-file PATH] state snapshot
  agent-workspace-cli [--session-file PATH] settings get
  agent-workspace-cli [--session-file PATH] closed list
  agent-workspace-cli [--session-file PATH] closed get --closed-item-id UUID
  agent-workspace-cli [--session-file PATH] request tab.reopen --params-json JSON
  agent-workspace-cli [--session-file PATH] request settings.update|settings.resetKey --params-json JSON
  agent-workspace-cli [--session-file PATH] notification list --window-id UUID [--workspace-id UUID] [--unread-only true|false] [--offset N] [--limit N]
  agent-workspace-cli [--session-file PATH] notify --title TEXT [--body TEXT] [--level info|warning|error] [--window-id UUID] [--workspace-id UUID] [--pane-id UUID] [--tab-id UUID]
  agent-workspace-cli [--session-file PATH] hook codex JSON_PAYLOAD
  agent-workspace-cli [--session-file PATH] hook claude < JSON_PAYLOAD
  agent-workspace-cli hook install|uninstall|status codex|claude
  agent-workspace-cli [--session-file PATH] request notification.publish|notification.markRead|notification.markUnread|notification.clear --params-json JSON
  agent-workspace-cli [--session-file PATH] workspace list
  agent-workspace-cli [--session-file PATH] workspace organization
  agent-workspace-cli [--session-file PATH] workspace create --name NAME --working-directory PATH [--terminal-cwd PATH] [--description TEXT] [--color COLOR] [--rows N] [--cols N] [--expected-revision N] [--idempotency-key UUID] [--command PROGRAM ARG...]
  agent-workspace-cli [--session-file PATH] workspace pin --workspace-id UUID --pinned true|false --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] workspace reorder --workspace-id UUID --destination-index N --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] workspace select-many --workspace-id UUID [--workspace-id UUID ...] --focused-workspace-id UUID --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] workspace close-selected --expected-revision N [--idempotency-key UUID] [--replacement-name NAME --replacement-working-directory PATH [--replacement-description TEXT] [--replacement-color COLOR] [--replacement-terminal-cwd PATH] [--replacement-rows N] [--replacement-cols N] [--replacement-command PROGRAM ARG...]]
  agent-workspace-cli [--session-file PATH] group create|rename --group-id UUID --name NAME --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] group delete --group-id UUID --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] group move --group-id UUID --destination-index N --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] group collapse --group-id UUID --collapsed true|false --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] group assign --workspace-id UUID [--group-id UUID] --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] layout list
  agent-workspace-cli [--session-file PATH] layout get --layout-id UUID
  agent-workspace-cli [--session-file PATH] layout export --layout-id UUID
  agent-workspace-cli [--session-file PATH] layout save --layout-id UUID --name NAME --workspace-id UUID [--workspace-id UUID ...] --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] layout delete|apply --layout-id UUID --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] layout import --layout-id UUID --file PATH --expected-revision N [--idempotency-key UUID]
  agent-workspace-cli [--session-file PATH] remote target list [--limit N] [--cursor UUID]
  agent-workspace-cli [--session-file PATH] remote target get --target-id UUID
  agent-workspace-cli [--session-file PATH] remote target delete --params-json JSON
  agent-workspace-cli [--session-file PATH] remote session list [--limit N] [--cursor UUID]
  agent-workspace-cli [--session-file PATH] remote session get --session-id UUID
  agent-workspace-cli [--session-file PATH] remote session terminal --session-id UUID
  agent-workspace-cli [--session-file PATH] remote session prepare --params-json JSON
  agent-workspace-cli [--session-file PATH] remote session activate --params-json JSON
  agent-workspace-cli [--session-file PATH] remote session detach --params-json JSON
  agent-workspace-cli [--session-file PATH] remote session close --params-json JSON
  agent-workspace-cli [--session-file PATH] remote host-key scan --params-json JSON
  agent-workspace-cli [--session-file PATH] remote host-key decide --params-json JSON
  agent-workspace-cli [--session-file PATH] remote tmux discover --params-json JSON
  agent-workspace-cli [--session-file PATH] agent catalog list
  agent-workspace-cli [--session-file PATH] agent catalog get --session-id UUID
  agent-workspace-cli [--session-file PATH] agent catalog-register|restore-assess|restore|fork|hibernate-preflight|hibernate-confirm|hibernate-cancel --params-json JSON
  agent-workspace-cli [--session-file PATH] agent team-create|team-update|team-delete|member-create|member-update|member-move|member-delete|attention-set --params-json JSON
  agent-workspace-cli [--session-file PATH] remote target-list|target-get|target-create|target-delete|session-list|session-get|session-connect|session-reconnect|session-detach|session-close|host-key-decide|tmux-discover --params-json JSON
  agent-workspace-cli [--session-file PATH] sidebar recently-closed-list|recently-closed-reopen --params-json JSON
  agent-workspace-cli [--session-file PATH] request agent.catalog.register --params-json JSON
  agent-workspace-cli [--session-file PATH] request agent.restore.assess --params-json JSON
  agent-workspace-cli [--session-file PATH] request agent.session.restore --params-json JSON
  agent-workspace-cli [--session-file PATH] request agent.session.fork --params-json JSON
  agent-workspace-cli [--session-file PATH] request workspace.cardSlots.get|workspace.cardSlots.replace|workspace.cardSlots.v2.get|workspace.cardSlots.v2.replace --params-json JSON
  agent-workspace-cli [--session-file PATH] request workspace.attention.get|attention.acknowledge --params-json JSON
  agent-workspace-cli [--session-file PATH] request agent.team.create|agent.team.update|agent.team.delete --params-json JSON
  agent-workspace-cli [--session-file PATH] request agent.team.member.create|agent.team.member.update|agent.team.member.move|agent.team.member.delete --params-json JSON
  agent-workspace-cli [--session-file PATH] action list [--limit N] [--cursor TOKEN]
  agent-workspace-cli [--session-file PATH] action invoke --action-id ID --action-version N --idempotency-epoch UUID [--parameters-json JSON] [--idempotency-key UUID] [--correlation-id UUID] [--target-window-id UUID --target-window-generation N]
  agent-workspace-cli [--session-file PATH] action cancel --invocation-id UUID --correlation-id UUID
  agent-workspace-cli [--session-file PATH] request action.invoke --params-json JSON
  agent-workspace-cli [--session-file PATH] request action.cancel --params-json JSON
  agent-workspace-cli [--session-file PATH] task list|confirm|action --params-json JSON
  agent-workspace-cli [--session-file PATH] search query|cancel|policy|exclude|forget|rebuild|export-confirm|export --params-json JSON
  agent-workspace-cli [--session-file PATH] sidebar placement list
  agent-workspace-cli [--session-file PATH] sidebar placement get --window-id UUID
  agent-workspace-cli [--session-file PATH] files roots [--limit N] [--cursor UUID]
  agent-workspace-cli [--session-file PATH] files directory|issue|read|save|markdown|diff --params-json JSON
  agent-workspace-cli [--session-file PATH] request sidebar.placement.save --params-json JSON
  agent-workspace-cli [--session-file PATH] textbox list [--limit N] [--cursor UUID]
  agent-workspace-cli [--session-file PATH] textbox get --document-id UUID
  agent-workspace-cli [--session-file PATH] request textbox.create|textbox.save|textbox.delete --params-json JSON
  agent-workspace-cli [--session-file PATH] request CAPABILITY --params-json JSON
  agent-workspace-cli [--session-file PATH] terminal create --workspace-id UUID --pane-id UUID --cwd PATH [--rows N] [--cols N] [--destination-index N] [--expected-revision N] [--idempotency-key UUID] [--command PROGRAM ARG...]
  agent-workspace-cli [--session-file PATH] terminal send --terminal-id UUID --data TEXT
  agent-workspace-cli [--session-file PATH] pane split --workspace-id UUID --target-pane-id UUID --axis horizontal|vertical [--placement before|after] [--ratio R] --expected-revision N [--idempotency-key UUID] terminal --cwd PATH [--rows N] [--cols N] [--command PROGRAM ARG...]
  agent-workspace-cli [--session-file PATH] pane split --workspace-id UUID --target-pane-id UUID --axis horizontal|vertical [--placement before|after] [--ratio R] --expected-revision N [--idempotency-key UUID] browser --url URL [--profile-partition PARTITION]
  agent-workspace-cli [--session-file PATH] pane split --workspace-id UUID --target-pane-id UUID --axis horizontal|vertical [--placement before|after] [--ratio R] --expected-revision N [--idempotency-key UUID] existing-tab --tab-id UUID
  agent-workspace-cli [--session-file PATH] browser-automation list
  agent-workspace-cli [--session-file PATH] browser-automation create|get|execute|cancel|read|release|destroy --params-json JSON

On Linux, --session-file is optional when the desktop published its private Node
discovery record. AGENT_WORKSPACE_NODE_SESSION_FILE can override that path. The record must be
owned by the current user and readable only by that user. Notifications use the
focused window/workspace unless --window-id/--workspace-id or
AGENT_WORKSPACE_WINDOW_ID/AGENT_WORKSPACE_WORKSPACE_ID selects a target. Pane/tab
IDs may also come from AGENT_WORKSPACE_PANE_ID/AGENT_WORKSPACE_TAB_ID. Hook input
is bounded to 64 KiB; hooks publish at info level. Task commands also require
AGENT_WORKSPACE_WINDOW_CAPABILITY from the private window owner channel.`

interface TerminalCreateOptions {
  workspaceId: string
  paneId: string
  cwd: string
  rows: number
  cols: number
  destinationIndex?: number
  expectedRevision?: number
  idempotencyKey?: string
  command?: string[]
}

interface WorkspaceCreateOptions {
  name: string
  workingDirectory: string
  terminalCwd?: string
  description?: string
  color?: string
  rows: number
  cols: number
  expectedRevision?: number
  idempotencyKey?: string
  command?: string[]
}

interface RevisionOptions {
  workspaceId: string
  expectedRevision: number
  idempotencyKey?: string
}

interface NotificationOptions {
  title: string
  body?: string
  level: 'info' | 'warning' | 'error'
  windowId?: string
  workspaceId?: string
  paneId?: string
  tabId?: string
}

type Parsed =
  | {
      sessionFile: string
      command:
        | 'identify'
        | 'state.snapshot'
        | 'settings.get'
        | 'closed.list'
        | 'workspace.list'
        | 'workspace.organization'
    }
  | { sessionFile: string; command: 'workspace.create'; options: WorkspaceCreateOptions }
  | {
      sessionFile: string
      command: 'workspace.pin'
      options: RevisionOptions & { pinned: boolean }
    }
  | {
      sessionFile: string
      command: 'workspace.reorder'
      options: RevisionOptions & { destinationIndex: number }
    }
  | {
      sessionFile: string
      command: 'remote.target.list' | 'remote.session.list'
      limit: number
      cursor?: string
    }
  | { sessionFile: string; command: 'remote.target.get'; targetId: string }
  | { sessionFile: string; command: 'remote.session.get'; sessionId: string }
  | { sessionFile: string; command: 'remote.session.terminal'; sessionId: string }
  | { sessionFile: string; command: 'layout.list' }
  | { sessionFile: string; command: 'layout.get' | 'layout.export'; layoutId: string }
  | { sessionFile: string; command: 'closed.get'; closedItemId: string }
  | { sessionFile: string; command: 'agent.catalog.list' }
  | { sessionFile: string; command: 'agent.catalog.get'; sessionId: string }
  | { sessionFile: string; command: 'action.list'; limit: number; cursor?: string }
  | { sessionFile: string; command: 'notify'; options: NotificationOptions }
  | { sessionFile: string; command: 'hook.codex'; payload: string }
  | { sessionFile: string; command: 'hook.claude' }
  | {
      sessionFile: string
      command: 'hook.install' | 'hook.uninstall' | 'hook.status'
      agent: 'codex' | 'claude'
    }
  | { sessionFile: string; command: 'task.list' | 'task.confirm' | 'task.action'; params: unknown }
  | {
      sessionFile: string
      command:
        | 'search.query'
        | 'search.cancel'
        | 'search.policy'
        | 'search.exclude'
        | 'search.forget'
        | 'search.rebuild'
        | 'search.export-confirm'
        | 'search.export'
      params: unknown
    }
  | {
      sessionFile: string
      command: 'notification.list'
      windowId: string
      workspaceId?: string
      unreadOnly: boolean
      offset: number
      limit: number
    }
  | { sessionFile: string; command: 'sidebar.placement.list' }
  | { sessionFile: string; command: 'sidebar.placement.get'; windowId: string }
  | { sessionFile: string; command: 'content.root.list'; limit: number; cursor?: string }
  | {
      sessionFile: string
      command:
        | 'content.directory.list'
        | 'content.document.issue'
        | 'content.read'
        | 'content.save'
        | 'content.markdown'
        | 'content.diff'
      params: unknown
    }
  | { sessionFile: string; command: 'textbox.list'; limit: number; cursor?: string }
  | { sessionFile: string; command: 'textbox.get'; documentId: string }
  | {
      sessionFile: string
      command:
        | 'remote.target.delete'
        | 'remote.session.prepare'
        | 'remote.session.activate'
        | 'remote.session.detach'
        | 'remote.session.close'
        | 'remote.hostKey.scan'
        | 'remote.hostKey.decide'
        | 'remote.tmux.discover'
      params: unknown
    }
  | { sessionFile: string; command: 'terminal.create'; options: TerminalCreateOptions }
  | { sessionFile: string; command: 'terminal.send'; terminalId: string; data: string }
  | BrowserAutomationCommand
  | OrganizationCommand
  | LayoutCommand
  | ParityCommand
  | RustNamedCommand
  | { sessionFile: string; command: 'json.mutation'; capability: string; params: unknown }

function integerOption(value: string, label: string, minimum: number): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be an integer at least ${minimum}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer at least ${minimum}`)
  }
  return parsed
}

function parseTerminalCreate(args: string[]): TerminalCreateOptions {
  const { values, command } = flags(
    args,
    [
      '--workspace-id',
      '--pane-id',
      '--cwd',
      '--rows',
      '--cols',
      '--destination-index',
      '--expected-revision',
      '--idempotency-key'
    ],
    true
  )
  if (values.has('--idempotency-key') && !values.has('--expected-revision')) {
    throw new Error('--idempotency-key requires --expected-revision for safe retries')
  }
  return {
    workspaceId: required(values, '--workspace-id'),
    paneId: required(values, '--pane-id'),
    cwd: required(values, '--cwd'),
    rows: integerOption(values.get('--rows') ?? '24', '--rows', 1),
    cols: integerOption(values.get('--cols') ?? '80', '--cols', 1),
    ...(values.has('--destination-index')
      ? {
          destinationIndex: integerOption(
            values.get('--destination-index')!,
            '--destination-index',
            0
          )
        }
      : {}),
    ...(values.has('--expected-revision')
      ? {
          expectedRevision: integerOption(
            values.get('--expected-revision')!,
            '--expected-revision',
            0
          )
        }
      : {}),
    ...(values.has('--idempotency-key')
      ? { idempotencyKey: values.get('--idempotency-key')! }
      : {}),
    ...(command ? { command } : {})
  }
}

function parseWorkspaceCreate(args: string[]): WorkspaceCreateOptions {
  const { values, command } = flags(
    args,
    [
      '--name',
      '--working-directory',
      '--terminal-cwd',
      '--description',
      '--color',
      '--rows',
      '--cols',
      '--expected-revision',
      '--idempotency-key'
    ],
    true
  )
  if (values.has('--idempotency-key') && !values.has('--expected-revision')) {
    throw new Error('--idempotency-key requires --expected-revision for safe retries')
  }
  return {
    name: required(values, '--name'),
    workingDirectory: required(values, '--working-directory'),
    rows: integerOption(values.get('--rows') ?? '24', '--rows', 1),
    cols: integerOption(values.get('--cols') ?? '80', '--cols', 1),
    ...(values.has('--terminal-cwd') ? { terminalCwd: values.get('--terminal-cwd')! } : {}),
    ...(values.has('--description') ? { description: values.get('--description')! } : {}),
    ...(values.has('--color') ? { color: values.get('--color')! } : {}),
    ...(values.has('--expected-revision')
      ? {
          expectedRevision: integerOption(
            values.get('--expected-revision')!,
            '--expected-revision',
            0
          )
        }
      : {}),
    ...(values.has('--idempotency-key')
      ? { idempotencyKey: values.get('--idempotency-key')! }
      : {}),
    ...(command ? { command } : {})
  }
}

function parseWorkspaceRevision(args: string[], extra: '--pinned' | '--destination-index') {
  const { values } = flags(args, [
    '--workspace-id',
    extra,
    '--expected-revision',
    '--idempotency-key'
  ])
  return {
    workspaceId: required(values, '--workspace-id'),
    expectedRevision: integerOption(
      required(values, '--expected-revision'),
      '--expected-revision',
      0
    ),
    ...(values.has('--idempotency-key')
      ? { idempotencyKey: values.get('--idempotency-key')! }
      : {}),
    value: required(values, extra)
  }
}

function parse(argv: string[]): Parsed {
  const args = [...argv]
  let sessionFile = process.env.AGENT_WORKSPACE_NODE_SESSION_FILE
  const commandIndex = args.findIndex(
    (arg) => arg === '--command' || arg === '--replacement-command'
  )
  const pathIndex = args
    .slice(0, commandIndex < 0 ? undefined : commandIndex)
    .indexOf('--session-file')
  if (pathIndex >= 0) {
    sessionFile = args[pathIndex + 1]
    args.splice(pathIndex, 2)
  }
  if (sessionFile?.startsWith('--')) {
    throw new Error('Invalid private Node session file path')
  }
  sessionFile = resolveNodeSessionFile(sessionFile)
  if (args.length === 1 && args[0] === 'identify') {
    return { sessionFile, command: 'identify' }
  }
  const browserAutomation = parseBrowserAutomation(args, sessionFile)
  if (browserAutomation) return browserAutomation
  const organization = parseOrganizationCommand(args, sessionFile)
  if (organization) return organization
  const layoutMutation = parseLayoutCommand(args, sessionFile)
  if (layoutMutation) return layoutMutation
  const parityMutation = parseParityCommand(args, sessionFile)
  if (parityMutation) return parityMutation
  const rustNamed = parseRustNamedCommand(args, sessionFile)
  if (rustNamed) return rustNamed
  if (args[0] === 'notify') {
    const { values } = flags(args.slice(1), [
      '--title',
      '--body',
      '--level',
      '--window-id',
      '--workspace-id',
      '--pane-id',
      '--tab-id'
    ])
    const level = values.get('--level') ?? 'info'
    if (level !== 'info' && level !== 'warning' && level !== 'error') {
      throw new Error('--level must be info, warning, or error')
    }
    return {
      sessionFile,
      command: 'notify',
      options: {
        title: required(values, '--title'),
        level,
        ...(values.has('--body') ? { body: values.get('--body')! } : {}),
        ...(values.has('--window-id') ? { windowId: values.get('--window-id')! } : {}),
        ...(values.has('--workspace-id') ? { workspaceId: values.get('--workspace-id')! } : {}),
        ...(values.has('--pane-id') ? { paneId: values.get('--pane-id')! } : {}),
        ...(values.has('--tab-id') ? { tabId: values.get('--tab-id')! } : {})
      }
    }
  }
  if (args[0] === 'hook' && args[1] === 'codex' && args.length === 3) {
    return { sessionFile, command: 'hook.codex', payload: args[2]! }
  }
  if (args[0] === 'hook' && args[1] === 'claude' && args.length === 2) {
    return { sessionFile, command: 'hook.claude' }
  }
  if (
    args[0] === 'hook' &&
    ['install', 'uninstall', 'status'].includes(args[1] ?? '') &&
    args.length === 3
  ) {
    return {
      sessionFile,
      command: `hook.${args[1]}` as 'hook.install' | 'hook.uninstall' | 'hook.status',
      agent: integration(args[2]!)
    }
  }
  if (args.length === 2 && args[0] === 'state' && args[1] === 'snapshot') {
    return { sessionFile, command: 'state.snapshot' }
  }
  if (args.length === 2 && args[0] === 'settings' && args[1] === 'get') {
    return { sessionFile, command: 'settings.get' }
  }
  if (args.length === 2 && args[0] === 'closed' && args[1] === 'list') {
    return { sessionFile, command: 'closed.list' }
  }
  if (args[0] === 'closed' && args[1] === 'get') {
    const { values } = flags(args.slice(2), ['--closed-item-id'])
    return {
      sessionFile,
      command: 'closed.get',
      closedItemId: required(values, '--closed-item-id')
    }
  }
  if (args.length === 2 && args[0] === 'workspace' && args[1] === 'list') {
    return { sessionFile, command: 'workspace.list' }
  }
  if (args.length === 2 && args[0] === 'workspace' && args[1] === 'organization') {
    return { sessionFile, command: 'workspace.organization' }
  }
  if (args[0] === 'workspace' && args[1] === 'create') {
    return {
      sessionFile,
      command: 'workspace.create',
      options: parseWorkspaceCreate(args.slice(2))
    }
  }
  if (args[0] === 'workspace' && args[1] === 'pin') {
    const options = parseWorkspaceRevision(args.slice(2), '--pinned')
    if (options.value !== 'true' && options.value !== 'false') {
      throw new Error('--pinned must be true or false')
    }
    const { value, ...revision } = options
    return {
      sessionFile,
      command: 'workspace.pin',
      options: { ...revision, pinned: value === 'true' }
    }
  }
  if (args[0] === 'workspace' && args[1] === 'reorder') {
    const options = parseWorkspaceRevision(args.slice(2), '--destination-index')
    const { value, ...revision } = options
    return {
      sessionFile,
      command: 'workspace.reorder',
      options: {
        ...revision,
        destinationIndex: integerOption(value, '--destination-index', 0)
      }
    }
  }
  if (args[0] === 'layout') {
    if (args[1] === 'list' && args.length === 2) {
      return { sessionFile, command: 'layout.list' }
    }
    if (args[1] === 'get' || args[1] === 'export') {
      const { values } = flags(args.slice(2), ['--layout-id'])
      return {
        sessionFile,
        command: args[1] === 'get' ? 'layout.get' : 'layout.export',
        layoutId: required(values, '--layout-id')
      }
    }
  }
  if (args[0] === 'remote' && (args[1] === 'target' || args[1] === 'session')) {
    if (
      (args[1] === 'target' && args[2] === 'delete') ||
      (args[1] === 'session' && ['prepare', 'activate', 'detach', 'close'].includes(args[2] ?? ''))
    ) {
      return {
        sessionFile,
        command:
          args[1] === 'target'
            ? 'remote.target.delete'
            : args[2] === 'detach'
              ? 'remote.session.detach'
              : args[2] === 'activate'
                ? 'remote.session.activate'
                : args[2] === 'close'
                  ? 'remote.session.close'
                  : 'remote.session.prepare',
        params: jsonParams(args.slice(3))
      }
    }
    if (args[2] === 'list') {
      const { values } = flags(args.slice(3), ['--limit', '--cursor'])
      return {
        sessionFile,
        command: args[1] === 'target' ? 'remote.target.list' : 'remote.session.list',
        limit: integerOption(values.get('--limit') ?? '128', '--limit', 1),
        ...(values.has('--cursor') ? { cursor: values.get('--cursor')! } : {})
      }
    }
    if (args[2] === 'get' || (args[1] === 'session' && args[2] === 'terminal')) {
      const target = args[1] === 'target'
      const flag = target ? '--target-id' : '--session-id'
      const { values } = flags(args.slice(3), [flag])
      return target
        ? { sessionFile, command: 'remote.target.get', targetId: required(values, flag) }
        : {
            sessionFile,
            command: args[2] === 'terminal' ? 'remote.session.terminal' : 'remote.session.get',
            sessionId: required(values, flag)
          }
    }
  }
  if (
    args[0] === 'remote' &&
    args[1] === 'host-key' &&
    (args[2] === 'scan' || args[2] === 'decide')
  ) {
    return {
      sessionFile,
      command: args[2] === 'scan' ? 'remote.hostKey.scan' : 'remote.hostKey.decide',
      params: jsonParams(args.slice(3))
    }
  }
  if (args[0] === 'remote' && args[1] === 'tmux' && args[2] === 'discover') {
    return { sessionFile, command: 'remote.tmux.discover', params: jsonParams(args.slice(3)) }
  }
  if (args[0] === 'agent' && (args[1] === 'catalog' || args[1] === 'catalog-list')) {
    if (
      (args[1] === 'catalog' && args[2] === 'list' && args.length === 3) ||
      (args[1] === 'catalog-list' && args.length === 2)
    ) {
      return { sessionFile, command: 'agent.catalog.list' }
    }
    if (args[1] === 'catalog' && args[2] === 'get') {
      const { values } = flags(args.slice(3), ['--session-id', '--agent-session-id'])
      if (values.has('--session-id') && values.has('--agent-session-id')) {
        throw new Error('Choose one session ID option')
      }
      return {
        sessionFile,
        command: 'agent.catalog.get',
        sessionId: values.get('--session-id') ?? required(values, '--agent-session-id')
      }
    }
  }
  if (args[0] === 'agent' && args[1] === 'catalog-get') {
    const { values } = flags(args.slice(2), ['--agent-session-id'])
    return {
      sessionFile,
      command: 'agent.catalog.get',
      sessionId: required(values, '--agent-session-id')
    }
  }
  if (args[0] === 'action' && args[1] === 'list') {
    const { values } = flags(args.slice(2), ['--limit', '--cursor'])
    return {
      sessionFile,
      command: 'action.list',
      limit: integerOption(values.get('--limit') ?? '64', '--limit', 1),
      ...(values.has('--cursor') ? { cursor: values.get('--cursor')! } : {})
    }
  }
  if (
    args[0] === 'search' &&
    [
      'query',
      'cancel',
      'policy',
      'exclude',
      'forget',
      'rebuild',
      'export-confirm',
      'export'
    ].includes(args[1] ?? '')
  ) {
    return {
      sessionFile,
      command: `search.${args[1]}` as
        | 'search.query'
        | 'search.cancel'
        | 'search.policy'
        | 'search.exclude'
        | 'search.forget'
        | 'search.rebuild'
        | 'search.export-confirm'
        | 'search.export',
      params: jsonParams(args.slice(2))
    }
  }
  if (args[0] === 'task' && ['list', 'confirm', 'action'].includes(args[1] ?? '')) {
    return {
      sessionFile,
      command: `task.${args[1]}` as 'task.list' | 'task.confirm' | 'task.action',
      params: jsonParams(args.slice(2))
    }
  }
  if (args[0] === 'notification' && args[1] === 'list') {
    const { values } = flags(args.slice(2), [
      '--window-id',
      '--workspace-id',
      '--unread-only',
      '--offset',
      '--limit'
    ])
    const unreadOnly = values.get('--unread-only') ?? 'false'
    if (!['true', 'false'].includes(unreadOnly)) {
      throw new Error('--unread-only must be true or false')
    }
    return {
      sessionFile,
      command: 'notification.list',
      windowId: required(values, '--window-id'),
      ...(values.has('--workspace-id') ? { workspaceId: values.get('--workspace-id')! } : {}),
      unreadOnly: unreadOnly === 'true',
      offset: integerOption(values.get('--offset') ?? '0', '--offset', 0),
      limit: integerOption(values.get('--limit') ?? '50', '--limit', 1)
    }
  }
  if (args[0] === 'sidebar' && args[1] === 'placement') {
    if (args[2] === 'list' && args.length === 3) {
      return { sessionFile, command: 'sidebar.placement.list' }
    }
    if (args[2] === 'get') {
      const { values } = flags(args.slice(3), ['--window-id'])
      return {
        sessionFile,
        command: 'sidebar.placement.get',
        windowId: required(values, '--window-id')
      }
    }
  }
  if (args[0] === 'files') {
    if (args[1] === 'roots') {
      const { values } = flags(args.slice(2), ['--limit', '--cursor'])
      return {
        sessionFile,
        command: 'content.root.list',
        limit: integerOption(values.get('--limit') ?? '64', '--limit', 1),
        ...(values.has('--cursor') ? { cursor: values.get('--cursor')! } : {})
      }
    }
    const command = {
      directory: 'content.directory.list',
      issue: 'content.document.issue',
      read: 'content.read',
      save: 'content.save',
      markdown: 'content.markdown',
      diff: 'content.diff'
    }[args[1] ?? '']
    if (
      command === 'content.directory.list' ||
      command === 'content.document.issue' ||
      command === 'content.read' ||
      command === 'content.save' ||
      command === 'content.markdown' ||
      command === 'content.diff'
    )
      return { sessionFile, command, params: jsonParams(args.slice(2)) }
  }
  if (args[0] === 'textbox') {
    if (args[1] === 'list') {
      const { values } = flags(args.slice(2), ['--limit', '--cursor'])
      return {
        sessionFile,
        command: 'textbox.list',
        limit: integerOption(values.get('--limit') ?? '64', '--limit', 1),
        ...(values.has('--cursor') ? { cursor: values.get('--cursor')! } : {})
      }
    }
    if (args[1] === 'get') {
      const { values } = flags(args.slice(2), ['--document-id'])
      return {
        sessionFile,
        command: 'textbox.get',
        documentId: required(values, '--document-id')
      }
    }
  }
  if (args[0] === 'terminal' && args[1] === 'create') {
    return { sessionFile, command: 'terminal.create', options: parseTerminalCreate(args.slice(2)) }
  }
  if (args[0] === 'terminal' && args[1] === 'send') {
    const { values } = flags(args.slice(2), ['--terminal-id', '--data'])
    const data = values.get('--data')
    if (data === undefined) throw new Error('--data is required')
    return {
      sessionFile,
      command: 'terminal.send',
      terminalId: required(values, '--terminal-id'),
      data
    }
  }
  if (args[0] === 'request' && args[1] && supportsJsonMutation(args[1])) {
    return {
      sessionFile,
      command: 'json.mutation',
      capability: args[1],
      params: jsonParams(args.slice(2))
    }
  }
  throw new Error('Unknown command or arguments')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const commandIndex = args.findIndex(
    (arg) => arg === '--command' || arg === '--replacement-command'
  )
  if (
    args.length === 0 ||
    args.slice(0, commandIndex < 0 ? undefined : commandIndex).includes('--help')
  ) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  const parsed = parse(args)
  if (parsed.command === 'hook.install') {
    await hookInstall(parsed.agent)
    process.stdout.write('installed\n')
    return
  }
  if (parsed.command === 'hook.uninstall') {
    await hookUninstall(parsed.agent)
    process.stdout.write('uninstalled\n')
    return
  }
  if (parsed.command === 'hook.status') {
    process.stdout.write(`${await hookStatus(parsed.agent)}\n`)
    return
  }
  const session = await readNodeSessionFile(parsed.sessionFile)
  const client = new AgentWorkspaceClient(session.baseUrl, session.token)
  const mutationIdentity = async (capability: string) => {
    const identity = await client.identify()
    if (!identity.capabilities.includes(capability) || !identity.idempotencyEpoch) {
      throw new Error(`${capability} is unavailable in this Node session`)
    }
    return identity.idempotencyEpoch
  }
  const requireCapability = async (capability: string) => {
    if (!(await client.identify()).capabilities.includes(capability)) {
      throw new Error(`${capability} is unavailable in this Node session`)
    }
  }
  const windowCapability = () => {
    const capability = process.env.AGENT_WORKSPACE_WINDOW_CAPABILITY
    if (!capability || !/^[A-Za-z0-9_-]{43}$/u.test(capability)) {
      throw new Error('A private owner-issued AGENT_WORKSPACE_WINDOW_CAPABILITY is required')
    }
    return capability
  }
  const publishNotice = async (
    notice: HookNotice,
    options: Partial<NotificationOptions>,
    source: 'cli' | 'agentHook'
  ) => {
    const idempotencyEpoch = await mutationIdentity('notification.publish')
    const { snapshot } = await client.stateSnapshot()
    const windowId =
      options.windowId ?? process.env.AGENT_WORKSPACE_WINDOW_ID ?? snapshot.focusedWindowId
    const placement = snapshot.windowPlacements.find((item) => item.id === windowId)
    if (!placement) throw new Error('Notification window is unavailable')
    const workspaceId =
      options.workspaceId ??
      process.env.AGENT_WORKSPACE_WORKSPACE_ID ??
      placement.focusedWorkspaceId
    if (!placement.workspaceIds.includes(workspaceId)) {
      throw new Error('Notification workspace is outside the selected window')
    }
    const paneId = options.paneId ?? process.env.AGENT_WORKSPACE_PANE_ID
    const tabId = options.tabId ?? process.env.AGENT_WORKSPACE_TAB_ID
    const request = notificationPublishRequestSchema.parse({
      windowId,
      target: { workspaceId, ...(paneId ? { paneId } : {}), ...(tabId ? { tabId } : {}) },
      source,
      level: options.level ?? 'info',
      title: notice.title,
      ...(notice.body === undefined ? {} : { body: notice.body }),
      mutation: {
        expectedRevision: snapshot.revision,
        idempotencyEpoch,
        idempotencyKey: randomUUID()
      }
    })
    return client.publishNotification(request)
  }
  let result: unknown
  switch (parsed.command) {
    case 'rust.named':
      await requireCapability(parsed.capability)
      result = await runRustNamedCommand(
        client,
        parsed,
        rustNamedNeedsWindowCapability(parsed.capability) ? windowCapability() : undefined
      )
      break
    case 'parity.mutate':
      if (parsed.operation === 'action.invoke' || parsed.operation === 'action.cancel') {
        await requireCapability(parsed.operation)
        result = {
          schemaVersion: 1,
          command: parsed.operation,
          result: await runParityCommand(client, parsed)
        }
      } else {
        result = await runParityCommand(client, parsed, await mutationIdentity(parsed.operation))
      }
      break
    case 'organization.mutate':
      result = await runOrganizationCommand(
        client,
        parsed,
        await mutationIdentity(parsed.operation)
      )
      break
    case 'layout.mutate':
      result = await runLayoutCommand(client, parsed, await mutationIdentity(parsed.operation))
      break
    case 'browser-automation.create':
    case 'browser-automation.list':
    case 'browser-automation.get':
    case 'browser-automation.execute':
    case 'browser-automation.cancel':
    case 'browser-automation.read':
    case 'browser-automation.release':
    case 'browser-automation.destroy':
      result = await runBrowserAutomation(client, parsed)
      break
    case 'identify':
      result = await client.identify()
      break
    case 'state.snapshot':
      result = await client.stateSnapshot()
      break
    case 'settings.get':
      await requireCapability('settings.get')
      result = await client.getSettings()
      break
    case 'closed.list':
      await requireCapability('closed.list')
      result = await client.listClosedItemsPrivileged()
      break
    case 'closed.get':
      await requireCapability('closed.get')
      result = await client.getClosedItemPrivileged(parsed.closedItemId)
      break
    case 'workspace.list':
      result = await client.listWorkspaces()
      break
    case 'workspace.organization':
      result = await client.getOrganization()
      break
    case 'workspace.create': {
      const idempotencyEpoch = await mutationIdentity('workspace.create')
      const options = parsed.options
      const expectedRevision =
        options.expectedRevision ?? (await client.stateSnapshot()).snapshot.revision
      result = await client.createWorkspace({
        name: options.name,
        workingDirectory: options.workingDirectory,
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.color === undefined ? {} : { color: options.color }),
        initialTerminal: {
          cwd: options.terminalCwd ?? options.workingDirectory,
          rows: options.rows,
          cols: options.cols,
          ...(options.command ? { command: options.command } : {})
        },
        expectedRevision,
        idempotencyEpoch,
        idempotencyKey: options.idempotencyKey ?? randomUUID()
      })
      break
    }
    case 'workspace.pin': {
      const idempotencyEpoch = await mutationIdentity('workspace.pin')
      const options = parsed.options
      result = await client.pinWorkspace({
        workspaceId: options.workspaceId,
        pinned: options.pinned,
        expectedRevision: options.expectedRevision,
        idempotencyEpoch,
        idempotencyKey: options.idempotencyKey ?? randomUUID()
      })
      break
    }
    case 'workspace.reorder': {
      const idempotencyEpoch = await mutationIdentity('workspace.reorder')
      const options = parsed.options
      result = await client.reorderWorkspace({
        workspaceId: options.workspaceId,
        destinationIndex: options.destinationIndex,
        expectedRevision: options.expectedRevision,
        idempotencyEpoch,
        idempotencyKey: options.idempotencyKey ?? randomUUID()
      })
      break
    }
    case 'layout.list':
      await requireCapability('layout.list')
      result = await client.listLayouts()
      break
    case 'layout.get':
      await requireCapability('layout.get')
      result = await client.getLayout(parsed.layoutId)
      break
    case 'layout.export':
      await requireCapability('layout.export')
      result = await client.exportLayout(parsed.layoutId)
      break
    case 'remote.target.list':
      result = await client.listRemoteTargets({
        limit: parsed.limit,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {})
      })
      break
    case 'remote.target.get':
      result = await client.getRemoteTarget(parsed.targetId)
      break
    case 'remote.target.delete':
      await requireCapability('remote.target.delete')
      result = await client.deleteRemoteTarget(remoteTargetDeleteParamsSchema.parse(parsed.params))
      break
    case 'remote.session.list':
      result = await client.listRemoteSessions({
        limit: parsed.limit,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {})
      })
      break
    case 'remote.session.get':
      result = await client.getRemoteSession(parsed.sessionId)
      break
    case 'remote.session.terminal':
      await requireCapability('remote.session.terminal')
      result = await client.getRemoteTerminal(parsed.sessionId)
      break
    case 'remote.session.prepare':
      await requireCapability('remote.session.prepare')
      result = await client.prepareRemoteSession(
        remoteSessionConnectParamsSchema.parse(parsed.params)
      )
      break
    case 'remote.session.activate':
      await requireCapability('remote.session.activate')
      result = await client.activateRemoteSession(
        remoteSessionReconnectParamsSchema.parse(parsed.params)
      )
      break
    case 'remote.session.detach':
      await requireCapability('remote.session.detach')
      result = await client.detachRemoteSession(
        remoteSessionDetachParamsSchema.parse(parsed.params)
      )
      break
    case 'remote.session.close':
      await requireCapability('remote.session.close')
      result = await client.closeRemoteSession(remoteSessionCloseParamsSchema.parse(parsed.params))
      break
    case 'remote.hostKey.scan':
      await requireCapability('remote.hostKey.scan')
      result = await client.scanRemoteHostKey(remoteHostKeyScanParamsSchema.parse(parsed.params))
      break
    case 'remote.hostKey.decide':
      await requireCapability('remote.hostKey.decide')
      result = await client.decideRemoteHostKey(remoteHostKeyTrustParamsSchema.parse(parsed.params))
      break
    case 'remote.tmux.discover':
      await requireCapability('remote.tmux.discover')
      result = await client.discoverRemoteTmux(remoteTmuxDiscoverParamsSchema.parse(parsed.params))
      break
    case 'agent.catalog.list':
      await requireCapability('agent.catalog.list')
      result = await client.listAgentCatalog({ catalogVersion: 1 })
      break
    case 'agent.catalog.get':
      await requireCapability('agent.catalog.get')
      result = await client.getAgentSession(parsed.sessionId)
      break
    case 'action.list':
      await requireCapability('action.list')
      result = await client.listActions({
        limit: parsed.limit,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {})
      })
      break
    case 'notify':
      result = await publishNotice(parsed.options, parsed.options, 'cli')
      break
    case 'hook.codex':
      result = await publishNotice(parseCodexNotice(parsed.payload), {}, 'agentHook')
      break
    case 'hook.claude':
      result = await publishNotice(
        parseClaudeNotice(await readClaudeHookInput(process.stdin)),
        {},
        'agentHook'
      )
      break
    case 'search.query':
      await requireCapability('search.query')
      result = await client.searchContent(searchQueryParamsSchema.parse(parsed.params))
      break
    case 'search.cancel':
      await requireCapability('search.cancel')
      result = await client.cancelSearch(searchCancelParamsSchema.parse(parsed.params))
      break
    case 'search.policy':
      await requireCapability('search.source.policy')
      result = await client.setSearchSourcePolicy(
        searchSourcePolicyParamsSchema.parse(parsed.params)
      )
      break
    case 'search.exclude':
      await requireCapability('search.source.exclude')
      result = await client.excludeSearchSource(
        searchSourceMutationParamsSchema.parse(parsed.params)
      )
      break
    case 'search.forget':
      await requireCapability('search.source.forget')
      result = await client.forgetSearchSource(
        searchSourceMutationParamsSchema.parse(parsed.params)
      )
      break
    case 'search.rebuild':
      await requireCapability('search.source.rebuild')
      result = await client.rebuildSearchSource(searchRebuildParamsSchema.parse(parsed.params))
      break
    case 'search.export-confirm':
      await requireCapability('search.source.export.confirmation.issue')
      result = await client.issueSearchExportConfirmation(
        searchExportConfirmationIssueParamsSchema.parse(parsed.params)
      )
      break
    case 'search.export':
      await requireCapability('search.source.export')
      result = await client.exportSearchSource(searchExportParamsSchema.parse(parsed.params))
      break
    case 'task.list':
      await requireCapability('task.list')
      result = await client.listTasksBound(
        taskListParamsSchema.parse(parsed.params),
        windowCapability()
      )
      break
    case 'task.confirm':
      await requireCapability('task.confirmation.issue')
      result = await client.issueTaskConfirmationBound(
        taskConfirmationIssueParamsSchema.parse(parsed.params),
        windowCapability()
      )
      break
    case 'task.action':
      await requireCapability('task.action')
      result = await client.taskActionBound(
        taskActionParamsSchema.parse(parsed.params),
        windowCapability()
      )
      break
    case 'notification.list':
      await requireCapability('notification.list')
      result = await client.listNotifications({
        windowId: parsed.windowId,
        ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
        unreadOnly: parsed.unreadOnly,
        offset: parsed.offset,
        limit: parsed.limit
      })
      break
    case 'sidebar.placement.list':
      await requireCapability('sidebar.placement.list')
      result = await client.listSidebarPlacements()
      break
    case 'sidebar.placement.get':
      await requireCapability('sidebar.placement.get')
      result = await client.getSidebarPlacement(parsed.windowId)
      break
    case 'content.root.list':
      await requireCapability('content.root.list')
      result = await client.listContentRoots({
        limit: parsed.limit,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {})
      })
      break
    case 'content.directory.list':
      await requireCapability('content.directory.list')
      result = await client.listContentDirectory(
        workspaceDirectoryListParamsSchema.parse(parsed.params)
      )
      break
    case 'content.document.issue':
      await requireCapability('content.document.issue')
      result = await client.issueContentDocument(
        contentDocumentIssueParamsSchema.parse(parsed.params)
      )
      break
    case 'content.read':
      await requireCapability('content.read')
      result = await client.readContent(contentReadParamsSchema.parse(parsed.params))
      break
    case 'content.save':
      await requireCapability('content.save')
      result = await client.saveContent(contentSaveParamsSchema.parse(parsed.params))
      break
    case 'content.markdown':
      await requireCapability('content.markdown')
      result = await client.renderMarkdown(contentMarkdownParamsSchema.parse(parsed.params))
      break
    case 'content.diff':
      await requireCapability('content.diff')
      result = await client.diffContent(contentDiffParamsSchema.parse(parsed.params))
      break
    case 'textbox.list':
      await requireCapability('textbox.list')
      result = await client.listTextBoxes({
        limit: parsed.limit,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {})
      })
      break
    case 'textbox.get':
      await requireCapability('textbox.get')
      result = await client.getTextBox(parsed.documentId)
      break
    case 'terminal.create': {
      const identity = await client.identify()
      if (!identity.capabilities.includes('tab.openTerminal') || !identity.idempotencyEpoch) {
        throw new Error('Terminal tab creation is unavailable in this Node session')
      }
      const options = parsed.options
      const expectedRevision =
        options.expectedRevision ?? (await client.stateSnapshot()).snapshot.revision
      result = await client.openTerminalTab({
        workspaceId: options.workspaceId,
        paneId: options.paneId,
        launch: {
          cwd: options.cwd,
          rows: options.rows,
          cols: options.cols,
          ...(options.command ? { command: options.command } : {})
        },
        ...(options.destinationIndex === undefined
          ? {}
          : { destinationIndex: options.destinationIndex }),
        expectedRevision,
        idempotencyEpoch: identity.idempotencyEpoch,
        idempotencyKey: options.idempotencyKey ?? randomUUID()
      })
      break
    }
    case 'terminal.send':
      result = await client.send(parsed.terminalId, Buffer.from(parsed.data))
      break
    case 'json.mutation':
      await requireCapability(parsed.capability)
      result = await runJsonMutation(client, parsed.capability, parsed.params)
      break
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown CLI error'
  const code =
    error instanceof ServerError && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
      ? `[${error.code}] `
      : ''
  process.stderr.write(`agent-workspace-cli: ${code}${message}\n`)
  process.exitCode = 1
})
