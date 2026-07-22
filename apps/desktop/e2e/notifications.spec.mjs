import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const mainEntry = join(desktopDirectory, 'out/main/index.js')
const executable = (name) =>
  join(repositoryDirectory, 'target', 'debug', process.platform === 'win32' ? `${name}.exe` : name)
const serviceBinary = executable('agent-workspace-service')
const cliBinary = executable('agent-workspace-cli')
const rendererUrl = 'agent-workspace://renderer/index.html'
const startupReadyTimeoutMs = 20_000
const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const evidenceDirectory =
  process.env.AGENT_WORKSPACE_EVIDENCE_DIR ?? join(tmpdir(), 'agent-workspace-m3-validation')
const benignExternalConsoleError = /(?:font(?:config)?|gpu|mesa|dri3|webgl)/i

async function harnessServiceProcessId(runtimeDirectory) {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args='])
  const matches = stdout
    .split('\n')
    .filter((line) => line.includes(runtimeDirectory) && line.includes(basename(serviceBinary)))
  if (matches.length !== 1) {
    throw new Error(`Expected one harness service process, found ${String(matches.length)}`)
  }
  const processId = Number.parseInt(matches[0].trimStart().split(/\s+/u)[0] ?? '', 10)
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Could not parse the harness service process id')
  }
  return processId
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Electron E2E needs an X11 or Wayland display.')
  }
  await mkdir(evidenceDirectory, { recursive: true })
  execFileSync('cargo', ['build', '-p', 'agent-workspace-service', '-p', 'agent-workspace-cli'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
})

