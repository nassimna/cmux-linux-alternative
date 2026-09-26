import { describe, expect, it } from 'vitest'

import type {
  BrowserAutomationProviderAcknowledgeParams,
  BrowserAutomationProviderRequest,
  DesktopProviderIdentityParams
} from '@agent-workspace/protocol-client'

import { BrowserAutomationProviderMailbox } from './provider-mailbox'

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
const identity: DesktopProviderIdentityParams = {
  providerId: id('1'), providerEpoch: 1, leaseId: id('2')
}
const target = { windowId: id('3'), windowGeneration: 1 }

function createRequest(): BrowserAutomationProviderRequest {
  return {
    kind: 'create',
    identity,
    target,
    provision: {
      automationSessionId: id('4'),
      generation: 1,
      mode: 'ephemeral',
      profileKey: 'default',
      createdAtMs: 1,
      expiresAtMs: 1_000
    },
    operationId: id('5'),
    correlationId: id('6'),
    attemptEpoch: 1
  }
}

function successAck(): BrowserAutomationProviderAcknowledgeParams {
  return {
    identity,
    target,
    automationSessionId: id('4'),
    sessionGeneration: 1,
    operationId: id('5'),
    correlationId: id('6'),
    attemptEpoch: 1,
    state: 'succeeded',
    session: {
      automationSessionId: id('4'),
      generation: 1,
      navigationEpoch: 1,
      mode: 'ephemeral',
      state: 'ready',
      profileKey: 'default',
      target: {
        workspaceId: id('7'), paneId: id('8'), tabId: id('9'),
        browserSessionId: id('10'), browserLifecycleId: id('11'), window: target
      },
      createdAtMs: 1,
      updatedAtMs: 2,
      expiresAtMs: 1_000
    }
  }
}

describe('browser automation provider mailbox', () => {
  it('delivers one request and accepts only the exact current lease and target', async () => {
    let active = true
    const mailbox = new BrowserAutomationProviderMailbox((candidate, window) =>
      active && candidate.providerId === identity.providerId &&
      candidate.providerEpoch === identity.providerEpoch && candidate.leaseId === identity.leaseId &&
      (!window || (window.windowId === target.windowId && window.windowGeneration === target.windowGeneration))
    )
    const published = mailbox.publish(createRequest())
    expect((await mailbox.poll({ identity, timeoutMs: 0 })).request).toEqual(createRequest())
    expect(() => mailbox.acknowledge({ ...successAck(), correlationId: id('12') }))
      .toThrowError('provider_epoch_mismatch')
    active = false
    expect(() => mailbox.acknowledge(successAck())).toThrowError('provider_epoch_mismatch')
    active = true
    mailbox.acknowledge(successAck())
    expect(await published.completion).toMatchObject({ kind: 'acknowledge' })
    expect(() => mailbox.acknowledge(successAck())).toThrowError('canceled')
    mailbox.dispose()
  })

  it('keeps other provider work queued and interrupts it on revocation', async () => {
    const second = { providerId: id('13'), providerEpoch: 1, leaseId: id('14') }
    const mailbox = new BrowserAutomationProviderMailbox(() => true)
    const request = { ...createRequest(), identity: second }
    const published = mailbox.publish(request)
    expect(await mailbox.poll({ identity, timeoutMs: 0 })).toEqual({})
    expect((await mailbox.poll({ identity: second, timeoutMs: 0 })).request).toEqual(request)
    mailbox.revokeProvider(second.providerId)
    expect(await published.completion).toEqual({ kind: 'interrupted' })
    expect(() => mailbox.acknowledge({ ...successAck(), identity: second }))
      .toThrowError('canceled')
    mailbox.dispose()
  })

  it('never delivers a new epoch request to an old poll waiter with the same provider ID', async () => {
    const mailbox = new BrowserAutomationProviderMailbox(() => true)
    const oldPoll = mailbox.poll({ identity, timeoutMs: 30_000 })
    const nextIdentity = { ...identity, providerEpoch: 2, leaseId: id('22') }
    const request = { ...createRequest(), identity: nextIdentity }
    const published = mailbox.publish(request)
    expect(await oldPoll).toEqual({})
    expect(await mailbox.poll({ identity: nextIdentity, timeoutMs: 0 })).toEqual({ request })
    mailbox.cancel(published.requestId)
    expect(await published.completion).toEqual({ kind: 'interrupted' })
    mailbox.dispose()
  })

  it('rejects malformed provider results without consuming the request', async () => {
    const mailbox = new BrowserAutomationProviderMailbox(() => true)
    const published = mailbox.publish(createRequest())
    await mailbox.poll({ identity, timeoutMs: 0 })
    const missingSession = successAck()
    delete missingSession.session
    expect(() => mailbox.acknowledge(missingSession))
      .toThrow()
    mailbox.acknowledge(successAck())
    expect(await published.completion).toMatchObject({ kind: 'acknowledge' })
    mailbox.dispose()
  })

  it('matches screenshot transfer responses to the exact handle and chunk', async () => {
    const mailbox = new BrowserAutomationProviderMailbox(() => true)
    const request: BrowserAutomationProviderRequest = {
      kind: 'screenshotRead', identity, target,
      requestId: id('15'), correlationId: id('16'),
      params: { automationSessionId: id('4'), sessionGeneration: 1, handleId: id('17'), chunkIndex: 0 }
    }
    const published = mailbox.publish(request)
    await mailbox.poll({ identity, timeoutMs: 0 })
    const response = {
      identity, target, requestId: id('15'), correlationId: id('16'),
      outcome: {
        kind: 'screenshotRead' as const,
        result: {
          handleId: id('17'), chunkIndex: 0, chunkCount: 1,
          dataBase64: Buffer.from('png').toString('base64'),
          sha256: 'a'.repeat(64), expiresAtMs: 1_000
        }
      }
    }
    expect(() => mailbox.respondTransfer({
      ...response, outcome: {
        ...response.outcome,
        result: { ...response.outcome.result, handleId: id('18') }
      }
    })).toThrowError('invalid_operation')
    mailbox.respondTransfer(response)
    expect(await published.completion).toMatchObject({ kind: 'transfer' })
    mailbox.dispose()
  })
})
