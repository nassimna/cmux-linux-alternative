import { execFile, execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'
import { seedRepresentativeRichCardSlots } from './helpers/rich-card-slots.mjs'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const mainEntry = join(desktopDirectory, 'out/main/index.js')
const cliBinary = join(repositoryDirectory, 'target/node-linux/bin/agent-workspace-node.mjs')
const rendererUrl = 'agent-workspace://renderer/index.html'
const rendererOrigin = 'agent-workspace://renderer/'
const benignExternalConsoleError = /(?:font(?:config)?|gpu|mesa|dri3|webgl)/iu
const evidenceDirectory = process.env.AGENT_WORKSPACE_EVIDENCE_DIR

test.skip(process.platform !== 'linux', 'The checked-in reference baselines are Linux-specific.')

test.beforeAll(() => {
  test.setTimeout(120_000)
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Electron visual regression needs an X11 or Wayland display.')
  }
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
})

test('project-owned workspace states match the Linux visual baseline', async () => {
  test.setTimeout(90_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-visual-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated visual regression shell.\n')
  const consoleErrors = []
  const pageErrors = []
  let electronApplication

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    const sessionFile = join(profileDirectory, 'runtime', 'node-cli-session.json')
    electronApplication = await electron.launch({
      args: [mainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TMPDIR: harness.runtimeDirectory,
        TZ: 'UTC',
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      },
      timeout: 10_000
    })
    const page = await electronApplication.firstWindow()
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const location = message.location()
      if (
        !location.url.startsWith(rendererOrigin) &&
        benignExternalConsoleError.test(message.text())
      ) {
        return
      }
      consoleErrors.push(`${location.url || '<external>'} ${message.text()}`)
    })
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`))
    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800)
    })
    await page.setViewportSize({ height: 800, width: 1200 })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })

    await expect.poll(() => page.url()).toBe(rendererUrl)
    await page.addStyleTag({
      content:
        '.xterm-screen, .terminal-process, .notification-center time, .workspace-directory { visibility: hidden !important; } .workspace-runtime-metadata { display: none !important; }'
    })
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([1200, 800])
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)

    await setTheme(page, 'dark')
    const selectedWorkspace = page.locator('.workspace-row[aria-current="page"]')
    const richCardWorkspaceId = await page.evaluate(async () => {
      const result = await globalThis.desktopBridge.listWorkspaces()
      return result.snapshot.selectedWorkspaceId
    })
    await seedRepresentativeRichCardSlots(page, richCardWorkspaceId)
    const richCards = page.getByRole('region', { name: 'Workspace card details' })
    await expect(richCards.locator(':scope > *')).toHaveCount(9)
    await expect(richCards.locator('script, img')).toHaveCount(0)
    const richCardGeometry = await richCards.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    expect(richCardGeometry.scrollWidth).toBeLessThanOrEqual(richCardGeometry.clientWidth + 1)
    await expectVisual(page, 'workspace-rich-cards-dark.png')
    const initialTerminalId = await page.locator('.terminal-pane').getAttribute('data-terminal-id')
    if (!initialTerminalId) throw new Error('Initial terminal identity is missing.')
    await selectedWorkspace.hover()
    const confirmationPromise = page.waitForEvent('dialog')
    const closePromise = page.getByRole('button', { name: 'Close Workspace 1' }).click()
    const confirmation = await confirmationPromise
    expect(confirmation.type()).toBe('confirm')
    expect(confirmation.message()).toBe('Close workspace “Workspace 1”?')
    await confirmation.accept()
    await closePromise
    await expect(page.locator('.workspace-row')).toHaveCount(1)
    await expect(page.locator('.pane-view')).toHaveCount(1)
    await expect(page.locator('.pane-view [role="tab"]')).toHaveCount(1)
    await expect(page.locator('.terminal-pane')).not.toHaveAttribute(
      'data-terminal-id',
      initialTerminalId
    )
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    await page.mouse.move(600, 400)
    await page.waitForTimeout(100)
    await expectVisual(page, 'workspace-empty-replacement-dark.png')

    await page.getByRole('button', { name: 'Split pane right' }).click()
    await expect(page.locator('.pane-separator')).toHaveCount(1)
    await expectVisual(page, 'workspace-dark.png')

    await page.getByRole('button', { name: 'Open command palette' }).click()
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await expectVisual(page, 'command-palette-dark.png')
    await page.keyboard.press('Escape')

    await selectedWorkspace.hover()
    await page.getByRole('button', { name: 'Split pane down' }).first().focus()
    await expect(page.getByRole('button', { name: 'Split pane down' }).first()).toBeFocused()
    await expectVisual(page, 'workspace-hover-focus-dark.png')
    await page.mouse.move(600, 400)

    await invokePaletteCommand(page, 'toggle sidebar')
    await expect(page.getByRole('complementary', { name: 'Workspaces' })).toHaveCount(0)
    await expectVisual(page, 'workspace-sidebar-collapsed-dark.png')
    await invokePaletteCommand(page, 'toggle sidebar')
    await expect(page.getByRole('complementary', { name: 'Workspaces' })).toBeVisible()

    await page
      .locator('.pane-view')
      .first()
      .getByRole('button', { name: 'Split pane down' })
      .click()
    await expect(page.locator('.pane-view')).toHaveCount(3)
    await page.locator('.pane-view').last().getByRole('button', { name: 'Split pane down' }).click()
    await expect(page.locator('.pane-view')).toHaveCount(4)
    await expectVisual(page, 'workspace-four-pane-dark.png')

    await page
      .locator('.pane-view[data-selected="true"]')
      .getByRole('button', { name: 'Close pane' })
      .click()
    await expect(page.locator('.pane-view')).toHaveCount(3)
    await page.locator('.pane-view').nth(1).getByRole('button', { name: 'Close pane' }).click()
    await expect(page.locator('.pane-view')).toHaveCount(2)

    await setTheme(page, 'light', { keepSettingsOpen: true })
    await expectVisual(page, 'settings-light.png')
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      if (globalThis.document.activeElement instanceof globalThis.HTMLElement) {
        globalThis.document.activeElement.blur()
      }
    })
    await page.mouse.move(600, 400)
    await expectVisual(page, 'workspace-light.png')

    const activeWorkspace = page.locator('[data-workspace-id][data-selected="true"]')
    const activePane = page.locator('.pane-view').last()
    const activeWorkspaceId = await activeWorkspace.getAttribute('data-workspace-id')
    const activePaneId = await activePane.getAttribute('data-pane-id')
    if (!activeWorkspaceId || !activePaneId) throw new Error('Visual target pane is missing.')
    await page.evaluate(
      ({ paneId: targetPaneId, workspaceId: targetWorkspaceId }) =>
        globalThis.desktopBridge.focusPane({
          paneId: targetPaneId,
          workspaceId: targetWorkspaceId
        }),
      { paneId: activePaneId, workspaceId: activeWorkspaceId }
    )
    const activePaneSelector = await page.evaluate(
      (paneId) => `.pane-view[data-pane-id=${globalThis.CSS.escape(paneId)}]`,
      activePaneId
    )
    const focusedPane = page.locator(activePaneSelector)
    await expect(focusedPane).toHaveCount(1)
    await expect(focusedPane).toHaveAttribute('data-selected', 'true')
    const activeTab = focusedPane.getByRole('tab', { selected: true })
    await expect(activeTab).toHaveCount(1)
    await expect(activeTab).toHaveAttribute('data-selected', 'true')
    const workspaceId = await activeWorkspace.getAttribute('data-workspace-id')
    const paneId = await focusedPane.getAttribute('data-pane-id')
    const tabId = await activeTab.getAttribute('data-tab-id')
    if (!workspaceId || !paneId || !tabId) throw new Error('Active workspace target is missing.')

    await execFileAsync(cliBinary, [
      '--session-file',
      sessionFile,
      'notify',
      '--title',
      'Visual regression attention',
      '--body',
      'A deterministic warning needs review.',
      '--level',
      'warning',
      '--workspace-id',
      workspaceId,
      '--pane-id',
      paneId,
      '--tab-id',
      tabId
    ])
    const notificationTrigger = page.getByRole('button', { name: /Open notifications, 1 unread/ })
    await expect(notificationTrigger).toBeVisible()
    await expect(page.getByLabel(/1 unread, highest severity warning/).first()).toBeVisible()
    await expect(page.locator('[data-sonner-toast][data-visible="true"]')).toHaveCount(0, {
      timeout: 10_000
    })
    await page.evaluate(() => {
      if (globalThis.document.activeElement instanceof globalThis.HTMLElement) {
        globalThis.document.activeElement.blur()
      }
    })
    await page.mouse.move(600, 400)
    await expectVisual(page, 'notification-attention-light.png')

    await notificationTrigger.click()
    const notificationCenter = page.getByRole('dialog', { name: 'Notifications' })
    await expect(notificationCenter.getByText('Visual regression attention')).toBeVisible()
    await expectVisual(page, 'notification-center-light.png')

    expect(consoleErrors, 'renderer/external console errors').toEqual([])
    expect(pageErrors, 'uncaught renderer page errors').toEqual([])
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

test('workspace matches the Linux visual baseline at 125 percent scale', async () => {
  test.setTimeout(60_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-visual-scale-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated fractional-scale shell.\n')
  const consoleErrors = []
  const pageErrors = []
  let electronApplication

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    electronApplication = await electron.launch({
      args: [mainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TMPDIR: harness.runtimeDirectory,
        TZ: 'UTC',
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      },
      timeout: 10_000
    })
    const page = await electronApplication.firstWindow()
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const location = message.location()
      if (
        !location.url.startsWith(rendererOrigin) &&
        benignExternalConsoleError.test(message.text())
      ) {
        return
      }
      consoleErrors.push(`${location.url || '<external>'} ${message.text()}`)
    })
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`))
    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800)
    })
    await page.setViewportSize({ height: 800, width: 1200 })
    const cdpSession = await page.context().newCDPSession(page)
    await cdpSession.send('Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: 1.25,
      height: 800,
      mobile: false,
      width: 1200
    })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })

    await expect.poll(() => page.url()).toBe(rendererUrl)
    await page.addStyleTag({
      content:
        '.xterm-screen, .terminal-process, .notification-center time { visibility: hidden !important; }'
    })
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([1200, 800])
    await expect.poll(() => page.evaluate(() => globalThis.devicePixelRatio)).toBe(1.25)
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    await setTheme(page, 'dark')
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([1200, 800])
    await expect.poll(() => page.evaluate(() => globalThis.devicePixelRatio)).toBe(1.25)
    await expectVisual(page, 'workspace-fractional-scale-dark.png')

    expect(consoleErrors, 'renderer/external console errors').toEqual([])
    expect(pageErrors, 'uncaught renderer page errors').toEqual([])
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

