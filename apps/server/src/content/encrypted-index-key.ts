/* eslint-disable @typescript-eslint/no-unsafe-call -- dbus-next proxy methods are typed as Function. */
import {
  createCipheriv,
  createDecipheriv,
  getDiffieHellman,
  hkdfSync,
  randomBytes,
  randomUUID
} from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeSync,
  fsyncSync
} from 'node:fs'
import { isAbsolute, parse, resolve, sep } from 'node:path'
import dbus from 'dbus-next'
import { ensureSecretService } from '../secret-service/activation'

const SERVICE = 'org.freedesktop.secrets'
const SECRET = 'org.freedesktop.Secret'
const ALGORITHM = 'dh-ietf1024-sha256-aes128-cbc-pkcs7'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const attributes = (id: string) => ({
  application: 'cmux-linux-alternative',
  kind: 'content-index-key-v1',
  'key-id': id
})
export class IndexKeyError extends Error {
  constructor(
    public readonly code: 'unavailable' | 'unsafe_storage' | 'ambiguous' | 'invalid_secret'
  ) {
    super(`Content index key ${code}`)
    this.name = 'IndexKeyError'
  }
}
const keyError = (code: IndexKeyError['code']): never => {
  throw new IndexKeyError(code)
}

export interface IndexSecretStore {
  findExact(keyId: string): Promise<{ unlocked: Buffer[]; locked: number }>
  createExact(keyId: string, secret: Buffer): Promise<void>
}

function profileDirectory(profile: string): number {
  if (!isAbsolute(profile) || resolve(profile) !== profile) keyError('unsafe_storage')
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const part of profile.slice(parse(profile).root.length).split(sep).filter(Boolean)) {
      const next = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
      closeSync(fd)
      fd = next
    }
    const entry = fstatSync(fd)
    if (entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700)
      keyError('unsafe_storage')
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}
function locator(profile: string): string {
  const directory = profileDirectory(profile)
  try {
    return locatorAt(directory)
  } finally {
    closeSync(directory)
  }
}
function existingLocator(profile: string): string {
  const directory = profileDirectory(profile)
  try {
    const fd = openSync(
      `/proc/self/fd/${directory}/content-index-key-id`,
      constants.O_RDONLY | constants.O_NOFOLLOW
    )
    try {
      const entry = fstatSync(fd)
      if (
        !entry.isFile() ||
        entry.uid !== process.getuid?.() ||
        (entry.mode & 0o777) !== 0o600 ||
        entry.nlink !== 1 ||
        entry.size > 64
      )
        keyError('unsafe_storage')
      const value = readFileSync(fd, 'utf8').replace(/\n$/, '')
      if (!UUID.test(value)) keyError('unsafe_storage')
      return value
    } finally {
      closeSync(fd)
    }
  } finally {
    closeSync(directory)
  }
}
function locatorAt(directory: number): string {
  const path = `/proc/self/fd/${directory}/content-index-key-id`
  let fd: number
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return keyError('unsafe_storage')
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      return keyError('unsafe_storage')
    }
    try {
      const entry = fstatSync(fd)
      if (
        !entry.isFile() ||
        entry.uid !== process.getuid?.() ||
        (entry.mode & 0o777) !== 0o600 ||
        entry.nlink !== 1 ||
        entry.size > 64
      )
        keyError('unsafe_storage')
      const value = readFileSync(fd, 'utf8').replace(/\n$/, '')
      if (!UUID.test(value)) keyError('unsafe_storage')
      return value
    } finally {
      closeSync(fd)
    }
  }
  try {
    const id = randomUUID()
    writeSync(fd, `${id}\n`)
    fsyncSync(fd)
    fsyncSync(directory)
    const entry = fstatSync(fd)
    if (
      !entry.isFile() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o777) !== 0o600 ||
      entry.nlink !== 1 ||
      entry.size > 64
    )
      keyError('unsafe_storage')
    return id
  } finally {
    closeSync(fd)
  }
}

/** Never unlock an item or collection. Duplicate or locked matches deny the entire index. */
export async function loadOrCreateIndexKey(
  profile: string,
  store: IndexSecretStore = new SecretServiceIndexSecretStore()
): Promise<Buffer> {
  if (process.platform !== 'linux') keyError('unavailable')
  const id = locator(profile)
  let found = await store.findExact(id)
  try {
    if (found.locked || found.unlocked.length > 1) keyError('ambiguous')
    if (found.unlocked.length === 1) {
      if (found.unlocked[0]!.length !== 32) keyError('invalid_secret')
      return Buffer.from(found.unlocked[0]!)
    }
  } finally {
    found.unlocked.forEach((secret) => secret.fill(0))
  }
  const generated = randomBytes(32)
  try {
    await store.createExact(id, generated)
  } finally {
    generated.fill(0)
  }
  found = await store.findExact(id)
  try {
    if (found.locked || found.unlocked.length !== 1) keyError('ambiguous')
    if (found.unlocked[0]!.length !== 32) keyError('invalid_secret')
    return Buffer.from(found.unlocked[0]!)
  } finally {
    found.unlocked.forEach((secret) => secret.fill(0))
  }
}

