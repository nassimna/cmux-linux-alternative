import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  configurationGetResultSchema,
  configurationUpdateParamsSchema
} from '@agent-workspace/protocol-client'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { validateEffectiveShortcuts } from '../persistence/settings-mutations'
import { TerminalService } from '../terminal/terminal-service'
import { serviceLogger, type ServiceLogger } from '../logging/service-logger'

const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_NODES = 4096
const MAX_DEPTH = 32
const MAX_UNKNOWN_BYTES = 256 * 1024
const SECTIONS = [
  'appearance',
  'terminal',
  'browser',
  'notifications',
  'keyboardShortcuts',
  'agentIntegration',
  'updates',
  'logging'
] as const

type Snapshot = ReturnType<typeof configurationGetResultSchema.parse>['config']

const DEFAULTS: Snapshot = {
  schemaVersion: 2,
  revision: 0,
  appearance: {
    theme: 'system',
    density: 'comfortable',
    fontFamily: "system-ui, 'Segoe UI', 'Cantarell', 'Ubuntu', sans-serif"
  },
  terminal: {
    shellPath: null,
    fontFamily: 'JetBrains Mono Variable',
    fontSize: 13,
    scrollback: 10_000,
    multilinePasteProtection: true
  },
  browser: { profileName: 'Default', partition: 'default', privacy: 'standard' },
  notifications: { systemEnabled: true, includeBody: false },
  keyboardShortcuts: { overrides: {} },
  agentIntegration: { enabled: true, notificationsEnabled: true, browserEnabled: true },
  updates: { channel: 'stable' },
  logging: { level: 'info' }
}

export class ConfigurationQualificationError extends Error {
  constructor(
    public readonly code:
      | 'unsafe_config'
      | 'invalid_config'
      | 'config_unavailable'
      | 'revision_conflict'
      | 'revision_overflow'
      | 'runtime_unavailable'
      | 'runtime_failure'
      | 'consistency_failure'
  ) {
    super(code.replaceAll('_', ' '))
    this.name = 'ConfigurationQualificationError'
  }
}

function fail(code: ConfigurationQualificationError['code']): never {
  throw new ConfigurationQualificationError(code)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runtimeShortcuts(
  overrides: Snapshot['keyboardShortcuts']['overrides']
): Record<string, string | null> {
  const result: Record<string, string | null> = {}
  for (const [command, shortcut] of Object.entries(overrides)) {
    if (shortcut !== undefined) result[command] = shortcut
  }
  return result
}

/** Rust ConfigStore's bounded JSON extension policy, before any projection discards fields. */
function validateJsonBudget(root: unknown): void {
  let nodes = 0
  let budget = 0
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('invalid_config')
    if (Array.isArray(value)) {
      if (value.length > 256) fail('invalid_config')
      for (const child of value) visit(child, depth + 1)
    } else if (object(value)) {
      const entries = Object.entries(value)
      if (entries.length > 512) fail('invalid_config')
      for (const [key, child] of entries) {
        if (Buffer.byteLength(key) > 4096 || /token|secret|command/iu.test(key))
          fail('invalid_config')
        budget +=
          Buffer.byteLength(key) +
          (typeof child === 'string'
            ? Buffer.byteLength(child)
            : object(child) || Array.isArray(child)
              ? 1
              : 24)
        if (budget > MAX_UNKNOWN_BYTES) fail('invalid_config')
        visit(child, depth + 1)
      }
    } else if (typeof value === 'string' && Buffer.byteLength(value) > 4096) {
      fail('invalid_config')
    }
  }
  visit(root, 0)
}

