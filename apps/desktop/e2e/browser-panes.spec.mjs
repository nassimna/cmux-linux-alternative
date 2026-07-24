import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { createBrowserTestServer } from './helpers/browser-test-server.mjs'
import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

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

test.beforeAll(() => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Electron browser-pane E2E needs an X11 or Wayland display.')
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
test('native browser panes navigate securely and release WebContentsView instances', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-browser-e2e-'))
  const evidenceDirectory = testInfo.outputPath('browser-pane-evidence')
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated browser E2E shell.\n')
  const browserServer = await createBrowserTestServer()
  let electronApplication

  try {
    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
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
    const renderer = await electronApplication.firstWindow()
    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(570, 800)
    })
    await renderer.setViewportSize({ height: 800, width: 570 })
    await expect.poll(() => renderer.url()).toBe(rendererUrl)
    await expect
      .poll(() => renderer.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([570, 800])
    await expect(renderer.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    const baseline = await webContentsCount(electronApplication)

    await createBrowserSplit(renderer)
    const browserPane = renderer.locator('.browser-pane')
    await expect(browserPane).toBeVisible()
    await navigate(renderer, `${browserServer.origin}/`)
    await expect(renderer.getByRole('textbox', { name: 'Address' })).toHaveValue(
      `${browserServer.origin}/`
    )
    await expect(browserPane).toHaveAttribute('aria-label', 'Initial Browser Test')
    await expect
      .poll(() => remoteUrl(electronApplication, browserServer.origin))
      .toBe(`${browserServer.origin}/`)

    const toolbar = browserPane.locator('.browser-toolbar')
    const browserMenu = toolbar.getByRole('button', { name: 'Browser menu' })
    const paneBounds = await browserPane.boundingBox()
    const menuTriggerBounds = await browserMenu.boundingBox()
    expect(paneBounds).not.toBeNull()
    expect(menuTriggerBounds).not.toBeNull()
    expect(paneBounds.width).toBeLessThanOrEqual(320)
    expect(menuTriggerBounds.x).toBeGreaterThanOrEqual(paneBounds.x)
    expect(menuTriggerBounds.x + menuTriggerBounds.width).toBeLessThanOrEqual(
      paneBounds.x + paneBounds.width
    )
    await expect(toolbar.locator('[data-browser-toolbar-action="open-external"]')).toBeHidden()
    await expect(toolbar.locator('[data-browser-toolbar-action="developer-tools"]')).toBeHidden()

    await browserMenu.focus()
    await browserMenu.press('Enter')
    await expect(renderer.getByRole('menuitem', { name: 'Open externally' })).toBeVisible()
    await expect(renderer.getByRole('menuitem', { name: 'Developer tools' })).toBeVisible()
    await expect
      .poll(() => remoteViewState(electronApplication, browserServer.origin))
      .toMatchObject({ attached: false, visible: false })
    const menuBounds = await renderer.getByRole('menu').boundingBox()
    const rendererViewport = await renderer.evaluate(() => ({
      height: globalThis.innerHeight,
      width: globalThis.innerWidth
    }))
    expect(menuBounds).not.toBeNull()
    expect(menuBounds.x).toBeGreaterThanOrEqual(0)
    expect(menuBounds.y).toBeGreaterThanOrEqual(0)
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(rendererViewport.width)
    expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(rendererViewport.height)
    await renderer.keyboard.press('Escape')
    await expect(renderer.getByRole('menuitem', { name: 'Open externally' })).toHaveCount(0)
    await expect
      .poll(() => remoteViewState(electronApplication, browserServer.origin))
      .toMatchObject({ attached: true, visible: true })

    expect(await remoteProbe(electronApplication, browserServer.origin)).toEqual({
      process: 'undefined',
      require: 'undefined',
      electron: 'undefined',
      desktopBridge: 'undefined'
    })

    await clickRemote(
      electronApplication,
      browserServer.origin,
      "document.querySelector('#next').click()"
    )
    await expect(renderer.getByRole('textbox', { name: 'Address' })).toHaveValue(
      `${browserServer.origin}/next`
    )
    await expect(browserPane).toHaveAttribute('aria-label', 'Navigation Target')
    const nativeNavigation = await remoteNavigationState(electronApplication, browserServer.origin)
    expect(nativeNavigation, JSON.stringify(nativeNavigation, null, 2)).toMatchObject({
      url: `${browserServer.origin}/next`,
      activeIndex: 1,
      entries: [{ url: `${browserServer.origin}/` }, { url: `${browserServer.origin}/next` }]
    })
    await expect(renderer.getByRole('button', { name: 'Back' })).toBeEnabled()
    await renderer.getByRole('button', { name: 'Back' }).click()
    await expect(renderer.getByRole('textbox', { name: 'Address' })).toHaveValue(
      `${browserServer.origin}/`
    )
    await expect(renderer.getByRole('button', { name: 'Forward' })).toBeEnabled()
    await renderer.getByRole('button', { name: 'Forward' }).click()
    await expect(renderer.getByRole('textbox', { name: 'Address' })).toHaveValue(
      `${browserServer.origin}/next`
    )

    const selectedPaneId = await renderer
      .locator('.pane-view.selected')
      .getAttribute('data-pane-id')
    if (!selectedPaneId) throw new Error('Selected browser pane has no pane ID')
    const selectedPane = renderer.locator(`.pane-view[data-pane-id="${selectedPaneId}"]`)
    const browserTabId = await selectedPane
      .locator('.pane-tab-select[data-selected="true"]')
      .getAttribute('data-tab-id')
    if (!browserTabId) throw new Error('Selected browser tab has no tab ID')
    await selectedPane.getByRole('button', { name: 'Add tab' }).click()
    await renderer.getByRole('menuitem', { name: 'Terminal', exact: true }).click()
    await expect(selectedPane.locator('.pane-tab-select')).toHaveCount(2)
    const terminalTabId = await selectedPane
      .locator('.pane-tab-select')
      .evaluateAll(
        (tabs, currentBrowserTabId) =>
          tabs
            .map((tab) => tab.getAttribute('data-tab-id'))
            .find((tabId) => tabId && tabId !== currentBrowserTabId) ?? null,
        browserTabId
      )
    if (!terminalTabId) throw new Error('Selected terminal tab has no tab ID')
    const browserTab = selectedPane.locator(`.pane-tab-select[data-tab-id="${browserTabId}"]`)
    const terminalTab = selectedPane.locator(`.pane-tab-select[data-tab-id="${terminalTabId}"]`)
    const workspaceId = await renderer.evaluate(async () => {
      const result = await globalThis.desktopBridge.listWorkspaces()
      return result.snapshot.selectedWorkspaceId
    })
    await expect
      .poll(() => authoritativeSelectedTab(renderer, workspaceId, selectedPaneId))
      .toBe(terminalTabId)
    await expect(terminalTab).toHaveAttribute('aria-selected', 'true')
    await selectTabAuthoritatively(renderer, workspaceId, browserTabId)
    await expect
      .poll(() => authoritativeSelectedTab(renderer, workspaceId, selectedPaneId))
      .toBe(browserTabId)
    await expect(browserTab).toHaveAttribute('aria-selected', 'true')
    await expect
      .poll(() => remoteViewState(electronApplication, browserServer.origin))
      .toMatchObject({ attached: true, visible: true, url: `${browserServer.origin}/next` })

    for (let iteration = 0; iteration < 2; iteration += 1) {
      await selectTabAuthoritatively(renderer, workspaceId, terminalTabId)
      await expect
        .poll(() => authoritativeSelectedTab(renderer, workspaceId, selectedPaneId))
        .toBe(terminalTabId)
      await expect(terminalTab).toHaveAttribute('aria-selected', 'true')
      await expect(renderer.locator('.browser-pane')).toHaveCount(0)
      await expect
        .poll(() => remoteViewState(electronApplication, browserServer.origin))
        .toMatchObject({ attached: false, visible: false, url: `${browserServer.origin}/next` })
      await selectTabAuthoritatively(renderer, workspaceId, browserTabId)
      await expect
        .poll(() => authoritativeSelectedTab(renderer, workspaceId, selectedPaneId))
        .toBe(browserTabId)
      await expect(browserTab).toHaveAttribute('aria-selected', 'true')
      await expect(renderer.locator('.browser-pane')).toBeVisible()
      await expect
        .poll(() => remoteViewState(electronApplication, browserServer.origin))
        .toMatchObject({
          attached: true,
          visible: true,
          url: `${browserServer.origin}/next`
        })
    }

    await navigate(renderer, `${browserServer.origin}/slow`)
    await expect(renderer.getByRole('button', { name: 'Stop loading' })).toBeVisible()
    await expect(browserPane).toHaveAttribute('aria-label', 'Slow Browser Target')

    await clickRemote(electronApplication, browserServer.origin, "window.open('/popup', '_blank')")
    await expect(renderer.getByRole('textbox', { name: 'Address' })).toHaveValue(
      `${browserServer.origin}/popup`
    )
    await expect(browserPane).toHaveAttribute('aria-label', 'Popup Target')
    expect(await remoteOriginCount(electronApplication, browserServer.origin)).toBe(1)

    const screenshotPath = join(evidenceDirectory, 'browser-popup-policy.png')
    await renderer.screenshot({ path: screenshotPath })
    await testInfo.attach('browser-popup-policy', {
      body: await import('node:fs/promises').then(({ readFile }) => readFile(screenshotPath)),
      contentType: 'image/png'
    })

    await closeSelectedBrowserTab(renderer)
    await expect(renderer.locator('.browser-pane')).toHaveCount(0)
    await expect.poll(() => remoteOriginCount(electronApplication, browserServer.origin)).toBe(0)
    await expect.poll(() => webContentsCount(electronApplication)).toBeLessThanOrEqual(baseline)

    for (let iteration = 0; iteration < 4; iteration += 1) {
      await createBrowserSplit(renderer)
      await expect
        .poll(() => webContentsCount(electronApplication))
        .toBeLessThanOrEqual(baseline + 1)
      await closeSelectedBrowserTab(renderer)
      await expect(renderer.locator('.browser-pane')).toHaveCount(0)
      await expect.poll(() => webContentsCount(electronApplication)).toBeLessThanOrEqual(baseline)
    }
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await browserServer.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function createBrowserSplit(renderer) {
  await renderer.getByRole('button', { name: 'Open command palette' }).click()
  const palette = renderer.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search commands' }).fill('open browser split')
  const command = palette.getByRole('option', { name: /Open browser split/ })
  await expect(command).toBeEnabled()
  await command.click()
  await expect(palette).toHaveCount(0)
  await expect(renderer.locator('.browser-pane')).toHaveCount(1)
  const pane = renderer.locator('.pane-view:has(.browser-pane)')
  await pane.locator('.browser-status').click()
  await expect(pane).toHaveAttribute('data-selected', 'true')
  await expect.poll(() => authoritativeBrowserCount(renderer)).toBe(1)
}

async function navigate(renderer, url) {
  const address = renderer.getByRole('textbox', { name: 'Address' })
  await address.fill(url)
  await address.press('Enter')
  await expect(address).toHaveValue(url)
}

async function closeSelectedBrowserTab(renderer) {
  const browserPane = renderer.locator('.pane-view:has(.browser-pane)')
  const tabId = await browserPane
    .locator('.pane-tab-select[data-selected="true"]')
    .getAttribute('data-tab-id')
  if (!tabId) throw new Error('Selected browser tab has no tab ID')
  await renderer.evaluate(async (browserTabId) => {
    const result = await globalThis.desktopBridge.listWorkspaces()
    await globalThis.desktopBridge.closeTab({
      workspaceId: result.snapshot.selectedWorkspaceId,
      tabId: browserTabId
    })
  }, tabId)
  await expect.poll(() => authoritativeBrowserCount(renderer)).toBe(0)
}

async function authoritativeBrowserCount(renderer) {
  return renderer.evaluate(async () => {
    const result = await globalThis.desktopBridge.listWorkspaces()
    return result.snapshot.workspaces.reduce(
      (count, workspace) =>
        count + workspace.tabs.filter((tab) => tab.content.kind === 'browser').length,
      0
    )
  })
}

async function authoritativeSelectedTab(renderer, workspaceId, paneId) {
  return renderer.evaluate(
    async ({ expectedPaneId, expectedWorkspaceId }) => {
      const result = await globalThis.desktopBridge.listWorkspaces()
      return result.snapshot.workspaces
        .find((workspace) => workspace.id === expectedWorkspaceId)
        ?.panes.find((pane) => pane.id === expectedPaneId)?.selectedTabId
    },
    { expectedPaneId: paneId, expectedWorkspaceId: workspaceId }
  )
}

async function selectTabAuthoritatively(renderer, workspaceId, tabId) {
  await renderer.evaluate(
    ({ selectedWorkspaceId, selectedTabId }) =>
      globalThis.desktopBridge.selectTab({
        workspaceId: selectedWorkspaceId,
        tabId: selectedTabId
      }),
    { selectedWorkspaceId: workspaceId, selectedTabId: tabId }
  )
}

async function webContentsCount(application) {
  return application.evaluate(
    ({ webContents }) =>
      webContents.getAllWebContents().filter((contents) => !contents.isDestroyed()).length
  )
}

async function remoteOriginCount(application, origin) {
  return application.evaluate(
    ({ webContents }, expectedOrigin) =>
      webContents
        .getAllWebContents()
        .filter(
          (contents) => !contents.isDestroyed() && contents.getURL().startsWith(expectedOrigin)
        ).length,
    origin
  )
}

async function remoteUrl(application, origin) {
  return application.evaluate(
    ({ webContents }, expectedOrigin) =>
      webContents
        .getAllWebContents()
        .find((contents) => !contents.isDestroyed() && contents.getURL().startsWith(expectedOrigin))
        ?.getURL() ?? null,
    origin
  )
}

async function remoteNavigationState(application, origin) {
  return application.evaluate(({ webContents }, expectedOrigin) => {
    const contents = webContents
      .getAllWebContents()
      .find(
        (candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(expectedOrigin)
      )
    if (!contents) return null
    return {
      url: contents.getURL(),
      canBack: contents.navigationHistory.canGoBack(),
      canForward: contents.navigationHistory.canGoForward(),
      activeIndex: contents.navigationHistory.getActiveIndex(),
      entries: contents.navigationHistory
        .getAllEntries()
        .map((entry) => ({ title: entry.title, url: entry.url }))
    }
  }, origin)
}

async function remoteViewState(application, origin) {
  return application.evaluate(({ BrowserWindow, webContents }, expectedOrigin) => {
    const contents = webContents
      .getAllWebContents()
      .find(
        (candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(expectedOrigin)
      )
    if (!contents) return null
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
      (candidate) => candidate.webContents?.id === contents.id
    )
    return {
      attached: Boolean(view),
      visible: view?.getVisible() ?? false,
      url: contents.getURL()
    }
  }, origin)
}

async function remoteProbe(application, origin) {
  return application.evaluate(async ({ webContents }, expectedOrigin) => {
    const contents = webContents
      .getAllWebContents()
      .find(
        (candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(expectedOrigin)
      )
    if (!contents) throw new Error('Remote browser WebContents was not found')
    return contents.executeJavaScript('globalThis.__browserIsolationProbe')
  }, origin)
}

async function clickRemote(application, origin, script) {
  await application.evaluate(
    async ({ webContents }, { expectedOrigin, expression }) => {
      const contents = webContents
        .getAllWebContents()
        .find(
          (candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(expectedOrigin)
        )
      if (!contents) throw new Error('Remote browser WebContents was not found')
      await contents.executeJavaScript(expression)
    },
    { expectedOrigin: origin, expression: script }
  )
}
