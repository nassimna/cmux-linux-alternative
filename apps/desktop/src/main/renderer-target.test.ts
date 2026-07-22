import { describe, expect, it } from 'vitest'

import { resolveRendererTarget } from './renderer-target'

describe('resolveRendererTarget', () => {
  it('always uses the trusted application origin when packaged', () => {
    expect(resolveRendererTarget(true, 'https://hostile.invalid/renderer')).toBe(
      'agent-workspace://renderer/index.html'
    )
  })

  it('honors the explicit development server URL when unpackaged', () => {
    expect(resolveRendererTarget(false, 'http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
  })

  it('uses the application origin when development has no override', () => {
    expect(resolveRendererTarget(false, undefined)).toBe('agent-workspace://renderer/index.html')
  })
})
