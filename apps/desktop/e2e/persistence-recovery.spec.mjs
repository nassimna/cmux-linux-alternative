import { execFileSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'
import { persistRecoveryEvidence } from '../scripts/recovery-evidence.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const mainEntry = join(desktopDirectory, 'out/main/index.js')
const serviceBinary = join(
  repositoryDirectory,
  'target',
  'debug',
  process.platform === 'win32' ? 'agent-workspace-service.exe' : 'agent-workspace-service'
)
const rendererUrl = 'agent-workspace://renderer/index.html'
const rendererOrigin = 'agent-workspace://renderer/'
const benignExternalConsoleError = /(?:font(?:config)?|gpu|mesa|dri3|webgl)/i
const intentionalCrashConsoleError =
  /^node:electron\/js2c\/sandbox_bundle:1 (?:Electron sandboxed_renderer\.bundle\.js script failed to run|TypeError: Cannot destructure property 'preloadScripts' of 'binding\.startupData' as it is null\.)/u

test.beforeAll(() => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Electron persistence E2E needs an X11 or Wayland display.')
  }
  execFileSync('cargo', ['build', '-p', 'agent-workspace-service'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
})

// Playwright requires an object destructuring pattern even when no browser fixture is used.
// eslint-disable-next-line no-empty-pattern
test('persists durable workspace, layout, typed configuration, and visible window bounds', async ({}) => {
  test.setTimeout(60_000)
  const profileDirectory = await createProfile('persistence')
  const configurationPath = join(profileDirectory, 'configuration', 'desktop.json')
  const errors = createErrorRecorder()
  let electronApplication

  try {
    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
    electronApplication = await launchApplication(profileDirectory, harness, errors)
    let page = await readyPage(electronApplication, errors)

    await createWorkspace(page, 'Persistent workspace', profileDirectory)
    await page.getByRole('button', { name: 'Split pane right' }).click()
    await expect(page.locator('.pane-view')).toHaveCount(2)

    const initialConfiguration = await page.evaluate(() =>
      globalThis.desktopBridge.getConfiguration()
    )
    const savedConfiguration = await page.evaluate(
      ({ density, expectedRevision }) =>
        globalThis.desktopBridge.updateConfiguration({
          expectedRevision,
          update: { appearance: { density, theme: 'light', fontFamily: 'system-ui' } }
        }),
      {
        density: initialConfiguration.config.appearance.density,
        expectedRevision: initialConfiguration.config.revision
      }
    )
    expect(savedConfiguration.config.appearance.theme).toBe('light')
    const diskConfiguration = JSON.parse(await readFile(configurationPath, 'utf8'))
    expect(diskConfiguration.appearance.theme).toBe('light')

    const geometryRequest = await electronApplication.evaluate(
      ({ BrowserWindow, screen }, trustedUrl) => {
        const window = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.getURL() === trustedUrl
        )
        if (!window) throw new Error('Expected one trusted test window')
        const workArea = screen.getDisplayMatching(window.getBounds()).workArea
        const width = Math.max(900, Math.min(1040, workArea.width - 80))
        const height = Math.max(600, Math.min(720, workArea.height - 80))
        const bounds = {
          x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 3)),
          y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 3)),
          width,
          height
        }
        window.setBounds(bounds)
        return { applied: window.getNormalBounds(), requested: bounds }
      },
      rendererUrl
    )
    expect(geometryRequest.applied).toEqual(geometryRequest.requested)
    await page.waitForTimeout(350)
    const settledBounds = await electronApplication.evaluate(({ BrowserWindow }, trustedUrl) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === trustedUrl
      )
      if (!window) throw new Error('Expected one trusted test window')
      return window.getNormalBounds()
    }, rendererUrl)
    const persistedWindowId = await page.evaluate(async () => {
      const topology = await globalThis.desktopBridge.listWindows()
      const focusedWindow = topology.windows.find(
        ({ windowId }) => windowId === topology.focusedWindowId
      )
      if (!focusedWindow) throw new Error('Focused window placement is missing')
      return focusedWindow.windowId
    })

    await electronApplication.close()
    electronApplication = undefined
    expect(JSON.parse(await readFile(configurationPath, 'utf8')).appearance.theme).toBe('light')

    const persistedWindowState = JSON.parse(
      execFileSync(
        'sqlite3',
        [
          join(profileDirectory, 'state', 'workspace.sqlite'),
          `SELECT json_payload FROM window_state WHERE window_id = '${persistedWindowId.replaceAll("'", "''")}';`
        ],
        { encoding: 'utf8' }
      )
    )
    expect(persistedWindowState).toMatchObject({
      ...settledBounds,
      maximized: false,
      fullscreen: false
    })
    expect(persistedWindowState.revision).toBeGreaterThan(0)

    electronApplication = await launchApplication(profileDirectory, harness, errors)
    page = await readyPage(electronApplication, errors)
    await expect(page.locator('.workspace-title')).toHaveText('Persistent workspace')
    await expect(page.locator('.pane-view')).toHaveCount(2)

    const restoredConfiguration = await page.evaluate(() =>
      globalThis.desktopBridge.getConfiguration()
    )
    expect(restoredConfiguration.config.appearance.theme).toBe('light')

    await page.getByRole('button', { name: 'Open settings' }).click()
    const restoredSettings = page.getByRole('dialog', { name: 'Settings' })
    await expect(restoredSettings.getByLabel('Theme')).toHaveValue('light')

    const physicalPlacement = await electronApplication.evaluate(
      ({ BrowserWindow, screen }, trustedUrl) => {
        const window = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.getURL() === trustedUrl
        )
        if (!window) throw new Error('Expected one trusted test window')
        const bounds = window.getNormalBounds()
        const visible = screen.getAllDisplays().some(({ workArea }) => {
          const width = Math.max(
            0,
            Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
              Math.max(bounds.x, workArea.x)
          )
          const height = Math.max(
            0,
            Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
              Math.max(bounds.y, workArea.y)
          )
          return width >= Math.min(120, bounds.width) && height >= Math.min(80, bounds.height)
        })
        return { bounds, visible }
      },
      rendererUrl
    )
    expect(physicalPlacement.visible).toBe(true)
    expect(physicalPlacement.bounds.width).toBeGreaterThanOrEqual(120)
    expect(physicalPlacement.bounds.height).toBeGreaterThanOrEqual(80)
    errors.assertEmpty()
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await removeProfile(profileDirectory)
  }
})

