import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const dialogHarnessEntry = join(desktopDirectory, 'e2e/helpers/dialog-harness-main.cjs')
const rendererUrl = 'agent-workspace://renderer/index.html'
const rendererOrigin = 'agent-workspace://renderer/'
const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const evidenceDirectory = join(tmpdir(), 'agent-workspace-m2-validation')
const benignExternalConsoleError = /(?:font(?:config)?|gpu|mesa|dri3|webgl)/i

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Electron E2E needs an X11 or Wayland display.')
  }
  await mkdir(evidenceDirectory, { recursive: true })
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'inherit'
  })
})

test('real service drives the Milestone 2 workspace UI', async () => {
  test.setTimeout(90_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m2-e2e-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated Electron E2E shell.\n')
  const configuredShellPath = join(profileDirectory, 'configured-shell')
  if (process.platform !== 'win32') {
    await writeFile(
      configuredShellPath,
      "#!/bin/sh\nprintf 'CONFIGURED_SHELL_ACTIVE\\n'\nexec /bin/sh\n"
    )
    await chmod(configuredShellPath, 0o700)
  }
  const consoleErrors = []
  const pageErrors = []
  const layoutExportPath = join(profileDirectory, 'saved-pair.workspace-layout.json')
  let electronApplication

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    electronApplication = await electron.launch({
      args: [dialogHarnessEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        AGENT_WORKSPACE_E2E_DIALOG_RESPONSES: JSON.stringify({
          savePaths: [layoutExportPath],
          openPaths: [layoutExportPath],
          tracePath: join(evidenceDirectory, 'dialog-harness.jsonl')
        }),
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
    page.on('pageerror', (error) =>
      pageErrors.push({
        name: error.name,
        message: error.message,
        stack: error.stack,
        value: String(error)
      })
    )

    await expect.poll(() => page.url()).toBe(rendererUrl)
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    await expect(page.locator('.workspace-row')).toContainText('Workspace 1')
    await page.screenshot({ path: join(evidenceDirectory, '01-initial-workspace.png') })

    if (process.platform !== 'win32') {
      const originalTerminalId = await page
        .locator('.terminal-pane')
        .getAttribute('data-terminal-id')
      const originalProcessId = await page.locator('.terminal-pane').getAttribute('data-process-id')
      if (!originalTerminalId || !originalProcessId) {
        throw new Error('Expected the initial terminal identity before changing shell settings')
      }
      await page.getByRole('button', { name: 'Open settings' }).click()
      await page.getByRole('button', { name: 'Terminal' }).click()
      const shellPath = page.getByRole('textbox', { name: 'Shell path' })
      const terminalSettings = shellPath.locator('xpath=ancestor::section')
      await shellPath.fill(configuredShellPath)
      await terminalSettings.getByRole('button', { name: 'Save section' }).click()
      await expect(page.locator('.configuration-status')).toHaveText('Setting saved.')
      await page.screenshot({ path: join(evidenceDirectory, '01a-configured-shell-setting.png') })
      await page.keyboard.press('Escape')

      await expect(page.locator('.terminal-pane')).toHaveAttribute(
        'data-terminal-id',
        originalTerminalId
      )
      await expect(page.locator('.terminal-pane')).toHaveAttribute(
        'data-process-id',
        originalProcessId
      )
      await page.getByRole('button', { name: 'Add tab' }).click()
      await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click()
      await expect(page.locator('.xterm-rows').last()).toContainText('CONFIGURED_SHELL_ACTIVE')
      await page.screenshot({ path: join(evidenceDirectory, '01b-configured-shell-terminal.png') })

      await page.getByRole('button', { name: 'Open settings' }).click()
      await page.getByRole('button', { name: 'Terminal' }).click()
      await shellPath.fill('')
      await terminalSettings.getByRole('button', { name: 'Save section' }).click()
      await expect(page.locator('.configuration-status')).toHaveText('Setting saved.')
      await page.getByRole('button', { name: 'Advanced' }).click()
      const logLevel = page.getByRole('combobox', { name: 'Log level' })
      const loggingSettings = logLevel.locator('xpath=ancestor::section')
      await logLevel.selectOption('debug')
      await loggingSettings.getByRole('button', { name: 'Save section' }).click()
      await expect(page.locator('.configuration-status')).toHaveText('Setting saved.')
      await loggingSettings.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(evidenceDirectory, '01c-live-logging-setting.png') })
      await page.keyboard.press('Escape')
      await page.locator('.tab-close').last().click()
      await expect(page.locator('.terminal-pane')).toHaveAttribute(
        'data-terminal-id',
        originalTerminalId
      )
    }

    const listenerTerminalId = await page.locator('.terminal-pane').getAttribute('data-terminal-id')
    if (!listenerTerminalId) throw new Error('Expected a selected terminal for listener discovery')
    const listenerCommand =
      `node -e "const net=require('node:net');const server=net.createServer();` +
      `server.listen(0,'127.0.0.1',()=>console.log('AGENT_WORKSPACE_LISTENER_READY'))"\n`
    const selectedRuntimeMetadata = page.locator(
      '.workspace-card[data-selected="true"] .workspace-runtime-metadata'
    )
    let listenerInputSent = false
    try {
      await page.evaluate(
        ({ terminalId, command }) =>
          globalThis.desktopBridge.sendTerminalInput(terminalId, command),
        { terminalId: listenerTerminalId, command: listenerCommand }
      )
      listenerInputSent = true
      await expect(selectedRuntimeMetadata).toContainText(/Ports: [1-9]\d*/u, {
        timeout: 20_000
      })
      await page.screenshot({
        path: join(evidenceDirectory, '01d-listening-port-metadata.png')
      })
    } finally {
      if (listenerInputSent) {
        await page
          .evaluate(
            (terminalId) => globalThis.desktopBridge.sendTerminalInput(terminalId, '\u0003'),
            listenerTerminalId
          )
          .catch(() => undefined)
      }
    }
    await expect(selectedRuntimeMetadata).toContainText('Ports: —', { timeout: 20_000 })

    await page.getByRole('button', { name: 'Open folder as workspace' }).click()
    const createDialog = page.getByRole('dialog')
    await createDialog.getByLabel('Workspace folder path').fill(profileDirectory)
    await createDialog.getByRole('button', { name: 'Open workspace' }).click()
    await expect(page.locator('.workspace-title')).toHaveText(basename(profileDirectory))
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-terminal-id', /.+/)

    const selectedWorkspace = page.locator('.workspace-row[aria-current="page"]')
    await page.evaluate(() => {
      globalThis.prompt = () => 'Renamed workspace'
    })
    await selectedWorkspace.dblclick()
    await expect(page.locator('.workspace-title')).toHaveText('Renamed workspace')

    await page.getByRole('button', { name: 'Split pane right' }).click()
    await expect(page.locator('.pane-view')).toHaveCount(2)
    const separator = page.getByRole('separator').first()
    await separator.focus()
    await page.keyboard.press('ArrowRight')
    await page.getByRole('button', { name: 'Add tab' }).last().click()
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click()
    await expect(page.locator('.pane-tab')).toHaveCount(3)
    await page.screenshot({ path: join(evidenceDirectory, '02-split-tabs.png') })

    const terminalInput = page.locator('.xterm-helper-textarea').last()
    await terminalInput.focus()
    await terminalInput.pressSequentially("printf 'M2_UI_OK\\n'")
    await terminalInput.press('Enter')
    await expect(page.locator('.xterm-rows').last()).toContainText('M2_UI_OK')

    const secondPaneTabs = page.locator('.pane-view').last().locator('.pane-tab')
    const tabOrderBeforeDrag = await secondPaneTabs.allTextContents()
    expect(tabOrderBeforeDrag).toHaveLength(2)
    await secondPaneTabs.first().dragTo(secondPaneTabs.last(), {
      sourcePosition: { x: 5, y: 13 },
      targetPosition: { x: 5, y: 13 }
    })
    await expect
      .poll(() => secondPaneTabs.allTextContents())
      .toEqual([...tabOrderBeforeDrag].reverse())

    const firstPane = page.locator('.pane-view').first()
    const secondPane = page.locator('.pane-view').last()
    const keyboardDestination = secondPane.locator('.tab-drop-actions').first()
    await expect(keyboardDestination).toHaveCSS('opacity', '0')
    await expect(keyboardDestination.locator('xpath=..').locator('svg')).toBeVisible()
    await keyboardDestination.selectOption({ index: 1 })
    await expect(firstPane.locator('.pane-tab')).toHaveCount(2)
    await expect(secondPane.locator('.pane-tab')).toHaveCount(1)

    const directionalDestination = firstPane.locator('.tab-drop-actions').last()
    const secondPaneMoveValue = await directionalDestination
      .locator('option')
      .nth(2)
      .getAttribute('value')
    if (!secondPaneMoveValue?.startsWith('move:')) {
      throw new Error(`Expected second pane move option, received ${String(secondPaneMoveValue)}`)
    }
    const secondPaneId = secondPaneMoveValue.slice('move:'.length)
    await directionalDestination.selectOption(`split:${secondPaneId}:left`)
    await expect(page.locator('.pane-view')).toHaveCount(3)
    await expect(page.locator('.pane-tab')).toHaveCount(3)
    await page.screenshot({
      path: join(evidenceDirectory, '03-tab-drag-and-directional-split.png')
    })

    const reorderWorkspaceOne = page.getByRole('button', { name: 'Reorder Workspace 1' })
    await reorderWorkspaceOne.focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect(page.locator('.workspace-row').last()).toContainText('Workspace 1')

    const workspaceCards = page.locator('.workspace-card')
    const orderBeforeWholeCardDrag = await workspaceCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute('data-workspace-id'))
    )
    expect(orderBeforeWholeCardDrag).toHaveLength(2)
    const wholeCardDragSource = await workspaceCards
      .first()
      .locator('.workspace-directory')
      .boundingBox()
    const wholeCardDragTarget = await workspaceCards.last().boundingBox()
    if (!wholeCardDragSource || !wholeCardDragTarget) {
      throw new Error('Expected visible workspace cards for whole-card pointer dragging')
    }
    const sourceX = wholeCardDragSource.x + 12
    const sourceY = wholeCardDragSource.y + wholeCardDragSource.height / 2
    await page.mouse.move(sourceX, sourceY)
    await page.mouse.down()
    await page.mouse.move(sourceX, sourceY + 10, { steps: 4 })
    await page.mouse.move(
      wholeCardDragTarget.x + 12,
      wholeCardDragTarget.y + wholeCardDragTarget.height / 2,
      { steps: 12 }
    )
    await page.mouse.up()
    await expect
      .poll(() =>
        workspaceCards.evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-workspace-id'))
        )
      )
      .toEqual([...orderBeforeWholeCardDrag].reverse())
    await page.screenshot({ path: join(evidenceDirectory, '03a-whole-card-workspace-drag.png') })

    const m2Capabilities = await page.evaluate(
      async () => (await globalThis.desktopBridge.identify()).capabilities
    )
    expect(m2Capabilities).toEqual(
      expect.arrayContaining(['workspace-groups-v1', 'saved-layouts-v1'])
    )
    const canonicalWorkspaceIds = await page.evaluate(async () =>
      (await globalThis.desktopBridge.listWorkspaces()).snapshot.workspaces.map(({ id }) => id)
    )
    const workspaceRows = page.locator('.workspace-row')
    const organizationBeforePointer = await page.evaluate(
      async () => (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
    )
    const pointerTargetId = canonicalWorkspaceIds.find(
      (workspaceId) => !organizationBeforePointer.selection.includes(workspaceId)
    )
    if (!pointerTargetId)
      throw new Error('Expected one unselected workspace for additive pointer selection')
    await page
      .locator(`[data-workspace-id="${pointerTargetId}"] .workspace-row`)
      .dispatchEvent('click', {
        ctrlKey: primaryModifier === 'Control',
        metaKey: primaryModifier === 'Meta'
      })
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
        )
      )
      .toMatchObject({ selection: canonicalWorkspaceIds, focusedWorkspaceId: pointerTargetId })
    await expect(page.locator('.workspace-row[aria-current="page"]')).toHaveCount(1)
    await expect(page.locator('.workspace-row[aria-pressed="true"]')).toHaveCount(2)

    await workspaceRows.nth(0).click()
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
        )
      )
      .toMatchObject({
        selection: [canonicalWorkspaceIds[0]],
        focusedWorkspaceId: canonicalWorkspaceIds[0]
      })
    await workspaceRows.nth(0).focus()
    await workspaceRows.nth(0).press('Shift+ArrowDown')
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
        )
      )
      .toMatchObject({
        selection: canonicalWorkspaceIds,
        focusedWorkspaceId: canonicalWorkspaceIds[1]
      })
    await expect(page.locator('.workspace-row[aria-current="page"]')).toHaveCount(1)
    await expect(page.locator('.workspace-row[aria-pressed="true"]')).toHaveCount(2)
    await replaceWorkspaceSelection(page, canonicalWorkspaceIds, canonicalWorkspaceIds[0])

    await page.locator('[data-workspace-action="workspace.group.create"]').click()
    const groupDialog = page.getByRole('dialog')
    await groupDialog.getByLabel('Group name').fill('Active group')
    await groupDialog.getByRole('button', { name: 'Create group' }).click()
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await globalThis.desktopBridge.getWorkspaceOrganization()).organization.groups.map(
            ({ name }) => name
          )
        )
      )
      .toContain('Active group')
    await expect(page.getByText('Active group', { exact: true })).toBeVisible()
    const firstWorkspace = page.locator(`[data-workspace-id="${canonicalWorkspaceIds[0]}"]`)
    await firstWorkspace.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to group' }).hover()
    await page.getByRole('menuitem', { name: 'Active group', exact: true }).click()
    await firstWorkspace.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    await expect(page.getByText('Pinned', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Collapse Active group' }).click()
    await expect(firstWorkspace).toHaveCount(1)
    await page.screenshot({ path: join(evidenceDirectory, '03a-m2-organization.png') })

    await page.evaluate(() => {
      globalThis.prompt = () => 'Saved pair'
      globalThis.__workspaceConfirmations = []
      globalThis.confirm = (message) => {
        globalThis.__workspaceConfirmations.push(String(message))
        return true
      }
    })
    await page.getByRole('button', { name: 'Saved layouts' }).click()
    await page.locator('[data-workspace-action="workspace.layout.save"]').click()
    await expect(page.getByText('Saved pair', { exact: true })).toBeVisible()
    const identitiesBeforeApply = await layoutTerminalIdentities(page)
    expect(identitiesBeforeApply.authoritativeRuntimeIds.length).toBeGreaterThan(0)
    expect(new Set(identitiesBeforeApply.authoritativeRuntimeIds).size).toBe(
      identitiesBeforeApply.authoritativeRuntimeIds.length
    )
    expect(identitiesBeforeApply.processes.length).toBeGreaterThan(0)
    for (const { terminalId } of identitiesBeforeApply.processes) {
      expect(identitiesBeforeApply.authoritativeRuntimeIds).toContain(terminalId)
    }
    await page
      .locator('.saved-layouts-panel li', { hasText: 'Saved pair' })
      .getByRole('button', { name: 'Apply' })
      .click()
    await expect
      .poll(() => page.evaluate(() => globalThis.__workspaceConfirmations.at(-1)))
      .toBe('Apply “Saved pair” and replace the current workspace set?')
    const identitiesAfterApply = await layoutTerminalIdentities(page)
    expect(identitiesAfterApply).toEqual(identitiesBeforeApply)
    expect(new Set(identitiesAfterApply.authoritativeRuntimeIds).size).toBe(
      identitiesAfterApply.authoritativeRuntimeIds.length
    )
    expect(new Set(identitiesAfterApply.processes.map(({ terminalId }) => terminalId)).size).toBe(
      identitiesAfterApply.processes.length
    )
    expect(new Set(identitiesAfterApply.processes.map(({ processId }) => processId)).size).toBe(
      identitiesAfterApply.processes.length
    )
    const invalidLayoutResult = await page.evaluate(async () => {
      const before = await globalThis.desktopBridge.listSavedLayouts()
      let rejected = false
      try {
        await globalThis.desktopBridge.saveLayout({
          layoutId: globalThis.crypto.randomUUID(),
          name: 'Invalid empty layout',
          workspaceIds: [],
          expectedRevision: before.revision,
          idempotencyKey: globalThis.crypto.randomUUID()
        })
      } catch {
        rejected = true
      }
      const after = await globalThis.desktopBridge.listSavedLayouts()
      return { rejected, before, after }
    })
    expect(invalidLayoutResult.rejected).toBe(true)
    expect(invalidLayoutResult.after).toEqual(invalidLayoutResult.before)

    const processIdBeforeInvalidApply = await page
      .locator('.terminal-pane')
      .first()
      .getAttribute('data-process-id')
    const invalidApplyResult = await page.evaluate(async () => {
      const before = await globalThis.desktopBridge.listWorkspaces()
      const layouts = await globalThis.desktopBridge.listSavedLayouts()
      let rejected = false
      try {
        await globalThis.desktopBridge.applyLayout({
          layoutId: globalThis.crypto.randomUUID(),
          expectedRevision: layouts.revision,
          idempotencyKey: globalThis.crypto.randomUUID()
        })
      } catch {
        rejected = true
      }
      const after = await globalThis.desktopBridge.listWorkspaces()
      return { rejected, before, after }
    })
    expect(invalidApplyResult.rejected).toBe(true)
    expect(invalidApplyResult.after).toEqual(invalidApplyResult.before)
    await expect(page.locator('.terminal-pane').first()).toHaveAttribute(
      'data-process-id',
      processIdBeforeInvalidApply
    )

    const layoutsBeforeFileRoundTrip = await page.evaluate(() =>
      globalThis.desktopBridge.listSavedLayouts()
    )
    const savedPairLayout = layoutsBeforeFileRoundTrip.layouts.find(
      (layout) => layout.name === 'Saved pair'
    )
    expect(savedPairLayout).toBeDefined()
    const exportResult = await page.evaluate(async (layoutId) => {
      try {
        return {
          value: await globalThis.desktopBridge.exportSavedLayoutToFile({ layoutId })
        }
      } catch (error) {
        return {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }
      }
    }, savedPairLayout.id)
    expect(exportResult).toEqual({ value: true })
    await expect
      .poll(async () => {
        try {
          JSON.parse(await readFile(layoutExportPath, 'utf8'))
          return true
        } catch {
          return false
        }
      })
      .toBe(true)
    const exportedEnvelope = JSON.parse(await readFile(layoutExportPath, 'utf8'))
    expect(exportedEnvelope).toMatchObject({ formatVersion: 1, name: 'Saved pair' })
    expect(exportedEnvelope).not.toHaveProperty('path')
    const importResult = await page.evaluate(async () => {
      const layouts = await globalThis.desktopBridge.listSavedLayouts()
      try {
        return {
          value: await globalThis.desktopBridge.importSavedLayoutFromFile({
            layoutId: globalThis.crypto.randomUUID(),
            expectedRevision: layouts.revision,
            idempotencyKey: globalThis.crypto.randomUUID()
          })
        }
      } catch (error) {
        return {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }
      }
    })
    expect(importResult).not.toHaveProperty('error')
    expect(importResult.value).not.toBeNull()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => globalThis.desktopBridge.listSavedLayouts())).layouts.length
      )
      .toBe(layoutsBeforeFileRoundTrip.layouts.length + 1)

    await page.evaluate(async () => globalThis.desktopBridge.restartService())
    await expect(page.locator('.terminal-pane').first()).toHaveAttribute(
      'data-process-id',
      /^\d+$/,
      {
        timeout: 20_000
      }
    )
    await expect(page.getByText('Active group', { exact: true })).toBeVisible()
    await expect(page.getByText('Pinned', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Saved layouts' }).click()
    await expect(page.getByText('Saved pair', { exact: true })).toHaveCount(2)
    await expect(firstWorkspace).toHaveCount(1)
    await page.screenshot({ path: join(evidenceDirectory, '03b-m2-restart-persistence.png') })

    await page.keyboard.press(`${primaryModifier}+Shift+P`)
    const publicActionPalette = page.getByRole('dialog')
    await publicActionPalette.getByLabel('Search commands').fill('desktop window focus')
    await expect(
      publicActionPalette.getByRole('option', { name: /Desktop Window Focus/u })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(publicActionPalette).toHaveCount(0)
    await expect
      .poll(
        () =>
          electronApplication.evaluate(({ BrowserWindow }) =>
            Boolean(BrowserWindow.getFocusedWindow()?.isFocused())
          ),
        // Window-manager focus grants lag under load; the assertion is about
        // eventual focus, not latency.
        { timeout: 20_000 }
      )
      .toBe(true)

    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog')
    await palette.getByLabel('Search commands').fill('toggle sidebar')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('complementary', { name: 'Workspaces' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Open command palette' }).click()
    await page.getByRole('dialog').getByLabel('Search commands').fill('toggle sidebar')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('complementary', { name: 'Workspaces' })).toBeVisible()

    await page.getByRole('button', { name: 'Open settings' }).click()
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
    await expect(page.locator('.shortcut-row')).toHaveCount(12)
    let firstShortcut = page.locator('.shortcut-row').first()
    await firstShortcut.locator('input').fill('Primary+Shift+N')
    await firstShortcut.getByRole('button', { name: 'Save' }).click()
    const openFolderShortcut = page.getByRole('textbox', { name: 'Open folder shortcut' })
    await expect(openFolderShortcut).toHaveValue('Primary+Shift+N')
    await page.getByRole('button', { name: 'Clear' }).first().click()
    await expect(openFolderShortcut).toHaveValue('')
    firstShortcut = page.locator('.shortcut-row').first()
    await firstShortcut.getByRole('button', { name: 'Reset workspace.new' }).click()
    await expect(openFolderShortcut).toHaveValue('Primary+O')
    await page.screenshot({ path: join(evidenceDirectory, '04-shortcut-settings.png') })
    await page.keyboard.press('Escape')

    await electronApplication.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 650)
    })
    await page.setViewportSize({ width: 900, height: 650 })
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([900, 650])
    await expect(page.locator('.workspace-content')).toBeVisible()
    await page.locator('.workspace-content').click({ position: { x: 300, y: 200 } })
    await page.screenshot({ path: join(evidenceDirectory, '05-narrow-workspace.png') })

    await page.setViewportSize({ width: 1200, height: 800 })

    await exerciseWorkspaceCloseVariants(page, profileDirectory)
    await page.screenshot({ path: join(evidenceDirectory, '06-batch-close-replacement.png') })

    expect(consoleErrors, 'renderer/external console errors').toEqual([])
    expect(pageErrors, 'uncaught renderer page errors').toEqual([])
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function exerciseWorkspaceCloseVariants(page, workingDirectory) {
  const singleton = await createWorkspace(page, 'Singleton close', workingDirectory, 33, 101)
  const singletonTerminalId = terminalRuntimeId(singleton)
  await closeWorkspaceCard(page, singleton.id, 'Close workspace “Singleton close”?')
  await expect
    .poll(async () =>
      (await workspaceSnapshot(page)).workspaces.some(({ id }) => id === singleton.id)
    )
    .toBe(false)
  await expectTerminalSessionClosed(page, singletonTerminalId)

  const survivor = await createWorkspace(page, 'Batch survivor', workingDirectory, 34, 102)
  const survivorTerminalId = terminalRuntimeId(survivor)
  const beforeSubsetClose = await workspaceSnapshot(page)
  const selectedForSubset = beforeSubsetClose.workspaces
    .filter(({ id }) => id !== survivor.id)
    .slice(0, 2)
  expect(selectedForSubset).toHaveLength(2)
  await replaceWorkspaceSelection(
    page,
    selectedForSubset.map(({ id }) => id),
    selectedForSubset[1].id
  )
  const subsetTerminalIds = selectedForSubset.map(terminalRuntimeId)
  await closeWorkspaceCard(
    page,
    selectedForSubset[1].id,
    `Close 2 selected workspaces (${selectedForSubset.map(({ name }) => name).join(', ')})?`
  )
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces.length).toBe(1)
  const afterSubsetClose = await workspaceSnapshot(page)
  expect(afterSubsetClose.workspaces[0]?.id).toBe(survivor.id)
  expect(terminalRuntimeId(afterSubsetClose.workspaces[0])).toBe(survivorTerminalId)
  for (const terminalId of subsetTerminalIds) await expectTerminalSessionClosed(page, terminalId)

  const allSource = await createWorkspace(page, 'All-workspaces source', workingDirectory, 47, 139)
  const beforeAllClose = await workspaceSnapshot(page)
  const allIds = beforeAllClose.workspaces.map(({ id }) => id)
  const oldTerminalIds = beforeAllClose.workspaces.map(terminalRuntimeId)
  await replaceWorkspaceSelection(page, allIds, allSource.id)
  await closeWorkspaceCard(
    page,
    allSource.id,
    `Close ${String(allIds.length)} selected workspaces (${beforeAllClose.workspaces
      .map(({ name }) => name)
      .join(', ')})?`
  )
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces.length).toBe(1)
  const replacement = (await workspaceSnapshot(page)).workspaces[0]
  expect(replacement.name).toBe('Workspace 1')
  expect(replacement.workingDirectory).toBe(workingDirectory)
  const replacementTerminal = replacement.tabs.find(({ content }) => content.kind === 'terminal')
  expect(replacementTerminal?.content).toMatchObject({
    kind: 'terminal',
    launch: { cwd: workingDirectory, rows: 47, cols: 139 }
  })
  expect(replacementTerminal?.content).not.toHaveProperty('launch.command')
  expect(oldTerminalIds).not.toContain(terminalRuntimeId(replacement))
  const organization = await page.evaluate(
    async () => (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
  )
  expect(organization.selection).toEqual([replacement.id])
  expect(organization.focusedWorkspaceId).toBe(replacement.id)
  for (const terminalId of oldTerminalIds) await expectTerminalSessionClosed(page, terminalId)
}

