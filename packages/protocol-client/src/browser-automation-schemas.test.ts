import { describe, expect, it } from 'vitest'

import {
  browserAutomationOperationSchema,
  browserAutomationOperationInvokeParamsSchema,
  browserAutomationOperationResultDataSchema,
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
  it('accepts keyboard operations and rejects explicit null ambiguity', () => {
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

  it('accepts evaluation and diagnostics while bounding their results', () => {
    for (const operation of [
      { kind: 'evaluate', expression: '1+1' },
      { kind: 'console', clear: true },
      { kind: 'errors' }
    ]) {
      expect(
        browserAutomationOperationInvokeParamsSchema.safeParse(invoke(operation)).success
      ).toBe(true)
    }
    expect(
      browserAutomationOperationResultDataSchema.safeParse({
        kind: 'evaluation',
        value: { answer: [2, null] }
      }).success
    ).toBe(true)
    expect(
      browserAutomationOperationResultDataSchema.safeParse({
        kind: 'evaluation',
        value: 'x'.repeat(65_536)
      }).success
    ).toBe(false)
    expect(
      browserAutomationOperationResultDataSchema.safeParse({ kind: 'evaluation', value: Infinity })
        .success
    ).toBe(false)
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
        mode: 'attach',
        ...base,
        attachTabId: ID,
        attachWindowId: SECOND_ID
      }).success
    ).toBe(true)
    expect(
      browserAutomationSessionCreateParamsSchema.safeParse({
        mode: 'attach',
        ...base,
        attachTabId: ID
      }).success
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

  it('requires the correct media type for screenshot and recording results', () => {
    const handle = {
      handleId: ID,
      width: 320,
      height: 240,
      byteLength: 3,
      sha256: '0'.repeat(64),
      chunkCount: 1,
      expiresAtMs: 1
    }
    for (const [kind, mediaType] of [
      ['screenshot', 'image/png'],
      ['recording', 'video/webm']
    ]) {
      expect(
        browserAutomationOperationResultDataSchema.safeParse({
          kind,
          handle: { ...handle, mediaType }
        }).success
      ).toBe(true)
      expect(
        browserAutomationOperationResultDataSchema.safeParse({
          kind,
          handle: { ...handle, mediaType: mediaType === 'image/png' ? 'video/webm' : 'image/png' }
        }).success
      ).toBe(false)
    }
  })
})

it('accepts browser inspection/control operations and requires unambiguous targets', () => {
  for (const operation of [
    { kind: 'snapshot' },
    { kind: 'networkGet', requestId: '1' },
    { kind: 'networkBody', requestId: '1' },
    { kind: 'recordingStart', width: 320, height: 240 },
    { kind: 'appearance', colorScheme: 'dark' },
    { kind: 'click', locator: { role: 'button', name: 'Send' } },
    { kind: 'typeText', locator: { text: 'Message' }, clear: true, text: 'abc' },
    { kind: 'key', key: 'a', modifiers: ['control'] },
    { kind: 'wait', condition: { kind: 'text', text: 'Saved' } }
  ])
    expect(browserAutomationOperationSchema.safeParse(operation).success).toBe(true)
  expect(
    browserAutomationOperationSchema.safeParse({
      kind: 'click',
      selector: 'button',
      locator: { text: 'Send' }
    }).success
  ).toBe(false)
})