// Playwright requires an object destructuring pattern even when no browser fixture is used.
// eslint-disable-next-line no-empty-pattern
test('unexpected bundled service exit recovers durable metadata with a new terminal process', async ({}) => {
  test.skip(process.platform !== 'linux', 'Safe bundled-service discovery uses Linux /proc.')
  test.setTimeout(60_000)
  const profileDirectory = await createProfile('service-recovery')
  const errors = createErrorRecorder()
  let electronApplication

  try {
    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
    electronApplication = await launchApplication(profileDirectory, harness, errors)
    const page = await readyPage(electronApplication, errors)
    await createWorkspace(page, 'Recovery workspace', profileDirectory)

    const terminal = page.locator('.terminal-pane').first()
    await expect(terminal).toHaveAttribute('data-process-id', /^\d+$/)
    const originalProcessId = await terminal.getAttribute('data-process-id')
    expect(originalProcessId).not.toBeNull()

    await page.evaluate(() => {
      globalThis.__m5LifecycleStates = []
      globalThis.__m5LifecycleText = []
      globalThis.desktopBridge.onLifecycleState((state) => {
        globalThis.__m5LifecycleStates.push(state)
      })
      const remember = () => globalThis.__m5LifecycleText.push(globalThis.document.body.innerText)
      new globalThis.MutationObserver(remember).observe(globalThis.document.body, {
        childList: true,
        subtree: true
      })
      remember()
    })

    const expectedService = join(
      dirname(harness.executablePath),
      'resources',
      'bin',
      basename(serviceBinary)
    )
    const originalServicePid = await bundledServicePid(electronApplication, expectedService)
    process.kill(originalServicePid, 'SIGKILL')

    await expect
      .poll(() =>
        page.evaluate(() =>
          globalThis.__m5LifecycleStates.some((state) => state.status === 'recovering')
        )
      )
      .toBe(true)
    await expect
      .poll(() =>
        page.evaluate(() =>
          globalThis.__m5LifecycleText.some(
            (text) =>
              text.includes('Restoring your workspace') &&
              text.includes('Live terminal processes were interrupted')
          )
        )
      )
      .toBe(true)
    await expect
      .poll(() => page.evaluate(() => globalThis.desktopBridge.getLifecycleState()), {
        timeout: 15_000
      })
      .toEqual({ status: 'ready' })
    await expect(page.locator('.workspace-title')).toHaveText('Recovery workspace')

    await expect(page.locator('.terminal-pane').first()).toHaveAttribute('data-process-id', /^\d+$/)
    const recoveredProcessId = await page
      .locator('.terminal-pane')
      .first()
      .getAttribute('data-process-id')
    expect(recoveredProcessId).not.toBe(originalProcessId)
    const recoveredServicePid = await bundledServicePid(electronApplication, expectedService)
    expect(recoveredServicePid).not.toBe(originalServicePid)
    expect(await page.locator('body').innerText()).not.toContain('survived')
    errors.assertEmpty()
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await removeProfile(profileDirectory)
  }
})