test('CLI identify, notification attention, exact tab jump, and read transition', async () => {
  test.setTimeout(60_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m3-e2e-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated Electron E2E shell.\n')
  const consoleErrors = []
  const pageErrors = []
  let electronApplication
  let pausedServiceProcessId

  try {
    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
    const sessionFile = join(harness.runtimeDirectory, 'agent-workspace', 'cli-session.json')
    electronApplication = await electron.launch({
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
    const page = await electronApplication.firstWindow()
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const location = message.location()
      if (
        !location.url.startsWith('agent-workspace://') &&
        benignExternalConsoleError.test(message.text())
      ) {
        return
      }
      consoleErrors.push(`${location.url || '<external>'} ${message.text()}`)
    })
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))

    await expect
      .poll(() => page.url(), {
        message: `Expected trusted renderer ${rendererUrl}`,
        timeout: startupReadyTimeoutMs
      })
      .toBe(rendererUrl)
    await expect(
      page.locator('.terminal-pane'),
      'Expected the workspace service to start an initial terminal with a live process'
    ).toHaveAttribute('data-process-id', /^\d+$/, { timeout: startupReadyTimeoutMs })
    await expect
      .poll(async () => {
        try {
          const { stdout } = await execFileAsync(cliBinary, [
            '--session-file',
            sessionFile,
            'identify'
          ])
          return JSON.parse(stdout).application
        } catch {
          return null
        }
      })
      .toBe('agent-workspace')

    const selectedWorkspace = page.locator('[data-workspace-id][data-selected="true"]')
    const selectedPane = page.locator('[data-pane-id][data-selected="true"]')
    const originalTab = selectedPane.locator('[data-tab-id][data-selected="true"]')
    const workspaceId = await selectedWorkspace.getAttribute('data-workspace-id')
    const paneId = await selectedPane.getAttribute('data-pane-id')
    const tabId = await originalTab.getAttribute('data-tab-id')
    if (!workspaceId || !paneId || !tabId) {
      throw new Error('Selected workspace, pane, and tab identifiers must be present.')
    }

    await selectedPane.getByRole('button', { name: 'New terminal tab' }).click()
    await expect(page.locator(`[data-tab-id="${tabId}"]`)).toHaveAttribute('data-selected', 'false')

    await execFileAsync(cliBinary, [
      '--session-file',
      sessionFile,
      'notify',
      '--title',
      'Agent needs input',
      '--body',
      'Permission required to continue',
      '--level',
      'warning',
      '--workspace-id',
      workspaceId,
      '--pane-id',
      paneId,
      '--tab-id',
      tabId
    ])

    const notificationTrigger = page.getByRole('button', {
      name: /Open notifications, 1 unread/
    })
    await expect(notificationTrigger).toBeVisible()
    await notificationTrigger.click()
    const center = page.getByRole('dialog', { name: 'Notifications' })
    await expect(center.getByText('Agent needs input')).toBeVisible()
    await page.screenshot({ path: join(evidenceDirectory, '01-notification-attention.png') })

    await center.getByRole('button', { name: /Jump/ }).click()
    await expect(page.locator(`[data-tab-id="${tabId}"]`)).toHaveAttribute('data-selected', 'true')
    await expect(page.getByRole('button', { name: 'Open notifications' })).toBeVisible()

    await page.getByRole('button', { name: 'Open notifications' }).click()
    await expect(page.getByRole('button', { name: 'Mark notification unread' })).toBeVisible()
    await page.screenshot({ path: join(evidenceDirectory, '02-notification-read-after-jump.png') })

    await page.keyboard.press('Escape')
    await execFileAsync(cliBinary, [
      '--session-file',
      sessionFile,
      'notify',
      '--title',
      'Pane-only notice',
      '--workspace-id',
      workspaceId,
      '--pane-id',
      paneId
    ])
    await page.getByRole('button', { name: /Open notifications, 1 unread/ }).click()
    const paneOnlyNotice = page
      .locator('[data-notification-id]')
      .filter({ hasText: 'Pane-only notice' })
    await paneOnlyNotice.getByRole('button', { name: /Jump/ }).click()
    await expect(page.getByRole('button', { name: /Open notifications/ })).toBeVisible()
    await expect
      .poll(() =>
        selectedPane.evaluate((element) => {
          const activeElement = element.ownerDocument.activeElement
          return (
            element === activeElement || (activeElement !== null && element.contains(activeElement))
          )
        })
      )
      .toBe(true)
    await page.getByRole('button', { name: 'Open notifications' }).click()
    await expect(
      paneOnlyNotice.getByRole('button', { name: 'Mark notification unread' })
    ).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Toggle workspace sidebar' }).click()
    await expect(page.getByRole('complementary', { name: 'Workspaces' })).toHaveCount(0)
    await expect(page.locator(`[data-workspace-content-id="${workspaceId}"]`)).toHaveAttribute(
      'data-selected',
      'true'
    )
    await execFileAsync(cliBinary, [
      '--session-file',
      sessionFile,
      'notify',
      '--title',
      'Workspace-only notice',
      '--workspace-id',
      workspaceId
    ])
    await page.getByRole('button', { name: /Open notifications, 1 unread/ }).click()
    const workspaceOnlyNotice = page
      .locator('[data-notification-id]')
      .filter({ hasText: 'Workspace-only notice' })
    await workspaceOnlyNotice.getByRole('button', { name: /Jump/ }).click()
    await expect(page.getByRole('button', { name: 'Open notifications' })).toBeVisible()
    await expect
      .poll(() =>
        page.locator(`[data-workspace-content-id="${workspaceId}"]`).evaluate((element) => {
          const activeElement = element.ownerDocument.activeElement
          return (
            element === activeElement || (activeElement !== null && element.contains(activeElement))
          )
        })
      )
      .toBe(true)

    const exactTargetPane = page.locator(`[data-pane-id="${paneId}"]`)
    const exactTargetTab = page.locator(`[data-tab-id="${tabId}"]`)
    await exactTargetPane.getByRole('button', { name: 'New terminal tab' }).click()
    await expect(exactTargetTab).toHaveAttribute('data-selected', 'false')
    await execFileAsync(cliBinary, [
      '--session-file',
      sessionFile,
      'notify',
      '--title',
      'Palette latest unread notice',
      '--body',
      'Command palette should focus this exact tab before marking the notice read',
      '--level',
      'warning',
      '--workspace-id',
      workspaceId,
      '--pane-id',
      paneId,
      '--tab-id',
      tabId
    ])
    await expect(page.locator('.notification-trigger')).toHaveAttribute(
      'aria-label',
      'Open notifications, 1 unread'
    )

    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const paletteSearch = palette.getByRole('combobox', { name: 'Search commands' })
    await paletteSearch.fill('latest unread')
    await expect(palette.getByRole('option', { name: /Latest unread/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(page.locator('.notification-trigger')).toHaveAttribute(
      'aria-label',
      'Open notifications, 1 unread'
    )
    await page.evaluate(
      ({ targetPaneId, targetTabId, targetWorkspaceId }) => {
        const events = []
        const recordCurrentState = () => {
          const workspace = globalThis.document.querySelector(
            `[data-workspace-content-id="${targetWorkspaceId}"]`
          )
          const pane = globalThis.document.querySelector(`[data-pane-id="${targetPaneId}"]`)
          const tab = globalThis.document.querySelector(`[data-tab-id="${targetTabId}"]`)
          const notificationTrigger = globalThis.document.querySelector('.notification-trigger')
          if (
            workspace?.getAttribute('data-selected') === 'true' &&
            !events.includes('workspace')
          ) {
            events.push('workspace')
          }
          if (pane?.getAttribute('data-selected') === 'true' && !events.includes('pane')) {
            events.push('pane')
          }
          if (tab?.getAttribute('data-selected') === 'true' && !events.includes('tab')) {
            events.push('tab')
          }
          if (notificationTrigger?.getAttribute('aria-label') === 'Open notifications') {
            if (!events.includes('read')) events.push('read')
          }
        }
        const onFocus = () => {
          const tab = globalThis.document.querySelector(`[data-tab-id="${targetTabId}"]`)
          if (tab?.contains(globalThis.document.activeElement) && !events.includes('focus')) {
            events.push('focus')
          }
        }
        const observer = new globalThis.MutationObserver(recordCurrentState)
        observer.observe(globalThis.document.body, {
          attributes: true,
          attributeFilter: ['aria-label', 'data-selected'],
          subtree: true
        })
        globalThis.document.addEventListener('focusin', onFocus)
        globalThis.__paletteLatestUnreadTrace = {
          dispose: () => {
            observer.disconnect()
            globalThis.document.removeEventListener('focusin', onFocus)
          },
          events
        }
      },
      { targetPaneId: paneId, targetTabId: tabId, targetWorkspaceId: workspaceId }
    )

    if (process.platform === 'linux') {
      expect(await page.evaluate(() => Object.isFrozen(globalThis.desktopBridge))).toBe(true)
      pausedServiceProcessId = await harnessServiceProcessId(harness.runtimeDirectory)
      process.kill(pausedServiceProcessId, 'SIGSTOP')
    }

    await page.keyboard.press('Enter')
    await expect(palette).toHaveCount(0)
    if (pausedServiceProcessId !== undefined) {
      await page.getByRole('button', { name: 'Open command palette' }).click()
      await page.keyboard.press(`${primaryModifier}+Shift+P`)
      await expect(palette).toHaveCount(0)
      await expect(exactTargetTab).toHaveAttribute('data-selected', 'false')
      await expect(page.locator('.notification-trigger')).toHaveAttribute(
        'aria-label',
        'Open notifications, 1 unread'
      )
      const pendingTrace = await page.evaluate(
        () => globalThis.__paletteLatestUnreadTrace?.events ?? []
      )
      expect(pendingTrace).not.toContain('focus')
      expect(pendingTrace).not.toContain('read')
      process.kill(pausedServiceProcessId, 'SIGCONT')
      pausedServiceProcessId = undefined
    }
    await expect(page.locator(`[data-workspace-content-id="${workspaceId}"]`)).toHaveAttribute(
      'data-selected',
      'true'
    )
    await expect(exactTargetPane).toHaveAttribute('data-selected', 'true')
    await expect(exactTargetTab).toHaveAttribute('data-selected', 'true')
    await expect
      .poll(() =>
        exactTargetPane.evaluate((element) => {
          const activeElement = element.ownerDocument.activeElement
          return (
            element === activeElement || (activeElement !== null && element.contains(activeElement))
          )
        })
      )
      .toBe(true)
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toHaveCount(0)
    await expect(page.locator('.notification-navigation-error')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open notifications' })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => globalThis.__paletteLatestUnreadTrace?.events.includes('read') ?? false)
      )
      .toBe(true)
    const paletteLatestUnreadTrace = await page.evaluate(() => {
      const trace = globalThis.__paletteLatestUnreadTrace
      trace?.dispose()
      return trace?.events ?? []
    })
    expect(paletteLatestUnreadTrace).toContain('workspace')
    expect(paletteLatestUnreadTrace).toContain('pane')
    expect(paletteLatestUnreadTrace).toContain('tab')
    expect(paletteLatestUnreadTrace).toContain('focus')
    expect(paletteLatestUnreadTrace).toContain('read')
    expect(paletteLatestUnreadTrace.indexOf('focus')).toBeLessThan(
      paletteLatestUnreadTrace.indexOf('read')
    )
    await page.getByRole('button', { name: 'Open command palette' }).click()
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(evidenceDirectory, '04-palette-latest-unread.png') })

    await page.getByRole('button', { name: 'Open notifications' }).click()
    const paletteLatestUnreadNotice = page
      .locator('[data-notification-id]')
      .filter({ hasText: 'Palette latest unread notice' })
    await expect(paletteLatestUnreadNotice).toHaveCount(1)
    await expect(
      paletteLatestUnreadNotice.getByRole('button', { name: 'Mark notification unread' })
    ).toBeVisible()
    await expect(
      page.getByRole('dialog', { name: 'Notifications' }).getByRole('alert')
    ).toHaveCount(0)
    await page.keyboard.press('Escape')

    await electronApplication.evaluate(({ BrowserWindow, Notification }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Expected the notification test window to exist.')
      globalThis.__systemNotificationE2e = {
        originalIsFocused: window.isFocused,
        originalIsSupported: Notification.isSupported,
        originalShow: Notification.prototype.show,
        shown: 0,
        window
      }
      window.isFocused = () => false
      Notification.isSupported = () => true
      Notification.prototype.show = () => {
        globalThis.__systemNotificationE2e.shown += 1
      }
    })
    await execFileAsync(cliBinary, [
      '--session-file',
      sessionFile,
      'notify',
      '--title',
      'Enabled system notification control',
      '--workspace-id',
      workspaceId
    ])
    await expect
      .poll(() =>
        electronApplication.evaluate(() => globalThis.__systemNotificationE2e?.shown ?? 0)
      )
      .toBe(1)
    await page.getByRole('button', { name: /Open notifications, 1 unread/ }).click()
    const enabledSystemNotification = page
      .locator('[data-notification-id]')
      .filter({ hasText: 'Enabled system notification control' })
    await expect(enabledSystemNotification).toHaveCount(1)
    await enabledSystemNotification.getByRole('button', { name: 'Mark notification read' }).click()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Open settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Notifications', exact: true }).click()
    const systemNotifications = settings.getByRole('checkbox', {
      name: /system notifications/i
    })
    await systemNotifications.click()
    await expect(systemNotifications).not.toBeChecked()
    const notificationsSection = systemNotifications.locator(
      'xpath=ancestor::*[contains(@class, "configuration-section")]'
    )
    await notificationsSection.getByRole('button', { name: 'Save section' }).click()
    await expect(settings.getByText('Setting saved.')).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await globalThis.desktopBridge.getConfiguration()
          return result.config.notifications.systemEnabled
        })
      )
      .toBe(false)
    await page.keyboard.press('Escape')

    const stormSize = 30
    await Promise.all(
      Array.from({ length: stormSize }, (_, index) =>
        execFileAsync(cliBinary, [
          '--session-file',
          sessionFile,
          'notify',
          '--title',
          `Storm notice ${String(index + 1)}`,
          '--workspace-id',
          workspaceId
        ])
      )
    )
    await expect(
      page.getByRole('button', {
        name: new RegExp(`Open notifications, ${String(stormSize)} unread`)
      })
    ).toBeVisible()
    await expect
      .poll(() => page.locator('[data-sonner-toast][data-visible="true"]').count())
      .toBeLessThanOrEqual(3)
    await page.getByRole('button', { name: /Open notifications, 30 unread/ }).click()
    await expect(page.locator('.notification-item.unread')).toHaveCount(stormSize)
    expect(
      await electronApplication.evaluate(() => globalThis.__systemNotificationE2e?.shown ?? 0)
    ).toBe(1)
    await page.screenshot({ path: join(evidenceDirectory, '03-bounded-notification-storm.png') })

    expect(consoleErrors, 'renderer/external console errors').toEqual([])
    expect(pageErrors, 'uncaught renderer page errors').toEqual([])
  } finally {
    await electronApplication
      ?.evaluate(({ Notification }) => {
        const state = globalThis.__systemNotificationE2e
        if (!state) return
        state.window.isFocused = state.originalIsFocused
        Notification.isSupported = state.originalIsSupported
        Notification.prototype.show = state.originalShow
        delete globalThis.__systemNotificationE2e
      })
      .catch(() => undefined)
    if (pausedServiceProcessId !== undefined) {
      try {
        process.kill(pausedServiceProcessId, 'SIGCONT')
      } catch {
        // The harness may already have exited after a test failure.
      }
    }
    await electronApplication?.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})
