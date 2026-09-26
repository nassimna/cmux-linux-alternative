import { execFile } from 'node:child_process'

import {
  MAX_WORKSPACE_RUNTIME_METADATA_CHARS,
  type WorkspaceGitStatus,
  type WorkspaceRuntimeMetadata
} from '@agent-workspace/contracts/desktop/desktop-bridge'

const GIT_TIMEOUT_MS = 1_000
const GIT_MAX_BUFFER_BYTES = 4 * 1024

export interface GitMetadataExecutionOptions {
  cwd: string
  encoding: 'utf8'
  env: NodeJS.ProcessEnv
  maxBuffer: number
  timeout: number
  windowsHide: true
}

export type GitMetadataExecutor = (
  executable: string,
  arguments_: readonly string[],
  options: GitMetadataExecutionOptions
) => Promise<string>

export async function resolveWorkspaceRuntimeMetadata(
  workingDirectory: string,
  execute: GitMetadataExecutor = executeGit
): Promise<Pick<WorkspaceRuntimeMetadata, 'gitBranch' | 'gitStatus'>> {
  try {
    const stdout = await execute(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      gitExecutionOptions(workingDirectory)
    )
    return parseGitStatus(stdout)
  } catch {
    return { gitBranch: null, gitStatus: null }
  }
}

function executeGit(
  executable: string,
  arguments_: readonly string[],
  options: GitMetadataExecutionOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...arguments_], options, (error, stdout) => {
      if (error) reject(error instanceof Error ? error : new Error('Git branch query failed'))
      else resolve(stdout)
    })
  })
}

function gitExecutionOptions(cwd: string): GitMetadataExecutionOptions {
  return {
    cwd,
    encoding: 'utf8',
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR
    },
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true
  }
}

function parseGitStatus(stdout: string): Pick<WorkspaceRuntimeMetadata, 'gitBranch' | 'gitStatus'> {
  const lines = stdout.split(/\r?\n/u)
  const branchLine = lines.find((line) => line.startsWith('# branch.head '))
  if (!branchLine) throw new Error('Missing Git branch status')
  const rawBranch = branchLine.slice('# branch.head '.length)
  const gitBranch = rawBranch === '(detached)' ? null : sanitizeBranch(rawBranch)
  if (rawBranch !== '(detached)' && gitBranch === null) throw new Error('Malformed Git branch')
  let staged = false
  let unstaged = false
  let untracked = false
  let conflicted = false
  let ahead = 0
  let behind = 0
  for (const line of lines) {
    if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(line)
      if (!match) throw new Error('Malformed Git branch status')
      ahead = safeCount(match[1]!)
      behind = safeCount(match[2]!)
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const x = line[2]
      const y = line[3]
      const minimumFields = line.startsWith('2 ') ? 10 : 9
      if (
        !x ||
        !y ||
        !'.MTADRCU'.includes(x) ||
        !'.MTADRCU'.includes(y) ||
        line.split(' ').length < minimumFields
      ) {
        throw new Error('Malformed Git file status')
      }
      staged ||= x !== '.'
      unstaged ||= y !== '.'
    } else if (line.startsWith('u ')) {
      if (line.split(' ').length < 11) throw new Error('Malformed Git conflict status')
      conflicted = true
    } else if (line.startsWith('? ')) {
      if (line.length <= 2) throw new Error('Malformed Git untracked status')
      untracked = true
    } else if (
      line !== '' &&
      !line.startsWith('# branch.oid ') &&
      !line.startsWith('# branch.head ') &&
      !line.startsWith('# branch.upstream ')
    ) {
      throw new Error('Unknown Git status record')
    }
  }
  const gitStatus: WorkspaceGitStatus = {
    clean: !(staged || unstaged || untracked || conflicted),
    staged,
    unstaged,
    untracked,
    conflicted,
    ahead,
    behind
  }
  return { gitBranch, gitStatus }
}

function safeCount(value: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Git status count')
  return count
}

function sanitizeBranch(branch: string): string | null {
  if (
    !branch ||
    branch !== branch.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(branch) ||
    [...branch].length > MAX_WORKSPACE_RUNTIME_METADATA_CHARS
  ) {
    return null
  }
  return branch
}
