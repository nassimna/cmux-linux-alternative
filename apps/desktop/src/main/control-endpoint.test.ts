import { describe, expect, it } from 'vitest'

import { resolveControlEndpoint, toNodeSocketPath } from './control-endpoint'

describe('control endpoint', () => {
  it('prefers an explicit endpoint override', () => {
    expect(
      resolveControlEndpoint(false, {
        platform: 'linux',
        environment: { AGENT_WORKSPACE_SOCKET: '/custom/control.sock' },
        temporaryDirectory: '/tmp',
        userId: 1000
      })
    ).toBe('/custom/control.sock')
  })

  it('ignores an explicit endpoint override in packaged applications', () => {
    expect(
      resolveControlEndpoint(true, {
        platform: 'linux',
        environment: { AGENT_WORKSPACE_SOCKET: '/custom/control.sock' },
        temporaryDirectory: '/tmp',
        userId: 1000
      })
    ).toBe('/tmp/agent-workspace-1000/control.sock')
  })

  it('uses XDG_RUNTIME_DIR on Linux', () => {
    expect(
      resolveControlEndpoint(false, {
        platform: 'linux',
        environment: { XDG_RUNTIME_DIR: '/run/user/1000' },
        temporaryDirectory: '/tmp',
        userId: 1000
      })
    ).toBe('/run/user/1000/agent-workspace/control.sock')
  })

  it('falls back to a per-user temporary directory', () => {
    expect(
      resolveControlEndpoint(false, {
        platform: 'linux',
        environment: {},
        temporaryDirectory: '/tmp',
        userId: 1000
      })
    ).toBe('/tmp/agent-workspace-1000/control.sock')
  })

  it('maps a Windows endpoint to the Node named-pipe path', () => {
    expect(toNodeSocketPath('agent-workspace-control', 'win32')).toBe(
      '\\\\.\\pipe\\agent-workspace-control'
    )
  })
})
