import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

import { diagnosticBundlePreviewSchema } from '@agent-workspace/protocol-client'

import { redact } from './redact'

export const ACTIVE_LOG_FILENAME = 'diagnostics.jsonl'
const MAX_LOG_TAIL_BYTES = 64 * 1024
const MAX_BUNDLE_BYTES = 512 * 1024
const FORMAT = 'agent-workspace-diagnostic-bundle-v1'

export interface DiagnosticBundlePreview {
  entries: { name: string; bytes: number }[]
  totalBytes: number
  redactionCount: number
  createdAt: number
}

export interface DiagnosticServiceOptions {
  logDirectory: string
  application: string
  version: string
  platform: string
  recovery:
    | 'healthy'
    | 'migrationRequired'
    | 'futureSchema'
    | 'corruptStorage'
    | 'invalidState'
    | 'unavailable'
  /** Only createSafeConfigurationSummary's fields are retained. */
  configurationSummary: Record<string, unknown>
}

function fail(message: string): never {
  throw new Error(message)
}

/** Reject traversal and symlinks in every existing path component. */
export function verifyDirectory(directory: string, ownerOnly = true): void {
  if (!isAbsolute(directory) || directory.split(sep).includes('..'))
    fail('Unsafe diagnostics directory')
  const absolute = resolve(directory)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Unsafe diagnostics directory')
  }
  if (ownerOnly && (lstatSync(absolute).mode & 0o077) !== 0)
    fail('Diagnostics directory is not owner-only')
}

function verifyPrivateLogFile(path: string): { device: number; inode: number } {
  const before = lstatSync(path)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0
  )
    fail('Unsafe diagnostics file')
  return { device: before.dev, inode: before.ino }
}

function readLogTail(directory: string): { bytes: Buffer; clipped: boolean } | undefined {
  verifyDirectory(directory)
  const path = join(directory, ACTIVE_LOG_FILENAME)
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    fail('Unsafe diagnostics file')
  }
  try {
    const identity = verifyPrivateLogFile(path)
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.ino !== identity.inode ||
      stat.dev !== identity.device
    )
      fail('Unsafe diagnostics file')
    const length = Math.min(stat.size, MAX_LOG_TAIL_BYTES)
    const bytes = Buffer.alloc(length)
    const count = readSync(fd, bytes, 0, length, stat.size - length)
    return { bytes: bytes.subarray(0, count), clipped: stat.size > MAX_LOG_TAIL_BYTES }
  } finally {
    closeSync(fd)
  }
}

/** Only fields explicitly named by the Rust diagnostic summary are retained. */
export function createSafeConfigurationSummary(
  config: Record<string, unknown>
): Record<string, unknown> {
  const section = (name: string): Record<string, unknown> => {
    const value = config[name]
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
  const select = (name: string, keys: string[]): Record<string, unknown> =>
    Object.fromEntries(keys.map((key) => [key, section(name)[key] ?? null]))
  const terminal = section('terminal')
  const shortcuts = section('keyboardShortcuts').overrides
  return {
    schemaVersion: config.schemaVersion ?? null,
    revision: config.revision ?? null,
    appearance: select('appearance', ['theme', 'density', 'fontFamily']),
    terminal: {
      ...select('terminal', ['fontSize', 'scrollback', 'multilinePasteProtection']),
      hasCustomShell:
        typeof terminal.hasCustomShell === 'boolean'
          ? terminal.hasCustomShell
          : terminal.shellPath !== null && terminal.shellPath !== undefined
    },
    browser: select('browser', ['privacy']),
    notifications: select('notifications', ['systemEnabled', 'includeBody']),
    keyboardShortcuts: {
      overrideCount: shortcuts && typeof shortcuts === 'object' ? Object.keys(shortcuts).length : 0
    },
    agentIntegration: select('agentIntegration', [
      'enabled',
      'notificationsEnabled',
      'browserEnabled'
    ]),
    updates: select('updates', ['channel']),
    logging: select('logging', ['level'])
  }
}

interface Entry {
  content: unknown
  redactions: number
  truncations: number
}

function logRecords(bytes: Buffer, clipped: boolean): Entry {
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  if (clipped) lines.shift() // The first record may be partial.
  const recordsInTail = lines.filter(Boolean)
  const retained = recordsInTail.slice(-128)
  const records: unknown[] = []
  let redactions = 0
  let truncations = clipped || recordsInTail.length > retained.length ? 1 : 0
  if (clipped) records.push({ recordTruncated: true })
  for (const line of retained) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      record = {
        message: [...line]
          .map((character) => {
            const code = character.charCodeAt(0)
            return code < 32 && code !== 9 && code !== 10 && code !== 13 ? '\ufffd' : character
          })
          .join('')
      }
    }
    const report = redact(record)
    records.push(report.value)
    redactions += report.redactions
    truncations += report.truncations
  }
  return { content: records, redactions, truncations }
}

