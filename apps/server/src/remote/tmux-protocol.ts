export const MAX_TMUX_DISCOVERY_ROWS = 128
export const MAX_TMUX_DISCOVERY_BYTES = 64 * 1024

export class TmuxProtocolError extends Error {
  public constructor(
    public readonly code: 'invalid_target' | 'invalid_tmux_response' | 'unsupported_tmux'
  ) {
    super(code === 'unsupported_tmux' ? 'tmux 3.2 or newer is required' : code.replaceAll('_', ' '))
    this.name = 'TmuxProtocolError'
  }
}

export type TmuxOperation =
  | { kind: 'discoverVersion' }
  | { kind: 'discoverSessions' }
  | { kind: 'attach'; name: string }
  | { kind: 'create'; name: string }

export function validateTmuxName(name: string): void {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new TmuxProtocolError('invalid_target')
}

/** No caller-supplied shell fragment may reach the remote command. */
export function tmuxCommand(operation: TmuxOperation): string {
  switch (operation.kind) {
    case 'discoverVersion':
      return 'tmux -V'
    case 'discoverSessions':
      return "tmux list-sessions -F '#{session_name}'"
    case 'attach':
      validateTmuxName(operation.name)
      return `tmux attach-session -t ${operation.name}`
    case 'create':
      validateTmuxName(operation.name)
      return `tmux new-session -s ${operation.name}`
  }
}

/** Stock tmux reports a missing default socket differently across versions. */
export function isNoTmuxServerResponse(stderr: string): boolean {
  return (
    /^no server running on [^\r\n]+\r?\n?$/u.test(stderr) ||
    /^error connecting to \/tmp\/tmux-[0-9]+\/default \(No such file or directory\)\r?\n?$/u.test(stderr)
  )
}

function decode(output: Uint8Array, maxBytes: number): string {
  if (output.byteLength > maxBytes) throw new TmuxProtocolError('invalid_tmux_response')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(output)
  } catch {
    throw new TmuxProtocolError('invalid_tmux_response')
  }
}

export function parseTmuxVersion(output: Uint8Array): void {
  const value = decode(output, 128).trim()
  const match = /^tmux ([0-9]+)(?:\.([0-9]+))?[a-z]?$/.exec(value)
  if (!match) throw new TmuxProtocolError('invalid_tmux_response')
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor))
    throw new TmuxProtocolError('invalid_tmux_response')
  if (major < 3 || (major === 3 && minor < 2)) throw new TmuxProtocolError('unsupported_tmux')
}

export function parseTmuxSessions(output: Uint8Array): string[] {
  const value = decode(output, MAX_TMUX_DISCOVERY_BYTES)
  if (value === '') return []
  const rows = value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n')
  if (rows.length > MAX_TMUX_DISCOVERY_ROWS) throw new TmuxProtocolError('invalid_tmux_response')
  for (const row of rows) {
    try {
      validateTmuxName(row)
    } catch {
      throw new TmuxProtocolError('invalid_tmux_response')
    }
  }
  return rows
}
