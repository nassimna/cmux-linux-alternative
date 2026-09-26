import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type {
  TerminalAttachResult,
  TerminalCheckpoint,
  TerminalCreateParams,
  TerminalDescriptor,
  TerminalEventMessage
} from '@agent-workspace/contracts'

import { linuxListeningPorts } from './linux-listening-ports'
import type { SshLaunchPlan } from '../remote/ssh-launch-plan'

export const MAX_OUTPUT_CHUNK_BYTES = 64 * 1024
const STARTUP_JOURNAL_LIMIT_BYTES = 512 * 1024
const POST_CHECKPOINT_JOURNAL_LIMIT_BYTES = 256 * 1024
const CHECKPOINT_REQUEST_THRESHOLD_BYTES = 64 * 1024
const MAX_RETAINED_EXITED_SESSIONS = 64

export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: Buffer) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtyAdapter {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd: string
      rows: number
      cols: number
      env: NodeJS.ProcessEnv
    }
  ): Promise<PtyProcess>
}

export interface TerminalContext {
  workspaceId: string
  paneId: string
  tabId: string
}

export class TerminalServiceError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'TerminalServiceError'
  }
}

interface TerminalSession {
  pty: PtyProcess
  descriptor: TerminalDescriptor
  terminating: boolean
  checkpoint?: TerminalCheckpoint
  journal: TerminalAttachResult['output']
  journalBytes: number
  lastSequence: number
  reconstructionComplete: boolean
  checkpointRequested: boolean
  listeners: Set<(event: TerminalEventMessage) => void>
  disposables: { dispose(): void }[]
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly exitedOrder: string[] = []
  private configuredShell: string | null = null
  private disposed = false

  public constructor(private readonly adapter: PtyAdapter) {}

  public static async validateConfiguredShell(shell: string | null): Promise<void> {
    if (shell === null) return
    if (!isAbsolute(shell)) {
      throw new TerminalServiceError('invalid_configured_shell', 'Configured shell is not usable')
    }
    const metadata = await stat(shell).catch(() => undefined)
    if (!metadata?.isFile() || (metadata.mode & 0o111) === 0) {
      throw new TerminalServiceError('invalid_configured_shell', 'Configured shell is not usable')
    }
  }

  /** The caller validates before committing the configuration. Existing PTYs are unaffected. */
  public setConfiguredShell(shell: string | null): void {
    this.configuredShell = shell
  }

  public async create(
    request: TerminalCreateParams,
    context?: TerminalContext
  ): Promise<{ terminal: TerminalDescriptor }> {
    if (this.disposed) throw new TerminalServiceError('service_stopping', 'Service is stopping')
    const cwd = resolve(request.cwd ?? process.cwd())
    const directory = await stat(cwd).catch(() => undefined)
    if (!directory?.isDirectory()) {
      throw new TerminalServiceError(
        'invalid_working_directory',
        'Working directory does not exist'
      )
    }

    const command =
      request.command ??
      (this.configuredShell ? implicitShellCommand(this.configuredShell) : defaultShellCommand())
    if (!command[0]) {
      throw new TerminalServiceError('invalid_command', 'Terminal command cannot be empty')
    }

    const env = { ...process.env }
    delete env.AGENT_WORKSPACE_SERVER_TOKEN
    delete env.AGENT_WORKSPACE_WORKSPACE_ID
    delete env.AGENT_WORKSPACE_PANE_ID
    delete env.AGENT_WORKSPACE_TAB_ID
    delete env.AGENT_WORKSPACE_STATE_SOURCE
    delete env.AGENT_WORKSPACE_STATE_BACKUP
    delete env.AGENT_WORKSPACE_STATE_WORKING
    delete env.AGENT_WORKSPACE_NODE_SESSION_FILE
    if (context) {
      env.AGENT_WORKSPACE_WORKSPACE_ID = context.workspaceId
      env.AGENT_WORKSPACE_PANE_ID = context.paneId
      env.AGENT_WORKSPACE_TAB_ID = context.tabId
    }
    const pty = await this.adapter.spawn(command[0], command.slice(1), {
      cwd,
      rows: request.rows,
      cols: request.cols,
      env
    })
    return this.register(pty, command, cwd, request.rows, request.cols)
  }

  /** Remote transports receive only the plan's attempt-scoped agent socket. */
  public async createRemote(
    plan: SshLaunchPlan,
    rows: number,
    cols: number
  ): Promise<{ terminal: TerminalDescriptor }> {
    if (this.disposed) throw new TerminalServiceError('service_stopping', 'Service is stopping')
    if (
      !Number.isInteger(rows) ||
      !Number.isInteger(cols) ||
      rows < 1 ||
      cols < 1 ||
      rows > 1000 ||
      cols > 1000
    ) {
      throw new TerminalServiceError('invalid_size', 'Terminal size must be between 1 and 1000')
    }
    await plan.revalidate()
    const env = await plan.environment()
    const pty = await this.adapter.spawn(plan.executable, [...plan.argv], {
      cwd: '/',
      rows,
      cols,
      env
    })
    return this.register(pty, ['remote-transport'], '/', rows, cols)
  }

