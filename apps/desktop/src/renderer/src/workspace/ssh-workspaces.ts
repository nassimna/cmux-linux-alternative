/** Only connection coordinates are saved. OpenSSH handles keys, passwords and host trust. */
export interface SavedSshWorkspace {
  host: string
  user: string
  port: number
}

const STORAGE_KEY = 'agent-workspace.ssh-workspaces.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const HOST = /^(?!-)[a-z0-9][a-z0-9._:-]*$/iu
const USER = /^[a-z_][a-z0-9_.-]*$/iu

export function parseSshWorkspace(host: string, user: string, port: number): SavedSshWorkspace {
  const normalizedHost = host.trim()
  const normalizedUser = user.trim()
  if (!HOST.test(normalizedHost) || normalizedHost.length > 253) {
    throw new Error('Enter a valid SSH host or alias without spaces or options.')
  }
  if (normalizedUser && (!USER.test(normalizedUser) || normalizedUser.length > 64)) {
    throw new Error('Enter a valid SSH username, or leave it blank for your SSH config.')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH port must be between 1 and 65535.')
  }
  return { host: normalizedHost, user: normalizedUser, port }
}

export function sshCommand(profile: SavedSshWorkspace): string[] {
  const command = ['ssh']
  if (profile.port !== 22) command.push('-p', String(profile.port))
  command.push(profile.user ? `${profile.user}@${profile.host}` : profile.host)
  return command
}

export function readSshWorkspaces(): Record<string, SavedSshWorkspace> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const result: Record<string, SavedSshWorkspace> = {}
    for (const [id, candidate] of Object.entries(value)) {
      if (!UUID.test(id) || typeof candidate !== 'object' || candidate === null) continue
      const fields = candidate as Record<string, unknown>
      if (typeof fields.host !== 'string' || typeof fields.user !== 'string') continue
      try {
        result[id] = parseSshWorkspace(fields.host, fields.user, Number(fields.port))
      } catch {
        // Ignore a damaged entry while retaining valid saved workspaces.
      }
    }
    return result
  } catch {
    return {}
  }
}

export function saveSshWorkspaces(workspaces: Record<string, SavedSshWorkspace>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces))
}
