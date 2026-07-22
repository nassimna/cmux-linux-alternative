import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rmdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import {
  diagnosticBundlePreviewSchema,
  startupRecordSchema,
  type DiagnosticBundlePreview,
  type RecoveryExportResult,
  type ServiceReadyRecord,
  type ServiceRecoveryRequiredRecord
} from '@agent-workspace/protocol-client'

import { ControlClient } from './control-client'
import {
  CLI_SESSION_FILE_ENVIRONMENT_VARIABLE,
  SERVICE_BINARY_NAME,
  SERVICE_PATH_ENVIRONMENT_VARIABLE
} from './identity'
import { ServiceUtilityRunner, type RuntimeSchema } from './service-utility-runner'

const STARTUP_TIMEOUT_MS = 15_000
export const DESKTOP_BOOTSTRAP_PROOF_ENVIRONMENT_VARIABLE =
  'AGENT_WORKSPACE_DESKTOP_BOOTSTRAP_PROOF'
const CONNECT_RETRY_MS = 50
const STARTUP_RECORD_MAX_BYTES = 16 * 1024
const SHUTDOWN_TIMEOUT_MS = 2_500
const CONTAINMENT_CLEANUP_ATTEMPTS = 2
const CONTAINMENT_CLEANUP_RETRY_MS = 25
const CONTAINMENT_CLEANUP_PENDING_MESSAGE =
  '[control-service] process containment cleanup is pending'
const LINUX_CGROUP_ROOT = '/sys/fs/cgroup'
const SERVICE_CONTAINMENT_ENVIRONMENT_VARIABLE = 'AGENT_WORKSPACE_SERVICE_CONTAINMENT'

export const REQUIRED_CAPABILITIES = [
  'system.identify',
  'system.ping',
  'terminal.attach',
  'terminal.runtimeMetadata',
  'terminal.detach',
  'terminal.send',
  'terminal.resize',
  'terminal.checkpoint',
  'terminal.events',
  'terminal.restart',
  'workspace.list',
  'workspace.snapshot',
  'workspace.cardSlots.get',
  'workspace.cardSlots.replace',
  'workspace.cardSlots.events',
  'card-slots-v1',
  'workspace.create',
  'workspace.update',
  'workspace.select',
  'workspace.move',
  'workspace.close',
  'pane.split',
  'pane.focus',
  'pane.resize',
  'pane.close',
  'pane.moveTab',
  'tab.openTerminal',
  'tab.select',
  'tab.update',
  'tab.move',
  'tab.close',
  'settings.get',
  'settings.update',
  'settings.resetKey',
  'notification.list',
  'notification.publish',
  'notification.markRead',
  'notification.markUnread',
  'notification.clear',
  'configuration.get',
  'configuration.update',
  'window.getState',
  'window.updateState'
] as const

export interface ServicePaths {
  isPackaged: boolean
  resourcesPath: string
  workingDirectory: string
}

export interface ServiceSupervisorOptions {
  stateDatabasePath: string
  configurationPath: string
  logDirectoryPath: string
  defaultWorkingDirectory?: string
  cliSessionFilePath?: string
}

export type ServiceProcessSpawn = (
  executable: string,
  arguments_: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: ['pipe', 'pipe', 'pipe']
    windowsHide: true
    detached: boolean
  }
) => ChildProcessWithoutNullStreams

export interface ServiceProcessContainment {
  readonly environment: Readonly<NodeJS.ProcessEnv>
  dispose(): Promise<void>
  isAlive(child: ChildProcessWithoutNullStreams): Promise<boolean>
  terminate(child: ChildProcessWithoutNullStreams): Promise<void>
}

export type ServiceProcessContainmentFactory = (
  platform: NodeJS.Platform
) => Promise<ServiceProcessContainment>

export interface ServiceSupervisorDependencies {
  createProcessContainment?: ServiceProcessContainmentFactory
  createControlClient?: (endpoint: string, token: string) => ControlClient
  platform?: NodeJS.Platform
  shutdownTimeoutMs?: number
  spawnProcess?: ServiceProcessSpawn
  utilityRunner?: Pick<ServiceUtilityRunner, 'run'> &
    Partial<
      Pick<ServiceUtilityRunner, 'runCredential' | 'runCredentialCommit' | 'runCredentialRemoval'>
    >
}

export interface ServiceUtilityPaths {
  configurationPath: string
  logDirectoryPath: string
  stateDatabasePath: string
}

