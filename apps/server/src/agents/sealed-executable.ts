import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CodexLaunchPlan } from './codex-adapter'
import { CodexAdapterError } from './codex-adapter'

const requireNative = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

type Sealer = {
  capture(path: string, expectedSize: number): number
  verify(fd: number): boolean
}
function sealer(): Sealer {
  const path = here.endsWith('/dist')
    ? join(here, 'seal-executable.node')
    : join(here, '../../dist/seal-executable.node')
  return requireNative(path) as Sealer
}

export function sealedLaunchAvailable(): boolean {
  try {
    const native = sealer()
    return typeof native.capture === 'function' && typeof native.verify === 'function'
  } catch {
    return false
  }
}

/** The memfd remains open until node-pty has forked. Its write seals fix the exec inode. */
export async function withSealedExecutable<T>(
  plan: CodexLaunchPlan,
  launch: (command: readonly string[]) => Promise<T>
): Promise<T> {
  let fd: number
  try {
    fd = sealer().capture(plan.command[0], plan.executableIdentity.size)
  } catch {
    throw new CodexAdapterError('insecure_executable', 'Sealed executable capture failed')
  }
  try {
    if (!sealer().verify(fd)) {
      throw new CodexAdapterError('insecure_executable', 'Executable descriptor is not sealed')
    }
    const digest = createHash('sha256')
    const file = openSync(`/proc/self/fd/${fd}`, 'r')
    try {
      const buffer = Buffer.allocUnsafe(65536)
      for (;;) {
        const count = readSync(file, buffer, 0, buffer.length, null)
        if (count === 0) break
        digest.update(buffer.subarray(0, count))
      }
    } finally {
      closeSync(file)
    }
    if (digest.digest('hex') !== plan.executableIdentity.sha256) {
      throw new CodexAdapterError('insecure_executable', 'Sealed executable digest changed')
    }
    return await launch([`/proc/self/fd/${fd}`, ...plan.command.slice(1)])
  } finally {
    closeSync(fd)
  }
}