/** Read an existing live key without creating a locator or Secret Service item. */
export async function loadExistingIndexKey(
  profile: string,
  store: IndexSecretStore = new SecretServiceIndexSecretStore()
): Promise<Buffer> {
  if (process.platform !== 'linux') keyError('unavailable')
  let id: string
  try {
    id = existingLocator(profile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') keyError('unavailable')
    throw error
  }
  const found = await store.findExact(id)
  try {
    if (found.locked || found.unlocked.length > 1) keyError('ambiguous')
    if (found.unlocked.length === 0) keyError('unavailable')
    if (found.unlocked[0]!.length !== 32) keyError('invalid_secret')
    return Buffer.from(found.unlocked[0]!)
  } finally {
    found.unlocked.forEach((secret) => secret.fill(0))
  }
}

type Bus = ReturnType<typeof dbus.sessionBus>
class SecretSession {
  private constructor(
    private bus: Bus,
    readonly path: string,
    private key: Buffer
  ) {}
  static async open(bus: Bus): Promise<SecretSession> {
    const dh = getDiffieHellman('modp2')
    dh.generateKeys()
    const service = (await bus.getProxyObject(SERVICE, '/org/freedesktop/secrets')).getInterface(
      `${SECRET}.Service`
    )
    const [output, path] = (await service.OpenSession!(
      ALGORITHM,
      new dbus.Variant('ay', dh.getPublicKey())
    )) as [dbus.Variant, string]
    if (!path || path === '/' || output.signature !== 'ay') keyError('unavailable')
    const peer = Buffer.from(output.value as Uint8Array)
    if (peer.length < 1 || peer.length > 128) keyError('unavailable')
    const shared = dh.computeSecret(peer)
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 16))
    shared.fill(0)
    return new SecretSession(bus, path, key)
  }
  async close(): Promise<void> {
    this.key.fill(0)
    try {
      await (await this.bus.getProxyObject(SERVICE, this.path)).getInterface(`${SECRET}.Session`)
        .Close!()
    } catch {
      /* disconnected or unavailable */
    }
  }
  async get(path: string): Promise<Buffer> {
    const item = (await this.bus.getProxyObject(SERVICE, path)).getInterface(`${SECRET}.Item`)
    const value = (await item.GetSecret!(this.path)) as unknown
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== this.path ||
      value[3] !== 'application/octet-stream'
    )
      keyError('invalid_secret')
    const fields = value as [string, Uint8Array, Uint8Array, string]
    const iv = Buffer.from(fields[1])
    const ciphertext = Buffer.from(fields[2])
    if (iv.length !== 16 || !ciphertext.length || ciphertext.length > 48 || ciphertext.length % 16)
      keyError('invalid_secret')
    try {
      const cipher = createDecipheriv('aes-128-cbc', this.key, iv)
      return Buffer.concat([cipher.update(ciphertext), cipher.final()])
    } catch {
      return keyError('invalid_secret')
    }
  }
  encode(secret: Buffer): [string, Buffer, Buffer, string] {
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-128-cbc', this.key, iv)
    return [
      this.path,
      iv,
      Buffer.concat([cipher.update(secret), cipher.final()]),
      'application/octet-stream'
    ]
  }
}
async function withService<T>(run: (bus: Bus, session: SecretSession) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS) keyError('unavailable')
  const bus = dbus.sessionBus()
  // dbus-next may emit a late transport error after disconnect during a failed handshake.
  bus.on('error', () => undefined)
  let session: SecretSession | undefined
  try {
    await ensureSecretService(bus)
    session = await SecretSession.open(bus)
    return await run(bus, session)
  } catch (error) {
    if (error instanceof IndexKeyError) throw error
    return keyError('unavailable')
  } finally {
    await session?.close()
    bus.disconnect()
  }
}
async function search(bus: Bus, id: string): Promise<{ unlocked: string[]; locked: string[] }> {
  const service = (await bus.getProxyObject(SERVICE, '/org/freedesktop/secrets')).getInterface(
    `${SECRET}.Service`
  )
  const [unlocked, locked] = (await service.SearchItems!(attributes(id))) as [string[], string[]]
  if (!Array.isArray(unlocked) || !Array.isArray(locked)) keyError('unavailable')
  return { unlocked, locked }
}
export class SecretServiceIndexSecretStore implements IndexSecretStore {
  async findExact(id: string): Promise<{ unlocked: Buffer[]; locked: number }> {
    return withService(async (bus, session) => {
      const found = await search(bus, id)
      const unlocked: Buffer[] = []
      try {
        for (const path of found.unlocked.slice(0, 2)) unlocked.push(await session.get(path))
        return { unlocked, locked: found.locked.length }
      } catch (error) {
        unlocked.forEach((secret) => secret.fill(0))
        throw error
      }
    })
  }
  async createExact(id: string, secret: Buffer): Promise<void> {
    await withService(async (bus, session) => {
      const service = (await bus.getProxyObject(SERVICE, '/org/freedesktop/secrets')).getInterface(
        `${SECRET}.Service`
      )
      const collectionPath = (await service.ReadAlias!('default')) as string
      if (!collectionPath || collectionPath === '/') keyError('unavailable')
      const collection = await bus.getProxyObject(SERVICE, collectionPath)
      const locked = (await collection.getInterface('org.freedesktop.DBus.Properties').Get!(
        `${SECRET}.Collection`,
        'Locked'
      )) as dbus.Variant
      if (locked.value !== false) keyError('unavailable')
      const properties = {
        [`${SECRET}.Item.Label`]: new dbus.Variant('s', 'Agent Workspace content index key'),
        [`${SECRET}.Item.Attributes`]: new dbus.Variant('a{ss}', attributes(id))
      }
      const [item, prompt] = (await collection.getInterface(`${SECRET}.Collection`).CreateItem!(
        properties,
        session.encode(secret),
        false
      )) as [string, string]
      if (!item || item === '/' || prompt !== '/') keyError('unavailable')
    })
  }
}
