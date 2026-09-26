import type { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import type { DesktopProviderIdentityParams } from '@agent-workspace/protocol-client'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import type { AgentHibernationAuthority } from '../persistence/agent-hibernation-challenges'
import { BrowserAutomationProviderAuthority } from '../browser-automation/provider-authority'
import { BrowserAutomationDurableRecords } from '../browser-automation/durable-records'
import { BrowserAutomationRuntime } from '../browser-automation/runtime'
import { WindowBindingError, WindowBindingRegistry } from './window-binding-registry'
import { WindowHostingAuthority } from './window-hosting-authority'

const MAX_FRAME_BYTES = 1_024
const MAX_BUFFER_BYTES = 4_096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/u

type Request =
  | { id: string; operation: 'liveBackupProof' }
  | { id: string; operation: 'issue'; windowId: string }
  | {
      id: string
      operation: 'registerAutomationProvider'
      windowId: string
      windowGeneration: number
    }
  | {
      id: string
      operation: 'revokeAutomationProvider'
      windowId: string
      windowGeneration: number
      identity: DesktopProviderIdentityParams
    }
  | {
      id: string
      operation: 'registerHosting' | 'heartbeatHosting' | 'revokeHosting'
      windowId: string
      windowGeneration: number
    }
  | { id: string; operation: 'revoke'; capability: string }
  | { id: string; operation: 'revokeWindow'; windowId: string }

/**
 * The caller must pass the inherited fd 3 duplex pipe, never a network socket.
 * Its peer is trusted Electron main. No HTTP-supplied window ID reaches issue().
 */
export class WindowOwnerChannel {
  public readonly registry: WindowBindingRegistry
  public readonly automation: BrowserAutomationProviderAuthority
  public readonly agentHibernationAuthority: AgentHibernationAuthority
  public readonly automationRecords: BrowserAutomationDurableRecords | undefined
  public readonly automationRuntime: BrowserAutomationRuntime | undefined
  public readonly hosting: WindowHostingAuthority | undefined
  private readonly automationDatabase: Database.Database | undefined
  private readonly hostingSweep: NodeJS.Timeout | undefined
  private readonly automationSweep: NodeJS.Timeout | undefined
  private pending = Buffer.alloc(0)
  private closed = false

  public constructor(
    private readonly stream: Duplex,
    state: Pick<ApplicationStateStore, 'readSnapshot'> &
      Partial<
        Pick<
          ApplicationStateStore,
          'currentIdempotencyEpoch' | 'reconcileWindowHosting' | 'liveBackupProof'
        >
      >,
    durable?: { databasePath: string; digestKey: Buffer }
  ) {
    this.state = state
    this.registry = new WindowBindingRegistry(state)
    if (state.reconcileWindowHosting) {
      this.hosting = new WindowHostingAuthority({
        reconcileWindowHosting: (claims) => state.reconcileWindowHosting!(claims)
      })
      this.hostingSweep = setInterval(() => {
        try {
          this.hosting?.expire()
        } catch {
          console.error('[window-hosting] lease reconciliation failed')
        }
      }, 1_000)
      this.hostingSweep.unref()
    }
    this.automation = new BrowserAutomationProviderAuthority((windowId) =>
      this.registry.hasCurrentWindow(windowId)
    )
    this.agentHibernationAuthority = {
      current: (provider, window) => this.automation.isCurrent(provider, window)
    }
    if (durable) {
      if (!state.currentIdempotencyEpoch)
        throw new Error('Automation runtime requires the isolated state epoch')
      this.automationDatabase = new Database(durable.databasePath, {
        fileMustExist: true,
        timeout: 5_000
      })
      this.automationDatabase.pragma('foreign_keys = ON')
      this.automationRecords = new BrowserAutomationDurableRecords(
        this.automationDatabase,
        this.automation,
        durable.digestKey
      )
      this.automationRecords.recoverAfterRestart()
      this.automationRuntime = new BrowserAutomationRuntime(
        this.automation,
        this.automationRecords,
        automationCallerId(durable.digestKey),
        () => state.currentIdempotencyEpoch!()
      )
      this.automationSweep = setInterval(() => {
        try {
          this.automationRecords?.reconcile()
        } catch {
          console.error('[browser-automation] reconciliation failed')
        }
      }, 1_000)
      this.automationSweep.unref()
    }
    stream.on('data', this.onData)
    stream.on('error', this.close)
    stream.on('close', this.close)
  }

  private readonly state: Pick<ApplicationStateStore, 'readSnapshot'> &
    Partial<Pick<ApplicationStateStore, 'liveBackupProof'>>

  public close = (): void => {
    if (this.closed) return
    this.closed = true
    this.pending = Buffer.alloc(0)
    this.registry.dispose()
    this.automation.dispose()
    if (this.hostingSweep) clearInterval(this.hostingSweep)
    if (this.automationSweep) clearInterval(this.automationSweep)
    try {
      this.hosting?.close()
    } catch {
      console.error('[window-hosting] owner shutdown reconciliation failed')
    }
    try {
      this.automationRecords?.recoverAfterRestart()
    } catch {
      console.error('[browser-automation] provider recovery failed')
    } finally {
      this.automationDatabase?.close()
    }
    this.stream.off('data', this.onData)
    this.stream.destroy()
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.closed) return
    if (!Buffer.isBuffer(chunk) || this.pending.length + chunk.length > MAX_BUFFER_BYTES) {
      this.close()
      return
    }
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0)
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.close()
        return
      }
      if (this.pending.length < length + 4) break
      const payload = this.pending.subarray(4, length + 4)
      this.pending = this.pending.subarray(length + 4)
      const request = parseRequest(payload)
      if (!request) {
        this.close()
        return
      }
      this.respond(request)
      if (this.closed) return
    }
  }

  private respond(request: Request): void {
    try {
      if (request.operation === 'liveBackupProof') {
        if (!this.state.liveBackupProof) throw new Error('live_backup_unavailable')
        this.write({ id: request.id, ok: true, proof: this.state.liveBackupProof() })
      } else if (request.operation === 'issue') {
        this.write({
          id: request.id,
          ok: true,
          capability: this.registry.issueForTrustedOwner(request.windowId)
        })
      } else if (request.operation === 'registerAutomationProvider') {
        this.write({
          id: request.id,
          ok: true,
          identity: this.automation.registerTrustedWindow(
            request.windowId,
            request.windowGeneration
          )
        })
      } else if (request.operation === 'revokeAutomationProvider') {
        this.automation.revokeIfCurrent(
          { windowId: request.windowId, windowGeneration: request.windowGeneration },
          request.identity
        )
        this.write({ id: request.id, ok: true })
      } else if (
        request.operation === 'registerHosting' ||
        request.operation === 'heartbeatHosting' ||
        request.operation === 'revokeHosting'
      ) {
        if (!this.hosting) throw new Error('hosting_unavailable')
        const revision =
          request.operation === 'registerHosting'
            ? this.hosting.register(request.windowId, request.windowGeneration)
            : request.operation === 'heartbeatHosting'
              ? this.hosting.heartbeat(request.windowId, request.windowGeneration)
              : this.hosting.revoke(request.windowId, request.windowGeneration)
        this.write({ id: request.id, ok: true, revision })
      } else if (request.operation === 'revoke') {
        this.registry.revoke(request.capability)
        this.write({ id: request.id, ok: true })
      } else {
        this.registry.revokeWindow(request.windowId)
        this.automation.revokeWindow(request.windowId)
        this.write({ id: request.id, ok: true })
      }
    } catch (error) {
      const code =
        error instanceof WindowBindingError
          ? error.code
          : error instanceof Error && error.message === 'stale_window_generation'
            ? error.message
            : 'owner_channel_unavailable'
      this.write({ id: request.id, ok: false, error: code })
    }
  }

  private write(value: object): void {
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    if (payload.length > MAX_FRAME_BYTES) {
      this.close()
      return
    }
    const frame = Buffer.allocUnsafe(payload.length + 4)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    try {
      if (!this.stream.write(frame)) {
        this.stream.pause()
        this.stream.once('drain', () => {
          if (!this.closed) this.stream.resume()
        })
      }
    } catch {
      this.close()
    }
  }
}

