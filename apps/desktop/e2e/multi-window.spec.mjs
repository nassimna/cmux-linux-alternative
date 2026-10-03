import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { closeElectronApplication } from './helpers/close-electron-application.mjs'
import { createBrowserTestServer } from './helpers/browser-test-server.mjs'
import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const mainEntry = join(desktopDirectory, 'out/main/index.js')
const preloadEntry = join(desktopDirectory, 'out/preload/index.cjs')
const rendererUrl = 'agent-workspace://renderer/index.html'

test.beforeAll(() => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Electron multi-window E2E needs an X11 or Wayland display.')
  }
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
})

// Playwright requires an object destructuring pattern even when no browser fixture is used.
// eslint-disable-next-line no-empty-pattern
test('owns, transfers, denies, and restores two packaged desktop windows', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m3-multi-window-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated multi-window E2E shell.\n')
  const errors = []
  const qualificationEvidence = {}
  const browserServer = await createBrowserTestServer()
  let application

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    application = await launchApplication(profileDirectory, harness, errors)
    const primary = await readyPage(application, errors)
    await installRendererTrace(primary)

    await createWorkspace(primary, 'M3 transferable workspace', profileDirectory)
    const createdWorkspace = await selectedWorkspace(primary)
    const originalTerminal = await terminalProjection(primary)
    expect(originalTerminal).toMatchObject({
      runtimeSessionId: expect.any(String),
      tabId: expect.any(String),
      terminalId: expect.any(String),
      processId: expect.stringMatching(/^\d+$/u)
    })

    const initialTopology = await primary.evaluate(() => globalThis.desktopBridge.listWindows())
    expect(initialTopology.windows).toHaveLength(1)
    const initialPlacement = initialTopology.windows[0]
    expect(initialPlacement.workspaceIds).toContain(createdWorkspace.id)

    const createRequest = {
      mutation: {
        expectedRevision: initialTopology.revision,
        idempotencyEpoch: initialTopology.idempotencyEpoch,
        idempotencyKey: randomUUID()
      },
      label: 'M3 Secondary',
      workspaceId: createdWorkspace.id,
      sourceWindow: {
        windowId: initialPlacement.windowId,
        expectedRevision: initialPlacement.revision
      }
    }
    let created
    try {
      created = await primary.evaluate(
        (request) =>
          globalThis.__m3Deadline(globalThis.desktopBridge.createWindow(request), 'window.create'),
        createRequest
      )
    } catch (error) {
      const postTopology = await primary
        .evaluate(() => globalThis.desktopBridge.listWindows())
        .catch((postError) => ({ error: String(postError?.message ?? postError) }))
      const serviceLogs = await readDiagnosticLogs(join(profileDirectory, 'logs'))
      throw new Error(
        `window.create diagnostic: ${JSON.stringify({
          error: String(error?.message ?? error),
          postTopology,
          preTopology: initialTopology,
          request: createRequest,
          serviceLogs
        })}`,
        { cause: error }
      )
    }

    const secondary = await waitForPlacementPage(application, created.window.windowId)
    await readyPage(application, errors, secondary)
    const twoWindowProjection = await nativeWindowProjection(application)
    expect(twoWindowProjection).toHaveLength(2)
    expect(new Set(twoWindowProjection.map(({ webContentsId }) => webContentsId)).size).toBe(2)
    expect(new Set(twoWindowProjection.map(({ placementId }) => placementId)).size).toBe(2)
    expect(
      twoWindowProjection.find(({ placementId }) => placementId === created.window.windowId)
        ?.workspaceIds
    ).toEqual([createdWorkspace.id])
    expect(
      twoWindowProjection.find(({ placementId }) => placementId === initialPlacement.windowId)
        ?.workspaceIds
    ).not.toContain(createdWorkspace.id)

    await applyDistinctBounds(application)
    await primary.waitForTimeout(400)
    const settledBounds = await nativeBoundsByPlacement(application)
    expect(new Set(Object.values(settledBounds).map((bounds) => JSON.stringify(bounds))).size).toBe(
      2
    )

    const topologyBeforeMove = await secondary.evaluate(() =>
      globalThis.desktopBridge.listWindows()
    )
    const secondaryBeforeMove = topologyBeforeMove.windows.find(
      ({ windowId }) => windowId === created.window.windowId
    )
    const primaryBeforeMove = topologyBeforeMove.windows.find(
      ({ windowId }) => windowId === initialPlacement.windowId
    )
    expect(secondaryBeforeMove).toBeDefined()
    expect(primaryBeforeMove).toBeDefined()

    // The keyboard-accessible command path must preserve the live PTY while moving it.
    await secondary.getByRole('button', { name: 'Open command palette' }).click()
    const palette = secondary.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox', { name: 'Search commands' }).fill('move tab to window')
    await secondary.keyboard.press('Enter')
    const moveDialog = secondary.getByRole('dialog', { name: 'Move tab to window' })
    await expect(moveDialog).toBeVisible()
    await expect(moveDialog.getByLabel('Destination window')).toHaveValue(initialPlacement.windowId)
    await moveDialog.getByRole('button', { name: 'Move tab', exact: true }).click()
    await expect(moveDialog).toHaveCount(0, { timeout: 20_000 })

    await expect
      .poll(() => terminalIdentityOccurrences(application, originalTerminal), { timeout: 20_000 })
      .toEqual([
        {
          placementId: initialPlacement.windowId,
          processId: originalTerminal.processId,
          runtimeSessionId: originalTerminal.runtimeSessionId,
          tabId: originalTerminal.tabId,
          terminalId: originalTerminal.terminalId
        }
      ])
    qualificationEvidence.terminalTransfer = {
      identity: originalTerminal,
      sourcePlacementId: created.window.windowId,
      targetPlacementId: initialPlacement.windowId
    }

    const staleMutationMessage = await secondary.evaluate(
      ({ identity, sourcePlacement, targetPlacement, topology, workspace }) =>
        globalThis
          .__m3Deadline(
            globalThis.desktopBridge.moveTabExact({
              mutation: {
                expectedRevision: topology.revision,
                idempotencyEpoch: topology.idempotencyEpoch,
                idempotencyKey: globalThis.crypto.randomUUID()
              },
              source: {
                windowId: sourcePlacement.windowId,
                workspaceId: workspace.id,
                paneId: workspace.selectedPaneId,
                tabId: identity.tabId,
                expectedWindowRevision: sourcePlacement.revision
              },
              target: {
                ...targetPlacement.defaultTabDestination,
                windowId: targetPlacement.windowId,
                expectedWindowRevision: targetPlacement.revision
              }
            }),
            'stale tab.moveExact'
          )
          .then(
            () => 'unexpected success',
            (error) => String(error?.message ?? error)
          ),
      {
        identity: originalTerminal,
        sourcePlacement: secondaryBeforeMove,
        targetPlacement: primaryBeforeMove,
        topology: topologyBeforeMove,
        workspace: createdWorkspace
      }
    )
    expect(staleMutationMessage).toMatch(/(?:stale|revision|source|not found)/iu)

    // A native browser session is recreated, never reparented, across placements.
    await createBrowserSplit(secondary)
    const browserUrl = `${browserServer.origin}/?handoff=${randomUUID()}#query-fragment-preserved`
    await navigateBrowser(secondary, browserUrl)
    const originalBrowser = await selectedBrowserProjection(secondary)
    expect(originalBrowser).toMatchObject({
      browserSessionId: expect.any(String),
      profilePartition: expect.stringMatching(/^persist:/u),
      tabId: expect.any(String),
      url: browserUrl
    })
    await expect
      .poll(() => browserNativeOccurrences(application, browserUrl), { timeout: 20_000 })
      .toEqual([
        expect.objectContaining({
          attachedPlacementId: created.window.windowId,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          url: browserUrl
        })
      ])
    const sourceBrowserNative = await browserNativeOccurrences(application, browserUrl)

    await moveSelectedTabToWindow(secondary, initialPlacement.windowId)
    await expect
      .poll(() => browserAuthoritativeOccurrences(application, originalBrowser), {
        timeout: 20_000
      })
      .toEqual([
        {
          browserSessionId: originalBrowser.browserSessionId,
          placementId: initialPlacement.windowId,
          profilePartition: originalBrowser.profilePartition,
          tabId: originalBrowser.tabId,
          url: browserUrl
        }
      ])
    await expect
      .poll(() => browserNativeOccurrences(application, browserUrl), { timeout: 20_000 })
      .toEqual([
        expect.objectContaining({
          attachedPlacementId: initialPlacement.windowId,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          sessionIdentity: sourceBrowserNative[0].sessionIdentity,
          url: browserUrl
        })
      ])
    const targetBrowserNative = await browserNativeOccurrences(application, browserUrl)
    expect(targetBrowserNative[0].webContentsId).not.toBe(sourceBrowserNative[0].webContentsId)
    expect(await isWebContentsAlive(application, sourceBrowserNative[0].webContentsId)).toBe(false)
    await expect
      .poll(() => browserLifecycleHandoff(application, originalBrowser.browserSessionId), {
        timeout: 20_000
      })
      .toMatchObject({
        source: {
          lifecycleId: expect.any(String),
          unmounted: true,
          webContentsId: expect.any(Number)
        },
        target: {
          lifecycleId: expect.any(String),
          webContentsId: expect.any(Number)
        }
      })
    const browserLifecycle = await browserLifecycleHandoff(
      application,
      originalBrowser.browserSessionId
    )
    expect(browserLifecycle.target.webContentsId).not.toBe(browserLifecycle.source.webContentsId)
    expect(browserLifecycle.target.lifecycleId).not.toBe(browserLifecycle.source.lifecycleId)
    qualificationEvidence.browserTransfer = {
      authoritative: await browserAuthoritativeOccurrences(application, originalBrowser),
      lifecycle: browserLifecycle,
      nativeAfter: targetBrowserNative,
      nativeBefore: sourceBrowserNative,
      session: originalBrowser
    }

    // A renderer with the authentic preload and URL but no registry generation must fail closed.
    const unauthorizedMessage = await unauthorizedTrustedSenderMessage(application)
    expect(unauthorizedMessage).toMatch(/Unauthorized desktop IPC sender/u)
    await expect.poll(() => nativeWindowProjection(application)).toHaveLength(2)

    const crashedWebContentsId = await crashPlacementRenderer(
      application,
      initialPlacement.windowId
    )
    await expect
      .poll(() => recoveredPlacementProjection(application, crashedWebContentsId), {
        timeout: 20_000
      })
      .toMatchObject({
        bridgeAvailable: true,
        rendererReady: true,
        topology: {
          windows: expect.arrayContaining([
            expect.objectContaining({ windowId: initialPlacement.windowId }),
            expect.objectContaining({ windowId: created.window.windowId })
          ])
        },
        webContentsId: crashedWebContentsId
      })

    // Close and reopen from keyboard commands. Reopen is intentionally a fresh runtime.
    await selectTabInPlacement(application, crashedWebContentsId, originalTerminal.tabId)
    await expect
      .poll(() => selectedTabIdInPlacement(application, crashedWebContentsId))
      .toBe(originalTerminal.tabId)
    await expect
      .poll(() =>
        renderedSelectedTabInPlacement(application, crashedWebContentsId, originalTerminal.tabId)
      )
      .toBe(true)
    await sendShortcutToPlacement(application, crashedWebContentsId, 'W', ['control'])
    await expect.poll(() => countTabId(application, originalTerminal.tabId)).toBe(0)
    const closed = await closedItemsForPlacement(application, crashedWebContentsId)
    const closedItem = closed.items.find(
      ({ priorItemId, restored }) => priorItemId === originalTerminal.tabId && !restored
    )
    expect(closedItem).toBeDefined()
    await sendShortcutToPlacement(application, crashedWebContentsId, 'T', ['control', 'shift'])
    await expect
      .poll(async () => {
        const projection = await terminalProjectionForPlacement(application, crashedWebContentsId)
        return projection.tabId === originalTerminal.tabId ? null : projection
      })
      .toMatchObject({
        processId: expect.stringMatching(/^\d+$/u),
        runtimeSessionId: expect.any(String),
        tabId: expect.any(String),
        terminalId: expect.any(String)
      })
    const reopenedTerminal = await terminalProjectionForPlacement(application, crashedWebContentsId)
    expect(reopenedTerminal.tabId).not.toBe(originalTerminal.tabId)
    expect(reopenedTerminal.runtimeSessionId).not.toBe(originalTerminal.runtimeSessionId)
    expect(reopenedTerminal.processId).not.toBe(originalTerminal.processId)

    assertNoUnexpectedErrors(errors)
    await closeElectronApplication(application)
    application = undefined
    errors.length = 0

    application = await launchApplication(profileDirectory, harness, errors)
    await expect
      .poll(() => nativeWindowProjection(application), { timeout: 20_000 })
      .toHaveLength(2)
    const restoredWindows = await nativeWindowProjection(application)
    expect(restoredWindows.map(({ placementId }) => placementId).sort()).toEqual(
      [initialPlacement.windowId, created.window.windowId].sort()
    )
    expect(await nativeBoundsByPlacement(application)).toEqual(settledBounds)
    expect(
      restoredWindows
        .flatMap(({ workspaceIds }) => workspaceIds)
        .filter((workspaceId) => workspaceId === createdWorkspace.id)
    ).toHaveLength(1)
    await expect
      .poll(() => browserAuthoritativeOccurrences(application, originalBrowser), {
        timeout: 20_000
      })
      .toEqual([
        {
          browserSessionId: originalBrowser.browserSessionId,
          placementId: initialPlacement.windowId,
          profilePartition: originalBrowser.profilePartition,
          tabId: originalBrowser.tabId,
          url: browserUrl
        }
      ])
    const restoredPrimaryForBrowser = await waitForPlacementPage(
      application,
      initialPlacement.windowId
    )
    const restoredBrowserTab = restoredPrimaryForBrowser.locator(
      `[data-tab-id="${originalBrowser.tabId}"]`
    )
    await expect(restoredBrowserTab).toHaveAttribute('aria-selected', 'false')
    await restoredBrowserTab.click()
    await expect(restoredBrowserTab).toHaveAttribute('aria-selected', 'true')
    await expect(restoredBrowserTab).toHaveAttribute('data-selected', 'true')
    await expect
      .poll(() => browserNativeOccurrences(application, browserUrl), { timeout: 20_000 })
      .toEqual([
        expect.objectContaining({
          attachedPlacementId: initialPlacement.windowId,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          url: browserUrl
        })
      ])
    const ownershipBeforeRehome = await durableOwnershipProjection(application)
    expectUniqueOwnership(ownershipBeforeRehome)
    const restoredSecondary = await waitForPlacementPage(application, created.window.windowId)
    let restoredTopology = await restoredSecondary.evaluate(() =>
      globalThis.desktopBridge.listWindows()
    )
    let closingPlacement = restoredTopology.windows.find(
      ({ windowId }) => windowId === created.window.windowId
    )
    let rehomePlacement = restoredTopology.windows.find(
      ({ windowId }) => windowId === initialPlacement.windowId
    )
    expect(closingPlacement).toBeDefined()
    expect(rehomePlacement).toBeDefined()
    await restoredSecondary.evaluate(
      ({ idempotencyEpoch, revision, window }) =>
        globalThis.__m3Deadline(
          globalThis.desktopBridge.focusWindow({
            mutation: {
              expectedRevision: revision,
              idempotencyEpoch,
              idempotencyKey: globalThis.crypto.randomUUID()
            },
            window: { windowId: window.windowId, expectedRevision: window.revision }
          }),
          'window.focus'
        ),
      {
        idempotencyEpoch: restoredTopology.idempotencyEpoch,
        revision: restoredTopology.revision,
        window: closingPlacement
      }
    )
    await expect
      .poll(() => focusedPlacementId(application), { timeout: 10_000 })
      .toBe(created.window.windowId)

    restoredTopology = await restoredSecondary.evaluate(() =>
      globalThis.desktopBridge.listWindows()
    )
    closingPlacement = restoredTopology.windows.find(
      ({ windowId }) => windowId === created.window.windowId
    )
    rehomePlacement = restoredTopology.windows.find(
      ({ windowId }) => windowId === initialPlacement.windowId
    )
    expect(closingPlacement).toBeDefined()
    expect(rehomePlacement).toBeDefined()
    await restoredSecondary.evaluate(
      ({ closing, idempotencyEpoch, rehome, revision }) =>
        globalThis.__m3Deadline(
          globalThis.desktopBridge.closeWindow({
            mutation: {
              expectedRevision: revision,
              idempotencyEpoch,
              idempotencyKey: globalThis.crypto.randomUUID()
            },
            window: { windowId: closing.windowId, expectedRevision: closing.revision },
            policy: 'rehome',
            rehomeTarget: { windowId: rehome.windowId, expectedRevision: rehome.revision }
          }),
          'window.close'
        ),
      {
        closing: closingPlacement,
        idempotencyEpoch: restoredTopology.idempotencyEpoch,
        rehome: rehomePlacement,
        revision: restoredTopology.revision
      }
    )
    await expect.poll(() => nativeBrowserWindowCount(application), { timeout: 20_000 }).toBe(1)
    await expect(
      restoredPrimaryForBrowser.locator(`[data-workspace-id="${createdWorkspace.id}"]`)
    ).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => flatOwnership(await durableOwnershipProjection(application)), {
        timeout: 20_000
      })
      .toEqual(flatOwnership(ownershipBeforeRehome))
    const ownershipAfterRehome = await durableOwnershipProjection(application)
    expectUniqueOwnership(ownershipAfterRehome)
    expect(ownershipAfterRehome.map(({ placementId }) => placementId)).toEqual([
      initialPlacement.windowId
    ])
    expect(flatOwnership(ownershipAfterRehome)).toEqual(flatOwnership(ownershipBeforeRehome))
    assertNoUnexpectedErrors(errors)
    qualificationEvidence.final = {
      bounds: await nativeBoundsByPlacement(application),
      ownership: ownershipAfterRehome,
      windows: await nativeWindowProjection(application)
    }
    const finalPrimary = await waitForPlacementPage(application, initialPlacement.windowId)
    await closeTabById(finalPrimary, originalBrowser.tabId)
    await expect
      .poll(() => browserAuthoritativeOccurrences(application, originalBrowser), {
        timeout: 20_000
      })
      .toEqual([])
    await expect
      .poll(() => browserNativeOccurrences(application, browserUrl), { timeout: 20_000 })
      .toEqual([])
    qualificationEvidence.browserCleanup = {
      authoritativeOccurrences: 0,
      nativeOccurrences: 0
    }
    await persistQualificationEvidence(testInfo, qualificationEvidence)
  } catch (error) {
    await persistFailureEvidence(testInfo, application, errors, error)
    throw error
  } finally {
    await closeElectronApplication(application).catch(() => undefined)
    await browserServer.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

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
  const childProcess = application.process()
  childProcess.stdout?.on('data', (chunk) => errors.push(`[main stdout] ${String(chunk)}`))
  childProcess.stderr?.on('data', (chunk) => errors.push(`[main stderr] ${String(chunk)}`))
  application.on('window', (page) => {
    instrumentPage(page, errors)
    void page.addInitScript(rendererTraceInit).catch(() => undefined)
  })
  await application.evaluate(({ app, BrowserWindow, ipcMain }) => {
    globalThis.__m3IpcTrace = []
    globalThis.__m3BrowserLifecycleTrace = []
    const invokeHandlers = ipcMain._invokeHandlers
    for (const channel of [
      'browser:mountView',
      'browser:unmountView',
      'browser:setBounds',
      'browser:focusView'
    ]) {
      const original = invokeHandlers?.get(channel)
      if (!original || original.__m3LifecycleTraceInstalled) continue
      const traced = async (event, ...args) => {
        let safeArgs
        try {
          safeArgs = JSON.parse(JSON.stringify(args))
        } catch {
          safeArgs = args.map(String)
        }
        globalThis.__m3BrowserLifecycleTrace.push({
          args: safeArgs,
          at: Date.now(),
          channel,
          webContentsId: event.sender.id
        })
        return original(event, ...args)
      }
      traced.__m3LifecycleTraceInstalled = true
      invokeHandlers.set(channel, traced)
    }
    const instrument = (window) => {
      if (window.webContents.__m3TraceInstalled) return
      window.webContents.__m3TraceInstalled = true
      for (const eventName of ['ipc-message', 'ipc-message-sync']) {
        window.webContents.on(eventName, (_event, channel, ...args) => {
          if (!/(?:terminal|window|tab|browser)/u.test(channel)) return
          let safeArgs
          try {
            safeArgs = JSON.parse(JSON.stringify(args))
          } catch {
            safeArgs = args.map(String)
          }
          globalThis.__m3IpcTrace.push({
            args: safeArgs,
            at: Date.now(),
            channel,
            eventName,
            webContentsId: window.webContents.id
          })
        })
      }
    }
    BrowserWindow.getAllWindows().forEach(instrument)
    app.on('browser-window-created', (_event, window) => instrument(window))
  })
  return application
}