export interface UnexpectedServiceExit {
  reason: 'service-process-ended'
  status: 'exited' | 'signaled' | 'failed'
}

export type ServiceStartupRecord = ServiceReadyRecord | ServiceRecoveryRequiredRecord

export type RecoveryInspectionCategory =
  | 'healthy'
  | 'migrationRequired'
  | 'futureSchema'
  | 'corruptDatabase'
  | 'corruptSchema'
  | 'invalidSnapshot'
  | 'invalidWindowState'
  | 'migrationFailed'
  | 'permissions'

export interface RecoveryInspectionResult {
  classification: RecoveryInspectionCategory
  schemaVersion?: number
  migrationFrom?: number
  migrationTo?: number
}

export interface DiagnosticExportResult {
  path: string
  bytes: number
}

interface ActiveService {
  child: ChildProcessWithoutNullStreams
  client: ControlClient | undefined
  containment: ServiceProcessContainment
  generation: number
  deferredExitStatus: UnexpectedServiceExit['status'] | undefined
  intentionalStop: boolean
  startupComplete: boolean
  desktopBootstrapProof: string
  unexpectedExitReported: boolean
}

export class ServiceRecoveryRequiredError extends Error {
  public readonly record: ServiceRecoveryRequiredRecord

  public constructor(record: ServiceRecoveryRequiredRecord) {
    super('The local control service requires recovery')
    this.name = 'ServiceRecoveryRequiredError'
    this.record = structuredClone(record)
  }
}

export class ServiceSupervisor {
  private active: ActiveService | undefined
  private diagnosticApproval: DiagnosticBundlePreview | undefined
  private generation = 0
  private lifecycleQueue: Promise<void> = Promise.resolve()
  private readonly pendingContainmentCleanup = new Set<ServiceProcessContainment>()
  private readonly unexpectedExitListeners = new Set<(event: UnexpectedServiceExit) => void>()
  private utilityQueue: Promise<void> = Promise.resolve()
  private readonly configurationPath: string
  private readonly defaultWorkingDirectory: string | undefined
  private readonly cliSessionFilePath: string
  private readonly logDirectoryPath: string
  private readonly stateDatabasePath: string
  private readonly utilityRunner: Pick<ServiceUtilityRunner, 'run'> &
    Partial<
      Pick<ServiceUtilityRunner, 'runCredential' | 'runCredentialCommit' | 'runCredentialRemoval'>
    >
  private readonly endpoint: string
  private readonly token: string
  private readonly servicePath: string
  private readonly spawnProcess: ServiceProcessSpawn
  private readonly createControlClient: (endpoint: string, token: string) => ControlClient
  private readonly createProcessContainment: ServiceProcessContainmentFactory
  private readonly platform: NodeJS.Platform
  private readonly shutdownTimeoutMs: number

  public constructor(
    endpoint: string,
    token: string,
    servicePath: string,
    options: ServiceSupervisorOptions,
    dependencies?: ServiceSupervisorDependencies
  )
  public constructor(
    endpoint: string,
    token: string,
    servicePath: string,
    stateDatabasePath: string,
    defaultWorkingDirectory?: string,
    cliSessionFilePath?: string
  )
  public constructor(
    endpoint: string,
    token: string,
    servicePath: string,
    optionsOrStateDatabasePath: ServiceSupervisorOptions | string,
    dependenciesOrLegacyDefaultWorkingDirectory?: ServiceSupervisorDependencies | string,
    legacyCliSessionFilePath?: string
  ) {
    this.endpoint = endpoint
    this.token = token
    this.servicePath = servicePath
    const options =
      typeof optionsOrStateDatabasePath === 'string'
        ? legacySupervisorOptions(
            optionsOrStateDatabasePath,
            dependenciesOrLegacyDefaultWorkingDirectory as string | undefined,
            legacyCliSessionFilePath
          )
        : optionsOrStateDatabasePath
    const dependencies =
      typeof optionsOrStateDatabasePath === 'string'
        ? undefined
        : (dependenciesOrLegacyDefaultWorkingDirectory as ServiceSupervisorDependencies | undefined)
    this.stateDatabasePath = options.stateDatabasePath
    this.configurationPath = options.configurationPath
    this.logDirectoryPath = options.logDirectoryPath
    this.defaultWorkingDirectory = options.defaultWorkingDirectory
    this.cliSessionFilePath =
      options.cliSessionFilePath ??
      resolve(dirname(this.stateDatabasePath), '..', 'runtime', 'cli-session.json')
    this.utilityRunner = dependencies?.utilityRunner ?? new ServiceUtilityRunner(this.servicePath)
    this.platform = dependencies?.platform ?? process.platform
    this.shutdownTimeoutMs =
      Number.isSafeInteger(dependencies?.shutdownTimeoutMs) &&
      (dependencies?.shutdownTimeoutMs ?? 0) > 0
        ? (dependencies?.shutdownTimeoutMs as number)
        : SHUTDOWN_TIMEOUT_MS
    this.createProcessContainment =
      dependencies?.createProcessContainment ?? prepareServiceProcessContainment
    this.spawnProcess =
      dependencies?.spawnProcess ??
      ((executable, arguments_, spawnOptions) => spawn(executable, arguments_, spawnOptions))
    const injectedControlClientFactory = dependencies?.createControlClient
    this.createControlClient = injectedControlClientFactory
      ? (controlEndpoint, controlToken) =>
          injectedControlClientFactory(controlEndpoint, controlToken)
      : (controlEndpoint, controlToken) => new ControlClient(controlEndpoint, controlToken)
  }