  private register(
    pty: PtyProcess,
    command: string[],
    cwd: string,
    rows: number,
    cols: number
  ): { terminal: TerminalDescriptor } {
    if (this.disposed) {
      pty.kill()
      throw new TerminalServiceError('service_stopping', 'Service is stopping')
    }
    const id = randomUUID()
    const descriptor: TerminalDescriptor = {
      id,
      processId: pty.pid,
      command,
      cwd,
      rows,
      cols,
      exited: false
    }
    const session: TerminalSession = {
      pty,
      descriptor,
      terminating: false,
      journal: [],
      journalBytes: 0,
      lastSequence: 0,
      reconstructionComplete: true,
      checkpointRequested: false,
      listeners: new Set(),
      disposables: []
    }
    this.sessions.set(id, session)
    session.disposables.push(
      pty.onData((data) => this.appendOutput(id, session, data)),
      pty.onExit((event) => this.exit(id, session, event))
    )
    return { terminal: { ...descriptor } }
  }

  public attach(id: string): TerminalAttachResult {
    const session = this.get(id)
    if (session.terminating)
      throw new TerminalServiceError('termination_pending', 'Terminal is being terminated')
    return {
      terminal: { ...session.descriptor },
      ...(session.checkpoint ? { checkpoint: { ...session.checkpoint } } : {}),
      output: session.journal.map((chunk) => ({ ...chunk })),
      lastSequence: session.lastSequence,
      reconstructionComplete: session.reconstructionComplete
    }
  }

  public async runtimeMetadata(
    id: string
  ): Promise<{ terminalId: string; listeningPorts: number[] }> {
    const descriptor = this.get(id).descriptor
    return {
      terminalId: id,
      listeningPorts:
        !descriptor.exited && descriptor.processId
          ? await linuxListeningPorts(descriptor.processId)
          : []
    }
  }

  public subscribe(id: string, listener: (event: TerminalEventMessage) => void): () => void {
    const session = this.get(id)
    if (session.terminating)
      throw new TerminalServiceError('termination_pending', 'Terminal is being terminated')
    session.listeners.add(listener)
    return () => session.listeners.delete(listener)
  }

  public send(id: string, data: Buffer): void {
    const session = this.live(id)
    if (data.length > MAX_OUTPUT_CHUNK_BYTES) {
      throw new TerminalServiceError('invalid_input', 'Terminal input exceeds 64 KiB')
    }
    session.pty.write(data)
  }

  public resize(id: string, rows: number, cols: number): void {
    const session = this.live(id)
    session.pty.resize(cols, rows)
    session.descriptor.rows = rows
    session.descriptor.cols = cols
    this.emit(session, { event: 'terminal.resized', data: { terminalId: id, rows, cols } })
  }

  public checkpoint(id: string, checkpoint: TerminalCheckpoint): void {
    const session = this.get(id)
    if (session.terminating)
      throw new TerminalServiceError('termination_pending', 'Terminal is being terminated')
    if (checkpoint.sequence > session.lastSequence) {
      throw new TerminalServiceError('checkpoint_ahead', 'Checkpoint is ahead of terminal output')
    }
    if (session.checkpoint && checkpoint.sequence < session.checkpoint.sequence) {
      throw new TerminalServiceError(
        'stale_checkpoint',
        'Checkpoint is older than the accepted one'
      )
    }
    while (session.journal[0] && session.journal[0].sequence <= checkpoint.sequence) {
      const removed = session.journal.shift()!
      session.journalBytes -= removed.byteLength
    }
    session.reconstructionComplete = session.journal[0]
      ? session.journal[0].sequence === checkpoint.sequence + 1
      : checkpoint.sequence === session.lastSequence
    session.checkpoint = { ...checkpoint }
    session.checkpointRequested = false
  }

  public close(id: string): void {
    const session = this.get(id)
    this.remove(id, session)
    if (!session.descriptor.exited) session.pty.kill()
  }