function rendererTraceInit() {
  globalThis.__m3RendererTrace ??= { events: [], installed: false }
  const attach = () => {
    if (globalThis.__m3RendererTrace.installed || !globalThis.desktopBridge?.onMultiWindowEvent) {
      return
    }
    globalThis.__m3RendererTrace.installed = true
    globalThis.desktopBridge.onMultiWindowEvent((event) => {
      globalThis.__m3RendererTrace.events.push({ at: Date.now(), event })
    })
  }
  attach()
  const timer = globalThis.setInterval(() => {
    attach()
    if (globalThis.__m3RendererTrace.installed) globalThis.clearInterval(timer)
  }, 10)
}

async function installRendererTrace(page) {
  await page.evaluate(rendererTraceInit)
}

async function readyPage(application, errors, candidate) {
  const page = candidate ?? (await application.firstWindow())
  await expect.poll(() => page.url()).toBe(rendererUrl)
  try {
    await expect(page.locator('.terminal-pane').first()).toHaveAttribute(
      'data-process-id',
      /^\d+$/u,
      { timeout: 20_000 }
    )
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      body: globalThis.document.body.innerText,
      url: globalThis.location.href
    }))
    throw new Error(
      `renderer did not become ready: ${JSON.stringify({ diagnostic, output: errors })}`,
      { cause: error }
    )
  }
  await installRendererDeadline(page)
  return page
}