  public start(): Promise<ControlClient> {
    return this.enqueueLifecycle(() => this.startUnlocked())
  }

  public stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopUnlocked())
  }

  public getDesktopBootstrapProof(): string | undefined {
    return this.active?.desktopBootstrapProof
  }

  public async connectAdditionalClient(): Promise<ControlClient> {
    if (!this.active?.startupComplete) throw new Error('The local control service is not ready')
    const client = this.createControlClient(this.endpoint, this.token)
    try {
      await client.connect()
      await client.identify()
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  public restart(): Promise<ControlClient> {
    return this.enqueueLifecycle(async () => {
      await this.stopUnlocked()
      return this.startUnlocked()
    })
  }

  public onUnexpectedExit(listener: (event: UnexpectedServiceExit) => void): () => void {
    this.unexpectedExitListeners.add(listener)
    return () => this.unexpectedExitListeners.delete(listener)
  }

  public getUtilityPaths(): Readonly<ServiceUtilityPaths> {
    return Object.freeze({
      configurationPath: this.configurationPath,
      logDirectoryPath: this.logDirectoryPath,
      stateDatabasePath: this.stateDatabasePath
    })
  }

  public inspectRecovery(): Promise<RecoveryInspectionResult> {
    return this.enqueueUtility(() =>
      this.utilityRunner.run(
        ['recovery-inspect', '--state-db', this.stateDatabasePath],
        recoveryInspectionSchema
      )
    )
  }

  public exportRecovery(destination: string): Promise<RecoveryExportResult> {
    return this.enqueueUtility(() =>
      this.utilityRunner.run(
        ['recovery-export', '--state-db', this.stateDatabasePath, '--destination', destination],
        absoluteResultSchema
      )
    )
  }

  public enrollRemoteCredential(
    targetId: string,
    expectedRevision: number,
    credentialFd: number
  ): Promise<string> {
    return this.enqueueUtility(async () => {
      const runCredential = this.utilityRunner.runCredential
      if (!runCredential) throw new Error('Credential enrollment is unavailable')
      const enrollmentId = randomUUID()
      await runCredential.call(
        this.utilityRunner,
        this.stateDatabasePath,
        enrollmentId,
        targetId,
        expectedRevision,
        credentialFd,
        credentialStoredSchema
      )
      return enrollmentId
    })
  }

  public commitRemoteCredential(
    enrollmentId: string,
    targetId: string,
    expectedRevision: number
  ): Promise<void> {
    return this.enqueueUtility(async () => {
      const runCredentialCommit = this.utilityRunner.runCredentialCommit
      if (!runCredentialCommit) throw new Error('Credential enrollment is unavailable')
      await runCredentialCommit.call(
        this.utilityRunner,
        this.stateDatabasePath,
        enrollmentId,
        targetId,
        expectedRevision,
        credentialStoredSchema
      )
    })
  }

  public removeRemoteCredential(enrollmentId: string, targetId: string): Promise<void> {
    return this.enqueueUtility(async () => {
      const runCredentialRemoval = this.utilityRunner.runCredentialRemoval
      if (!runCredentialRemoval) throw new Error('Credential removal is unavailable')
      await runCredentialRemoval.call(
        this.utilityRunner,
        this.stateDatabasePath,
        enrollmentId,
        targetId,
        credentialRemovedSchema
      )
    })
  }

  public previewDiagnostics(): Promise<DiagnosticBundlePreview> {
    return this.enqueueUtility(async () => {
      this.diagnosticApproval = undefined
      const preview = await this.utilityRunner.run(
        [
          'diagnostics-preview',
          '--state-db',
          this.stateDatabasePath,
          '--config',
          this.configurationPath,
          '--log-dir',
          this.logDirectoryPath
        ],
        diagnosticBundlePreviewSchema
      )
      this.diagnosticApproval = structuredClone(preview)
      return structuredClone(preview)
    })
  }

  public exportDiagnostics(
    destination: string,
    approvedPreview: DiagnosticBundlePreview
  ): Promise<DiagnosticExportResult> {
    return this.enqueueUtility(async () => {
      const retainedApproval = this.diagnosticApproval
      this.diagnosticApproval = undefined
      if (!retainedApproval) {
        throw new Error('A diagnostic preview must be approved before export')
      }
      let validatedApproval: DiagnosticBundlePreview
      try {
        validatedApproval = diagnosticBundlePreviewSchema.parse(approvedPreview)
      } catch {
        throw new Error('The approved diagnostic preview is invalid')
      }
      if (!isDeepStrictEqual(validatedApproval, retainedApproval)) {
        throw new Error('The approved diagnostic preview does not match')
      }
      return this.utilityRunner.run(
        [
          'diagnostics-export',
          '--state-db',
          this.stateDatabasePath,
          '--config',
          this.configurationPath,
          '--log-dir',
          this.logDirectoryPath,
          '--destination',
          destination
        ],
        absoluteResultSchema
      )
    })
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.sweepPendingContainmentCleanup()
      return operation()
    }
    const result = this.lifecycleQueue.then(run, run)
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private enqueueUtility<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.utilityQueue.then(operation, operation)
    this.utilityQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async startUnlocked(): Promise<ControlClient> {
    if (this.active?.client && this.active.startupComplete) return this.active.client
    if (this.active) await this.stopActive(this.active)

    try {
      await access(this.servicePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      await this.createServiceDirectories()
    } catch {
      throw new Error('The local control service could not be prepared')
    }
    let containment: ServiceProcessContainment
    try {
      containment = await this.createProcessContainment(this.platform)
    } catch {
      throw new Error('The local control service containment is unavailable')
    }
    let child: ChildProcessWithoutNullStreams
    const desktopBootstrapProof = randomBytes(32).toString('base64url')
    try {
      child = this.spawnProcess(
        this.servicePath,
        buildServiceArguments(
          this.endpoint,
          this.stateDatabasePath,
          this.cliSessionFilePath,
          this.configurationPath,
          this.logDirectoryPath,
          this.defaultWorkingDirectory
        ),
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: this.platform !== 'win32',
          env: buildServiceEnvironment(
            this.cliSessionFilePath,
            process.env,
            containment.environment,
            desktopBootstrapProof
          )
        }
      )
    } catch {
      await this.releaseContainment(containment)
      throw new Error('The local control service could not be started')
    }
    const active: ActiveService = {
      child,
      client: undefined,
      containment,
      generation: ++this.generation,
      deferredExitStatus: undefined,
      intentionalStop: false,
      startupComplete: false,
      desktopBootstrapProof,
      unexpectedExitReported: false
    }
    this.active = active
    this.observeChild(active)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => undefined)
    child.stdin.on('error', () => undefined)

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let startupSettled = false
    const startup = waitForServiceStartup(child, STARTUP_TIMEOUT_MS).finally(() => {
      startupSettled = true
    })
    void startup.catch(() => undefined)
    await nextTurn()
    if (
      !startupSettled &&
      this.active?.generation === active.generation &&
      !processHasExited(child)
    ) {
      try {
        child.stdin.write(`${this.token}\n`)
      } catch {
        // Startup remains fail-closed: readiness or process exit is still required below.
      }
    }

    let startupError: unknown
    try {
      const startupRecord = await startup
      if (startupRecord.event === 'service.recoveryRequired') {
        throw new ServiceRecoveryRequiredError(startupRecord)
      }

      let lastConnectionFailed = false
      while (Date.now() < deadline) {
        if (this.active?.generation !== active.generation || processHasExited(child)) break
        const client = this.createControlClient(this.endpoint, this.token)
        try {
          await client.connect()
          const identity = await client.identify()
          if (
            identity.application !== startupRecord.application ||
            identity.version !== startupRecord.version ||
            identity.protocolVersion !== startupRecord.protocolVersion
          ) {
            throw new Error('service identity mismatch')
          }
          assertServiceCapabilities(identity.capabilities)
          if (this.active?.generation !== active.generation || processHasExited(child)) {
            client.close()
            break
          }
          active.client = client
          active.startupComplete = true
          return client
        } catch {
          client.close()
          lastConnectionFailed = true
          await delay(CONNECT_RETRY_MS)
        }
      }
      throw new Error(
        lastConnectionFailed
          ? 'The local control service did not become ready in time'
          : 'The local control service stopped during startup'
      )
    } catch (error) {
      await this.stopActive(active)
      startupError = error
    }
    if (startupError instanceof ServiceRecoveryRequiredError) throw startupError
    throw new Error('The local control service could not be started')
  }

  private async stopUnlocked(): Promise<void> {
    const active = this.active
    if (!active) return
    await this.stopActive(active)
  }

  private async stopActive(active: ActiveService): Promise<void> {
    active.intentionalStop = true
    try {
      await stopServiceProcess(active.child, {
        containment: active.containment,
        timeoutMs: this.shutdownTimeoutMs
      })
    } catch {
      active.intentionalStop = false
      active.client?.close()
      active.client = undefined
      const deferredExitStatus = active.deferredExitStatus
      active.deferredExitStatus = undefined
      if (deferredExitStatus) this.reportUnexpectedExit(active, deferredExitStatus)
      throw new Error('The local control service could not be stopped')
    }
    active.client?.close()
    active.client = undefined
    await this.releaseContainment(active.containment)
    if (this.active?.generation === active.generation) this.active = undefined
  }

  private observeChild(active: ActiveService): void {
    let ended = false
    const processEnded = (status: UnexpectedServiceExit['status']): void => {
      if (ended) return
      ended = true
      if (this.active?.generation !== active.generation) return
      active.client?.close()
      active.client = undefined
      if (active.intentionalStop) {
        active.deferredExitStatus = status
        return
      }
      this.reportUnexpectedExit(active, status)
    }
    active.child.once('error', () => processEnded('failed'))
    active.child.once('exit', (_code, signal) => processEnded(signal ? 'signaled' : 'exited'))
  }

  private reportUnexpectedExit(
    active: ActiveService,
    status: UnexpectedServiceExit['status']
  ): void {
    if (
      this.active?.generation !== active.generation ||
      !active.startupComplete ||
      active.unexpectedExitReported
    ) {
      return
    }
    active.unexpectedExitReported = true
    console.error('[control-service] the local service stopped unexpectedly')
    const event: UnexpectedServiceExit = { reason: 'service-process-ended', status }
    for (const listener of this.unexpectedExitListeners) {
      try {
        listener(event)
      } catch {
        console.error('[control-service] an unexpected-exit listener failed')
      }
    }
  }

  private async releaseContainment(containment: ServiceProcessContainment): Promise<void> {
    for (let attempt = 0; attempt < CONTAINMENT_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await containment.dispose()
        this.pendingContainmentCleanup.delete(containment)
        return
      } catch (error) {
        if (isFileNotFoundError(error)) {
          this.pendingContainmentCleanup.delete(containment)
          return
        }
        if (attempt + 1 < CONTAINMENT_CLEANUP_ATTEMPTS) {
          await delay(CONTAINMENT_CLEANUP_RETRY_MS)
        }
      }
    }
    const wasPending = this.pendingContainmentCleanup.has(containment)
    this.pendingContainmentCleanup.add(containment)
    if (!wasPending) console.error(CONTAINMENT_CLEANUP_PENDING_MESSAGE)
  }

  private async sweepPendingContainmentCleanup(): Promise<void> {
    for (const containment of [...this.pendingContainmentCleanup]) {
      await this.releaseContainment(containment)
    }
  }

  private async createServiceDirectories(): Promise<void> {
    const directories = new Set([
      dirname(this.stateDatabasePath),
      dirname(this.configurationPath),
      this.logDirectoryPath,
      dirname(this.cliSessionFilePath)
    ])
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
    }
  }
}

