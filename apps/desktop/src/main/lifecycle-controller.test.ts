/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest'

import type { ControlClient } from './control-client'
import { desktopMessages } from '../shared/desktop-messages'
import { LifecycleController, type LifecycleSupervisor } from './lifecycle-controller'
import { ServiceRecoveryRequiredError, type UnexpectedServiceExit } from './service-supervisor'

const client = (name: string): ControlClient => ({ name }) as unknown as ControlClient

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve: (value: T) => resolve?.(value) }
}

function supervisorFixture() {
  let unexpected: ((event: UnexpectedServiceExit) => void) | undefined
  const supervisor: LifecycleSupervisor = {
    start: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    onUnexpectedExit: vi.fn((listener) => {
      unexpected = listener
      return vi.fn()
    })
  }
  return {
    supervisor,
    emitUnexpected: () => unexpected?.({ reason: 'service-process-ended', status: 'exited' })
  }
}

describe('LifecycleController', () => {
  it('transitions from starting to ready and binds the current client', async () => {
    const fixture = supervisorFixture()
    const readyClient = client('ready')
    vi.mocked(fixture.supervisor.start).mockResolvedValue(readyClient)
    const bind = vi.fn()
    const controller = new LifecycleController(fixture.supervisor, { bind, unbind: vi.fn() })

    expect(controller.getState()).toEqual({ status: 'starting' })
    await controller.initialize()

    expect(controller.getState()).toEqual({ status: 'ready' })
    expect(controller.getClient()).toBe(readyClient)
    expect(bind).toHaveBeenCalledWith(readyClient)
  })

  it('caps automatic recovery at three deterministic attempts and unbinds immediately', async () => {
    const fixture = supervisorFixture()
    vi.mocked(fixture.supervisor.start).mockResolvedValue(client('initial'))
    vi.mocked(fixture.supervisor.restart).mockRejectedValue(new Error('unavailable'))
    const unbind = vi.fn()
    const delay = vi.fn().mockResolvedValue(undefined)
    const controller = new LifecycleController(fixture.supervisor, {
      bind: vi.fn(),
      unbind,
      delay,
      delaysMs: [100, 300, 900]
    })
    const states: string[] = []
    controller.onStateChanged((state) => states.push(state.status))
    await controller.initialize()

    fixture.emitUnexpected()
    expect(unbind).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(controller.getState().status).toBe('failed'))

    expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 300, 900])
    expect(fixture.supervisor.restart).toHaveBeenCalledTimes(3)
    expect(states.filter((state) => state === 'recovering')).toHaveLength(3)
    expect(controller.getState()).toEqual({
      status: 'failed',
      message: desktopMessages.lifecycleController.restartFailed
    })
  })

  it('stops retries on typed recovery-required startup and removes private path data', async () => {
    const fixture = supervisorFixture()
    vi.mocked(fixture.supervisor.start).mockResolvedValue(client('initial'))
    vi.mocked(fixture.supervisor.restart).mockRejectedValue(
      new ServiceRecoveryRequiredError({
        event: 'service.recoveryRequired',
        application: 'agent-workspace',
        version: '1.0.0',
        protocolVersion: 1,
        category: 'corruptDatabase',
        message: '/private/raw/service/error',
        migrationBackupAvailable: true,
        migrationBackupPath: '/private/backup.sqlite'
      })
    )
    const controller = new LifecycleController(fixture.supervisor, {
      bind: vi.fn(),
      unbind: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined)
    })
    await controller.initialize()

    fixture.emitUnexpected()
    await vi.waitFor(() => expect(controller.getState().status).toBe('recoveryRequired'))

    expect(fixture.supervisor.restart).toHaveBeenCalledTimes(1)
    expect(controller.getState()).not.toHaveProperty('recovery.migrationBackupPath')
    expect(controller.getState()).toHaveProperty('recovery.migrationBackupAvailable', true)
    expect(controller.getState()).toHaveProperty(
      'recovery.message',
      desktopMessages.lifecycleController.recoveryRequired
    )
    expect(JSON.stringify(controller.getState())).not.toContain('/private')
  })

  it('preserves a false migration backup availability signal without exposing a path', async () => {
    const fixture = supervisorFixture()
    vi.mocked(fixture.supervisor.start).mockRejectedValue(
      new ServiceRecoveryRequiredError({
        event: 'service.recoveryRequired',
        application: 'agent-workspace',
        version: '1.0.0',
        protocolVersion: 1,
        category: 'corruptDatabase',
        message: 'Recovery is required.',
        migrationBackupAvailable: false
      })
    )
    const controller = new LifecycleController(fixture.supervisor, {
      bind: vi.fn(),
      unbind: vi.fn()
    })

    await controller.initialize()

    expect(controller.getState()).toHaveProperty('recovery.migrationBackupAvailable', false)
    expect(controller.getState()).not.toHaveProperty('recovery.migrationBackupPath')
  })

  it('serializes manual restart behind automatic cancellation without stale state winning', async () => {
    const fixture = supervisorFixture()
    const replacement = client('replacement')
    vi.mocked(fixture.supervisor.start).mockResolvedValue(client('initial'))
    vi.mocked(fixture.supervisor.restart).mockResolvedValue(replacement)
    let releaseDelay: (() => void) | undefined
    const delay = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDelay = resolve
        })
    )
    const controller = new LifecycleController(fixture.supervisor, {
      bind: vi.fn(),
      unbind: vi.fn(),
      delay
    })
    await controller.initialize()

    fixture.emitUnexpected()
    await vi.waitFor(() => expect(delay).toHaveBeenCalledTimes(1))
    const manual = controller.restart()
    releaseDelay?.()
    await manual

    expect(fixture.supervisor.restart).toHaveBeenCalledTimes(1)
    expect(controller.getClient()).toBe(replacement)
    expect(controller.getState()).toEqual({ status: 'ready' })
  })

  it('ignores a stale initial completion after a newer manual generation begins', async () => {
    const fixture = supervisorFixture()
    let resolveInitial: ((value: ControlClient) => void) | undefined
    vi.mocked(fixture.supervisor.start).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve
        })
    )
    const current = client('current')
    vi.mocked(fixture.supervisor.restart).mockResolvedValue(current)
    const bind = vi.fn()
    const controller = new LifecycleController(fixture.supervisor, { bind, unbind: vi.fn() })

    const initial = controller.initialize()
    const manual = controller.restart()
    await vi.waitFor(() => expect(resolveInitial).toBeTypeOf('function'))
    resolveInitial?.(client('stale'))
    await Promise.all([initial, manual])

    expect(bind).toHaveBeenCalledTimes(1)
    expect(bind).toHaveBeenCalledWith(current)
    expect(controller.getClient()).toBe(current)
  })

  it('cancels an initial binding that exits before bind resolves and recovers once', async () => {
    const fixture = supervisorFixture()
    const initial = client('initial')
    const recovered = client('recovered')
    vi.mocked(fixture.supervisor.start).mockResolvedValue(initial)
    vi.mocked(fixture.supervisor.restart).mockResolvedValue(recovered)
    const initialBind = deferred<void>()
    const bind = vi.fn((boundClient: ControlClient) =>
      boundClient === initial ? initialBind.promise : Promise.resolve()
    )
    const unbind = vi.fn()
    const controller = new LifecycleController(fixture.supervisor, {
      bind,
      unbind,
      delay: vi.fn().mockResolvedValue(undefined)
    })

    const initialize = controller.initialize()
    await vi.waitFor(() => expect(bind).toHaveBeenCalledWith(initial))
    fixture.emitUnexpected()
    fixture.emitUnexpected()
    expect(controller.getClient()).toBeUndefined()

    initialBind.resolve(undefined)
    await initialize
    await vi.waitFor(() => expect(controller.getState()).toEqual({ status: 'ready' }))

    expect(controller.getClient()).toBe(recovered)
    expect(unbind).toHaveBeenCalledTimes(1)
    expect(fixture.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('treats an exit during recovery binding as a consumed bounded attempt', async () => {
    const fixture = supervisorFixture()
    const firstRecovery = client('first-recovery')
    const secondRecovery = client('second-recovery')
    vi.mocked(fixture.supervisor.start).mockResolvedValue(client('initial'))
    vi.mocked(fixture.supervisor.restart)
      .mockResolvedValueOnce(firstRecovery)
      .mockResolvedValueOnce(secondRecovery)
    const recoveryBind = deferred<void>()
    const bind = vi.fn((boundClient: ControlClient) =>
      boundClient === firstRecovery ? recoveryBind.promise : Promise.resolve()
    )
    const unbind = vi.fn()
    const controller = new LifecycleController(fixture.supervisor, {
      bind,
      unbind,
      delay: vi.fn().mockResolvedValue(undefined),
      delaysMs: [0, 0, 0]
    })
    await controller.initialize()

    fixture.emitUnexpected()
    await vi.waitFor(() => expect(bind).toHaveBeenCalledWith(firstRecovery))
    fixture.emitUnexpected()
    fixture.emitUnexpected()
    recoveryBind.resolve(undefined)
    await vi.waitFor(() => expect(controller.getClient()).toBe(secondRecovery))

    expect(controller.getState()).toEqual({ status: 'ready' })
    expect(unbind).toHaveBeenCalledTimes(2)
    expect(fixture.supervisor.restart).toHaveBeenCalledTimes(2)
  })

  it('does not let stale activation cleanup cancel a newer manual client', async () => {
    const fixture = supervisorFixture()
    const initial = client('initial')
    const current = client('current')
    vi.mocked(fixture.supervisor.start).mockResolvedValue(initial)
    vi.mocked(fixture.supervisor.restart).mockResolvedValue(current)
    const initialBind = deferred<void>()
    const bind = vi.fn((boundClient: ControlClient) =>
      boundClient === initial ? initialBind.promise : Promise.resolve()
    )
    const unbind = vi.fn()
    const controller = new LifecycleController(fixture.supervisor, { bind, unbind })

    const initialize = controller.initialize()
    await vi.waitFor(() => expect(bind).toHaveBeenCalledWith(initial))
    fixture.emitUnexpected()
    const manual = controller.restart()
    initialBind.resolve(undefined)
    await Promise.all([initialize, manual])

    expect(controller.getClient()).toBe(current)
    expect(controller.getState()).toEqual({ status: 'ready' })
    expect(unbind).toHaveBeenCalledTimes(1)
    expect(fixture.supervisor.restart).toHaveBeenCalledTimes(1)
  })

  it('reconciles a failed shutdown into a content-safe retry state without a stale client', async () => {
    const fixture = supervisorFixture()
    vi.mocked(fixture.supervisor.start).mockResolvedValue(client('initial'))
    const unbind = vi.fn()
    const controller = new LifecycleController(fixture.supervisor, {
      bind: vi.fn(),
      unbind
    })
    await controller.initialize()

    await controller.reconcileShutdownFailure()

    expect(controller.getClient()).toBeUndefined()
    expect(controller.getState()).toEqual({
      status: 'failed',
      message: desktopMessages.lifecycleController.unsafeShutdown
    })
    expect(unbind).toHaveBeenCalledOnce()
    expect(JSON.stringify(controller.getState())).not.toContain('/private')
  })

  it('uses a later service exit after shutdown failure to drive bounded recovery', async () => {
    const fixture = supervisorFixture()
    const recovered = client('recovered')
    vi.mocked(fixture.supervisor.start).mockResolvedValue(client('initial'))
    vi.mocked(fixture.supervisor.restart).mockResolvedValue(recovered)
    const bind = vi.fn()
    const controller = new LifecycleController(fixture.supervisor, {
      bind,
      unbind: vi.fn(),
      delay: vi.fn().mockResolvedValue(undefined),
      delaysMs: [0, 0, 0]
    })
    await controller.initialize()
    await controller.reconcileShutdownFailure()

    fixture.emitUnexpected()
    await vi.waitFor(() => expect(controller.getState()).toEqual({ status: 'ready' }))

    expect(fixture.supervisor.restart).toHaveBeenCalledOnce()
    expect(controller.getClient()).toBe(recovered)
    expect(bind).toHaveBeenLastCalledWith(recovered)
  })

  it('disposes a cancelled partial binding without starting recovery', async () => {
    const fixture = supervisorFixture()
    const initial = client('initial')
    vi.mocked(fixture.supervisor.start).mockResolvedValue(initial)
    const initialBind = deferred<void>()
    const unbind = vi.fn()
    const controller = new LifecycleController(fixture.supervisor, {
      bind: vi.fn(() => initialBind.promise),
      unbind,
      delay: vi.fn().mockResolvedValue(undefined)
    })

    const initialize = controller.initialize()
    await vi.waitFor(() => expect(controller.getClient()).toBe(initial))
    fixture.emitUnexpected()
    const dispose = controller.dispose()
    initialBind.resolve(undefined)
    await Promise.all([initialize, dispose])

    expect(controller.getClient()).toBeUndefined()
    expect(controller.getState()).not.toEqual({ status: 'ready' })
    expect(unbind).toHaveBeenCalledTimes(1)
    expect(fixture.supervisor.restart).not.toHaveBeenCalled()
  })
})
