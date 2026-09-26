import { statSync } from 'node:fs'

import { spawn } from 'node-pty'
import { expect, it } from 'vitest'

import { CodexAdapter } from './codex-adapter'
import { withSealedExecutable } from './sealed-executable'

it.skipIf(process.env.RUN_CODEX_0156_AUDIT !== '1')(
  'prepares exact resume for a disposable 0.156.1 Codex thread',
  async () => {
    const home = process.env.CODEX_HOME
    const thread = process.env.AGENT_WORKSPACE_CODEX_AUDIT_THREAD
    if (!home?.startsWith('/tmp/agent-codex-audit.') || !thread) {
      throw new Error('This test requires a disposable isolated Codex home and thread')
    }
    const adapter = await CodexAdapter.fromExecutable()
    try {
      expect(adapter.descriptor).toMatchObject({
        id: 'codex',
        version: '0.156.1',
        platform: 'linux',
        capabilities: ['resume', 'fork']
      })
      const plan = await adapter.prepareResume(thread)
      expect(plan.command).toEqual([plan.command[0], 'resume', thread, '--no-alt-screen'])
      expect(statSync(plan.command[0]).size).toBe(plan.executableIdentity.size)
      expect(plan.executableIdentity.sha256).toMatch(/^[a-f0-9]{64}$/)
      const output = await withSealedExecutable(plan, async (command) => {
        const terminal = spawn(command[0]!, [...command.slice(1)], {
          cwd: home,
          rows: 24,
          cols: 80,
          env: { ...process.env, CODEX_HOME: home, TERM: 'xterm-256color' }
        })
        try {
          return await new Promise<string>((resolve, reject) => {
            let text = ''
            const deadline = setTimeout(
              () => reject(new Error('Codex sign-in gate timed out')),
              5_000
            )
            terminal.onData((chunk) => {
              text += chunk
              if (/Sign\s*in\s*with\s*ChatGPT/i.test(text)) {
                clearTimeout(deadline)
                resolve(text)
              }
            })
            terminal.onExit(() => {
              clearTimeout(deadline)
              reject(new Error('Codex exited before the sign-in gate'))
            })
          })
        } finally {
          terminal.kill()
        }
      })
      expect(output).toMatch(/Sign\s*in\s*with\s*ChatGPT/i)
    } finally {
      adapter.close()
    }
  }
)
