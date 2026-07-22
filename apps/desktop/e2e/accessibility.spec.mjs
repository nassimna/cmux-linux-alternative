import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'
import axe from 'axe-core'

import { closeElectronApplication } from './helpers/close-electron-application.mjs'
import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'
import { seedRepresentativeRichCardSlots } from './helpers/rich-card-slots.mjs'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const mainEntry = join(desktopDirectory, 'out/main/index.js')
const executable = (name) =>
  join(repositoryDirectory, 'target', 'debug', process.platform === 'win32' ? `${name}.exe` : name)
const serviceBinary = executable('agent-workspace-service')
const cliBinary = executable('agent-workspace-cli')
const rendererUrl = 'agent-workspace://renderer/index.html'
const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const evidenceDirectory =
  process.env.AGENT_WORKSPACE_EVIDENCE_DIR ?? join(tmpdir(), 'agent-workspace-m6-accessibility')

async function audit(page, state) {
  await page.evaluate(axe.source)
  const results = await page.evaluate(async () =>
    globalThis.axe.run(globalThis.document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
      }
    })
  )
  const violations = results.violations.map(({ help, impact, id, nodes }) => ({
    help,
    id,
    impact,
    targets: nodes.map((node) => ({ summary: node.failureSummary, target: node.target }))
  }))
  expect(violations, `${state} WCAG A/AA violations`).toEqual([])
}

async function auditColorContrast(page, locator, state) {
  await page.evaluate(axe.source)
  await locator.evaluate((element) => element.setAttribute('data-a11y-contrast-target', ''))
  const result = await page.evaluate(async () => {
    const results = await globalThis.axe.run(
      { include: [['[data-a11y-contrast-target]']] },
      {
        runOnly: {
          type: 'rule',
          values: ['color-contrast']
        }
      }
    )
    const canvas = globalThis.document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas color context is unavailable.')
    const rgb = (color) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)]
    }
    const luminance = (color) =>
      rgb(color)
        .map((channel) => channel / 255)
        .map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
    const contrast = (foreground, background) => {
      const lighter = Math.max(luminance(foreground), luminance(background))
      const darker = Math.min(luminance(foreground), luminance(background))
      return (lighter + 0.05) / (darker + 0.05)
    }
    const element = globalThis.document.querySelector('[data-a11y-contrast-target]')
    if (!element) throw new Error('Color contrast target is unavailable.')
    const foreground = globalThis.getComputedStyle(element).color
    const tokens = globalThis.getComputedStyle(globalThis.document.documentElement)
    return {
      checkedNodeCount:
        (results.passes.find(({ id }) => id === 'color-contrast')?.nodes.length ?? 0) +
        (results.incomplete.find(({ id }) => id === 'color-contrast')?.nodes.length ?? 0),
      contrastRatios: [
        contrast(foreground, tokens.getPropertyValue('--aw-color-surface-overlay')),
        contrast(foreground, tokens.getPropertyValue('--aw-color-surface-interactive'))
      ],
      violations: results.violations.map(({ help, impact, id, nodes }) => ({
        help,
        id,
        impact,
        targets: nodes.map((node) => ({ summary: node.failureSummary, target: node.target }))
      }))
    }
  })
  await locator.evaluate((element) => element.removeAttribute('data-a11y-contrast-target'))
  expect(result.violations, `${state} color contrast violations`).toEqual([])
  expect(result.checkedNodeCount, `${state} color contrast nodes checked`).toBeGreaterThan(0)
  expect(
    Math.min(...result.contrastRatios),
    `${state} minimum gradient contrast`
  ).toBeGreaterThanOrEqual(4.5)
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Electron accessibility E2E needs an X11 or Wayland display.')
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