// Playwright requires an object destructuring pattern even when no browser fixture is used.
// eslint-disable-next-line no-empty-pattern
test('renderer crash reloads the trusted URL once without restarting the service or PTY', async ({}) => {
  test.setTimeout(60_000)
  const profileDirectory = await createProfile('renderer-crash')
  const errors = createErrorRecorder()
  let electronApplication

  try {
    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
    electronApplication = await launchApplication(profileDirectory, harness, errors)
    const page = await readyPage(electronApplication, errors)
    await createWorkspace(page, 'Renderer recovery workspace', profileDirectory)

    const terminal = page.locator('.terminal-pane').first()
    const terminalId = await terminal.getAttribute('data-terminal-id')
    const processId = await terminal.getAttribute('data-process-id')
    expect(terminalId).not.toBeNull()
    expect(processId).toMatch(/^\d+$/)

    const crashedWebContentsId = await electronApplication.evaluate(
      ({ BrowserWindow }, trustedUrl) => {
        const window = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.getURL() === trustedUrl
        )
        if (!window) throw new Error('Expected one trusted test window')
        globalThis.__m5RendererRecoveryLoads = 0
        window.webContents.on('did-finish-load', () => {
          globalThis.__m5RendererRecoveryLoads += 1
        })
        window.webContents.forcefullyCrashRenderer()
        return window.webContents.id
      },
      rendererUrl
    )

    await expect
      .poll(() => electronApplication.evaluate(() => globalThis.__m5RendererRecoveryLoads ?? 0))
      .toBe(1)
    await expect
      .poll(() => recoveredRendererProjection(electronApplication))
      .toEqual({
        trustedWindowCount: 1,
        webContentsId: crashedWebContentsId,
        workspaceTitle: 'Renderer recovery workspace',
        terminalId,
        processId
      })
    await delay(250)
    expect(
      await electronApplication.evaluate(() => globalThis.__m5RendererRecoveryLoads ?? 0)
    ).toBe(1)
    expect(electronApplication.process().exitCode).toBeNull()
    errors.assertEmpty({ allowIntentionalRendererCrash: true })
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await removeProfile(profileDirectory)
  }
})