  /** Keep the PTY owned until its exit event proves disposition; retain it for retry on failure. */
  public async terminateObserved(
    id: string,
    timeoutMs = 5_000
  ): Promise<{ exitCode: number; signal: string | null }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
      throw new TerminalServiceError('invalid_timeout', 'Termination timeout is invalid')
    const session = this.get(id)
    if (session.descriptor.exited) {
      const result = { exitCode: session.descriptor.exitCode ?? 0, signal: null }
      this.remove(id, session)
      return result
    }
    session.terminating = true
    session.listeners.clear()
    const result = await new Promise<{ exitCode: number; signal: string | null }>(
      (resolve, reject) => {
        let settled = false
        const finish = (outcome: { exitCode: number; signal: string | null } | Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          session.listeners.delete(onExit)
          if (outcome instanceof Error) reject(outcome)
          else resolve(outcome)
        }
        const onExit = (event: TerminalEventMessage): void => {
          if (event.event === 'terminal.exited') finish(event.data)
        }
        session.listeners.add(onExit)
        const timer = setTimeout(
          () =>
            finish(new TerminalServiceError('termination_unverified', 'PTY exit was not observed')),
          timeoutMs
        )
        try {
          session.pty.kill()
        } catch {
          finish(new TerminalServiceError('termination_failed', 'PTY termination failed'))
        }
      }
    )
    if (this.sessions.get(id) === session) this.remove(id, session)
    return result
  }

  public dispose(): void {
    this.disposed = true
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  private get(id: string): TerminalSession {
    const session = this.sessions.get(id)
    if (!session) throw new TerminalServiceError('terminal_not_found', 'Terminal does not exist')
    return session
  }

  private live(id: string): TerminalSession {
    const session = this.get(id)
    if (session.terminating) {
      throw new TerminalServiceError('termination_pending', 'Terminal is being terminated')
    }
    if (session.descriptor.exited) {
      throw new TerminalServiceError('terminal_exited', 'Terminal has exited')
    }
    return session
  }

  private appendOutput(id: string, session: TerminalSession, bytes: Buffer): void {
    if (this.sessions.get(id) !== session) return
    for (let offset = 0; offset < bytes.length; offset += MAX_OUTPUT_CHUNK_BYTES) {
      const piece = bytes.subarray(offset, offset + MAX_OUTPUT_CHUNK_BYTES)
      const chunk = {
        sequence: ++session.lastSequence,
        data: piece.toString('base64'),
        byteLength: piece.length
      }
      session.journal.push(chunk)
      session.journalBytes += piece.length
      const limit = session.checkpoint
        ? POST_CHECKPOINT_JOURNAL_LIMIT_BYTES
        : STARTUP_JOURNAL_LIMIT_BYTES
      while (session.journalBytes > limit) {
        const removed = session.journal.shift()!
        session.journalBytes -= removed.byteLength
        session.reconstructionComplete = false
      }
      this.emit(session, { event: 'terminal.output', data: { terminalId: id, chunk } })
      if (
        session.checkpoint &&
        session.journalBytes >= CHECKPOINT_REQUEST_THRESHOLD_BYTES &&
        !session.checkpointRequested
      ) {
        session.checkpointRequested = true
        this.emit(session, {
          event: 'terminal.checkpointRequested',
          data: { terminalId: id, sequence: session.lastSequence }
        })
      }
    }
  }

  private exit(
    id: string,
    session: TerminalSession,
    event: { exitCode: number; signal?: number }
  ): void {
    if (this.sessions.get(id) !== session || session.descriptor.exited) return
    const exitCode = Math.max(0, event.exitCode)
    session.descriptor.exited = true
    session.descriptor.exitCode = exitCode
    this.emit(session, {
      event: 'terminal.exited',
      data: { terminalId: id, exitCode, signal: event.signal ? String(event.signal) : null }
    })
    this.exitedOrder.push(id)
    while (this.exitedOrder.length > MAX_RETAINED_EXITED_SESSIONS) {
      const oldest = this.exitedOrder.shift()!
      const retained = this.sessions.get(oldest)
      if (retained?.descriptor.exited) this.remove(oldest, retained)
    }
  }

  private remove(id: string, session: TerminalSession): void {
    this.sessions.delete(id)
    for (const disposable of session.disposables) disposable.dispose()
    session.listeners.clear()
  }

  private emit(session: TerminalSession, event: TerminalEventMessage): void {
    for (const listener of session.listeners) {
      try {
        listener(event)
      } catch {
        session.listeners.delete(listener)
      }
    }
  }
}

function defaultShellCommand(): string[] {
  if (process.platform === 'win32') {
    const shell = process.env.ComSpec ?? 'cmd.exe'
    return [shell]
  }
  const shell = process.env.SHELL
  const executable = shell && isAbsolute(shell) ? shell : '/bin/sh'
  return implicitShellCommand(executable)
}

function implicitShellCommand(executable: string): string[] {
  if (process.platform === 'win32') return [executable]
  const name = executable.split('/').at(-1)?.toLowerCase()
  if (name === 'nu') return [executable, '--login']
  if (name === 'powershell' || name === 'pwsh') return [executable, '-Login']
  return name && ['ash', 'bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'].includes(name)
    ? [executable, '-l']
    : [executable]
}
