import type { IClipboardProvider } from '@xterm/addon-clipboard'

/**
 * OSC 52 is untrusted terminal output. Host clipboard reads and writes stay disabled
 * until a future explicit permission setting is designed and reviewed.
 */
export const DENY_OSC52_CLIPBOARD_PROVIDER: IClipboardProvider = Object.freeze({
  readText: () => '',
  writeText: () => undefined
})
