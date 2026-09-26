import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

import type { CredentialBrokerLease } from './credential-provider'
import { isVerifiedHostKeyLaunch, type VerifiedHostKeyLaunch } from './host-key-authority'
import { readKnownHostExact } from './known-hosts-store'
import { tmuxCommand, type TmuxOperation } from './tmux-protocol'

export type SshErrorCode =
  | 'unsafe_ssh_executable'
  | 'unsafe_known_hosts'
  | 'host_key_untrusted'
  | 'host_key_mismatch'
  | 'invalid_target'

export class SshLaunchError extends Error {
  public constructor(public readonly code: SshErrorCode) {
    super(code.replaceAll('_', ' '))
    this.name = 'SshLaunchError'
  }
}

export interface VerifiedRemoteTarget {
  readonly proof: VerifiedHostKeyLaunch
  readonly generation: number
  readonly user: string
  readonly knownHostsVersion: number
}

/** Call HostKeyAuthority.verifyForLaunch first; caller claims cannot create a launch proof. */
export function verifyRemoteTarget(input: {
  proof: VerifiedHostKeyLaunch
  generation: number
  user: string
  knownHostsVersion: number
}): VerifiedRemoteTarget {
  const proof = input.proof
  if (!isVerifiedHostKeyLaunch(proof)) throw new SshLaunchError('host_key_untrusted')
  if (
    !Number.isSafeInteger(input.generation) ||
    input.generation <= 0 ||
    !Number.isSafeInteger(input.knownHostsVersion) ||
    input.knownHostsVersion <= 0 ||
    proof.host.length > 253 ||
    !/^[a-z0-9][a-z0-9.-]*$/.test(proof.host) ||
    !Number.isInteger(proof.port) ||
    proof.port < 1 ||
    proof.port > 65535 ||
    input.user.length > 64 ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(input.user)
  )
    throw new SshLaunchError('invalid_target')
  return Object.freeze({
    proof,
    generation: input.generation,
    user: input.user,
    knownHostsVersion: input.knownHostsVersion
  })
}

async function validateSshExecutable(path: string): Promise<void> {
  if (process.platform !== 'linux' || !isAbsolute(path))
    throw new SshLaunchError('unsafe_ssh_executable')
  try {
    const canonical = await realpath(path)
    if (canonical !== '/usr/bin/ssh' && canonical !== '/bin/ssh') throw new Error('unapproved path')
    const stat = await lstat(canonical)
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o111) === 0 ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error('unsafe executable')
    }
  } catch {
    throw new SshLaunchError('unsafe_ssh_executable')
  }
}

async function validateKnownHosts(path: string): Promise<void> {
  if (process.platform !== 'linux' || !isAbsolute(path) || !process.getuid)
    throw new SshLaunchError('unsafe_known_hosts')
  try {
    const parent = dirname(path)
    const parentStat = await lstat(parent)
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      parentStat.uid !== process.getuid() ||
      (parentStat.mode & 0o077) !== 0 ||
      (await realpath(parent)) !== parent
    )
      throw new Error('unsafe parent')
    const stat = await lstat(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error('unsafe file')
    }
  } catch {
    throw new SshLaunchError('unsafe_known_hosts')
  }
}

/** Fixed stock OpenSSH invocation. The caller must clear the child environment except plan.env. */
export class SshLaunchPlan {
  private constructor(
    public readonly executable: string,
    public readonly argv: readonly string[],
    private readonly knownHosts: string,
    private readonly lease: CredentialBrokerLease,
    private readonly target: VerifiedRemoteTarget
  ) {}

  public static async create(input: {
    sshExecutable: string
    lease: CredentialBrokerLease
    target: VerifiedRemoteTarget
    operation: TmuxOperation
  }): Promise<SshLaunchPlan> {
    if (!isVerifiedHostKeyLaunch(input.target.proof)) throw new SshLaunchError('host_key_untrusted')
    await validateSshExecutable(input.sshExecutable)
    await validateKnownHosts(input.target.proof.knownHostsPath)
    await input.lease.socketFor(input.target.proof.remoteTargetId, input.target.generation)
    const remote = tmuxCommand(input.operation)
    const interactive = input.operation.kind === 'attach' || input.operation.kind === 'create'
    const argv = [
      '-F',
      '/dev/null',
      '-o',
      `UserKnownHostsFile=${input.target.proof.knownHostsPath}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'HostKeyAlgorithms=ssh-ed25519',
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=no',
      '-o',
      'IdentityFile=none',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'PubkeyAuthentication=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ProxyCommand=none',
      '-o',
      'ProxyJump=none',
      '-o',
      'CanonicalizeHostname=no',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      `RequestTTY=${interactive ? 'force' : 'no'}`,
      '-p',
      String(input.target.proof.port),
      '-l',
      input.target.user,
      '--',
      input.target.proof.host,
      remote
    ]
    return new SshLaunchPlan(
      input.sshExecutable,
      Object.freeze(argv),
      input.target.proof.knownHostsPath,
      input.lease,
      input.target
    )
  }

  public async revalidate(): Promise<void> {
    await validateSshExecutable(this.executable)
    await validateKnownHosts(this.knownHosts)
    const { proof } = this.target
    try {
      const current = await readKnownHostExact(this.knownHosts, proof.host, proof.port)
      if (
        current.algorithm !== proof.descriptor.algorithm ||
        current.publicKey !== proof.descriptor.publicKey ||
        current.fingerprint !== proof.descriptor.fingerprint
      )
        throw new SshLaunchError('host_key_mismatch')
    } catch {
      throw new SshLaunchError('host_key_mismatch')
    }
    await this.lease.socketFor(this.target.proof.remoteTargetId, this.target.generation)
  }

  public async environment(): Promise<{ SSH_AUTH_SOCK: string }> {
    return {
      SSH_AUTH_SOCK: await this.lease.socketFor(
        this.target.proof.remoteTargetId,
        this.target.generation
      )
    }
  }

  public async close(): Promise<void> {
    await this.lease.close()
  }

  public toString(): string {
    return '[SshLaunchPlan stock-ssh; agent socket REDACTED]'
  }
}

export async function resolveSshExecutable(): Promise<string> {
  for (const path of ['/usr/bin/ssh', '/bin/ssh']) {
    try {
      await validateSshExecutable(path)
      return await realpath(path)
    } catch {
      /* try next fixed path */
    }
  }
  throw new SshLaunchError('unsafe_ssh_executable')
}
