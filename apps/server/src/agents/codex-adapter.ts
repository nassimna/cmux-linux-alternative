import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  chmodSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'

import {
  AUDITED_CODEX_VERSIONS,
  supportsAuditedCodexFork,
  type AuditedCodexVersion
} from './codex-versions'

const execFileAsync = promisify(execFile)
export type { AuditedCodexVersion } from './codex-versions'
const TIMEOUT_MS = 5_000
const MAX_LINES = 256
const MAX_LINE_BYTES = 64 * 1024
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const MAX_MESSAGES = 10_000
const MAX_MESSAGE_BYTES = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type RpcMethod = 'thread/read' | 'thread/fork' | 'thread/archive'
type RpcValue = Record<string, unknown>
export type CodexAdapterErrorCode =
  | 'unavailable'
  | 'insecure_executable'
  | 'unsupported_platform'
  | 'unsupported_version'
  | 'protocol'
  | 'interrupted'
  | 'resource_limit'
  | 'declined'
  | 'identity_mismatch'
export class CodexAdapterError extends Error {
  constructor(
    public readonly code: CodexAdapterErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CodexAdapterError'
  }
}
export interface CodexLaunchPlan {
  readonly command: readonly [string, 'resume', string, '--no-alt-screen']
  readonly executableIdentity: Readonly<{
    device: number
    inode: number
    uid: number
    mode: number
    size: number
    sha256: string
  }>
}
export interface CodexTranscript {
  readonly messages: ReadonlyArray<Readonly<{ role: 'user' | 'assistant'; text: string }>>
  readonly skippedItems: number
}

type Identity = CodexLaunchPlan['executableIdentity']
function fail(code: CodexAdapterErrorCode, message: string): never {
  throw new CodexAdapterError(code, message)
}
function threadId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    fail('protocol', 'Invalid Codex thread identity')
  return value.toLowerCase()
}
function resolveExecutable(path: string): string {
  const candidates = path.includes('/')
    ? [path]
    : (process.env.PATH ?? '').split(delimiter).map((root) => join(root, path))
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(resolve(candidate))
      const stat = statSync(canonical)
      if (!stat.isFile() || (stat.mode & 0o022) !== 0)
        fail('insecure_executable', 'Codex executable is writable by group or other')
      return canonical
    } catch (error) {
      if (error instanceof CodexAdapterError) throw error
    }
  }
  fail('unavailable', 'Codex executable is unavailable')
}
function nativeExecutable(path: string): string {
  // The npm CLI entrypoint delegates to a platform package. Copying that JS file breaks its
  // relative vendor lookup, so resolve its native executable without running the launcher.
  if (
    basename(path) !== 'codex.js' ||
    basename(dirname(path)) !== 'bin' ||
    basename(dirname(dirname(path))) !== 'codex' ||
    basename(dirname(dirname(dirname(path)))) !== '@openai'
  )
    return path
  const target =
    process.arch === 'x64'
      ? { packageName: 'codex-linux-x64', triple: 'x86_64-unknown-linux-musl' }
      : process.arch === 'arm64'
        ? { packageName: 'codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' }
        : fail('unsupported_platform', 'Codex native package is unavailable for this architecture')
  const root = dirname(dirname(path))
  const candidates = [
    join(
      root,
      'node_modules',
      '@openai',
      target.packageName,
      'vendor',
      target.triple,
      'bin',
      'codex'
    ),
    join(root, 'vendor', target.triple, 'bin', 'codex')
  ]
  for (const candidate of candidates) {
    try {
      return resolveExecutable(candidate)
    } catch (error) {
      if (error instanceof CodexAdapterError && error.code !== 'unavailable') throw error
    }
  }
  fail('unavailable', 'Codex native executable is unavailable beside the npm launcher')
}
async function probeVersion(path: string): Promise<AuditedCodexVersion> {
  let stdout: string
  try {
    const result = await execFileAsync(path, ['--version'], {
      // Keep executable lookup available without passing the service bearer token
      // or isolated state paths to the child.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_LINE_BYTES,
      encoding: 'utf8'
    })
    stdout = result.stdout
  } catch {
    fail('unavailable', 'Codex native version probe failed')
  }
  const version = AUDITED_CODEX_VERSIONS.find(
    (candidate) => stdout!.trim() === `codex-cli ${candidate}`
  )
  if (!version) fail('unsupported_version', 'Codex CLI version is not audited')
  return version
}
function identity(path: string): Identity {
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o022) !== 0)
    fail('insecure_executable', 'Codex executable is insecure')
  const digest = createHash('sha256')
  const file = openSync(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(16 * 1024)
    for (;;) {
      const count = readSync(file, chunk, 0, chunk.length, null)
      if (count === 0) break
      digest.update(chunk.subarray(0, count))
    }
  } finally {
    closeSync(file)
  }
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    size: stat.size,
    sha256: digest.digest('hex')
  })
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof Identity] === right[key as keyof Identity]
  )
}
function object(value: unknown): value is RpcValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A private, service-owned copy of one audited executable. No HTTP or renderer registration. */
export class CodexAdapter {
  readonly descriptor: Readonly<{
    id: 'codex'
    version: AuditedCodexVersion
    platform: 'linux'
    capabilities: readonly ('resume' | 'fork')[]
  }>
  private closed = false
  private constructor(
    private readonly source: string,
    private readonly privatePath: string,
    private readonly directory: string,
    private readonly sourceIdentity: Identity,
    private readonly copyIdentity: Identity,
    version: AuditedCodexVersion,
    private readonly privateHome?: string
  ) {
    this.descriptor = Object.freeze({
      id: 'codex',
      version,
      platform: 'linux',
      capabilities: Object.freeze(
        supportsAuditedCodexFork(version) ? (['resume', 'fork'] as const) : (['resume'] as const)
      )
    })
  }

