import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { LiveOwnerLock } from './persistence/live-owner-lock'

interface RawRecoveryFile {
  path: string
  name: string
  size: bigint
  device: bigint
  inode: bigint
  modified: bigint
  changed: bigint
}

function validatePaths(sourcePath: string, destinationPath: string): void {
  if (
    !isAbsolute(sourcePath) ||
    !isAbsolute(destinationPath) ||
    resolve(sourcePath) !== sourcePath ||
    resolve(destinationPath) !== destinationPath ||
    [
      sourcePath,
      `${sourcePath}-wal`,
      `${sourcePath}-shm`,
      `${sourcePath}-journal`,
      `${sourcePath}.live-owner.lock`,
      `${sourcePath}.writer-transfer.lock`
    ].includes(destinationPath)
  ) {
    throw new Error('Recovery export requires distinct absolute paths')
  }
}

async function validateDestinationDirectory(destinationPath: string): Promise<string> {
  const directory = dirname(destinationPath)
  const parent = await lstat(directory)
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error('Recovery destination directory must be real')
  }
  return directory
}

async function publishTemporary(temporaryPath: string, destinationPath: string): Promise<number> {
  // Hard linking publishes only after all bytes are durable and never replaces a user file.
  await link(temporaryPath, destinationPath)
  await unlink(temporaryPath)
  const directory = dirname(destinationPath)
  const parent = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  )
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
  return (await stat(destinationPath)).size
}

async function exportDatabase(sourcePath: string, destinationPath: string) {
  validatePaths(sourcePath, destinationPath)
  const source = await lstat(sourcePath)
  if (!source.isFile() || source.isSymbolicLink() || source.uid !== process.getuid?.()) {
    throw new Error('Recovery source must be an owned regular file')
  }
  const directory = await validateDestinationDirectory(destinationPath)
  const temporaryPath = join(directory, `.${basename(destinationPath)}.${randomUUID()}.tmp`)
  const temporary = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600
  )
  await temporary.close()
  try {
    const database = new Database(sourcePath, { readonly: true, fileMustExist: true })
    try {
      database.pragma('query_only = ON')
      await database.backup(temporaryPath)
    } finally {
      database.close()
    }
    const exportDatabase = new Database(temporaryPath, { fileMustExist: true })
    try {
      exportDatabase.pragma('wal_checkpoint(TRUNCATE)')
      if (exportDatabase.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
        throw new Error('Recovery export could not leave WAL mode')
      }
      const integrity = exportDatabase.prepare('PRAGMA integrity_check(1)').get() as {
        integrity_check?: unknown
      }
      if (integrity.integrity_check !== 'ok') throw new Error('Recovery export is not integral')
    } finally {
      exportDatabase.close()
    }
    await chmod(temporaryPath, 0o600)
    const file = await open(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    return { path: destinationPath, bytes: await publishTemporary(temporaryPath, destinationPath) }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

async function inspectRawFile(path: string): Promise<RawRecoveryFile | undefined> {
  const file = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!file) return undefined
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1n ||
    file.uid !== BigInt(process.getuid!()) ||
    (file.mode & 0o777n) !== 0o600n
  ) {
    throw new Error('Recovery source files must be private owned regular files')
  }
  return {
    path,
    name: basename(path),
    size: file.size,
    device: file.dev,
    inode: file.ino,
    modified: file.mtimeNs,
    changed: file.ctimeNs
  }
}

function sameRawFile(
  left: RawRecoveryFile | undefined,
  right: RawRecoveryFile | undefined
): boolean {
  if (!left || !right) return left === right
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  )
}

async function writeAll(output: FileHandle, bytes: Buffer): Promise<void> {
  let written = 0
  while (written < bytes.length) {
    const result = await output.write(bytes, written, bytes.length - written, null)
    if (result.bytesWritten <= 0) throw new Error('Recovery archive write was incomplete')
    written += result.bytesWritten
  }
}

