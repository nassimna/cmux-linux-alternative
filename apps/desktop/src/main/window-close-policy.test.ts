import { describe, expect, it } from 'vitest'

import { shouldRequestServiceWindowClose } from './window-close-policy'

describe('shouldRequestServiceWindowClose', () => {
  it('rehomes an ordinary close while another provider-owned window remains', () => {
    expect(shouldRequestServiceWindowClose(2, true, false)).toBe(true)
  })

  it('does not intercept close after fail-closed application shutdown begins', () => {
    expect(shouldRequestServiceWindowClose(2, true, true)).toBe(false)
  })
})
