const TERMINAL_GLYPH_FALLBACKS = Object.freeze([
  '"JetBrainsMono Nerd Font Mono"',
  '"JetBrainsMono Nerd Font"',
  '"Symbols Nerd Font Mono"',
  '"Symbols Nerd Font"',
  '"Noto Color Emoji"',
  '"Apple Color Emoji"',
  '"Segoe UI Emoji"'
])

/**
 * Keep the configured terminal face first, then let xterm's canvas renderer
 * resolve prompt icons and emoji from commonly installed platform fonts.
 */
export function withTerminalGlyphFallbacks(fontFamily: string): string {
  return [fontFamily, ...TERMINAL_GLYPH_FALLBACKS].join(', ')
}