async function layoutTerminalIdentities(page) {
  let identities
  await expect
    .poll(
      async () => {
        identities = await page.evaluate(async () => {
          const snapshot = (await globalThis.desktopBridge.listWorkspaces()).snapshot
          const authoritativeRuntimeIds = snapshot.workspaces
            .flatMap(({ tabs }) =>
              tabs.flatMap(({ content }) =>
                content.kind === 'terminal' && content.runtimeSessionId
                  ? [content.runtimeSessionId]
                  : []
              )
            )
            .sort()
          const processes = [...globalThis.document.querySelectorAll('.terminal-pane')]
            .map((element) => ({
              terminalId: element.getAttribute('data-terminal-id'),
              processId: element.getAttribute('data-process-id')
            }))
            .sort((left, right) => String(left.terminalId).localeCompare(String(right.terminalId)))
          return { authoritativeRuntimeIds, processes }
        })
        return identities.processes.find(({ terminalId, processId }) => !terminalId || !processId)
      },
      { timeout: 10_000 }
    )
    .toBeUndefined()
  return identities
}

async function createWorkspace(page, name, workingDirectory, rows, cols) {
  const result = await page.evaluate(
    async ({ name, workingDirectory, rows, cols }) =>
      globalThis.desktopBridge.createWorkspace({
        name,
        workingDirectory,
        initialTerminal: { cwd: workingDirectory, rows, cols }
      }),
    { name, workingDirectory, rows, cols }
  )
  const workspace = result.snapshot.workspaces.find((candidate) => candidate.name === name)
  if (!workspace) throw new Error(`Created workspace ${name} is missing from the snapshot`)
  await expect(page.locator(`[data-workspace-id="${workspace.id}"]`)).toHaveCount(1)
  return workspace
}

