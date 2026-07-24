import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'
import axe from 'axe-core'

import { closeElectronApplication } from './helpers/close-electron-application.mjs'
import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const dialogHarnessEntry = join(desktopDirectory, 'e2e/helpers/dialog-harness-main.cjs')
const executable = (name) =>
  join(repositoryDirectory, 'target', 'debug', process.platform === 'win32' ? `${name}.exe` : name)
const serviceBinary = executable('agent-workspace-service')
const cliBinary = executable('agent-workspace-cli')
const rendererUrl = 'agent-workspace://renderer/index.html'
const evidenceDirectory =
  process.env.AGENT_WORKSPACE_EVIDENCE_DIR ?? join(tmpdir(), 'agent-workspace-m8-evidence')
const sidebarLabels = [
  'Text Box',
  'Vault',
  'Task Manager',
  'Files',
  'Markdown',
  'Diff',
  'Search',
  'Recently Closed'
]

test.beforeAll(() => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('M8 packaged Electron E2E needs an X11 or Wayland display.')
  }
  execFileSync('cargo', ['build', '-p', 'agent-workspace-service', '-p', 'agent-workspace-cli'], {
    cwd: repositoryDirectory,
    stdio: 'pipe'
  })
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
})

test('packaged sidebar mounts all fixed surfaces and restores keyboard placement at supported zoom', async () => {
  test.fixme(
    true,
    'The tools sidebar has no entry point while the right-sidebar rework is in flight; re-enable once it ships again.'
  )
  test.setTimeout(60_000)
  const fixture = await launchFixture('placement')
  try {
    const { application, page } = fixture
    const sidebar = page.locator('.right-sidebar')
    await expect(sidebar).toBeVisible()
    const tabs = sidebar.getByRole('tab')
    await expect
      .poll(async () => ((await tabs.count()) === 8 ? 'ready' : await sidebar.innerText()), {
        timeout: 20_000
      })
      .toBe('ready')
    expect(await tabs.allTextContents()).toEqual(sidebarLabels)
    const resizer = sidebar.getByRole('separator', { name: 'Resize tools sidebar' })
    await expect(resizer).toHaveAttribute('aria-valuenow', '320')

    const textBox = sidebar.getByRole('tab', { name: 'Text Box' })
    const vault = sidebar.getByRole('tab', { name: 'Vault' })
    await textBox.focus()
    await textBox.press('ArrowRight')
    await expect(vault).toBeFocused()
    await expect(vault).toHaveAttribute('aria-selected', 'true')
    await vault.press('End')
    const recentlyClosed = sidebar.getByRole('tab', { name: 'Recently Closed' })
    await expect(recentlyClosed).toBeFocused()
    await expect(recentlyClosed).toHaveAttribute('aria-selected', 'true')
    await recentlyClosed.press('Home')
    await expect(textBox).toBeFocused()
    await expect(textBox).toHaveAttribute('aria-selected', 'true')

    await resizer.focus()
    await resizer.press('ArrowLeft')
    await expect(resizer).toHaveAttribute('aria-valuenow', '332')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.right-sidebar')).toBeVisible()
    await expect(page.getByRole('separator', { name: 'Resize tools sidebar' })).toHaveAttribute(
      'aria-valuenow',
      '332'
    )
    await expect(page.getByRole('tab', { name: 'Text Box' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(480, 800)
    })
    await page.setViewportSize({ height: 800, width: 480 })
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([480, 800])
    const narrowSidebarBounds = await page.locator('.right-sidebar').boundingBox()
    expect(narrowSidebarBounds).not.toBeNull()
    expect(narrowSidebarBounds?.y ?? -1).toBeGreaterThanOrEqual(32)
    expect(narrowSidebarBounds?.height ?? 0).toBeGreaterThan(700)
    expect((narrowSidebarBounds?.x ?? 0) + (narrowSidebarBounds?.width ?? 0)).toBeLessThanOrEqual(
      480
    )
    expect((narrowSidebarBounds?.y ?? 0) + (narrowSidebarBounds?.height ?? 0)).toBeLessThanOrEqual(
      800
    )
    const tabOverflowPresentation = await page
      .locator('.right-sidebar-tabs')
      .evaluate((element) => ({
        scrollbarWidth: globalThis.getComputedStyle(element).scrollbarWidth,
        webkitScrollbarDisplay: globalThis.getComputedStyle(element, '::-webkit-scrollbar').display
      }))
    expect(tabOverflowPresentation.scrollbarWidth).toBe('none')
    expect(tabOverflowPresentation.webkitScrollbarDisplay).toBe('none')
    await page.screenshot({
      animations: 'disabled',
      path: join(evidenceDirectory, 'm8-sidebar-narrow.png')
    })

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setContentSize(1600, 1000)
      window?.webContents.setZoomFactor(2)
    })
    await page.setViewportSize({ height: 1000, width: 1600 })
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
        )
      )
      .toBe(2)
    await page.getByRole('tab', { name: 'Recently Closed' }).scrollIntoViewIfNeeded()
    await page.getByRole('tab', { name: 'Recently Closed' }).focus()
    await expect(page.getByRole('tab', { name: 'Recently Closed' })).toBeFocused()
    await expect(page.locator('.right-sidebar')).toBeInViewport()

    await page.evaluate(axe.source)
    const violations = await page.evaluate(async () => {
      const result = await globalThis.axe.run('.right-sidebar', {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }
      })
      return result.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        targets: nodes.map((node) => node.target)
      }))
    })
    expect(violations, '200% zoom sidebar accessibility violations').toEqual([])
    await mkdir(evidenceDirectory, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      path: join(evidenceDirectory, 'm8-sidebar-zoom-200.png')
    })

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(4)
    })
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
        )
      )
      .toBeCloseTo(4, 5)
    await page.getByRole('tab', { name: 'Recently Closed' }).scrollIntoViewIfNeeded()
    await page.getByRole('tab', { name: 'Recently Closed' }).focus()
    await expect(page.getByRole('tab', { name: 'Recently Closed' })).toBeFocused()
    const extremeZoomBounds = await page.locator('.right-sidebar').boundingBox()
    expect(extremeZoomBounds).not.toBeNull()
    expect(extremeZoomBounds?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((extremeZoomBounds?.x ?? 0) + (extremeZoomBounds?.width ?? 0)).toBeLessThanOrEqual(
      await page.evaluate(() => globalThis.document.documentElement.getBoundingClientRect().right)
    )
    await page.screenshot({
      animations: 'disabled',
      path: join(evidenceDirectory, 'm8-sidebar-zoom-400.png')
    })
  } finally {
    await fixture.cleanup()
  }
})