function project(raw: unknown): { config: Snapshot; unknownFieldsPresent: boolean } {
  if (!object(raw) || ![1, 2].includes(raw.schemaVersion as number)) fail('invalid_config')
  if (raw.schemaVersion === 1 && object(raw.appearance) && raw.appearance.density === 'expanded')
    fail('invalid_config')
  const candidate: Record<string, unknown> = {
    schemaVersion: 2,
    revision: raw.revision ?? 0
  }
  let unknownFieldsPresent = Object.keys(raw).some(
    (key) => !['schemaVersion', 'revision', ...SECTIONS, 'actions', 'remoteSessions'].includes(key)
  )
  for (const section of SECTIONS) {
    const value = raw[section]
    if (value !== undefined && !object(value)) fail('invalid_config')
    const defaults = DEFAULTS[section] as Record<string, unknown>
    if (value && Object.keys(value).some((key) => !(key in defaults))) unknownFieldsPresent = true
    candidate[section] = Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [
        key,
        value && Object.hasOwn(value, key) ? value[key] : fallback
      ])
    )
  }
  if (raw.actions !== undefined && !object(raw.actions)) fail('invalid_config')
  if (raw.remoteSessions !== undefined && !object(raw.remoteSessions)) fail('invalid_config')
  // Action trust policy is outside this read-only slice. Fail closed on non-default policy.
  if (object(raw.actions)) {
    if (
      Object.keys(raw.actions).some(
        (key) => !['approvedExecutables', 'trustedProjects'].includes(key)
      )
    )
      fail('invalid_config')
    for (const field of ['approvedExecutables', 'trustedProjects']) {
      const value = raw.actions[field]
      if (value !== undefined && (!Array.isArray(value) || value.length !== 0))
        fail('invalid_config')
    }
  }
  if (object(raw.remoteSessions)) {
    if (
      Object.keys(raw.remoteSessions).some(
        (key) =>
          !['reconnectMaxAttempts', 'reconnectInitialDelayMs', 'reconnectMaxDelayMs'].includes(key)
      )
    )
      fail('invalid_config')
    const attempts = raw.remoteSessions.reconnectMaxAttempts ?? 5
    const initial = raw.remoteSessions.reconnectInitialDelayMs ?? 500
    const maximum = raw.remoteSessions.reconnectMaxDelayMs ?? 30_000
    if (
      !Number.isInteger(attempts) ||
      !Number.isInteger(initial) ||
      !Number.isInteger(maximum) ||
      (attempts as number) < 0 ||
      (attempts as number) > 10 ||
      (initial as number) < 100 ||
      (initial as number) > 60_000 ||
      (maximum as number) < (initial as number) ||
      (maximum as number) > 300_000
    )
      fail('invalid_config')
  }
  const parsed = configurationGetResultSchema.safeParse({ config: candidate })
  if (!parsed.success) fail('invalid_config')
  return { config: parsed.data.config, unknownFieldsPresent }
}

/** Shared strict decoder for private copies and explicit live-settings preflight. */
export function qualifyConfigurationBytes(bytes: Buffer): {
  config: Snapshot
  unknownFieldsPresent: boolean
  raw: Record<string, unknown>
} {
  if (bytes.byteLength > MAX_CONFIG_BYTES) fail('invalid_config')
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    fail('invalid_config')
  }
  validateJsonBudget(raw)
  const result = project(raw)
  return { ...result, raw: raw as Record<string, unknown> }
}

/** Configuration authority beside the owned SQLite state. */
export class ConfigurationQualification {
  private constructor(
    private readonly workingDirectory: string,
    private readonly state: ApplicationStateStore,
    public readonly writable: boolean,
    private readonly terminals?: TerminalService,
    private readonly logger: ServiceLogger = serviceLogger
  ) {}