async function replaceWorkspaceSelection(page, selection, focusedWorkspaceId) {
  await page.evaluate(
    async ({ selection, focusedWorkspaceId }) => {
      const organization = await globalThis.desktopBridge.getWorkspaceOrganization()
      await globalThis.desktopBridge.selectWorkspaces({
        selection,
        focusedWorkspaceId,
        expectedRevision: organization.organization.revision,
        idempotencyKey: globalThis.crypto.randomUUID()
      })
    },
    { selection, focusedWorkspaceId }
  )
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
      )
    )
    .toMatchObject({ selection, focusedWorkspaceId })
  await expect(
    page.locator(`[data-workspace-id="${focusedWorkspaceId}"] .workspace-row`)
  ).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.workspace-row[aria-pressed="true"]')).toHaveCount(selection.length)
}

async function closeWorkspaceCard(page, workspaceId, expectedConfirmation) {
  const workspaceCard = page.locator(`[data-workspace-id="${workspaceId}"]`)
  if ((await workspaceCard.count()) === 0) {
    const collapsedGroups = page.getByRole('button', { name: /^Expand / })
    while ((await collapsedGroups.count()) > 0) await collapsedGroups.first().click()
  }
  await expect(workspaceCard).toBeVisible()
  const workspaceItem = page.locator('.workspace-row-wrap', { has: workspaceCard })
  await workspaceItem.locator('.workspace-remove').click()
  await expect
    .poll(() => page.evaluate(() => globalThis.__workspaceConfirmations.at(-1)))
    .toBe(expectedConfirmation)
}

async function workspaceSnapshot(page) {
  return page.evaluate(async () => (await globalThis.desktopBridge.listWorkspaces()).snapshot)
}

function terminalRuntimeId(workspace) {
  const terminal = workspace.tabs.find(({ content }) => content.kind === 'terminal')
  if (terminal?.content.kind !== 'terminal' || !terminal.content.runtimeSessionId) {
    throw new Error(`Workspace ${workspace.id} is missing a live terminal`)
  }
  return terminal.content.runtimeSessionId
}

async function expectTerminalSessionClosed(page, terminalId) {
  await expect
    .poll(
      () =>
        page.evaluate(async (candidate) => {
          try {
            await globalThis.desktopBridge.attachTerminal(candidate)
            return false
          } catch {
            return true
          }
        }, terminalId),
      { timeout: 10_000 }
    )
    .toBe(true)
}