test('bundled service startup failure matches the Linux visual baseline', async () => {
  test.setTimeout(60_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-visual-failure-'))
  const consoleErrors = []
  const pageErrors = []
  let electronApplication

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    await writeFile(harness.serverPath, 'process.exit(23)\n')
    electronApplication = await electron.launch({
      args: [mainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TMPDIR: harness.runtimeDirectory,
        TZ: 'UTC',
        XDG_RUNTIME_DIR: harness.runtimeDirectory
      },
      timeout: 10_000
    })
    const page = await electronApplication.firstWindow()
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const location = message.location()
      if (
        !location.url.startsWith(rendererOrigin) &&
        benignExternalConsoleError.test(message.text())
      ) {
        return
      }
      consoleErrors.push(`${location.url || '<external>'} ${message.text()}`)
    })
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`))
    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800)
    })
    await page.setViewportSize({ height: 800, width: 1200 })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })

    await expect.poll(() => page.url()).toBe(rendererUrl)
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([1200, 800])
    await expect(page.getByRole('heading', { name: 'Workspace service unavailable' })).toBeVisible()
    await expect(page.getByText('The local service could not be restarted.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry service' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Preview diagnostics' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export diagnostic bundle' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Quit application' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export database' })).toHaveCount(0)
    const renderedText = await page.locator('body').innerText()
    expect(renderedText).not.toContain(profileDirectory)
    expect(renderedText).not.toContain('exit 23')
    await expectVisual(page, 'service-failure-dark.png')

    expect(consoleErrors, 'renderer/external console errors').toEqual([])
    expect(pageErrors, 'uncaught renderer page errors').toEqual([])
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function setTheme(page, theme, options = {}) {
  await page.getByRole('button', { name: 'Open settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  const themeSelect = settings.getByLabel('Theme')
  await expect(themeSelect).toBeVisible()
  await themeSelect.selectOption(theme)
  const appearanceSection = themeSelect.locator(
    'xpath=ancestor::*[contains(@class, "configuration-section")]'
  )
  await appearanceSection.getByRole('button', { name: 'Save section' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(settings.getByText('Setting saved.', { exact: true })).toBeVisible()
  if (!options.keepSettingsOpen) await page.keyboard.press('Escape')
}

async function invokePaletteCommand(page, query) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox', { name: 'Search commands' }).fill(query)
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
}

async function expectVisual(page, name) {
  const screenshotOptions = {
    animations: 'disabled',
    caret: 'hide',
    scale: 'css'
  }
  await page.screenshot(screenshotOptions)
  await expect(page).toHaveScreenshot(name, {
    ...screenshotOptions,
    maxDiffPixelRatio: 0.002
  })
  if (evidenceDirectory) {
    // Electron can de-composite one-off captures around native dialogs. Export the exact baseline
    // only after Playwright has proven the live renderer matches it.
    await mkdir(evidenceDirectory, { recursive: true })
    const baselineName = name.replace(/\.png$/u, `-${process.platform}.png`)
    await copyFile(
      join(desktopDirectory, 'e2e', 'visual-regression.spec.mjs-snapshots', baselineName),
      join(evidenceDirectory, name)
    )
  }
}
