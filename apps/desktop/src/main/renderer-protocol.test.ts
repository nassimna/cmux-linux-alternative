import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveRendererAsset } from './renderer-protocol'

describe('renderer application protocol', () => {
  const root = resolve('/application/renderer')

  it('maps the renderer origin and relative assets into the bundle', () => {
    expect(resolveRendererAsset(root, 'agent-workspace://renderer/')).toBe(
      resolve(root, 'index.html')
    )
    expect(resolveRendererAsset(root, 'agent-workspace://renderer/assets/app.js')).toBe(
      resolve(root, 'assets/app.js')
    )
  })

  it('rejects other hosts, malformed escapes, and traversal attempts', () => {
    expect(resolveRendererAsset(root, 'agent-workspace://other/index.html')).toBeUndefined()
    expect(resolveRendererAsset(root, 'agent-workspace://renderer/%E0%A4%A')).toBeUndefined()
    expect(resolveRendererAsset(root, 'agent-workspace://renderer/%2e%2e/secret')).toBeUndefined()
    expect(resolveRendererAsset(root, 'agent-workspace://renderer/%5c..%5csecret')).toBeUndefined()
  })
})