test('packaged recently closed reopens its exact target and Task Manager uses native confirmation', async () => {
  test.fixme(
    true,
    'The tools sidebar has no entry point while the right-sidebar rework is in flight; re-enable once it ships again.'
  )
  test.setTimeout(60_000)
  const agentSessionId = randomUUID()
  const fixture = await launchFixture('task', { agentSessionId, messageResponses: [1] })
  try {
    const { application, page, sessionFile, tracePath } = fixture
    const selectedPane = page.locator('[data-pane-id][data-selected="true"]')
    await mkdir(evidenceDirectory, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      path: join(evidenceDirectory, 'm8-task-manager-before.png')
    })
    await selectedPane.getByRole('button', { name: 'Add tab' }).click()
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click()
    const before = await selectedTerminalTarget(page)
    const utilities = selectedPane.getByRole('toolbar', { name: new RegExp(before.title) })
    await utilities
      .getByRole('button', { name: new RegExp(`Close ${escapeRegExp(before.title)}`) })
      .click()
    await expect(page.locator(`[data-tab-id="${before.tabId}"]`)).toHaveCount(0)

    await page.getByRole('tab', { name: 'Recently Closed' }).click()
    const record = page.locator('.right-sidebar .surface-card', { hasText: before.title })
    await expect(record).toContainText('reopenTerminal')
    await record.getByRole('button', { name: 'Reopen' }).click()
    await expect
      .poll(async () => {
        const candidate = await selectedTerminalTarget(page)
        return {
          cwd: candidate.cwd,
          paneId: candidate.paneId,
          runtimeWasReplaced: candidate.runtimeSessionId !== before.runtimeSessionId,
          tabWasReplaced: candidate.tabId !== before.tabId,
          title: candidate.title
        }
      })
      .toEqual({
        cwd: before.cwd,
        paneId: before.paneId,
        runtimeWasReplaced: true,
        tabWasReplaced: true,
        title: before.title
      })
    const after = await selectedTerminalTarget(page)
    expect(after.paneId).toBe(before.paneId)
    expect(after.tabId).not.toBe(before.tabId)
    expect(after.runtimeSessionId).not.toBe(before.runtimeSessionId)
    expect(after.title).toBe(before.title)
    expect(after.cwd).toBe(before.cwd)

    await cli(sessionFile, [
      'agent',
      'catalog-register',
      '--params-json',
      JSON.stringify({
        catalogVersion: 1,
        binding: {
          workspaceId: after.workspaceId,
          paneId: after.paneId,
          tabId: after.tabId,
          agentSessionId
        },
        adapterId: 'codex',
        adapterVersion: '0.142.4',
        title: 'M8 authoritative agent task',
        operation: {
          idempotencyKey: randomUUID(),
          requestHash: 'a'.repeat(64),
          sessionRevision: 1,
          attemptEpoch: 1
        }
      })
    ])

    await page.getByRole('tab', { name: 'Task Manager' }).click()
    const task = page.locator('.right-sidebar .surface-card', {
      hasText: 'M8 authoritative agent task'
    })
    await expect(task).toContainText('agent · created')
    await task.getByRole('button', { name: 'Terminate', exact: true }).click()
    await expect(task).toContainText('agent · terminated')

    const trace = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(trace).toContainEqual(
      expect.objectContaining({ kind: 'message', title: 'Confirm task action' })
    )
    const controlRequests = await application.evaluate(() =>
      (globalThis.__m5ControlRequests ?? [])
        .filter(({ command }) => command.startsWith('task.'))
        .map(({ command, params }) => ({ command, params }))
    )
    expect(controlRequests.map(({ command }) => command)).toEqual(
      expect.arrayContaining(['task.confirmation.issue', 'task.action'])
    )
    const action = controlRequests.find(({ command }) => command === 'task.action')
    expect(action?.params).toMatchObject({
      action: 'terminate',
      confirmation: { action: 'terminate', target: { sessionId: agentSessionId } },
      target: { sessionId: agentSessionId }
    })
  } finally {
    await fixture.cleanup()
  }
})

