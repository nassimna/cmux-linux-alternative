import { describe, expect, it, vi } from 'vitest'

import {
  resolveWorkspaceRuntimeMetadata,
  type GitMetadataExecutor
} from './workspace-runtime-metadata'

const clean = {
  clean: true,
  staged: false,
  unstaged: false,
  untracked: false,
  conflicted: false,
  ahead: 0,
  behind: 0
}

describe('workspace runtime metadata', () => {
  it('uses one shell-free bounded status query in the authoritative directory', async () => {
    const execute = vi
      .fn<GitMetadataExecutor>()
      .mockResolvedValue('# branch.oid abc123\n# branch.head feature/sidebar-metadata\n')

    await expect(
      resolveWorkspaceRuntimeMetadata('/repo with spaces/$(not-a-shell)', execute)
    ).resolves.toEqual({ gitBranch: 'feature/sidebar-metadata', gitStatus: clean })
    const [executable, arguments_, options] = execute.mock.calls[0]!
    expect(executable).toBe('git')
    expect(arguments_).toEqual(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'])
    expect(options).toMatchObject({
      cwd: '/repo with spaces/$(not-a-shell)',
      encoding: 'utf8',
      maxBuffer: 4_096,
      timeout: 1_000,
      windowsHide: true
    })
    expect(options.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C'
    })
  })

  it('summarizes every bounded porcelain-v2 state and upstream divergence', async () => {
    const stdout = [
      '# branch.oid abc123',
      '# branch.head feature/status',
      '# branch.upstream origin/feature/status',
      '# branch.ab +12 -3',
      '1 M. N... 100644 100644 100644 abc abc staged.txt',
      '1 .M N... 100644 100644 100644 abc abc unstaged.txt',
      'u UU N... 100644 100644 100644 100644 abc abc abc conflict.txt',
      '? untracked.txt',
      ''
    ].join('\n')
    await expect(
      resolveWorkspaceRuntimeMetadata('/repo', () => Promise.resolve(stdout))
    ).resolves.toEqual({
      gitBranch: 'feature/status',
      gitStatus: {
        clean: false,
        staged: true,
        unstaged: true,
        untracked: true,
        conflicted: true,
        ahead: 12,
        behind: 3
      }
    })
  })

  it.each([
    '# branch.head  branch\n',
    '# branch.head branch \n',
    '# branch.head unsafe\u001bbranch\n',
    '# branch.head unsafe\u200bbranch\n',
    `# branch.head ${'x'.repeat(257)}\n`,
    '# branch.head main\n# branch.ab +x -1\n',
    '# branch.head main\nmalformed status record\n',
    '# branch.head main\n1 Z. too short\n'
  ])('drops malformed, control-bearing, or oversized status output %#', async (stdout) => {
    await expect(
      resolveWorkspaceRuntimeMetadata('/repo', () => Promise.resolve(stdout))
    ).resolves.toEqual({ gitBranch: null, gitStatus: null })
  })

  it('returns no branch for detached heads, missing git, timeouts, and non-repositories', async () => {
    await expect(
      resolveWorkspaceRuntimeMetadata('/repo', () =>
        Promise.reject(new Error('private path and git error'))
      )
    ).resolves.toEqual({ gitBranch: null, gitStatus: null })
  })
})
