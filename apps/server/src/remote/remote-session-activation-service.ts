import { spawn } from 'node:child_process'
import { createHash, randomInt, randomUUID } from 'node:crypto'

import { remoteSessionResultSchema } from '@agent-workspace/contracts'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { RemoteCatalogError, type RemoteOperationMutation } from '../persistence/remote-catalog'
import {
  CredentialError,
  CredentialReference,
  type CredentialProvider
} from './credential-provider'
import { HostKeyAuthorityError, type HostKeyAuthority } from './host-key-authority'
import { HostKeyScanError } from './host-key-scanner'
import { KnownHostsError } from './known-hosts-store'
import { RemoteInteractiveError, type RemoteInteractiveRuntime } from './remote-interactive-runtime'
import {
  SshLaunchError,
  SshLaunchPlan,
  resolveSshExecutable,
  verifyRemoteTarget
} from './ssh-launch-plan'
import { parseTmuxVersion, TmuxProtocolError, type TmuxOperation } from './tmux-protocol'
import {
  sharedRemoteTargetOperationLock,
  type RemoteTargetOperationLock
} from './remote-target-operation-lock'

const VERSION_TIMEOUT_MS = 15_000
const MAX_VERSION_BYTES = 128
const STABLE_CONNECTION_MS = 30_000

export function retryAfterTransportExit(
  automatic: { attempt: number } | undefined,
  connectedAt: number,
  now: number
): number {
  return automatic && now - connectedAt < STABLE_CONNECTION_MS ? automatic.attempt + 1 : 1
}

export class RemoteActivationError extends Error {
  public constructor(public readonly code: string) {
    super(code.replaceAll('_', ' '))
    this.name = 'RemoteActivationError'
  }
}

export interface ActivateRemoteSession {
  remoteSessionId: string
  mutation: RemoteOperationMutation
}

interface ReconnectTimer {
  generation: number
  revision: number
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  timer?: NodeJS.Timeout
}

/** Durable attempt reservation followed by exact host-key, credential and tmux launch gates. */
export class RemoteSessionActivationService {
  private readonly reconnectTimers = new Map<string, ReconnectTimer>()
  private readonly inFlightReconnects = new Set<Promise<void>>()
  private disposed = false
  public constructor(
    private readonly state: ApplicationStateStore,
    private readonly hostKeys: HostKeyAuthority,
    private readonly credentials: CredentialProvider,
    private readonly runtime: RemoteInteractiveRuntime,
    private readonly targetLock: RemoteTargetOperationLock = sharedRemoteTargetOperationLock
  ) {}

  public usesTargetLock(lock: RemoteTargetOperationLock): boolean {
    return this.targetLock === lock
  }

  public async activate(input: ActivateRemoteSession) {
    if (this.disposed) throw new RemoteActivationError('transport_unavailable')
    return this.activateAttempt(input)
  }

  private async activateAttempt(
    input: ActivateRemoteSession,
    automatic?: { attempt: number; max: number }
  ) {
    let targetId: string
    try {
      targetId = this.state.getRemoteSession(input.remoteSessionId).session.remoteTargetId
    } catch (error) {
      // A completed idempotent replay may outlive its session row.
      if (error instanceof RemoteCatalogError && error.code === 'session_not_found')
        return this.activateAttemptLocked(input, automatic)
      throw error
    }
    return this.targetLock.withTarget(targetId, () => this.activateAttemptLocked(input, automatic))
  }

