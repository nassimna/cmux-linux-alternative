import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import type { ControlClient } from './control-client'

import {
  REQUIRED_CAPABILITIES,
  ServiceRecoveryRequiredError,
  ServiceSupervisor,
  assertServiceCapabilities,
  buildServiceArguments,
  buildServiceEnvironment,
  DESKTOP_BOOTSTRAP_PROOF_ENVIRONMENT_VARIABLE,
  parseUnifiedCgroupPath,
  prepareServiceProcessContainment,
  parseServiceReadyRecord,
  parseServiceStartupRecord,
  waitForServiceStartup,
  type ServiceProcessSpawn,
  type ServiceProcessContainment,
  type ServiceSupervisorDependencies,
  resolveServicePath
} from './service-supervisor'

describe('resolveServicePath', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('resolves the development sidecar from the repository target directory', () => {
    vi.stubEnv('AGENT_WORKSPACE_SERVICE_PATH', undefined)

    expect(
      resolveServicePath({
        isPackaged: false,
        resourcesPath: '/unused',
        workingDirectory: '/repo/apps/desktop'
      })
    ).toMatch(/\/repo\/target\/debug\/agent-workspace-service(?:\.exe)?$/)
  })

  it('resolves the packaged sidecar from application resources', () => {
    vi.stubEnv('AGENT_WORKSPACE_SERVICE_PATH', '/tmp/untrusted')

    expect(
      resolveServicePath({
        isPackaged: true,
        resourcesPath: '/application/resources',
        workingDirectory: '/unused'
      })
    ).toMatch(/\/application\/resources\/bin\/agent-workspace-service(?:\.exe)?$/)
  })

  it('honors an explicit sidecar override during development', () => {
    vi.stubEnv('AGENT_WORKSPACE_SERVICE_PATH', '/repo/custom/agent-workspace-service')

    expect(
      resolveServicePath({
        isPackaged: false,
        resourcesPath: '/unused',
        workingDirectory: '/repo/apps/desktop'
      })
    ).toBe('/repo/custom/agent-workspace-service')
  })
})

describe('assertServiceCapabilities', () => {
  it('accepts the complete Milestone 2 dispatcher contract', () => {
    expect(() => assertServiceCapabilities(REQUIRED_CAPABILITIES)).not.toThrow()
  })

  it('rejects a service that cannot provide required terminal behavior', () => {
    expect(() => assertServiceCapabilities(['system.identify'])).toThrow(/terminal\.attach/)
  })

  it('requires the complete notification command contract', () => {
    const withoutNotificationClear = REQUIRED_CAPABILITIES.filter(
      (capability) => capability !== 'notification.clear'
    )
    expect(() => assertServiceCapabilities(withoutNotificationClear)).toThrow(/notification\.clear/)
  })

  it('accepts a mixed-version service without the optional attention family', () => {
    const withOptionalAttention = [
      ...REQUIRED_CAPABILITIES,
      'workspace.attention.get',
      'workspace.attention.events',
      'attention.acknowledge',
      'attention-v1'
    ]
    const olderService = withOptionalAttention.filter(
      (capability) =>
        ![
          'workspace.attention.get',
          'workspace.attention.events',
          'attention.acknowledge',
          'attention-v1'
        ].includes(capability)
    )

    expect(() => assertServiceCapabilities(olderService)).not.toThrow()
  })
})

describe('buildServiceArguments', () => {
  it('passes the endpoint, durable state database, and optional bootstrap directory', () => {
    expect(
      buildServiceArguments(
        '/run/control.sock',
        '/user/state/workspace.sqlite',
        '/run/cli-session.json',
        '/user/config/configuration.json',
        '/user/logs',
        '/work'
      )
    ).toEqual([
      '--endpoint',
      '/run/control.sock',
      '--cli-session-file',
      '/run/cli-session.json',
      '--state-db',
      '/user/state/workspace.sqlite',
      '--config',
      '/user/config/configuration.json',
      '--log-dir',
      '/user/logs',
      '--default-cwd',
      '/work'
    ])
  })

  it('omits the optional bootstrap directory when it is not configured', () => {
    expect(
      buildServiceArguments(
        '/run/control.sock',
        '/user/state/workspace.sqlite',
        '/run/cli-session.json',
        '/user/config/configuration.json',
        '/user/logs'
      )
    ).toEqual([
      '--endpoint',
      '/run/control.sock',
      '--cli-session-file',
      '/run/cli-session.json',
      '--state-db',
      '/user/state/workspace.sqlite',
      '--config',
      '/user/config/configuration.json',
      '--log-dir',
      '/user/logs'
    ])
  })
})

