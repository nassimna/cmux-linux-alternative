import { describe, expect, it } from 'vitest'

import {
  browserAutomationOperationInvokeParamsSchema,
  browserAutomationProviderAcknowledgeParamsSchema,
  browserAutomationScreenshotReadResultSchema,
  browserAutomationSessionCreateParamsSchema
} from './schemas'

const ID = '10000000-0000-4000-8000-000000000001'
const SECOND_ID = '10000000-0000-4000-8000-000000000002'

function invoke(operation: unknown): unknown {
  return {
    automationSessionId: ID,
    sessionGeneration: 1,
    navigationEpoch: 0,
    operationId: SECOND_ID,
    attemptEpoch: 1,
    timeoutMs: 30_000,
    operation,
    idempotency: { epoch: ID, key: SECOND_ID },
    correlationId: ID
  }
}

describe('browser automation schemas', () => {
  it('accepts only the closed key variants and rejects explicit null ambiguity', () => {
    expect(
      browserAutomationOperationInvokeParamsSchema.safeParse(invoke({ kind: 'key', key: 'enter' }))
        .success
    ).toBe(true)
    expect(
      browserAutomationOperationInvokeParamsSchema.safeParse(
        invoke({ kind: 'keyAt', selector: '#field', key: 'enter' })
      ).success
    ).toBe(true)
    expect(
      browserAutomationOperationInvokeParamsSchema.safeParse(
        invoke({ kind: 'key', selector: null, key: 'enter' })
      ).success
    ).toBe(false)
  })

  it('rejects scripts, credentials, unsafe URLs, oversized images, and unknown fields', () => {
    for (const operation of [
      { kind: 'navigate', url: 'javascript:alert(1)' },
      { kind: 'navigate', url: 'https://user:secret@example.test/' },
      { kind: 'query', selector: '#x', limit: 1, script: 'document.cookie' },
      { kind: 'screenshot', width: 4096, height: 4096 }
    ]) {
      expect(
        browserAutomationOperationInvokeParamsSchema.safeParse(invoke(operation)).success
      ).toBe(false)
    }
  })

  it('requires attach targets and forbids ephemeral target selection', () => {
    const base = {
      profileKey: 'private',
      idempotency: { epoch: ID, key: SECOND_ID },
      correlationId: ID
    }
    expect(
      browserAutomationSessionCreateParamsSchema.safeParse({ mode: 'attach', ...base }).success
    ).toBe(false)
    expect(
      browserAutomationSessionCreateParamsSchema.safeParse({
        mode: 'ephemeral',
        ...base,
        target: {
          workspaceId: ID,
          paneId: ID,
          tabId: ID,
          browserSessionId: ID,
          browserLifecycleId: ID,
          window: { windowId: ID, windowGeneration: 1 }
        }
      }).success
    ).toBe(false)
  })

  it('rejects explicit null provider acknowledgement optionals', () => {
    const base = {
      identity: { providerId: ID, providerEpoch: 1, leaseId: SECOND_ID },
      target: { windowId: ID, windowGeneration: 1 },
      automationSessionId: ID,
      sessionGeneration: 1,
      operationId: SECOND_ID,
      correlationId: ID,
      attemptEpoch: 1,
      state: 'succeeded',
      result: null,
      errorCode: null
    }
    expect(browserAutomationProviderAcknowledgeParamsSchema.safeParse(base).success).toBe(false)
    expect(
      browserAutomationProviderAcknowledgeParamsSchema.safeParse({
        ...base,
        state: 'queued',
        result: undefined,
        errorCode: undefined
      }).success
    ).toBe(false)
    expect(
      browserAutomationProviderAcknowledgeParamsSchema.safeParse({
        ...base,
        state: 'failed',
        result: undefined,
        errorCode: undefined
      }).success
    ).toBe(false)
  })

  it('accepts only canonical bounded screenshot base64 chunks', () => {
    const chunk = {
      handleId: ID,
      chunkIndex: 0,
      chunkCount: 1,
      dataBase64: 'cG5n',
      sha256: '0'.repeat(64),
      expiresAtMs: 1
    }
    expect(browserAutomationScreenshotReadResultSchema.safeParse(chunk).success).toBe(true)
    for (const dataBase64 of ['abc', 'cG5n=', 'A===', 'YR==']) {
      expect(
        browserAutomationScreenshotReadResultSchema.safeParse({ ...chunk, dataBase64 }).success
      ).toBe(false)
    }
  })
})
