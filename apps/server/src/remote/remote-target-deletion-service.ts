import {
  remoteTargetDeleteParamsSchema,
  type RemoteTargetDeleteParams
} from '@agent-workspace/protocol-client'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import type { SecretServiceCredentialProvider } from './credential-secret-service'
import type { HostKeyAuthority } from './host-key-authority'
import type { RemoteSessionActivationService } from './remote-session-activation-service'
import {
  sharedRemoteTargetOperationLock,
  type RemoteTargetOperationLock
} from './remote-target-operation-lock'

/**
 * A durable deletion fence precedes every external cleanup step. An interrupted
 * operation remains fenced and may be resumed with the same mutation identity.
 */
export class RemoteTargetDeletionService {
  public constructor(
    private readonly state: ApplicationStateStore,
    private readonly activation: Pick<RemoteSessionActivationService, 'terminate'>,
    private readonly hostKeys: Pick<HostKeyAuthority, 'removeTarget'>,
    private readonly keyring: Pick<SecretServiceCredentialProvider, 'deleteFencedTarget'>,
    private readonly targetLock: RemoteTargetOperationLock = sharedRemoteTargetOperationLock
  ) {}

  public async delete(input: RemoteTargetDeleteParams) {
    const request = remoteTargetDeleteParamsSchema.parse(input)
    return this.targetLock.withTarget(request.remoteTargetId, async () => {
      const begun = await this.state.exclusive(() => this.state.beginRemoteTargetDeletion(request))
      if (begun.replay) return begun.value

      // The fence has already closed every session. A failed termination keeps
      // the target and deletion intent in place for an exact retry.
      const sessions = this.state.remoteSessionsForTargetDeletion(request.remoteTargetId)
      for (const session of sessions) {
        await this.activation.terminate(session.remoteSessionId, session.attemptGeneration)
      }
      await this.hostKeys.removeTarget(request.remoteTargetId)
      await this.keyring.deleteFencedTarget(request.remoteTargetId)
      return this.state.exclusive(() => this.state.finishRemoteTargetDeletion(request))
    })
  }

  /** Run before remote transport accepts work, or leave startup unavailable. */
  public async recoverPending(): Promise<number> {
    const pending = this.state.pendingRemoteTargetDeletions()
    for (const request of pending) await this.delete(request)
    return pending.length
  }
}
