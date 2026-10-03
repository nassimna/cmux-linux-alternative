import { describe, expect, it } from 'vitest'

import { browserSecurity, normalizeBrowserAddress } from './url-policy'
import { browserMessages } from '@agent-workspace/contracts/desktop/browser-messages'

describe('browser address policy', () => {
  it.each([
    ['example.com', 'https://example.com/'],
    ['localhost:3000/path', 'https://localhost:3000/path'],
    ['http://example.com/a?b=1', 'http://example.com/a?b=1'],
    [' https://example.com/path ', 'https://example.com/path']
  ])('normalizes %s to a safe absolute URL', (input, expected) => {
    expect(normalizeBrowserAddress(input)).toEqual({ valid: true, url: expected })
  })

  it.each([
    ['', 'Enter a web address.'],
    ['file:///tmp/secret', 'Only HTTP and HTTPS addresses are supported.'],
    ['javascript:alert(1)', 'Only HTTP and HTTPS addresses are supported.'],
    ['https://user:secret@example.com', 'Addresses containing credentials are not allowed.'],
    ['https://', 'Enter a valid web address.']
  ])('rejects %s', (input, reason) => {
    expect(normalizeBrowserAddress(input)).toEqual({ valid: false, reason })
  })

  it('reports the transport security affordance without trusting arbitrary schemes', () => {
    expect(browserSecurity('https://example.com')).toBe('secure')
    expect(browserSecurity('http://example.com')).toBe('insecure')
    expect(browserSecurity('file:///tmp/a')).toBe('invalid')
  })

  it('gets validation copy from the provided catalog', () => {
    expect(
      normalizeBrowserAddress('', {
        ...browserMessages,
        validation: (reason) => `localized:${reason}`
      })
    ).toEqual({ valid: false, reason: 'localized:empty' })
  })
})
