import {
  browserMessages,
  type BrowserAddressValidationReason,
  type BrowserMessages
} from '../../../shared/browser-messages'

export type BrowserAddressResult =
  | { readonly valid: true; readonly url: string }
  | { readonly valid: false; readonly reason: string }

const SCHEME = /^[a-z][a-z\d+.-]*:/iu

export function normalizeBrowserAddress(
  input: string,
  messages: BrowserMessages = browserMessages
): BrowserAddressResult {
  const value = input.trim()
  if (!value) return invalidAddress('empty', messages)

  const looksLikeHostWithPort = /^[a-z\d.-]+:\d+(?:\/|$)/iu.test(value)
  const candidate = SCHEME.test(value) && !looksLikeHostWithPort ? value : `https://${value}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return invalidAddress('invalid', messages)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalidAddress('scheme', messages)
  }
  if (!parsed.hostname) return invalidAddress('host', messages)
  if (parsed.username || parsed.password) {
    return invalidAddress('credentials', messages)
  }
  return { valid: true, url: parsed.href }
}

function invalidAddress(
  reason: BrowserAddressValidationReason,
  messages: BrowserMessages
): BrowserAddressResult {
  return { valid: false, reason: messages.validation(reason) }
}

export function browserSecurity(url: string): 'secure' | 'insecure' | 'invalid' {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return 'secure'
    if (parsed.protocol === 'http:') return 'insecure'
  } catch {
    // Invalid state is rendered without attempting to load it.
  }
  return 'invalid'
}