// Playwright requires an object destructuring pattern even when no browser fixture is used.
// eslint-disable-next-line no-empty-pattern
test('corrupt database enters private recovery UI without mutating the source', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const profileDirectory = await createProfile('corrupt-database')
  const stateDirectory = join(profileDirectory, 'state')
  const databasePath = join(stateDirectory, 'workspace.sqlite')
  const corruptBytes = Buffer.from('M5 deterministic invalid sqlite payload\u0000\u0001', 'utf8')
  const errors = createErrorRecorder()
  let electronApplication

  try {
    await mkdir(stateDirectory, { recursive: true })
    await writeFile(databasePath, corruptBytes)
    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
    electronApplication = await launchApplication(profileDirectory, harness, errors)
    const page = await electronApplication.firstWindow()
    errors.instrument(page)
    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800)
    })
    await page.setViewportSize({ height: 800, width: 1200 })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await expect.poll(() => page.url()).toBe(rendererUrl)

    await expect(page.getByRole('heading', { name: 'Workspace recovery required' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export database' })).toBeVisible()
    const exportDiagnostics = page.getByRole('button', { name: 'Export diagnostic bundle' })
    await expect(exportDiagnostics).toBeVisible()
    await expect(exportDiagnostics).toBeDisabled()
    if (process.platform === 'linux') {
      await expect(page).toHaveScreenshot('corrupt-database-recovery.png', {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.002,
        scale: 'css'
      })
      if (process.env.AGENT_WORKSPACE_EVIDENCE_DIR !== undefined) {
        const reviewedScreenshot = await page.screenshot({
          animations: 'disabled',
          caret: 'hide',
          scale: 'css'
        })
        await persistRecoveryEvidence(process.env.AGENT_WORKSPACE_EVIDENCE_DIR, reviewedScreenshot)
      }
    }
    await page.getByRole('button', { name: 'Preview diagnostics' }).click()
    await expect(page.getByRole('heading', { name: 'Diagnostic bundle preview' })).toBeVisible()
    await expect(exportDiagnostics).toBeEnabled()

    const renderedText = await page.locator('body').innerText()
    expect(renderedText).not.toContain(profileDirectory)
    expect(renderedText).not.toContain('deterministic invalid sqlite payload')
    expect(Buffer.compare(await readFile(databasePath), corruptBytes)).toBe(0)

    const screenshotPath = testInfo.outputPath('corrupt-database-recovery.png')
    await page.screenshot({ path: screenshotPath })
    await testInfo.attach('corrupt-database-recovery', {
      path: screenshotPath,
      contentType: 'image/png'
    })
    errors.assertEmpty()
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await removeProfile(profileDirectory)
  }
})

async function createProfile(label) {
  const profileDirectory = await mkdtemp(join(tmpdir(), `agent-workspace-m5-${label}-`))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated persistence E2E shell.\n')
  return profileDirectory
}

async function removeProfile(profileDirectory) {
  await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
}