test('packaged search opens a revalidated result from an authorized workspace root', async () => {
  test.fixme(
    true,
    'The tools sidebar has no entry point while the right-sidebar rework is in flight; re-enable once it ships again.'
  )
  test.setTimeout(60_000)
  const marker = `M8_AUTHORIZED_SEARCH_${process.pid}_${Date.now()}`
  const fixture = await launchFixture('search', { workspaceFile: `safe ${marker} preview\n` })
  try {
    const { page, sessionFile, workspaceDirectory } = fixture
    await openWorkspace(page, workspaceDirectory)
    const roots = await cli(sessionFile, [
      'sidebar',
      'root-list',
      '--params-json',
      JSON.stringify({ limit: 100 })
    ])
    const root = roots.roots.find(({ label }) => label === basename(workspaceDirectory))
    expect(root, 'newly authorized workspace root').toBeDefined()

    const policy = await cliWhenProviderReady(sessionFile, [
      'sidebar',
      'search-source-policy',
      '--params-json',
      JSON.stringify({
        sourceAuthorizationId: root.rootId,
        sourceKind: 'workspaceFile',
        retentionDays: 30,
        exclusionIds: [],
        mutation: {
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          requestHash: 'b'.repeat(64)
        }
      })
    ])
    await cli(sessionFile, [
      'sidebar',
      'search-source-rebuild',
      '--params-json',
      JSON.stringify({
        sourceAuthorizationId: root.rootId,
        cancellationId: randomUUID(),
        mutation: {
          expectedRevision: policy.revision,
          idempotencyKey: randomUUID(),
          requestHash: 'c'.repeat(64)
        }
      })
    ])

    await page.getByRole('tab', { name: 'Search' }).focus()
    await page.getByRole('tab', { name: 'Search' }).press('Enter')
    const searchInput = page
      .locator('.right-sidebar')
      .getByRole('textbox', { name: 'Search', exact: true })
    await searchInput.fill(marker)
    await searchInput.press('Enter')
    const result = page.locator('.right-sidebar .surface-card', { hasText: marker })
    await expect(result).toContainText('workspaceFile')
    const openPreview = result.getByRole('button', { name: 'Open preview' })
    await openPreview.focus()
    await openPreview.press('Enter')
    await expect(page.getByRole('region', { name: 'Preview m8-search.txt' })).toContainText(marker)
  } finally {
    await fixture.cleanup()
  }
})

