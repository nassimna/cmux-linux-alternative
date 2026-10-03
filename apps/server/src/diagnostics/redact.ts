const REDACTED = '[REDACTED]'
const TRUNCATED = '[TRUNCATED]'
const SENSITIVE = /token|auth|password|passwd|secret|cookie|session|credential|apikey|accesskey|privatekey|controlkey|terminalcontent|terminaloutput|content|output|checkpoint|body|snapshot|clisession|environment|^env$/i
const ASSIGNMENT = /\b(authorization|password|passwd|secret|token|cookie|session|credential|api_key|apikey|control_key|controlkey)\s*[:=]\s*([^\s,;&"']+)/gi
const BEARER = /\b(bearer\s+)([^\s,;&"']+)/gi
const URLS = /\b(?:https?|wss?):\/\/[^\s"'<>()[\]{}]+/gi

export interface RedactionReport {
  value: unknown
  redactions: number
  truncations: number
}

/** Bounds and sanitizes JSON values before either disk logging or export. */
export function redact(value: unknown): RedactionReport {
  let redactions = 0
  let truncations = 0
  let nodes = 4096
  const seen = new WeakSet<object>()

  const visit = (input: unknown, depth: number): unknown => {
    if (nodes-- <= 0 || depth > 16) {
      truncations++
      return TRUNCATED
    }
    if (input === null || typeof input === 'number' || typeof input === 'boolean') return input
    if (typeof input === 'string') {
      let bounded = input
      if (Buffer.byteLength(bounded) > 4096) {
        bounded = Buffer.from(bounded).subarray(0, 4096).toString('utf8').replace(/\ufffd$/u, '')
        truncations++
      }
      let changed = false
      let sanitized = bounded.replace(URLS, (candidate) => {
        try {
          const url = new URL(candidate)
          if (!url.hostname || (!url.username && !url.password && !url.search && !url.hash)) return candidate
          url.username = ''
          url.password = ''
          url.search = ''
          url.hash = ''
          changed = true
          return url.toString()
        } catch {
          return candidate
        }
      })
      sanitized = sanitized.replace(ASSIGNMENT, (_match, key: string) => {
        changed = true
        return `${key}=${REDACTED}`
      }).replace(BEARER, (_match, prefix: string) => {
        changed = true
        return `${prefix}${REDACTED}`
      })
      if (changed) redactions++
      return sanitized
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) { truncations++; return TRUNCATED }
      seen.add(input)
      if (input.length > 128) truncations++
      const result = input.slice(0, 128).map((item) => visit(item, depth + 1))
      seen.delete(input)
      return result
    }
    if (typeof input === 'object') {
      if (seen.has(input)) { truncations++; return TRUNCATED }
      seen.add(input)
      const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      if (entries.length > 128) truncations++
      const result = Object.create(null) as Record<string, unknown>
      for (const [key, child] of entries.slice(0, 128)) {
        if (SENSITIVE.test(key.replace(/[^a-z0-9]/gi, ''))) {
          result[key] = REDACTED
          redactions++
        } else {
          result[key] = visit(child, depth + 1)
        }
      }
      seen.delete(input)
      return result
    }
    truncations++
    return TRUNCATED
  }
  return { value: visit(value, 0), redactions, truncations }
}