export function waitForServiceStartup(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<ServiceStartupRecord> {
  return new Promise((resolveRecord, rejectRecord) => {
    let buffer = ''
    let settled = false
    const finish = (error: Error | undefined, record?: ServiceStartupRecord): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      child.stdout.pause()
      if (error) rejectRecord(error)
      else resolveRecord(record as ServiceStartupRecord)
    }
    const onData = (chunk: string): void => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > STARTUP_RECORD_MAX_BYTES) {
        finish(new Error('The local control service emitted an oversized startup record'))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      if (buffer.slice(newline + 1).trim().length > 0) {
        finish(new Error('The local control service emitted unexpected startup output'))
        return
      }
      const rawLine = buffer.slice(0, newline)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      try {
        finish(undefined, parseServiceStartupRecord(line))
      } catch {
        finish(new Error('The local control service emitted an invalid startup record'))
      }
    }
    const onError = (): void =>
      finish(new Error('The local control service failed before startup completed'))
    const onExit = (): void =>
      finish(new Error('The local control service exited before startup completed'))
    const timer = setTimeout(
      () => finish(new Error('The local control service startup record timed out')),
      timeoutMs
    )
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

export async function waitForServiceReady(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<ServiceReadyRecord> {
  const record = await waitForServiceStartup(child, timeoutMs)
  if (record.event === 'service.recoveryRequired') throw new ServiceRecoveryRequiredError(record)
  return record
}

export function parseServiceStartupRecord(line: string): ServiceStartupRecord {
  if (Buffer.byteLength(line) > STARTUP_RECORD_MAX_BYTES) {
    throw new Error('The local control service emitted an oversized startup record')
  }
  return startupRecordSchema.parse(JSON.parse(line) as unknown) as ServiceStartupRecord
}

export function parseServiceReadyRecord(line: string): ServiceReadyRecord {
  const record = parseServiceStartupRecord(line)
  if (record.event !== 'service.ready') {
    throw new Error('The local control service did not emit a readiness record')
  }
  return record
}

interface StopServiceProcessOptions {
  containment: ServiceProcessContainment
  timeoutMs: number
}

async function stopServiceProcess(
  child: ChildProcessWithoutNullStreams,
  options: StopServiceProcessOptions
): Promise<void> {
  const initiallyAlive = await containmentIsAlive(options.containment, child)
  if (processHasExited(child) && !initiallyAlive) return
  if (!processHasExited(child)) {
    try {
      child.stdin.end()
    } catch {
      // Exit verification and kernel-backed forced containment remain authoritative.
    }
  }
  if (await waitForContainedExit(child, options.containment, options.timeoutMs)) return
  await options.containment.terminate(child)
  if (!(await waitForContainedExit(child, options.containment, options.timeoutMs))) {
    throw new Error('forced process containment timed out')
  }
}

async function waitForContainedExit(
  child: ChildProcessWithoutNullStreams,
  containment: ServiceProcessContainment,
  timeoutMs: number
): Promise<boolean> {
  const exited = async (): Promise<boolean> =>
    processHasExited(child) && !(await containmentIsAlive(containment, child))
  if (await exited()) return true
  if (timeoutMs <= 0) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await delay(Math.min(25, Math.max(1, deadline - Date.now())))
    if (await exited()) return true
  }
  return exited()
}

async function containmentIsAlive(
  containment: ServiceProcessContainment,
  child: ChildProcessWithoutNullStreams
): Promise<boolean> {
  try {
    return await containment.isAlive(child)
  } catch {
    return true
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

export async function prepareServiceProcessContainment(
  platform: NodeJS.Platform,
  createLinuxCgroup: () => Promise<ServiceProcessContainment> = () =>
    LinuxCgroupContainment.create()
): Promise<ServiceProcessContainment> {
  if (platform === 'linux') {
    try {
      return await createLinuxCgroup()
    } catch {
      return new GracefulOnlyContainment()
    }
  }
  if (platform === 'win32') return new WindowsJobContainment()
  if (platform === 'darwin') return new GracefulOnlyContainment()
  throw new Error('service process containment is unsupported on this platform')
}

class LinuxCgroupContainment implements ServiceProcessContainment {
  public readonly environment: Readonly<NodeJS.ProcessEnv>

  private constructor(private readonly path: string) {
    this.environment = Object.freeze({
      [SERVICE_CONTAINMENT_ENVIRONMENT_VARIABLE]: `linux-cgroup-v2:${path}`
    })
  }

  public static async create(): Promise<LinuxCgroupContainment> {
    const membership = await readFile('/proc/self/cgroup', 'utf8')
    const relativePath = parseUnifiedCgroupPath(membership)
    const parent = resolve(LINUX_CGROUP_ROOT, `.${relativePath}`)
    if (parent !== LINUX_CGROUP_ROOT && !parent.startsWith(`${LINUX_CGROUP_ROOT}/`)) {
      throw new Error('invalid unified cgroup membership')
    }
    const path = resolve(parent, `agent-workspace-service-${randomUUID()}`)
    await mkdir(path, { mode: 0o700 })
    try {
      await access(resolve(path, 'cgroup.kill'), constants.W_OK)
      await access(resolve(path, 'cgroup.events'), constants.R_OK)
      await access(resolve(path, 'cgroup.procs'), constants.W_OK)
      return new LinuxCgroupContainment(path)
    } catch (error) {
      await rmdir(path).catch(() => undefined)
      throw error
    }
  }

  public async dispose(): Promise<void> {
    if (await this.isPopulated()) return
    await rmdir(this.path).catch((error: unknown) => {
      if (!isFileNotFoundError(error)) throw error
    })
  }

  public isAlive(): Promise<boolean> {
    return this.isPopulated()
  }

  public terminate(): Promise<void> {
    return writeFile(resolve(this.path, 'cgroup.kill'), '1')
  }

  private async isPopulated(): Promise<boolean> {
    const events = await readFile(resolve(this.path, 'cgroup.events'), 'utf8')
    const populated = /^populated ([01])$/m.exec(events)?.[1]
    if (populated === undefined) throw new Error('invalid cgroup events')
    return populated === '1'
  }
}

class WindowsJobContainment implements ServiceProcessContainment {
  public readonly environment = Object.freeze({
    [SERVICE_CONTAINMENT_ENVIRONMENT_VARIABLE]: 'windows-job-object'
  })

  public dispose(): Promise<void> {
    return Promise.resolve()
  }

  public isAlive(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    // The native service owns the Job handle. Closing it atomically terminates every member.
    return Promise.resolve(!processHasExited(child))
  }

  public terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    return Promise.resolve().then(() => {
      if (processHasExited(child)) return
      // libuv targets the process HANDLE retained by ChildProcess, never a freshly resolved PID.
      if (!child.kill('SIGKILL') && !processHasExited(child)) {
        throw new Error('service process handle termination failed')
      }
    })
  }
}

class GracefulOnlyContainment implements ServiceProcessContainment {
  public readonly environment = Object.freeze({
    [SERVICE_CONTAINMENT_ENVIRONMENT_VARIABLE]: 'graceful-only'
  })

  public dispose(): Promise<void> {
    return Promise.resolve()
  }

  public isAlive(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    return Promise.resolve(!processHasExited(child))
  }

  public terminate(): Promise<void> {
    // A bare PID can be reused after any snapshot. Never risk signaling an unrelated process.
    return Promise.reject(new Error('identity-safe forced process containment is unavailable'))
  }
}

export function parseUnifiedCgroupPath(membership: string): string {
  const unified = membership
    .split(/\r?\n/)
    .find((line) => line.startsWith('0::'))
    ?.slice(3)
  if (!unified?.startsWith('/') || unified.includes('\0')) {
    throw new Error('unified cgroup v2 membership is unavailable')
  }
  return unified
}

export function assertServiceCapabilities(capabilities: readonly string[]): void {
  const available = new Set(capabilities)
  const missing = REQUIRED_CAPABILITIES.filter((capability) => !available.has(capability))
  if (missing.length > 0) {
    throw new Error(`The local control service is missing capabilities: ${missing.join(', ')}`)
  }
}

export function buildServiceArguments(
  endpoint: string,
  stateDatabasePath: string,
  cliSessionFilePath: string,
  configurationPath: string,
  logDirectoryPath: string,
  defaultWorkingDirectory?: string
): string[] {
  return [
    '--endpoint',
    endpoint,
    '--cli-session-file',
    cliSessionFilePath,
    '--state-db',
    stateDatabasePath,
    '--config',
    configurationPath,
    '--log-dir',
    logDirectoryPath,
    ...(defaultWorkingDirectory ? ['--default-cwd', defaultWorkingDirectory] : [])
  ]
}

export function buildServiceEnvironment(
  cliSessionFilePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  containmentEnvironment: Readonly<NodeJS.ProcessEnv> = {
    [SERVICE_CONTAINMENT_ENVIRONMENT_VARIABLE]: 'graceful-only'
  },
  desktopBootstrapProof?: string
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...containmentEnvironment,
    [CLI_SESSION_FILE_ENVIRONMENT_VARIABLE]: cliSessionFilePath,
    ...(desktopBootstrapProof
      ? { [DESKTOP_BOOTSTRAP_PROOF_ENVIRONMENT_VARIABLE]: desktopBootstrapProof }
      : {})
  }
}

export function resolveServicePath(paths: ServicePaths): string {
  const executable =
    process.platform === 'win32' ? `${SERVICE_BINARY_NAME}.exe` : SERVICE_BINARY_NAME
  if (paths.isPackaged) {
    return resolve(paths.resourcesPath, 'bin', executable)
  }
  const override = process.env[SERVICE_PATH_ENVIRONMENT_VARIABLE]
  if (override) return override
  return resolve(paths.workingDirectory, '..', '..', 'target', 'debug', executable)
}

function legacySupervisorOptions(
  stateDatabasePath: string,
  defaultWorkingDirectory: string | undefined,
  cliSessionFilePath: string | undefined
): ServiceSupervisorOptions {
  const userDataDirectory = resolve(dirname(stateDatabasePath), '..')
  return {
    stateDatabasePath,
    configurationPath: resolve(userDataDirectory, 'config', 'configuration.json'),
    logDirectoryPath: resolve(userDataDirectory, 'logs'),
    ...(defaultWorkingDirectory ? { defaultWorkingDirectory } : {}),
    ...(cliSessionFilePath ? { cliSessionFilePath } : {})
  }
}

const recoveryInspectionSchema: RuntimeSchema<RecoveryInspectionResult> = {
  parse(value: unknown): RecoveryInspectionResult {
    if (!isRecord(value)) throw new Error('invalid recovery inspection')
    const allowed = new Set(['classification', 'schemaVersion', 'migrationFrom', 'migrationTo'])
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw new Error('invalid recovery inspection')
    }
    const classification = value.classification
    if (!RECOVERY_CLASSIFICATIONS.has(classification as RecoveryInspectionCategory)) {
      throw new Error('invalid recovery inspection')
    }
    const result: RecoveryInspectionResult = {
      classification: classification as RecoveryInspectionCategory
    }
    for (const field of ['schemaVersion', 'migrationFrom', 'migrationTo'] as const) {
      if (value[field] !== undefined) {
        if (!isSafeRevision(value[field])) throw new Error('invalid recovery inspection')
        result[field] = value[field]
      }
    }
    if (!validRecoveryInspectionShape(result)) throw new Error('invalid recovery inspection')
    return result
  }
}

const credentialStoredSchema: RuntimeSchema<{ status: 'stored' }> = {
  parse(value: unknown) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      (value as { status?: unknown }).status !== 'stored'
    ) {
      throw new Error('invalid credential enrollment result')
    }
    return { status: 'stored' }
  }
}

