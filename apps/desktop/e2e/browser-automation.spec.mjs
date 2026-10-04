import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import { createBrowserAutomationTestServer } from './helpers/browser-automation-test-server.mjs'
import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const automationMainEntry = join(desktopDirectory, 'e2e/helpers/browser-automation-main.cjs')
const dialogHarnessEntry = join(desktopDirectory, 'e2e/helpers/dialog-harness-main.cjs')
const cliBinary = join(repositoryDirectory, 'target/node-linux/bin/agent-workspace-node.mjs')
const rendererUrl = 'agent-workspace://renderer/index.html'
const evidenceRoot =
  process.env.AGENT_WORKSPACE_EVIDENCE_DIR ?? join(tmpdir(), 'agent-workspace-m5-validation')

test.beforeAll(async () => {
  test.setTimeout(150_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('M5 browser automation E2E needs an X11 or Wayland display.')
  }
  await mkdir(evidenceRoot, { recursive: true })
  if (process.env.AGENT_WORKSPACE_E2E_SKIP_BUILD !== '1') {
    execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
      cwd: repositoryDirectory,
      stdio: 'inherit'
    })
  }
})

test('Linux automation mode uses a separate profile without keyring access', async () => {
  test.skip(process.platform !== 'linux', 'No-keyring automation mode is Linux-only.')
  test.setTimeout(60_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'aw-keyring-'))
  const normalDirectory = profileDirectory
  const automationDirectory = join(normalDirectory, 'automation')
  const sessionFile = join(automationDirectory, 'runtime', 'node-cli-session.json')
  const normalCredential = join(normalDirectory, 'secrets', 'control-token.enc')
  const target = await createBrowserAutomationTestServer()
  let application
  let session
  const automation = (command, params) =>
    cli(sessionFile, ['browser-automation', command, '--params-json', JSON.stringify(params)])
  try {
    await mkdir(dirname(normalCredential), { recursive: true })
    await writeFile(normalCredential, 'normal profile credential remains untouched')
    const harness = await createPackagedElectronHarness(profileDirectory)
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    application = await electron.launch({
      args: [automationMainEntry, `--user-data-dir=${profileDirectory}`, '--automation'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...environment,
        ...harness.electronEnvironment,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        TMPDIR: harness.runtimeDirectory,
        HOME: profileDirectory,
        ZDOTDIR: profileDirectory
      }
    })
    const renderer = await application.firstWindow()
    await expect(renderer.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/)
    await waitForAutomationCapability(sessionFile)
    expect(
      await application.evaluate(({ app, safeStorage }) => ({
        userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData'),
        passwordStore: app.commandLine.getSwitchValue('password-store'),
        backend: safeStorage.getSelectedStorageBackend()
      }))
    ).toEqual({
      userData: automationDirectory,
      sessionData: automationDirectory,
      passwordStore: 'basic',
      backend: 'basic_text'
    })
    await expect(
      readFile(join(automationDirectory, 'secrets', 'control-token.enc'))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      readFile(join(automationDirectory, 'state', 'content-index-key-id'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(normalCredential, 'utf8')).toBe(
      'normal profile credential remains untouched'
    )
    const epoch = await currentIdempotencyEpoch(sessionFile)
    session = (
      await automation('create', {
        mode: 'ephemeral',
        profileKey: 'default',
        idempotency: { epoch, key: randomUUID() },
        correlationId: randomUUID()
      })
    ).session
    let navigationEpoch = session.navigationEpoch
    for (const operation of [
      { kind: 'navigate', url: target.origin },
      { kind: 'wait', condition: { kind: 'lifecycle', lifecycle: 'load' } },
      { kind: 'typeText', selector: '#typed', text: 'automation input' },
      { kind: 'click', selector: '#commit' }
    ]) {
      const result = await automation('execute', {
        automationSessionId: session.automationSessionId,
        sessionGeneration: session.generation,
        navigationEpoch,
        operationId: randomUUID(),
        attemptEpoch: 1,
        timeoutMs: 10_000,
        operation,
        idempotency: { epoch, key: randomUUID() },
        correlationId: randomUUID()
      })
      expect(result.operation.state).toBe('succeeded')
      if (result.operation.result?.kind === 'navigation')
        navigationEpoch = result.operation.result.navigationEpoch
    }
    await expect
      .poll(() => target.requests.filter(({ path }) => path === '/event/input').length)
      .toBe(1)
    await application.evaluate(({ webContents }, origin) => {
      const browser = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(origin))
      if (!browser || browser.session.isPersistent())
        throw new Error('Automation browser must be in memory')
    }, target.origin)
  } finally {
    if (session)
      await automation('destroy', {
        automationSessionId: session.automationSessionId,
        generation: session.generation
      }).catch(() => undefined)
    await application?.close().catch(() => undefined)
    await target.close()
    await rm(profileDirectory, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern
test('attach mode requires trusted approval for the exact live target', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m5-attach-'))
  const evidenceDirectory = join(evidenceRoot, testInfo.testId.replaceAll(/[^A-Za-z0-9._-]/gu, '_'))
  const dialogTrace = join(evidenceDirectory, 'attach-confirmation.jsonl')
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(dialogTrace, '')
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated M5 attach shell.\n')
  const target = await createBrowserAutomationTestServer()
  let application
  let attachedSession
  let sessionFile

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    sessionFile = join(profileDirectory, 'runtime', 'node-cli-session.json')
    application = await electron.launch({
      args: [dialogHarnessEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        AGENT_WORKSPACE_E2E_DIALOG_RESPONSES: JSON.stringify({
          messageResponses: [0, 1, 1],
          tracePath: dialogTrace
        }),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      },
      timeout: 10_000
    })
    const renderer = await application.firstWindow()
    await expect.poll(() => renderer.url(), { timeout: 20_000 }).toBe(rendererUrl)
    await expect(renderer.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/, {
      timeout: 20_000
    })
    await waitForAutomationCapability(sessionFile)
    await installBrowserMountTrace(application)
    await createBrowserSplit(renderer)
    await navigateBrowser(renderer, `${target.origin}/`)
    const exactTarget = await selectedBrowserTarget(renderer, application)
    const baseline = await webContentsCounts(application)

    const attachArgs = (browserLifecycleId) => [
      'browser',
      'automation',
      'session-create',
      '--mode',
      'attach',
      '--profile-key',
      'default',
      '--workspace-id',
      exactTarget.workspaceId,
      '--pane-id',
      exactTarget.paneId,
      '--tab-id',
      exactTarget.tabId,
      '--browser-session-id',
      exactTarget.browserSessionId,
      '--browser-lifecycle-id',
      browserLifecycleId,
      '--target-window-id',
      exactTarget.windowId,
      '--target-window-generation',
      String(exactTarget.windowGeneration),
      '--idempotency-epoch',
      exactTarget.idempotencyEpoch
    ]

    await expectCliFailure(
      sessionFile,
      attachArgs(exactTarget.browserLifecycleId),
      'approval_denied'
    )
    const approved = await cli(sessionFile, attachArgs(exactTarget.browserLifecycleId))
    attachedSession = approved.session
    expect(attachedSession).toMatchObject({ mode: 'attach', state: 'ready' })
    expect(await webContentsCounts(application)).toEqual(baseline)
    await cli(sessionFile, sessionCommand('session-destroy', attachedSession))
    attachedSession = undefined
    expect(await webContentsCounts(application)).toEqual(baseline)
    await expect(renderer.locator('.browser-pane')).toBeVisible()

    await expectCliFailure(sessionFile, attachArgs(randomUUID()), 'target_not_found')
    const trace = await readFileUtf8(dialogTrace)
    const entries = trace
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter(({ kind }) => kind === 'message')
    expect(entries).toHaveLength(3)
    expect(entries.map(({ kind, result }) => [kind, result.response])).toEqual([
      ['message', 0],
      ['message', 1],
      ['message', 1]
    ])
    expect(entries.every(({ title }) => title === 'Allow browser automation?')).toBe(true)
  } finally {
    if (attachedSession && sessionFile) {
      await cli(sessionFile, sessionCommand('session-destroy', attachedSession)).catch(
        () => undefined
      )
    }
    await application?.close().catch(() => undefined)
    await target.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

// Each cli() call is a fresh process/socket connection. The create call is deliberately
// separate from list/get/invoke/read/release/destroy to exercise caller-scoped transport.
// Playwright requires fixture object destructuring even when this Electron test uses none.
// eslint-disable-next-line no-empty-pattern
test('packaged M5 CLI automation is isolated, policy-bound, cancellable, and leak-free', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m5-browser-'))
  const evidenceDirectory = join(evidenceRoot, testInfo.testId.replaceAll(/[^A-Za-z0-9._-]/gu, '_'))
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated M5 browser automation shell.\n')
  const target = await createBrowserAutomationTestServer()
  const consoleEvidence = []
  const networkEvidence = []
  const operationEvidence = []
  const mainOutput = []
  const mainTrace = join(evidenceDirectory, 'main-diagnostic.jsonl')
  await writeFile(mainTrace, '')
  let application
  let idempotencyEpoch
  let session
  let sessionFile
  let preserveFailureProfile = false

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    sessionFile = join(profileDirectory, 'runtime', 'node-cli-session.json')
    application = await electron.launch({
      args: [automationMainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        AGENT_WORKSPACE_E2E_MAIN_TRACE: mainTrace,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      },
      timeout: 10_000
    })
    application.process().stdout?.on('data', (chunk) => mainOutput.push(String(chunk)))
    application.process().stderr?.on('data', (chunk) => mainOutput.push(String(chunk)))
    const renderer = await application.firstWindow()
    renderer.on('console', (message) => {
      consoleEvidence.push({ source: 'renderer', type: message.type(), text: message.text() })
    })
    renderer.on('pageerror', (error) => {
      consoleEvidence.push({ source: 'renderer', type: 'pageerror', text: error.message })
    })
    await expect.poll(() => renderer.url(), { timeout: 20_000 }).toBe(rendererUrl)
    await expect(renderer.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/, {
      timeout: 20_000
    })
    await waitForAutomationCapability(sessionFile)

    await installMainEvidence(application)
    const baseline = await webContentsCounts(application)
    idempotencyEpoch = await currentIdempotencyEpoch(sessionFile)
    const created = await cli(sessionFile, [
      'browser',
      'automation',
      'session-create',
      '--mode',
      'ephemeral',
      '--profile-key',
      'default',
      '--idempotency-epoch',
      idempotencyEpoch
    ])
    session = created.session
    session.idempotencyEpoch = idempotencyEpoch
    expect(session).toMatchObject({ generation: 1, mode: 'ephemeral', state: 'ready' })
    operationEvidence.push(summary('session-create', created))

    const listed = await cli(sessionFile, ['browser', 'automation', 'session-list'])
    expect(listed.sessions).toContainEqual(
      expect.objectContaining({
        automationSessionId: session.automationSessionId,
        generation: session.generation
      })
    )
    const fetched = await cli(sessionFile, sessionCommand('session-get', session))
    expect(fetched.session).toMatchObject({ automationSessionId: session.automationSessionId })

    let navigationEpoch = session.navigationEpoch
    const navigated = await invoke(sessionFile, session, navigationEpoch, [
      'navigate',
      '--url',
      `${target.origin}/`
    ])
    navigationEpoch = navigated.result.navigationEpoch
    operationEvidence.push(summary('navigate', navigated))
    await invoke(sessionFile, session, navigationEpoch, [
      'wait',
      'lifecycle',
      '--lifecycle',
      'load'
    ])

    const queried = await invoke(sessionFile, session, navigationEpoch, [
      'query',
      '--selector',
      'body *',
      '--limit',
      '40'
    ])
    const queryJson = JSON.stringify(queried)
    expect(queryJson).not.toContain(target.secret)
    expect(queryJson).not.toContain('M5 hostile automation target')
    expect(queried.result).toMatchObject({ kind: 'query', matches: expect.any(Array) })
    operationEvidence.push(summary('query', queried))

    await invoke(sessionFile, session, navigationEpoch, [
      'type',
      '--selector',
      '#typed',
      '--text',
      'literal typed value'
    ])
    await invoke(sessionFile, session, navigationEpoch, ['click', '--selector', '#commit'])
    await expect
      .poll(() => target.requests.filter(({ path }) => path === '/event/input').length)
      .toBe(1)

    const isolation = await automationPageState(application, target.origin)
    expect(isolation.probe).toEqual({
      process: 'undefined',
      require: 'undefined',
      electron: 'undefined',
      desktopBridge: 'undefined',
      controlToken: 'undefined',
      partition: 'undefined'
    })
    expect(isolation.inputCommitted).toBe(true)
    expect(isolation.storageKeys).toEqual([])

    const beforePolicy = await webContentsCounts(application)
    await invoke(sessionFile, session, navigationEpoch, ['click', '--selector', '#popup'])
    await invoke(sessionFile, session, navigationEpoch, ['click', '--selector', '#download'])
    await invoke(sessionFile, session, navigationEpoch, ['click', '--selector', '#permission'])
    await invoke(sessionFile, session, navigationEpoch, ['click', '--selector', '#external'])
    await expect
      .poll(() => target.requests.some(({ path }) => path === '/event/permission-denied'))
      .toBe(true)
    expect(target.requests.some(({ path }) => path === '/event/permission-granted')).toBe(false)
    expect(target.requests.some(({ path }) => path === '/popup')).toBe(false)
    expect(await webContentsCounts(application)).toEqual(beforePolicy)
    expect(await findNamedFile(profileDirectory, 'm5-forbidden-download.txt')).toBeNull()

    const captured = await invoke(sessionFile, session, navigationEpoch, [
      'screenshot',
      '--width',
      '320',
      '--height',
      '240'
    ])
    const handle = captured.result?.handle
    expect(captured.result?.kind).toBe('screenshot')
    expect(handle).toMatchObject({ mediaType: 'image/png', chunkCount: expect.any(Number) })
    const chunks = []
    for (let index = 0; index < handle.chunkCount; index += 1) {
      const result = await cli(sessionFile, [
        'browser',
        'automation',
        'screenshot-read',
        '--automation-session-id',
        session.automationSessionId,
        '--session-generation',
        String(session.generation),
        '--handle-id',
        handle.handleId,
        '--chunk-index',
        String(index)
      ])
      expect(result).toMatchObject({ handleId: handle.handleId, chunkIndex: index })
      chunks.push(Buffer.from(result.dataBase64, 'base64'))
    }
    const screenshotBytes = Buffer.concat(chunks)
    expect(screenshotBytes).toHaveLength(handle.byteLength)
    expect(createHash('sha256').update(screenshotBytes).digest('hex')).toBe(handle.sha256)
    screenshotBytes.fill(0)
    await cli(sessionFile, [
      'browser',
      'automation',
      'screenshot-release',
      '--automation-session-id',
      session.automationSessionId,
      '--session-generation',
      String(session.generation),
      '--handle-id',
      handle.handleId
    ])
    await expectCliFailure(
      sessionFile,
      [
        'browser',
        'automation',
        'screenshot-read',
        '--automation-session-id',
        session.automationSessionId,
        '--session-generation',
        String(session.generation),
        '--handle-id',
        handle.handleId,
        '--chunk-index',
        '0'
      ],
      'result_expired'
    )
    operationEvidence.push(summary('screenshot', captured))

    const canceledOperation = randomUUID()
    const canceledCorrelation = randomUUID()
    const pendingCancel = cliProcess(
      sessionFile,
      operationArgs(session, navigationEpoch, [
        'wait',
        '--operation-id',
        canceledOperation,
        '--correlation-id',
        canceledCorrelation,
        'selector',
        '--selector',
        '#will-never-exist',
        '--condition',
        'visible'
      ])
    )
    void pendingCancel.catch(() => undefined)
    await waitForAutomationPending(application, '#will-never-exist')
    const canceled = await cli(sessionFile, [
      'browser',
      'automation',
      'cancel',
      '--automation-session-id',
      session.automationSessionId,
      '--session-generation',
      String(session.generation),
      '--operation-id',
      canceledOperation,
      '--correlation-id',
      canceledCorrelation
    ])
    expect(canceled.operation.errorCode).toBe('canceled')
    await expectProcessFailure(pendingCancel, 'canceled')

    const pendingDestroy = cliProcess(
      sessionFile,
      operationArgs(session, navigationEpoch, [
        'wait',
        'selector',
        '--selector',
        '#still-never-exists',
        '--condition',
        'visible'
      ])
    )
    void pendingDestroy.catch(() => undefined)
    await waitForAutomationPending(application, '#still-never-exists')
    const destroyed = await cli(sessionFile, sessionCommand('session-destroy', session))
    expect(destroyed.session.state).toBe('destroying')
    await expectProcessFailure(pendingDestroy, 'canceled')
    await expect
      .poll(async () => {
        const terminal = await cli(sessionFile, sessionCommand('session-get', session))
        return terminal.session.state
      })
      .toBe('destroyed')
    session = undefined
    await expect.poll(() => webContentsCounts(application)).toEqual(baseline)

    const runtimeEvidence = await readMainEvidence(application)
    networkEvidence.push(...runtimeEvidence.network)
    consoleEvidence.push(...runtimeEvidence.console)
    expect(runtimeEvidence.duplicateNavigations).toEqual([])
    expect(runtimeEvidence.network.filter(({ url }) => url === `${target.origin}/`).length).toBe(1)
    expect(consoleEvidence.filter(({ type }) => type === 'error' || type === 'pageerror')).toEqual(
      []
    )

    const evidence = {
      schemaVersion: 1,
      acceptance: {
        'M5-AC-01': 'pass',
        'M5-AC-02': 'pass',
        'M5-AC-03': 'pass',
        'M5-AC-04': 'pass-with-packaged-provider-window-race-suite'
      },
      baseline,
      final: await webContentsCounts(application),
      console: consoleEvidence,
      network: networkEvidence,
      operations: operationEvidence,
      requestCounts: Object.fromEntries(
        [...new Set(target.requests.map(({ path }) => path))].map((path) => [
          path,
          target.requests.filter((entry) => entry.path === path).length
        ])
      )
    }
    const evidenceJson = JSON.stringify(evidence, null, 2)
    expect(evidenceJson).not.toContain(target.secret)
    expect(evidenceJson).not.toContain('dataBase64')
    await writeFile(join(evidenceDirectory, 'm5-browser-automation.json'), `${evidenceJson}\n`)
  } catch (error) {
    preserveFailureProfile = process.env.AGENT_WORKSPACE_E2E_KEEP_FAILURE === '1'
    const diagnostic = {
      error: String(error?.stack ?? error),
      mainOutput: mainOutput.join('').slice(-16_384),
      mainTrace: await readFile(mainTrace, 'utf8').catch(() => ''),
      controlRequests: application
        ? await application.evaluate(() =>
            (globalThis.__m5ControlRequests ?? [])
              .filter(
                ({ command }) =>
                  command.includes('Poll') ||
                  command.includes('poll') ||
                  command.includes('heartbeat') ||
                  command.startsWith('browserAutomation.')
              )
              .map(({ command, params }) => ({ command, params }))
          )
        : [],
      sessions: sessionFile
        ? await cli(sessionFile, ['browser', 'automation', 'session-list']).catch(
            (listError) => `${listError.stdout ?? ''}${listError.stderr ?? ''}`
          )
        : undefined,
      serviceLogs: await readDiagnosticLogs(join(profileDirectory, 'logs'))
    }
    await writeFile(
      join(evidenceDirectory, 'm5-browser-automation-failure.json'),
      `${JSON.stringify(diagnostic, null, 2)}\n`
    )
    throw new Error(`M5 packaged flow failed: ${JSON.stringify(diagnostic)}`, { cause: error })
  } finally {
    if (session) {
      const runtime = application
        ? await application.evaluate(({ app }) => app.getPath('userData')).catch(() => undefined)
        : undefined
      if (runtime && sessionFile) {
        await cli(sessionFile, sessionCommand('session-destroy', session)).catch(() => undefined)
      }
    }
    await application?.close().catch(() => undefined)
    await target.close().catch(() => undefined)
    if (!preserveFailureProfile) {
      await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
    }
  }
})

// eslint-disable-next-line no-empty-pattern
test('packaged M5 provider and window races terminate once and preserve exact routing', async ({}, testInfo) => {
  test.setTimeout(150_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m5-races-'))
  const evidenceDirectory = join(evidenceRoot, testInfo.testId.replaceAll(/[^A-Za-z0-9._-]/gu, '_'))
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated M5 provider-race shell.\n')
  const target = await createBrowserAutomationTestServer()
  const mainTrace = join(evidenceDirectory, 'm5-ac04-main.jsonl')
  await writeFile(mainTrace, '')
  let application
  let sessionFile
  const sessions = []
  const checks = {}
  const mark = (step) =>
    writeFile(join(evidenceDirectory, 'm5-ac04-progress.json'), `${JSON.stringify({ step })}\n`)

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    sessionFile = join(profileDirectory, 'runtime', 'node-cli-session.json')
    application = await electron.launch({
      args: [automationMainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        AGENT_WORKSPACE_E2E_ALLOW_ATTACH: '1',
        AGENT_WORKSPACE_E2E_MAIN_TRACE: mainTrace,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      },
      timeout: 10_000
    })
    const primary = await application.firstWindow()
    await expect.poll(() => primary.url(), { timeout: 20_000 }).toBe(rendererUrl)
    await expect(primary.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/, {
      timeout: 20_000
    })
    await waitForAutomationCapability(sessionFile)
    await mark('provider-ready')
    await installBrowserMountTrace(application)
    await createBrowserSplit(primary)
    await navigateBrowser(primary, `${target.origin}/?owner=primary`)
    let primaryTarget = await selectedBrowserTarget(primary, application)

    const secondaryWorkspace = join(profileDirectory, 'secondary-workspace')
    await mkdir(secondaryWorkspace)
    const secondary = await createSecondPlacementWindow(primary, application, secondaryWorkspace)
    await mark('second-window-ready')
    await expect(primary.locator('.browser-pane')).toBeVisible()
    primaryTarget = await selectedBrowserTarget(primary, application)
    await createBrowserSplit(secondary)
    await navigateBrowser(secondary, `${target.origin}/?owner=secondary`)
    const secondaryTarget = await selectedBrowserTarget(secondary, application)
    expect(primaryTarget.windowId).not.toBe(secondaryTarget.windowId)
    expect(primaryTarget.windowGeneration).toBeGreaterThan(0)
    expect(secondaryTarget.windowGeneration).toBeGreaterThan(0)
    const routedBaseline = await webContentsCounts(application)

    await mark('attaching-primary')
    const primarySession = await createAttachedSession(sessionFile, primaryTarget)
    await mark('attaching-secondary')
    const secondarySession = await createAttachedSession(sessionFile, secondaryTarget)
    sessions.push(primarySession, secondarySession)
    const primaryQueryId = randomUUID()
    const secondaryQueryId = randomUUID()
    await invoke(sessionFile, primarySession, primarySession.navigationEpoch, [
      'query',
      '--operation-id',
      primaryQueryId,
      '--selector',
      'body'
    ])
    await invoke(sessionFile, secondarySession, secondarySession.navigationEpoch, [
      'query',
      '--operation-id',
      secondaryQueryId,
      '--selector',
      'body'
    ])
    const routed = await providerDeliveries(application)
    expect(executeDelivery(routed, primaryQueryId)?.request.target).toEqual({
      windowId: primaryTarget.windowId,
      windowGeneration: primaryTarget.windowGeneration
    })
    expect(executeDelivery(routed, secondaryQueryId)?.request.target).toEqual({
      windowId: secondaryTarget.windowId,
      windowGeneration: secondaryTarget.windowGeneration
    })
    checks.multiWindowExactRouting = 'pass'
    await mark('multi-window-routing-pass')

    const disconnectSession = await createEphemeralSessionEventually(sessionFile)
    sessions.push(disconnectSession)
    const disconnect = await pendingSelectorOperation(
      application,
      sessionFile,
      disconnectSession,
      '#m5-provider-disconnect-pending'
    )
    const registrationsBeforeDisconnect = await controlRequestCount(
      application,
      'desktopProvider.register'
    )
    expect(await application.evaluate(() => globalThis.__m5CloseProviderTransport())).toBe(true)
    const disconnectCode = failureCode(await processFailureOutput(disconnect.promise))
    expect(['interrupted', 'timeout']).toContain(disconnectCode)
    await waitForControlRequestCount(
      application,
      'desktopProvider.register',
      registrationsBeforeDisconnect + 1
    )
    const disconnectReplay = failureCode(await cliFailureOutput(sessionFile, disconnect.args))
    expect(disconnectReplay).toBe(disconnectCode)
    await delay(1_250)
    expect(await providerDeliveryCount(application, disconnect.operationId)).toBe(1)
    checks.providerDisconnect = disconnectCode
    await mark('provider-disconnect-pass')

    const leaseSession = await createEphemeralSessionEventually(sessionFile)
    sessions.push(leaseSession)
    const leasePending = await pendingSelectorOperation(
      application,
      sessionFile,
      leaseSession,
      '#m5-provider-lease-expiry'
    )
    const leaseStartedAt = Date.now()
    await application.evaluate(() => globalThis.__m5SetDropProviderHeartbeats(true))
    const leaseCode = failureCode(await processFailureOutput(leasePending.promise))
    const leaseElapsedMs = Date.now() - leaseStartedAt
    expect(leaseCode).toBe('interrupted')
    expect(leaseElapsedMs).toBeGreaterThanOrEqual(13_000)
    await application.evaluate(() => globalThis.__m5SetDropProviderHeartbeats(false))
    await createEphemeralSessionEventually(sessionFile, { destroyAfterCreate: true })
    const leaseReplay = failureCode(await cliFailureOutput(sessionFile, leasePending.args))
    expect(leaseReplay).toBe(leaseCode)
    await delay(1_250)
    expect(await providerDeliveryCount(application, leasePending.operationId)).toBe(1)
    checks.providerLeaseExpiry = { code: leaseCode, elapsedAtLeastRealLeaseWindow: true }
    await mark('provider-lease-expiry-pass')

    const refreshedSecondaryTarget = await selectedBrowserTarget(secondary, application)
    expect(refreshedSecondaryTarget.windowId).toBe(secondaryTarget.windowId)
    expect(refreshedSecondaryTarget.windowGeneration).toBe(secondaryTarget.windowGeneration)
    const closingSession = await createAttachedSession(sessionFile, refreshedSecondaryTarget)
    sessions.push(closingSession)
    const windowClose = await pendingSelectorOperation(
      application,
      sessionFile,
      closingSession,
      '#m5-window-close-pending'
    )
    const secondaryWindow = await application.browserWindow(secondary)
    await secondaryWindow.evaluate((window) => window.destroy())
    await secondaryWindow.dispose()
    const windowCloseCode = failureCode(await processFailureOutput(windowClose.promise))
    expect(['interrupted', 'target_not_found', 'canceled', 'timeout']).toContain(windowCloseCode)
    const windowCloseReplay = failureCode(await cliFailureOutput(sessionFile, windowClose.args))
    expect(windowCloseReplay).toBe(windowCloseCode)
    await delay(1_250)
    expect(await providerDeliveryCount(application, windowClose.operationId)).toBe(1)
    expect(await providerDeliveryCount(application, primaryQueryId)).toBe(1)
    checks.ownerWindowClosure = windowCloseCode
    await mark('owner-window-close-pass')

    for (const candidate of sessions.splice(0)) {
      await destroySessionFully(sessionFile, candidate)
    }
    await writeFile(
      join(evidenceDirectory, 'm5-ac04-cleanup-diagnostic.json'),
      `${JSON.stringify(await webContentsProjection(application), null, 2)}\n`
    )
    await expect
      .poll(() => webContentsCounts(application), { timeout: 20_000 })
      .toEqual({
        total: routedBaseline.total - 1,
        remotePages: routedBaseline.remotePages
      })
    const finalProjection = await webContentsProjection(application)
    expect(new Set(finalProjection.map(({ browserWindow }) => browserWindow))).toEqual(
      new Set([finalProjection.find(({ url }) => url === rendererUrl)?.browserWindow])
    )
    checks.noRedispatch = 'pass'
    checks.otherWindowNotTargeted = 'pass'
    await mark('cleanup-pass')

    const evidence = {
      schemaVersion: 1,
      acceptance: { 'M5-AC-04': 'pass' },
      checks,
      baseline: routedBaseline,
      final: await webContentsCounts(application),
      deliveryCounts: {
        disconnect: await providerDeliveryCount(application, disconnect.operationId),
        leaseExpiry: await providerDeliveryCount(application, leasePending.operationId),
        windowClosure: await providerDeliveryCount(application, windowClose.operationId)
      },
      targets: {
        distinctWindowIds: primaryTarget.windowId !== secondaryTarget.windowId,
        generationsPositive:
          primaryTarget.windowGeneration > 0 && secondaryTarget.windowGeneration > 0
      }
    }
    await writeFile(
      join(evidenceDirectory, 'm5-provider-window-races.json'),
      `${JSON.stringify(evidence, null, 2)}\n`
    )
  } finally {
    if (sessionFile) {
      for (const candidate of sessions) {
        await cli(sessionFile, sessionCommand('session-destroy', candidate)).catch(() => undefined)
      }
    }
    await application?.close().catch(() => undefined)
    await target.close().catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

// eslint-disable-next-line no-empty-pattern
test('round 2 CLI feedback survives SPA startup and autonomous navigation', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'ternline-round2-'))
  const evidenceDirectory = join(evidenceRoot, 'round2')
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(join(profileDirectory, '.zshrc'), '# Task-owned round 2 shell.\n')
  const target = await createBrowserAutomationTestServer()
  let application
  let sessionFile
  const sessions = []
  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    sessionFile = join(profileDirectory, 'runtime', 'node-cli-session.json')
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    application = await electron.launch({
      args: [dialogHarnessEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...environment,
        ...harness.electronEnvironment,
        AGENT_WORKSPACE_E2E_DIALOG_RESPONSES: JSON.stringify({ messageResponses: [0, 1] }),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        HOME: profileDirectory,
        TMPDIR: harness.runtimeDirectory,
        XDG_RUNTIME_DIR: harness.runtimeDirectory,
        ZDOTDIR: profileDirectory
      },
      timeout: 20_000
    })
    const renderer = await application.firstWindow()
    await expect(renderer.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/, {
      timeout: 20_000
    })
    await waitForAutomationCapability(sessionFile)
    for (const path of ['/', '/push', '/replace', '/redirect']) {
      const opened = await cli(sessionFile, ['browser', 'open', '--url', `${target.origin}${path}`])
      expect(opened.operation.state).toBe('succeeded')
      sessions.push(opened.session)
    }
    const sessionId = sessions[1].automationSessionId
    const browser = (...args) => cli(sessionFile, ['browser', ...args, '--session-id', sessionId])
    expect(await browser('eval', '--expression', 'location.pathname')).toEqual({
      kind: 'evaluation',
      value: '/pushed'
    })
    const query = await browser('query', '--selector', 'h1')
    expect(query.matches[0]).toMatchObject({
      tag: 'h1',
      role: 'heading',
      text: 'M5 hostile automation target'
    })
    expect(query).not.toHaveProperty('session')
    expect(await browser('eval', '--verbose', '--expression', 'Promise.resolve(42)')).toMatchObject(
      {
        session: { automationSessionId: sessionId },
        operation: { result: { kind: 'evaluation', value: 42 } }
      }
    )
    for (const [expression, message] of [
      ['throw new Error("boom")', 'Error: boom'],
      ['nope.x', 'ReferenceError: nope is not defined']
    ]) {
      const output = await cliFailureOutput(sessionFile, [
        'browser',
        'eval',
        '--session-id',
        sessionId,
        '--expression',
        expression
      ])
      expect(output).toContain('evaluation_failed')
      expect(output).toContain(message)
      expect(output).toContain('at ')
    }
    expect(
      await browser('eval', '--expression', 'history.pushState({},"","/x"); location.pathname')
    ).toMatchObject({ kind: 'evaluation', value: '/x', navigation: { url: `${target.origin}/x` } })
    const beforeNavigation = (await cli(sessionFile, ['browser-automation', 'list'])).sessions.find(
      (item) => item.automationSessionId === sessionId
    ).navigationEpoch
    await browser(
      'eval',
      '--expression',
      'setTimeout(()=>location.replace("/next"),50); "scheduled"'
    )
    await expect
      .poll(
        async () =>
          (await cli(sessionFile, ['browser-automation', 'list'])).sessions.find(
            (item) => item.automationSessionId === sessionId
          ).navigationEpoch,
        { timeout: 15_000 }
      )
      .toBeGreaterThan(beforeNavigation)
    expect(await browser('eval', '--expression', 'document.title')).toEqual({
      kind: 'evaluation',
      value: 'M5 navigation target'
    })
    expect((await cli(sessionFile, ['browser-automation', 'list'])).sessions).toHaveLength(4)
    expect(
      await cli(sessionFile, [
        'browser',
        'eval',
        '--session-id',
        sessions[0].automationSessionId,
        '--expression',
        'document.title'
      ])
    ).toEqual({ kind: 'evaluation', value: 'M5 hostile automation target' })

    const workspace = await cli(sessionFile, [
      'workspace',
      'create',
      '--name',
      'Round 2 ports',
      '--working-directory',
      profileDirectory
    ])
    const portCommand = `python3 -m http.server 0 --bind 127.0.0.1\n`
    await cli(sessionFile, [
      'terminal',
      'send',
      '--terminal-id',
      workspace.terminalId,
      '--data',
      portCommand
    ])
    let port
    await expect
      .poll(
        async () => {
          const { stdout } = await execFileAsync(cliBinary, [
            '--session-file',
            sessionFile,
            'terminal',
            'read',
            '--terminal-id',
            workspace.terminalId
          ])
          port = Number(stdout.match(/Serving HTTP on .* port (\d+)/u)?.[1])
          return port
        },
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0)
    await expect
      .poll(async () =>
        (
          await cli(sessionFile, ['terminal', 'ports', '--terminal-id', workspace.terminalId])
        ).listeningPorts.includes(port)
      )
      .toBe(true)
    await cli(sessionFile, ['workspace', 'close', '--workspace-id', workspace.workspaceId])
    expect(
      (await cli(sessionFile, ['state', 'snapshot'])).snapshot.workspaces.find(
        (item) => item.id === workspace.workspaceId
      )
    ).toBeUndefined()

    await createBrowserSplit(renderer)
    await navigateBrowser(renderer, `${target.origin}/push`)
    const tabId = await renderer.evaluate(async () => {
      const { snapshot } = await globalThis.desktopBridge.listWorkspaces()
      const workspace = snapshot.workspaces.find(({ id }) => id === snapshot.selectedWorkspaceId)
      return workspace.panes.find(({ id }) => id === workspace.selectedPaneId).selectedTabId
    })
    const attachArgs = ['browser', 'attach', '--tab-id', tabId]
    await expectCliFailure(sessionFile, attachArgs, 'approval_denied')
    const attached = await cli(sessionFile, attachArgs)
    sessions.push(attached.session)
    const attachedId = attached.session.automationSessionId
    await cli(sessionFile, [
      'browser',
      'type',
      '--session-id',
      attachedId,
      '--selector',
      '#typed',
      '--text',
      'round 2 verified',
      '--clear'
    ])
    await cli(sessionFile, [
      'browser',
      'click',
      '--session-id',
      attachedId,
      '--selector',
      '#commit'
    ])
    expect(
      await cli(sessionFile, [
        'browser',
        'eval',
        '--session-id',
        attachedId,
        '--expression',
        'globalThis.__m5InputCommitted'
      ])
    ).toEqual({ kind: 'evaluation', value: true })
    await cli(sessionFile, [
      'browser',
      'screenshot',
      '--session-id',
      attachedId,
      '--width',
      '1000',
      '--height',
      '700',
      '--output',
      join(evidenceDirectory, 'attached-browser.png')
    ])

    await cli(sessionFile, [
      'browser',
      'recording',
      'start',
      '--session-id',
      attachedId,
      '--width',
      '1000',
      '--height',
      '700'
    ])
    await cli(sessionFile, [
      'browser',
      'type',
      '--session-id',
      attachedId,
      '--selector',
      '#typed',
      '--text',
      'recorded interaction',
      '--clear'
    ])
    await cli(sessionFile, [
      'browser',
      'click',
      '--session-id',
      attachedId,
      '--selector',
      '#commit'
    ])
    await delay(600)
    const recording = await cli(sessionFile, [
      'browser',
      'recording',
      'stop',
      '--session-id',
      attachedId,
      '--output',
      join(evidenceDirectory, 'flow.webm')
    ])
    expect(recording).toMatchObject({
      kind: 'recording',
      output: join(evidenceDirectory, 'flow.webm')
    })
    expect((await readFile(recording.output)).byteLength).toBeGreaterThan(1000)
    await testInfo.attach('Approved browser attachment (1000x700 isolated Electron fixture)', {
      path: join(evidenceDirectory, 'attached-browser.png'),
      contentType: 'image/png'
    })
  } finally {
    for (const session of sessions) {
      if (sessionFile)
        await cli(sessionFile, [
          'browser-automation',
          'destroy',
          '--params-json',
          JSON.stringify({
            automationSessionId: session.automationSessionId,
            generation: session.generation
          })
        ]).catch(() => undefined)
    }
    await application?.close().catch(() => undefined)
    await target.close().catch(() => undefined)
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function cli(sessionFile, args) {
  const { stdout } = await execFileAsync(cliBinary, ['--session-file', sessionFile, ...args], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 40_000
  })
  const parsed = JSON.parse(stdout)
  return parsed.result ?? parsed
}

function cliProcess(sessionFile, args) {
  return execFileAsync(cliBinary, ['--session-file', sessionFile, ...args], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 40_000
  })
}

function sessionCommand(command, session) {
  return [
    'browser',
    'automation',
    command,
    '--automation-session-id',
    session.automationSessionId,
    '--generation',
    String(session.generation)
  ]
}

function operationArgs(session, navigationEpoch, args) {
  return [
    'browser',
    'automation',
    ...args.slice(0, 1),
    '--automation-session-id',
    session.automationSessionId,
    '--session-generation',
    String(session.generation),
    '--navigation-epoch',
    String(navigationEpoch),
    '--idempotency-epoch',
    session.idempotencyEpoch,
    '--timeout-ms',
    '30000',
    ...args.slice(1)
  ]
}

async function invoke(sessionFile, session, navigationEpoch, args) {
  const result = await cli(sessionFile, operationArgs(session, navigationEpoch, args))
  expect(result.operation.state).toBe('succeeded')
  return result.operation
}

async function expectCliFailure(sessionFile, args, code) {
  try {
    await cli(sessionFile, args)
  } catch (error) {
    expect(`${error.stdout ?? ''}${error.stderr ?? ''}`).toContain(code)
    return
  }
  throw new Error(`Expected CLI failure ${code}`)
}

async function waitForAutomationCapability(sessionFile) {
  let observed
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      observed = await cli(sessionFile, ['identify'])
      if (observed.capabilities?.includes('browser-automation-v1')) return
    } catch (error) {
      observed = { error: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
    await delay(100)
  }
  throw new Error(`browser-automation-v1 unavailable; last identify=${JSON.stringify(observed)}`)
}

async function currentIdempotencyEpoch(sessionFile) {
  const catalog = await cli(sessionFile, ['action', 'list', '--limit', '1'])
  if (!catalog.idempotencyEpoch) throw new Error('Service idempotency epoch is unavailable')
  return catalog.idempotencyEpoch
}

async function expectProcessFailure(promise, code) {
  try {
    await promise
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    expect(output).toContain(code)
    return
  }
  throw new Error(`Expected pending CLI operation to fail with ${code}`)
}

async function processFailureOutput(promise) {
  try {
    await promise
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  throw new Error('Expected pending CLI operation to fail')
}

async function cliFailureOutput(sessionFile, args) {
  try {
    await cli(sessionFile, args)
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  throw new Error('Expected replayed CLI operation to fail')
}

function failureCode(output) {
  const codes = [
    'interrupted',
    'target_not_found',
    'canceled',
    'timeout',
    'provider_lease_expired',
    'provider_unavailable'
  ]
  const code = codes.find((candidate) => output.includes(candidate))
  if (!code) throw new Error(`Stable browser automation error code missing from: ${output}`)
  return code
}

function summary(command, result) {
  const operation = result.operation ?? result
  return {
    command,
    state: operation.state ?? operation.session?.state,
    errorCode: operation.errorCode,
    resultKind: operation.result?.kind,
    navigationEpoch: operation.navigationEpoch,
    screenshot:
      operation.result?.kind === 'screenshot'
        ? {
            byteLength: operation.result.handle.byteLength,
            chunkCount: operation.result.handle.chunkCount,
            mediaType: operation.result.handle.mediaType,
            sha256: operation.result.handle.sha256
          }
        : undefined
  }
}

async function webContentsCounts(application) {
  return application.evaluate(({ webContents }) => {
    const live = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed())
    return {
      total: live.length,
      remotePages: live.filter((contents) => /^https?:\/\//u.test(contents.getURL())).length
    }
  })
}

async function webContentsProjection(application) {
  return application.evaluate(({ BrowserWindow, webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed())
      .map((contents) => ({
        id: contents.id,
        type: contents.getType(),
        url: contents.getURL(),
        browserWindow: BrowserWindow.fromWebContents(contents)?.id ?? null
      }))
  )
}

async function automationPageState(application, origin) {
  return application.evaluate(async ({ webContents }, expectedOrigin) => {
    const candidate = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().startsWith(expectedOrigin))
    if (!candidate) throw new Error('Automation WebContents not found')
    return candidate.executeJavaScript(`({
      probe: globalThis.__m5Probe,
      inputCommitted: globalThis.__m5InputCommitted,
      storageKeys: Object.keys(localStorage)
    })`)
  }, origin)
}

async function installMainEvidence(application) {
  await application.evaluate(({ app }) => {
    globalThis.__m5AutomationEvidence = { console: [], network: [] }
    app.on('web-contents-created', (_event, contents) => {
      contents.on('console-message', (_consoleEvent, level, message) => {
        globalThis.__m5AutomationEvidence.console.push({ level, message })
      })
      contents.on('did-start-navigation', (_navigationEvent, url, _inPlace, mainFrame) => {
        if (mainFrame) globalThis.__m5AutomationEvidence.network.push({ kind: 'navigation', url })
      })
    })
  })
}

async function readMainEvidence(application) {
  return application.evaluate(() => {
    const evidence = globalThis.__m5AutomationEvidence ?? { console: [], network: [] }
    const counts = new Map()
    for (const entry of evidence.network) counts.set(entry.url, (counts.get(entry.url) ?? 0) + 1)
    return {
      ...evidence,
      duplicateNavigations: [...counts].filter(([, count]) => count > 1)
    }
  })
}

async function waitForAutomationPending(application, selector) {
  await expect
    .poll(() =>
      application.evaluate(async ({ webContents }, expectedSelector) => {
        const contents = webContents
          .getAllWebContents()
          .find(
            (candidate) =>
              !candidate.isDestroyed() && candidate.getURL().startsWith('http://127.0.0.1:')
          )
        if (!contents) return 0
        return contents.executeJavaScript(
          `globalThis.__m5SelectorPolls?.[${JSON.stringify(expectedSelector)}] ?? 0`
        )
      }, selector)
    )
    .toBeGreaterThan(0)
}

async function providerDeliveries(application) {
  return application.evaluate(() => JSON.parse(JSON.stringify(globalThis.__m5ProviderDeliveries)))
}

function executeDelivery(deliveries, operationId) {
  return deliveries.find(
    (delivery) =>
      delivery.kind === 'execute' && delivery.request?.operation?.operationId === operationId
  )
}

async function providerDeliveryCount(application, operationId) {
  return application.evaluate(
    (_, expectedOperationId) =>
      (globalThis.__m5ProviderDeliveries ?? []).filter(
        (delivery) =>
          delivery.kind === 'execute' &&
          delivery.request?.operation?.operationId === expectedOperationId
      ).length,
    operationId
  )
}

async function pendingSelectorOperation(application, sessionFile, session, selector) {
  const operationId = randomUUID()
  const correlationId = randomUUID()
  const idempotencyKey = randomUUID()
  const args = operationArgs(session, session.navigationEpoch, [
    'wait',
    '--operation-id',
    operationId,
    '--correlation-id',
    correlationId,
    '--idempotency-key',
    idempotencyKey,
    'selector',
    '--selector',
    selector,
    '--condition',
    'visible'
  ])
  const promise = cliProcess(sessionFile, args)
  void promise.catch(() => undefined)
  await expect.poll(() => providerDeliveryCount(application, operationId)).toBe(1)
  return { args, correlationId, operationId, promise }
}

async function controlRequestCount(application, command) {
  return application.evaluate(
    (_, expectedCommand) =>
      (globalThis.__m5ControlRequests ?? []).filter(
        (request) => request.command === expectedCommand
      ).length,
    command
  )
}

async function waitForControlRequestCount(application, command, minimum) {
  await expect
    .poll(() => controlRequestCount(application, command), { timeout: 25_000 })
    .toBeGreaterThanOrEqual(minimum)
}

async function createAttachedSession(sessionFile, target) {
  const created = await cli(sessionFile, [
    'browser',
    'automation',
    'session-create',
    '--mode',
    'attach',
    '--profile-key',
    'default',
    '--workspace-id',
    target.workspaceId,
    '--pane-id',
    target.paneId,
    '--tab-id',
    target.tabId,
    '--browser-session-id',
    target.browserSessionId,
    '--browser-lifecycle-id',
    target.browserLifecycleId,
    '--target-window-id',
    target.windowId,
    '--target-window-generation',
    String(target.windowGeneration),
    '--idempotency-epoch',
    target.idempotencyEpoch
  ])
  const session = created.session
  session.idempotencyEpoch = target.idempotencyEpoch
  expect(session).toMatchObject({ mode: 'attach', state: 'ready' })
  return session
}

async function createEphemeralSessionEventually(sessionFile, options = {}) {
  const idempotencyEpoch = await currentIdempotencyEpoch(sessionFile)
  let lastError
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    try {
      const created = await cli(sessionFile, [
        'browser',
        'automation',
        'session-create',
        '--mode',
        'ephemeral',
        '--profile-key',
        'default',
        '--idempotency-epoch',
        idempotencyEpoch
      ])
      created.session.idempotencyEpoch = idempotencyEpoch
      if (options.destroyAfterCreate) {
        await destroySessionFully(sessionFile, created.session)
      }
      return created.session
    } catch (error) {
      lastError = error
      await delay(200)
    }
  }
  throw new Error(`Desktop browser provider did not recover: ${String(lastError)}`)
}

async function destroySessionFully(sessionFile, session) {
  await cli(sessionFile, sessionCommand('session-destroy', session)).catch(() => undefined)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const fetched = await cli(sessionFile, sessionCommand('session-get', session))
      if (['destroyed', 'failed', 'expired'].includes(fetched.session.state)) return
    } catch {
      return
    }
    await delay(100)
  }
  throw new Error(`Automation session ${session.automationSessionId} did not finish destruction`)
}

async function findNamedFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = await findNamedFile(path, name)
      if (found) return found
    } else if (entry.name === name) return path
  }
  return null
}