test('representative renderer states meet the accessibility baseline', async () => {
  test.setTimeout(90_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m6-a11y-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated accessibility audit shell.\n')
  let electronApplication

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
    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800)
    })
    await page.setViewportSize({ height: 800, width: 1200 })

    await expect.poll(() => page.url()).toBe(rendererUrl)
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([1200, 800])
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    await expect(page.locator('.workspace-runtime-metadata')).toHaveAttribute(
      'aria-label',
      /Git branch .+; process .+; no listening ports$/u,
      { timeout: 10_000 }
    )
    await page.getByRole('button', { name: 'Open settings' }).click()
    const initialSettings = page.getByRole('dialog', { name: 'Settings' })
    await expect(initialSettings).toBeVisible()
    await saveTheme(page, initialSettings, 'dark')
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(evidenceDirectory, '01-initial-workspace.png') })
    await audit(page, 'fresh-profile initialized workspace in dark appearance')

    const workspaceList = page.getByRole('list', { name: 'Workspace list' })
    const groupedState = await page.evaluate(async (workingDirectory) => {
      const before = await globalThis.desktopBridge.listWorkspaces()
      const focusedWorkspaceId = before.snapshot.selectedWorkspaceId
      const created = await globalThis.desktopBridge.createWorkspace({
        name: 'Collapsed group member',
        workingDirectory,
        initialTerminal: { cwd: workingDirectory, rows: 30, cols: 120 }
      })
      const groupedWorkspace = created.snapshot.workspaces.find(
        ({ name }) => name === 'Collapsed group member'
      )
      if (!groupedWorkspace) throw new Error('Grouped accessibility workspace is missing')
      let organization = await globalThis.desktopBridge.getWorkspaceOrganization()
      await globalThis.desktopBridge.selectWorkspaces({
        selection: [focusedWorkspaceId],
        focusedWorkspaceId,
        expectedRevision: organization.organization.revision,
        idempotencyKey: globalThis.crypto.randomUUID()
      })
      organization = await globalThis.desktopBridge.getWorkspaceOrganization()
      const groupId = globalThis.crypto.randomUUID()
      await globalThis.desktopBridge.createGroup({
        groupId,
        name: 'Accessibility group',
        expectedRevision: organization.organization.revision,
        idempotencyKey: globalThis.crypto.randomUUID()
      })
      organization = await globalThis.desktopBridge.getWorkspaceOrganization()
      await globalThis.desktopBridge.assignWorkspaceGroup({
        workspaceId: groupedWorkspace.id,
        groupId,
        expectedRevision: organization.organization.revision,
        idempotencyKey: globalThis.crypto.randomUUID()
      })
      organization = await globalThis.desktopBridge.getWorkspaceOrganization()
      await globalThis.desktopBridge.collapseGroup({
        groupId,
        collapsed: true,
        expectedRevision: organization.organization.revision,
        idempotencyKey: globalThis.crypto.randomUUID()
      })
      return { focusedWorkspaceId, groupedWorkspaceId: groupedWorkspace.id }
    }, profileDirectory)
    const collapsedGroup = page.getByRole('button', { name: 'Expand Accessibility group' })
    await expect(collapsedGroup).toHaveAttribute('aria-expanded', 'false')
    await expect(
      page.locator(`[data-workspace-id="${groupedState.groupedWorkspaceId}"]`)
    ).toHaveCount(0)
    await expect(
      page.locator(`[data-workspace-id="${groupedState.focusedWorkspaceId}"] .workspace-row`)
    ).toHaveAttribute('aria-current', 'page')
    await collapsedGroup.focus()
    await expect(collapsedGroup).toBeFocused()
    await audit(page, 'collapsed workspace group with visible focused ungrouped workspace')

    const selectedWorkspace = workspaceList.locator('.workspace-row[aria-current="page"]')
    await selectedWorkspace.focus()
    await expect(selectedWorkspace).toBeFocused()
    await page.keyboard.press('Home')
    await expect(workspaceList.locator('.workspace-row[aria-current="page"]')).toBeFocused()

    const selectedTab = page.locator('.pane-view.selected').getByRole('tab', { selected: true })
    await selectedTab.focus()
    await expect(selectedTab).toBeFocused()
    await page.keyboard.press('Home')
    await expect(
      page.locator('.pane-view.selected').getByRole('tab', { selected: true })
    ).toBeFocused()

    await page.getByRole('button', { name: 'Split pane right' }).focus()
    await page.keyboard.press('Enter')
    const separator = page.getByRole('separator').first()
    await expect(separator).toBeVisible()
    await separator.focus()
    await expect(separator).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await audit(page, 'split workspace with tabs and separator')

    await page.keyboard.press(`${primaryModifier}+Shift+P`)
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const commandSearch = palette.getByRole('combobox', { name: 'Search commands' })
    await expect(commandSearch).toBeFocused()
    const initialCommand = await commandSearch.getAttribute('aria-activedescendant')
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(() => commandSearch.getAttribute('aria-activedescendant'))
      .not.toBe(initialCommand)
    await audit(page, 'command palette')
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)

    const settingsTrigger = page.getByRole('button', { name: 'Open settings' })
    await settingsTrigger.focus()
    await page.keyboard.press('Enter')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    const theme = settings.getByLabel('Theme')
    await theme.focus()
    await page.keyboard.press('Tab')
    await expect(settings.getByLabel('Density')).toBeFocused()
    await audit(page, 'settings in dark appearance')
    await saveTheme(page, settings, 'light')
    await audit(page, 'settings in light appearance')
    await page.screenshot({ path: join(evidenceDirectory, '02-settings.png') })
    await page.keyboard.press('Escape')
    await audit(page, 'split workspace in light appearance')

    const activeWorkspace = page.locator('[data-workspace-id][data-selected="true"]')
    const activePane = page.locator('[data-pane-id][data-selected="true"]')
    const activeTab = activePane.locator('[data-tab-id][data-selected="true"]')
    const workspaceId = await activeWorkspace.getAttribute('data-workspace-id')
    const paneId = await activePane.getAttribute('data-pane-id')
    const tabId = await activeTab.getAttribute('data-tab-id')
    if (!workspaceId || !paneId || !tabId) throw new Error('Active workspace target is missing.')
    await seedRepresentativeRichCardSlots(page, workspaceId)
    const richCards = page.getByRole('region', { name: 'Workspace card details' })
    await expect(richCards).toBeVisible()
    await expect(richCards.locator(':scope > *')).toHaveCount(9)
    await expect(richCards.locator('script, img')).toHaveCount(0)
    await expect(
      richCards.getByText(/<script>globalThis\.compromised=true<\/script>/u)
    ).toBeVisible()
    await expect(richCards.getByRole('link', { name: 'Approved link' })).toHaveAttribute(
      'rel',
      'noreferrer noopener'
    )
    await expect(richCards.getByRole('link', { name: 'Blocked link' })).toHaveCount(0)
    await expect(richCards.getByRole('region', { name: 'Recent log output' })).not.toHaveAttribute(
      'aria-live'
    )
    await richCards.getByRole('link', { name: 'Approved link' }).focus()
    await expect(richCards.getByRole('link', { name: 'Approved link' })).toBeFocused()
    await audit(page, 'all bounded rich-card payloads with hostile Markdown')
    for (const density of ['compact', 'comfortable']) {
      await saveDensity(page, density)
      await expect(page.locator('html')).toHaveAttribute('data-density', density)
      await expect(richCards.locator(':scope > *')).toHaveCount(9)
      if (density === 'compact') {
        const metadataLayout = await activeWorkspace
          .locator('.workspace-runtime-metadata')
          .evaluate((element) => ({
            clientHeight: element.clientHeight,
            overflowY: globalThis.getComputedStyle(element).overflowY,
            scrollHeight: element.scrollHeight
          }))
        expect(metadataLayout.overflowY).toBe('visible')
        expect(metadataLayout.scrollHeight).toBeLessThanOrEqual(metadataLayout.clientHeight + 1)
        const slotOverflow = await activeWorkspace
          .locator('.workspace-card-slots, .workspace-card-slots-v2')
          .evaluateAll((elements) =>
            elements.map((element) => globalThis.getComputedStyle(element).overflowY)
          )
        expect(slotOverflow).not.toContain('auto')
        expect(slotOverflow).not.toContain('scroll')
        await page.screenshot({
          path: join(evidenceDirectory, '02a-compact-workspace-card.png')
        })
      }
      await audit(page, `all rich-card payloads at ${density} density`)
    }
    await page.evaluate(() => {
      globalThis.document.documentElement.dataset.density = 'expanded'
    })
    await expect(page.locator('html')).toHaveAttribute('data-density', 'expanded')
    await expect(richCards.locator(':scope > *')).toHaveCount(9)
    await audit(page, 'all rich-card payloads at expanded presentation density')
    await execFileAsync(cliBinary, [
      '--session-file',
      sessionFile,
      'notify',
      '--title',
      'Accessibility attention check',
      '--body',
      'Action required',
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
    const selectedWorkspaceCard = workspaceList.locator(
      '.workspace-card:has(.workspace-row[aria-current="page"])'
    )
    const attentionExcerpt = selectedWorkspaceCard.locator('.workspace-attention-excerpt')
    await expect(attentionExcerpt).toHaveText('Accessibility attention check')
    await expect(attentionExcerpt).toBeVisible()
    await auditColorContrast(
      page,
      attentionExcerpt,
      'visible light-theme workspace warning attention'
    )
    await audit(page, 'visible light-theme workspace warning attention')
    await notificationTrigger.focus()
    await page.keyboard.press('Enter')
    const notifications = page.getByRole('dialog', { name: 'Notifications' })
    await expect(notifications.getByText('Accessibility attention check')).toBeVisible()
    await audit(page, 'notification attention and dialog')
    await page.screenshot({ path: join(evidenceDirectory, '03-notification-attention.png') })
    await page.keyboard.press('Escape')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const motion = await page.evaluate(() => {
      const probe = globalThis.document.createElement('span')
      probe.className = 'browser-loading'
      globalThis.document.body.append(probe)
      const style = globalThis.getComputedStyle(probe)
      const result = {
        animationName: style.animationName,
        transitionDuration: style.transitionDuration
      }
      probe.remove()
      return result
    })
    expect(motion.animationName).toBe('none')
    const transitionMilliseconds = motion.transitionDuration.endsWith('ms')
      ? Number.parseFloat(motion.transitionDuration)
      : Number.parseFloat(motion.transitionDuration) * 1000
    expect(transitionMilliseconds).toBeGreaterThanOrEqual(0)
    expect(transitionMilliseconds).toBeLessThanOrEqual(0.01)
    const richCardMotion = await richCards.evaluate((element) => {
      const style = globalThis.getComputedStyle(element.querySelector('*'))
      return { animationName: style.animationName, transitionDuration: style.transitionDuration }
    })
    expect(richCardMotion.animationName).toBe('none')
    expect(Number.parseFloat(richCardMotion.transitionDuration) || 0).toBe(0)
  } finally {
    await cleanupApplicationAndProfile(electronApplication, profileDirectory)
  }
})

