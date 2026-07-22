import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'
import { closeElectronApplication } from './helpers/close-electron-application.mjs'

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

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('Electron E2E needs an X11 or Wayland display.')
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

test('packaged UI reports exact legacy counts and clears reduction mode after recovery', async () => {
  test.setTimeout(120_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-legacy-reduction-'))
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated legacy reduction shell.\n')
  let application

  try {
    const harness = await createPackagedElectronHarness(profileDirectory, serviceBinary)
    application = await launch(profileDirectory, harness)
    let page = await application.firstWindow()
    await expect.poll(() => page.url()).toBe(rendererUrl)
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    await page.evaluate(async () => {
      const current = await globalThis.desktopBridge.listWorkspaces()
      const workspace = current.snapshot.workspaces.find(
        ({ id }) => id === current.snapshot.selectedWorkspaceId
      )
      if (!workspace) throw new Error('Selected seed workspace is missing')
      await globalThis.desktopBridge.openBrowserTab({
        workspaceId: workspace.id,
        paneId: workspace.selectedPaneId,
        metadata: { url: 'https://example.test' }
      })
    })
    await expect(page.locator('.browser-pane')).toBeVisible()
    await closeElectronApplication(application)
    application = undefined

    const databasePath = join(profileDirectory, 'state', 'workspace.sqlite')
    await seedLegacyWorkspaceOverflow(databasePath, profileDirectory)

    application = await launch(profileDirectory, harness)
    page = await application.firstWindow()
    await expect.poll(() => page.url()).toBe(rendererUrl)
    await expect
      .poll(
        async () =>
          (await page.getByRole('heading', { name: 'Workspace recovery required' }).isVisible()) ||
          (await page.getByRole('alert', { name: 'Legacy data reduction required' }).isVisible()),
        { timeout: 30_000 }
      )
      .toBe(true)
    if (await page.getByRole('heading', { name: 'Workspace recovery required' }).isVisible()) {
      const lifecycle = await page.evaluate(() => globalThis.desktopBridge.getLifecycleState?.())
      const diagnostics = await readFile(
        join(profileDirectory, 'logs', 'diagnostics.jsonl'),
        'utf8'
      ).catch(() => 'service diagnostics unavailable')
      throw new Error(
        `Legacy fixture failed service startup: ${JSON.stringify(lifecycle)}\n${diagnostics}`
      )
    }
    const notice = page.getByRole('alert', { name: 'Legacy data reduction required' })
    await expect(notice).toContainText('Legacy data reduction required', { timeout: 30_000 })
    await expect(notice).toContainText(
      'Current counts and limits: workspaces 129/128; maximum panes in one workspace 1/64; maximum tabs in one workspace 1/128; total panes 129/1024; total tabs 129/2048.'
    )
    await expect(notice).toContainText('Export important layouts first')
    await expect(page.getByRole('button', { name: 'Open folder as workspace' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Import' })).toBeDisabled()

    const before = await page.evaluate(async () => ({
      snapshot: (await globalThis.desktopBridge.listWorkspaces()).snapshot,
      organization: (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
    }))
    expect(before.snapshot.workspaces).toHaveLength(129)
    expect(before.organization.legacyOverLimit).toEqual({
      workspaceCount: 129,
      maximumPanesInWorkspace: 1,
      maximumTabsInWorkspace: 1,
      totalPaneCount: 129,
      totalTabCount: 129,
      exceededDimensions: ['workspaces']
    })
    const closing = before.snapshot.workspaces.find(
      ({ id }) => id === before.organization.focusedWorkspaceId
    )
    if (!closing) throw new Error('Focused legacy workspace is missing')
    page.once('dialog', (dialog) => dialog.accept())
    const closingCard = page.locator(`[data-workspace-id="${closing.id}"]`)
    await page
      .locator('.workspace-row-wrap', { has: closingCard })
      .locator('.workspace-remove')
      .click()

    await expect(notice).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Open folder as workspace' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Import' })).toBeEnabled()
    const recovered = await page.evaluate(async () => ({
      snapshot: (await globalThis.desktopBridge.listWorkspaces()).snapshot,
      organization: (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
    }))
    expect(recovered.snapshot.workspaces).toHaveLength(128)
    expect(recovered.organization).not.toHaveProperty('legacyOverLimit')

    await page.evaluate(() => globalThis.desktopBridge.restartService())
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => globalThis.desktopBridge.listWorkspaces())).snapshot.workspaces
            .length,
        { timeout: 30_000 }
      )
      .toBe(128)
    await expect(page.getByRole('alert')).toHaveCount(0)
    const afterRestart = await page.evaluate(async () => ({
      count: (await globalThis.desktopBridge.listWorkspaces()).snapshot.workspaces.length,
      organization: (await globalThis.desktopBridge.getWorkspaceOrganization()).organization
    }))
    expect(afterRestart.count).toBe(128)
    expect(afterRestart.organization).not.toHaveProperty('legacyOverLimit')
  } finally {
    await closeElectronApplication(application).catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function launch(profileDirectory, harness, shellPath) {
  return electron.launch({
    args: [mainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
    cwd: desktopDirectory,
    executablePath: harness.executablePath,
    env: {
      ...process.env,
      ...harness.electronEnvironment,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      HOME: profileDirectory,
      ...(shellPath ? { SHELL: shellPath } : {}),
      TMPDIR: harness.runtimeDirectory,
      XDG_RUNTIME_DIR: harness.runtimeDirectory,
      ZDOTDIR: profileDirectory
    },
    timeout: 15_000
  })
}

async function seedLegacyWorkspaceOverflow(databasePath, workingDirectory) {
  const current = JSON.parse(
    execFileSync(
      'sqlite3',
      [databasePath, 'SELECT json_payload FROM application_snapshot WHERE singleton = 1;'],
      { encoding: 'utf8' }
    )
  )
  const source = current.workspaces[0]
  if (!source) throw new Error('Seed application snapshot has no workspace')
  const workspaces = Array.from({ length: 129 }, (_, index) =>
    cloneLegacyWorkspace(source, index, workingDirectory)
  )
  const placement = current.windowPlacements?.find(({ id }) => id === current.focusedWindowId)
  if (!placement) throw new Error('Seed application snapshot has no focused window placement')
  const legacy = {
    ...current,
    workspaces,
    selectedWorkspaceId: workspaces[0].id,
    workspaceSelection: [workspaces[0].id],
    workspacePins: [],
    workspaceGroups: [],
    workspaceGroupAssignments: {},
    savedLayouts: [],
    windowPlacements: [
      {
        ...placement,
        workspaceIds: workspaces.map(({ id }) => id),
        focusedWorkspaceId: workspaces[0].id
      }
    ],
    focusedWindowId: placement.id,
    focusHistory: { entries: [], cursor: 0 },
    legacyOverLimit: {
      workspaceCount: 129,
      maximumPanesInWorkspace: 1,
      maximumTabsInWorkspace: 1,
      totalPaneCount: 129,
      totalTabCount: 129
    },
    revision: 0
  }

  const payloadPath = join(dirname(databasePath), 'legacy-reduction-payload.json')
  await writeFile(payloadPath, JSON.stringify(legacy))
  const escapedPayloadPath = payloadPath.replaceAll("'", "''")
  execFileSync('sqlite3', [
    databasePath,
    `UPDATE application_snapshot
       SET revision = '0', json_payload = CAST(readfile('${escapedPayloadPath}') AS TEXT), saved_at_ms = 1
       WHERE singleton = 1;`
  ])
  JSON.parse(await readFile(payloadPath, 'utf8'))
}

function cloneLegacyWorkspace(source, index, workingDirectory) {
  const sourcePanes = Array.isArray(source.panes) ? source.panes : Object.values(source.panes)
  const sourceTabs = Array.isArray(source.tabs) ? source.tabs : Object.values(source.tabs)
  const sourceBrowser = sourceTabs.find(({ content }) => content.kind === 'browser')
  if (!sourcePanes[0] || !sourceBrowser) throw new Error('Seed workspace is not browser-backed')
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const tabId = randomUUID()
  const pane = {
    ...sourcePanes[0],
    id: paneId,
    tabs: [tabId],
    selectedTabId: tabId
  }
  const content = {
    ...sourceBrowser.content,
    metadata: {
      ...sourceBrowser.content.metadata,
      browserSessionId: randomUUID()
    }
  }
  const tab = { ...sourceBrowser, id: tabId, paneId, content }
  return {
    ...source,
    id: workspaceId,
    name: `Legacy workspace ${String(index + 1)}`,
    workingDirectory,
    layout: { kind: 'leaf', paneId },
    selectedPaneId: paneId,
    panes: { [paneId]: pane },
    tabs: { [tabId]: tab }
  }
}
