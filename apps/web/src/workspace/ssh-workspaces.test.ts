import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  parseSshWorkspace,
  readSshWorkspaces,
  saveSshWorkspaces,
  sshCommand
} from './ssh-workspaces'

const id = '10000000-0000-4000-8000-000000000001'

afterEach(() => vi.unstubAllGlobals())

describe('saved SSH workspaces', () => {
  it('builds argv for SSH config aliases and an explicit user and port', () => {
    expect(sshCommand(parseSshWorkspace('prod-alias', '', 22))).toEqual(['ssh', 'prod-alias'])
    expect(sshCommand(parseSshWorkspace('host.example', 'deploy', 2222))).toEqual([
      'ssh',
      '-p',
      '2222',
      'deploy@host.example'
    ])
  })

  it('rejects option and whitespace injection before launching a terminal', () => {
    expect(() => parseSshWorkspace('-oProxyCommand=evil', '', 22)).toThrow()
    expect(() => parseSshWorkspace('host; rm -rf ~', '', 22)).toThrow()
    expect(() => parseSshWorkspace('host', '-bad', 22)).toThrow()
    expect(() => parseSshWorkspace('host', '', 0)).toThrow()
  })

  it('round trips connection coordinates and ignores damaged entries', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    })
    const profile = parseSshWorkspace('prod', 'deploy', 22)
    saveSshWorkspaces({ [id]: profile })
    expect(readSshWorkspaces()).toEqual({ [id]: profile })
    storage.set(
      'agent-workspace.ssh-workspaces.v1',
      JSON.stringify({
        [id]: profile,
        'bad-id': profile,
        '20000000-0000-4000-8000-000000000002': { host: '-evil', user: '', port: 22 }
      })
    )
    expect(readSshWorkspaces()).toEqual({ [id]: profile })
  })
})
