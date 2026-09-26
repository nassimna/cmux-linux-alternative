import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync, closeSync, chmodSync } from 'node:fs'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'

import { ACTIVE_LOG_FILENAME, verifyDirectory } from './diagnostic-service'
import { redact } from './redact'

const MAX_RECORD_BYTES = 64 * 1024
const MAX_ACTIVE_BYTES = 4 * 1024 * 1024
const RETAINED_FILES = 5
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ROTATED = /^diagnostics\.(\d{6})\.jsonl$/u

function ensurePrivateDirectory(directory: string): void {
  if (!isAbsolute(directory) || directory.split(sep).includes('..')) throw new Error('Unsafe diagnostics directory')
  const absolute = resolve(directory)
  let current = parse(absolute).root
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe diagnostics directory')
  }
  chmodSync(absolute, 0o700)
  verifyDirectory(absolute)
}

function openPrivateLog(path: string): number {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  const stat = fstatSync(fd)
  const pathname = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.ino !== pathname.ino || pathname.isSymbolicLink()) {
    closeSync(fd)
    throw new Error('Unsafe diagnostics file')
  }
  return fd
}

/** Bounded private JSONL sink for ServiceLogger's existing fixed-event lines. */
export class RotatingDiagnosticLog {
  private fd: number
  private bytes: number

  constructor(private readonly directory: string) {
    ensurePrivateDirectory(directory)
    this.fd = openPrivateLog(join(directory, ACTIVE_LOG_FILENAME))
    this.bytes = fstatSync(this.fd).size
    if (this.bytes > MAX_ACTIVE_BYTES) this.rotate()
    this.prune()
  }

  writeLine(line: string): void {
    const report = redact({ kind: 'service', message: line.trimEnd() })
    let encoded = Buffer.from(JSON.stringify(report.value))
    if (encoded.length > MAX_RECORD_BYTES) encoded = Buffer.from(JSON.stringify({ recordTruncated: true, originalSerializedBytes: encoded.length }))
    if (this.bytes > 0 && this.bytes + encoded.length + 1 > MAX_ACTIVE_BYTES) this.rotate()
    const output = Buffer.concat([encoded, Buffer.from('\n')])
    let offset = 0
    while (offset < output.length) offset += writeSync(this.fd, output, offset)
    this.bytes += output.length
  }

  close(): void { closeSync(this.fd) }

  private rotate(): void {
    closeSync(this.fd)
    const active = join(this.directory, ACTIVE_LOG_FILENAME)
    const existing = readdirSync(this.directory).flatMap((name) => {
      const match = ROTATED.exec(name)
      return match ? [Number(match[1])] : []
    })
    const sequence = Math.max(0, ...existing) + 1
    if (sequence > 999999) throw new Error('Diagnostic rotation namespace exhausted')
    const target = join(this.directory, `diagnostics.${String(sequence).padStart(6, '0')}.jsonl`)
    if (existsSync(target)) throw new Error('Diagnostic rotation target already exists')
    renameSync(active, target)
    this.fd = openPrivateLog(active)
    this.bytes = 0
    this.prune()
  }

  private prune(): void {
    const files = readdirSync(this.directory).flatMap((name) => {
      if (!ROTATED.test(name)) return []
      const path = join(this.directory, name)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) return []
      return [{ path, name, modified: stat.mtimeMs }]
    }).sort((a, b) => b.name.localeCompare(a.name))
    for (const [index, file] of files.entries()) {
      if (index >= RETAINED_FILES || Date.now() - file.modified > RETENTION_MS) unlinkSync(file.path)
    }
  }
}
