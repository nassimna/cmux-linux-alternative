import { closeSync, fstatSync, readFileSync, readSync } from 'node:fs'

import { CredentialError } from './credential-provider'

const CREDENTIAL_FD = 3
const MAX_KEY_BYTES = 64 * 1024
let consumed = false

const invalid = () => new CredentialError('credential_revoked', 'Credential descriptor is invalid')

/** Reject a writable inherited descriptor before reserving a durable enrollment. */
export function assertInheritedCredentialReadOnly(fd: number): void {
  if (process.platform !== 'linux' || !process.getuid || fd !== CREDENTIAL_FD || consumed) throw invalid()
  try {
    const info = readFileSync('/proc/self/fdinfo/3', 'utf8')
    const match = /^flags:[ \t]*([0-7]+)[ \t]*$/m.exec(info)
    if (!match || (Number.parseInt(match[1]!, 8) & 0o3) !== 0) throw invalid()
  } catch {
    consumed = true
    try { closeSync(CREDENTIAL_FD) } catch { /* A rejected descriptor may already be closed. */ }
    throw invalid()
  }
}

/** Consume the one read-only descriptor inherited by a dedicated credential utility. */
export function readInheritedCredentialFd(fd: number): Buffer {
  assertInheritedCredentialReadOnly(fd)
  consumed = true
  let secret: Buffer | undefined
  try {
    const uid = process.getuid?.()
    const before = fstatSync(CREDENTIAL_FD)
    if (uid === undefined || !before.isFile() || before.uid !== uid || before.nlink !== 1 ||
        (before.mode & 0o077) !== 0 || before.size === 0 || before.size > MAX_KEY_BYTES) throw invalid()
    secret = Buffer.alloc(before.size)
    let offset = 0
    while (offset < secret.length) {
      const bytesRead = readSync(CREDENTIAL_FD, secret, offset, secret.length - offset, null)
      if (bytesRead === 0) throw invalid()
      offset += bytesRead
    }
    const extra = Buffer.alloc(1)
    try {
      if (readSync(CREDENTIAL_FD, extra, 0, 1, null) !== 0) throw invalid()
    } finally {
      extra.fill(0)
    }
    const after = fstatSync(CREDENTIAL_FD)
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw invalid()
    const result = secret
    secret = undefined
    return result
  } catch {
    throw invalid()
  } finally {
    secret?.fill(0)
    try { closeSync(CREDENTIAL_FD) } catch { /* A rejected descriptor may already be closed. */ }
  }
}