async function installRendererDeadline(page) {
  await page.evaluate(() => {
    globalThis.__m3Deadline = (operation, label) =>
      Promise.race([
        operation,
        new Promise((_, reject) =>
          globalThis.setTimeout(
            () => reject(new Error(`${label} did not settle within 20 seconds`)),
            20_000
          )
        )
      ])
  })
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
}

async function selectedWorkspace(page) {
  const result = await page.evaluate(() => globalThis.desktopBridge.listWorkspaces())
  return result.snapshot.workspaces.find(({ id }) => id === result.snapshot.selectedWorkspaceId)
}

async function terminalProjection(page) {
  return page.evaluate(async () => {
    const result = await globalThis.desktopBridge.listWorkspaces()
    const workspace = result.snapshot.workspaces.find(
      ({ id }) => id === result.snapshot.selectedWorkspaceId
    )
    const pane = workspace?.panes.find(({ id }) => id === workspace.selectedPaneId)
    const tab = workspace?.tabs.find(({ id }) => id === pane?.selectedTabId)
    const terminal = globalThis.document.querySelector('.terminal-pane')
    return {
      processId: terminal?.getAttribute('data-process-id') ?? null,
      runtimeSessionId: tab?.content.kind === 'terminal' ? tab.content.runtimeSessionId : null,
      tabId: tab?.id ?? null,
      terminalId: terminal?.getAttribute('data-terminal-id') ?? null
    }
  })
}

