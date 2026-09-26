/* eslint-disable @typescript-eslint/no-unsafe-call -- dbus-next exposes proxy interface methods as Function. */
import {
  createCipheriv,
  createDecipheriv,
  getDiffieHellman,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { prepareBrokerRoot } from './credential-agent-broker'
import dbus from 'dbus-next'
import { ensureSecretService } from '../secret-service/activation'

import { parseEd25519Credential } from './credential-agent-broker'
import {
  assertInheritedCredentialReadOnly,
  readInheritedCredentialFd
} from './credential-inherited-fd'
import {
  CredentialBrokerLease,
  CredentialError,
  CredentialReference,
  type CredentialProvider
} from './credential-provider'
import { IsolatedCredentialScope } from './credential-scope'
import type { LiveOwnerLock } from '../persistence/live-owner-lock'
import type { LiveCredentialOrigin, LiveCredentialOriginStore } from './live-credential-origin'

const SERVICE = 'org.freedesktop.secrets'
const SERVICE_PATH = '/org/freedesktop/secrets'
const SECRET = 'org.freedesktop.Secret'
const ALGORITHM = 'dh-ietf1024-sha256-aes128-cbc-pkcs7'
const MAX_KEY_BYTES = 64 * 1024
const attributes = (reference: CredentialReference) => ({
  application: 'cmux-linux-alternative',
  kind: 'openssh-private-key-v1',
  'credential-reference': reference.locator
})
const unavailable = () =>
  new CredentialError(
    'credential_provider_unavailable',
    'Trusted credential provider is unavailable'
  )
const required = () =>
  new CredentialError('credential_required', 'An unlocked credential is required')
const revoked = () =>
  new CredentialError('credential_revoked', 'Credential is ambiguous or invalid')

/** A committed v2 target can never fall back to its former Rust v1 wallet item. */
export function activeCredentialReference(
  targetId: string,
  scopeId: string,
  origin?: LiveCredentialOrigin
): CredentialReference {
  if (origin === 'v1_eligible') return CredentialReference.forTarget(targetId)
  if (origin === undefined || origin === 'v2_committed')
    return CredentialReference.forIsolatedTarget(targetId, scopeId)
  throw required()
}

/** SearchItems returns separate unlocked and locked paths. Any locked or duplicate result denies use. */
export function exactCredentialMatch(
  unlocked: unknown,
  locked: unknown,
  allowMissing = false
): string | undefined {
  if (
    !Array.isArray(unlocked) ||
    !Array.isArray(locked) ||
    !unlocked.every((p) => typeof p === 'string') ||
    !locked.every((p) => typeof p === 'string')
  )
    throw unavailable()
  if (locked.length > 0) throw required()
  if (unlocked.length === 0) {
    if (allowMissing) return undefined
    throw required()
  }
  if (unlocked.length !== 1) throw revoked()
  return unlocked[0]
}

export type ExactCredentialPresence = 'present' | 'missing' | 'locked' | 'duplicate'

/** Classify an exact SearchItems result without opening a session or reading a secret. */
export function exactCredentialPresence(
  unlocked: unknown,
  locked: unknown
): ExactCredentialPresence {
  if (
    !Array.isArray(unlocked) ||
    !Array.isArray(locked) ||
    !unlocked.every((path) => typeof path === 'string') ||
    !locked.every((path) => typeof path === 'string')
  )
    throw unavailable()
  if (locked.length > 0) return 'locked'
  if (unlocked.length > 1) return 'duplicate'
  return unlocked.length === 1 ? 'present' : 'missing'
}

/** Read-only exact locator inventory for a fenced cutover preflight. */
export async function probeExactCredentialPresence(
  reference: CredentialReference
): Promise<ExactCredentialPresence> {
  if (process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS) throw unavailable()
  const bus = dbus.sessionBus()
  bus.on('error', () => undefined)
  try {
    await ensureSecretService(bus)
    const service = (await bus.getProxyObject(SERVICE, SERVICE_PATH)).getInterface(
      `${SECRET}.Service`
    )
    const [unlocked, locked] = (await service.SearchItems!(attributes(reference))) as [
      string[],
      string[]
    ]
    return exactCredentialPresence(unlocked, locked)
  } catch (error) {
    if (error instanceof CredentialError) throw error
    throw unavailable()
  } finally {
    bus.disconnect()
  }
}

type Bus = ReturnType<typeof dbus.sessionBus>
class SecretSession {
  private constructor(
    private readonly bus: Bus,
    private readonly path: string,
    private readonly key: Buffer
  ) {}

  public static async open(bus: Bus): Promise<SecretSession> {
    const dh = getDiffieHellman('modp2')
    dh.generateKeys()
    const service = (await bus.getProxyObject(SERVICE, SERVICE_PATH)).getInterface(
      `${SECRET}.Service`
    )
    const [output, sessionPath] = (await service.OpenSession!(
      ALGORITHM,
      new dbus.Variant('ay', dh.getPublicKey())
    )) as [dbus.Variant, string]
    if (!sessionPath || sessionPath === '/' || output.signature !== 'ay') throw unavailable()
    const peer = Buffer.from(output.value as Uint8Array)
    if (peer.length < 1 || peer.length > 128) throw unavailable()
    const shared = dh.computeSecret(peer)
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 16))
    shared.fill(0)
    return new SecretSession(bus, sessionPath, key)
  }

  public async close(): Promise<void> {
    this.key.fill(0)
    try {
      await (await this.bus.getProxyObject(SERVICE, this.path)).getInterface(`${SECRET}.Session`)
        .Close!()
    } catch {
      /* The D-Bus connection is disconnected by the caller. */
    }
  }

  public async get(itemPath: string): Promise<Buffer> {
    const item = (await this.bus.getProxyObject(SERVICE, itemPath)).getInterface(`${SECRET}.Item`)
    const value = (await item.GetSecret!(this.path)) as unknown
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== this.path ||
      typeof value[3] !== 'string'
    )
      throw revoked()
    const iv = Buffer.from(value[1] as Uint8Array)
    const ciphertext = Buffer.from(value[2] as Uint8Array)
    if (
      iv.length !== 16 ||
      ciphertext.length === 0 ||
      ciphertext.length > MAX_KEY_BYTES + 16 ||
      ciphertext.length % 16 !== 0
    )
      throw revoked()
    try {
      const decipher = createDecipheriv('aes-128-cbc', this.key, iv)
      const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (secret.length === 0 || secret.length > MAX_KEY_BYTES) {
        secret.fill(0)
        throw revoked()
      }
      return secret
    } catch {
      throw revoked()
    }
  }

  public encode(secret: Buffer): [string, Buffer, Buffer, string] {
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-128-cbc', this.key, iv)
    return [
      this.path,
      iv,
      Buffer.concat([cipher.update(secret), cipher.final()]),
      'application/x-openssh-private-key'
    ]
  }
}

