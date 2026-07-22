import { describe, expect, it } from 'vitest'

import { withTerminalGlyphFallbacks } from './terminal-fonts'

describe('withTerminalGlyphFallbacks', () => {
  it('preserves the configured primary face and adds Nerd Font and emoji fallbacks', () => {
    expect(withTerminalGlyphFallbacks('Iosevka')).toBe(
      'Iosevka, "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", "Symbols Nerd Font", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"'
    )
  })

  it('preserves a configured CSS font stack', () => {
    expect(withTerminalGlyphFallbacks('"Berkeley Mono", monospace')).toMatch(
      /^"Berkeley Mono", monospace, "JetBrainsMono Nerd Font Mono"/u
    )
  })
})
