import { spawn } from 'node:child_process'

import {
  remoteTmuxDiscoverParamsSchema,
  remoteTmuxDiscoveryResultSchema,
  type RemoteTmuxDiscoverParams
} from '@agent-workspace/contracts'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { RemoteCatalogError } from '../persistence/remote-catalog'
import { CredentialError, CredentialReference, type CredentialProvider } from './credential-provider'
import { HostKeyAuthorityError, type HostKeyAuthority } from './host-key-authority'
import { SshLaunchError, SshLaunchPlan, resolveSshExecutable, verifyRemoteTarget } from './ssh-launch-plan'
import {
  sharedRemoteTargetOperationLock,
  type RemoteTargetOperationLock
} from './remote-target-operation-lock'
import {
  MAX_TMUX_DISCOVERY_BYTES,
  isNoTmuxServerResponse,
  parseTmuxSessions,
  parseTmuxVersion,
  TmuxProtocolError,
  type TmuxOperation
} from './tmux-protocol'

const DISCOVERY_TIMEOUT_MS = 15_000

export class RemoteTransportError extends Error {
  public constructor(public readonly code: string) {
    super(code.replaceAll('_', ' '))
    this.name = 'RemoteTransportError'
  }
}

/** Executes only fixed stock-SSH tmux probes on an explicitly enabled isolated state copy. */
export class RemoteTmuxDiscoveryService {
  public constructor(
    private readonly state: ApplicationStateStore,
    private readonly hostKeys: HostKeyAuthority,
    private readonly credentials: CredentialProvider,
    private readonly targetLock: RemoteTargetOperationLock = sharedRemoteTargetOperationLock
  ) {}

  public async discover(input: RemoteTmuxDiscoverParams) {
    const request = remoteTmuxDiscoverParamsSchema.parse(input)
    let targetId: string
    try {
      targetId = this.state.getRemoteSession(request.remoteSessionId).session.remoteTargetId
    } catch (error) {
      if (!(error instanceof RemoteCatalogError && error.code === 'session_not_found')) throw error
      // Completed idempotent discovery can outlive a deleted session row.
      return this.discoverLocked(request)
    }
    return this.targetLock.withTarget(targetId, () => this.discoverLocked(request, targetId))
  }

  private async discoverLocked(request: RemoteTmuxDiscoverParams, targetId?: string) {
    const prior = await this.state.exclusive(() =>
      this.state.reserveHostKeyOperation('discover', request.remoteSessionId, request.mutation)
    )
    if (prior.replay) {
      const value = prior.value as { remoteError?: { code: string; message: string } }
      if (value.remoteError) throw new RemoteTransportError(value.remoteError.code)
      return remoteTmuxDiscoveryResultSchema.parse(value)
    }
    try {
      const session = this.state.getRemoteSession(request.remoteSessionId).session
      if (targetId && session.remoteTargetId !== targetId) {
        throw new RemoteCatalogError('stale_revision', 'Remote session target changed')
      }
      if (session.state === 'trustRequired' || session.state === 'closed') {
        throw new RemoteCatalogError('invalid_state', 'Remote session cannot discover tmux')
      }
      const target = this.state.getRemoteTarget(session.remoteTargetId).target
      const proof = await this.hostKeys.verifyForLaunch(target)
      const verified = verifyRemoteTarget({
        proof,
        generation: session.attemptGeneration,
        user: target.user,
        knownHostsVersion: target.knownHostsVersion
      })
      const executable = await resolveSshExecutable()
      const run = async (operation: TmuxOperation) => {
        const lease = await this.credentials.acquire(
          CredentialReference.forTarget(target.remoteTargetId),
          target.remoteTargetId,
          session.attemptGeneration,
          proof.descriptor.publicKey
        )
        try {
          const plan = await SshLaunchPlan.create({
            sshExecutable: executable,
            lease,
            target: verified,
            operation
          })
          const currentSession = this.state.getRemoteSession(session.remoteSessionId).session
          const currentTarget = this.state.getRemoteTarget(target.remoteTargetId).target
          if (currentSession.revision !== session.revision ||
              currentSession.attemptGeneration !== session.attemptGeneration ||
              currentTarget.revision !== target.revision ||
              currentTarget.knownHostsVersion !== target.knownHostsVersion) {
            throw new RemoteCatalogError('stale_revision', 'Remote authority changed during discovery')
          }
          await plan.revalidate()
          return await execute(plan, operation.kind === 'discoverSessions')
        } finally {
          await lease.close()
        }
      }
      parseTmuxVersion(await run({ kind: 'discoverVersion' }))
      const sessions = parseTmuxSessions(await run({ kind: 'discoverSessions' }))
      const result = remoteTmuxDiscoveryResultSchema.parse({ sessions })
      await this.state.exclusive(() =>
        this.state.completeHostKeyOperation('discover', request.mutation, result)
      )
      return result
    } catch (error) {
      const code = safeErrorCode(error)
      await this.state.exclusive(() =>
        this.state.completeHostKeyOperation('discover', request.mutation, {
          remoteError: { code, message: code.replaceAll('_', ' ') }
        })
      )
      throw new RemoteTransportError(code)
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof RemoteCatalogError || error instanceof CredentialError ||
      error instanceof HostKeyAuthorityError || error instanceof SshLaunchError ||
      error instanceof TmuxProtocolError || error instanceof RemoteTransportError) {
    return error.code
  }
  return 'transport_unavailable'
}

async function execute(plan: SshLaunchPlan, allowEmptySessions: boolean): Promise<Buffer> {
  const env = await plan.environment()
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.argv], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let stderrBytes = 0
    let failure: RemoteTransportError | undefined
    const fail = (error: RemoteTransportError) => {
      if (failure) return
      failure = error
      child.kill('SIGKILL')
    }
    const timeout = setTimeout(() => fail(new RemoteTransportError('transport_unavailable')), DISCOVERY_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_TMUX_DISCOVERY_BYTES) fail(new RemoteTransportError('invalid_tmux_response'))
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes <= 512) stderr += chunk.toString('utf8')
    })
    child.on('error', () => fail(new RemoteTransportError('transport_unavailable')))
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (failure) reject(failure)
      else if (
        allowEmptySessions && code === 1 && size === 0 && stderrBytes <= 512 &&
        isNoTmuxServerResponse(stderr)
      ) resolve(Buffer.alloc(0))
      else if (code !== 0) reject(new RemoteTransportError('invalid_tmux_response'))
      else resolve(Buffer.concat(chunks))
    })
  })
}
