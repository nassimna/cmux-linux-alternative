import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { terminalTheme } from '@agent-workspace/design-tokens/terminal-theme'

const rendererFoundation = readFileSync(
  new URL('../renderer/src/styles/foundation.css', import.meta.url),
  'utf8'
)
const productStyles = readFileSync(new URL('../renderer/src/styles.css', import.meta.url), 'utf8')
const rendererStyles = `${rendererFoundation}\n${productStyles}`
const foundationTokens = readFileSync(
  new URL('../../../../packages/design-tokens/src/tokens.css', import.meta.url),
  'utf8'
)
const terminalPane = readFileSync(
  new URL('../renderer/src/terminal/TerminalPane.tsx', import.meta.url),
  'utf8'
)

function declarationValues(property: string): string[] {
  const pattern = new RegExp(`${property}:([^;]+);`, 'gu')
  return Array.from(rendererStyles.matchAll(pattern), (match) => (match[1] ?? '').trim())
}

describe('renderer design-token contract', () => {
  it('keeps foundational color literals in the project-owned token package', () => {
    expect(rendererStyles.match(/#[\da-f]{3,8}\b|rgba?\(/giu) ?? []).toEqual([])
    expect(terminalPane.match(/#[\da-f]{3,8}\b|rgba?\(/giu) ?? []).toEqual([])
  })

  it('uses the project radius scale instead of product-owned length literals', () => {
    expect(
      rendererStyles.match(/border-radius:[^;\n]*\d+(?:\.\d+)?(?:px|r?em|%)/giu) ?? []
    ).toEqual([])
  })

  it('sources typography, borders, shadows, motion, and layers from foundation tokens', () => {
    expect(declarationValues('font-size').every((value) => value.startsWith('var(--aw-'))).toBe(
      true
    )
    expect(declarationValues('font-weight').every((value) => value.startsWith('var(--aw-'))).toBe(
      true
    )
    expect(
      declarationValues('font-family').every(
        (value) => value === 'inherit' || value.startsWith('var(--aw-')
      )
    ).toBe(true)
    expect(
      declarationValues('font').every(
        (value) => value === 'inherit' || value.includes('var(--aw-font-')
      )
    ).toBe(true)
    expect(declarationValues('line-height').every((value) => value.startsWith('var(--aw-'))).toBe(
      true
    )
    expect(declarationValues('z-index').every((value) => value.startsWith('var(--aw-'))).toBe(true)
    expect(
      declarationValues('box-shadow').every(
        (value) => value === 'none' || value.startsWith('var(--aw-')
      )
    ).toBe(true)
    expect(
      rendererStyles.match(/(?:animation|transition)(?:-[\w-]+)?:[^;]*\d+(?:\.\d+)?m?s/giu) ?? []
    ).toEqual([])
    expect(
      rendererStyles.match(
        /border(?:-(?:top|right|bottom|left))?(?:-width)?:[^;\n]*\d+(?:\.\d+)?(?:px|r?em)/giu
      ) ?? []
    ).toEqual([])
    expect(rendererFoundation.match(/--aw-[\w-]+\s*:/gu) ?? []).toEqual([])
  })

  it('uses semantic theme and specialized content tokens', () => {
    expect(productStyles).toContain('var(--aw-color-surface-canvas)')
    expect(productStyles).toContain('var(--aw-color-text-primary)')
    expect(productStyles).toContain('var(--aw-color-border-default)')
    expect(productStyles).toContain('var(--aw-color-terminal-canvas)')
    expect(productStyles).toContain('var(--aw-color-browser-content)')
    expect(terminalPane).toContain("from '@agent-workspace/design-tokens/terminal-theme'")
    expect(foundationTokens).toContain(
      "--aw-font-ui: system-ui, 'Segoe UI', 'Cantarell', 'Ubuntu', sans-serif"
    )
    expect(foundationTokens).toContain(
      "--aw-font-mono: 'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace"
    )
  })

  it('keeps transient notification text on semantic colors without opacity interpolation', () => {
    expect(productStyles).toContain(
      '[data-sonner-toaster] [data-sonner-toast] [data-title] {\n  color: var(--aw-color-text-primary) !important;\n}'
    )
    expect(productStyles).toContain(
      '[data-sonner-toaster] [data-sonner-toast] [data-description] {\n  color: var(--aw-color-text-secondary) !important;\n}'
    )
    expect(productStyles).toContain(
      'transition-property: transform, height, box-shadow !important;'
    )
    expect(productStyles).toContain('transition-property: transform !important;')
  })

  it('keeps the CSS terminal canvas synchronized with the xterm palette', () => {
    const terminalCanvas = foundationTokens.match(/--aw-color-terminal-canvas:\s*([^;]+);/u)?.[1]
    expect(terminalCanvas?.trim()).toBe(terminalTheme.background)
    expect(terminalTheme.cursorAccent).toBe(terminalTheme.background)
  })

  it('bounds rich card payloads at every density and wraps high-zoom preformatted content', () => {
    expect(productStyles).toContain("[data-density='compact']")
    expect(productStyles).toContain("[data-density='comfortable'] .workspace-card-slots-v2")
    expect(productStyles).toContain("[data-density='expanded'] .workspace-card-slots-v2")
    expect(productStyles).toContain('max-block-size: 10rem')
    expect(productStyles).toContain('max-block-size: 16rem')
    expect(productStyles).toContain('.workspace-card-v2-log code')
    expect(productStyles).toContain('white-space: pre-wrap')
    expect(productStyles).toContain('word-break: break-word')
    expect(productStyles).toContain('overflow-wrap: anywhere')
  })
})