test('packaged Vault enforces transcript consent, exclusion, retention, rebuild, and forget', async () => {
  test.fixme(
    true,
    'The tools sidebar has no entry point while the right-sidebar rework is in flight; re-enable once it ships again.'
  )
  test.setTimeout(60_000)
  const agentSessionId = randomUUID()
  const marker = `M8_PRIVATE_TRANSCRIPT_${process.pid}_${Date.now()}`
  const fixture = await launchFixture('vault', { agentSessionId, transcriptText: marker })
  try {
    const { page, sessionFile } = fixture
    const target = await selectedTerminalTarget(page)
    await cli(sessionFile, [
      'agent',
      'catalog-register',
      '--params-json',
      JSON.stringify({
        catalogVersion: 1,
        binding: {
          workspaceId: target.workspaceId,
          paneId: target.paneId,
          tabId: target.tabId,
          agentSessionId
        },
        adapterId: 'codex',
        adapterVersion: '0.142.4',
        title: 'M8 private transcript',
        operation: {
          idempotencyKey: randomUUID(),
          requestHash: 'd'.repeat(64),
          sessionRevision: 1,
          attemptEpoch: 1
        }
      })
    ])

    const mutation = (expectedRevision) => ({
      expectedRevision,
      idempotencyKey: randomUUID(),
      requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)
    })
    const policy = async (expectedRevision, exclusionIds) =>
      cliWhenProviderReady(sessionFile, [
        'sidebar',
        'search-source-policy',
        '--params-json',
        JSON.stringify({
          sourceAuthorizationId: agentSessionId,
          sourceKind: 'agentTranscript',
          retentionDays: 1,
          exclusionIds,
          mutation: mutation(expectedRevision)
        })
      ])
    const rebuild = async (expectedRevision) =>
      cli(sessionFile, [
        'sidebar',
        'search-source-rebuild',
        '--params-json',
        JSON.stringify({
          sourceAuthorizationId: agentSessionId,
          cancellationId: randomUUID(),
          mutation: mutation(expectedRevision)
        })
      ])
    const query = async () =>
      cli(sessionFile, [
        'sidebar',
        'search-query',
        '--params-json',
        JSON.stringify({ query: marker, limit: 100, cancellationId: randomUUID() })
      ])

    const excludedPolicy = await policy(1, [agentSessionId])
    const excludedRebuild = await rebuild(excludedPolicy.revision)
    expect((await query()).results).toEqual([])

    const includedPolicy = await policy(excludedRebuild.revision, [])
    const includedRebuild = await rebuild(includedPolicy.revision)
    expect((await query()).results).toEqual([
      expect.objectContaining({
        sourceKind: 'agentTranscript',
        snippet: expect.stringContaining(marker)
      })
    ])

    const excluded = await cli(sessionFile, [
      'sidebar',
      'search-source-exclude',
      '--params-json',
      JSON.stringify({
        sourceAuthorizationId: agentSessionId,
        mutation: mutation(includedRebuild.revision)
      })
    ])
    expect((await query()).results).toEqual([])

    const reauthorized = await policy(excluded.revision, [])
    const rebuilt = await rebuild(reauthorized.revision)
    expect((await query()).results).toHaveLength(1)

    await cli(sessionFile, [
      'sidebar',
      'search-source-forget',
      '--params-json',
      JSON.stringify({
        sourceAuthorizationId: agentSessionId,
        mutation: mutation(rebuilt.revision)
      })
    ])
    expect((await query()).results).toEqual([])
  } finally {
    await fixture.cleanup()
  }
})

