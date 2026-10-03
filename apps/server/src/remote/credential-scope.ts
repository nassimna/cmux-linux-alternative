import { randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { CredentialError } from './credential-provider'

interface ScopeRecord {
  version: 1
  workingIdentity: string
  scopeId: string
}

const invalidScope = () =>
  new CredentialError('credential_provider_unavailable', 'Isolated credential scope is unavailable')

function workingIdentity(path: string): string {
  if (process.platform !== 'linux' || !process.getuid || !isAbsolute(path) || resolve(path) !== path) {
    throw invalidScope()
  }
  try {
    const file = lstatSync(path)
    const parent = lstatSync(dirname(path))
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
        file.uid !== process.getuid() || (file.mode & 0o077) !== 0 ||
        !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() ||
        (parent.mode & 0o077) !== 0 || realpathSync(path) !== path ||
        realpathSync(dirname(path)) !== dirname(path)) throw invalidScope()
    return `${file.dev}:${file.ino}`
  } catch {
    throw invalidScope()
  }
}

function scopePath(working: string): string {
  return `${working}.remote-credential-scope.json`
}

/** The scope is bound to the exact isolated database inode and never copied from Rust state. */
export class IsolatedCredentialScope {
  private constructor(public readonly id: string) {}

  public static load(working: string): IsolatedCredentialScope {
    const identity = workingIdentity(working)
    const path = scopePath(working)
    let fd: number | undefined
    try {
      const file = lstatSync(path)
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
          file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || file.size > 256) {
        throw invalidScope()
      }
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = fstatSync(fd)
      if (opened.dev !== file.dev || opened.ino !== file.ino || opened.size > 256) throw invalidScope()
      const record = JSON.parse(readFileSync(fd, 'utf8')) as ScopeRecord
      if (record.version !== 1 || record.workingIdentity !== identity ||
          typeof record.scopeId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(record.scopeId)) {
        throw invalidScope()
      }
      return new IsolatedCredentialScope(record.scopeId)
    } catch {
      throw invalidScope()
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  /** Only the isolated-copy owner creates a scope; enrollment utilities must load it. */
  public static loadOrCreate(working: string): IsolatedCredentialScope {
    const identity = workingIdentity(working)
    const path = scopePath(working)
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.load(working)
      throw invalidScope()
    }
    try {
      const record: ScopeRecord = { version: 1, workingIdentity: identity, scopeId: randomUUID() }
      writeSync(fd, JSON.stringify(record))
      fsyncSync(fd)
      const directoryFd = openSync(dirname(working), constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        fsyncSync(directoryFd)
      } finally {
        closeSync(directoryFd)
      }
      return new IsolatedCredentialScope(record.scopeId)
    } catch {
      throw invalidScope()
    } finally {
      closeSync(fd)
    }
  }
}