describe('buildServiceEnvironment', () => {
  it('overwrites an inherited untrusted CLI discovery path', () => {
    expect(
      buildServiceEnvironment('/trusted/cli-session.json', {
        AGENT_WORKSPACE_SESSION_FILE: '/attacker/session.json',
        AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'linux-cgroup-v2:/attacker',
        PRESERVED: 'yes'
      })
    ).toMatchObject({
      AGENT_WORKSPACE_SESSION_FILE: '/trusted/cli-session.json',
      AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'graceful-only',
      PRESERVED: 'yes'
    })
  })
})

describe('service process containment', () => {
  it('parses only unified cgroup v2 membership', () => {
    expect(parseUnifiedCgroupPath('0::/user.slice/app.scope\n')).toBe('/user.slice/app.scope')
    expect(() => parseUnifiedCgroupPath('2:cpu:/legacy\n')).toThrow(/unified cgroup v2/)
  })

  it('preserves graceful-only startup on Darwin and fails closed for forced termination', async () => {
    const containment = await prepareServiceProcessContainment('darwin')
    const serviceChild = createServiceChild(undefined, undefined, false)
    expect(containment.environment).toMatchObject({
      AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'graceful-only'
    })
    await expect(containment.terminate(serviceChild.child)).rejects.toThrow(/identity-safe/)
    expect((serviceChild.child.kill as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('falls back to graceful-only startup when Linux cgroup delegation is unavailable', async () => {
    const containment = await prepareServiceProcessContainment('linux', () =>
      Promise.reject(new Error('permission denied'))
    )
    const serviceChild = createServiceChild(undefined, undefined, false)
    expect(containment.environment).toMatchObject({
      AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'graceful-only'
    })
    await expect(containment.terminate(serviceChild.child)).rejects.toThrow(/identity-safe/)
    expect((serviceChild.child.kill as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('rejects an unsupported platform without spawning a risky fallback', async () => {
    await expect(prepareServiceProcessContainment('freebsd')).rejects.toThrow(/unsupported/)
  })

  it('uses the retained Windows child handle even if the exposed PID changes at termination', async () => {
    const containment = await prepareServiceProcessContainment('win32')
    const serviceChild = createServiceChild(undefined, undefined, false)
    Object.assign(serviceChild.child, { pid: 123_456 })

    await containment.terminate(serviceChild.child)

    expect((serviceChild.child.kill as ReturnType<typeof vi.fn>).mock.calls).toEqual([['SIGKILL']])
    expect(containment.environment).toMatchObject({
      AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'windows-job-object'
    })
  })
})

describe('parseServiceReadyRecord', () => {
  it('accepts the stable machine-readable readiness contract', () => {
    expect(
      parseServiceReadyRecord(
        JSON.stringify({
          event: 'service.ready',
          application: 'agent-workspace',
          version: '0.1.0',
          protocolVersion: 1
        })
      )
    ).toMatchObject({ event: 'service.ready', application: 'agent-workspace' })
  })

  it('rejects malformed and mismatched readiness records', () => {
    expect(() => parseServiceReadyRecord('{')).toThrow()
    expect(() =>
      parseServiceReadyRecord(
        JSON.stringify({
          event: 'service.ready',
          application: 'other-project',
          version: '0.1.0',
          protocolVersion: 1
        })
      )
    ).toThrow()
  })

  it('accepts only a validated recovery startup record in the startup union', () => {
    expect(
      parseServiceStartupRecord(
        JSON.stringify({
          event: 'service.recoveryRequired',
          application: 'agent-workspace',
          version: '0.1.0',
          protocolVersion: 1,
          category: 'corruptDatabase',
          message: 'Recovery is required.',
          migrationBackupAvailable: false
        })
      )
    ).toMatchObject({ event: 'service.recoveryRequired', category: 'corruptDatabase' })
    for (const contradictory of [
      { migrationBackupAvailable: true },
      { migrationBackupAvailable: false, migrationBackupPath: '/private/backup.sqlite' }
    ]) {
      expect(() =>
        parseServiceStartupRecord(
          JSON.stringify({
            event: 'service.recoveryRequired',
            application: 'agent-workspace',
            version: '0.1.0',
            protocolVersion: 1,
            category: 'migrationFailed',
            message: 'Recovery is required.',
            ...contradictory
          })
        )
      ).toThrow()
    }
    expect(() =>
      parseServiceStartupRecord(
        JSON.stringify({
          event: 'service.recoveryRequired',
          application: 'agent-workspace',
          version: '0.1.0',
          protocolVersion: 1,
          category: 'other',
          message: 'Recovery is required.',
          migrationBackupAvailable: false
        })
      )
    ).toThrow()
  })
})

describe('waitForServiceStartup', () => {
  it('reads exactly one bounded line and rejects malformed, trailing, and oversized output', async () => {
    const readyChild = createServiceChild()
    const ready = waitForServiceStartup(readyChild.child, 1_000)
    readyChild.stdout.write(`${JSON.stringify(readyRecord)}\n`)
    await expect(ready).resolves.toMatchObject({ event: 'service.ready' })

    const trailingChild = createServiceChild()
    const trailing = waitForServiceStartup(trailingChild.child, 1_000)
    trailingChild.stdout.write(`${JSON.stringify(readyRecord)}\nnot-allowed\n`)
    await expect(trailing).rejects.toThrow(/unexpected startup output/)

    const malformedChild = createServiceChild()
    const malformed = waitForServiceStartup(malformedChild.child, 1_000)
    malformedChild.stdout.write('{bad}\n')
    await expect(malformed).rejects.toThrow(/invalid startup record/)

    const oversizedChild = createServiceChild()
    const oversized = waitForServiceStartup(oversizedChild.child, 1_000)
    oversizedChild.stdout.write('x'.repeat(16 * 1024 + 1))
    await expect(oversized).rejects.toThrow(/oversized startup record/)
  })
})

describe('ServiceSupervisor utilities', () => {
  it('uses exact flat arguments and enforces one-time exact diagnostic approval', async () => {
    const preview = {
      entries: [{ name: 'state-summary.json', bytes: 20 }],
      totalBytes: 20,
      redactionCount: 2,
      createdAt: 100
    }
    const calls: string[][] = []
    const utilityRunner = {
      run: <T>(arguments_: readonly string[], schema: { parse(value: unknown): T }) => {
        calls.push([...arguments_])
        const command = arguments_[0]
        if (command === 'recovery-inspect') {
          return Promise.resolve(schema.parse({ classification: 'healthy', schemaVersion: 5 }))
        }
        if (command === 'diagnostics-preview') return Promise.resolve(schema.parse(preview))
        return Promise.resolve(schema.parse({ path: '/exports/result.json', bytes: 20 }))
      }
    }
    const supervisor = createUtilitySupervisor(utilityRunner)

    await expect(supervisor.inspectRecovery()).resolves.toEqual({
      classification: 'healthy',
      schemaVersion: 5
    })
    await expect(supervisor.exportRecovery('/exports/recovery.sqlite')).resolves.toEqual({
      path: '/exports/result.json',
      bytes: 20
    })
    const approved = await supervisor.previewDiagnostics()
    await expect(
      supervisor.exportDiagnostics('/exports/diagnostics.json', {
        ...approved,
        redactionCount: 3
      })
    ).rejects.toThrow(/does not match/)
    await expect(
      supervisor.exportDiagnostics('/exports/diagnostics.json', approved)
    ).rejects.toThrow(/must be approved/)

    const approvedAgain = await supervisor.previewDiagnostics()
    await expect(
      supervisor.exportDiagnostics('/exports/diagnostics.json', approvedAgain)
    ).resolves.toEqual({ path: '/exports/result.json', bytes: 20 })
    await expect(
      supervisor.exportDiagnostics('/exports/diagnostics.json', approvedAgain)
    ).rejects.toThrow(/must be approved/)

    expect(calls).toEqual([
      ['recovery-inspect', '--state-db', '/data/state.sqlite'],
      [
        'recovery-export',
        '--state-db',
        '/data/state.sqlite',
        '--destination',
        '/exports/recovery.sqlite'
      ],
      [
        'diagnostics-preview',
        '--state-db',
        '/data/state.sqlite',
        '--config',
        '/data/config.json',
        '--log-dir',
        '/data/logs'
      ],
      [
        'diagnostics-preview',
        '--state-db',
        '/data/state.sqlite',
        '--config',
        '/data/config.json',
        '--log-dir',
        '/data/logs'
      ],
      [
        'diagnostics-export',
        '--state-db',
        '/data/state.sqlite',
        '--config',
        '/data/config.json',
        '--log-dir',
        '/data/logs',
        '--destination',
        '/exports/diagnostics.json'
      ]
    ])
  })
})

describe('ServiceSupervisor lifecycle', () => {
  it('establishes containment before startup authentication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord)
    const order: string[] = []
    serviceChild.stdin.on('data', () => order.push('token'))
    const containment = fakeContainment(serviceChild)
    const createProcessContainment = vi.fn(() => {
      order.push('containment')
      return Promise.resolve(containment)
    })
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([serviceChild], {
        createProcessContainment,
        spawnProcess: () => serviceChild.child,
        createControlClient: () => createControlClient()
      })
    )
    try {
      await supervisor.start()
      expect(createProcessContainment).toHaveBeenCalled()
      expect(order.slice(0, 2)).toEqual(['containment', 'token'])
    } finally {
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('retains kernel containment after root exit and terminates a final-interval descendant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord, undefined, false)
    let containedDescendantAlive = true
    const terminate = vi.fn(() => {
      containedDescendantAlive = false
      return Promise.resolve()
    })
    const containment: ServiceProcessContainment = {
      environment: { AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'test-kernel-container' },
      dispose: vi.fn().mockResolvedValue(undefined),
      isAlive: vi.fn(() => Promise.resolve(containedDescendantAlive)),
      terminate
    }
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([serviceChild], {
        createProcessContainment: () => Promise.resolve(containment),
        shutdownTimeoutMs: 5,
        spawnProcess: () => serviceChild.child,
        createControlClient: () => createControlClient()
      })
    )
    try {
      await supervisor.start()
      serviceChild.exit(1)
      await expect(supervisor.stop()).resolves.toBeUndefined()
      expect(terminate).toHaveBeenCalledWith(serviceChild.child)
      expect(containedDescendantAlive).toBe(false)
    } finally {
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('serializes concurrent starts and restart while ignoring stale intentional exits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const children = [createServiceChild(readyRecord), createServiceChild(readyRecord)]
    const clients = [createControlClient(), createControlClient()]
    let spawnIndex = 0
    let clientIndex = 0
    const spawnProcess = vi.fn<ServiceProcessSpawn>(() => children[spawnIndex++]!.child)
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment(children, {
        spawnProcess,
        createControlClient: () => clients[clientIndex++]!
      })
    )
    const unexpected = vi.fn()
    supervisor.onUnexpectedExit(unexpected)
    try {
      const [first, concurrent] = await Promise.all([supervisor.start(), supervisor.start()])
      expect(concurrent).toBe(first)
      expect(spawnProcess).toHaveBeenCalledTimes(1)
      expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({
        detached: process.platform !== 'win32',
        windowsHide: true
      })
      expect(spawnProcess.mock.calls[0]?.[1]).toEqual([
        '--endpoint',
        '/run/control.sock',
        '--cli-session-file',
        join(directory, 'runtime', 'session.json'),
        '--state-db',
        join(directory, 'state', 'state.sqlite'),
        '--config',
        join(directory, 'config', 'configuration.json'),
        '--log-dir',
        join(directory, 'logs'),
        '--default-cwd',
        directory
      ])

      const replacement = await supervisor.restart()
      expect(replacement).toBe(clients[1])
      expect(spawnProcess).toHaveBeenCalledTimes(2)
      const firstProof =
        spawnProcess.mock.calls[0]?.[2].env[DESKTOP_BOOTSTRAP_PROOF_ENVIRONMENT_VARIABLE]
      const replacementProof =
        spawnProcess.mock.calls[1]?.[2].env[DESKTOP_BOOTSTRAP_PROOF_ENVIRONMENT_VARIABLE]
      expect(firstProof).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(replacementProof).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(replacementProof).not.toBe(firstProof)
      expect(supervisor.getDesktopBootstrapProof()).toBe(replacementProof)
      children[0]!.exit(1)
      expect(unexpected).not.toHaveBeenCalled()

      await supervisor.stop()
      expect(supervisor.getDesktopBootstrapProof()).toBeUndefined()
      expect(unexpected).not.toHaveBeenCalled()
    } finally {
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('does not detach the Windows root before native Job Object containment is used', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord)
    const spawnProcess = vi.fn<ServiceProcessSpawn>(() => serviceChild.child)
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([serviceChild], {
        platform: 'win32',
        spawnProcess,
        createControlClient: () => createControlClient()
      })
    )
    try {
      await supervisor.start()
      expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ detached: false, windowsHide: true })
    } finally {
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('keeps stdin open after token delivery and closes it for graceful shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord)
    const terminateContainment = vi.fn().mockResolvedValue(undefined)
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([serviceChild], {
        spawnProcess: () => serviceChild.child,
        createControlClient: () => createControlClient(),
        terminateContainment
      })
    )
    try {
      await supervisor.start()
      expect(serviceChild.receivedInput).toEqual(['0123456789abcdef0123456789abcdef\n'])
      expect(serviceChild.stdin.writableEnded).toBe(false)

      await expect(supervisor.stop()).resolves.toBeUndefined()
      expect(serviceChild.stdin.writableEnded).toBe(true)
      expect((serviceChild.child.kill as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
      expect(terminateContainment).not.toHaveBeenCalled()
    } finally {
      await supervisor.stop().catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('reports content-free unexpected exit status and never reports intentional stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const unexpectedChild = createServiceChild(readyRecord)
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([unexpectedChild], {
        spawnProcess: () => unexpectedChild.child,
        createControlClient: () => createControlClient()
      })
    )
    const unexpected = vi.fn()
    supervisor.onUnexpectedExit(unexpected)
    try {
      await supervisor.start()
      unexpectedChild.exit(7)
      expect(unexpected).toHaveBeenCalledWith({
        reason: 'service-process-ended',
        status: 'exited'
      })
      expect(JSON.stringify(unexpected.mock.calls)).not.toMatch(/7|token|stderr|path/)
    } finally {
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it.each(['emits an error', 'throws'] as const)(
    'uses bounded forced termination when closing the graceful stdin channel %s',
    async (failureMode) => {
      const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
      const serviceChild = createServiceChild(readyRecord, undefined, false)
      let containmentAlive = true
      const terminateContainment = vi.fn(() => {
        containmentAlive = false
        serviceChild.exit(0)
        return Promise.resolve()
      })
      const supervisor = new ServiceSupervisor(
        '/run/control.sock',
        '0123456789abcdef0123456789abcdef',
        '/bin/true',
        serviceOptions(directory),
        withFakeContainment([serviceChild], {
          platform: 'linux',
          shutdownTimeoutMs: 5,
          spawnProcess: () => serviceChild.child,
          createControlClient: () => createControlClient(),
          isContainedAlive: () => containmentAlive,
          terminateContainment
        })
      )
      const unexpected = vi.fn()
      supervisor.onUnexpectedExit(unexpected)
      try {
        await supervisor.start()
        const originalEnd = serviceChild.stdin.end.bind(serviceChild.stdin)
        vi.spyOn(serviceChild.stdin, 'end').mockImplementation((() => {
          if (failureMode === 'throws') throw new Error('private platform detail')
          serviceChild.stdin.emit('error', new Error('private stream detail'))
          return serviceChild.stdin
        }) as typeof serviceChild.stdin.end)

        await expect(supervisor.stop()).resolves.toBeUndefined()
        expect(terminateContainment).toHaveBeenCalledWith(serviceChild.child)
        expect((serviceChild.child.kill as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
        expect(unexpected).not.toHaveBeenCalled()
        originalEnd()
      } finally {
        containmentAlive = false
        await supervisor.stop().catch(() => undefined)
        await rm(directory, { force: true, recursive: true })
      }
    }
  )

  it('rejects within bounds when forced containment termination does not produce exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord, undefined, false)
    let containmentAlive = true
    const terminateContainment = vi.fn().mockResolvedValue(undefined)
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([serviceChild], {
        platform: 'linux',
        shutdownTimeoutMs: 5,
        spawnProcess: () => serviceChild.child,
        createControlClient: () => createControlClient(),
        isContainedAlive: () => containmentAlive,
        terminateContainment
      })
    )
    try {
      await supervisor.start()
      const startedAt = Date.now()
      await expect(supervisor.stop()).rejects.toThrow(
        'The local control service could not be stopped'
      )
      expect(Date.now() - startedAt).toBeLessThan(250)
      expect(terminateContainment).toHaveBeenCalledOnce()
      expect(terminateContainment).toHaveBeenCalledWith(serviceChild.child)
      expect((serviceChild.child.kill as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    } finally {
      containmentAlive = false
      serviceChild.exit(0)
      await supervisor.stop().catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('rolls back intentional-exit suppression after graceful-only shutdown refusal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord, undefined, false)
    const client = createControlClient()
    const closeClient = vi.spyOn(client, 'close')
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      {
        platform: 'darwin',
        shutdownTimeoutMs: 5,
        spawnProcess: () => serviceChild.child,
        createControlClient: () => client,
        createProcessContainment: () => prepareServiceProcessContainment('darwin')
      }
    )
    const unexpected = vi.fn()
    supervisor.onUnexpectedExit(unexpected)
    try {
      await supervisor.start()

      await expect(supervisor.stop()).rejects.toThrow(
        'The local control service could not be stopped'
      )
      expect(closeClient).toHaveBeenCalledOnce()
      expect(unexpected).not.toHaveBeenCalled()

      serviceChild.exit(0)
      expect(unexpected).toHaveBeenCalledWith({
        reason: 'service-process-ended',
        status: 'exited'
      })
      await expect(supervisor.stop()).resolves.toBeUndefined()
    } finally {
      await supervisor.stop().catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('reports a root exit deferred during a failed contained-descendant shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord)
    let containedDescendantAlive = true
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([serviceChild], {
        shutdownTimeoutMs: 5,
        spawnProcess: () => serviceChild.child,
        createControlClient: () => createControlClient(),
        isContainedAlive: () => containedDescendantAlive,
        terminateContainment: vi.fn().mockResolvedValue(undefined)
      })
    )
    const unexpected = vi.fn()
    supervisor.onUnexpectedExit(unexpected)
    try {
      await supervisor.start()

      await expect(supervisor.stop()).rejects.toThrow(
        'The local control service could not be stopped'
      )
      expect(unexpected).toHaveBeenCalledOnce()
      expect(unexpected).toHaveBeenCalledWith({
        reason: 'service-process-ended',
        status: 'exited'
      })
    } finally {
      containedDescendantAlive = false
      await supervisor.stop().catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }
  })

  it.each(['EBUSY', 'EPERM'] as const)(
    'retries transient %s containment cleanup without failing a successful stop',
    async (code) => {
      const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
      const serviceChild = createServiceChild(readyRecord)
      const disposalError = Object.assign(new Error('/private/cgroup/path'), { code })
      const dispose = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(disposalError)
        .mockResolvedValueOnce(undefined)
      const containment: ServiceProcessContainment = {
        environment: { AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'test-containment' },
        dispose,
        isAlive: () =>
          Promise.resolve(
            serviceChild.child.exitCode === null && serviceChild.child.signalCode === null
          ),
        terminate: vi.fn().mockResolvedValue(undefined)
      }
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const supervisor = new ServiceSupervisor(
        '/run/control.sock',
        '0123456789abcdef0123456789abcdef',
        '/bin/true',
        serviceOptions(directory),
        {
          createProcessContainment: () => Promise.resolve(containment),
          spawnProcess: () => serviceChild.child,
          createControlClient: () => createControlClient()
        }
      )
      try {
        await supervisor.start()
        await expect(supervisor.stop()).resolves.toBeUndefined()

        expect(dispose).toHaveBeenCalledTimes(2)
        expect(log).not.toHaveBeenCalledWith(
          '[control-service] process containment cleanup is pending'
        )
      } finally {
        log.mockRestore()
        await rm(directory, { force: true, recursive: true })
      }
    }
  )

  it('retries containment cleanup after process spawn failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const disposalError = Object.assign(new Error('/private/cgroup/path'), { code: 'EBUSY' })
    const dispose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(disposalError)
      .mockResolvedValueOnce(undefined)
    const containment: ServiceProcessContainment = {
      environment: { AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'test-containment' },
      dispose,
      isAlive: vi.fn().mockResolvedValue(false),
      terminate: vi.fn().mockResolvedValue(undefined)
    }
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      {
        createProcessContainment: () => Promise.resolve(containment),
        spawnProcess: () => {
          throw new Error('/private/spawn/failure')
        }
      }
    )
    try {
      await expect(supervisor.start()).rejects.toThrow(
        'The local control service could not be started'
      )
      expect(dispose).toHaveBeenCalledTimes(2)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('retains permanent containment cleanup failure for later bounded lifecycle sweeps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord)
    const disposalError = Object.assign(new Error('/private/cgroup/path'), { code: 'EPERM' })
    const dispose = vi.fn<() => Promise<void>>().mockRejectedValue(disposalError)
    const containment: ServiceProcessContainment = {
      environment: { AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'test-containment' },
      dispose,
      isAlive: () =>
        Promise.resolve(
          serviceChild.child.exitCode === null && serviceChild.child.signalCode === null
        ),
      terminate: vi.fn().mockResolvedValue(undefined)
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      {
        createProcessContainment: () => Promise.resolve(containment),
        spawnProcess: () => serviceChild.child,
        createControlClient: () => createControlClient()
      }
    )
    try {
      await supervisor.start()
      await expect(supervisor.stop()).resolves.toBeUndefined()
      expect(dispose).toHaveBeenCalledTimes(2)

      await expect(supervisor.stop()).resolves.toBeUndefined()
      expect(dispose).toHaveBeenCalledTimes(4)
      expect(log).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith('[control-service] process containment cleanup is pending')
      expect(JSON.stringify(log.mock.calls)).not.toContain('/private')

      dispose.mockResolvedValue(undefined)
      await expect(supervisor.stop()).resolves.toBeUndefined()
      expect(dispose).toHaveBeenCalledTimes(5)
    } finally {
      log.mockRestore()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('returns success only after forced containment termination confirms process exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord, undefined, false)
    let containmentAlive = true
    const terminateContainment = vi.fn(() => {
      containmentAlive = false
      Object.assign(serviceChild.child, { signalCode: 'SIGKILL' })
      serviceChild.child.emit('exit', null, 'SIGKILL')
      return Promise.resolve()
    })
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([serviceChild], {
        platform: 'linux',
        shutdownTimeoutMs: 5,
        spawnProcess: () => serviceChild.child,
        createControlClient: () => createControlClient(),
        isContainedAlive: () => containmentAlive,
        terminateContainment
      })
    )
    const unexpected = vi.fn()
    supervisor.onUnexpectedExit(unexpected)
    try {
      await supervisor.start()
      await expect(supervisor.stop()).resolves.toBeUndefined()
      expect(terminateContainment).toHaveBeenCalledWith(serviceChild.child)
      expect((serviceChild.child.kill as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
      expect(unexpected).not.toHaveBeenCalled()
    } finally {
      await supervisor.stop().catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('uses native Windows containment without PID-based taskkill', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const serviceChild = createServiceChild(readyRecord, undefined, false)
    let containmentAlive = true
    const terminateContainment = vi.fn(() => {
      containmentAlive = false
      serviceChild.exit(0)
      return Promise.resolve()
    })
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([serviceChild], {
        platform: 'win32',
        shutdownTimeoutMs: 5,
        spawnProcess: () => serviceChild.child,
        createControlClient: () => createControlClient(),
        isContainedAlive: () => containmentAlive,
        terminateContainment
      })
    )
    try {
      await supervisor.start()
      await expect(supervisor.stop()).resolves.toBeUndefined()
      expect((serviceChild.child.kill as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
      expect(terminateContainment).toHaveBeenCalledWith(serviceChild.child)
    } finally {
      containmentAlive = false
      serviceChild.exit(0)
      await supervisor.stop().catch(() => undefined)
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('surfaces only a validated recovery record and avoids a late token write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-'))
    const recovery = {
      event: 'service.recoveryRequired',
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      category: 'corruptDatabase',
      message: 'Recovery is required.',
      migrationBackupAvailable: false
    } as const
    const child = createServiceChild(undefined, recovery)
    let tokenBytes = 0
    child.stdin.on('data', (chunk: Buffer) => {
      tokenBytes += chunk.byteLength
    })
    const supervisor = new ServiceSupervisor(
      '/run/control.sock',
      '0123456789abcdef0123456789abcdef',
      '/bin/true',
      serviceOptions(directory),
      withFakeContainment([child], { spawnProcess: () => child.child })
    )
    try {
      const start = supervisor.start()
      await expect(start).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ServiceRecoveryRequiredError &&
          error.record.event === 'service.recoveryRequired' &&
          Object.keys(error).every((key) => key === 'name' || key === 'record')
      )
      expect(tokenBytes).toBe(0)
    } finally {
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  })
})

describe('real Linux cgroup v2 containment', () => {
  it.runIf(process.platform === 'linux')(
    'kills a separate-session descendant created immediately before root loss',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'service-supervisor-real-'))
      const pidFile = join(directory, 'descendant.pid')
      const script = [
        'printf %s "$$" > "$TEST_CGROUP_PATH/cgroup.procs"',
        'IFS= read -r token',
        `printf '%s\\n' '${JSON.stringify(readyRecord)}'`,
        'IFS= read -r trigger',
        `setsid sh -c 'trap "" TERM; sleep 300 & wait' &`,
        `echo "$!" > "${pidFile}"`,
        'exit 9'
      ].join('\n')
      let root: ReturnType<typeof spawn> | undefined
      const supervisor = new ServiceSupervisor(
        '/run/control.sock',
        '0123456789abcdef0123456789abcdef',
        '/bin/true',
        serviceOptions(directory),
        {
          platform: 'linux',
          shutdownTimeoutMs: 1_000,
          spawnProcess: (_executable, _arguments, options) => {
            const marker = options.env.AGENT_WORKSPACE_SERVICE_CONTAINMENT
            if (!marker?.startsWith('linux-cgroup-v2:')) {
              throw new Error('real probe requires delegated cgroup v2')
            }
            root = spawn('/bin/sh', ['-c', script], {
              detached: true,
              env: {
                ...options.env,
                TEST_CGROUP_PATH: marker.slice('linux-cgroup-v2:'.length)
              },
              stdio: ['pipe', 'pipe', 'pipe']
            })
            return root as ReturnType<ServiceProcessSpawn>
          },
          createControlClient: () => createControlClient()
        }
      )
      let descendantPid = 0
      try {
        await supervisor.start()
        root!.stdin!.write('fork-now\n')
        await waitForFile(pidFile, 1_000)
        descendantPid = Number(readFileSync(pidFile, 'utf8').trim())
        expect(descendantPid).toBeGreaterThan(0)
        await waitForChildExit(root!, 1_000)

        await expect(supervisor.stop()).resolves.toBeUndefined()
        await expectPidsGone([descendantPid], 1_000)
      } finally {
        await supervisor.stop().catch(() => undefined)
        if (descendantPid > 0) {
          try {
            process.kill(-descendantPid, 'SIGKILL')
          } catch {
            // Probe cleanup is intentionally idempotent.
          }
        }
        await rm(directory, { force: true, recursive: true })
      }
    },
    5_000
  )
})

describe('desktop packaging', () => {
  it('ships both executable local sidecars', () => {
    const configuration = readFileSync(
      new URL('../../electron-builder.yml', import.meta.url),
      'utf8'
    )
    expect(configuration).toContain('from: ../../target/release')
    expect(configuration).toContain('to: bin')
    expect(configuration).toContain('- agent-workspace-service')
    expect(configuration).toContain('- agent-workspace-service.exe')
    expect(configuration).toContain('- agent-workspace-cli')
    expect(configuration).toContain('- agent-workspace-cli.exe')
  })
})

const readyRecord = {
  event: 'service.ready',
  application: 'agent-workspace',
  version: '0.1.0',
  protocolVersion: 1
} as const

let nextFakePid = 900_000

function createUtilitySupervisor(
  utilityRunner: NonNullable<ServiceSupervisorDependencies['utilityRunner']>
): ServiceSupervisor {
  return new ServiceSupervisor(
    '/run/control.sock',
    '0123456789abcdef0123456789abcdef',
    '/service',
    {
      stateDatabasePath: '/data/state.sqlite',
      configurationPath: '/data/config.json',
      logDirectoryPath: '/data/logs'
    },
    { utilityRunner }
  )
}

function serviceOptions(directory: string) {
  return {
    stateDatabasePath: join(directory, 'state', 'state.sqlite'),
    configurationPath: join(directory, 'config', 'configuration.json'),
    logDirectoryPath: join(directory, 'logs'),
    cliSessionFilePath: join(directory, 'runtime', 'session.json'),
    defaultWorkingDirectory: directory
  }
}

function createControlClient(): ControlClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({
      application: readyRecord.application,
      version: readyRecord.version,
      protocolVersion: readyRecord.protocolVersion,
      capabilities: [...REQUIRED_CAPABILITIES]
    }),
    close: vi.fn()
  } as unknown as ControlClient
}

function createServiceChild(
  ready?: typeof readyRecord,
  immediateRecord?: unknown,
  exitOnStdinEnd = true
): {
  child: ReturnType<ServiceProcessSpawn>
  exit(code: number): void
  receivedInput: string[]
  stdin: PassThrough
  stdout: PassThrough
} {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const receivedInput: string[] = []
  const child = Object.assign(emitter, {
    pid: nextFakePid++,
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
      Object.assign(child, { signalCode: signal })
      child.emit('exit', null, signal)
      return true
    })
  }) as unknown as ReturnType<ServiceProcessSpawn>
  if (ready) {
    let startupInput = ''
    stdin.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      receivedInput.push(text)
      startupInput += text
      if (startupInput.includes('\n')) stdout.write(`${JSON.stringify(ready)}\n`)
    })
  }
  if (exitOnStdinEnd) {
    stdin.once('finish', () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      Object.assign(child, { exitCode: 0, signalCode: null })
      child.emit('exit', 0, null)
    })
  }
  if (immediateRecord) {
    setImmediate(() => stdout.write(`${JSON.stringify(immediateRecord)}\n`))
  }
  return {
    child,
    exit: (code) => {
      Object.assign(child, { exitCode: code, signalCode: null })
      child.emit('exit', code, null)
    },
    receivedInput,
    stdin,
    stdout
  }
}

function withFakeContainment(
  _children: readonly ReturnType<typeof createServiceChild>[],
  dependencies: ServiceSupervisorDependencies & {
    isContainedAlive?: () => boolean | Promise<boolean>
    terminateContainment?: (child: ReturnType<ServiceProcessSpawn>) => Promise<void>
  }
): ServiceSupervisorDependencies {
  return {
    ...dependencies,
    createProcessContainment:
      dependencies.createProcessContainment ??
      (() =>
        Promise.resolve({
          environment: { AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'test-containment' },
          dispose: vi.fn().mockResolvedValue(undefined),
          isAlive: async (child) => {
            if (dependencies.isContainedAlive) {
              return dependencies.isContainedAlive()
            }
            return child.exitCode === null && child.signalCode === null
          },
          terminate: async (child) => {
            if (dependencies.terminateContainment) {
              await dependencies.terminateContainment(child)
              return
            }
            child.kill('SIGKILL')
          }
        }))
  }
}

function fakeContainment(
  fixture: ReturnType<typeof createServiceChild>
): ServiceProcessContainment {
  return {
    environment: { AGENT_WORKSPACE_SERVICE_CONTAINMENT: 'test-containment' },
    dispose: vi.fn().mockResolvedValue(undefined),
    isAlive: () =>
      Promise.resolve(fixture.child.exitCode === null && fixture.child.signalCode === null),
    terminate: () => {
      fixture.child.kill('SIGKILL')
      return Promise.resolve()
    }
  }
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('probe root exit timed out')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      if (readFileSync(path, 'utf8').trim()) return
    } catch {
      // The root publishes the descendant identity after the final-interval fork.
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('probe identity file timed out')
}

async function expectPidsGone(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (pids.every((pid) => !pidIsAlive(pid))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(pids.filter(pidIsAlive)).toEqual([])
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
