import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** lsof's process selection is intersected with TCP listeners, including IPv6. */
export async function macosListeningPorts(rootPid: number): Promise<number[]> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return []
  const { stdout: tree } = await execute('/bin/ps', ['-axo', 'pid=,ppid='], {
    timeout: 2_000,
    maxBuffer: 1024 * 1024
  }).catch(() => ({ stdout: '' }))
  const relations = tree
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  if (!relations.some(([pid]) => pid === rootPid)) return []
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parent] of relations) {
      if (pid && parent && descendants.has(parent) && !descendants.has(pid)) {
        descendants.add(pid)
        changed = true
      }
    }
  }
  const { stdout } = await execute(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', [...descendants].join(','), '-iTCP', '-sTCP:LISTEN', '-Fn'],
    { timeout: 2_000, maxBuffer: 1024 * 1024 }
  ).catch(() => ({ stdout: '' }))
  const ports = new Set<number>()
  for (const line of stdout.split('\n')) {
    const match = /^n.*:(\d+)$/.exec(line)
    const port = match ? Number(match[1]) : 0
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b).slice(0, 16)
}
