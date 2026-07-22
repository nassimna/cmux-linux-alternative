import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { closeElectronApplication } from '../e2e/helpers/close-electron-application.mjs'

test('graceful close succeeds without force-killing', async () => {
  const fixture = applicationFixture(async ({ childProcess }) => {
    childProcess.exitCode = 0
  })

  await closeElectronApplication(fixture.application, {}, fixture.dependencies)

  assert.equal(fixture.closeCalls, 1)
  assert.deepEqual(fixture.groupKills, [])
  assert.deepEqual(fixture.childKills, [])
  assert.equal(fixture.childProcess.listenerCount('exit'), 0)
})

test('graceful close timeout force-kills the process group and fails', async () => {
  const fixture = applicationFixture(() => new Promise(() => undefined), {
    timerActions: ['fire', 'exit']
  })

  await assert.rejects(
    closeElectronApplication(fixture.application, {}, fixture.dependencies),
    /graceful shutdown timed out after 3000ms/u
  )

  assert.deepEqual(fixture.groupKills, [[-4172, 'SIGKILL']])
  assert.deepEqual(fixture.childKills, [])
  assert.equal(fixture.childProcess.listenerCount('exit'), 0)
})

test('close rejection still force-cleans the process and fails', async () => {
  const fixture = applicationFixture(
    () => Promise.reject(new Error('browser process disconnected')),
    { timerActions: ['noop', 'exit'] }
  )

  await assert.rejects(
    closeElectronApplication(fixture.application, {}, fixture.dependencies),
    /graceful shutdown rejected \(browser process disconnected\)/u
  )

  assert.deepEqual(fixture.groupKills, [[-4172, 'SIGKILL']])
  assert.equal(fixture.childProcess.listenerCount('exit'), 0)
})

test('an already-exited application needs no close or kill', async () => {
  const fixture = applicationFixture(() => Promise.reject(new Error('must not close')))
  fixture.childProcess.exitCode = 0

  await closeElectronApplication(fixture.application, {}, fixture.dependencies)

  assert.equal(fixture.closeCalls, 0)
  assert.deepEqual(fixture.groupKills, [])
  assert.deepEqual(fixture.childKills, [])
  assert.equal(fixture.childProcess.listenerCount('exit'), 0)
})

test('Windows force-kills the child instead of a Unix process group', async () => {
  const fixture = applicationFixture(() => Promise.reject(new Error('close failed')), {
    platform: 'win32',
    timerActions: ['noop', 'exit']
  })

  await assert.rejects(closeElectronApplication(fixture.application, {}, fixture.dependencies))

  assert.deepEqual(fixture.groupKills, [])
  assert.deepEqual(fixture.childKills, ['SIGKILL'])
  assert.equal(fixture.childProcess.listenerCount('exit'), 0)
})

test('Unix group-kill failure falls back to the exact child process', async () => {
  const fixture = applicationFixture(() => Promise.reject(new Error('close failed')), {
    groupKillError: new Error('no process group'),
    timerActions: ['noop', 'exit']
  })

  await assert.rejects(closeElectronApplication(fixture.application, {}, fixture.dependencies))

  assert.deepEqual(fixture.groupKills, [[-4172, 'SIGKILL']])
  assert.deepEqual(fixture.childKills, ['SIGKILL'])
  assert.equal(fixture.childProcess.listenerCount('exit'), 0)
})

test('forced-exit timeout removes its listener and reports cleanup failure', async () => {
  const fixture = applicationFixture(() => Promise.reject(new Error('close failed')), {
    timerActions: ['noop', 'fire']
  })

  await assert.rejects(
    closeElectronApplication(fixture.application, {}, fixture.dependencies),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /Forced process cleanup also failed/u)
      assert.match(error.errors[1].message, /did not exit within 2000ms/u)
      return true
    }
  )

  assert.equal(fixture.childProcess.listenerCount('exit'), 0)
})

function applicationFixture(close, options = {}) {
  const childProcess = new EventEmitter()
  childProcess.exitCode = null
  childProcess.signalCode = null
  childProcess.pid = 4172
  const childKills = []
  const groupKills = []
  let closeCalls = 0
  let timerIndex = 0

  childProcess.kill = (signal) => {
    childKills.push(signal)
    return true
  }

  return {
    application: {
      close: () => {
        closeCalls += 1
        return close({ childProcess })
      },
      process: () => childProcess
    },
    childProcess,
    childKills,
    get closeCalls() {
      return closeCalls
    },
    dependencies: {
      clearTimeout: () => undefined,
      killProcess: (pid, signal) => {
        groupKills.push([pid, signal])
        if (options.groupKillError) throw options.groupKillError
      },
      platform: options.platform ?? 'linux',
      setTimeout: (callback) => {
        const action = options.timerActions?.[timerIndex]
        timerIndex += 1
        globalThis.queueMicrotask(() => {
          if (action === 'exit') {
            childProcess.signalCode = 'SIGKILL'
            childProcess.emit('exit', null, 'SIGKILL')
          } else if (action === 'fire') {
            callback()
          }
        })
        return timerIndex
      }
    },
    groupKills
  }
}
