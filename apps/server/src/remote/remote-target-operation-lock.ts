import { CredentialReference } from './credential-provider'

/** Process-local serialization for credential mutation and SSH activation of one target. */
export class RemoteTargetOperationLock {
  private readonly tails = new Map<string, Promise<void>>()

  public async withTarget<T>(targetId: string, run: () => Promise<T>): Promise<T> {
    const exactId = CredentialReference.forTarget(targetId).targetId
    if (exactId !== targetId) throw new Error('invalid remote target identifier')
    const previous = this.tails.get(exactId)
    let release!: () => void
    const done = new Promise<void>((resolve) => { release = resolve })
    this.tails.set(exactId, done)
    if (previous) await previous
    try {
      return await run()
    } finally {
      if (this.tails.get(exactId) === done) this.tails.delete(exactId)
      release()
    }
  }
}

/** Used by default when both services run in the same trusted Node process. */
export const sharedRemoteTargetOperationLock = new RemoteTargetOperationLock()
