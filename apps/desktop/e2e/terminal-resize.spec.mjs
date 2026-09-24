import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { closeElectronApplication } from './helpers/close-electron-application.mjs'
import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const serviceBinary = join(repositoryDirectory, 'target/debug/agent-workspace-service')
const mainEntry = join(desktopDirectory, 'out/main/index.js')
const evidenceDirectory = process.env.AGENT_WORKSPACE_EVIDENCE_DIR

async function observeResizeColumns(page) {
  await page.evaluate(() => {
    globalThis.__resizeTestColumns = []
    globalThis.desktopBridge.onTerminalEvent((event) => {
      if (event.event === 'terminal.resized') {
        globalThis.__resizeTestColumns.push(event.data.cols)
      }
    })
  })
  return () => page.evaluate(() => globalThis.__resizeTestColumns.at(-1))
}

test.skip(process.platform !== 'linux', 'The packaged terminal fixture currently runs on Linux.')

test.beforeAll(async () => {
  test.setTimeout(120_000)
  execFileSync('cargo', ['build', '-p', 'agent-workspace-service'], {
    cwd: repositoryDirectory,
    stdio: 'pipe'
  })
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'pipe'
  })
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true })
})

test('retains output and synchronizes the PTY through narrow and wide resizes', async () => {
  test.setTimeout(90_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-resize-e2e-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated resize test shell.\n')
  let application

  try {
    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
    const electronEnvironment = { ...process.env }
    delete electronEnvironment.ELECTRON_RUN_AS_NODE
    application = await electron.launch({
      args: [mainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...electronEnvironment,
        ...harness.electronEnvironment,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      }
    })
    const page = await application.firstWindow()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const terminal = page.locator('.terminal-pane')
    const output = page.locator('.xterm-rows')
    const input = page.locator('.xterm-helper-textarea')
    const setSize = async (width, height) => {
      await application.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
        },
        { width, height }
      )
      await page.setViewportSize({ width, height })
    }
    const send = async (command) => {
      await input.focus()
      await page.keyboard.type(command)
      await page.keyboard.press('Enter')
    }
    const latestSize = async () => {
      const text = await output.innerText()
      const sizes = [...text.matchAll(/SIZE:(\d+) (\d+)/g)]
      return sizes.at(-1)?.slice(1).map(Number)
    }
    const countOutput = async () => (await output.innerText()).match(/Z/g)?.length ?? 0
    await setSize(1200, 800)
    await expect(terminal).toHaveAttribute('data-process-id', /^\d+$/)
    const serviceColumns = await observeResizeColumns(page)
    await send("printf 'SIZE:'; stty size")
    await expect.poll(latestSize).toMatchObject([expect.any(Number), expect.any(Number)])
    const initialSize = await latestSize()
    const initialCharacters = await countOutput()

    await send("printf '%0200d' 0 | tr 0 Z; sleep 60")
    await expect.poll(countOutput).toBe(initialCharacters + 201)
    const outputCharacters = await countOutput()

    await setSize(700, 700)
    await expect.poll(serviceColumns).toBeLessThan(initialSize[1])
    await expect.poll(countOutput).toBe(outputCharacters)
    if (evidenceDirectory) {
      await page.screenshot({ path: join(evidenceDirectory, 'terminal-resize-narrow.png') })
    }
    await input.focus()
    await page.keyboard.press('Control+C')
    await send("printf 'SIZE:'; stty size")
    await expect.poll(async () => (await latestSize())?.[1]).toBeLessThan(initialSize[1])
    const narrowSize = await latestSize()

    await setSize(1200, 800)
    await expect.poll(serviceColumns).toBeGreaterThan(narrowSize[1])
    await send("printf 'SIZE:'; stty size")
    await expect.poll(async () => (await latestSize())?.[1]).toBeGreaterThan(narrowSize[1])
    await send("printf 'SHELL_OK\\n'")
    await expect(output).toContainText('SHELL_OK')
    const longInput = 'a'.repeat(100)
    await setSize(700, 700)
    await input.focus()
    await page.keyboard.type(`printf 'INPUT_OK:%s\\n' '${longInput}'`)
    await setSize(1200, 800)
    await page.keyboard.press('Enter')
    await expect(output).toContainText(`INPUT_OK:${longInput}`)
    if (evidenceDirectory) {
      await page.screenshot({ path: join(evidenceDirectory, 'terminal-resize-wide.png') })
    }
    expect(pageErrors).toEqual([])
  } finally {
    await closeElectronApplication(application).catch(() => undefined)
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('forwards narrow and wide resizes to a real SSH session', async () => {
  test.skip(!existsSync('/usr/bin/sshd'), 'The isolated OpenSSH server is unavailable.')
  test.setTimeout(90_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-ssh-resize-e2e-'))
  const hostname = '127.0.0.1'
  const user = userInfo().username
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, hostname, resolve))
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  let server
  let application

  try {
    await writeFile(join(profileDirectory, '.zshrc'), '# Isolated SSH resize test shell.\n')
    const hostKey = join(profileDirectory, 'host_key')
    const clientKey = join(profileDirectory, 'client_key')
    execFileSync('ssh-keygen', ['-q', '-N', '', '-t', 'ed25519', '-f', hostKey])
    execFileSync('ssh-keygen', ['-q', '-N', '', '-t', 'ed25519', '-f', clientKey])
    await writeFile(join(profileDirectory, 'authorized_keys'), await readFile(`${clientKey}.pub`))
    const serverConfig = join(profileDirectory, 'sshd_config')
    await writeFile(
      serverConfig,
      `Port ${port}\nListenAddress ${hostname}\nHostKey ${hostKey}\nPidFile ${join(profileDirectory, 'sshd.pid')}\nAuthorizedKeysFile ${join(profileDirectory, 'authorized_keys')}\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${user}\n`
    )
    const clientConfig = join(profileDirectory, 'ssh_config')
    await writeFile(
      clientConfig,
      `Host resize-fixture\n  HostName ${hostname}\n  User ${user}\n  Port ${port}\n  IdentityFile ${clientKey}\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking no\n  UserKnownHostsFile ${join(profileDirectory, 'known_hosts')}\n`
    )
    server = spawn('/usr/bin/sshd', ['-D', '-e', '-f', serverConfig], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let serverError = ''
    server.stderr.on('data', (chunk) => {
      serverError += chunk.toString()
    })
    await expect
      .poll(async () => {
        if (server.exitCode !== null) throw new Error(`OpenSSH exited: ${serverError}`)
        return new Promise((resolve) => {
          const socket = createConnection(port, hostname)
          socket.once('connect', () => {
            socket.end()
            resolve(true)
          })
          socket.once('error', () => resolve(false))
        })
      })
      .toBe(true)

    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
    const electronEnvironment = { ...process.env }
    delete electronEnvironment.ELECTRON_RUN_AS_NODE
    application = await electron.launch({
      args: [mainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...electronEnvironment,
        ...harness.electronEnvironment,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      }
    })
    const page = await application.firstWindow()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const input = page.locator('.xterm-helper-textarea')
    const output = page.locator('.xterm-rows')
    const setSize = async (width, height) => {
      await application.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
        },
        { width, height }
      )
      await page.setViewportSize({ width, height })
    }
    const remoteSizes = async () =>
      [...(await output.innerText()).matchAll(/REMOTE_SIZE:(\d+) (\d+)/g)].map((match) =>
        match.slice(1).map(Number)
      )
    await setSize(1200, 800)
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    const serviceColumns = await observeResizeColumns(page)
    await input.focus()
    await page.keyboard.type(`ssh -tt -F ${clientConfig} resize-fixture`)
    await page.keyboard.press('Enter')
    await expect.poll(() => serverError.includes('Accepted publickey')).toBe(true)
    await page.waitForTimeout(300)
    await input.focus()
    await page.keyboard.type('while :; do printf REMOTE_SIZE:; stty size; sleep 0.2; done')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await remoteSizes()).length).toBeGreaterThan(0)
    const initialSize = (await remoteSizes()).at(-1)

    await setSize(700, 700)
    await expect.poll(serviceColumns).toBeLessThan(initialSize[1])
    await expect.poll(async () => (await remoteSizes()).at(-1)?.[1]).toBeLessThan(initialSize[1])
    const narrowSize = (await remoteSizes()).at(-1)
    if (evidenceDirectory) {
      await page.screenshot({ path: join(evidenceDirectory, 'terminal-resize-ssh-narrow.png') })
    }

    await setSize(1200, 800)
    await expect.poll(serviceColumns).toBeGreaterThan(narrowSize[1])
    await expect.poll(async () => (await remoteSizes()).at(-1)?.[1]).toBeGreaterThan(narrowSize[1])
    if (evidenceDirectory) {
      await page.screenshot({ path: join(evidenceDirectory, 'terminal-resize-ssh-wide.png') })
    }
    await input.focus()
    await page.keyboard.press('Control+C')
    expect(pageErrors).toEqual([])
  } finally {
    await closeElectronApplication(application).catch(() => undefined)
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        new Promise((resolve) => globalThis.setTimeout(resolve, 2000))
      ])
    }
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 3 })
  }
})
