import { randomUUID } from 'node:crypto'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import {
  actionInvokeParamsSchema,
  actionCancelParamsSchema,
  paneSplitRequestSchema,
  workspaceBatchCloseRequestSchema
} from '@agent-workspace/contracts'

import { flags, required } from './options'

type Operation = 'workspace.closeSelected' | 'pane.split' | 'action.invoke' | 'action.cancel'

export interface ParityCommand {
  sessionFile: string
  command: 'parity.mutate'
  operation: Operation
  values: Map<string, string>
  commandTail?: string[]
  content?: 'terminal' | 'browser' | 'existing-tab'
}

function integer(value: string, flag: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`)
  }
  return number
}

const revisionFlags = ['--expected-revision', '--idempotency-key'] as const

export function parseParityCommand(args: string[], sessionFile: string): ParityCommand | undefined {
  if (args[0] === 'workspace' && args[1] === 'close-selected') {
    const { values, command } = flags(
      args.slice(2),
      [
        '--replacement-name',
        '--replacement-working-directory',
        '--replacement-description',
        '--replacement-color',
        '--replacement-terminal-cwd',
        '--replacement-rows',
        '--replacement-cols',
        ...revisionFlags
      ],
      true,
      '--replacement-command'
    )
    required(values, '--expected-revision')
    const replacement = values.has('--replacement-name')
    if (replacement !== values.has('--replacement-working-directory')) {
      throw new Error(
        '--replacement-name and --replacement-working-directory must be supplied together'
      )
    }
    if (
      !replacement &&
      (command || [...values.keys()].some((key) => key.startsWith('--replacement-')))
    ) {
      throw new Error('Replacement options require --replacement-name')
    }
    return {
      sessionFile,
      command: 'parity.mutate',
      operation: 'workspace.closeSelected',
      values,
      ...(command ? { commandTail: command } : {})
    }
  }
  if (args[0] === 'pane' && args[1] === 'split') {
    const contentIndex = args.findIndex(
      (arg, index) => index >= 2 && ['terminal', 'browser', 'existing-tab'].includes(arg)
    )
    if (contentIndex < 0)
      throw new Error('pane split requires terminal, browser, or existing-tab content')
    const content = args[contentIndex] as 'terminal' | 'browser' | 'existing-tab'
    const common = flags(args.slice(2, contentIndex), [
      '--workspace-id',
      '--target-pane-id',
      '--axis',
      '--placement',
      '--ratio',
      ...revisionFlags
    ])
    required(common.values, '--workspace-id')
    required(common.values, '--target-pane-id')
    required(common.values, '--axis')
    required(common.values, '--expected-revision')
    const allowed =
      content === 'terminal'
        ? ['--cwd', '--rows', '--cols']
        : content === 'browser'
          ? ['--url', '--profile-partition']
          : ['--tab-id']
    const { values: contentValues, command } = flags(
      args.slice(contentIndex + 1),
      allowed,
      content === 'terminal'
    )
    for (const [key, value] of contentValues) common.values.set(key, value)
    return {
      sessionFile,
      command: 'parity.mutate',
      operation: 'pane.split',
      values: common.values,
      content,
      ...(command ? { commandTail: command } : {})
    }
  }
  if (args[0] === 'action' && args[1] === 'invoke') {
    const { values } = flags(args.slice(2), [
      '--action-id',
      '--action-version',
      '--parameters-json',
      '--idempotency-epoch',
      '--idempotency-key',
      '--correlation-id',
      '--target-window-id',
      '--target-window-generation'
    ])
    required(values, '--action-id')
    required(values, '--action-version')
    required(values, '--idempotency-epoch')
    if (values.has('--target-window-id') !== values.has('--target-window-generation')) {
      throw new Error('Both action target fields are required together')
    }
    return { sessionFile, command: 'parity.mutate', operation: 'action.invoke', values }
  }
  if (args[0] === 'action' && args[1] === 'cancel') {
    const { values } = flags(args.slice(2), ['--invocation-id', '--correlation-id'])
    required(values, '--invocation-id')
    required(values, '--correlation-id')
    return { sessionFile, command: 'parity.mutate', operation: 'action.cancel', values }
  }
  return undefined
}

export function parityRequest(parsed: ParityCommand, idempotencyEpoch?: string) {
  const { values } = parsed
  if (parsed.operation === 'action.cancel')
    return actionCancelParamsSchema.parse({
      invocationId: required(values, '--invocation-id'),
      correlationId: required(values, '--correlation-id')
    })
  if (parsed.operation === 'action.invoke') {
    const raw = values.get('--parameters-json') ?? '{}'
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('--parameters-json exceeds 64 KiB')
    let parameters: unknown
    try {
      parameters = JSON.parse(raw) as unknown
    } catch {
      throw new Error('--parameters-json must be a JSON object')
    }
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new Error('--parameters-json must be a JSON object')
    }
    return actionInvokeParamsSchema.parse({
      actionId: required(values, '--action-id'),
      actionVersion: integer(
        required(values, '--action-version'),
        '--action-version',
        1,
        0xffffffff
      ),
      parameters,
      idempotency: {
        epoch: required(values, '--idempotency-epoch'),
        key: values.get('--idempotency-key') ?? randomUUID()
      },
      correlationId: values.get('--correlation-id') ?? randomUUID(),
      ...(values.has('--target-window-id')
        ? {
            target: {
              windowId: values.get('--target-window-id'),
              windowGeneration: integer(
                required(values, '--target-window-generation'),
                '--target-window-generation',
                1
              )
            }
          }
        : {})
    })
  }
  const identity = {
    expectedRevision: integer(required(values, '--expected-revision'), '--expected-revision', 0),
    idempotencyEpoch,
    idempotencyKey: values.get('--idempotency-key') ?? randomUUID()
  }
  if (parsed.operation === 'workspace.closeSelected') {
    const workingDirectory = values.get('--replacement-working-directory')
    return workspaceBatchCloseRequestSchema.parse({
      ...identity,
      ...(workingDirectory
        ? {
            replacement: {
              name: required(values, '--replacement-name'),
              workingDirectory,
              ...(values.has('--replacement-description')
                ? { description: values.get('--replacement-description') }
                : {}),
              ...(values.has('--replacement-color')
                ? { color: values.get('--replacement-color') }
                : {}),
              initialTerminal: {
                cwd: values.get('--replacement-terminal-cwd') ?? workingDirectory,
                rows: integer(
                  values.get('--replacement-rows') ?? '24',
                  '--replacement-rows',
                  1,
                  1000
                ),
                cols: integer(
                  values.get('--replacement-cols') ?? '80',
                  '--replacement-cols',
                  1,
                  1000
                ),
                ...(parsed.commandTail ? { command: parsed.commandTail } : {})
              }
            }
          }
        : {})
    })
  }
  const axis = required(values, '--axis')
  if (axis !== 'horizontal' && axis !== 'vertical')
    throw new Error('--axis must be horizontal or vertical')
  const placement = values.get('--placement') ?? 'after'
  if (placement !== 'before' && placement !== 'after')
    throw new Error('--placement must be before or after')
  const ratio = Number(values.get('--ratio') ?? '0.5')
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1)
    throw new Error('--ratio must be greater than 0 and less than 1')
  const content =
    parsed.content === 'terminal'
      ? {
          kind: 'newTerminal',
          launch: {
            cwd: required(values, '--cwd'),
            rows: integer(values.get('--rows') ?? '24', '--rows', 1, 1000),
            cols: integer(values.get('--cols') ?? '80', '--cols', 1, 1000),
            ...(parsed.commandTail ? { command: parsed.commandTail } : {})
          }
        }
      : parsed.content === 'browser'
        ? {
            kind: 'newBrowser',
            url: required(values, '--url'),
            ...(values.has('--profile-partition')
              ? { profilePartition: values.get('--profile-partition') }
              : {})
          }
        : { kind: 'existingTab', tabId: required(values, '--tab-id') }
  return paneSplitRequestSchema.parse({
    workspaceId: required(values, '--workspace-id'),
    targetPaneId: required(values, '--target-pane-id'),
    axis,
    placement,
    ratio,
    content,
    ...identity
  })
}

export function runParityCommand(
  client: AgentWorkspaceClient,
  parsed: ParityCommand,
  epoch?: string
): Promise<unknown> {
  const request = parityRequest(parsed, epoch)
  switch (parsed.operation) {
    case 'workspace.closeSelected':
      return client.closeSelectedWorkspaces(workspaceBatchCloseRequestSchema.parse(request))
    case 'pane.split':
      return client.splitPane(paneSplitRequestSchema.parse(request))
    case 'action.invoke':
      return client.invokeAction(actionInvokeParamsSchema.parse(request))
    case 'action.cancel':
      return client.cancelAction(actionCancelParamsSchema.parse(request))
  }
}