test('screen-reader controls remain keyboard reachable in a narrow terminal pane', async () => {
  test.setTimeout(45_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m6-a11y-narrow-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated narrow accessibility shell.\n')
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
    const page = await electronApplication.firstWindow()
    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(570, 800)
    })
    await page.setViewportSize({ height: 800, width: 570 })

    await expect.poll(() => page.url()).toBe(rendererUrl)
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([570, 800])
    const terminalPane = page.locator('.terminal-pane')
    await expect(terminalPane).toHaveAttribute('data-process-id', /^\d+$/)
    await expect(terminalPane.getByText('Connected', { exact: true })).toBeVisible()
    await expect
      .poll(async () => (await terminalPane.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(500)

    const screenReaderMode = page.getByRole('checkbox', { name: 'Screen reader mode' })
    const terminalTools = page.getByRole('button', { name: 'Open terminal tools' })
    await terminalTools.focus()
    await page.keyboard.press('Enter')
    await expect(
      page.locator('button[aria-label="Close terminal tools"][aria-pressed]')
    ).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Next match' }).focus()
    for (let index = 0; index < 4; index += 1) await page.keyboard.press('Tab')
    await expect(screenReaderMode).toBeFocused()
    await expect(screenReaderMode).toBeVisible()
    await page.screenshot({ path: join(evidenceDirectory, '01-screen-reader-control.png') })
    await expect(screenReaderMode).not.toBeChecked()
    await screenReaderMode.check()
    await expect(screenReaderMode).toBeChecked()
    await screenReaderMode.uncheck()
    await expect(screenReaderMode).not.toBeChecked()
    await expect(terminalPane).toHaveAttribute('data-process-id', /^\d+$/)
    await expect(terminalPane.getByText('Connected', { exact: true })).toBeVisible()
  } finally {
    await cleanupApplicationAndProfile(electronApplication, profileDirectory)
  }
})

