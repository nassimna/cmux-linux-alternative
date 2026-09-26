import { randomUUID } from 'node:crypto'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import {
  groupAssignRequestSchema,
  groupCollapseRequestSchema,
  groupCreateRequestSchema,
  groupDeleteRequestSchema,
  groupMoveRequestSchema,
  groupRenameRequestSchema,
  workspaceSelectionReplaceRequestSchema
} from '@agent-workspace/contracts'

import { flags, required } from './options'

type Operation =
  | 'workspace.selectMany'
  | 'group.create'
  | 'group.rename'
  | 'group.delete'
  | 'group.move'
  | 'group.assign'
  | 'group.collapse'

export interface OrganizationCommand {
  sessionFile: string
  command: 'organization.mutate'
  operation: Operation
  values: Map<string, string>
  selection?: string[]
}

const groupOptions: Record<string, readonly string[]> = {
  create: ['--group-id', '--name'],
  rename: ['--group-id', '--name'],
  delete: ['--group-id'],
  move: ['--group-id', '--destination-index'],
  assign: ['--workspace-id', '--group-id'],
  collapse: ['--group-id', '--collapsed']
}

const revisionOptions = ['--expected-revision', '--idempotency-key'] as const

function selectionFlags(args: string[]): { values: Map<string, string>; selection: string[] } {
  const selection: string[] = []
  const remainder: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--workspace-id') {
      remainder.push(args[index]!)
      continue
    }
    const id = args[++index]
    if (!id || id.startsWith('--')) throw new Error('--workspace-id requires a value')
    selection.push(id)
  }
  const { values } = flags(remainder, ['--focused-workspace-id', ...revisionOptions])
  if (selection.length === 0) throw new Error('--workspace-id is required')
  return { values, selection }
}

export function parseOrganizationCommand(
  args: string[],
  sessionFile: string
): OrganizationCommand | undefined {
  if (args[0] === 'workspace' && args[1] === 'select-many') {
    const { values, selection } = selectionFlags(args.slice(2))
    required(values, '--focused-workspace-id')
    required(values, '--expected-revision')
    return {
      sessionFile,
      command: 'organization.mutate',
      operation: 'workspace.selectMany',
      values,
      selection
    }
  }
  if (args[0] !== 'group' || !Object.hasOwn(groupOptions, args[1] ?? '')) return undefined
  const action = args[1]!
  const { values } = flags(args.slice(2), [...groupOptions[action]!, ...revisionOptions])
  required(values, '--expected-revision')
  for (const option of groupOptions[action]!) {
    if (action === 'assign' && option === '--group-id') continue
    required(values, option)
  }
  return {
    sessionFile,
    command: 'organization.mutate',
    operation: `group.${action}` as Operation,
    values
  }
}

function nonnegativeInteger(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a nonnegative safe integer`)
  }
  return Number(value)
}

export function organizationRequest(parsed: OrganizationCommand, idempotencyEpoch: string) {
  const { values, operation } = parsed
  const identity = {
    expectedRevision: nonnegativeInteger(
      required(values, '--expected-revision'),
      '--expected-revision'
    ),
    idempotencyEpoch,
    idempotencyKey: values.get('--idempotency-key') ?? randomUUID()
  }
  switch (operation) {
    case 'workspace.selectMany':
      return workspaceSelectionReplaceRequestSchema.parse({
        selection: parsed.selection,
        focusedWorkspaceId: required(values, '--focused-workspace-id'),
        ...identity
      })
    case 'group.create':
      return groupCreateRequestSchema.parse({
        groupId: required(values, '--group-id'),
        name: required(values, '--name'),
        ...identity
      })
    case 'group.rename':
      return groupRenameRequestSchema.parse({
        groupId: required(values, '--group-id'),
        name: required(values, '--name'),
        ...identity
      })
    case 'group.delete':
      return groupDeleteRequestSchema.parse({ groupId: required(values, '--group-id'), ...identity })
    case 'group.move':
      return groupMoveRequestSchema.parse({
        groupId: required(values, '--group-id'),
        destinationIndex: nonnegativeInteger(
          required(values, '--destination-index'),
          '--destination-index'
        ),
        ...identity
      })
    case 'group.assign':
      return groupAssignRequestSchema.parse({
        workspaceId: required(values, '--workspace-id'),
        ...(values.has('--group-id') ? { groupId: values.get('--group-id') } : {}),
        ...identity
      })
    case 'group.collapse': {
      const value = required(values, '--collapsed')
      if (value !== 'true' && value !== 'false') {
        throw new Error('--collapsed must be true or false')
      }
      return groupCollapseRequestSchema.parse({
        groupId: required(values, '--group-id'),
        collapsed: value === 'true',
        ...identity
      })
    }
  }
}

export function runOrganizationCommand(
  client: AgentWorkspaceClient,
  parsed: OrganizationCommand,
  idempotencyEpoch: string
): Promise<unknown> {
  const request = organizationRequest(parsed, idempotencyEpoch)
  switch (parsed.operation) {
    case 'workspace.selectMany':
      return client.selectWorkspaces(workspaceSelectionReplaceRequestSchema.parse(request))
    case 'group.create':
      return client.createGroup(groupCreateRequestSchema.parse(request))
    case 'group.rename':
      return client.renameGroup(groupRenameRequestSchema.parse(request))
    case 'group.delete':
      return client.deleteGroup(groupDeleteRequestSchema.parse(request))
    case 'group.move':
      return client.moveGroup(groupMoveRequestSchema.parse(request))
    case 'group.assign':
      return client.assignGroup(groupAssignRequestSchema.parse(request))
    case 'group.collapse':
      return client.collapseGroup(groupCollapseRequestSchema.parse(request))
  }
}