function automationCallerId(digestKey: Buffer): string {
  const bytes = createHash('sha256')
    .update('node-browser-owner-v1\0')
    .update(digestKey)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function parseRequest(payload: Buffer): Request | undefined {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8')) as unknown
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || !UUID.test(candidate.id)) return undefined
  if (candidate.operation === 'liveBackupProof') {
    if (Object.keys(candidate).length !== 2) return undefined
    return { id: candidate.id, operation: 'liveBackupProof' }
  }
  if (candidate.operation === 'issue' || candidate.operation === 'revokeWindow') {
    if (
      Object.keys(candidate).length !== 3 ||
      typeof candidate.windowId !== 'string' ||
      !UUID.test(candidate.windowId)
    )
      return undefined
    return { id: candidate.id, operation: candidate.operation, windowId: candidate.windowId }
  }
  if (
    candidate.operation === 'registerAutomationProvider' ||
    candidate.operation === 'registerHosting' ||
    candidate.operation === 'heartbeatHosting' ||
    candidate.operation === 'revokeHosting'
  ) {
    if (
      Object.keys(candidate).length !== 4 ||
      typeof candidate.windowId !== 'string' ||
      !UUID.test(candidate.windowId) ||
      typeof candidate.windowGeneration !== 'number' ||
      !Number.isSafeInteger(candidate.windowGeneration) ||
      candidate.windowGeneration < 1
    )
      return undefined
    return {
      id: candidate.id,
      operation: candidate.operation,
      windowId: candidate.windowId,
      windowGeneration: candidate.windowGeneration
    }
  }
  if (candidate.operation === 'revokeAutomationProvider') {
    const identity = candidate.identity
    if (
      Object.keys(candidate).length !== 5 ||
      typeof candidate.windowId !== 'string' ||
      !UUID.test(candidate.windowId) ||
      typeof candidate.windowGeneration !== 'number' ||
      !Number.isSafeInteger(candidate.windowGeneration) ||
      candidate.windowGeneration < 1 ||
      !identity ||
      typeof identity !== 'object' ||
      Array.isArray(identity)
    )
      return undefined
    const fields = identity as Record<string, unknown>
    if (
      Object.keys(fields).length !== 3 ||
      typeof fields.providerId !== 'string' ||
      !UUID.test(fields.providerId) ||
      typeof fields.leaseId !== 'string' ||
      !UUID.test(fields.leaseId) ||
      typeof fields.providerEpoch !== 'number' ||
      !Number.isSafeInteger(fields.providerEpoch) ||
      fields.providerEpoch < 1
    )
      return undefined
    return {
      id: candidate.id,
      operation: 'revokeAutomationProvider',
      windowId: candidate.windowId,
      windowGeneration: candidate.windowGeneration,
      identity: {
        providerId: fields.providerId,
        providerEpoch: fields.providerEpoch,
        leaseId: fields.leaseId
      }
    }
  }
  if (candidate.operation === 'revoke') {
    if (
      Object.keys(candidate).length !== 3 ||
      typeof candidate.capability !== 'string' ||
      !CAPABILITY.test(candidate.capability)
    )
      return undefined
    return { id: candidate.id, operation: 'revoke', capability: candidate.capability }
  }
  return undefined
}
