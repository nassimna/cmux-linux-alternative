import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  knownHostsLine,
  parseHostKeyScan,
  SystemHostKeyScanner,
  type HostKeyDescriptor
} from './host-key-scanner'
import {
  prepareKnownHostsRoot,
  readKnownHostExact,
  removeKnownHostExact,
  writeKnownHostAtomic
} from './known-hosts-store'

const PROMPT_TTL_MS = 120_000
const MAX_PROMPTS = 64
const MAX_PROMPTS_PER_TARGET = 4
const TARGET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export interface HostKeyTarget {
  remoteTargetId: string
  host: string
  port: number
  hostKeyState: 'untrusted' | 'trusted' | 'changed' | 'revoked'
  revision: number
}

export interface HostKeyChallenge {
  remoteSessionId: string
  promptId: string
  attemptGeneration: number
  canonicalHost: string
  port: number
  algorithm: 'ssh-ed25519'
  publicKey: string
  presentedFingerprint: string
  targetRevision: number
  expiresAtMs: number
}

const verifiedLaunches = new WeakSet<object>()

/** A fresh exact host-key check bound to this authority's approved known-hosts file. */
export interface VerifiedHostKeyLaunch {
  readonly remoteTargetId: string
  readonly targetRevision: number
  readonly host: string
  readonly port: number
  readonly knownHostsPath: string
  readonly descriptor: HostKeyDescriptor
}

export function isVerifiedHostKeyLaunch(value: unknown): value is VerifiedHostKeyLaunch {
  return typeof value === 'object' && value !== null && verifiedLaunches.has(value)
}

interface PendingPrompt {
  remoteSessionId: string
  remoteTargetId: string
  targetRevision: number
  attemptGeneration: number
  expiresAtMs: number
  descriptor: HostKeyDescriptor
}

interface HostKeyScanner {
  scan(host: string, port: number): Promise<HostKeyDescriptor>
}

export class HostKeyAuthorityError extends Error {
  public constructor(
    public readonly code: 'host_key_mismatch' | 'host_key_trust_required' | 'prompt_capacity',
    message: string
  ) {
    super(message)
    this.name = 'HostKeyAuthorityError'
  }
}

/** Process-local one-use trust prompts; durable approved keys stay in private files. */
export class HostKeyAuthority {
  private readonly prompts = new Map<string, PendingPrompt>()

  private constructor(
    private readonly root: string,
    private readonly scanner: HostKeyScanner,
    private readonly now: () => number
  ) {}

  public static async create(
    root: string,
    scanner?: HostKeyScanner,
    now: () => number = Date.now
  ): Promise<HostKeyAuthority> {
    await prepareKnownHostsRoot(root)
    return new HostKeyAuthority(root, scanner ?? (await SystemHostKeyScanner.resolveSystem()), now)
  }

  /** Reuse a live profile only after every trusted target has an exact approved key. */
  public static async openLive(
    stateDatabasePath: string,
    targets: readonly HostKeyTarget[],
    scanner?: HostKeyScanner,
    now: () => number = Date.now
  ): Promise<HostKeyAuthority> {
    const root = join(dirname(stateDatabasePath), 'remote-known-hosts')
    const trusted = targets.filter((target) => target.hostKeyState === 'trusted')
    const ids = new Set<string>()
    for (const target of targets) {
      if (!TARGET_ID_PATTERN.test(target.remoteTargetId) || ids.has(target.remoteTargetId)) {
        throw new Error('Live remote target catalog is invalid')
      }
      ids.add(target.remoteTargetId)
    }
    try {
      await lstat(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || trusted.length > 0) {
        throw new Error('Live known-hosts directory is missing or unsafe')
      }
    }
    await prepareKnownHostsRoot(root)
    for (const target of trusted) {
      await readKnownHostExact(
        join(root, `${target.remoteTargetId}.known_hosts`),
        target.host,
        target.port
      )
    }
    return new HostKeyAuthority(root, scanner ?? (await SystemHostKeyScanner.resolveSystem()), now)
  }

  public async challenge(
    target: HostKeyTarget,
    remoteSessionId: string,
    attemptGeneration: number
  ): Promise<HostKeyChallenge> {
    this.pathFor(target.remoteTargetId)
    if (
      target.hostKeyState === 'trusted' ||
      !Number.isSafeInteger(attemptGeneration) ||
      attemptGeneration < 1
    ) {
      throw new HostKeyAuthorityError('host_key_mismatch', 'Host-key challenge is unavailable')
    }
    this.checkCapacity(target.remoteTargetId)
    const descriptor = await this.scanner.scan(target.host, target.port)
    if (descriptor.canonicalHost !== target.host || descriptor.port !== target.port) {
      throw new HostKeyAuthorityError('host_key_mismatch', 'Scanned host key did not match target')
    }
    const normalized = parseHostKeyScan(
      Buffer.from(knownHostsLine(descriptor)),
      target.host,
      target.port
    )
    if (normalized.fingerprint !== descriptor.fingerprint) {
      throw new HostKeyAuthorityError('host_key_mismatch', 'Scanned fingerprint did not match key')
    }
    this.checkCapacity(target.remoteTargetId)
    const expiresAtMs = this.clock() + PROMPT_TTL_MS
    const promptId = randomUUID()
    this.prompts.set(promptId, {
      remoteSessionId,
      remoteTargetId: target.remoteTargetId,
      targetRevision: target.revision,
      attemptGeneration,
      expiresAtMs,
      descriptor
    })
    return {
      remoteSessionId,
      promptId,
      attemptGeneration,
      canonicalHost: descriptor.canonicalHost,
      port: descriptor.port,
      algorithm: descriptor.algorithm,
      publicKey: descriptor.publicKey,
      presentedFingerprint: descriptor.fingerprint,
      targetRevision: target.revision,
      expiresAtMs
    }
  }