async function launchFixture(name, options = {}) {
  const profileDirectory = await mkdtemp(join(tmpdir(), `agent-workspace-m8-${name}-`))
  const workspaceDirectory = join(profileDirectory, 'authorized-workspace')
  const fakeBin = join(profileDirectory, 'bin')
  const tracePath = join(profileDirectory, 'native-dialogs.jsonl')
  await mkdir(workspaceDirectory, { recursive: true })
  await mkdir(fakeBin, { recursive: true })
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated M8 Electron E2E shell.\n')
  await writeFile(tracePath, '')
  if (options.workspaceFile) {
    await writeFile(join(workspaceDirectory, 'm8-search.txt'), options.workspaceFile)
  }
  if (options.agentSessionId) {
    await writeFakeCodex(fakeBin, options.agentSessionId, options.transcriptText)
  }

  const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
  const sessionFile = join(harness.runtimeDirectory, 'agent-workspace', 'cli-session.json')
  let application
  let page
  const rendererDiagnostics = []
  try {
    application = await electron.launch({
      args: [dialogHarnessEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        AGENT_WORKSPACE_E2E_DIALOG_RESPONSES: JSON.stringify({
          messageResponses: options.messageResponses ?? [],
          tracePath
        }),
        AGENT_WORKSPACE_E2E_USER_DATA_DIR: profileDirectory,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      },
      timeout: 10_000
    })
    page = await application.firstWindow()
    await page.bringToFront()
    await setApplicationZoom(application, 1)
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800)
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect
      .poll(async () => ({
        native: await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          return {
            boundsWidth: window?.getBounds().width,
            contentWidth: window?.getContentBounds().width,
            zoom: window?.webContents.getZoomFactor()
          }
        }),
        viewportWidth: await page.evaluate(() => globalThis.innerWidth)
      }))
      .toEqual({
        native: { boundsWidth: 1280, contentWidth: 1280, zoom: 1 },
        viewportWidth: 1280
      })
    page.on('console', (message) =>
      rendererDiagnostics.push(`console:${message.type()}:${message.text()}`)
    )
    page.on('pageerror', (error) =>
      rendererDiagnostics.push(`pageerror:${error.stack ?? error.message}`)
    )
    await expect.poll(() => page.url(), { timeout: 20_000 }).toBe(rendererUrl)
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/, {
      timeout: 20_000
    })
    const toggleToolsSidebar = page.getByRole('button', { name: 'Toggle tools sidebar' })
    await expect(toggleToolsSidebar).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 })
    await toggleToolsSidebar.focus()
    await toggleToolsSidebar.press('Enter')
    await expect(toggleToolsSidebar).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.right-sidebar')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => {
        try {
          return (await cli(sessionFile, ['identify'])).application
        } catch {
          return null
        }
      })
      .toBe('agent-workspace')
    return {
      application,
      page,
      profileDirectory,
      sessionFile,
      tracePath,
      workspaceDirectory,
      cleanup: async () => {
        await setApplicationZoom(application, 1).catch(() => undefined)
        await closeElectronApplication(application).catch(() => undefined)
        await clearContentIndexSecret(profileDirectory)
        if (process.env.AGENT_WORKSPACE_E2E_PRESERVE_PROFILE === '1') return
        await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
      }
    }
  } catch (error) {
    await mkdir(evidenceDirectory, { recursive: true })
    const bodyText = await page
      ?.locator('body')
      .innerText()
      .catch(() => '')
    await writeFile(
      join(evidenceDirectory, `m8-${name}-launch-diagnostics.txt`),
      [`url=${page?.url() ?? '<no-window>'}`, `body=${bodyText}`, ...rendererDiagnostics].join('\n')
    )
    await setApplicationZoom(application, 1).catch(() => undefined)
    await closeElectronApplication(application).catch(() => undefined)
    await clearContentIndexSecret(profileDirectory)
    if (process.env.AGENT_WORKSPACE_E2E_PRESERVE_PROFILE !== '1') {
      await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
    }
    throw error
  }
}