/** One service instance holds at most one approval; export consumes it even on failure. */
export class DiagnosticService {
  private approval: { preview: DiagnosticBundlePreview; bytes: Buffer } | undefined

  constructor(private readonly options: DiagnosticServiceOptions) {}

  preview(): DiagnosticBundlePreview {
    this.approval = undefined
    const prepared = this.prepare()
    const preview = diagnosticBundlePreviewSchema.parse({
      entries: prepared.entries,
      totalBytes: prepared.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      redactionCount: prepared.redactionCount,
      createdAt: Date.now()
    })
    this.approval = { preview, bytes: Buffer.from(prepared.bytes) }
    return structuredClone(preview)
  }

  export(
    destination: string,
    approvedPreview: DiagnosticBundlePreview
  ): { path: string; bytes: number } {
    const approval = this.approval
    this.approval = undefined
    if (!approval) fail('A diagnostic preview must be approved before export')
    const candidate = diagnosticBundlePreviewSchema.parse(approvedPreview)
    if (JSON.stringify(candidate) !== JSON.stringify(approval.preview))
      fail('Diagnostic preview does not match')
    if (!isAbsolute(destination) || destination.split(sep).includes('..'))
      fail('Unsafe diagnostic destination')
    const name = parse(destination).base
    if (name === '.' || name === '..' || !/^[A-Za-z0-9._-]{1,128}$/u.test(name))
      fail('Unsafe diagnostic destination')
    verifyDirectory(dirname(destination), false)
    const temp = join(dirname(destination), `.diagnostic-export-${randomUUID()}.tmp`)
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
        fail('Unsafe diagnostic destination')
      let written = 0
      while (written < approval.bytes.length) written += writeSync(fd, approval.bytes, written)
      fsyncSync(fd)
      try {
        linkSync(temp, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          fail('Diagnostic export destination already exists')
        throw error
      }
      return { path: destination, bytes: approval.bytes.length }
    } finally {
      closeSync(fd)
      unlinkSync(temp)
    }
  }

  private prepare(): {
    bytes: Buffer
    entries: { name: string; bytes: number }[]
    redactionCount: number
  } {
    const source = this.options
    const wrap = (value: unknown): Entry => {
      const report = redact(value)
      return {
        content: report.value,
        redactions: report.redactions,
        truncations: report.truncations
      }
    }
    const values: Record<string, Entry> = {
      'metadata.json': wrap({
        application: source.application,
        version: source.version,
        platform: source.platform
      }),
      'recovery.json': wrap({ classification: source.recovery }),
      'configuration-summary.json': wrap(
        createSafeConfigurationSummary(source.configurationSummary)
      )
    }
    const tail = readLogTail(source.logDirectory)
    if (tail) values['logs/service.json'] = logRecords(tail.bytes, tail.clipped)
    const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
    const manifestEntries = entries.map(([name, entry]) => ({
      name,
      bytes: Buffer.byteLength(JSON.stringify(entry.content)),
      redactions: entry.redactions,
      truncations: entry.truncations
    }))
    const manifest = {
      entries: manifestEntries,
      totalEntryBytes: manifestEntries.reduce((sum, entry) => sum + entry.bytes, 0),
      totalRedactions: manifestEntries.reduce((sum, entry) => sum + entry.redactions, 0),
      totalTruncations: manifestEntries.reduce((sum, entry) => sum + entry.truncations, 0)
    }
    const document = {
      format: FORMAT,
      manifest,
      entries: Object.fromEntries(entries.map(([name, entry]) => [name, entry.content]))
    }
    const bytes = Buffer.from(JSON.stringify(document))
    if (bytes.length > MAX_BUNDLE_BYTES) fail('Diagnostic bundle exceeds size limit')
    return {
      bytes,
      entries: manifestEntries.map(({ name, bytes }) => ({ name, bytes })),
      redactionCount: manifest.totalRedactions
    }
  }
}
