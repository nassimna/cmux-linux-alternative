import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'

import { chromium, expect, test } from '@playwright/test'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const packagedExecutable = join(repositoryDirectory, 'release', 'linux-unpacked', 'agent-workspace')
const rendererUrl = 'agent-workspace://renderer/index.html'

const reserveLoopbackPort = async () => {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a CDP port.')
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise()))
  )
  return address.port
}

const readCdpVersion = (endpoint) =>
  new Promise((resolvePromise, reject) => {
    const request = get(`${endpoint}/json/version`, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`CDP discovery returned HTTP ${response.statusCode}.`))
          return
        }

        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString()))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.once('error', reject)
    request.setTimeout(1_000, () => request.destroy(new Error('CDP discovery timed out.')))
  })

const waitForCdp = async (endpoint, application, output) => {
  const deadline = Date.now() + 20_000
  let lastError

  while (Date.now() < deadline) {
    if (application.exitCode !== null) {
      throw new Error(
        `Packaged application exited with code ${application.exitCode}.\n${output.join('')}`
      )
    }

    try {
      if ((await readCdpVersion(endpoint)).webSocketDebuggerUrl) return
      lastError = new Error('CDP discovery did not include a WebSocket URL.')
    } catch (error) {
      lastError = error
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }

  throw new Error(`CDP did not become ready at ${endpoint}: ${lastError}\n${output.join('')}`)
}

const stopProcessTree = async (application) => {
  if (!application?.pid) return

  const signalGroup = (signal) => {
    try {
      process.kill(-application.pid, signal)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  const waitForGroupExit = async (timeout) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        process.kill(-application.pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return true
        throw error
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
    return false
  }

  if (!signalGroup('SIGTERM')) return
  if (!(await waitForGroupExit(5_000))) {
    signalGroup('SIGKILL')
    if (!(await waitForGroupExit(5_000))) {
      throw new Error(`Packaged application process group ${application.pid} did not exit.`)
    }
  }
}

test.beforeAll(() => {
  test.setTimeout(180_000)
  if (process.platform !== 'linux') return
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Packaged Electron E2E needs an X11 or Wayland display.')
  }
  execFileSync('pnpm', ['package:linux:dir'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
})

test('packaged launch ignores development renderer, service, and endpoint overrides', async () => {
  // This flow has independent 20s CDP, 15s renderer, and 10s teardown bounds. Keep the
  // individual failure deadlines strict while allowing their worst-case sequence to complete.
  test.setTimeout(60_000)
  test.skip(process.platform !== 'linux', 'The unpacked application regression is Linux-specific.')
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-packaged-e2e-'))
  const runtimeDirectory = join(profileDirectory, 'runtime')
  const hostileEndpoint = join(profileDirectory, 'hostile', 'control.sock')
  const trustedEndpoint = join(runtimeDirectory, 'agent-workspace', 'control.sock')
  const cdpPort = await reserveLoopbackPort()
  const cdpEndpoint = `http://127.0.0.1:${cdpPort}`
  const applicationOutput = []
  const pageErrors = []
  let application
  let browser

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated packaged Electron E2E shell.\n')

  try {
    application = spawn(
      packagedExecutable,
      [
        `--remote-debugging-port=${cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        '--in-process-gpu',
        `--user-data-dir=${profileDirectory}`
      ],
      {
        detached: true,
        env: {
          ...process.env,
          AGENT_WORKSPACE_SERVICE_PATH: '/tmp/untrusted',
          AGENT_WORKSPACE_SOCKET: hostileEndpoint,
          ELECTRON_RENDERER_URL: 'data:text/html,<title>Untrusted renderer</title>',
          HOME: profileDirectory,
          XDG_RUNTIME_DIR: runtimeDirectory,
          ZDOTDIR: profileDirectory
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    application.stdout.on('data', (chunk) => applicationOutput.push(chunk.toString()))
    application.stderr.on('data', (chunk) => applicationOutput.push(chunk.toString()))

    await waitForCdp(cdpEndpoint, application, applicationOutput)
    browser = await chromium.connectOverCDP(cdpEndpoint)
    const context = browser.contexts()[0]
    await expect
      .poll(() => context.pages().find((candidate) => candidate.url() === rendererUrl), {
        message: `Expected packaged renderer ${rendererUrl}`,
        timeout: 15_000
      })
      .not.toBeUndefined()

    const rendererPage = context.pages().find((candidate) => candidate.url() === rendererUrl)
    expect(rendererPage).toBeDefined()
    rendererPage.on('pageerror', (error) => pageErrors.push(error.message))
    rendererPage.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })

    expect(rendererPage.url()).toBe(rendererUrl)
    await expect(rendererPage.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    await access(trustedEndpoint)
    await expect(access(hostileEndpoint)).rejects.toThrow()
    expect(pageErrors).toEqual([])
  } finally {
    await browser?.close().catch(() => undefined)
    try {
      await stopProcessTree(application)
    } finally {
      await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
    }
  }
})
