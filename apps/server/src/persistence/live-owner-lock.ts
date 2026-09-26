import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** Linux flock contract shared with the Rust service for the live state database. */
export class LiveOwnerLock {
  private closed = false

  private constructor(
    private readonly transferFd: number,
    private readonly ownerFd: number,
    private readonly databasePath: string,
    private readonly databaseDevice: number,
    private readonly databaseInode: number
  ) {}

  static acquire(databasePath: string): LiveOwnerLock {
    if (process.platform !== 'linux' || !process.getuid || !isAbsolute(databasePath)) {
      throw new Error('Live ownership requires an absolute Linux state path')
    }
    if (resolve(databasePath) !== databasePath) {
      throw new Error('Live state path must be canonical')
    }
    const directory = dirname(databasePath)
    const parent = lstatSync(directory)
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid() ||
      (parent.mode & 0o777) !== 0o700 ||
      realpathSync(directory) !== directory
    ) {
      throw new Error('Live state directory must be private and canonical')
    }
    const database = lstatSync(databasePath)
    if (
      !database.isFile() ||
      database.isSymbolicLink() ||
      database.nlink !== 1 ||
      database.uid !== process.getuid() ||
      (database.mode & 0o777) !== 0o600 ||
      realpathSync(databasePath) !== databasePath
    ) {
      throw new Error('Live state database must be a private canonical regular file')
    }
    const transferFd = acquireFence(`${databasePath}.writer-transfer.lock`, 'writer transfer')
    try {
      const ownerFd = acquireFence(`${databasePath}.live-owner.lock`, 'live owner')
      try {
        const lock = new LiveOwnerLock(
          transferFd,
          ownerFd,
          databasePath,
          database.dev,
          database.ino
        )
        lock.assertDatabaseUnchanged()
        return lock
      } catch (error) {
        closeSync(ownerFd)
        throw error
      }
    } catch (error) {
      closeSync(transferFd)
      throw error
    }
  }

  /** Call immediately before opening the live database under this fence. */
  assertDatabaseUnchanged(): void {
    if (this.closed) throw new Error('Live owner lock is closed')
    const database = lstatSync(this.databasePath)
    if (
      !database.isFile() ||
      database.isSymbolicLink() ||
      database.nlink !== 1 ||
      database.uid !== process.getuid!() ||
      (database.mode & 0o777) !== 0o600 ||
      database.dev !== this.databaseDevice ||
      database.ino !== this.databaseInode
    ) {
      throw new Error('Live state database changed while acquiring ownership')
    }
  }

  assertDatabasePath(path: string): void {
    if (path !== this.databasePath) throw new Error('Live owner lock belongs to another database')
    this.assertDatabaseUnchanged()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.ownerFd)
    closeSync(this.transferFd)
  }
}

function acquireFence(path: string, name: string): number {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const opened = fstatSync(fd)
    const named = lstatSync(path)
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.uid !== process.getuid?.() ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    ) {
      throw new Error(`${name} lock file is unsafe`)
    }
    // flock locks the shared open-file description passed as descriptor 3. The
    // lock survives the short helper process and remains held by this fd.
    const result = spawnSync('/usr/bin/flock', ['-n', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
      timeout: 5_000
    })
    if (result.status !== 0) {
      throw new Error(`Live state is already owned or the ${name} fence is unavailable`)
    }
    const current = lstatSync(path)
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`${name} lock path changed during acquisition`)
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}