async function createBrowserSplit(page) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search commands' }).fill('open browser split')
  const command = palette.getByRole('option', { name: /Open browser split/u })
  await expect(command).toBeEnabled()
  await command.click()
  await expect(page.locator('.browser-pane')).toHaveCount(1)
  const pane = page.locator('.pane-view:has(.browser-pane)')
  await pane.locator('.browser-status').click()
  await expect(pane).toHaveAttribute('data-selected', 'true')
}

async function navigateBrowser(page, url) {
  const address = page.getByRole('textbox', { name: 'Address' })
  await address.fill(url)
  await address.press('Enter')
  await expect(address).toHaveValue(url)
  await expect
    .poll(() => selectedBrowserProjection(page), { timeout: 20_000 })
    .toMatchObject({ url })
}

async function selectedBrowserProjection(page) {
  return page.evaluate(async () => {
    const result = await globalThis.desktopBridge.listWorkspaces()
    const workspace = result.snapshot.workspaces.find(
      ({ id }) => id === result.snapshot.selectedWorkspaceId
    )
    const pane = workspace?.panes.find(({ id }) => id === workspace.selectedPaneId)
    const tab = workspace?.tabs.find(({ id }) => id === pane?.selectedTabId)
    if (tab?.content.kind !== 'browser') return null
    return {
      browserSessionId: tab.content.state.browserSessionId,
      profilePartition: tab.content.state.profilePartition,
      tabId: tab.id,
      url: tab.content.state.url
    }
  })
}

async function closeTabById(page, tabId) {
  await page.evaluate(async (expectedTabId) => {
    const result = await globalThis.desktopBridge.listWorkspaces()
    const workspace = result.snapshot.workspaces.find(({ tabs }) =>
      tabs.some(({ id }) => id === expectedTabId)
    )
    if (!workspace) throw new Error('Browser cleanup tab is not authoritatively owned')
    await globalThis.desktopBridge.closeTab({ workspaceId: workspace.id, tabId: expectedTabId })
  }, tabId)
}

async function moveSelectedTabToWindow(page, destinationWindowId) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search commands' }).fill('move tab to window')
  await page.keyboard.press('Enter')
  const moveDialog = page.getByRole('dialog', { name: 'Move tab to window' })
  await expect(moveDialog).toBeVisible()
  await expect(moveDialog.getByLabel('Destination window')).toHaveValue(destinationWindowId)
  await moveDialog.getByRole('button', { name: 'Move tab', exact: true }).click()
  await expect(moveDialog).toHaveCount(0, { timeout: 20_000 })
}

