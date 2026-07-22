import { describe, expect, it } from 'vitest'
import {
  remoteSessionConnectParamsSchema,
  remoteListParamsSchema,
  remoteSessionStateSchema,
  remoteSessionListResultSchema,
  remoteTargetCreateParamsSchema
} from './schemas'

const id = '00000000-0000-4000-8000-000000000001'
const mutation = { idempotencyKey: id, requestHash: 'a'.repeat(64), expectedRevision: 0 }

describe('remote session schemas', () => {
  it('accepts only the closed lifecycle', () => {
    expect(remoteSessionStateSchema.safeParse('connected').success).toBe(true)
    expect(remoteSessionStateSchema.safeParse('runningShell').success).toBe(false)
  })

  it('rejects credential and arbitrary SSH surfaces', () => {
    const target = {
      remoteTargetId: id,
      label: 'dev',
      host: 'example.com',
      port: 22,
      user: 'alice',
      mutation
    }
    expect(remoteTargetCreateParamsSchema.safeParse(target).success).toBe(true)
    expect(
      remoteTargetCreateParamsSchema.safeParse({ ...target, privateKey: 'secret' }).success
    ).toBe(false)
    expect(
      remoteTargetCreateParamsSchema.safeParse({ ...target, proxyCommand: 'anything' }).success
    ).toBe(false)
    expect(
      remoteTargetCreateParamsSchema.safeParse({ ...target, host: '[2001:db8::1]' }).success
    ).toBe(false)
  })

  it('rejects arbitrary remote commands and unsafe tmux names', () => {
    const connect = {
      remoteSessionId: id,
      remoteTargetId: id,
      workspaceId: id,
      paneId: id,
      tabId: id,
      reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 10_000 },
      mutation
    }
    expect(
      remoteSessionConnectParamsSchema.safeParse({ ...connect, command: 'curl example.com' })
        .success
    ).toBe(false)
    expect(
      remoteSessionConnectParamsSchema.safeParse({
        ...connect,
        tmux: { mode: 'attach', sessionName: 'x;id' }
      }).success
    ).toBe(false)
  })

  it('uses bounded opaque pagination cursors', () => {
    expect(remoteListParamsSchema.safeParse({ limit: 128, cursor: id }).success).toBe(true)
    expect(remoteListParamsSchema.safeParse({ limit: 129 }).success).toBe(false)
    expect(remoteListParamsSchema.safeParse({ limit: 1, cursor: 'offset:1' }).success).toBe(false)
    expect(remoteSessionListResultSchema.safeParse({ sessions: [], nextCursor: id }).success).toBe(
      true
    )
    expect(
      remoteSessionListResultSchema.safeParse({ sessions: [], nextCursor: null }).success
    ).toBe(false)
  })
})
