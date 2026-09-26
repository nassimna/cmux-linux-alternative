import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'
import axe from 'axe-core'

import { closeElectronApplication } from './helpers/close-electron-application.mjs'
import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const dialogHarnessEntry = join(desktopDirectory, 'e2e/helpers/dialog-harness-main.cjs')
const evidenceDirectory =
  process.env.AGENT_WORKSPACE_EVIDENCE_DIR ??
  join(repositoryDirectory, 'dogfood-output/ssh-workspaces')

test.skip(process.platform !== 'linux', 'The isolated OpenSSH executable fixture is Linux-only.')

async function auditDialog(page) {
  await page.evaluate(axe.source)
  const violations = await page.evaluate(async () => {
    const dialog = globalThis.document.querySelector('[role="dialog"]')
    if (!dialog) throw new Error('The expected dialog is missing')
    const results = await globalThis.axe.run(dialog, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
    })
    return results.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary }))
    }))
  })
  expect(violations).toEqual([])
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
    cwd: repositoryDirectory,
    stdio: 'pipe'
  })
  await mkdir(evidenceDirectory, { recursive: true })
})

test('keeps output responsive and manages a saved SSH workspace', async () => {
  test.setTimeout(120_000)
  const cacheDirectory = join(homedir(), '.cache')
  await mkdir(cacheDirectory, { recursive: true })
  const profileDirectory = await mkdtemp(join(cacheDirectory, 'agent-workspace-ssh-e2e-'))
  const binDirectory = join(profileDirectory, 'bin')
  const sshExecutable = join(binDirectory, 'ssh')
  let harness
  let application
  const launch = async () => {
    const electronEnvironment = { ...process.env }
    delete electronEnvironment.ELECTRON_RUN_AS_NODE
    application = await electron.launch({
      args: [dialogHarnessEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...electronEnvironment,
        ...harness.electronEnvironment,
        AGENT_WORKSPACE_E2E_DIALOG_RESPONSES: '{}',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        PATH: `${binDirectory}:${process.env.PATH}`,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      }
    })
    const page = await application.firstWindow()
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800)
    })
    await page.setViewportSize({ width: 1200, height: 800 })
    await expect(page.locator('.terminal-pane')).toHaveCount(1)
    return page
  }

  try {
    await mkdir(binDirectory)
    await writeFile(sshExecutable, '#!/bin/sh\nprintf "SSH_ARGS:%s\\n" "$*"\nsleep 30\n')
    await chmod(sshExecutable, 0o700)
    harness = await createPackagedElectronHarness(profileDirectory)
    let page = await launch()
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('seq 1 20000; printf "OUTPUT_COMPLETE\\n"')
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText('OUTPUT_COMPLETE', { timeout: 60_000 })
    await page.getByRole('button', { name: 'Split pane right' }).click()
    await expect(page.locator('.terminal-pane')).toHaveCount(2)
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(900, 700)
    })
    await page.setViewportSize({ width: 900, height: 700 })
    await page.locator('.xterm-helper-textarea').last().focus()
    await page.keyboard.type('printf "AFTER_RESIZE\\n"')
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => {
        const visible = await page.locator('.xterm-rows').last().innerText()
        return visible.split('AFTER_RESIZE').length - 1
      })
      .toBeGreaterThanOrEqual(2)
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800)
    })
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.getByRole('button', { name: 'Create SSH workspace' }).click()
    await auditDialog(page)
    await page.getByRole('textbox', { name: 'Workspace name' }).fill('Demo SSH')
    await page.getByRole('textbox', { name: 'SSH host or alias' }).fill('demo-host')
    await page.getByRole('textbox', { name: 'Username (optional)' }).fill('deploy')
    await page.screenshot({ path: join(evidenceDirectory, 'ssh-workspace-create.png') })
    await page.getByRole('button', { name: 'Create and pin' }).click()
    await expect(page.locator('.workspace-section[data-section-kind="pinned"]')).toContainText(
      'Demo SSH'
    )
    await expect(page.locator('.xterm-rows').last()).toContainText('SSH_ARGS:deploy@demo-host')
    await expect(page.getByRole('button', { name: 'Unpin Demo SSH', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.getByRole('button', { name: 'Pin Workspace 1' }).click()
    await expect(page.getByRole('button', { name: 'Unpin Workspace 1' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.getByRole('button', { name: 'Unpin Workspace 1' }).click()
    await expect(page.getByRole('button', { name: 'Pin Workspace 1' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    await page.screenshot({ path: join(evidenceDirectory, 'ssh-workspace-desktop.png') })

    await closeElectronApplication(application)
    application = undefined
    page = await launch()
    await expect(page.locator('.workspace-section[data-section-kind="pinned"]')).toContainText(
      'Demo SSH'
    )
    await page.getByRole('button', { name: 'New SSH shell in Demo SSH' }).click()
    await expect(page.locator('.xterm-rows').last()).toContainText('SSH_ARGS:deploy@demo-host')
    await page.locator('.workspace-card').filter({ hasText: 'Demo SSH' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit SSH connection' }).click()
    await auditDialog(page)
    await page.screenshot({ path: join(evidenceDirectory, 'ssh-workspace-edit.png') })
    await page.getByRole('textbox', { name: 'SSH host or alias' }).fill('edited-host')
    await page.getByRole('button', { name: 'Save connection' }).click()
    await expect(page.getByRole('button', { name: 'New SSH shell in Demo SSH' })).toBeVisible()
    await page.getByRole('button', { name: 'New SSH shell in Demo SSH' }).click()
    await expect(page.locator('.xterm-rows').last()).toContainText('SSH_ARGS:deploy@edited-host')
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(900, 700)
    })
    await page.setViewportSize({ width: 900, height: 700 })
    await page.screenshot({ path: join(evidenceDirectory, 'ssh-workspace-narrow.png') })

    await page.evaluate(() => {
      globalThis.window.confirm = () => true
    })
    await page.getByRole('button', { name: 'Close Demo SSH' }).click()
    await expect(page.getByRole('button', { name: 'Create SSH workspace' })).toBeVisible()
    await page.getByRole('button', { name: 'Create SSH workspace' }).click()
    await auditDialog(page)
    await expect(
      page.getByRole('region', { name: 'Previously saved SSH connections' })
    ).toContainText('deploy@edited-host:22')
    await page.screenshot({ path: join(evidenceDirectory, 'ssh-workspace-saved.png') })
    await page.getByRole('button', { name: 'Use details' }).click()
    await expect(page.getByRole('textbox', { name: 'SSH host or alias' })).toHaveValue(
      'edited-host'
    )
    await page.getByRole('button', { name: 'Remove saved SSH details for edited-host' }).click()
    await expect(
      page.getByRole('region', { name: 'Previously saved SSH connections' })
    ).toHaveCount(0)
    await page.getByRole('button', { name: 'Create and pin' }).click()
    await expect(page.locator('.workspace-section[data-section-kind="pinned"]')).toContainText(
      'edited-host'
    )
  } finally {
    await closeElectronApplication(application).catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})