async function browserAuthoritativeOccurrences(application, identity) {
  return application.evaluate(
    async ({ BrowserWindow }, { expected, trustedUrl }) => {
      const matches = []
      const expectedTabId = JSON.stringify(expected.tabId)
      for (const window of BrowserWindow.getAllWindows().filter(
        (candidate) => candidate.webContents.getURL() === trustedUrl
      )) {
        const projection = await window.webContents.executeJavaScript(`(async () => {
          const topology = await globalThis.desktopBridge.listWindows()
          const scoped = await globalThis.desktopBridge.listWorkspaces()
          const workspaceIds = scoped.snapshot.workspaces.map(({ id }) => id)
          const placement = topology.windows.find(({ workspaceIds: owned }) =>
            owned.some((id) => workspaceIds.includes(id)))
          const tabs = scoped.snapshot.workspaces.flatMap((workspace) => workspace.tabs)
          const tab = tabs.find(({ id }) => id === ${expectedTabId})
          return tab?.content.kind === 'browser' ? {
            browserSessionId: tab.content.state.browserSessionId,
            placementId: placement?.windowId ?? null,
            profilePartition: tab.content.state.profilePartition,
            tabId: tab.id,
            url: tab.content.state.url
          } : null
        })()`)
        if (
          projection?.tabId === expected.tabId ||
          projection?.browserSessionId === expected.browserSessionId
        ) {
          matches.push(projection)
        }
      }
      return matches
    },
    { expected: identity, trustedUrl: rendererUrl }
  )
}

async function browserNativeOccurrences(application, expectedUrl) {
  return application.evaluate(
    async ({ BrowserWindow, webContents }, { trustedUrl, url }) => {
      globalThis.__m3BrowserSessions ??= { identities: new WeakMap(), nextIdentity: 1 }
      const occurrences = []
      const trustedWindows = BrowserWindow.getAllWindows().filter(
        (candidate) => candidate.webContents.getURL() === trustedUrl
      )
      for (const contents of webContents
        .getAllWebContents()
        .filter((candidate) => !candidate.isDestroyed() && candidate.getURL() === url)) {
        const owner = trustedWindows.find((window) =>
          window.contentView.children.some((view) => view.webContents?.id === contents.id)
        )
        let attachedPlacementId = null
        if (owner) {
          attachedPlacementId = await owner.webContents.executeJavaScript(`(async () => {
          const topology = await globalThis.desktopBridge.listWindows()
          const scoped = await globalThis.desktopBridge.listWorkspaces()
          const ids = scoped.snapshot.workspaces.map(({ id }) => id)
          return topology.windows.find(({ workspaceIds }) =>
            workspaceIds.some((id) => ids.includes(id)))?.windowId ?? null
        })()`)
        }
        let sessionIdentity = globalThis.__m3BrowserSessions.identities.get(contents.session)
        if (!sessionIdentity) {
          sessionIdentity = globalThis.__m3BrowserSessions.nextIdentity++
          globalThis.__m3BrowserSessions.identities.set(contents.session, sessionIdentity)
        }
        const preferences = contents.getLastWebPreferences()
        occurrences.push({
          attachedPlacementId,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          sandbox: preferences.sandbox,
          sessionIdentity,
          url: contents.getURL(),
          webContentsId: contents.id
        })
      }
      return occurrences
    },
    { trustedUrl: rendererUrl, url: expectedUrl }
  )
}

async function isWebContentsAlive(application, id) {
  return application.evaluate(
    ({ webContents }, expectedId) => Boolean(webContents.fromId(expectedId)),
    id
  )
}

async function browserLifecycleHandoff(application, browserSessionId) {
  return application.evaluate((_, expectedSessionId) => {
    const relevant = (globalThis.__m3BrowserLifecycleTrace ?? []).filter(
      ({ args }) => args[0]?.browserSessionId === expectedSessionId
    )
    const mounts = relevant.filter(({ channel }) => channel === 'browser:mountView')
    const first = mounts[0]
    const target = mounts.find(({ webContentsId }) => webContentsId !== first?.webContentsId)
    if (!first || !target) return null
    return {
      source: {
        lifecycleId: first.args[0].lifecycleId,
        unmounted: relevant.some(
          ({ args, channel, webContentsId }) =>
            channel === 'browser:unmountView' &&
            webContentsId === first.webContentsId &&
            args[0]?.lifecycleId === first.args[0].lifecycleId
        ),
        webContentsId: first.webContentsId
      },
      target: {
        lifecycleId: target.args[0].lifecycleId,
        webContentsId: target.webContentsId
      }
    }
  }, browserSessionId)
}