  static async create(
    workingPath: string,
    state: ApplicationStateStore,
    writable = false,
    terminals?: TerminalService,
    logger?: ServiceLogger
  ) {
    const directory = dirname(workingPath)
    const resolved = await realpath(directory)
    const metadata = await stat(resolved)
    if (directory !== resolved || !metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
      fail('unsafe_config')
    return new ConfigurationQualification(resolved, state, writable, terminals, logger)
  }

  /** Live settings are usable only after the exact database owner has transferred. */
  static async createLive(
    livePath: string,
    state: ApplicationStateStore,
    terminals: TerminalService,
    logger?: ServiceLogger
  ): Promise<ConfigurationQualification> {
    const owner = state.liveOwnerEvidence(livePath)
    const authority = await this.create(livePath, state, true, terminals, logger)
    owner.assertDatabaseUnchanged()
    return authority
  }

  /** Validate saved shell configuration before any restored workspace can launch a terminal. */
  async initializeTerminalRuntime(): Promise<void> {
    if (!this.writable) return
    if (!this.terminals) fail('runtime_unavailable')
    const { raw } = await this.load()
    const { config } = project(raw)
    try {
      await TerminalService.validateConfiguredShell(config.terminal.shellPath)
    } catch {
      fail('invalid_config')
    }
    this.terminals.setConfiguredShell(config.terminal.shellPath)
    this.logger.setLevel(config.logging.level)
    this.logger.emit('info', 'configurationReady')
  }

  async inspect() {
    const { bytes, raw } = await this.load()
    const { config, unknownFieldsPresent } = project(raw)
    const snapshot = this.state.readSnapshot()
    const runtimeSettingsMatch =
      config.notifications.systemEnabled === snapshot.notificationSettings.systemEnabled &&
      config.notifications.includeBody === snapshot.notificationSettings.includeBody &&
      JSON.stringify(Object.entries(config.keyboardShortcuts.overrides).sort()) ===
        JSON.stringify(Object.entries(snapshot.shortcutOverrides).sort())
    return {
      config,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      unknownFieldsPresent,
      runtimeSettingsMatch,
      writable: false as const
    }
  }

  /** Read and repair the runtime-backed sections, as Rust configuration.get does. */
  async get() {
    if (!this.writable) fail('runtime_unavailable')
    return this.state.exclusive(async () => {
      const { raw } = await this.load()
      const { config } = project(raw)
      const snapshot = this.state.readSnapshot()
      const shortcuts = runtimeShortcuts(config.keyboardShortcuts.overrides)
      if (
        config.notifications.systemEnabled === snapshot.notificationSettings.systemEnabled &&
        config.notifications.includeBody === snapshot.notificationSettings.includeBody &&
        JSON.stringify(Object.entries(shortcuts).sort()) ===
          JSON.stringify(Object.entries(snapshot.shortcutOverrides).sort())
      ) {
        return { config }
      }
      if (config.revision >= Number.MAX_SAFE_INTEGER) fail('revision_overflow')
      const reconciled: Record<string, unknown> = {
        ...raw,
        schemaVersion: 2,
        revision: config.revision + 1,
        notifications: {
          ...(object(raw.notifications) ? raw.notifications : {}),
          ...snapshot.notificationSettings
        },
        keyboardShortcuts: {
          ...(object(raw.keyboardShortcuts) ? raw.keyboardShortcuts : {}),
          overrides: snapshot.shortcutOverrides
        }
      }
      await this.write(reconciled)
      return { config: project(reconciled).config }
    })
  }

  /** Rust-style section replacement on the isolated copy, with a SQLite compensation boundary. */
  async update(input: unknown) {
    if (!this.writable) fail('runtime_unavailable')
    const params = configurationUpdateParamsSchema.parse(input)
    return this.state.exclusive(async () => {
      const { raw } = await this.load()
      const { config: original } = project(raw)
      if (original.revision !== params.expectedRevision) fail('revision_conflict')
      if (original.revision >= Number.MAX_SAFE_INTEGER) fail('revision_overflow')
      const before = this.state.readSnapshot()
      const candidate: Record<string, unknown> = {
        ...raw,
        schemaVersion: 2,
        revision: original.revision + 1,
        notifications: {
          ...(object(raw.notifications) ? raw.notifications : {}),
          ...before.notificationSettings
        },
        keyboardShortcuts: {
          ...(object(raw.keyboardShortcuts) ? raw.keyboardShortcuts : {}),
          overrides: before.shortcutOverrides
        }
      }
      for (const [section, value] of Object.entries(params.update)) {
        candidate[section] = {
          ...(object(raw[section]) ? raw[section] : {}),
          ...value
        }
      }
      validateJsonBudget(candidate)
      const { config: next } = project(candidate)
      const shellChanged = next.terminal.shellPath !== original.terminal.shellPath
      if (shellChanged) {
        if (!this.terminals) fail('runtime_unavailable')
        try {
          await TerminalService.validateConfiguredShell(next.terminal.shellPath)
        } catch {
          fail('invalid_config')
        }
      }
      try {
        validateEffectiveShortcuts(runtimeShortcuts(next.keyboardShortcuts.overrides), 'nonMac')
      } catch {
        fail('invalid_config')
      }
      const runtimeChanged =
        JSON.stringify(next.notifications) !== JSON.stringify(before.notificationSettings) ||
        JSON.stringify(Object.entries(next.keyboardShortcuts.overrides).sort()) !==
          JSON.stringify(Object.entries(before.shortcutOverrides).sort())
      await this.write(candidate)
      if (runtimeChanged) {
        try {
          this.state.replaceConfigurationRuntimeSettings(
            before.revision,
            next.notifications,
            runtimeShortcuts(next.keyboardShortcuts.overrides)
          )
        } catch {
          try {
            await this.write(raw)
          } catch {
            fail('consistency_failure')
          }
          fail('runtime_failure')
        }
      }
      if (shellChanged) this.terminals!.setConfiguredShell(next.terminal.shellPath)
      if (next.logging.level !== original.logging.level) this.logger.setLevel(next.logging.level)
      this.logger.emit('debug', 'configurationUpdated')
      return { config: next }
    })
  }

  private async load(): Promise<{ bytes: Buffer; raw: Record<string, unknown> }> {
    const path = join(this.workingDirectory, 'config.json')
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { bytes: Buffer.alloc(0), raw: structuredClone(DEFAULTS) }
      }
      return fail('config_unavailable')
    }
    let bytes: Buffer
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > MAX_CONFIG_BYTES)
        fail('unsafe_config')
      bytes = await handle.readFile()
      if (bytes.byteLength > MAX_CONFIG_BYTES) fail('invalid_config')
    } finally {
      await handle.close()
    }
    const { raw } = qualifyConfigurationBytes(bytes)
    return { bytes, raw }
  }

  private async write(raw: Record<string, unknown>): Promise<void> {
    validateJsonBudget(raw)
    project(raw)
    const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    if (bytes.byteLength > MAX_CONFIG_BYTES) fail('invalid_config')
    const destination = join(this.workingDirectory, 'config.json')
    const temporary = join(this.workingDirectory, `.config.json.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      try {
        const existing = await lstat(destination)
        if (!existing.isFile() || (existing.mode & 0o077) !== 0) fail('unsafe_config')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      // The private directory is the transaction boundary; recheck before replacement.
      await this.load()
      await rename(temporary, destination)
      const directory = await open(this.workingDirectory, constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      if (error instanceof ConfigurationQualificationError) throw error
      fail('config_unavailable')
    } finally {
      await handle?.close()
      await rm(temporary, { force: true })
    }
  }
}
