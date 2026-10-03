#!/usr/bin/env node
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { CredentialError } from './credential-provider'
import { RemoteCredentialEnrollmentError } from './remote-credential-enrollment-service'
import {
  CredentialEnrollmentUtilityError,
  runCredentialEnrollment,
  runLiveCredentialNew,
  runLiveCredentialReplacement,
  runLiveCredentialV1Replacement,
  runNativeCredentialReplacement,
  runNativeCredentialWrite,
  runOnlineCredentialWrite,
  runOnlineCredentialReplacement
} from './credential-enroll-utility'

function requestFile(path: string): unknown {
  if (!isAbsolute(path) || resolve(path) !== path || !process.getuid) {
    throw new CredentialEnrollmentUtilityError('invalid_request')
  }
  let fd: number | undefined
  try {
    const before = lstatSync(path)
    const parent = lstatSync(dirname(path))
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== process.getuid() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > 4096 ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid() ||
      (parent.mode & 0o077) !== 0 ||
      realpathSync(path) !== path ||
      realpathSync(dirname(path)) !== dirname(path)
    ) {
      throw new Error('unsafe request file')
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('request file changed')
    }
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown
  } catch {
    throw new CredentialEnrollmentUtilityError('invalid_request')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== '--request-file') {
    throw new CredentialEnrollmentUtilityError('invalid_request')
  }
  const request = requestFile(process.argv[3]!)
  const result = request && typeof request === 'object' && 'version' in request
    ? request.version === 8
      ? await runNativeCredentialReplacement(request)
      : request.version === 7
      ? await runNativeCredentialWrite(request)
      : request.version === 6
      ? await runLiveCredentialNew(request)
      : request.version === 5
      ? await runLiveCredentialReplacement(request)
      : request.version === 4
      ? await runLiveCredentialV1Replacement(request)
      : request.version === 3
        ? await runOnlineCredentialReplacement(request)
        : request.version === 2
          ? await runOnlineCredentialWrite(request)
          : await runCredentialEnrollment(request)
    : await runCredentialEnrollment(request)
  // The credential FD and Secret Service socket are closed before this point. End this
  // dedicated child explicitly: Node 22 can abort while polling a closed inherited FD.
  writeSync(1, `${JSON.stringify(result)}\n`)
  process.exit(0)
}

void main().catch((error: unknown) => {
  const code =
    error instanceof CredentialEnrollmentUtilityError ||
    error instanceof RemoteCredentialEnrollmentError ||
    error instanceof CredentialError
      ? error.code
      : 'enrollment_unavailable'
  writeSync(1, `${JSON.stringify({ status: 'error', code })}\n`)
  process.exit(1)
})
