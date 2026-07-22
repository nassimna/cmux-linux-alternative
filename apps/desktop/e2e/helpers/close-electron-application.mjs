import process from 'node:process'

const gracefulTimeoutMs = 3_000
const forcedExitTimeoutMs = 2_000

export async function closeElectronApplication(application, options = {}, dependencies = {}) {
  if (!application) return

  const childProcess = application.process()
  if (hasExited(childProcess)) return

  const timers = {
    clearTimeout: dependencies.clearTimeout ?? globalThis.clearTimeout,
    setTimeout: dependencies.setTimeout ?? globalThis.setTimeout
  }
  const closeTimeoutMs = options.gracefulTimeoutMs ?? gracefulTimeoutMs
  const exitTimeoutMs = options.forcedExitTimeoutMs ?? forcedExitTimeoutMs
  const closeResult = await settleWithin(
    Promise.resolve().then(() => application.close()),
    closeTimeoutMs,
    timers
  )

  if (closeResult.status === 'resolved' && hasExited(childProcess)) return

  const shutdownError = describeShutdownFailure(closeResult, closeTimeoutMs)
  const cleanupErrors = []

  if (!hasExited(childProcess)) {
    try {
      forceKill(childProcess, {
        killProcess: dependencies.killProcess ?? process.kill,
        platform: dependencies.platform ?? process.platform
      })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (!hasExited(childProcess)) {
    const exited = await waitForExit(childProcess, exitTimeoutMs, timers)
    if (!exited) {
      cleanupErrors.push(
        new Error(`Packaged Electron process did not exit within ${exitTimeoutMs}ms after SIGKILL.`)
      )
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [shutdownError, ...cleanupErrors],
      `${shutdownError.message} Forced process cleanup also failed.`
    )
  }
  throw shutdownError
}

function hasExited(childProcess) {
  return childProcess.exitCode !== null || childProcess.signalCode !== null
}

async function settleWithin(promise, timeoutMs, timers) {
  let timeout
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        () => ({ status: 'resolved' }),
        (error) => ({ error, status: 'rejected' })
      ),
      new Promise((resolvePromise) => {
        timeout = timers.setTimeout(() => resolvePromise({ status: 'timed-out' }), timeoutMs)
      })
    ])
  } finally {
    if (timeout !== undefined) timers.clearTimeout(timeout)
  }
}

function describeShutdownFailure(result, timeoutMs) {
  if (result.status === 'timed-out') {
    return new Error(
      `Electron application graceful shutdown timed out after ${timeoutMs}ms; forced packaged-process cleanup was required.`
    )
  }
  if (result.status === 'rejected') {
    const reason = result.error instanceof Error ? result.error.message : String(result.error)
    return new Error(
      `Electron application graceful shutdown rejected (${reason}); forced packaged-process cleanup was required.`,
      { cause: result.error }
    )
  }
  return new Error(
    'Electron application close resolved before the packaged process exited; forced packaged-process cleanup was required.'
  )
}

function forceKill(childProcess, { killProcess, platform }) {
  if (platform === 'win32' || !childProcess.pid) {
    childProcess.kill('SIGKILL')
    return
  }

  try {
    killProcess(-childProcess.pid, 'SIGKILL')
  } catch (groupError) {
    try {
      childProcess.kill('SIGKILL')
    } catch (processError) {
      throw new AggregateError(
        [groupError, processError],
        `Unable to force-kill packaged Electron process group ${childProcess.pid}.`,
        { cause: processError }
      )
    }
  }
}

function waitForExit(childProcess, timeoutMs, timers) {
  if (hasExited(childProcess)) return Promise.resolve(true)

  return new Promise((resolvePromise) => {
    let settled = false
    let timeout
    const finish = (exited) => {
      if (settled) return
      settled = true
      childProcess.removeListener('exit', onExit)
      if (timeout !== undefined) timers.clearTimeout(timeout)
      resolvePromise(exited)
    }
    const onExit = () => finish(true)

    childProcess.once('exit', onExit)
    timeout = timers.setTimeout(() => finish(false), timeoutMs)
  })
}
