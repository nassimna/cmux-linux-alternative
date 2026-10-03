/** Private stderr events. Never interpolate request bodies, paths, or exception messages. */
const EVENTS = {
  configurationReady: 'Configuration runtime is ready',
  configurationUpdated: 'Configuration was updated',
  requestHandled: 'Authenticated request completed',
  encryptedIndexUnavailable: 'Encrypted content index is unavailable',
  cliDiscoveryFailed: 'CLI discovery failed',
  shutdownFailed: 'Service shutdown failed',
  listenerFailed: 'Service listener failed',
  startupFailed: 'Service startup failed',
  attentionRefreshFailed: 'Attention refresh failed',
  requestFailed: 'Request failed',
  remoteCleanupFailed: 'Remote transport cleanup failed',
  terminalRetireFailed: 'Terminal retirement failed',
  layoutTerminalCleanupFailed: 'Layout terminal cleanup failed',
  paneTerminalCleanupFailed: 'Pane terminal cleanup failed',
  workspaceTerminalCleanupFailed: 'Workspace terminal cleanup failed',
  batchTerminalCleanupFailed: 'Batch terminal cleanup failed',
  tabTerminalCleanupFailed: 'Tab terminal cleanup failed',
  restartTerminalCleanupFailed: 'Restarted terminal cleanup failed'
} as const

export type ServiceLogEvent = keyof typeof EVENTS
export type ServiceLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

const RANK: Record<ServiceLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
}

/** Runtime filter for this Node process; the Electron parent owns the private stderr pipe. */
export class ServiceLogger {
  private level: ServiceLogLevel = 'info'
  private readonly sinks = new Set<(line: string) => void>()

  constructor(
    private readonly write: (line: string) => void = (line) => process.stderr.write(line)
  ) {}

  setLevel(level: ServiceLogLevel): void {
    if (!Object.hasOwn(RANK, level)) throw new Error('Invalid service log level')
    this.level = level
  }

  getLevel(): ServiceLogLevel {
    return this.level
  }

  addSink(sink: (line: string) => void): () => void {
    this.sinks.add(sink)
    return () => this.sinks.delete(sink)
  }

  emit(level: ServiceLogLevel, event: ServiceLogEvent): void {
    if (RANK[level] > RANK[this.level]) return
    const line = `${new Date().toISOString()} [${level}] ${EVENTS[event]}\n`
    this.write(line)
    for (const sink of this.sinks) {
      try {
        sink(line)
      } catch {
        this.sinks.delete(sink)
        this.write(`${new Date().toISOString()} [warn] Diagnostic log sink stopped\n`)
      }
    }
  }
}

export const serviceLogger = new ServiceLogger()
