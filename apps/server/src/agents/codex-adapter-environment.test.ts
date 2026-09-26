import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { CodexAdapter } from './codex-adapter'

it.skipIf(process.platform !== 'linux')(
  'keeps user auth context but excludes service authority from a non-private Codex child',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-adapter-env-'))
    const executable = join(directory, 'codex-fixture')
    const capture = join(directory, 'child-environment')
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-cli 0.156.1\\n'
  exit 0
fi
printf 'token=%s\\nstate=%s\\nauth=%s\\n' "\${AGENT_WORKSPACE_SERVER_TOKEN+present}" "\${AGENT_WORKSPACE_STATE_WORKING+present}" "\${CODEX_ADAPTER_TEST_AUTH-}" > "$CODEX_ADAPTER_ENV_CAPTURE"
exit 1
`
    )
    chmodSync(executable, 0o700)
    const previous = {
      token: process.env.AGENT_WORKSPACE_SERVER_TOKEN,
      state: process.env.AGENT_WORKSPACE_STATE_WORKING,
      capture: process.env.CODEX_ADAPTER_ENV_CAPTURE,
      auth: process.env.CODEX_ADAPTER_TEST_AUTH
    }
    process.env.AGENT_WORKSPACE_SERVER_TOKEN = 'fixture-bearer-token'
    process.env.AGENT_WORKSPACE_STATE_WORKING = join(directory, 'isolated-state')
    process.env.CODEX_ADAPTER_ENV_CAPTURE = capture
    process.env.CODEX_ADAPTER_TEST_AUTH = 'available'
    let adapter: CodexAdapter | undefined
    try {
      adapter = await CodexAdapter.fromExecutable(executable)
      expect(adapter.descriptor.capabilities).toEqual(['resume', 'fork'])
      await expect(adapter.verifyThread(randomUUID())).rejects.toThrow()
      expect(readFileSync(capture, 'utf8')).toBe('token=\nstate=\nauth=available\n')
    } finally {
      adapter?.close()
      for (const [name, value] of Object.entries({
        AGENT_WORKSPACE_SERVER_TOKEN: previous.token,
        AGENT_WORKSPACE_STATE_WORKING: previous.state,
        CODEX_ADAPTER_ENV_CAPTURE: previous.capture,
        CODEX_ADAPTER_TEST_AUTH: previous.auth
      })) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
