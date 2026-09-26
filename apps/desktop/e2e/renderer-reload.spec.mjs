import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const mainEntry = join(desktopDirectory, 'out/main/index.js')
const rendererUrl = 'agent-workspace://renderer/index.html'
const rendererOrigin = 'agent-workspace://renderer/'
const benignExternalConsoleError = /(?:font(?:config)?|gpu|mesa|dri3|webgl)/i

test.beforeAll(() => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      'Electron E2E needs a display on Linux; run this command inside an X11/Wayland session or under Xvfb.'
    )
  }
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
})

test('renderer reload restores checkpointed output on the exact same PTY without new output', async () => {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-e2e-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated Electron E2E shell.\n')
  const consoleErrors = []
  const pageErrors = []
  const instrumentedPages = new WeakSet()
  let electronApplication

  const instrumentPage = (page) => {
    if (instrumentedPages.has(page)) {
      return
    }
    instrumentedPages.add(page)
    page.on('console', (message) => {
      if (message.type() !== 'error') {
        return
      }
      const location = message.location()
      const isRendererMessage = location.url.startsWith(rendererOrigin)
      if (!isRendererMessage && benignExternalConsoleError.test(message.text())) {
        return
      }
      consoleErrors.push(
        `${location.url || '<external>'}:${String(location.lineNumber ?? 0)} ${message.text()}`
      )
    })
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  }

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    electronApplication = await electron.launch({
      // The app falls back to xterm's DOM renderer when GPU acceleration is disabled. Its
      // `.xterm-rows` projection lets the test assert actual visible screen content.
      args: [mainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      },
      timeout: 10_000
    })
    electronApplication.on('window', instrumentPage)

    const page = await electronApplication.firstWindow()
    instrumentPage(page)
    await expect.poll(() => page.url()).toBe(rendererUrl)

    const terminalPane = page.locator('.terminal-pane')
    await expect(terminalPane).toHaveAttribute(
      'data-terminal-id',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    await expect(terminalPane).toHaveAttribute('data-process-id', /^\d+$/)
    await expect(terminalPane).toContainText('Connected')

    const terminalId = await terminalPane.getAttribute('data-terminal-id')
    const processId = await terminalPane.getAttribute('data-process-id')
    expect(terminalId).not.toBeNull()
    expect(processId).not.toBeNull()

    const uniqueSuffix = `${String(Date.now())}_${process.pid.toString(36)}`
    const marker = `AGENT_WORKSPACE_RELOAD_${uniqueSuffix}`
    const splitAt = Math.floor(marker.length / 2)
    const terminalInput = page.locator('.xterm-helper-textarea')
    await terminalInput.focus()
    // The marker is assembled by the shell, so its contiguous presence proves command output
    // reached xterm rather than merely matching the locally echoed command line.
    await terminalInput.pressSequentially(
      `printf '%s%s\\n' '${marker.slice(0, splitAt)}' '${marker.slice(splitAt)}'`
    )
    await terminalInput.press('Enter')

    const terminalRows = page.locator('.xterm-rows')
    await expect(terminalRows).toContainText(marker, { timeout: 5_000 })

    // Active output is checkpointed after five seconds. Reload only after that deadline so
    // the post-reload marker can be satisfied by checkpoint+journal reconstruction alone.
    await page.waitForTimeout(5_500)
    const reloadStartedAt = Date.now()
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 5_000 })
    await expect.poll(() => page.url()).toBe(rendererUrl)

    const reloadedTerminalPane = page.locator('.terminal-pane')
    await expect(reloadedTerminalPane).toHaveAttribute('data-terminal-id', terminalId, {
      timeout: 2_500
    })
    await expect(reloadedTerminalPane).toHaveAttribute('data-process-id', processId, {
      timeout: 2_500
    })
    // No terminal input or synthetic PTY output occurs after reload. This tight deadline is
    // evidence that the visible marker came from attach-time reconstruction.
    await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 2_500 })
    expect(
      Date.now() - reloadStartedAt,
      'reload and attach-time reconstruction latency'
    ).toBeLessThan(3_000)

    expect(consoleErrors, 'renderer/external console errors').toEqual([])
    expect(pageErrors, 'uncaught renderer page errors').toEqual([])
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})
