export interface BeforeQuitEvent {
  preventDefault(): void
}

export interface ApplicationQuitOrchestratorOptions {
  cleanup(): Promise<void>
  logFailure(message: string): void
  quit(): void
}

type QuitState = 'idle' | 'requesting' | 'cleaning' | 'clean' | 'failed' | 'finalizing'

const CLEANUP_FAILURE_MESSAGE = '[shutdown] application cleanup failed'

export class ApplicationQuitOrchestrator {
  private cleanupOperation: Promise<void> | undefined
  private finalQuitRequested = false
  private state: QuitState = 'idle'

  public constructor(private readonly options: ApplicationQuitOrchestratorOptions) {}

  public isQuitStarted(): boolean {
    return (
      this.state === 'requesting' ||
      this.state === 'cleaning' ||
      this.state === 'clean' ||
      this.state === 'finalizing'
    )
  }

  public windowClose(event: BeforeQuitEvent): void {
    if (this.state === 'clean' || this.state === 'finalizing') return

    event.preventDefault()
    if (this.state === 'requesting' || this.state === 'cleaning') return

    this.state = 'requesting'
    this.options.quit()
  }

  public prepare(): Promise<void> {
    if (this.state === 'clean' || this.state === 'finalizing') return Promise.resolve()
    if (this.cleanupOperation) return this.cleanupOperation

    this.state = 'cleaning'
    const operation = Promise.resolve()
      .then(() => this.options.cleanup())
      .then(
        () => {
          this.state = 'clean'
        },
        () => {
          this.state = 'failed'
          this.cleanupOperation = undefined
          this.options.logFailure(CLEANUP_FAILURE_MESSAGE)
          throw new Error('Application cleanup failed')
        }
      )
    this.cleanupOperation = operation
    return operation
  }

  public beforeQuit(event: BeforeQuitEvent): void {
    if (this.state === 'finalizing') return
    if (this.state === 'clean') {
      this.state = 'finalizing'
      return
    }

    event.preventDefault()
    void this.prepare()
      .then(() => {
        if (this.finalQuitRequested || this.state !== 'clean') return
        this.finalQuitRequested = true
        this.state = 'finalizing'
        this.options.quit()
      })
      .catch(() => undefined)
  }
}
