import { createHash } from 'node:crypto'

import {
  actionCancelParamsSchema,
  actionInvokeParamsSchema,
  actionInvokeResultSchema
} from '@agent-workspace/protocol-client'
import { z } from 'zod'

import { WorkspaceMutationError } from '../domain/workspace-mutations'
import { StateStoreError, type ApplicationStateStore } from '../persistence/application-state-store'

const workspacePin = z.strictObject({
  workspaceId: z.uuid(),
  pinned: z.boolean(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
})
const groupRename = z.strictObject({
  groupId: z.uuid(),
  name: z.string(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
})
const groupCollapse = z.strictObject({
  groupId: z.uuid(),
  collapsed: z.boolean(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
})

type ActionCode =
  | 'invalid_params'
  | 'action_not_found'
  | 'action_version_mismatch'
  | 'invalid_parameters'
  | 'idempotency_conflict'
  | 'idempotency_expired'
  | 'invalid_state'
  | 'target_not_found'
  | 'resource_limit'
  | 'policy_denied'

export class ServiceActionError extends Error {
  constructor(public readonly code: ActionCode) {
    super('The action request could not be completed')
    this.name = 'ServiceActionError'
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

function invocationId(epoch: string, key: string, actionId: string): string {
  const bytes = createHash('sha256')
    .update('actions-v1')
    .update(Buffer.from(epoch.replaceAll('-', ''), 'hex'))
    .update(Buffer.from(key.replaceAll('-', ''), 'hex'))
    .update(actionId)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Owner authorization is enforced by the HTTP bearer boundary before this method is called. */
export class ServiceActionInvoker {
  constructor(
    private readonly store: ApplicationStateStore,
    private readonly now: () => number = Date.now
  ) {}

  /** Service actions finish in the invoke transaction and have no cancellable invocation row. */
  cancel(input: unknown): never {
    if (!actionCancelParamsSchema.safeParse(input).success)
      throw new ServiceActionError('invalid_params')
    throw new ServiceActionError('action_not_found')
  }

  invoke(input: unknown) {
    const parsed = actionInvokeParamsSchema.safeParse(input)
    if (!parsed.success) throw new ServiceActionError('invalid_params')
    const request = parsed.data
    if (
      !['workspace.card.pin', 'workspace.group.rename', 'workspace.group.collapse'].includes(
        request.actionId
      )
    ) {
      throw new ServiceActionError('action_not_found')
    }
    if (request.actionVersion !== 1) throw new ServiceActionError('action_version_mismatch')
    if (
      request.target !== undefined ||
      Buffer.byteLength(JSON.stringify(canonical(request.parameters))) > 4 * 1024
    ) {
      throw new ServiceActionError('invalid_parameters')
    }
    const action = request.actionId
    const value =
      action === 'workspace.card.pin'
        ? workspacePin.safeParse(request.parameters)
        : action === 'workspace.group.rename'
          ? groupRename.safeParse(request.parameters)
          : groupCollapse.safeParse(request.parameters)
    if (!value.success) throw new ServiceActionError('invalid_parameters')
    const params = value.data
    if (action === 'workspace.group.rename' && 'name' in params) {
      const name = params.name.trim()
      if (name.length === 0 || [...name].length > 80) {
        throw new ServiceActionError('policy_denied')
      }
      params.name = name
    }
    const requestJson = JSON.stringify({
      actionId: request.actionId,
      actionVersion: request.actionVersion,
      parameters: canonical(request.parameters),
      idempotency: { epoch: request.idempotency.epoch, key: request.idempotency.key },
      correlationId: request.correlationId
    })
    const requestHash = createHash('sha256').update(requestJson).digest('hex')
    const timestamp = this.now()
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error('Action timestamp is invalid')
    const result = actionInvokeResultSchema.parse({
      invocation: {
        invocationId: invocationId(request.idempotency.epoch, request.idempotency.key, action),
        correlationId: request.correlationId,
        state: 'acknowledged',
        terminalCode: 'succeeded',
        result: {},
        updatedAtMs: timestamp
      }
    })
    try {
      return this.store.commitServiceAction({
        actionId: action as
          'workspace.card.pin' | 'workspace.group.rename' | 'workspace.group.collapse',
        parameters: params,
        expectedRevision: params.expectedRevision,
        idempotencyEpoch: request.idempotency.epoch,
        idempotencyKey: request.idempotency.key,
        requestHash,
        result
      })
    } catch (error) {
      if (error instanceof StateStoreError) {
        const code: ActionCode =
          error.code === 'idempotency_conflict'
            ? 'idempotency_conflict'
            : error.code === 'epoch_expired' || error.code === 'result_expired'
              ? 'idempotency_expired'
              : error.code === 'idempotency_capacity'
                ? 'resource_limit'
                : 'invalid_state'
        throw new ServiceActionError(code)
      }
      if (error instanceof WorkspaceMutationError) {
        const code: ActionCode =
          error.code === 'workspace_not_found' || error.code === 'group_not_found'
            ? 'target_not_found'
            : error.code === 'workspace_limit_reached' || error.code === 'group_limit_reached'
              ? 'resource_limit'
              : 'policy_denied'
        throw new ServiceActionError(code)
      }
      throw error
    }
  }
}