async function withService<T>(run: (bus: Bus, session: SecretSession) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS) throw unavailable()
  const bus = dbus.sessionBus()
  bus.on('error', () => undefined)
  let session: SecretSession | undefined
  try {
    await ensureSecretService(bus)
    session = await SecretSession.open(bus)
    return await run(bus, session)
  } catch (error) {
    if (error instanceof CredentialError) throw error
    throw unavailable()
  } finally {
    await session?.close()
    bus.disconnect()
  }
}

async function search(
  bus: Bus,
  reference: CredentialReference,
  allowMissing = false
): Promise<string | undefined> {
  const service = (await bus.getProxyObject(SERVICE, SERVICE_PATH)).getInterface(
    `${SECRET}.Service`
  )
  const [unlocked, locked] = (await service.SearchItems!(attributes(reference))) as [
    string[],
    string[]
  ]
  return exactCredentialMatch(unlocked, locked, allowMissing)
}

async function storeExact(
  bus: Bus,
  session: SecretSession,
  reference: CredentialReference,
  secret: Buffer,
  replaceExisting = true
): Promise<void> {
  const expected = parseEd25519Credential(secret).getPublicSSH()
  const service = (await bus.getProxyObject(SERVICE, SERVICE_PATH)).getInterface(
    `${SECRET}.Service`
  )
  const collectionPath = (await service.ReadAlias!('default')) as string
  if (!collectionPath || collectionPath === '/') throw required()
  const collection = await bus.getProxyObject(SERVICE, collectionPath)
  const locked = (await collection.getInterface('org.freedesktop.DBus.Properties').Get!(
    `${SECRET}.Collection`,
    'Locked'
  )) as dbus.Variant
  if (locked.value !== false) throw required()
  const existing = await search(bus, reference, true)
  if (!replaceExisting && existing) throw revoked()
  const properties = {
    [`${SECRET}.Item.Label`]: new dbus.Variant('s', 'cmux remote SSH credential'),
    [`${SECRET}.Item.Attributes`]: new dbus.Variant('a{ss}', attributes(reference))
  }
  const [item, prompt] = (await collection.getInterface(`${SECRET}.Collection`).CreateItem!(
    properties,
    session.encode(secret),
    replaceExisting
  )) as [string, string]
  if (!item || item === '/' || prompt !== '/') throw unavailable()
  if ((await search(bus, reference)) !== item) throw revoked()
  const stored = await session.get(item)
  try {
    if (!parseEd25519Credential(stored).getPublicSSH().equals(expected)) throw revoked()
  } finally {
    stored.fill(0)
  }
}

