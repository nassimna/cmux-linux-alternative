import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Readable } from 'node:stream'

const DEFAULT_UTILITY_TIMEOUT_MS = 10_000
const UTILITY_OUTPUT_MAX_BYTES = 16 * 1024
const UTILITY_KILL_GRACE_MS = 500

type UtilityChild = ChildProcessByStdio<null, Readable, Readable>

export interface RuntimeSchema<T> {
  parse(value: unknown): T
}

export type ServiceUtilitySpawn = (
  executable: string,
  arguments_: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    shell: false
    stdio: ['ignore', 'pipe', 'pipe'] | ['ignore', 'pipe', 'pipe', number]
    windowsHide: true
  }
) => UtilityChild

export interface ServiceUtilityRunnerOptions {
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  spawnProcess?: ServiceUtilitySpawn
  timeoutMs?: number
}

export class ServiceUtilityRunner {
  private readonly environment: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly spawnProcess: ServiceUtilitySpawn
  private readonly timeoutMs: number

  public constructor(
    private readonly executable: string,
    options: ServiceUtilityRunnerOptions = {}
  ) {
    this.environment = options.environment ?? process.env
    this.platform = options.platform ?? process.platform
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, arguments_, spawnOptions) =>
        spawn(executable, arguments_, spawnOptions) as unknown as UtilityChild)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_UTILITY_TIMEOUT_MS
  }

  public run<T>(arguments_: readonly string[], schema: RuntimeSchema<T>): Promise<T> {
    return this.runInternal(arguments_, schema)
  }

  public async runCredential<T>(
    stateDatabasePath: string,
    enrollmentId: string,
    targetId: string,
    expectedRevision: number,
    credentialFd: number,
    schema: RuntimeSchema<T>
  ): Promise<T> {
    await verifyCredentialUtilityExecutable(this.executable)
    return this.runInternal(
      [
        'credential-enroll',
        '--state-db',
        stateDatabasePath,
        '--enrollment-id',
        enrollmentId,
        '--target-id',
        targetId,
        '--expected-revision',
        String(expectedRevision),
        '--key-fd',
        '3'
      ],
      schema,
      credentialFd
    )
  }

  public async runCredentialRemoval<T>(
    stateDatabasePath: string,
    enrollmentId: string,
    targetId: string,
    schema: RuntimeSchema<T>
  ): Promise<T> {
    await verifyCredentialUtilityExecutable(this.executable)
    return this.runInternal(
      [
        'credential-remove',
        '--state-db',
        stateDatabasePath,
        '--enrollment-id',
        enrollmentId,
        '--target-id',
        targetId
      ],
      schema,
      -1
    )
  }

  public async runCredentialCommit<T>(
    stateDatabasePath: string,
    enrollmentId: string,
    targetId: string,
    expectedRevision: number,
    schema: RuntimeSchema<T>
  ): Promise<T> {
    await verifyCredentialUtilityExecutable(this.executable)
    return this.runInternal(
      [
        'credential-commit',
        '--state-db',
        stateDatabasePath,
        '--enrollment-id',
        enrollmentId,
        '--target-id',
        targetId,
        '--expected-revision',
        String(expectedRevision)
      ],
      schema,
      -1
    )
  }

  private runInternal<T>(
    arguments_: readonly string[],
    schema: RuntimeSchema<T>,
    credentialFd?: number
  ): Promise<T> {
    return new Promise((resolveResult, rejectResult) => {
      let child: UtilityChild
      try {
        child = this.spawnProcess(this.executable, arguments_, {
          env: buildUtilityEnvironment(
            this.executable,
            this.environment,
            this.platform,
            credentialFd !== undefined
          ),
          shell: false,
          stdio:
            credentialFd === undefined || credentialFd < 0
              ? ['ignore', 'pipe', 'pipe']
              : ['ignore', 'pipe', 'pipe', credentialFd],
          windowsHide: true
        })
      } catch {
        rejectResult(new Error('The local service utility could not be started'))
        return
      }
      let stdout = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let terminating = false
      let failureMessage: string | undefined
      const timers: { kill?: NodeJS.Timeout; timeout?: NodeJS.Timeout } = {}

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')

      const finish = (error: Error | undefined, result?: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timers.timeout)
        clearTimeout(timers.kill)
        child.removeAllListeners('error')
        child.removeAllListeners('exit')
        child.stdout.removeAllListeners('data')
        child.stderr.removeAllListeners('data')
        if (error) rejectResult(error)
        else resolveResult(result as T)
      }

      const terminate = (message: string): void => {
        if (terminating || settled) return
        terminating = true
        failureMessage = message
        safeKill(child, 'SIGTERM')
        timers.kill = setTimeout(() => {
          safeKill(child, 'SIGKILL')
          finish(new Error(message))
        }, UTILITY_KILL_GRACE_MS)
      }

      child.stdout.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk)
        if (stdoutBytes > UTILITY_OUTPUT_MAX_BYTES) {
          terminate('The local service utility emitted oversized output')
          return
        }
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > UTILITY_OUTPUT_MAX_BYTES) {
          terminate('The local service utility failed')
        }
      })
      child.once('error', () => {
        finish(new Error('The local service utility could not be started'))
      })
      child.once('exit', (code) => {
        if (failureMessage) {
          finish(new Error(failureMessage))
          return
        }
        if (code !== 0) {
          finish(new Error('The local service utility failed'))
          return
        }
        try {
          finish(undefined, parseUtilityOutput(stdout, schema))
        } catch {
          finish(new Error('The local service utility emitted an invalid result'))
        }
      })

      timers.timeout = setTimeout(
        () => terminate('The local service utility timed out'),
        this.timeoutMs
      )
    })
  }
}

export function parseUtilityOutput<T>(stdout: string, schema: RuntimeSchema<T>): T {
  if (Buffer.byteLength(stdout) > UTILITY_OUTPUT_MAX_BYTES) {
    throw new Error('oversized utility output')
  }
  const newline = stdout.indexOf('\n')
  if (newline < 0 || stdout.slice(newline + 1).trim().length > 0) {
    throw new Error('utility output must contain exactly one line')
  }
  const line = stdout.slice(0, newline).endsWith('\r')
    ? stdout.slice(0, newline - 1)
    : stdout.slice(0, newline)
  if (line.length === 0) throw new Error('utility output is empty')
  return schema.parse(JSON.parse(line) as unknown)
}

export function buildUtilityEnvironment(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  allowSessionBus = false
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  if (!isAbsolute(executable) && environment.PATH) result.PATH = environment.PATH
  if (platform === 'win32') {
    for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'] as const) {
      if (environment[name]) result[name] = environment[name]
    }
  }
  if (allowSessionBus && platform !== 'win32') {
    for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] as const) {
      if (environment[name]) result[name] = environment[name]
    }
  }
  return result
}

async function verifyCredentialUtilityExecutable(executable: string): Promise<void> {
  if (!isAbsolute(executable)) {
    throw new Error('The credential utility executable is not trusted')
  }
  const canonical = await realpath(executable).catch(() => undefined)
  if (canonical !== executable) {
    throw new Error('The credential utility executable is not trusted')
  }
  const metadata = await lstat(executable).catch(() => undefined)
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error('The credential utility executable is not trusted')
  }
}

function safeKill(child: UtilityChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // The bounded fallback timer completes even when the platform refuses the signal.
  }
}