  static async fromExecutable(path = 'codex', privateHome?: string): Promise<CodexAdapter> {
    if (process.platform !== 'linux')
      fail('unsupported_platform', 'Audited Codex adapter is Linux only')
    if (privateHome && (!privateHome.startsWith('/') || realpathSync(privateHome) !== privateHome))
      fail('unavailable', 'Private Codex home is not canonical')
    const source = nativeExecutable(resolveExecutable(path))
    // Reject unsupported installations before copying a potentially large native binary.
    const version = await probeVersion(source)
    const before = identity(source)
    const directory = mkdtempSync(join(tmpdir(), 'agent-workspace-codex-'))
    try {
      chmodSync(directory, 0o700)
      const privatePath = join(directory, 'codex')
      copyFileSync(source, privatePath)
      chmodSync(privatePath, 0o500)
      const copyIdentity = identity(privatePath)
      if (!sameIdentity(before, identity(source)) || copyIdentity.sha256 !== before.sha256) {
        fail('insecure_executable', 'Codex executable changed during capture')
      }
      if ((await probeVersion(privatePath)) !== version)
        fail('identity_mismatch', 'Codex executable version changed during capture')
      return new CodexAdapter(
        source,
        privatePath,
        directory,
        before,
        copyIdentity,
        version,
        privateHome
      )
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }

  /** Discovery only; every provider operation still captures and verifies the executable. */
  static async installedVersion(path = 'codex'): Promise<AuditedCodexVersion> {
    if (process.platform !== 'linux')
      fail('unsupported_platform', 'Audited Codex adapter is Linux only')
    return probeVersion(nativeExecutable(resolveExecutable(path)))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    rmSync(this.directory, { recursive: true, force: true })
  }
  private assertExecutable(): void {
    if (this.closed) fail('unavailable', 'Codex adapter is closed')
    try {
      if (
        !sameIdentity(this.sourceIdentity, identity(this.source)) ||
        !sameIdentity(this.copyIdentity, identity(this.privatePath))
      ) {
        fail('insecure_executable', 'Codex executable identity changed')
      }
    } catch (error) {
      if (error instanceof CodexAdapterError) throw error
      fail('insecure_executable', 'Codex executable identity is unavailable')
    }
  }
  private childEnvironment(): NodeJS.ProcessEnv {
    if (!this.privateHome) {
      // Transcript reads use the user's Codex login, but never pass service
      // authority or isolated copy paths to that provider process.
      const env = { ...process.env }
      for (const name of Object.keys(env)) {
        if (name.startsWith('AGENT_WORKSPACE_')) delete env[name]
      }
      return env
    }
    return {
      CODEX_HOME: this.privateHome,
      HOME: this.privateHome,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: 'xterm-256color'
    }
  }
  /** The caller must keep this adapter alive and prove a live PTY binding before using the plan. */
  private planForThread(thread: string): CodexLaunchPlan {
    this.assertExecutable()
    const id = threadId(thread)
    return Object.freeze({
      command: Object.freeze([this.privatePath, 'resume', id, '--no-alt-screen'] as const),
      executableIdentity: this.copyIdentity
    })
  }
  async verifyThread(thread: string, signal?: AbortSignal): Promise<void> {
    const expected = threadId(thread)
    const response = await this.rpc('thread/read', expected, false, signal)
    if (this.responseThread(response) !== expected)
      fail('identity_mismatch', 'Codex returned another thread')
  }
  async prepareResume(thread: string, signal?: AbortSignal): Promise<CodexLaunchPlan> {
    await this.verifyThread(thread, signal)
    return this.planForThread(thread)
  }
  /** Read-only status probe against the captured executable and explicit private home. */
  async privateLoginReady(): Promise<boolean> {
    if (!this.privateHome) return false
    this.assertExecutable()
    try {
      const result = await execFileAsync(this.privatePath, ['login', 'status'], {
        env: this.childEnvironment(),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_LINE_BYTES,
        encoding: 'utf8'
      })
      return [result.stdout, result.stderr].some((output) =>
        output.split(/\r?\n/u).some((line) => /^Logged in\b/u.test(line.trim()))
      )
    } catch {
      return false
    }
  }
  async readTranscript(thread: string, signal?: AbortSignal): Promise<CodexTranscript> {
    if (this.descriptor.version !== '0.142.4')
      fail('unsupported_version', 'Codex transcript projection is not audited for this version')
    const expected = threadId(thread)
    const response = await this.rpc('thread/read', expected, true, signal)
    const result = response.result
    if (!object(result) || !object(result.thread)) fail('protocol', 'Codex transcript is malformed')
    if (threadId(result.thread.id) !== expected)
      fail('identity_mismatch', 'Codex returned another thread')
    if (!Array.isArray(result.thread.turns)) fail('protocol', 'Codex transcript turns are missing')
    return projectTranscript(result.thread.turns, signal)
  }
  async forkThread(
    thread: string,
    signal?: AbortSignal
  ): Promise<{ destinationThreadId: string; launch: CodexLaunchPlan }> {
    if (!supportsAuditedCodexFork(this.descriptor.version))
      fail('unsupported_version', 'Codex fork is not audited for this version')
    const source = threadId(thread)
    const response = await this.rpc('thread/fork', source, false, signal)
    const destination = this.responseThread(response)
    if (destination === source) fail('identity_mismatch', 'Codex fork reused source identity')
    return { destinationThreadId: destination, launch: this.planForThread(destination) }
  }
  async archiveThread(thread: string, signal?: AbortSignal): Promise<void> {
    if (!supportsAuditedCodexFork(this.descriptor.version))
      fail('unsupported_version', 'Codex archive is not audited for this version')
    await this.rpc('thread/archive', threadId(thread), false, signal)
  }
  private responseThread(response: RpcValue): string {
    const result = response.result
    if (!object(result) || !object(result.thread))
      fail('protocol', 'Codex thread result is malformed')
    return threadId(result.thread.id)
  }
  private async rpc(
    method: RpcMethod,
    thread: string,
    includeTurns: boolean,
    signal?: AbortSignal
  ): Promise<RpcValue> {
    this.assertExecutable()
    if (signal?.aborted) fail('interrupted', 'Codex request was cancelled')
    const child = spawn(this.privatePath, ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: this.childEnvironment()
    })
    const limit = includeTurns ? MAX_TRANSCRIPT_BYTES : MAX_LINE_BYTES
    const deadline = Date.now() + TIMEOUT_MS
    const queue: string[] = []
    let bytes = 0
    let lines = 0
    let pending = Buffer.alloc(0)
    let failure: CodexAdapterError | undefined
    let waiter: (() => void) | undefined
    const wake = () => {
      waiter?.()
      waiter = undefined
    }
    const abort = () => {
      failure = new CodexAdapterError('interrupted', 'Codex request was cancelled')
      child.kill()
      wake()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => {
      failure = new CodexAdapterError('unavailable', 'Codex app-server failed')
      wake()
    })
    child.on('exit', () => {
      if (!failure) failure = new CodexAdapterError('interrupted', 'Codex app-server exited')
      wake()
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      bytes += chunk.length
      if (
        bytes > limit + MAX_LINE_BYTES ||
        pending.length + chunk.length > limit + MAX_LINE_BYTES
      ) {
        failure = new CodexAdapterError('resource_limit', 'Codex protocol output is too large')
        child.kill()
        wake()
        return
      }
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        const index = pending.indexOf(10)
        if (index < 0) break
        const line = pending.subarray(0, index)
        pending = pending.subarray(index + 1)
        if (line.length > limit || ++lines > MAX_LINES) {
          failure = new CodexAdapterError('resource_limit', 'Codex protocol line limit reached')
          child.kill()
          break
        }
        queue.push(line.toString('utf8'))
      }
      wake()
    })
    const nextLine = async (): Promise<string> => {
      for (;;) {
        if (failure && queue.length === 0) throw failure
        const line = queue.shift()
        if (line !== undefined) return line
        const remaining = deadline - Date.now()
        if (remaining <= 0) fail('interrupted', 'Codex app-server timed out')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiter = undefined
            resolve()
          }, remaining)
          waiter = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    }
    const receive = async (id: 1 | 2): Promise<RpcValue> => {
      for (;;) {
        const line = await nextLine()
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        if (!object(value) || !Object.hasOwn(value, 'id')) continue
        if (value.id !== id) fail('protocol', 'Codex RPC response ID changed')
        if (object(value.error)) fail('declined', 'Codex declined the request')
        if (!object(value.result)) fail('protocol', 'Codex RPC result is malformed')
        return value
      }
    }
    const write = (value: RpcValue) => {
      if (!child.stdin.write(`${JSON.stringify(value)}\n`))
        fail('interrupted', 'Codex stdin is unavailable')
    }
    try {
      write({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'cmux-linux-alternative', title: 'cmux', version: '0.1.0' } }
      })
      await receive(1)
      write({ method: 'initialized' })
      write({
        id: 2,
        method,
        params:
          method === 'thread/read'
            ? { threadId: thread, includeTurns }
            : method === 'thread/fork'
              ? { threadId: thread, excludeTurns: true }
              : { threadId: thread }
      })
      const result = await receive(2)
      child.stdin.end()
      return result
    } finally {
      signal?.removeEventListener('abort', abort)
      child.kill()
    }
  }
}