async function readDiagnosticLogs(directory) {
  try {
    const output = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) output.push(...(await readDiagnosticLogs(path)))
      else output.push((await readFile(path, 'utf8')).slice(-8_192))
    }
    return output
  } catch {
    return []
  }
}

async function readFileUtf8(path) {
  return readFile(path, 'utf8')
}

async function createBrowserSplit(renderer) {
  await renderer.getByRole('button', { name: 'Open command palette' }).click()
  const palette = renderer.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search commands' }).fill('open browser split')
  await palette.getByRole('option', { name: /Open browser split/u }).click()
  await expect(renderer.locator('.browser-pane')).toHaveCount(1)
  const pane = renderer.locator('.pane-view:has(.browser-pane)')
  await pane.locator('.browser-status').click()
  await expect(pane).toHaveAttribute('data-selected', 'true')
}

async function createSecondPlacementWindow(primary, application, workspaceDirectory) {
  await primary.getByRole('button', { name: 'Open folder as workspace' }).click()
  const workspaceDialog = primary.getByRole('dialog')
  await workspaceDialog.getByLabel('Workspace folder path').fill(workspaceDirectory)
  await workspaceDialog.getByRole('button', { name: 'Open workspace' }).click()
  await expect(primary.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/, {
    timeout: 20_000
  })
  const request = await primary.evaluate(async () => {
    const [workspaceResult, topology] = await Promise.all([
      globalThis.desktopBridge.listWorkspaces(),
      globalThis.desktopBridge.listWindows()
    ])
    const workspaceId = workspaceResult.snapshot.selectedWorkspaceId
    const source = topology.windows.find(({ workspaceIds }) => workspaceIds.includes(workspaceId))
    if (!workspaceId || !source) throw new Error('Source placement is unavailable')
    return {
      mutation: {
        expectedRevision: topology.revision,
        idempotencyEpoch: topology.idempotencyEpoch,
        idempotencyKey: globalThis.crypto.randomUUID()
      },
      label: 'M5 secondary',
      workspaceId,
      sourceWindow: { windowId: source.windowId, expectedRevision: source.revision }
    }
  })
  const created = await primary.evaluate(
    (windowRequest) =>
      Promise.race([
        globalThis.desktopBridge.createWindow(windowRequest),
        new Promise((_, reject) =>
          globalThis.setTimeout(() => reject(new Error('M5 window.create timed out')), 20_000)
        )
      ]),
    request
  )
  let secondary
  await expect
    .poll(
      async () => {
        for (const candidate of application.windows()) {
          if (candidate === primary || candidate.url() !== rendererUrl) continue
          try {
            const topology = await candidate.evaluate(() => globalThis.desktopBridge.listWindows())
            const workspaces = await candidate.evaluate(() =>
              globalThis.desktopBridge.listWorkspaces()
            )
            if (
              topology.windows.some(
                ({ windowId, workspaceIds }) =>
                  windowId === created.window.windowId &&
                  workspaceIds.some((id) =>
                    workspaces.snapshot.workspaces.some((workspace) => workspace.id === id)
                  )
              )
            ) {
              secondary = candidate
              return true
            }
          } catch {
            // The renderer binding is not ready yet.
          }
        }
        return false
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  await expect.poll(() => secondary.url()).toBe(rendererUrl)
  return secondary
}

async function navigateBrowser(renderer, url) {
  const address = renderer.getByRole('textbox', { name: 'Address' })
  await address.fill(url)
  await address.press('Enter')
  await expect(address).toHaveValue(url)
}

async function installBrowserMountTrace(application) {
  await application.evaluate(({ ipcMain }) => {
    globalThis.__m5BrowserMounts = []
    const handlers = ipcMain._invokeHandlers
    const original = handlers?.get('browser:mountView')
    if (!original || original.__m5TraceInstalled) return
    const traced = async (event, ...args) => {
      globalThis.__m5BrowserMounts.push(JSON.parse(JSON.stringify(args[0])))
      return original(event, ...args)
    }
    traced.__m5TraceInstalled = true
    handlers.set('browser:mountView', traced)
  })
}

async function selectedBrowserTarget(renderer, application) {
  const projection = await renderer.evaluate(async () => {
    const [workspaceResult, topology] = await Promise.all([
      globalThis.desktopBridge.listWorkspaces(),
      globalThis.desktopBridge.listWindows()
    ])
    const workspace = workspaceResult.snapshot.workspaces.find(
      ({ id }) => id === workspaceResult.snapshot.selectedWorkspaceId
    )
    const pane = workspace?.panes.find(({ id }) => id === workspace.selectedPaneId)
    const tab = workspace?.tabs.find(({ id }) => id === pane?.selectedTabId)
    const window = topology.windows.find(({ workspaceIds }) => workspaceIds.includes(workspace?.id))
    if (!workspace || !pane || tab?.content.kind !== 'browser' || !window) return null
    return {
      browserSessionId: tab.content.state.browserSessionId,
      idempotencyEpoch: topology.idempotencyEpoch,
      paneId: pane.id,
      tabId: tab.id,
      windowId: window.windowId,
      workspaceId: workspace.id
    }
  })
  if (!projection) throw new Error('Selected browser projection is unavailable')
  const mainTarget = await application.evaluate((_, expected) => {
    const mount = [...(globalThis.__m5BrowserMounts ?? [])]
      .reverse()
      .find((candidate) => candidate.browserSessionId === expected.browserSessionId)
    const heartbeat = [...(globalThis.__m5ControlRequests ?? [])]
      .reverse()
      .find(({ command }) => command === 'desktopProvider.heartbeat')
    const claim = heartbeat?.params?.windows?.find(({ windowId }) => windowId === expected.windowId)
    return {
      browserLifecycleId: mount?.lifecycleId ?? null,
      windowGeneration: claim?.generation ?? null
    }
  }, projection)
  if (!mainTarget.browserLifecycleId || !mainTarget.windowGeneration) {
    throw new Error('Browser lifecycle/provider target trace is unavailable')
  }
  return { ...projection, ...mainTarget }
}