async function waitForPlacementPage(application, placementId) {
  let found
  await expect
    .poll(
      async () => {
        for (const page of application.windows()) {
          if (page.url() !== rendererUrl) continue
          try {
            const topology = await page.evaluate(() => globalThis.desktopBridge.listWindows())
            const workspaces = await page.evaluate(() => globalThis.desktopBridge.listWorkspaces())
            const ownedWorkspaceIds = workspaces.snapshot.workspaces.map(({ id }) => id)
            if (
              topology.windows.some(
                ({ windowId, workspaceIds }) =>
                  windowId === placementId &&
                  workspaceIds.some((workspaceId) => ownedWorkspaceIds.includes(workspaceId))
              )
            ) {
              found = page
              return true
            }
          } catch {
            // A newly opened renderer may not have a ready scoped binding yet.
          }
        }
        return false
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  await installRendererDeadline(found)
  return found
}

async function nativeWindowProjection(application) {
  return application.evaluate(async ({ BrowserWindow }, trustedUrl) => {
    const projections = []
    for (const window of BrowserWindow.getAllWindows().filter(
      (candidate) => candidate.webContents.getURL() === trustedUrl
    )) {
      let projection
      try {
        projection = await window.webContents.executeJavaScript(`(async () => {
          const topology = await globalThis.desktopBridge.listWindows()
          const scoped = await globalThis.desktopBridge.listWorkspaces()
          const workspaceIds = scoped.snapshot.workspaces.map(({ id }) => id)
          const placement = topology.windows.find(({ workspaceIds: owned }) =>
            owned.some((id) => workspaceIds.includes(id)))
          return { placementId: placement?.windowId ?? null, workspaceIds }
        })()`)
      } catch {
        // Ownership changes fail closed on the retired scoped client until the survivor rebinds.
        return []
      }
      projections.push({ ...projection, webContentsId: window.webContents.id })
    }
    return projections.sort((left, right) => left.placementId.localeCompare(right.placementId))
  }, rendererUrl)
}

async function nativeBrowserWindowCount(application) {
  return application.evaluate(
    ({ BrowserWindow }, trustedUrl) =>
      BrowserWindow.getAllWindows().filter(
        (candidate) => candidate.webContents.getURL() === trustedUrl
      ).length,
    rendererUrl
  )
}

async function durableOwnershipProjection(application) {
  const projections = []
  for (const page of application.windows().filter((candidate) => candidate.url() === rendererUrl)) {
    try {
      projections.push(
        await page.evaluate(async () => {
          const topology = await globalThis.desktopBridge.listWindows()
          const scoped = await globalThis.desktopBridge.listWorkspaces()
          const workspaceIds = scoped.snapshot.workspaces.map(({ id }) => id)
          const placement = topology.windows.find(({ workspaceIds: owned }) =>
            owned.some((id) => workspaceIds.includes(id))
          )
          return {
            placementId: placement?.windowId ?? null,
            runtimeSessionIds: scoped.snapshot.workspaces.flatMap((workspace) =>
              workspace.tabs.flatMap((tab) =>
                tab.content.kind === 'terminal' ? [tab.content.runtimeSessionId] : []
              )
            ),
            tabIds: scoped.snapshot.workspaces.flatMap((workspace) =>
              workspace.tabs.map(({ id }) => id)
            ),
            workspaceIds
          }
        })
      )
    } catch {
      // The native close can destroy its renderer while Playwright still reports the page.
    }
  }
  return projections.sort((left, right) => left.placementId.localeCompare(right.placementId))
}

async function focusedPlacementId(application) {
  return application.evaluate(async ({ BrowserWindow }, trustedUrl) => {
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused || focused.webContents.getURL() !== trustedUrl) return null
    return focused.webContents.executeJavaScript(`(async () => {
      const topology = await globalThis.desktopBridge.listWindows()
      const scoped = await globalThis.desktopBridge.listWorkspaces()
      const ids = scoped.snapshot.workspaces.map(({ id }) => id)
      return topology.windows.find(({ workspaceIds }) =>
        workspaceIds.some((id) => ids.includes(id)))?.windowId ?? null
    })()`)
  }, rendererUrl)
}

function expectUniqueOwnership(projections) {
  const ownership = flatOwnership(projections)
  expect(new Set(ownership.workspaceIds).size).toBe(ownership.workspaceIds.length)
  expect(new Set(ownership.tabIds).size).toBe(ownership.tabIds.length)
  expect(new Set(ownership.runtimeSessionIds).size).toBe(ownership.runtimeSessionIds.length)
}

function flatOwnership(projections) {
  return {
    runtimeSessionIds: projections.flatMap(({ runtimeSessionIds }) => runtimeSessionIds).sort(),
    tabIds: projections.flatMap(({ tabIds }) => tabIds).sort(),
    workspaceIds: projections.flatMap(({ workspaceIds }) => workspaceIds).sort()
  }
}

async function applyDistinctBounds(application) {
  return application.evaluate(async ({ BrowserWindow, screen }, trustedUrl) => {
    const result = {}
    const windows = BrowserWindow.getAllWindows().filter(
      (candidate) => candidate.webContents.getURL() === trustedUrl
    )
    const workArea = screen.getPrimaryDisplay().workArea
    for (const [index, window] of windows.entries()) {
      const placementId = await window.webContents.executeJavaScript(`(async () => {
        const topology = await globalThis.desktopBridge.listWindows()
        const scoped = await globalThis.desktopBridge.listWorkspaces()
        const ids = scoped.snapshot.workspaces.map(({ id }) => id)
        return topology.windows.find(({ workspaceIds }) =>
          workspaceIds.some((id) => ids.includes(id)))?.windowId
      })()`)
      const width = Math.max(720, Math.min(900, workArea.width - 100))
      const height = Math.max(520, Math.min(680, workArea.height - 100))
      const bounds = {
        x: workArea.x + 20 + index * 45,
        y: workArea.y + 20 + index * 45,
        width,
        height
      }
      window.setBounds(bounds)
      result[placementId] = window.getNormalBounds()
    }
    return result
  }, rendererUrl)
}

async function nativeBoundsByPlacement(application) {
  return application.evaluate(async ({ BrowserWindow }, trustedUrl) => {
    const result = {}
    for (const window of BrowserWindow.getAllWindows().filter(
      (candidate) => candidate.webContents.getURL() === trustedUrl
    )) {
      const placementId = await window.webContents.executeJavaScript(`(async () => {
        const topology = await globalThis.desktopBridge.listWindows()
        const scoped = await globalThis.desktopBridge.listWorkspaces()
        const ids = scoped.snapshot.workspaces.map(({ id }) => id)
        return topology.windows.find(({ workspaceIds }) =>
          workspaceIds.some((id) => ids.includes(id)))?.windowId
      })()`)
      result[placementId] = window.getNormalBounds()
    }
    return result
  }, rendererUrl)
}

async function terminalIdentityOccurrences(application, identity) {
  return application.evaluate(
    async ({ BrowserWindow }, { identity: expected, trustedUrl }) => {
      const matches = []
      const expectedTabId = JSON.stringify(expected.tabId)
      const expectedTerminalId = JSON.stringify(expected.terminalId)
      for (const window of BrowserWindow.getAllWindows().filter(
        (candidate) => candidate.webContents.getURL() === trustedUrl
      )) {
        const projection = await window.webContents.executeJavaScript(`(async () => {
          const topology = await globalThis.desktopBridge.listWindows()
          const scoped = await globalThis.desktopBridge.listWorkspaces()
          const workspaceIds = scoped.snapshot.workspaces.map(({ id }) => id)
          const placement = topology.windows.find(({ workspaceIds: owned }) =>
            owned.some((id) => workspaceIds.includes(id)))
          const tabs = scoped.snapshot.workspaces.flatMap((workspace) => workspace.tabs)
          const tab = tabs.find(({ id }) => id === ${expectedTabId})
          const terminal = [...document.querySelectorAll('.terminal-pane')].find(
            (node) => node.getAttribute('data-terminal-id') === ${expectedTerminalId})
          return {
            placementId: placement?.windowId ?? null,
            processId: terminal?.getAttribute('data-process-id') ?? null,
            runtimeSessionId: tab?.content.kind === 'terminal' ? tab.content.runtimeSessionId : null,
            tabId: tab?.id ?? null,
            terminalId: terminal?.getAttribute('data-terminal-id') ?? null
          }
        })()`)
        if (
          projection.tabId === expected.tabId ||
          projection.runtimeSessionId === expected.runtimeSessionId ||
          projection.terminalId === expected.terminalId
        ) {
          matches.push(projection)
        }
      }
      return matches
    },
    { identity, trustedUrl: rendererUrl }
  )
}

async function unauthorizedTrustedSenderMessage(application) {
  return application.evaluate(
    async ({ BrowserWindow }, { preload, trustedUrl }) => {
      const registered = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === trustedUrl
      )
      if (!registered) throw new Error('Registered renderer is unavailable')
      const rogue = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, preload }
      })
      try {
        await rogue.loadURL(trustedUrl)
        return await rogue.webContents.executeJavaScript(`
        (async () => {
          try {
            await globalThis.desktopBridge.listWindows()
            return 'unexpected success'
          } catch (error) {
            return String(error?.message ?? error)
          }
        })()
      `)
      } finally {
        rogue.destroy()
      }
    },
    { preload: preloadEntry, trustedUrl: rendererUrl }
  )
}

