import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync
} from 'node:fs'
import { mkdir, open, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const MARKER = '.agent-workspace-profile.json'
const MAX_MARKER_BYTES = 1024
const MAX_SESSION_ENTRIES = 10_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type Marker = {
  version: 1
  source: string
  working: string
  workingIdentity: string
}

type FileIdentity = Readonly<{ device: number; inode: number }>

export type PrivateCodexThreadRecord = Readonly<{
  threadId: string
  path: string
  device: number
  inode: number
}>

function fileIdentity(path: string): FileIdentity {
  const file = lstatSync(path)
  return { device: file.dev, inode: file.ino }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function ownPrivateDirectory(path: string): void {
  const file = lstatSync(path)
  if (
    !file.isDirectory() ||
    file.isSymbolicLink() ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  ) {
    throw new Error('Codex profile directory must be real, owner-only, and owned by this user')
  }
}

function workingIdentity(path: string): string {
  const file = lstatSync(path)
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  ) {
    throw new Error('Codex profile requires an owner-only isolated working database')
  }
  return `${file.dev}:${file.ino}`
}

function sameOrWithin(parent: string, child: string): boolean {
  const remainder = relative(parent, child)
  return (
    remainder === '' ||
    (remainder !== '..' && !remainder.startsWith('../') && !isAbsolute(remainder))
  )
}

function privateSessionDirectory(path: string): void {
  const file = lstatSync(path)
  if (
    !file.isDirectory() ||
    file.isSymbolicLink() ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o022) !== 0 ||
    realpathSync(path) !== path
  ) {
    throw new Error('Private Codex session directory is unsafe')
  }
}

function privateSessionFile(path: string): FileIdentity {
  const file = lstatSync(path)
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  ) {
    throw new Error('Private Codex session record is unsafe')
  }
  return { device: file.dev, inode: file.ino }
}

function readMarker(path: string): Marker {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const file = fstatSync(fd)
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      file.uid !== process.getuid?.() ||
      (file.mode & 0o077) !== 0 ||
      file.size > MAX_MARKER_BYTES
    ) {
      throw new Error('Codex profile ownership marker is unsafe')
    }
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      !('version' in value) ||
      value.version !== 1 ||
      !('source' in value) ||
      typeof value.source !== 'string' ||
      !('working' in value) ||
      typeof value.working !== 'string' ||
      !('workingIdentity' in value) ||
      typeof value.workingIdentity !== 'string'
    ) {
      throw new Error('Codex profile ownership marker is invalid')
    }
    return value as Marker
  } finally {
    closeSync(fd)
  }
}

/** A distinct Codex home owned by one isolated SQLite writer. No live data is imported. */
export class PrivateCodexProfile {
  private constructor(
    readonly home: string,
    private readonly marker: Marker,
    private readonly homeIdentity: FileIdentity,
    private readonly markerIdentity: FileIdentity
  ) {}

