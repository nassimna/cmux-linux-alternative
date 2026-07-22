// @vitest-environment jsdom

import { ClipboardAddon, type ClipboardSelectionType } from '@xterm/addon-clipboard'
import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import { DENY_OSC52_CLIPBOARD_PROVIDER } from './clipboard-policy'

describe('OSC 52 clipboard policy', () => {
  it('never reads or writes the host clipboard', async () => {
    const readText = vi.fn().mockResolvedValue('host-secret')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { readText, writeText } })
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined
    const input = vi.fn()
    const terminal = {
      input,
      parser: {
        registerOscHandler: (_identifier: number, nextHandler: typeof handler) => {
          handler = nextHandler
          return { dispose: vi.fn() }
        }
      }
    }
    new ClipboardAddon(undefined, DENY_OSC52_CLIPBOARD_PROVIDER).activate(
      terminal as unknown as Terminal
    )

    await handler?.('c;?')
    await handler?.('c;aG9zdC13cml0ZQ==')

    expect(readText).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    expect(input).toHaveBeenCalledWith('\u001b]52;c;\u0007', false)
    expect(await DENY_OSC52_CLIPBOARD_PROVIDER.readText('c' as ClipboardSelectionType)).toBe('')
  })
})