function writeOctal(header: Buffer, value: bigint, offset: number, length: number): void {
  const octal = value.toString(8)
  if (octal.length >= length) throw new Error('Recovery TAR header value is too large')
  header.write(`${octal.padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function tarHeader(name: string, size: bigint): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  if (nameBytes.length > 100) throw new Error('Recovery file name is too long for TAR')
  const header = Buffer.alloc(512)
  nameBytes.copy(header, 0)
  writeOctal(header, 0o600n, 100, 8)
  writeOctal(header, BigInt(process.getuid!()), 108, 8)
  writeOctal(header, BigInt(process.getgid!()), 116, 8)
  if (size.toString(8).length < 12) {
    writeOctal(header, size, 124, 12)
  } else {
    let remaining = size
    for (let offset = 135; offset >= 124; offset -= 1) {
      header[offset] = Number(remaining & 0xffn)
      remaining >>= 8n
    }
    if (remaining !== 0n) throw new Error('Recovery file is too large for TAR')
    header[124]! |= 0x80
  }
  writeOctal(header, BigInt(Math.floor(Date.now() / 1000)), 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeOctal(header, BigInt(checksum), 148, 7)
  header[155] = 0x20
  return header
}

async function writeRawTarFile(output: FileHandle, file: RawRecoveryFile): Promise<void> {
  await writeAll(output, tarHeader(file.name, file.size))
  const input = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await input.stat({ bigint: true })
    if (
      opened.dev !== file.device ||
      opened.ino !== file.inode ||
      opened.size !== file.size ||
      opened.mtimeNs !== file.modified ||
      opened.ctimeNs !== file.changed
    ) {
      throw new Error('Recovery source changed before export')
    }
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0n
    while (position < file.size) {
      const length = Number(
        file.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : file.size - position
      )
      const { bytesRead } = await input.read(buffer, 0, length, Number(position))
      if (bytesRead <= 0) throw new Error('Recovery source changed during export')
      await writeAll(output, buffer.subarray(0, bytesRead))
      position += BigInt(bytesRead)
    }
  } finally {
    await input.close()
  }
  const padding = Number((512n - (file.size % 512n)) % 512n)
  if (padding > 0) await writeAll(output, Buffer.alloc(padding))
}

async function exportRawRecovery(sourcePath: string, destinationPath: string) {
  validatePaths(sourcePath, destinationPath)
  const directory = await validateDestinationDirectory(destinationPath)
  // The native owner uses these fences. A raw copy must run only when no writer owns the state.
  const owner = LiveOwnerLock.acquire(sourcePath)
  const temporaryPath = join(directory, `.${basename(destinationPath)}.${randomUUID()}.tmp`)
  try {
    const paths = [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`, `${sourcePath}-journal`]
    const before = await Promise.all(paths.map(inspectRawFile))
    if (!before[0]) throw new Error('Recovery database is missing')
    const output = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    try {
      const note = Buffer.from(
        'Agent Workspace raw recovery files. The database may be corrupt. Keep the -wal file beside the database when attempting recovery.\n',
        'utf8'
      )
      await writeAll(output, tarHeader('RECOVERY.txt', BigInt(note.length)))
      await writeAll(output, note)
      await writeAll(output, Buffer.alloc(Number((512n - (BigInt(note.length) % 512n)) % 512n)))
      for (const file of before) if (file) await writeRawTarFile(output, file)
      const after = await Promise.all(paths.map(inspectRawFile))
      if (before.some((file, index) => !sameRawFile(file, after[index]))) {
        throw new Error('Recovery source changed during export')
      }
      await writeAll(output, Buffer.alloc(1024))
      await output.sync()
    } finally {
      await output.close()
    }
    return { path: destinationPath, bytes: await publishTemporary(temporaryPath, destinationPath) }
  } finally {
    owner.close()
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

const raw = process.argv[2] === '--raw'
if (process.argv.length !== (raw ? 5 : 4)) {
  throw new Error('Usage: recovery-export [--raw] SOURCE DESTINATION')
}
const source = process.argv[raw ? 3 : 2]!
const destination = process.argv[raw ? 4 : 3]!
process.stdout.write(
  `${JSON.stringify(await (raw ? exportRawRecovery(source, destination) : exportDatabase(source, destination)))}\n`
)