  private async activateAttemptLocked(
    input: ActivateRemoteSession,
    automatic?: { attempt: number; max: number }
  ) {
    if (this.disposed) throw new RemoteActivationError('transport_unavailable')
    const reservation = await this.state.exclusive(() =>
      this.state.beginRemoteSessionActivation(input.remoteSessionId, input.mutation)
    )
    if (!automatic && !reservation.replay) this.cancelReconnect(input.remoteSessionId)
    if (reservation.replay) {
      const prior = reservation.value as { remoteError?: { code: string } }
      if (prior.remoteError) throw new RemoteActivationError(prior.remoteError.code)
      return remoteSessionResultSchema.parse(reservation.value)
    }
    const { session, target } = reservation
    const isCurrent = () => {
      if (this.disposed) return false
      try {
        const current = this.state.getRemoteSession(session.remoteSessionId).session
        const currentTarget = this.state.getRemoteTarget(target.remoteTargetId).target
        return (
          current.state === session.state &&
          current.attemptGeneration === session.attemptGeneration &&
          current.revision === session.revision &&
          currentTarget.hostKeyState === 'trusted' &&
          currentTarget.revision === target.revision &&
          currentTarget.knownHostsVersion === target.knownHostsVersion
        )
      } catch {
        return false
      }
    }
    try {
      const proof = await this.hostKeys.verifyForLaunch(target)
      const verified = verifyRemoteTarget({
        proof,
        generation: session.attemptGeneration,
        user: target.user,
        knownHostsVersion: target.knownHostsVersion
      })
      const executable = await resolveSshExecutable()
      const createPlan = async (operation: TmuxOperation) => {
        const lease = await this.credentials.acquire(
          CredentialReference.forTarget(target.remoteTargetId),
          target.remoteTargetId,
          session.attemptGeneration,
          proof.descriptor.publicKey
        )
        try {
          return await SshLaunchPlan.create({
            sshExecutable: executable,
            lease,
            target: verified,
            operation
          })
        } catch (error) {
          await lease.close()
          throw error
        }
      }
      const versionPlan = await createPlan({ kind: 'discoverVersion' })
      try {
        if (!isCurrent()) throw new RemoteActivationError('stale_revision')
        await versionPlan.revalidate()
        parseTmuxVersion(await runVersionProbe(versionPlan))
      } finally {
        await versionPlan.close()
      }
      if (!session.tmux) throw new RemoteActivationError('invalid_state')
      const operation: TmuxOperation =
        session.tmux.mode === 'attach'
          ? { kind: 'attach', name: session.tmux.sessionName }
          : { kind: 'create', name: session.tmux.sessionName }
      const plan = await createPlan(operation)
      let settled = false
      let exitBeforeCompletion = false
      let connectedAt = 0
      await this.runtime.launch({
        remoteSessionId: session.remoteSessionId,
        generation: session.attemptGeneration,
        plan,
        isCurrent,
        onExit: async ({ remoteSessionId, generation }) => {
          if (!settled) {
            exitBeforeCompletion = true
            return
          }
          await this.recordExitAndSchedule(
            remoteSessionId,
            generation,
            retryAfterTransportExit(automatic, connectedAt, Date.now())
          )
        }
      })
      if (
        exitBeforeCompletion ||
        !this.runtime.isLive(session.remoteSessionId, session.attemptGeneration)
      ) {
        throw new RemoteActivationError('transport_unavailable')
      }
      if (!isCurrent()) throw new RemoteActivationError('stale_revision')
      const completed = await this.state.exclusive(() =>
        this.state.completeRemoteSessionActivation(
          session.remoteSessionId,
          session.attemptGeneration,
          session.revision,
          input.mutation,
          'connected',
          target.remoteTargetId,
          target.revision,
          target.knownHostsVersion
        )
      )
      if (!completed.applied) {
        await this.runtime.terminate(session.remoteSessionId, session.attemptGeneration)
        throw new RemoteActivationError('stale_revision')
      }
      connectedAt = Date.now()
      settled = true
      if (exitBeforeCompletion) {
        await this.recordExitAndSchedule(
          session.remoteSessionId,
          session.attemptGeneration,
          retryAfterTransportExit(automatic, connectedAt, Date.now())
        )
      }
      // A very short-lived SSH process can exit after completion; the exit callback is fenced.
      return remoteSessionResultSchema.parse(completed.value)
    } catch (error) {
      const code = safeCode(error)
      let cleanupFailed = false
      try {
        await this.runtime.terminate(session.remoteSessionId, session.attemptGeneration)
      } catch {
        cleanupFailed = true
      }
      if (code === 'host_key_mismatch') {
        try {
          await this.state.exclusive(() =>
            this.state.markRemoteTargetHostKeyChanged(target.remoteTargetId, target.revision)
          )
        } catch {
          cleanupFailed = true
        }
      }
      const finalCode = cleanupFailed ? 'transport_unavailable' : code
      const retrying =
        automatic &&
        automatic.attempt < automatic.max &&
        finalCode !== 'host_key_mismatch' &&
        finalCode !== 'stale_revision'
      const completed = await this.state.exclusive(() =>
        this.state.completeRemoteSessionActivation(
          session.remoteSessionId,
          session.attemptGeneration,
          session.revision,
          input.mutation,
          retrying ? 'reconnecting' : 'failed',
          target.remoteTargetId,
          target.revision,
          target.knownHostsVersion,
          finalCode
        )
      )
      if (!completed.applied && finalCode !== 'stale_revision')
        throw new RemoteActivationError('stale_revision')
      throw new RemoteActivationError(finalCode)
    }
  }