async function clearContentIndexSecret(profileDirectory) {
  if (process.platform !== 'linux') return
  try {
    const keyId = (
      await readFile(join(profileDirectory, 'state', 'content-index-key-id'), 'utf8')
    ).trim()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(keyId))
      return
    await execFileAsync('secret-tool', [
      'clear',
      'application',
      'cmux-linux-alternative',
      'kind',
      'content-index-key-v1',
      'key-id',
      keyId
    ])
  } catch {
    // A missing locator or Secret Service means no exact test secret can be removed.
  }
}

async function setApplicationZoom(application, factor) {
  await application?.evaluate(({ BrowserWindow }, zoomFactor) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoomFactor)
  }, factor)
}

async function cli(sessionFile, args) {
  const { stdout } = await execFileAsync(cliBinary, ['--session-file', sessionFile, ...args])
  return JSON.parse(stdout)
}

async function cliWhenProviderReady(sessionFile, args) {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      return await cli(sessionFile, args)
    } catch (error) {
      if (
        !String(error?.stderr ?? error).includes('(provider_unavailable)') ||
        Date.now() >= deadline
      ) {
        throw error
      }
      await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 200))
    }
  }
}

async function openWorkspace(page, workingDirectory) {
  await page.evaluate(
    async ({ name, workingDirectory }) =>
      globalThis.desktopBridge.createWorkspace({
        name,
        workingDirectory,
        initialTerminal: { cwd: workingDirectory, rows: 24, cols: 80 }
      }),
    { name: basename(workingDirectory), workingDirectory }
  )
  await page.bringToFront()
  await expect(page.locator('.workspace-title')).toHaveText(basename(workingDirectory))
}

async function selectedTerminalTarget(page) {
  return page.evaluate(async () => {
    const result = await globalThis.desktopBridge.listWorkspaces()
    const workspace = result.snapshot.workspaces.find(
      ({ id }) => id === result.snapshot.selectedWorkspaceId
    )
    const pane = workspace?.panes.find(({ id }) => id === workspace.selectedPaneId)
    const tab = workspace?.tabs.find(({ id }) => id === pane?.selectedTabId)
    if (!workspace || !pane || !tab || tab.content.kind !== 'terminal') {
      throw new Error('Selected terminal target is unavailable')
    }
    return {
      cwd: tab.content.launch.cwd,
      paneId: pane.id,
      runtimeSessionId: tab.content.runtimeSessionId,
      tabId: tab.id,
      title: tab.title,
      workspaceId: workspace.id
    }
  })
}

async function writeFakeCodex(directory, agentSessionId, transcriptText = 'M8 test transcript') {
  const path = join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  const transcriptResponse = JSON.stringify({
    id: 2,
    result: {
      thread: {
        id: agentSessionId,
        turns: [{ items: [{ type: 'agentMessage', id: 'm8-item', text: transcriptText }] }]
      }
    }
  })
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "codex-cli 0.142.4"\n  exit 0\nfi\nIFS= read -r initialize\nprintf '%s\\n' '{"id":1,"result":{}}'\nIFS= read -r initialized\nIFS= read -r request\nprintf '%s\\n' '${transcriptResponse}'\n`
  )
  await chmod(path, 0o755)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