async function launchApplication(profileDirectory, harness, errors) {
  const application = await electron.launch({
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
  application.on('window', errors.instrument)
  return application
}

async function readyPage(application, errors) {
  const page = await application.firstWindow()
  errors.instrument(page)
  await expect.poll(() => page.url()).toBe(rendererUrl)
  await expect(page.locator('.terminal-pane').first()).toHaveAttribute('data-process-id', /^\d+$/)
  return page
}

async function recoveredRendererProjection(application) {
  return application.evaluate(async ({ BrowserWindow }, trustedUrl) => {
    const windows = BrowserWindow.getAllWindows().filter(
      (candidate) => candidate.webContents.getURL() === trustedUrl
    )
    const window = windows[0]
    if (!window) return null
    const projection = await window.webContents.executeJavaScript(`(() => {
      const terminal = document.querySelector('.terminal-pane')
      return {
        workspaceTitle: document.querySelector('.workspace-title')?.textContent ?? '',
        terminalId: terminal?.getAttribute('data-terminal-id') ?? null,
        processId: terminal?.getAttribute('data-process-id') ?? null
      }
    })()`)
    return {
      trustedWindowCount: windows.length,
      webContentsId: window.webContents.id,
      ...projection
    }
  }, rendererUrl)
}

async function createWorkspace(page, name, workingDirectory) {
  await page.getByRole('button', { name: 'Open folder as workspace' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Workspace folder path').fill(workingDirectory)
  await dialog.getByRole('button', { name: 'Open workspace' }).click()
  await expect(page.locator('.workspace-title')).toHaveText(basename(workingDirectory))
  await page.evaluate((workspaceName) => {
    globalThis.prompt = () => workspaceName
  }, name)
  await page.locator('.workspace-row[aria-current="page"]').dblclick()
  await expect(page.locator('.workspace-title')).toHaveText(name)
  await expect(page.locator('.terminal-pane').first()).toHaveAttribute('data-process-id', /^\d+$/)
}

function createErrorRecorder() {
  const consoleErrors = []
  const pageErrors = []
  const instrumentedPages = new WeakSet()
  return {
    instrument(page) {
      if (instrumentedPages.has(page)) return
      instrumentedPages.add(page)
      page.on('console', (message) => {
        if (message.type() !== 'error') return
        const location = message.location()
        if (
          !location.url.startsWith(rendererOrigin) &&
          benignExternalConsoleError.test(message.text())
        ) {
          return
        }
        consoleErrors.push(
          `${location.url || '<external>'}:${String(location.lineNumber ?? 0)} ${message.text()}`
        )
      })
      page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
    },
    assertEmpty({ allowIntentionalRendererCrash = false } = {}) {
      const unexpectedConsoleErrors = allowIntentionalRendererCrash
        ? consoleErrors.filter((message) => !intentionalCrashConsoleError.test(message))
        : consoleErrors
      expect(unexpectedConsoleErrors, 'renderer/external console errors').toEqual([])
      expect(pageErrors, 'uncaught renderer page errors').toEqual([])
    }
  }
}

async function bundledServicePid(application, expectedServicePath) {
  const mainPid = await application.evaluate(() => process.pid)
  const expectedExecutable = await realpath(expectedServicePath)
  await expect
    .poll(async () => {
      const childPids = await processDescendants(mainPid)
      const matches = []
      for (const childPid of childPids) {
        try {
          if ((await readlink(`/proc/${String(childPid)}/exe`)) === expectedExecutable) {
            matches.push(childPid)
          }
        } catch {
          // A short-lived Chromium helper may exit while /proc is inspected.
        }
      }
      return matches
    })
    .toHaveLength(1)

  for (const childPid of await processDescendants(mainPid)) {
    try {
      if ((await readlink(`/proc/${String(childPid)}/exe`)) === expectedExecutable) return childPid
    } catch {
      // The exact service match is rechecked below if a process exited between reads.
    }
  }
  throw new Error('The exact bundled service child disappeared during identification')
}

async function processDescendants(rootPid) {
  const statuses = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const status = await readFile(`/proc/${entry}/status`, 'utf8')
      const pid = Number.parseInt(/^Pid:\s+(\d+)$/mu.exec(status)?.[1] ?? '', 10)
      const parentPid = Number.parseInt(/^PPid:\s+(\d+)$/mu.exec(status)?.[1] ?? '', 10)
      if (Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid)) {
        statuses.push({ parentPid, pid })
      }
    } catch {
      // A process can exit between the /proc directory scan and its status read.
    }
  }

  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const { parentPid, pid } of statuses) {
      if (descendants.has(parentPid) && !descendants.has(pid)) {
        descendants.add(pid)
        changed = true
      }
    }
  }
  descendants.delete(rootPid)
  return [...descendants]
}
