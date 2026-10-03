import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith('--') || value === undefined)
    throw new Error('Expected --name value arguments.')
  values.set(key, value)
}

const executable = required('--executable')
const cli = required('--cli')
const cliEntry = values.get('--cli-entry')
const platform = required('--platform')
const profileRoot = required('--profile-root')
const marker = 'TERNLINE_NATIVE_PTY_OK'
const profile = await mkdtemp(join(profileRoot, 'ternline-native-package-'))
const sessionFile = join(profile, 'runtime', 'node-cli-session.json')
let startupLog = ''
const capture = (chunk) => {
  startupLog = (startupLog + chunk.toString()).slice(-65536)
}
let application
let passed = false
const preview = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><title>Native smoke</title><main>TERNLINE_NATIVE_BROWSER_OK</main>')
})
await new Promise((resolve) => preview.listen(0, '127.0.0.1', resolve))

try {
  const session = await launch()
  const headers = { authorization: `Bearer ${session.token}` }
  await request(new URL('v1/system/identify', session.baseUrl), headers)
  await request(new URL('v1/state/snapshot', session.baseUrl), headers)
  const configuration = await request(new URL('v1/configuration', session.baseUrl), headers)
  await request(new URL('v1/configuration/update', session.baseUrl), headers, {
    expectedRevision: configuration.config.revision,
    update: { updates: { channel: 'alpha' } }
  })
  await runCli(['identify'])
  if (platform === 'windows') {
    const launcher = join(dirname(executable), 'resources', 'cli', 'ternline-cli.cmd')
    await execFileAsync(
      'cmd.exe',
      ['/d', '/s', '/c', `""${launcher}" --session-file "${sessionFile}" identify"`],
      { windowsVerbatimArguments: true, timeout: 15_000 }
    )
  }

  const command =
    platform === 'windows'
      ? ['cmd.exe', '/d', '/c', `echo ${marker}`]
      : ['sh', '-c', `printf '${marker}\\n'`]
  const created = JSON.parse(
    await runCli([
      'workspace',
      'create',
      '--name',
      'Native package smoke',
      '--working-directory',
      profile,
      '--terminal-cwd',
      profile,
      '--command',
      ...command
    ])
  )
  if (!created.terminalId || !created.workspaceId) {
    throw new Error('Workspace creation did not create a terminal runtime.')
  }
  await waitForOutput(created.terminalId)
  const address = preview.address()
  const opened = await waitForBrowser(`http://127.0.0.1:${address.port}`)
  const sessionId = opened.session?.automationSessionId
  if (!sessionId) throw new Error('Packaged browser did not create an automation session.')
  await runCli([
    'browser',
    'wait',
    '--session-id',
    sessionId,
    '--text',
    'TERNLINE_NATIVE_BROWSER_OK'
  ])
  await stop(application)
  const restarted = await launch(session.token)
  const restoredConfiguration = await request(new URL('v1/configuration', restarted.baseUrl), {
    authorization: `Bearer ${restarted.token}`
  })
  if (restoredConfiguration.config.updates.channel !== 'alpha') {
    throw new Error('Alpha update selection did not persist across application restart.')
  }
  const restored = JSON.parse(await runCli(['workspace', 'list']))
  if (!restored.snapshot.workspaces.some((workspace) => workspace.id === created.workspaceId)) {
    throw new Error('Workspace did not persist across packaged application restart.')
  }
  passed = true
  process.stdout.write(`native package smoke passed for ${platform}\n`)
} finally {
  if (!passed) {
    process.stderr.write(startupLog)
  }
  await stop(application)
  await new Promise((resolve) => preview.close(resolve))
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

function required(name) {
  const value = values.get(name)
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function launch(previousToken) {
  application = spawn(executable, [`--user-data-dir=${profile}`, '--disable-gpu'], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENT_WORKSPACE_DEBUG_STARTUP: '1',
      ...(platform === 'linux'
        ? {
            XDG_RUNTIME_DIR: join(profile, 'runtime'),
            DBUS_SESSION_BUS_ADDRESS: ''
          }
        : {})
    }
  })
  application.stdout.on('data', capture)
  application.stderr.on('data', capture)
  application.on('error', (error) => capture(String(error)))
  return waitForSession(sessionFile, previousToken)
}

async function waitForSession(path, previousToken) {
  let lastError
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const session = JSON.parse(await readFile(path, 'utf8'))
      if (
        typeof session.baseUrl === 'string' &&
        typeof session.token === 'string' &&
        session.token !== previousToken
      )
        return session
      lastError = new Error('Session file is incomplete.')
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for native session file: ${String(lastError)}`)
}

async function request(url, headers, body) {
  const response = await fetch(url, {
    headers: { ...headers, 'content-type': 'application/json' },
    method: body ? 'POST' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000)
  })
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`)
  return response.json()
}

async function runCli(args) {
  const command = cliEntry
    ? [cliEntry, '--session-file', sessionFile, ...args]
    : ['--session-file', sessionFile, ...args]
  const { stdout } = await execFileAsync(cli, command, {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, ...(platform === 'windows' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
  })
  return stdout
}

async function waitForOutput(terminalId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const output = await runCli(['terminal', 'read', '--terminal-id', terminalId, '--lines', '30'])
    if (output.includes(marker)) return
    await delay(250)
  }
  throw new Error('Terminal did not return the expected PTY output.')
}

async function waitForBrowser(url) {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      return JSON.parse(await runCli(['browser', 'open', '--url', url]))
    } catch (error) {
      if (!error.stderr?.includes('[provider_unavailable]') || Date.now() >= deadline) throw error
    }
    await delay(250)
  }
}

async function stop(child) {
  if (!child?.pid) return
  if (process.platform === 'linux') {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      return
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(250)
      if (child.exitCode !== null || child.signalCode !== null) break
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(
      () => undefined
    )
    return
  }
  try {
    child.kill('SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await delay(250)
  }
  try {
    child.kill('SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
