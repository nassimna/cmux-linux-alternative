import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

export type CredentialErrorCode =
  | 'credential_required'
  | 'credential_provider_unavailable'
  | 'credential_revoked'
  | 'unsafe_agent_socket'

export class CredentialError extends Error {
  public constructor(
    public readonly code: CredentialErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CredentialError'
  }
}

const unavailable = () =>
  new CredentialError(
    'credential_provider_unavailable',
    'Trusted credential provider is unavailable'
  )
const unsafeSocket = () =>
  new CredentialError('unsafe_agent_socket', 'SSH agent socket is not an owner-only Unix socket')

/** Non-secret, target-bound locator. Never persist a socket path or key material in a profile. */
export class CredentialReference {
  private constructor(
    public readonly targetId: string,
    private readonly isolatedScopeId?: string
  ) {}

  public static forTarget(targetId: string): CredentialReference {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) {
      throw new CredentialError('credential_revoked', 'Invalid credential target')
    }
    return new CredentialReference(targetId.toLowerCase())
  }

  public static forIsolatedTarget(targetId: string, scopeId: string): CredentialReference {
    const reference = this.forTarget(targetId)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(scopeId)) {
      throw new CredentialError('credential_revoked', 'Invalid isolated credential scope')
    }
    return new CredentialReference(reference.targetId, scopeId)
  }

  public get locator(): string {
    return this.isolatedScopeId
      ? `v2-${this.isolatedScopeId}-${this.targetId}`
      : `v1-${this.targetId}`
  }

  public toString(): string {
    return '[CredentialReference REDACTED]'
  }
}

/** A broker-created socket is accepted only inside a canonical, owner-only attempt directory. */
export async function validateAgentSocket(path: string): Promise<void> {
  if (process.platform !== 'linux' || !isAbsolute(path) || !process.getuid) throw unsafeSocket()
  try {
    const uid = process.getuid()
    const parent = dirname(path)
    const parentStat = await lstat(parent)
    const socketStat = await lstat(path)
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      parentStat.uid !== uid ||
      (parentStat.mode & 0o077) !== 0 ||
      (await realpath(parent)) !== parent ||
      !socketStat.isSocket() ||
      socketStat.isSymbolicLink() ||
      socketStat.uid !== uid ||
      socketStat.nlink !== 1 ||
      (socketStat.mode & 0o077) !== 0
    )
      throw unsafeSocket()
  } catch {
    throw unsafeSocket()
  }
}

/** The broker owns revocation. Closing the lease must disable signing before unlinking its socket. */
export class CredentialBrokerLease {
  #closed = false
  private constructor(
    public readonly targetId: string,
    public readonly generation: number,
    socketPath: string,
    revoke: () => Promise<void>
  ) {
    this.#path = socketPath
    this.#revoke = revoke
  }

  readonly #path: string
  readonly #revoke: () => Promise<void>

  /** Creates a fresh broker itself; callers cannot wrap an arbitrary socket. */
  public static async fromSigningBroker(
    brokerRoot: string,
    targetId: string,
    generation: number,
    secret: Buffer,
    hostPublicKey: string
  ): Promise<CredentialBrokerLease> {
    CredentialReference.forTarget(targetId)
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new CredentialError('credential_revoked', 'Invalid credential attempt')
    }
    const { createSigningBroker } = await import('./credential-agent-broker')
    const handle = await createSigningBroker(brokerRoot, targetId, generation, secret, hostPublicKey)
    try {
      await validateAgentSocket(handle.socketPath)
      return new CredentialBrokerLease(
        targetId.toLowerCase(),
        generation,
        handle.socketPath,
        handle.revoke
      )
    } catch (error) {
      await handle.revoke()
      throw error
    }
  }

  public async socketFor(targetId: string, generation: number): Promise<string> {
    if (
      this.#closed ||
      targetId.toLowerCase() !== this.targetId ||
      generation !== this.generation
    ) {
      throw new CredentialError(
        'credential_revoked',
        'Credential lease does not match this attempt'
      )
    }
    await validateAgentSocket(this.#path)
    return this.#path
  }

  public async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#revoke()
  }

  public toString(): string {
    return '[CredentialBrokerLease REDACTED]'
  }
}

export interface CredentialProvider {
  acquire(
    reference: CredentialReference,
    targetId: string,
    generation: number,
    hostPublicKey: string
  ): Promise<CredentialBrokerLease>
}

/** Safe production default until an exact Secret Service lookup and signing broker are installed. */
export class UnavailableCredentialProvider implements CredentialProvider {
  public async acquire(
    _reference: CredentialReference,
    _targetId: string,
    _generation: number,
    _hostPublicKey: string
  ): Promise<CredentialBrokerLease> {
    throw unavailable()
  }
}