function projectTranscript(turns: unknown[], signal?: AbortSignal): CodexTranscript {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
  let skippedItems = 0
  let bytes = 0
  for (const turn of turns) {
    if (!object(turn) || !Array.isArray(turn.items))
      fail('protocol', 'Codex transcript turn is malformed')
    for (const item of turn.items) {
      if (signal?.aborted) fail('interrupted', 'Codex transcript was cancelled')
      if (messages.length >= MAX_MESSAGES) {
        skippedItems++
        continue
      }
      if (!object(item) || typeof item.type !== 'string' || item.id == null) {
        skippedItems++
        continue
      }
      let projected: { role: 'user' | 'assistant'; text: string } | undefined
      if (
        item.type === 'userMessage' &&
        !Object.keys(item).some((key) => !['type', 'id', 'clientId', 'content'].includes(key)) &&
        Array.isArray(item.content)
      ) {
        const chunks: string[] = []
        for (const part of item.content) {
          if (
            !object(part) ||
            part.type !== 'text' ||
            typeof part.text !== 'string' ||
            Buffer.byteLength(part.text) > MAX_MESSAGE_BYTES ||
            part.text_elements == null ||
            Object.keys(part).some((key) => !['type', 'text', 'text_elements'].includes(key))
          ) {
            chunks.length = 0
            break
          }
          chunks.push(part.text)
        }
        if (chunks.length) projected = { role: 'user', text: chunks.join('\n') }
      } else if (
        item.type === 'agentMessage' &&
        !Object.keys(item).some(
          (key) => !['type', 'id', 'text', 'phase', 'memoryCitation', 'clientId'].includes(key)
        ) &&
        item.clientId == null &&
        typeof item.text === 'string' &&
        Buffer.byteLength(item.text) <= MAX_MESSAGE_BYTES
      ) {
        projected = { role: 'assistant', text: item.text }
      }
      if (!projected) {
        skippedItems++
        continue
      }
      bytes += Buffer.byteLength(projected.text)
      if (bytes > MAX_TRANSCRIPT_BYTES)
        fail('resource_limit', 'Codex transcript exceeds text budget')
      messages.push(projected)
    }
  }
  return { messages, skippedItems }
}
