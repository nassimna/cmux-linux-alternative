import type { TerminalService } from '../terminal/terminal-service'
import { TerminalServiceError } from '../terminal/terminal-service'
import { serviceLogger } from '../logging/service-logger'
import type { SshLaunchPlan } from './ssh-launch-plan'

export class RemoteInteractiveError extends Error {
  public constructor(
    public readonly code: 'invalid_attempt' | 'stale_attempt' | 'transport_unavailable'
  ) {
    super(code.replaceAll('_', ' '))
    this.name = 'RemoteInteractiveError'
  }
}

interface Attempt {
  generation: number
  plan: SshLaunchPlan
  revokePromise?: Promise<void>
  terminalId?: string
  unsubscribe?: () => void
}

export interface InteractiveLaunch {
  remoteSessionId: string
  generation: number
  plan: SshLaunchPlan
  rows?: number
  cols?: number
  /** Read the durable catalog immediately before and after the PTY spawn. */
  isCurrent: () => boolean | Promise<boolean>
  /** Local SSH exit alone must not be reported as proof of remote tmux loss. */
  onExit?: (event: {
    remoteSessionId: string
    generation: number
    terminalId: string
    exitCode: number
  }) => void | Promise<void>
}

/** Owns one local SSH transport and its signing lease per remote session. */
export class RemoteInteractiveRuntime {
  private readonly attempts = new Map<string, Attempt>()
  private readonly pendingCleanup = new Set<Promise<void>>()
  private disposed = false

  public constructor(private readonly terminals: TerminalService) {}

  public uses(terminals: TerminalService): boolean {
    return this.terminals === terminals
  }

  public async launch(input: InteractiveLaunch): Promise<{ terminalId: string }> {
    if (
      this.disposed ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.remoteSessionId
      ) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1
    ) {
      await input.plan.close()
      throw new RemoteInteractiveError('invalid_attempt')
    }
    try {
      if (!(await input.isCurrent())) {
        await input.plan.close()
        throw new RemoteInteractiveError('stale_attempt')
      }
    } catch (error) {
      if (error instanceof RemoteInteractiveError) throw error
      await input.plan.close()
      throw new RemoteInteractiveError('transport_unavailable')
    }
    const previous = this.attempts.get(input.remoteSessionId)
    if (previous && previous.generation >= input.generation) {
      await input.plan.close()
      throw new RemoteInteractiveError('stale_attempt')
    }
    const attempt: Attempt = { generation: input.generation, plan: input.plan }
    this.attempts.set(input.remoteSessionId, attempt)
    try {
      if (previous) await this.stop(previous)
      if (!this.owns(input.remoteSessionId, attempt) || !(await input.isCurrent())) {
        throw new RemoteInteractiveError('stale_attempt')
      }
      const result = await this.terminals.createRemote(
        input.plan,
        input.rows ?? 24,
        input.cols ?? 80
      )
      attempt.terminalId = result.terminal.id
      if (!this.owns(input.remoteSessionId, attempt) || !(await input.isCurrent())) {
        throw new RemoteInteractiveError('stale_attempt')
      }
      attempt.unsubscribe = this.terminals.subscribe(result.terminal.id, (event) => {
        if (event.event !== 'terminal.exited') return
        const cleanup = this.exited(input, attempt, event.data.exitCode)
        this.pendingCleanup.add(cleanup)
        void cleanup
          .catch(() => {
            serviceLogger.emit('error', 'remoteCleanupFailed')
          })
          .finally(() => {
            this.pendingCleanup.delete(cleanup)
          })
      })
      // The PTY may exit between registration and subscription.
      if (this.terminals.attach(result.terminal.id).terminal.exited) {
        throw new RemoteInteractiveError('transport_unavailable')
      }
      return { terminalId: result.terminal.id }
    } catch (error) {
      if (this.owns(input.remoteSessionId, attempt)) this.attempts.delete(input.remoteSessionId)
      await this.stop(attempt)
      if (error instanceof RemoteInteractiveError) throw error
      throw new RemoteInteractiveError('transport_unavailable')
    }
  }

  public isLive(remoteSessionId: string, generation: number): boolean {
    const attempt = this.attempts.get(remoteSessionId)
    if (!attempt || attempt.generation !== generation || !attempt.terminalId) return false
    try {
      return !this.terminals.attach(attempt.terminalId).terminal.exited
    } catch {
      return false
    }
  }

  /** Generic terminal close must be rejected for these IDs; call terminate instead. */
  public ownsTerminal(terminalId: string): boolean {
    for (const attempt of this.attempts.values()) {
      if (attempt.terminalId === terminalId) return true
    }
    return false
  }

  public terminalFor(remoteSessionId: string): string | undefined {
    return this.attempts.get(remoteSessionId)?.terminalId
  }

  /** Revokes signing before terminating the local SSH PTY; tmux stays remote. */
  public async terminate(remoteSessionId: string, generation?: number): Promise<void> {
    const attempt = this.attempts.get(remoteSessionId)
    if (!attempt || (generation !== undefined && attempt.generation !== generation)) return
    this.attempts.delete(remoteSessionId)
    await this.stop(attempt)
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    const entries = [...this.attempts.values()]
    this.attempts.clear()
    const outcomes = await Promise.allSettled([
      ...entries.map((attempt) => this.stop(attempt)),
      ...this.pendingCleanup
    ])
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new RemoteInteractiveError('transport_unavailable')
    }
  }

  private owns(remoteSessionId: string, attempt: Attempt): boolean {
    return !this.disposed && this.attempts.get(remoteSessionId) === attempt
  }

  private async exited(
    input: InteractiveLaunch,
    attempt: Attempt,
    exitCode: number
  ): Promise<void> {
    if (!this.owns(input.remoteSessionId, attempt) || !attempt.terminalId) return
    this.attempts.delete(input.remoteSessionId)
    attempt.unsubscribe?.()
    try {
      await this.revoke(attempt)
    } finally {
      await input.onExit?.({
        remoteSessionId: input.remoteSessionId,
        generation: input.generation,
        terminalId: attempt.terminalId,
        exitCode
      })
    }
  }

  private async stop(attempt: Attempt): Promise<void> {
    attempt.unsubscribe?.()
    let revokeError: unknown
    try {
      await this.revoke(attempt)
    } catch (error) {
      revokeError = error
    }
    if (attempt.terminalId) {
      try {
        this.terminals.close(attempt.terminalId)
      } catch (error) {
        if (!(error instanceof TerminalServiceError && error.code === 'terminal_not_found'))
          throw error
      }
    }
    if (revokeError !== undefined) {
      throw revokeError instanceof Error
        ? revokeError
        : new RemoteInteractiveError('transport_unavailable')
    }
  }

  private revoke(attempt: Attempt): Promise<void> {
    attempt.revokePromise ??= attempt.plan.close()
    return attempt.revokePromise
  }
}