  public async decide(
    target: HostKeyTarget,
    request: {
      remoteSessionId: string
      promptId: string
      attemptGeneration: number
      presentedFingerprint: string
      decision: 'reject' | 'trust'
    }
  ): Promise<void> {
    const prompt = this.prompts.get(request.promptId)
    this.prompts.delete(request.promptId)
    if (
      !prompt ||
      prompt.remoteSessionId !== request.remoteSessionId ||
      prompt.remoteTargetId !== target.remoteTargetId ||
      prompt.targetRevision !== target.revision ||
      prompt.attemptGeneration !== request.attemptGeneration ||
      prompt.expiresAtMs < this.clock() ||
      prompt.descriptor.fingerprint !== request.presentedFingerprint ||
      prompt.descriptor.canonicalHost !== target.host ||
      prompt.descriptor.port !== target.port ||
      (request.decision !== 'reject' && request.decision !== 'trust') ||
      target.hostKeyState === 'trusted'
    ) {
      throw new HostKeyAuthorityError('host_key_mismatch', 'Host-key prompt is stale or mismatched')
    }
    if (request.decision === 'trust') {
      await writeKnownHostAtomic(this.pathFor(target.remoteTargetId), prompt.descriptor)
    }
  }

  /** A scanned challenge can be replayed only while its one-use prompt is live. */
  public hasPrompt(promptId: string): boolean {
    const prompt = this.prompts.get(promptId)
    if (!prompt) return false
    if (prompt.expiresAtMs < this.clock()) {
      this.prompts.delete(promptId)
      return false
    }
    return true
  }

  public async verify(target: HostKeyTarget): Promise<HostKeyDescriptor> {
    if (target.hostKeyState !== 'trusted') {
      throw new HostKeyAuthorityError('host_key_trust_required', 'Exact host-key trust is required')
    }
    const approved = await readKnownHostExact(
      this.pathFor(target.remoteTargetId),
      target.host,
      target.port
    )
    const presented = await this.scanner.scan(target.host, target.port)
    if (
      approved.canonicalHost !== presented.canonicalHost ||
      approved.port !== presented.port ||
      approved.algorithm !== presented.algorithm ||
      approved.publicKey !== presented.publicKey ||
      approved.fingerprint !== presented.fingerprint
    ) {
      throw new HostKeyAuthorityError('host_key_mismatch', 'SSH host key changed')
    }
    return approved
  }

  public async verifyForLaunch(target: HostKeyTarget): Promise<VerifiedHostKeyLaunch> {
    const descriptor = await this.verify(target)
    const result = Object.freeze({
      remoteTargetId: target.remoteTargetId,
      targetRevision: target.revision,
      host: target.host,
      port: target.port,
      knownHostsPath: this.pathFor(target.remoteTargetId),
      descriptor: Object.freeze({ ...descriptor })
    })
    verifiedLaunches.add(result)
    return result
  }

  public async removeTarget(targetId: string): Promise<void> {
    for (const [promptId, prompt] of this.prompts) {
      if (prompt.remoteTargetId === targetId) this.prompts.delete(promptId)
    }
    await removeKnownHostExact(this.pathFor(targetId))
  }

  private pathFor(targetId: string): string {
    if (!TARGET_ID_PATTERN.test(targetId)) {
      throw new HostKeyAuthorityError('host_key_mismatch', 'Invalid remote target identity')
    }
    return join(this.root, `${targetId}.known_hosts`)
  }

  private checkCapacity(targetId: string): void {
    const now = this.clock()
    for (const [promptId, prompt] of this.prompts) {
      if (prompt.expiresAtMs < now) this.prompts.delete(promptId)
    }
    let targetCount = 0
    for (const prompt of this.prompts.values()) {
      if (prompt.remoteTargetId === targetId) targetCount += 1
    }
    if (this.prompts.size >= MAX_PROMPTS || targetCount >= MAX_PROMPTS_PER_TARGET) {
      throw new HostKeyAuthorityError('prompt_capacity', 'Host-key prompt limit reached')
    }
  }

  private clock(): number {
    const at = this.now()
    if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - PROMPT_TTL_MS) {
      throw new HostKeyAuthorityError('host_key_mismatch', 'Invalid host-key prompt clock')
    }
    return at
  }
}