  static async prepare(
    sourceStatePath: string,
    workingStatePath: string,
    inheritedCodexHome: string | undefined
  ): Promise<PrivateCodexProfile> {
    if (!isAbsolute(sourceStatePath) || !isAbsolute(workingStatePath)) {
      throw new Error('Codex profile requires absolute source and working paths')
    }
    const source = await realpath(sourceStatePath)
    const working = await realpath(workingStatePath)
    const sourceRoot = dirname(source)
    const workingRoot = dirname(working)
    if (
      source !== resolve(sourceStatePath) ||
      working !== resolve(workingStatePath) ||
      sourceRoot === workingRoot
    ) {
      throw new Error('Codex profile requires separate canonical state profiles')
    }
    ownPrivateDirectory(workingRoot)
    const home = join(workingRoot, 'codex-profile')
    const inherited = resolve(inheritedCodexHome ?? join(homedir(), '.codex'))
    const liveHome = await realpath(inherited).catch(() => inherited)
    if (sameOrWithin(liveHome, home) || sameOrWithin(home, liveHome)) {
      throw new Error('Private Codex profile overlaps the inherited Codex home')
    }
    const marker: Marker = {
      version: 1,
      source,
      working,
      workingIdentity: workingIdentity(working)
    }
    await mkdir(home, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    ownPrivateDirectory(home)
    const markerPath = join(home, MARKER)
    let existing: Marker | undefined
    try {
      existing = readMarker(markerPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!existing) {
      if ((await readdir(home)).length !== 0) {
        throw new Error('Unmarked Codex profile already contains data')
      }
      const file = await open(
        markerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      try {
        await file.writeFile(JSON.stringify(marker))
        await file.sync()
      } finally {
        await file.close()
      }
      const directory = await open(home, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } else if (JSON.stringify(existing) !== JSON.stringify(marker)) {
      throw new Error('Codex profile belongs to another isolated working database')
    }
    const profile = new PrivateCodexProfile(
      home,
      marker,
      fileIdentity(home),
      fileIdentity(markerPath)
    )
    profile.assertCurrent()
    return profile
  }

  assertCurrent(): void {
    ownPrivateDirectory(dirname(this.home))
    ownPrivateDirectory(this.home)
    if (
      !sameFileIdentity(fileIdentity(this.home), this.homeIdentity) ||
      !sameFileIdentity(fileIdentity(join(this.home, MARKER)), this.markerIdentity) ||
      workingIdentity(this.marker.working) !== this.marker.workingIdentity ||
      JSON.stringify(readMarker(join(this.home, MARKER))) !== JSON.stringify(this.marker)
    ) {
      throw new Error('Private Codex profile authority changed')
    }
  }

  private threadRecordPath(threadId: string): string | undefined {
    this.assertCurrent()
    if (!UUID.test(threadId)) throw new Error('Invalid private Codex thread ID')
    const normalized = threadId.toLowerCase()
    const sessions = join(this.home, 'sessions')
    try {
      privateSessionDirectory(sessions)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let visited = 0
    let found: string | undefined
    const visit = (directory: string, depth: number): void => {
      for (const name of readdirSync(directory)) {
        if (++visited > MAX_SESSION_ENTRIES)
          throw new Error('Private Codex sessions exceed scan limit')
        const path = join(directory, name)
        if (depth < 3) {
          if (!new RegExp(depth === 0 ? '^\\d{4}$' : '^\\d{2}$', 'u').test(name)) continue
          privateSessionDirectory(path)
          visit(path, depth + 1)
        } else if (name.startsWith('rollout-') && name.endsWith(`-${normalized}.jsonl`)) {
          if (found) throw new Error('Private Codex thread has multiple records')
          found = path
        }
      }
    }
    visit(sessions, 0)
    this.assertCurrent()
    return found
  }

  /** Finds only an exact regular rollout record inside this independently owned home. */
  findThreadRecord(threadId: string): PrivateCodexThreadRecord | undefined {
    const path = this.threadRecordPath(threadId)
    if (!path) return undefined
    const identity = privateSessionFile(path)
    this.assertCurrent()
    return { threadId: threadId.toLowerCase(), path, ...identity }
  }

  /** Codex app-server can create a fork rollout as 0644; narrow that exact new file before use. */
  secureForkThreadRecord(threadId: string): PrivateCodexThreadRecord {
    const path = this.threadRecordPath(threadId)
    if (!path) throw new Error('Private Codex fork record is unavailable')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let identity: FileIdentity
    try {
      const file = fstatSync(fd)
      const named = lstatSync(path)
      if (
        !file.isFile() ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        file.nlink !== 1 ||
        file.uid !== process.getuid?.() ||
        file.dev !== named.dev ||
        file.ino !== named.ino ||
        realpathSync(path) !== path ||
        ![0o600, 0o644].includes(file.mode & 0o777)
      ) {
        throw new Error('Private Codex fork record is unsafe')
      }
      identity = { device: file.dev, inode: file.ino }
      if ((file.mode & 0o777) === 0o644) fchmodSync(fd, 0o600)
      const secured = fstatSync(fd)
      const current = lstatSync(path)
      if (
        !secured.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        secured.nlink !== 1 ||
        current.nlink !== 1 ||
        secured.uid !== process.getuid?.() ||
        current.uid !== process.getuid?.() ||
        identity.device !== secured.dev ||
        identity.inode !== secured.ino ||
        identity.device !== current.dev ||
        identity.inode !== current.ino ||
        (secured.mode & 0o777) !== 0o600 ||
        (current.mode & 0o777) !== 0o600 ||
        realpathSync(path) !== path
      ) {
        throw new Error('Private Codex fork record changed')
      }
    } finally {
      closeSync(fd)
    }
    const record = this.findThreadRecord(threadId)
    if (!record || !sameFileIdentity(record, identity)) {
      throw new Error('Private Codex fork record changed')
    }
    return record
  }

  assertThreadRecord(record: PrivateCodexThreadRecord): void {
    this.assertCurrent()
    if (!sameOrWithin(join(this.home, 'sessions'), record.path)) {
      throw new Error('Private Codex thread record left its profile')
    }
    const current = privateSessionFile(record.path)
    if (!sameFileIdentity(current, record)) {
      throw new Error('Private Codex thread record changed')
    }
  }
}