/** Explicit provider; application default remains Unavailable until a real login-session proof. */
export class SecretServiceCredentialProvider implements CredentialProvider {
  private constructor(
    private readonly brokerRoot: string,
    private readonly scope: IsolatedCredentialScope,
    private readonly liveOrigins?: Pick<
      LiveCredentialOriginStore,
      'read' | 'readFencedDeletionOrigin'
    >,
    private readonly liveOwner?: Pick<
      LiveOwnerLock,
      'assertDatabasePath' | 'assertDatabaseUnchanged'
    >
  ) {}

  public static async create(
    brokerRoot: string,
    scope: IsolatedCredentialScope
  ): Promise<SecretServiceCredentialProvider> {
    await prepareBrokerRoot(brokerRoot)
    return new SecretServiceCredentialProvider(brokerRoot, scope)
  }

  /** Explicit live owner policy; the isolated-copy constructor never reads Rust v1 items. */
  public static async createLive(
    brokerRoot: string,
    databasePath: string,
    origins: Pick<LiveCredentialOriginStore, 'read' | 'readFencedDeletionOrigin'>,
    owner: Pick<LiveOwnerLock, 'assertDatabasePath' | 'assertDatabaseUnchanged'>
  ): Promise<SecretServiceCredentialProvider> {
    owner.assertDatabasePath(databasePath)
    const scope = IsolatedCredentialScope.loadOrCreate(databasePath)
    await prepareBrokerRoot(brokerRoot)
    return new SecretServiceCredentialProvider(brokerRoot, scope, origins, owner)
  }

  private activeReference(targetId: string): CredentialReference {
    return activeCredentialReference(targetId, this.scope.id, this.liveOrigins?.read(targetId))
  }

  public validateInheritedFd(fd: number): void {
    assertInheritedCredentialReadOnly(fd)
  }

  public async acquire(
    reference: CredentialReference,
    targetId: string,
    generation: number,
    hostPublicKey: string
  ): Promise<CredentialBrokerLease> {
    if (
      reference.targetId !== targetId.toLowerCase() ||
      !Number.isSafeInteger(generation) ||
      generation <= 0
    )
      throw revoked()
    const scopedReference = this.activeReference(targetId)
    const secret = await withService(async (bus, session) => {
      const item = await search(bus, scopedReference)
      if (!item) throw required()
      const bytes = await session.get(item)
      // A change in lookup cardinality while fetching invalidates this attempt.
      if (
        (await search(bus, scopedReference)) !== item ||
        this.activeReference(targetId).locator !== scopedReference.locator
      ) {
        bytes.fill(0)
        throw revoked()
      }
      return bytes
    })
    try {
      return await CredentialBrokerLease.fromSigningBroker(
        this.brokerRoot,
        targetId,
        generation,
        secret,
        hostPublicKey
      )
    } finally {
      secret.fill(0)
    }
  }

  public async enrollFromInheritedFd(targetId: string, fd: number): Promise<void> {
    const reference = CredentialReference.forIsolatedTarget(targetId, this.scope.id)
    const secret = readInheritedCredentialFd(fd)
    try {
      await withService((bus, session) => storeExact(bus, session, reference, secret))
    } finally {
      secret.fill(0)
    }
  }