async function crashPlacementRenderer(application, placementId) {
  return application.evaluate(async ({ BrowserWindow }, targetId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL() !== 'agent-workspace://renderer/index.html') continue
      const owns = await window.webContents.executeJavaScript(`(async () => {
        const topology = await globalThis.desktopBridge.listWindows()
        const scoped = await globalThis.desktopBridge.listWorkspaces()
        const ids = scoped.snapshot.workspaces.map(({ id }) => id)
        return topology.windows.find(({ workspaceIds }) =>
          workspaceIds.some((id) => ids.includes(id)))?.windowId
      })()`)
      if (owns === targetId) {
        const id = window.webContents.id
        window.webContents.forcefullyCrashRenderer()
        return id
      }
    }
    throw new Error('Placement renderer was unavailable')
  }, placementId)
}

async function recoveredPlacementProjection(application, webContentsId) {
  return application.evaluate(async ({ BrowserWindow }, expectedWebContentsId) => {
    globalThis.__m3RecoveryProjectionTrace ??= []
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === expectedWebContentsId
    )
    if (!window || window.webContents.getURL() !== 'agent-workspace://renderer/index.html') {
      globalThis.__m3RecoveryProjectionTrace.push({
        expectedWebContentsId,
        observedWebContents: BrowserWindow.getAllWindows().map((candidate) => ({
          id: candidate.webContents.id,
          url: candidate.webContents.getURL()
        })),
        result: null
      })
      return null
    }
    try {
      const projection = await Promise.race([
        window.webContents.executeJavaScript(`(async () => {
            const topology = await globalThis.desktopBridge.listWindows()
            const scoped = await globalThis.desktopBridge.listWorkspaces()
            const rendererReady = Boolean(document.querySelector('main.workspace-shell'))
            if (rendererReady) {
              await new Promise((resolvePromise) => requestAnimationFrame(() =>
                requestAnimationFrame(resolvePromise)))
            }
            return {
              bridgeAvailable: Boolean(globalThis.desktopBridge),
              rendererReady,
              scopedWorkspaceCount: scoped.snapshot.workspaces.length,
              topology
            }
          })()`),
        new Promise((_, reject) =>
          globalThis.setTimeout(
            () => reject(new Error('recovery projection executeJavaScript timed out')),
            1_000
          )
        )
      ])
      const result = { ...projection, webContentsId: window.webContents.id }
      globalThis.__m3RecoveryProjectionTrace.push({
        expectedWebContentsId,
        result,
        url: window.webContents.getURL()
      })
      return result
    } catch (error) {
      const result = {
        error: String(error?.message ?? error),
        url: window.webContents.getURL(),
        webContentsId: window.webContents.id
      }
      globalThis.__m3RecoveryProjectionTrace.push({ expectedWebContentsId, result })
      return result
    }
  }, webContentsId)
}

async function selectTabInPlacement(application, webContentsId, tabId) {
  return application.evaluate(
    async ({ BrowserWindow }, { expectedTabId, expectedWebContentsId }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === expectedWebContentsId
      )
      if (!window) throw new Error('Recovered renderer is unavailable')
      const encodedTabId = JSON.stringify(expectedTabId)
      return window.webContents.executeJavaScript(`(async () => {
          const scoped = await globalThis.desktopBridge.listWorkspaces()
          const workspace = scoped.snapshot.workspaces.find(({ tabs }) =>
            tabs.some(({ id }) => id === ${encodedTabId}))
          if (!workspace) throw new Error('Recovered terminal tab is not authoritatively owned')
          const pane = workspace.panes.find(({ id }) => id === workspace.selectedPaneId)
          if (pane?.selectedTabId !== ${encodedTabId}) {
            await globalThis.desktopBridge.selectTab({
              workspaceId: workspace.id,
              tabId: ${encodedTabId}
            })
          }
        })()`)
    },
    { expectedTabId: tabId, expectedWebContentsId: webContentsId }
  )
}

async function selectedTabIdInPlacement(application, webContentsId) {
  return application.evaluate(async ({ BrowserWindow }, expectedWebContentsId) => {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === expectedWebContentsId
    )
    if (!window) return null
    return window.webContents.executeJavaScript(`(async () => {
        const scoped = await globalThis.desktopBridge.listWorkspaces()
        const workspace = scoped.snapshot.workspaces.find(
          ({ id }) => id === scoped.snapshot.selectedWorkspaceId)
        const pane = workspace?.panes.find(({ id }) => id === workspace.selectedPaneId)
        return pane?.selectedTabId ?? null
      })()`)
  }, webContentsId)
}

async function sendShortcutToPlacement(application, webContentsId, keyCode, modifiers) {
  return application.evaluate(
    async ({ BrowserWindow }, { expectedModifiers, expectedKeyCode, expectedWebContentsId }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === expectedWebContentsId
      )
      if (!window) throw new Error('Recovered renderer is unavailable')
      const shellFocused = await window.webContents.executeJavaScript(`(() => {
          const target = document.querySelector('section.workspace-content')
          if (!(target instanceof HTMLElement)) return false
          target.focus()
          globalThis.addEventListener('keydown', (event) => {
            globalThis.__m3ObservedShortcut = {
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              key: event.key,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
              target: event.target instanceof Element ? event.target.tagName : null
            }
          }, { once: true })
          return document.activeElement === target
        })()`)
      if (!shellFocused)
        throw new Error('Recovered workspace shell could not receive keyboard input')
      window.focus()
      window.webContents.focus()
      window.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: expectedKeyCode,
        modifiers: expectedModifiers
      })
      window.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: expectedKeyCode,
        modifiers: expectedModifiers
      })
      await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 100))
      const observed = await window.webContents.executeJavaScript(
        `globalThis.__m3ObservedShortcut ?? null`
      )
      globalThis.__m3ShortcutTrace ??= []
      globalThis.__m3ShortcutTrace.push({
        expected: { keyCode: expectedKeyCode, modifiers: expectedModifiers },
        observed,
        webContentsId: window.webContents.id
      })
    },
    {
      expectedKeyCode: keyCode,
      expectedModifiers: modifiers,
      expectedWebContentsId: webContentsId
    }
  )
}

