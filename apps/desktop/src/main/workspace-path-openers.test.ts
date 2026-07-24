import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { detectWorkspacePathOpeners } from './workspace-path-openers'

describe('workspace path opener detection', () => {
  it('reports only executable whitelisted IDE commands after the file explorer', async () => {
    const executableDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-openers-'))
    try {
      const code = join(executableDirectory, 'code')
      const cursor = join(executableDirectory, 'cursor')
      await Promise.all([writeFile(code, '#!/bin/sh\n'), writeFile(cursor, '#!/bin/sh\n')])
      await Promise.all([chmod(code, 0o755), chmod(cursor, 0o644)])

      await expect(detectWorkspacePathOpeners(executableDirectory)).resolves.toEqual([
        { id: 'fileManager', label: 'File Explorer', kind: 'fileManager' },
        { id: 'vscode', label: 'Visual Studio Code', kind: 'ide' }
      ])
    } finally {
      await rm(executableDirectory, { recursive: true, force: true })
    }
  })
})