  public async terminate(remoteSessionId: string, generation?: number): Promise<void> {
    this.cancelReconnect(remoteSessionId)
    await this.runtime.terminate(remoteSessionId, generation)
  }

  public terminalFor(remoteSessionId: string): string | undefined {
    return this.runtime.terminalFor(remoteSessionId)
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    for (const sessionId of this.reconnectTimers.keys()) this.cancelReconnect(sessionId)
    await Promise.allSettled([...this.inFlightReconnects])
  }

  private async recordExitAndSchedule(
    remoteSessionId: string,
    generation: number,
    nextAttempt: number
  ): Promise<void> {
    const snapshot = await this.state.exclusive(() => {
      if (!this.state.recordRemoteLocalTransportExit(remoteSessionId, generation)) return undefined
      return this.state.getRemoteSession(remoteSessionId).session
    })
    if (this.disposed || snapshot?.state !== 'reconnecting') return
    if (nextAttempt > snapshot.reconnect.maxAttempts) {
      await this.state.exclusive(() =>
        this.state.failRemoteReconnectIfCurrent(
          remoteSessionId,
          snapshot.attemptGeneration,
          snapshot.revision
        )
      )
      this.cancelReconnect(remoteSessionId)
      return
    }
    const timer: ReconnectTimer = {
      generation: snapshot.attemptGeneration,
      revision: snapshot.revision,
      maxAttempts: snapshot.reconnect.maxAttempts,
      initialDelayMs: snapshot.reconnect.initialDelayMs,
      maxDelayMs: snapshot.reconnect.maxDelayMs
    }
    this.cancelReconnect(remoteSessionId)
    this.reconnectTimers.set(remoteSessionId, timer)
    this.scheduleReconnect(remoteSessionId, timer, nextAttempt)
  }

  private scheduleReconnect(remoteSessionId: string, timer: ReconnectTimer, attempt: number): void {
    if (
      this.disposed ||
      attempt > timer.maxAttempts ||
      this.reconnectTimers.get(remoteSessionId) !== timer
    )
      return
    const base = Math.min(timer.maxDelayMs, timer.initialDelayMs * 2 ** (attempt - 1))
    const delay = base + Math.floor((base * randomInt(0, 1001)) / 10_000)
    timer.timer = setTimeout(() => {
      const work = this.runReconnect(remoteSessionId, timer, attempt).catch(() => {
        this.cancelReconnect(remoteSessionId)
      })
      this.inFlightReconnects.add(work)
      void work.then(() => this.inFlightReconnects.delete(work))
    }, delay)
    timer.timer.unref()
  }