  /** New live identities must never replace an item created after their presence check. */
  public async enrollNewFromInheritedFd(targetId: string, fd: number): Promise<void> {
    const reference = CredentialReference.forIsolatedTarget(targetId, this.scope.id)
    const secret = readInheritedCredentialFd(fd)
    try {
      await withService((bus, session) => storeExact(bus, session, reference, secret, false))
    } finally {
      secret.fill(0)
    }
  }

  /** A replacement's old key is stored under the exact isolated enrollment ID. */
  public async backupForReplacement(targetId: string, enrollmentId: string): Promise<void> {
    const active = CredentialReference.forIsolatedTarget(targetId, this.scope.id)
    const backup = CredentialReference.forIsolatedTarget(enrollmentId, this.scope.id)
    await withService(async (bus, session) => {
      if (await search(bus, backup, true)) throw revoked()
      const activeItem = await search(bus, active)
      if (!activeItem) throw required()
      const secret = await session.get(activeItem)
      try {
        if ((await search(bus, active)) !== activeItem) throw revoked()
        await storeExact(bus, session, backup, secret)
      } finally {
        secret.fill(0)
      }
    })
  }

  /** Returns false only when no backup exists; callers retain the durable intent until safe. */
  public async restoreReplacement(targetId: string, enrollmentId: string): Promise<boolean> {
    const active = CredentialReference.forIsolatedTarget(targetId, this.scope.id)
    const backup = CredentialReference.forIsolatedTarget(enrollmentId, this.scope.id)
    return withService(async (bus, session) => {
      const backupItem = await search(bus, backup, true)
      if (!backupItem) return false
      const secret = await session.get(backupItem)
      try {
        if ((await search(bus, backup)) !== backupItem) throw revoked()
        await storeExact(bus, session, active, secret)
        return true
      } finally {
        secret.fill(0)
      }
    })
  }

  public async delete(targetId: string): Promise<void> {
    const reference = CredentialReference.forIsolatedTarget(targetId, this.scope.id)
    await this.deleteExact(reference)
  }

  /** Called only after a durable target-deletion fence. Live provenance selects
   * the exact inherited v1 or isolated v2 item; an unknown origin fails closed. */
  public async deleteFencedTarget(targetId: string): Promise<void> {
    this.liveOwner?.assertDatabaseUnchanged()
    const reference = this.liveOrigins
      ? activeCredentialReference(
          targetId,
          this.scope.id,
          this.liveOrigins.readFencedDeletionOrigin(targetId)
        )
      : CredentialReference.forIsolatedTarget(targetId, this.scope.id)
    await this.deleteExact(reference)
  }

  private async deleteExact(reference: CredentialReference): Promise<void> {
    await withService(async (bus) => {
      const item = await search(bus, reference, true)
      if (!item) return
      const prompt = (await (await bus.getProxyObject(SERVICE, item)).getInterface(`${SECRET}.Item`)
        .Delete!()) as string
      if (prompt !== '/') throw unavailable()
    })
  }

  /** Presence proof for an exact isolated item; no key bytes leave Secret Service. */
  public async has(targetId: string): Promise<boolean> {
    const reference = CredentialReference.forIsolatedTarget(targetId, this.scope.id)
    return withService(async (bus) => (await search(bus, reference, true)) !== undefined)
  }

  /** Presence only: replacement never copies or removes the live v1 item. */
  public async hasV1(targetId: string): Promise<boolean> {
    const reference = CredentialReference.forTarget(targetId)
    // The isolated-copy provider must never search the shared Rust v1 wallet.
    if (this.liveOrigins?.read(reference.targetId) !== 'v1_eligible') throw required()
    return withService(async (bus) => (await search(bus, reference, true)) !== undefined)
  }

  /** Presence-only Rust credential inventory while the live writer fence is held. */
  public async probeRustCredentialForCutover(targetId: string): Promise<boolean> {
    this.liveOwner?.assertDatabaseUnchanged()
    const reference = CredentialReference.forTarget(targetId)
    if (!this.liveOwner || this.liveOrigins?.read(reference.targetId) !== 'unmarked') {
      throw required()
    }
    return withService(async (bus) => (await search(bus, reference, true)) !== undefined)
  }
}
