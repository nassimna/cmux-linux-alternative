import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { DiagnosticBundlePreview } from '@agent-workspace/protocol-client'

import {
  DiagnosticService,
  createSafeConfigurationSummary,
  verifyDirectory
} from '../../../server/src/diagnostics/diagnostic-service'

export interface NodeCopyDiagnosticsPaths {
  sourcePath: string
  backupPath: string
  workingPath: string
  liveDatabasePath: string
  liveLogDirectory: string
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix))
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function copyManifestMatches(
  source: string,
  backup: string,
  working: string,
  backupFile: Stats,
  workingFile: Stats
): boolean {
  const path = `${working}.copy-manifest.json`
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const marker = fstatSync(fd)
    const pathname = lstatSync(path)
    if (
      !sameFile(marker, pathname) ||
      !marker.isFile() ||
      marker.nlink !== 1 ||
      marker.uid !== process.getuid?.() ||
      (marker.mode & 0o077) !== 0 ||
      marker.size > 4096
    ) {
      throw new Error('Node diagnostics copy manifest is unsafe')
    }
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 7 ||
      !('version' in value) ||
      value.version !== 1 ||
      !('source' in value) ||
      value.source !== source ||
      !('backup' in value) ||
      value.backup !== backup ||
      !('working' in value) ||
      value.working !== working ||
      !('workingIdentity' in value) ||
      value.workingIdentity !== `${workingFile.dev}:${workingFile.ino}` ||
      !('backupIdentity' in value) ||
      value.backupIdentity !== `${backupFile.dev}:${backupFile.ino}` ||
      !('backupSha256' in value) ||
      typeof value.backupSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.backupSha256)
    ) {
      throw new Error('Node diagnostics copy manifest does not match')
    }
    return true
  } finally {
    closeSync(fd)
  }
}

/** Main-process diagnostics for a stopped Node copy. Never consults the live Rust log path. */
export class NodeCopyDiagnostics {
  private pending: DiagnosticService | undefined

  constructor(private readonly paths: NodeCopyDiagnosticsPaths) {}

  preview(): DiagnosticBundlePreview {
    this.pending = undefined
    const logDirectory = this.qualifiedLogDirectory()
    const rootBefore = lstatSync(dirname(logDirectory))
    const logsBefore = lstatSync(logDirectory)
    const service = new DiagnosticService({
      logDirectory,
      application: 'agent-workspace',
      version: '0.1.0',
      platform: process.platform,
      recovery: 'unavailable',
      configurationSummary: createSafeConfigurationSummary({})
    })
    const preview = service.preview()
    if (
      !sameFile(rootBefore, lstatSync(dirname(logDirectory))) ||
      !sameFile(logsBefore, lstatSync(logDirectory))
    ) {
      throw new Error('Node diagnostics copy directory changed during preview')
    }
    this.qualifiedLogDirectory()
    this.pending = service
    return preview
  }

  export(
    destination: string,
    approvedPreview: DiagnosticBundlePreview
  ): {
    path: string
    bytes: number
  } {
    const pending = this.pending
    this.pending = undefined
    if (!pending) throw new Error('A diagnostic preview must be approved before export')
    return pending.export(destination, approvedPreview)
  }

  private qualifiedLogDirectory(): string {
    const { sourcePath, backupPath, workingPath, liveDatabasePath, liveLogDirectory } = this.paths
    if (
      [sourcePath, backupPath, workingPath, liveDatabasePath, liveLogDirectory].some(
        (path) => !isAbsolute(path)
      )
    ) {
      throw new Error('Node diagnostics require absolute isolated copy paths')
    }
    const source = realpathSync(sourcePath)
    const backup = resolve(backupPath)
    const working = resolve(workingPath)
    const liveDatabase = realpathSync(liveDatabasePath)
    const sourceFile = lstatSync(sourcePath)
    const liveFile = lstatSync(liveDatabasePath)
    const workingRoot = dirname(working)
    const logDirectory = join(workingRoot, 'logs')
    const liveLogs = resolve(liveLogDirectory)
    if (
      source !== resolve(sourcePath) ||
      sameFile(sourceFile, liveFile) ||
      source === working ||
      backup === working ||
      backup === source ||
      source === liveDatabase ||
      contains(liveLogs, logDirectory) ||
      contains(logDirectory, liveLogs) ||
      contains(dirname(liveDatabase), workingRoot) ||
      contains(workingRoot, dirname(liveDatabase))
    ) {
      throw new Error('Node diagnostics require a separate isolated copy')
    }
    verifyDirectory(workingRoot)
    const root = lstatSync(workingRoot)
    if (root.uid !== process.getuid?.() || realpathSync(workingRoot) !== workingRoot) {
      throw new Error('Node diagnostics require an owned canonical copy directory')
    }
    let workingFile: Stats | undefined
    try {
      workingFile = lstatSync(working)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (
      workingFile &&
      (!workingFile.isFile() ||
        workingFile.isSymbolicLink() ||
        workingFile.nlink !== 1 ||
        workingFile.uid !== process.getuid?.() ||
        (workingFile.mode & 0o077) !== 0)
    ) {
      throw new Error('Node diagnostics working copy is unsafe')
    }
    if (workingFile && sameFile(workingFile, liveFile)) {
      throw new Error('Node diagnostics working copy aliases live state')
    }
    try {
      lstatSync(logDirectory)
      verifyDirectory(logDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let activeLog: Stats | undefined
    try {
      activeLog = lstatSync(join(logDirectory, 'diagnostics.jsonl'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (activeLog) {
      const backupFile = lstatSync(backup)
      if (
        !backupFile.isFile() ||
        backupFile.isSymbolicLink() ||
        backupFile.nlink !== 1 ||
        backupFile.uid !== process.getuid?.() ||
        (backupFile.mode & 0o077) !== 0 ||
        sameFile(backupFile, sourceFile) ||
        sameFile(backupFile, liveFile) ||
        !workingFile ||
        !copyManifestMatches(source, backup, working, backupFile, workingFile)
      ) {
        throw new Error('Node diagnostics log has no qualified isolated copy')
      }
    }
    try {
      mkdirSync(logDirectory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    verifyDirectory(logDirectory)
    const logs = lstatSync(logDirectory)
    if (logs.uid !== process.getuid?.()) {
      throw new Error('Node diagnostics log directory is not owned by this user')
    }
    return logDirectory
  }
}