async function renderedSelectedTabInPlacement(application, webContentsId, tabId) {
  return application.evaluate(
    async ({ BrowserWindow }, { expectedTabId, expectedWebContentsId }) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === expectedWebContentsId
      )
      if (!window) return false
      const encodedTabId = JSON.stringify(expectedTabId)
      return window.webContents.executeJavaScript(`(async () => {
          const tab = document.querySelector('[data-tab-id=' + CSS.escape(${encodedTabId}) + ']')
          const selected = tab?.getAttribute('aria-selected') === 'true' &&
            tab?.getAttribute('data-selected') === 'true'
          if (selected) {
            await new Promise((resolvePromise) => requestAnimationFrame(() =>
              requestAnimationFrame(resolvePromise)))
          }
          return selected
        })()`)
    },
    { expectedTabId: tabId, expectedWebContentsId: webContentsId }
  )
}

async function closedItemsForPlacement(application, webContentsId) {
  return application.evaluate(async ({ BrowserWindow }, expectedWebContentsId) => {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === expectedWebContentsId
    )
    if (!window) throw new Error('Recovered renderer is unavailable')
    return window.webContents.executeJavaScript('globalThis.desktopBridge.listClosedItems()')
  }, webContentsId)
}

async function terminalProjectionForPlacement(application, webContentsId) {
  return application.evaluate(async ({ BrowserWindow }, expectedWebContentsId) => {
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === expectedWebContentsId
    )
    if (!window) throw new Error('Recovered renderer is unavailable')
    return window.webContents.executeJavaScript(`(async () => {
        const scoped = await globalThis.desktopBridge.listWorkspaces()
        const workspace = scoped.snapshot.workspaces.find(
          ({ id }) => id === scoped.snapshot.selectedWorkspaceId)
        const pane = workspace?.panes.find(({ id }) => id === workspace.selectedPaneId)
        const tab = workspace?.tabs.find(({ id }) => id === pane?.selectedTabId)
        const terminal = document.querySelector('.terminal-pane')
        return {
          processId: terminal?.getAttribute('data-process-id') ?? null,
          runtimeSessionId: tab?.content.kind === 'terminal' ? tab.content.runtimeSessionId : null,
          tabId: tab?.id ?? null,
          terminalId: terminal?.getAttribute('data-terminal-id') ?? null
        }
      })()`)
  }, webContentsId)
}

async function countTabId(application, tabId) {
  return application.evaluate(async ({ BrowserWindow }, expectedTabId) => {
    const encodedTabId = JSON.stringify(expectedTabId)
    const counts = await Promise.all(
      BrowserWindow.getAllWindows()
        .filter((window) => window.webContents.getURL() === 'agent-workspace://renderer/index.html')
        .map((window) =>
          window.webContents
            .executeJavaScript(
              `document.querySelectorAll('[data-tab-id="' + ${encodedTabId} + '"]').length`
            )
            .catch(() => 0)
        )
    )
    return counts.reduce((total, count) => total + count, 0)
  }, tabId)
}

function instrumentPage(page, errors) {
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !/(?:font(?:config)?|gpu|mesa|dri3|webgl)/iu.test(message.text())
    ) {
      errors.push(message.text())
    }
  })
}

function assertNoUnexpectedErrors(errors) {
  expect(errors.filter((message) => !isExpectedQualificationDiagnostic(message))).toEqual([])
}

function isExpectedQualificationDiagnostic(message) {
  return (
    /Electron sandboxed_renderer\.bundle\.js script failed to run/iu.test(message) ||
    /TypeError: Cannot destructure property 'preloadScripts'/iu.test(message) ||
    /ControlRequestError: The request target is outside this connection's window placement/iu.test(
      message
    ) ||
    /ControlRequestError: Tab source is not authoritative/iu.test(message) ||
    /Browser state reconciliation failed Error: ERR_ABORTED \(-3\)/iu.test(message) ||
    /Error occurred in handler for '(?:lifecycle:get|window:list)': Error: Unauthorized desktop IPC sender/iu.test(
      message
    ) ||
    /FATAL:content\/child\/child_thread_impl\.cc:\d+\] Crashing because hung/iu.test(message) ||
    /Error sending from webFrameMain:\s+Error: Render frame was disposed before WebFrameMain could be accessed/iu.test(
      message
    ) ||
    /ControlRequestError: The client must attach before submitting a terminal checkpoint/iu.test(
      message
    ) ||
    /ControlRequestError: The terminal no longer exists/iu.test(message) ||
    /Error occurred in handler for 'workspace:selectMany': ControlRequestError: The expected revision does not match durable state/iu.test(
      message
    )
  )
}

async function persistQualificationEvidence(testInfo, evidence) {
  const evidencePath = testInfo.outputPath('multi-window-qualification.json')
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
  await testInfo.attach('multi-window-qualification', {
    contentType: 'application/json',
    path: evidencePath
  })
}

async function persistFailureEvidence(testInfo, application, errors, failure) {
  const evidencePath = testInfo.outputPath('multi-window-failure-trace.json')
  let main = {
    browserLifecycle: [],
    ipc: [],
    recoveryProjection: [],
    shortcuts: [],
    windows: []
  }
  if (application) {
    main = await application
      .evaluate(async ({ BrowserWindow }) => {
        const windows = []
        for (const window of BrowserWindow.getAllWindows()) {
          const renderer = await Promise.race([
            window.webContents
              .executeJavaScript(
                `({
                body: document.body?.innerText ?? '',
                trace: globalThis.__m3RendererTrace ?? null
              })`
              )
              .catch((error) => ({ error: String(error?.message ?? error) })),
            new Promise((resolvePromise) =>
              globalThis.setTimeout(
                () => resolvePromise({ error: 'renderer evidence timed out' }),
                1_000
              )
            )
          ])
          windows.push({
            bounds: window.getNormalBounds(),
            focused: window.isFocused(),
            renderer,
            url: window.webContents.getURL(),
            webContentsId: window.webContents.id
          })
        }
        return {
          browserLifecycle: globalThis.__m3BrowserLifecycleTrace ?? [],
          ipc: globalThis.__m3IpcTrace ?? [],
          recoveryProjection: globalThis.__m3RecoveryProjectionTrace ?? [],
          shortcuts: globalThis.__m3ShortcutTrace ?? [],
          windows
        }
      })
      .catch((error) => ({
        browserLifecycle: [],
        error: String(error?.message ?? error),
        ipc: [],
        recoveryProjection: [],
        shortcuts: [],
        windows: []
      }))
  }
  const evidence = {
    failure:
      failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure,
    main,
    output: errors
  }
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  await testInfo.attach('multi-window-failure-trace', {
    contentType: 'application/json',
    path: evidencePath
  })
}

async function readDiagnosticLogs(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const logs = {}
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        Object.assign(logs, await readDiagnosticLogs(path))
      } else if (entry.isFile()) {
        logs[path] = (await readFile(path, 'utf8')).slice(-8_192)
      }
    }
    return logs
  } catch {
    return {}
  }
}
