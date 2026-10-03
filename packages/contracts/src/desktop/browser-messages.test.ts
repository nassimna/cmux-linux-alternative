import { describe, expect, it } from 'vitest'

import { browserMessages } from './browser-messages'

describe('browser message catalog', () => {
  it('centralizes parameterized security, validation, status, permission, and profile copy', () => {
    expect(browserMessages.toolbar.securityLabel('secure')).toBe('Secure HTTPS connection')
    expect(browserMessages.validation('credentials')).toContain('credentials')
    expect(browserMessages.pane.status(true)).toBe('Loading…')
    expect(browserMessages.pane.profilePartitionLabel('persist:test')).toContain('persist:test')
    expect(browserMessages.native.permissionRequest('https://example.test', 'geolocation')).toBe(
      'https://example.test requests geolocation permission.'
    )
  })
})
