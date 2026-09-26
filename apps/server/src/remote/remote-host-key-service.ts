import {
  remoteHostKeyChallengeSchema,
  remoteHostKeyScanParamsSchema,
  remoteHostKeyTrustParamsSchema,
  remoteSessionConnectParamsSchema,
  remoteSessionResultSchema,
  type RemoteHostKeyScanParams,
  type RemoteHostKeyTrustParams,
  type RemoteSessionConnectParams
} from '@agent-workspace/contracts'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { RemoteCatalogError } from '../persistence/remote-catalog'
import { HostKeyAuthorityError, type HostKeyAuthority } from './host-key-authority'
import { HostKeyScanError } from './host-key-scanner'
import { KnownHostsError } from './known-hosts-store'
import {
  sharedRemoteTargetOperationLock,
  type RemoteTargetOperationLock
} from './remote-target-operation-lock'

type RemoteFailure = { remoteError: { code: string; message: string } }

function remoteFailure(error: unknown): RemoteFailure | null {
  if (
    error instanceof HostKeyAuthorityError ||
    error instanceof HostKeyScanError ||
    error instanceof KnownHostsError
  ) {
    return { remoteError: { code: error.code, message: error.message } }
  }
  return null
}

function replay(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'remoteError' in value) {
    const failure = (value as RemoteFailure).remoteError
    if (typeof failure?.code === 'string' && typeof failure.message === 'string') {
      const code =
        failure.code === 'host_key_mismatch' ||
        failure.code === 'scan_unavailable' ||
        failure.code === 'unsafe_known_hosts' ||
        failure.code === 'prompt_capacity'
          ? failure.code
          : 'invalid_state'
      throw new RemoteCatalogError(code, failure.message)
    }
  }
  return value
}

/** A bounded host-key workflow. No credentials or SSH sessions are opened here. */
export class RemoteHostKeyService {
  public constructor(
    private readonly state: ApplicationStateStore,
    private readonly authority: HostKeyAuthority,
    private readonly targetLock: RemoteTargetOperationLock = sharedRemoteTargetOperationLock
  ) {}

  public async prepare(input: RemoteSessionConnectParams) {
    const request = remoteSessionConnectParamsSchema.parse(input)
    return this.withTarget(request.remoteTargetId, async () => {
      const replay = this.state.getRemoteSessionPrepareReplay(request.mutation)
      if (replay) return replay
      const target = this.state.getRemoteTarget(request.remoteTargetId).target
      if (target.hostKeyState === 'trusted') await this.authority.verify(target)
      return this.state.exclusive(() => this.state.prepareRemoteSession(request))
    })
  }

  public async scan(input: RemoteHostKeyScanParams) {
    const request = remoteHostKeyScanParamsSchema.parse(input)
    const initial = this.state.getRemoteSession(request.remoteSessionId).session
    return this.withTarget(initial.remoteTargetId, () =>
      this.scanForTarget(request, initial.remoteTargetId)
    )
  }

  private async scanForTarget(request: RemoteHostKeyScanParams, targetId: string) {
    const session = this.state.getRemoteSession(request.remoteSessionId).session
    if (session.remoteTargetId !== targetId) {
      throw new RemoteCatalogError('stale_revision', 'Remote session target changed')
    }
    if (session.state !== 'trustRequired') {
      throw new RemoteCatalogError(
        'invalid_state',
        'Remote session does not require host-key trust'
      )
    }
    const target = this.state.getRemoteTarget(session.remoteTargetId).target
    const prior = await this.state.exclusive(() =>
      this.state.reserveHostKeyOperation('scan', session.remoteSessionId, request.mutation)
    )
    if (prior.replay) {
      const challenge = remoteHostKeyChallengeSchema.parse(replay(prior.value))
      if (!this.authority.hasPrompt(challenge.promptId)) {
        throw new RemoteCatalogError('result_expired', 'Host-key prompt is no longer active')
      }
      return challenge
    }
    try {
      const challenge = remoteHostKeyChallengeSchema.parse(
        await this.authority.challenge(target, session.remoteSessionId, session.attemptGeneration)
      )
      await this.state.exclusive(() =>
        this.state.completeHostKeyOperation('scan', request.mutation, challenge)
      )
      return challenge
    } catch (error) {
      const failure = remoteFailure(error)
      if (failure) {
        await this.state.exclusive(() =>
          this.state.completeHostKeyOperation('scan', request.mutation, failure)
        )
      }
      throw error
    }
  }

  public async decide(input: RemoteHostKeyTrustParams) {
    const request = remoteHostKeyTrustParamsSchema.parse(input)
    const initial = this.state.getRemoteSession(request.remoteSessionId).session
    return this.withTarget(initial.remoteTargetId, () =>
      this.decideForTarget(request, initial.remoteTargetId)
    )
  }

  private async decideForTarget(request: RemoteHostKeyTrustParams, targetId: string) {
    const session = this.state.getRemoteSession(request.remoteSessionId).session
    if (session.remoteTargetId !== targetId) {
      throw new RemoteCatalogError('stale_revision', 'Remote session target changed')
    }
    if (
      session.state !== 'trustRequired' ||
      session.attemptGeneration !== request.attemptGeneration
    ) {
      throw new RemoteCatalogError('stale_revision', 'Remote session attempt changed')
    }
    const target = this.state.getRemoteTarget(session.remoteTargetId).target
    const prior = await this.state.exclusive(() =>
      this.state.reserveHostKeyOperation('decide', target.remoteTargetId, request.mutation)
    )
    if (prior.replay) return remoteSessionResultSchema.parse(replay(prior.value))
    try {
      await this.authority.decide(target, request)
    } catch (error) {
      const failure = remoteFailure(error)
      if (failure) {
        await this.state.exclusive(() =>
          this.state.completeHostKeyOperation('decide', request.mutation, failure)
        )
      }
      throw error
    }
    const result = remoteSessionResultSchema.parse({ session })
    await this.state.exclusive(() =>
      this.state.commitHostKeyDecision(
        target.remoteTargetId,
        request.mutation,
        request.decision,
        result
      )
    )
    return result
  }

  private async withTarget<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
    return this.targetLock.withTarget(targetId, operation)
  }
}
