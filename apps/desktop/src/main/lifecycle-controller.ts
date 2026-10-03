import type { ControlClient } from './control-client'
import {
  ServiceRecoveryRequiredError,
  type ServiceSupervisor,
  type UnexpectedServiceExit
} from './service-supervisor'
import { parseDesktopLifecycleState, type DesktopLifecycleState } from '@agent-workspace/contracts/desktop/desktop-bridge'
import { desktopMessages } from '@agent-workspace/contracts/desktop/desktop-messages'

const lifecycleMessages = desktopMessages.lifecycleController

export interface LifecycleSupervisor {
  start(): Promise<ControlClient>
  restart(): Promise<ControlClient>
  stop(): Promise<void>
  onUnexpectedExit(listener: (event: UnexpectedServiceExit) => void): () => void
}

export interface LifecycleControllerOptions {
  bind(client: ControlClient): void | Promise<void>
  unbind(): void | Promise<void>
  delaysMs?: readonly number[]
  delay?(milliseconds: number): Promise<void>
}

export class LifecycleController {
  private state: DesktopLifecycleState = { status: 'starting' }
  private client: ControlClient | undefined
  private bindingActive = false
  private disposed = false
  private shutdownFailurePending = false
  private generation = 0
  private exitedGeneration: number | undefined
  private automaticRecoveryGeneration: number | undefined
  private operation: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(state: DesktopLifecycleState) => void>()
  private readonly removeUnexpectedExitListener: () => void
  private readonly delaysMs: readonly number[]
  private readonly delay: (milliseconds: number) => Promise<void>

  public constructor(
    private readonly supervisor: LifecycleSupervisor,
    private readonly options: LifecycleControllerOptions
  ) {
    this.delaysMs = options.delaysMs ?? [100, 300, 900]
    this.delay = options.delay
      ? (milliseconds) => options.delay?.(milliseconds) ?? Promise.resolve()
      : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
    this.removeUnexpectedExitListener = supervisor.onUnexpectedExit(() =>
      this.handleUnexpectedExit()
    )
  }

  public getState(): DesktopLifecycleState {
    return structuredClone(this.state)
  }

  public getClient(): ControlClient | undefined {
    return this.client
  }

  public onStateChanged(listener: (state: DesktopLifecycleState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public initialize(): Promise<void> {
    const generation = ++this.generation
    this.operation = this.operation.then(() => this.startInitial(generation))
    return this.operation
  }

  public restart(): Promise<void> {
    const generation = ++this.generation
    this.operation = this.operation
      .catch(() => undefined)
      .then(() => this.restartManually(generation))
    return this.operation
  }

  public reconcileShutdownFailure(): Promise<void> {
    ++this.generation
    this.shutdownFailurePending = true
    this.client = undefined
    this.setState({ status: 'failed', message: lifecycleMessages.unsafeShutdown })
    const deactivation = this.deactivateBinding()
    this.operation = this.operation.catch(() => undefined).then(() => deactivation)
    return this.operation
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    this.shutdownFailurePending = false
    ++this.generation
    this.removeUnexpectedExitListener()
    await this.operation.catch(() => undefined)
    await this.deactivateBinding()
  }

  private async startInitial(generation: number): Promise<void> {
    try {
      const client = await this.supervisor.start()
      if (generation !== this.generation) return
      await this.activateBinding(client, generation)
    } catch (error) {
      if (generation !== this.generation) return
      this.handleTerminalFailure(error)
    }
  }

  private handleUnexpectedExit(): void {
    if (
      this.disposed ||
      (!this.client && !this.shutdownFailurePending) ||
      this.exitedGeneration === this.generation
    ) {
      return
    }

    const exitedGeneration = this.generation
    this.exitedGeneration = exitedGeneration
    this.shutdownFailurePending = false
    this.client = undefined
    const recoveryAttemptCanConsumeExit =
      this.automaticRecoveryGeneration === exitedGeneration && !this.bindingActive
    const unbind = this.deactivateBinding()

    if (recoveryAttemptCanConsumeExit) return

    const generation = ++this.generation
    this.automaticRecoveryGeneration = generation
    this.operation = this.operation
      .catch(() => undefined)
      .then(async () => {
        await unbind
        try {
          await this.recoverAutomatically(generation)
        } finally {
          if (this.automaticRecoveryGeneration === generation) {
            this.automaticRecoveryGeneration = undefined
          }
        }
      })
  }

  private async recoverAutomatically(generation: number): Promise<void> {
    for (let index = 0; index < this.delaysMs.length; index += 1) {
      if (generation !== this.generation) return
      this.setState({
        status: 'recovering',
        attempt: index + 1,
        maxAttempts: this.delaysMs.length,
        message: lifecycleMessages.recovering
      })
      await this.delay(this.delaysMs[index] ?? 0)
      if (generation !== this.generation) return
      try {
        this.exitedGeneration = undefined
        const client = await this.supervisor.restart()
        if (generation !== this.generation) return
        const activation = await this.activateBinding(client, generation)
        if (activation === 'ready') return
        if (activation === 'stale') return
      } catch (error) {
        if (generation !== this.generation) return
        if (error instanceof ServiceRecoveryRequiredError) {
          this.handleTerminalFailure(error)
          return
        }
      }
    }
    if (generation === this.generation) {
      this.setState({ status: 'failed', message: lifecycleMessages.restartFailed })
    }
  }

  private async restartManually(generation: number): Promise<void> {
    await this.deactivateBinding()
    if (generation !== this.generation) return
    this.client = undefined
    this.setState({
      status: 'recovering',
      attempt: 1,
      maxAttempts: this.delaysMs.length,
      message: lifecycleMessages.recovering
    })
    try {
      const client = await this.supervisor.restart()
      if (generation !== this.generation) return
      await this.activateBinding(client, generation)
    } catch (error) {
      if (generation !== this.generation) return
      this.handleTerminalFailure(error)
    }
  }

  private async activateBinding(
    client: ControlClient,
    generation: number
  ): Promise<'ready' | 'exited' | 'stale'> {
    this.client = client
    await this.options.bind(client)
    if (generation !== this.generation || this.exitedGeneration === generation) {
      await this.options.unbind()
      if (this.client === client) this.client = undefined
      return generation === this.generation ? 'exited' : 'stale'
    }
    this.bindingActive = true
    this.shutdownFailurePending = false
    this.setState({ status: 'ready' })
    return 'ready'
  }

  private async deactivateBinding(): Promise<void> {
    if (!this.bindingActive) return
    this.bindingActive = false
    await this.options.unbind()
  }

  private handleTerminalFailure(error: unknown): void {
    this.client = undefined
    if (error instanceof ServiceRecoveryRequiredError) {
      const safeRecord = {
        event: error.record.event,
        application: error.record.application,
        version: error.record.version,
        protocolVersion: error.record.protocolVersion,
        category: error.record.category,
        message: lifecycleMessages.recoveryRequired,
        migrationBackupAvailable: error.record.migrationBackupAvailable
      }
      this.setState({
        status: 'recoveryRequired',
        recovery: safeRecord
      })
      return
    }
    this.setState({ status: 'failed', message: lifecycleMessages.restartFailed })
  }

  private setState(next: DesktopLifecycleState): void {
    this.state = parseDesktopLifecycleState(next)
    for (const listener of this.listeners) listener(structuredClone(this.state))
  }
}

export type DesktopServiceSupervisor = Pick<
  ServiceSupervisor,
  'start' | 'restart' | 'stop' | 'onUnexpectedExit'
>
