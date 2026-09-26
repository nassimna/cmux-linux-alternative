import { readFile, readdir, readlink } from 'node:fs/promises'

const MAX_LISTENING_PORTS = 16

/** Discover TCP listeners owned by a PTY process or one of its descendants. */
export async function linuxListeningPorts(rootPid: number): Promise<number[]> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(rootPid) || rootPid <= 0) return []
  const processes = await processTree(rootPid)
  if (!processes.length) return []

  const ports = new Set<number>()
  for (const pid of processes) {
    const [descriptors, tcp, tcp6] = await Promise.all([
      readdir(`/proc/${pid}/fd`).catch(() => []),
      readFile(`/proc/${pid}/net/tcp`, 'utf8').catch(() => ''),
      readFile(`/proc/${pid}/net/tcp6`, 'utf8').catch(() => '')
    ])
    const listeners = new Map([...parseTcpListeners(tcp), ...parseTcpListeners(tcp6)])
    if (!listeners.size) continue
    for (const descriptor of descriptors) {
      const target = await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => '')
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
      const port = inode ? listeners.get(inode) : undefined
      if (port) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b).slice(0, MAX_LISTENING_PORTS)
}

async function processTree(rootPid: number): Promise<number[]> {
  const entries = await readdir('/proc').catch(() => [])
  const relations = new Map<number, number>()
  for (let offset = 0; offset < entries.length; offset += 128) {
    await Promise.all(
      entries.slice(offset, offset + 128).map(async (name) => {
        if (!/^\d+$/.test(name)) return
        const pid = Number(name)
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
        const afterCommand = stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)
        const parent = Number(afterCommand[1])
        if (Number.isSafeInteger(parent)) relations.set(pid, parent)
      })
    )
  }
  if (!relations.has(rootPid)) return []
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parent] of relations) {
      if (descendants.has(parent) && !descendants.has(pid)) {
        descendants.add(pid)
        changed = true
      }
    }
  }
  return [...descendants]
}

function parseTcpListeners(table: string): Array<[string, number]> {
  const result: Array<[string, number]> = []
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== '0A') continue
    const port = Number.parseInt(fields[1]!.split(':').at(-1) ?? '', 16)
    if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\d+$/.test(fields[9]!)) {
      result.push([fields[9]!, port])
    }
  }
  return result
}