const credentialRemovedSchema: RuntimeSchema<{ status: 'removed' }> = {
  parse(value: unknown) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      (value as { status?: unknown }).status !== 'removed'
    ) {
      throw new Error('invalid credential removal result')
    }
    return { status: 'removed' }
  }
}

const absoluteResultSchema: RuntimeSchema<DiagnosticExportResult> = {
  parse(value: unknown): DiagnosticExportResult {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => key !== 'path' && key !== 'bytes') ||
      typeof value.path !== 'string' ||
      value.path.length === 0 ||
      value.path.length > 4096 ||
      value.path.includes('\0') ||
      !isAbsolute(value.path) ||
      !isSafeRevision(value.bytes)
    ) {
      throw new Error('invalid utility result')
    }
    return { path: value.path, bytes: value.bytes }
  }
}

const RECOVERY_CLASSIFICATIONS = new Set<RecoveryInspectionCategory>([
  'healthy',
  'migrationRequired',
  'futureSchema',
  'corruptDatabase',
  'corruptSchema',
  'invalidSnapshot',
  'invalidWindowState',
  'migrationFailed',
  'permissions'
])

function validRecoveryInspectionShape(result: RecoveryInspectionResult): boolean {
  const fields = {
    schemaVersion: result.schemaVersion !== undefined,
    migrationFrom: result.migrationFrom !== undefined,
    migrationTo: result.migrationTo !== undefined
  }
  switch (result.classification) {
    case 'healthy':
      return fields.schemaVersion && !fields.migrationFrom && !fields.migrationTo
    case 'migrationRequired':
    case 'migrationFailed':
      return !fields.schemaVersion && fields.migrationFrom && fields.migrationTo
    case 'futureSchema':
      return fields.schemaVersion && !fields.migrationFrom && fields.migrationTo
    default:
      return !fields.schemaVersion && !fields.migrationFrom && !fields.migrationTo
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function processHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function nextTurn(): Promise<void> {
  return new Promise((resolveTurn) => setImmediate(resolveTurn))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