  private async runReconnect(
    remoteSessionId: string,
    timer: ReconnectTimer,
    attempt: number
  ): Promise<void> {
    if (this.disposed || this.reconnectTimers.get(remoteSessionId) !== timer) return
    const session = this.state.getRemoteSession(remoteSessionId).session
    if (
      session.state !== 'reconnecting' ||
      session.revision !== timer.revision ||
      session.attemptGeneration !== timer.generation
    ) {
      this.cancelReconnect(remoteSessionId)
      return
    }
    const idempotencyKey = randomUUID()
    const requestHash = createHash('sha256')
      .update(
        `remote.session.activate:${remoteSessionId}:${timer.generation}:${attempt}:${idempotencyKey}`
      )
      .digest('hex')
    try {
      await this.activateAttempt(
        {
          remoteSessionId,
          mutation: {
            expectedRevision: timer.revision,
            idempotencyKey,
            requestHash
          }
        },
        { attempt, max: timer.maxAttempts }
      )
      if (this.reconnectTimers.get(remoteSessionId) === timer)
        this.reconnectTimers.delete(remoteSessionId)
    } catch {
      if (this.reconnectTimers.get(remoteSessionId) !== timer) return
      const current = this.state.getRemoteSession(remoteSessionId).session
      if (current.state !== 'reconnecting') {
        this.cancelReconnect(remoteSessionId)
        return
      }
      let trusted = false
      try {
        trusted =
          this.state.getRemoteTarget(current.remoteTargetId).target.hostKeyState === 'trusted'
      } catch {
        /* Deletion or lookup failure must stop retries. */
      }
      if (!trusted || attempt >= timer.maxAttempts) {
        await this.state.exclusive(() =>
          this.state.failRemoteReconnectIfCurrent(
            remoteSessionId,
            current.attemptGeneration,
            current.revision
          )
        )
        this.cancelReconnect(remoteSessionId)
        return
      }
      if (current.attemptGeneration === timer.generation) {
        if (current.revision === timer.revision) {
          await this.state.exclusive(() =>
            this.state.failRemoteReconnectIfCurrent(
              remoteSessionId,
              current.attemptGeneration,
              current.revision
            )
          )
        }
        this.cancelReconnect(remoteSessionId)
        return
      }
      timer.generation = current.attemptGeneration
      timer.revision = current.revision
      this.scheduleReconnect(remoteSessionId, timer, attempt + 1)
    }
  }

  private cancelReconnect(remoteSessionId: string): void {
    const timer = this.reconnectTimers.get(remoteSessionId)
    if (!timer) return
    if (timer.timer) clearTimeout(timer.timer)
    this.reconnectTimers.delete(remoteSessionId)
  }
}

function safeCode(error: unknown): string {
  if (
    error instanceof RemoteCatalogError ||
    error instanceof CredentialError ||
    error instanceof HostKeyAuthorityError ||
    error instanceof SshLaunchError ||
    error instanceof HostKeyScanError ||
    error instanceof KnownHostsError ||
    error instanceof TmuxProtocolError ||
    error instanceof RemoteInteractiveError ||
    error instanceof RemoteActivationError
  )
    return error.code
  return 'transport_unavailable'
}

async function runVersionProbe(plan: SshLaunchPlan): Promise<Buffer> {
  const env = await plan.environment()
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.argv], {
      env,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let failure: RemoteActivationError | undefined
    const fail = (code: string) => {
      if (failure) return
      failure = new RemoteActivationError(code)
      child.kill('SIGKILL')
    }
    const timeout = setTimeout(() => fail('transport_unavailable'), VERSION_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_VERSION_BYTES) fail('invalid_tmux_response')
      else chunks.push(chunk)
    })
    child.on('error', () => fail('transport_unavailable'))
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (failure) reject(failure)
      else if (code !== 0) reject(new RemoteActivationError('invalid_tmux_response'))
      else resolve(Buffer.concat(chunks))
    })
  })
}
