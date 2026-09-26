import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, open, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import Database from 'better-sqlite3'

import { inspectLegacyDatabase, type LegacyDatabaseReport } from './legacy-inspection'

export interface LegacyBackupReport {
  path: string
  database: LegacyDatabaseReport
}

/**
 * Creates a private, verified SQLite backup at a new path. This does not grant
 * Node ownership of the source database or alter the live service's state.
 */
export async function backupLegacyDatabase(
  sourcePath: string,
  destinationPath: string
): Promise<LegacyBackupReport> {
  const source = await lstat(sourcePath)
  if (!source.isFile() || source.isSymbolicLink()) {
    throw new Error('State database must be a regular file, not a symbolic link')
  }
  inspectLegacyDatabase(sourcePath)

  const directory = dirname(destinationPath)
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error('Backup directory must be a private, real directory')
  }
  const temporaryPath = join(directory, `.${basename(destinationPath)}.${randomUUID()}.tmp`)
  const temporary = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600
  )
  await temporary.close()

  try {
    const database = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000
    })
    try {
      database.pragma('query_only = ON')
      await database.backup(temporaryPath)
    } finally {
      database.close()
    }

    // A SQLite backup can inherit WAL mode. Make the published backup a single
    // immutable file so its pinned digest covers every committed page.
    const compacted = new Database(temporaryPath, { fileMustExist: true })
    try {
      compacted.pragma('wal_checkpoint(TRUNCATE)')
      if (compacted.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
        throw new Error('Backup could not leave WAL mode')
      }
    } finally {
      compacted.close()
    }

    await chmod(temporaryPath, 0o600)
    const verified = new Database(temporaryPath, { readonly: true, fileMustExist: true })
    try {
      const result = verified.prepare('PRAGMA integrity_check(1)').get() as {
        integrity_check?: unknown
      }
      if (result.integrity_check !== 'ok') {
        throw new Error('Backup failed SQLite integrity check')
      }
    } finally {
      verified.close()
    }
    const report = inspectLegacyDatabase(temporaryPath)
    const file = await open(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    // link() fails if the destination appeared while the backup was running.
    // Unlike rename(), it cannot silently replace an existing user backup.
    await link(temporaryPath, destinationPath)
    await unlink(temporaryPath)
    const parent = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
    return { path: destinationPath, database: report }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}
