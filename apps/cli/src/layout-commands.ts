import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import {
  layoutApplyRequestSchema,
  layoutDeleteRequestSchema,
  layoutExportEnvelopeSchema,
  layoutImportRequestSchema,
  layoutSaveRequestSchema
} from '@agent-workspace/contracts'

import { flags, required } from './options'

type LayoutMutation = 'layout.save' | 'layout.delete' | 'layout.apply' | 'layout.import'

export interface LayoutCommand {
  sessionFile: string
  command: 'layout.mutate'
  operation: LayoutMutation
  values: Map<string, string>
  workspaceIds?: string[]
}

const MAX_ENVELOPE_BYTES = 256 * 1024
const revisionOptions = ['--expected-revision', '--idempotency-key'] as const

function saveFlags(args: string[]) {
  const workspaceIds: string[] = []
  const remainder: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--workspace-id') {
      remainder.push(args[index]!)
      continue
    }
    const id = args[++index]
    if (!id || id.startsWith('--')) throw new Error('--workspace-id requires a value')
    workspaceIds.push(id)
  }
  const { values } = flags(remainder, ['--layout-id', '--name', ...revisionOptions])
  if (workspaceIds.length === 0) throw new Error('--workspace-id is required')
  return { values, workspaceIds }
}

export function parseLayoutCommand(args: string[], sessionFile: string): LayoutCommand | undefined {
  if (args[0] !== 'layout') return undefined
  const verb = args[1]
  if (verb !== 'save' && verb !== 'delete' && verb !== 'apply' && verb !== 'import') {
    return undefined
  }
  const parsed = verb === 'save'
    ? saveFlags(args.slice(2))
    : flags(args.slice(2), [
        '--layout-id',
        ...(verb === 'import' ? ['--file'] : []),
        ...revisionOptions
      ])
  required(parsed.values, '--layout-id')
  required(parsed.values, '--expected-revision')
  if (verb === 'save') required(parsed.values, '--name')
  if (verb === 'import') required(parsed.values, '--file')
  return {
    sessionFile,
    command: 'layout.mutate',
    operation: `layout.${verb}`,
    values: parsed.values,
    ...('workspaceIds' in parsed ? { workspaceIds: parsed.workspaceIds } : {})
  }
}

function nonnegativeRevision(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('--expected-revision must be a nonnegative safe integer')
  }
  return Number(value)
}

async function readLayoutEnvelope(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_ENVELOPE_BYTES) {
      throw new Error('Layout import requires a regular file no larger than 256 KiB')
    }
    const bytes = Buffer.alloc(MAX_ENVELOPE_BYTES + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > MAX_ENVELOPE_BYTES) throw new Error('Layout import exceeds 256 KiB')
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)))
    } catch {
      throw new Error('Layout import file must contain one UTF-8 JSON envelope')
    }
    return layoutExportEnvelopeSchema.parse(value)
  } finally {
    await file.close()
  }
}

export async function layoutRequest(parsed: LayoutCommand, idempotencyEpoch: string) {
  const { values } = parsed
  const identity = {
    expectedRevision: nonnegativeRevision(required(values, '--expected-revision')),
    idempotencyEpoch,
    idempotencyKey: values.get('--idempotency-key') ?? randomUUID()
  }
  const layoutId = required(values, '--layout-id')
  switch (parsed.operation) {
    case 'layout.save':
      return layoutSaveRequestSchema.parse({
        layoutId,
        name: required(values, '--name'),
        workspaceIds: parsed.workspaceIds,
        ...identity
      })
    case 'layout.delete':
      return layoutDeleteRequestSchema.parse({ layoutId, ...identity })
    case 'layout.apply':
      return layoutApplyRequestSchema.parse({ layoutId, ...identity })
    case 'layout.import':
      return layoutImportRequestSchema.parse({
        layoutId,
        envelope: await readLayoutEnvelope(required(values, '--file')),
        ...identity
      })
  }
}

export async function runLayoutCommand(
  client: AgentWorkspaceClient,
  parsed: LayoutCommand,
  idempotencyEpoch: string
): Promise<unknown> {
  const request = await layoutRequest(parsed, idempotencyEpoch)
  switch (parsed.operation) {
    case 'layout.save':
      return client.saveLayout(layoutSaveRequestSchema.parse(request))
    case 'layout.delete':
      return client.deleteLayout(layoutDeleteRequestSchema.parse(request))
    case 'layout.apply':
      return client.applyLayout(layoutApplyRequestSchema.parse(request))
    case 'layout.import':
      return client.importLayout(layoutImportRequestSchema.parse(request))
  }
}
