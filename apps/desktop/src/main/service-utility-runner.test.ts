import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  buildUtilityEnvironment,
  parseUtilityOutput,
  ServiceUtilityRunner,
  type RuntimeSchema,
  type ServiceUtilitySpawn
} from './service-utility-runner'

const strictValueSchema: RuntimeSchema<{ value: number }> = {
  parse(value: unknown) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof (value as { value?: unknown }).value !== 'number'
    ) {
      throw new Error('invalid')
    }
    return value as { value: number }
  }
}

describe('parseUtilityOutput', () => {
  it('accepts exactly one strict JSON line and rejects extra or oversized output', () => {
    expect(parseUtilityOutput('{"value":1}\n', strictValueSchema)).toEqual({ value: 1 })
    expect(() => parseUtilityOutput('{"value":1}\nextra\n', strictValueSchema)).toThrow()
    expect(() => parseUtilityOutput('{"value":1}', strictValueSchema)).toThrow()
    expect(() => parseUtilityOutput(`${'x'.repeat(16 * 1024)}\n`, strictValueSchema)).toThrow()
  })
})

describe('ServiceUtilityRunner', () => {
  it('uses flat arguments with no stdin, no shell, and a minimal environment', async () => {
    const fixture = createUtilityChild()
    const spawnProcess = vi.fn<ServiceUtilitySpawn>(() => fixture.child)
    const runner = new ServiceUtilityRunner('/service', {
      environment: { PATH: '/untrusted', SECRET: 'not-inherited' },
      spawnProcess
    })

    const result = runner.run(
      ['recovery-inspect', '--state-db', '/state.sqlite'],
      strictValueSchema
    )
    fixture.stdout.write('{"value":2}\n')
    fixture.exit(0)

    await expect(result).resolves.toEqual({ value: 2 })
    expect(spawnProcess).toHaveBeenCalledWith(
      '/service',
      ['recovery-inspect', '--state-db', '/state.sqlite'],
      expect.objectContaining({ env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    )
  })

  it('rejects nonzero exits, extra output, and bounded timeouts without exposing stderr', async () => {
    const failedFixture = createUtilityChild()
    const failed = new ServiceUtilityRunner('/service', {
      spawnProcess: () => failedFixture.child
    }).run([], strictValueSchema)
    failedFixture.stderr.write('sensitive path and token')
    failedFixture.exit(1)
    await expect(failed).rejects.toThrow('The local service utility failed')
    await expect(failed).rejects.not.toThrow(/sensitive|token/)

    const extraFixture = createUtilityChild()
    const extra = new ServiceUtilityRunner('/service', {
      spawnProcess: () => extraFixture.child
    }).run([], strictValueSchema)
    extraFixture.stdout.write('{"value":1}\nextra\n')
    extraFixture.exit(0)
    await expect(extra).rejects.toThrow('invalid result')

    vi.useFakeTimers()
    try {
      const timeoutFixture = createUtilityChild()
      const timedOut = new ServiceUtilityRunner('/service', {
        spawnProcess: () => timeoutFixture.child,
        timeoutMs: 10
      }).run([], strictValueSchema)
      const rejection = expect(timedOut).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(510)
      await rejection
      expect(timeoutFixture.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(timeoutFixture.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes credential authority only as fd 3 with redacted fixed argv and session-bus env', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cmux-credential-runner-'))
    const executable = join(directory, 'service')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    try {
      const fixture = createUtilityChild()
      const spawnProcess = vi.fn<ServiceUtilitySpawn>(() => fixture.child)
      const runner = new ServiceUtilityRunner(executable, {
        environment: {
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
          XDG_RUNTIME_DIR: '/run/user/1000',
          HOME: '/private/home',
          SECRET: 'must-not-leak'
        },
        platform: 'linux',
        spawnProcess
      })
      const enrollmentId = '00000000-0000-4000-8000-000000000001'
      const targetId = '00000000-0000-4000-8000-000000000002'
      const result = runner.runCredential(
        '/state.sqlite',
        enrollmentId,
        targetId,
        0,
        42,
        strictValueSchema
      )
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
      fixture.stdout.write('{"value":3}\n')
      fixture.exit(0)
      await expect(result).resolves.toEqual({ value: 3 })

      const [, arguments_, options] = spawnProcess.mock.calls[0]!
      expect(arguments_).toEqual([
        'credential-enroll',
        '--state-db',
        '/state.sqlite',
        '--enrollment-id',
        enrollmentId,
        '--target-id',
        targetId,
        '--expected-revision',
        '0',
        '--key-fd',
        '3'
      ])
      expect(arguments_.join(' ')).not.toMatch(/private\/home|selected-key|SECRET/)
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe', 42])
      expect(options.env).toEqual({
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR: '/run/user/1000'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked or writable credential utility before spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cmux-untrusted-runner-'))
    const executable = join(directory, 'service')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o722)
    const spawnProcess = vi.fn<ServiceUtilitySpawn>()
    try {
      const runner = new ServiceUtilityRunner(executable, { spawnProcess })
      await expect(
        runner.runCredential(
          '/state.sqlite',
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
          0,
          42,
          strictValueSchema
        )
      ).rejects.toThrow('not trusted')
      expect(spawnProcess).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('buildUtilityEnvironment', () => {
  it('keeps PATH only for a non-absolute executable', () => {
    expect(buildUtilityEnvironment('/service', { PATH: '/bin', SECRET: 'x' }, 'linux')).toEqual({})
    expect(buildUtilityEnvironment('service', { PATH: '/bin', SECRET: 'x' }, 'linux')).toEqual({
      PATH: '/bin'
    })
  })
})

function createUtilityChild(): {
  child: ReturnType<ServiceUtilitySpawn>
  exit(code: number): void
  kill: ReturnType<typeof vi.fn>
  stderr: PassThrough
  stdout: PassThrough
} {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kill = vi.fn(() => true)
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: null,
    exitCode: null as number | null,
    signalCode: null,
    kill
  }) as unknown as ReturnType<ServiceUtilitySpawn>
  return {
    child,
    exit: (code) => {
      Object.assign(child, { exitCode: code })
      child.emit('exit', code, null)
    },
    kill,
    stderr,
    stdout
  }
}
