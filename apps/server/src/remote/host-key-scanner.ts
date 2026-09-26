import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MAX_SCAN_BYTES = 8 * 1024
const ALGORITHM = 'ssh-ed25519'
const ALGORITHM_BYTES = Buffer.from(ALGORITHM, 'ascii')

export interface HostKeyDescriptor {
  canonicalHost: string
  port: number
  algorithm: typeof ALGORITHM
  publicKey: string
  fingerprint: string
}

export class HostKeyScanError extends Error {
  public constructor(
    public readonly code: 'invalid_target' | 'host_key_mismatch' | 'scan_unavailable',
    message: string
  ) {
    super(message)
    this.name = 'HostKeyScanError'
  }
}

function validateTarget(host: string, port: number): void {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    host.length === 0 ||
    host.length > 253 ||
    host.startsWith('-') ||
    host !== host.toLowerCase() ||
    /[\s\p{Cc}]/u.test(host)
  ) {
    throw new HostKeyScanError('invalid_target', 'Invalid canonical SSH target')
  }
}

function hostPattern(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

function keyBlob(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new HostKeyScanError('host_key_mismatch', 'Malformed Ed25519 host key')
  }
  const blob = Buffer.from(encoded, 'base64')
  if (
    blob.length !== 51 ||
    blob.toString('base64') !== encoded ||
    blob.readUInt32BE(0) !== ALGORITHM_BYTES.length ||
    !blob.subarray(4, 4 + ALGORITHM_BYTES.length).equals(ALGORITHM_BYTES) ||
    blob.readUInt32BE(15) !== 32
  ) {
    throw new HostKeyScanError('host_key_mismatch', 'Malformed Ed25519 host key')
  }
  return blob
}

/** Parse exactly the normalized Ed25519 record that can be shown in a trust prompt. */
export function parseHostKeyScan(
  output: Buffer,
  canonicalHost: string,
  port: number
): HostKeyDescriptor {
  validateTarget(canonicalHost, port)
  if (output.length > MAX_SCAN_BYTES) {
    throw new HostKeyScanError('host_key_mismatch', 'Host-key scan exceeded its size limit')
  }
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(output)
  } catch {
    throw new HostKeyScanError('host_key_mismatch', 'Host-key scan was not UTF-8')
  }
  const rows = value
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'))
  if (rows.length !== 1) {
    throw new HostKeyScanError('host_key_mismatch', 'Host-key scan must contain one record')
  }
  if (
    Array.from(rows[0]!).some(
      (character) => character.codePointAt(0)! > 127 && character.trim() === ''
    )
  ) {
    throw new HostKeyScanError('host_key_mismatch', 'Host-key scan used a non-ASCII separator')
  }
  const fields = rows[0]!.trim().split(/\s+/u)
  if (
    fields.length !== 3 ||
    fields[0] !== hostPattern(canonicalHost, port) ||
    fields[1] !== ALGORITHM
  ) {
    throw new HostKeyScanError('host_key_mismatch', 'Host-key scan did not match the target')
  }
  const blob = keyBlob(fields[2]!)
  return {
    canonicalHost,
    port,
    algorithm: ALGORITHM,
    publicKey: fields[2]!,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`
  }
}

export function knownHostsLine(descriptor: HostKeyDescriptor): string {
  return `${hostPattern(descriptor.canonicalHost, descriptor.port)} ${descriptor.algorithm} ${descriptor.publicKey}\n`
}

/** The executable argument is internal; production obtains it only from resolveSystem(). */
export async function scanWithExecutable(
  executable: string,
  canonicalHost: string,
  port: number
): Promise<HostKeyDescriptor> {
  validateTarget(canonicalHost, port)
  const output = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      executable,
      ['-T', '5', '-p', String(port), '-t', 'ed25519', canonicalHost],
      {
        encoding: 'buffer',
        env: {},
        maxBuffer: MAX_SCAN_BYTES,
        timeout: 7000,
        killSignal: 'SIGKILL',
        windowsHide: true
      },
      (error, stdout) => {
        if (error || !Buffer.isBuffer(stdout)) {
          reject(new HostKeyScanError('scan_unavailable', 'Host-key scan failed'))
        } else {
          resolve(stdout)
        }
      }
    )
  })
  return parseHostKeyScan(output, canonicalHost, port)
}

export class SystemHostKeyScanner {
  private constructor(private readonly executable: string) {}

  public static async resolveSystem(): Promise<SystemHostKeyScanner> {
    if (process.platform !== 'linux') {
      throw new HostKeyScanError('scan_unavailable', 'Linux host-key scanner is unavailable')
    }
    for (const root of ['/usr/bin', '/bin']) {
      try {
        const executable = await realpath(join(root, 'ssh-keyscan'))
        const [file, parent] = await Promise.all([stat(executable), stat(dirname(executable))])
        if (
          file.isFile() &&
          file.uid === 0 &&
          file.nlink === 1 &&
          (file.mode & 0o111) !== 0 &&
          (file.mode & 0o022) === 0 &&
          parent.isDirectory() &&
          parent.uid === 0 &&
          (parent.mode & 0o022) === 0
        ) {
          return new SystemHostKeyScanner(executable)
        }
      } catch {
        // Try the next fixed system path.
      }
    }
    throw new HostKeyScanError('scan_unavailable', 'Approved system ssh-keyscan is unavailable')
  }

  public scan(canonicalHost: string, port: number): Promise<HostKeyDescriptor> {
    return scanWithExecutable(this.executable, canonicalHost, port)
  }
}