test('zoom reflow and forced colors preserve keyboard operation and visible focus', async () => {
  test.setTimeout(60_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m6-a11y-zoom-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated zoom accessibility shell.\n')
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
    const page = await electronApplication.firstWindow()
    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800)
    })
    await page.setViewportSize({ height: 800, width: 1200 })

    await expect.poll(() => page.url()).toBe(rendererUrl)
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    const workspaceId = await page.evaluate(async () => {
      const result = await globalThis.desktopBridge.listWorkspaces()
      return result.snapshot.selectedWorkspaceId
    })
    await seedRepresentativeRichCardSlots(page, workspaceId)
    const richCards = page.getByRole('region', { name: 'Workspace card details' })
    await expect(richCards.locator(':scope > *')).toHaveCount(9)

    for (const qualification of [
      { evidence: '04-zoom-200.png', factor: 2 },
      { evidence: '05-zoom-400.png', factor: 4 }
    ]) {
      await electronApplication.evaluate(({ BrowserWindow }, factor) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor)
      }, qualification.factor)
      await expect
        .poll(() =>
          electronApplication.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
          )
        )
        .toBeCloseTo(qualification.factor, 10)

      const expectedWidth = 1200 / qualification.factor
      const expectedHeight = 800 / qualification.factor
      await expect
        .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
        .toEqual([expectedWidth, expectedHeight])
      const reflow = await page.evaluate(() => ({
        bodyWidth: globalThis.document.body.scrollWidth,
        documentWidth: globalThis.document.documentElement.scrollWidth,
        viewportWidth: globalThis.innerWidth
      }))
      expect(reflow.bodyWidth).toBeLessThanOrEqual(reflow.viewportWidth + 1)
      expect(reflow.documentWidth).toBeLessThanOrEqual(reflow.viewportWidth + 1)
      await richCards.getByRole('link', { name: 'Approved link' }).scrollIntoViewIfNeeded()
      await richCards.getByRole('link', { name: 'Approved link' }).focus()
      await expect(richCards.getByRole('link', { name: 'Approved link' })).toBeFocused()
      await expect(richCards.getByRole('link', { name: 'Approved link' })).toBeInViewport()

      const settingsTrigger = page.getByRole('button', { name: 'Open settings' })
      await settingsTrigger.focus()
      await expect(settingsTrigger).toBeFocused()
      await page.keyboard.press('Enter')
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await expect(settings).toBeVisible()
      const theme = settings.getByLabel('Theme')
      await theme.scrollIntoViewIfNeeded()
      await theme.focus()
      await expect(theme).toBeFocused()
      await expect(theme).toBeInViewport()
      await settings.getByRole('button', { name: 'Keyboard shortcuts' }).click()
      const shortcutInput = settings.getByRole('textbox', { name: 'Open folder shortcut' })
      await expect(shortcutInput).toBeVisible()
      await expect
        .poll(async () => (await shortcutInput.boundingBox())?.width ?? 0)
        .toBeGreaterThan(100)
      await settings.getByRole('button', { name: 'Agent sessions' }).click()
      for (const inputName of ['Exact Codex thread UUID', 'Session title', 'Team title']) {
        const input = settings.getByRole('textbox', { name: inputName })
        await expect(input).toBeVisible()
        await expect.poll(async () => (await input.boundingBox())?.width ?? 0).toBeGreaterThan(100)
      }
      const close = settings.getByRole('button', { name: 'Close dialog' })
      await close.focus()
      await expect(close).toBeFocused()
      await expect(close).toBeInViewport()
      await page.screenshot({ path: join(evidenceDirectory, qualification.evidence) })
      await page.keyboard.press('Enter')
      await expect(settings).toHaveCount(0)
      await expect(settingsTrigger).toBeFocused()
    }

    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
    })
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([1200, 800])
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    await expect
      .poll(() => page.evaluate(() => globalThis.matchMedia('(forced-colors: active)').matches))
      .toBe(true)

    const settingsTrigger = page.getByRole('button', { name: 'Open settings' })
    await settingsTrigger.focus()
    await expect(settingsTrigger).toBeFocused()
    const focusIndicator = await settingsTrigger.evaluate((element) => {
      const style = globalThis.getComputedStyle(element)
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth)
      }
    })
    expect(focusIndicator.outlineStyle).not.toBe('none')
    expect(focusIndicator.outlineWidth).toBeGreaterThanOrEqual(2)
    const richCardLink = richCards.getByRole('link', { name: 'Approved link' })
    await richCardLink.focus()
    await expect(richCardLink).toBeFocused()
    const richCardFocus = await richCardLink.evaluate((element) => {
      const style = globalThis.getComputedStyle(element)
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth)
      }
    })
    expect(richCardFocus.outlineStyle).not.toBe('none')
    expect(richCardFocus.outlineWidth).toBeGreaterThanOrEqual(2)

    await settingsTrigger.focus()
    await page.keyboard.press('Enter')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    const theme = settings.getByLabel('Theme')
    await theme.focus()
    await expect(theme).toBeFocused()
    await audit(page, 'settings with Chromium forced colors active')
    await page.screenshot({ path: join(evidenceDirectory, '06-forced-colors.png') })
  } finally {
    await cleanupApplicationAndProfile(electronApplication, profileDirectory)
  }
})

async function cleanupApplicationAndProfile(application, profileDirectory) {
  const cleanupErrors = []
  try {
    await closeElectronApplication(application)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    cleanupErrors.push(error)
  }

  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Electron application and profile cleanup both failed.')
  }
}

async function saveTheme(page, settings, theme) {
  const themeSelect = settings.getByLabel('Theme')
  await expect(themeSelect).toBeVisible()
  await themeSelect.selectOption(theme)
  const appearanceSection = themeSelect.locator(
    'xpath=ancestor::*[contains(@class, "configuration-section")]'
  )
  await appearanceSection.getByRole('button', { name: 'Save section' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(settings.getByText('Setting saved.', { exact: true })).toBeVisible()
}

async function saveDensity(page, density) {
  await page.getByRole('button', { name: 'Open settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const densitySelect = settings.getByLabel('Density')
  await densitySelect.selectOption(density)
  const appearanceSection = densitySelect.locator(
    'xpath=ancestor::*[contains(@class, "configuration-section")]'
  )
  await appearanceSection.getByRole('button', { name: 'Save section' }).click()
  await expect(settings.getByText('Setting saved.', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
}
