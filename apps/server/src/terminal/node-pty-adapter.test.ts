import { describe, expect, it } from 'vitest'

import { NodePtyAdapter } from './node-pty-adapter'
import { TerminalService } from './terminal-service'

describe('NodePtyAdapter', () => {
  it('runs a real process through a PTY and retains its output after exit', async () => {
    const service = new TerminalService(new NodePtyAdapter())
    const { terminal } = await service.create({
      rows: 24,
      cols: 80,
      command: [process.execPath, '-e', 'process.stdout.write(Buffer.from([0x6e, 0x61, 0xff]))']
    })
    try {
      const deadline = Date.now() + 10_000
      while (!service.attach(terminal.id).terminal.exited) {
        if (Date.now() > deadline) throw new Error('PTY child did not exit')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const result = service.attach(terminal.id)
      expect(
        Buffer.concat(result.output.map((chunk) => Buffer.from(chunk.data, 'base64')))
      ).toEqual(Buffer.from([0x6e, 0x61, 0xff]))
      expect(result.terminal.exitCode).toBe(0)
    } finally {
      service.dispose()
    }
  }, 15_000)
})
