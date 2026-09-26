// @vitest-environment jsdom

import { expect, it } from 'vitest'

it('keeps an unfinished output line through a narrow-and-wide resize', async () => {
  const originalGetContext = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext'
  )
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ measureText: () => ({ width: 8 }) })
  })

  try {
    const { Terminal } = await import('@xterm/xterm')
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 90,
      rows: 24,
      reflowCursorLine: true
    })
    try {
      const countCharacters = (): number => {
        const buffer = terminal.buffer.active
        let count = 0
        for (let row = 0; row < buffer.length; row += 1) {
          count += (buffer.getLine(row)?.translateToString(false).match(/x/g) ?? []).length
        }
        return count
      }

      await new Promise<void>((resolve) => terminal.write('x'.repeat(109), resolve))
      expect(countCharacters()).toBe(109)
      terminal.resize(45, 24)
      expect(countCharacters()).toBe(109)
      terminal.resize(90, 24)
      expect(countCharacters()).toBe(109)
    } finally {
      terminal.dispose()
    }
  } finally {
    if (originalGetContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
    }
  }
})
