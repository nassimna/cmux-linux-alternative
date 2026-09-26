const MAX_HOOK_INPUT_BYTES = 64 * 1024

export interface HookNotice {
  title: string
  body?: string
}

function field(value: unknown, names: string[]): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const name of names) {
    if (typeof record[name] === 'string') return record[name]
  }
  return undefined
}

function sanitize(value: string, max: number): string | undefined {
  const result = Array.from(value.trim())
    .filter((character) => !/\p{Cc}/u.test(character))
    .slice(0, max)
    .join('')
  return result || undefined
}

function parsePayload(raw: string): unknown {
  if (Buffer.byteLength(raw) > MAX_HOOK_INPUT_BYTES) {
    throw new Error('Hook input is missing, malformed, or exceeds its bound')
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('Hook input is missing, malformed, or exceeds its bound')
  }
}

export function parseCodexNotice(raw: string): HookNotice {
  const payload = parsePayload(raw)
  const title = sanitize(field(payload, ['type']) ?? 'Codex', 256) ?? 'Codex notification'
  const body = field(payload, ['last-assistant-message', 'last_assistant_message'])
  const sanitizedBody = body === undefined ? undefined : sanitize(body, 4096)
  return { title, ...(sanitizedBody === undefined ? {} : { body: sanitizedBody }) }
}

export function parseClaudeNotice(raw: string): HookNotice {
  const payload = parsePayload(raw)
  const title =
    sanitize(field(payload, ['title', 'notification_type']) ?? '', 256) ??
    'Claude Code notification'
  const body = field(payload, ['message'])
  const sanitizedBody = body === undefined ? undefined : sanitize(body, 4096)
  return { title, ...(sanitizedBody === undefined ? {} : { body: sanitizedBody }) }
}

export async function readClaudeHookInput(input: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > MAX_HOOK_INPUT_BYTES) {
      throw new Error('Hook input is missing, malformed, or exceeds its bound')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}
