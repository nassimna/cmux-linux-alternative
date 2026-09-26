import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'

import {
  actionInvokeParams,
  m4Cli,
  m4CliFailure,
  m4CliProcess,
  m4RawCommand,
  m4SpawnCli,
  prepareM4Project
} from './helpers/actions-m4-harness.mjs'
import { closeElectronApplication } from './helpers/close-electron-application.mjs'
import { createPackagedElectronHarness } from './helpers/packaged-electron-harness.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const mainEntry = join(desktopDirectory, 'e2e/helpers/actions-m4-main.cjs')
const cliBinary = join(repositoryDirectory, 'target/node-linux/bin/agent-workspace-node.mjs')
const rendererUrl = 'agent-workspace://renderer/index.html'
const evidenceRoot =
  process.env.AGENT_WORKSPACE_EVIDENCE_DIR ?? join(tmpdir(), 'agent-workspace-m4-validation')

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('M4 actions E2E needs an X11 or Wayland display.')
  }
  await mkdir(evidenceRoot, { recursive: true })
  if (process.env.AGENT_WORKSPACE_E2E_SKIP_BUILD !== '1') {
    execFileSync('pnpm', ['--filter', '@agent-workspace/desktop', 'build'], {
      cwd: repositoryDirectory,
      stdio: 'inherit'
    })
  }
})

// Each CLI call opens a fresh authenticated socket. Project-action calls remain connected while
// awaiting their terminal result, exercising the native main-process confirmation provider.
// eslint-disable-next-line no-empty-pattern
test('qualifies packaged M4 actions, confirmation, containment, and provider loss', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const profileDirectory = await mkdtemp(join(tmpdir(), 'agent-workspace-m4-actions-'))
  const evidenceDirectory = join(evidenceRoot, testInfo.testId.replaceAll(/[^A-Za-z0-9._-]/gu, '_'))
  const dialogTrace = join(evidenceDirectory, 'native-confirmations.jsonl')
  const evidencePath = join(evidenceDirectory, 'm4-actions.json')
  await rm(evidenceDirectory, { force: true, recursive: true })
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(join(profileDirectory, '.zshrc'), '# Isolated M4 actions shell.\n')
  const project = await prepareM4Project(profileDirectory)
  const checks = {}
  let application

  try {
    const harness = await createPackagedElectronHarness(profileDirectory)
    const sessionFile = join(profileDirectory, 'runtime', 'node-cli-session.json')
    application = await electron.launch({
      args: [mainEntry, `--user-data-dir=${profileDirectory}`, '--disable-gpu'],
      cwd: desktopDirectory,
      executablePath: harness.executablePath,
      env: {
        ...process.env,
        ...harness.electronEnvironment,
        AGENT_WORKSPACE_M4_DIALOGS: JSON.stringify({
          messageResponses: [0, 1, 0, 0, 0, 0, 0],
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
    const page = await application.firstWindow()
    await expect.poll(() => page.url(), { timeout: 20_000 }).toBe(rendererUrl)
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/, {
      timeout: 20_000
    })
    await expect
      .poll(() => m4Cli(cliBinary, sessionFile, ['identify']))
      .toMatchObject({
        application: 'agent-workspace',
        capabilities: expect.arrayContaining(['actions-v1'])
      })
    const catalog = await m4Cli(cliBinary, sessionFile, ['action', 'list', '--limit', '64'])
    const actionIds = catalog.definitions.map(({ actionId }) => actionId)
    expect(actionIds).toEqual(
      expect.arrayContaining([
        'desktop.window.focus',
        'workspace.card.pin',
        'workspace.group.rename',
        'workspace.group.collapse',
        'project.m4.literal',
        'project.m4.deny',
        'project.m4.output',
        'project.m4.slow'
      ])
    )
    checks.registryFreshSocket = 'pass'

    const listed = await page.evaluate(() => globalThis.desktopBridge.listWorkspaces())
    let organization = await page.evaluate(() =>
      globalThis.desktopBridge.getWorkspaceOrganization()
    )
    const workspaceId = listed.snapshot.workspaces[0].id
    const serviceAction = async (actionId, parameters) => {
      const result = await m4Cli(cliBinary, sessionFile, [
        'action',
        'invoke',
        '--action-id',
        actionId,
        '--action-version',
        '1',
        '--parameters-json',
        JSON.stringify(parameters),
        '--idempotency-epoch',
        catalog.idempotencyEpoch
      ])
      expect(result.invocation).toMatchObject({ state: 'acknowledged', terminalCode: 'succeeded' })
    }
    await serviceAction('workspace.card.pin', {
      workspaceId,
      pinned: true,
      expectedRevision: organization.organization.revision
    })
    organization = await page.evaluate(() => globalThis.desktopBridge.getWorkspaceOrganization())
    expect(organization.organization.pins).toContain(workspaceId)
    const groupId = randomUUID()
    await m4Cli(cliBinary, sessionFile, [
      'group',
      'create',
      '--group-id',
      groupId,
      '--name',
      'M4 group',
      '--expected-revision',
      String(organization.organization.revision)
    ])
    organization = await page.evaluate(() => globalThis.desktopBridge.getWorkspaceOrganization())
    await serviceAction('workspace.group.rename', {
      groupId,
      name: 'M4 renamed',
      expectedRevision: organization.organization.revision
    })
    organization = await page.evaluate(() => globalThis.desktopBridge.getWorkspaceOrganization())
    await serviceAction('workspace.group.collapse', {
      groupId,
      collapsed: true,
      expectedRevision: organization.organization.revision
    })
    organization = await page.evaluate(() => globalThis.desktopBridge.getWorkspaceOrganization())
    expect(organization.organization.groups).toContainEqual(
      expect.objectContaining({ id: groupId, name: 'M4 renamed', collapsed: true })
    )
    checks.serviceActions = 'pass'

    const topology = await page.evaluate(() => globalThis.desktopBridge.listWindows())
    const targetWindow = topology.windows[0]
    const providerHeartbeat = await waitForMainRequest(application, 'desktopProvider.heartbeat')
    const targetGeneration = providerHeartbeat.params.windows.find(
      ({ windowId }) => windowId === targetWindow.windowId
    )?.generation
    expect(targetGeneration).toBeGreaterThan(0)
    const focusKey = randomUUID()
    const focusCorrelation = randomUUID()
    const focus = await m4Cli(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'desktop.window.focus',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch,
      '--idempotency-key',
      focusKey,
      '--correlation-id',
      focusCorrelation,
      '--target-window-id',
      targetWindow.windowId,
      '--target-window-generation',
      String(targetGeneration)
    ])
    expect(focus.invocation).toMatchObject({ state: 'acknowledged', terminalCode: 'succeeded' })
    const replay = await m4Cli(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'desktop.window.focus',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch,
      '--idempotency-key',
      focusKey,
      '--correlation-id',
      focusCorrelation,
      '--target-window-id',
      targetWindow.windowId,
      '--target-window-generation',
      String(targetGeneration)
    ])
    expect(replay.invocation).toEqual(focus.invocation)
    const tracedAck = await waitForMainRequest(application, 'desktopAction.acknowledge')
    const duplicateAck = await m4RawCommand(
      sessionFile,
      'desktopAction.acknowledge',
      tracedAck.params
    )
    expect(duplicateAck).toMatchObject({ ok: true })
    checks.desktopFocusAndDuplicateAck = 'pass'

    const invokeProject = (actionId, extra = []) =>
      m4Cli(cliBinary, sessionFile, [
        'action',
        'invoke',
        '--action-id',
        actionId,
        '--action-version',
        '1',
        '--idempotency-epoch',
        catalog.idempotencyEpoch,
        ...extra
      ])
    const literal = await invokeProject('project.m4.literal')
    expect(literal.invocation).toMatchObject({ state: 'acknowledged', terminalCode: 'succeeded' })
    expect(await readFile(join(project.artifactDirectory, 'literal-result'), 'utf8')).toBe(
      '$(touch m4-artifacts/escape) ; *'
    )
    await expectMissing(join(project.artifactDirectory, 'escape'))
    checks.literalArgvAndContainment = 'pass'

    const denied = await m4CliFailure(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'project.m4.deny',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch
    ])
    expect(JSON.stringify(denied)).toContain('policy_denied')
    await expectMissing(join(project.artifactDirectory, 'denied-side-effect'))
    checks.nativeDenyAndNoPreapprovalEffect = 'pass'

    const output = await invokeProject('project.m4.output')
    expect(output.invocation.result).toMatchObject({
      outputTruncated: true,
      stdoutBytes: expect.any(Number),
      stderrBytes: expect.any(Number),
      redactionCount: expect.any(Number)
    })
    expect(JSON.stringify(output)).not.toContain('M4_PRIVATE_MARKER')
    checks.outputBoundsAndContentFreeResult = 'pass'

    const slowKey = randomUUID()
    const slowCorrelation = randomUUID()
    const pendingSlow = m4CliProcess(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'project.m4.slow',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch,
      '--idempotency-key',
      slowKey,
      '--correlation-id',
      slowCorrelation
    ]).then(
      (result) => ({ result }),
      (error) => ({ error })
    )
    const slowInvocation = {
      invocationId: invocationId(catalog.idempotencyEpoch, slowKey, 'project.m4.slow')
    }
    await waitForConfirmationResponse(application, slowInvocation.invocationId)
    const cancellation = await m4CliFailure(cliBinary, sessionFile, [
      'action',
      'cancel',
      '--invocation-id',
      slowInvocation.invocationId,
      '--correlation-id',
      slowCorrelation
    ])
    expect(JSON.stringify(cancellation)).toContain('cancellation_not_guaranteed')
    const canceledProcess = await pendingSlow
    expect(String(canceledProcess.error?.stdout ?? canceledProcess.result?.stdout)).toMatch(
      /(?:canceled|transport_or_service)/u
    )
    await expectMissing(join(project.artifactDirectory, 'slow-finished'))
    checks.cancelAndProcessTree = 'pass'

    const timedOut = await m4CliFailure(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'project.m4.slow',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch
    ])
    expect(JSON.stringify(timedOut)).toMatch(/(?:expired|execution_failed|failed)/u)
    await expectMissing(join(project.artifactDirectory, 'slow-finished'))
    checks.timeout = 'pass'

    const callerLossKey = randomUUID()
    const callerLossCorrelation = randomUUID()
    const lostCaller = m4SpawnCli(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'project.m4.slow',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch,
      '--idempotency-key',
      callerLossKey,
      '--correlation-id',
      callerLossCorrelation
    ])
    const callerLossInvocationId = invocationId(
      catalog.idempotencyEpoch,
      callerLossKey,
      'project.m4.slow'
    )
    await waitForConfirmationResponse(application, callerLossInvocationId)
    lostCaller.kill('SIGKILL')
    await new Promise((resolveExit) => lostCaller.once('exit', resolveExit))
    await expect
      .poll(
        async () => {
          const replayResult = await m4RawCommand(
            sessionFile,
            'action.invoke',
            actionInvokeParams(
              'project.m4.slow',
              catalog.idempotencyEpoch,
              {},
              undefined,
              callerLossKey,
              callerLossCorrelation
            )
          )
          return replayResult.result?.invocation?.state
        },
        { timeout: 20_000 }
      )
      .toMatch(/^(?:canceled|failed)$/u)
    const callerLossReplay = await m4RawCommand(
      sessionFile,
      'action.invoke',
      actionInvokeParams(
        'project.m4.slow',
        catalog.idempotencyEpoch,
        {},
        undefined,
        callerLossKey,
        callerLossCorrelation
      )
    )
    expect(callerLossReplay.result.invocation.state).toMatch(/^(?:canceled|failed)$/u)
    await expectMissing(join(project.artifactDirectory, 'slow-finished'))
    checks.callerLoss = 'pass'

    const confirmationRequest = await waitForMainRequest(
      application,
      'projectAction.confirmationRespond'
    )
    for (const mutation of [
      { nonce: randomUUID() },
      { challenge: randomUUID() },
      { confirmationDefinitionSha256: '0'.repeat(64) }
    ]) {
      const forged = await m4RawCommand(sessionFile, 'projectAction.confirmationRespond', {
        ...confirmationRequest.params,
        ...mutation
      })
      expect(forged).toMatchObject({ ok: false })
    }
    const replayConfirmation = await m4RawCommand(
      sessionFile,
      'projectAction.confirmationRespond',
      confirmationRequest.params
    )
    expect(replayConfirmation).toMatchObject({ ok: false })
    checks.forgedStaleReplayConfirmation = 'pass'

    const originalExecutable = join(project.projectDirectory, 'm4-bin/action-runner')
    const savedExecutable = join(project.projectDirectory, 'm4-bin/action-runner.saved')
    const outsideExecutable = join(tmpdir(), `agent-workspace-m4-outside-${randomUUID()}`)
    await writeFile(outsideExecutable, '#!/bin/sh\nexit 0\n')
    await rename(originalExecutable, savedExecutable)
    await symlink(outsideExecutable, originalExecutable)
    expect((await lstat(originalExecutable)).isSymbolicLink()).toBe(true)
    const symlinkFailure = await m4CliFailure(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'project.m4.literal',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch
    ])
    expect(JSON.stringify(symlinkFailure)).toMatch(/(?:execution_failed|policy_denied)/u)
    await rm(originalExecutable)
    await rename(savedExecutable, originalExecutable)
    await rm(outsideExecutable, { force: true })
    checks.symlinkAndPathEscape = 'pass'

    await replaceTrustedManifest(
      profileDirectory,
      [
        {
          id: 'project.m4.missing',
          title: 'Unavailable executable',
          executable: { kind: 'approvedName', name: 'bash' },
          args: ['-c', 'program'],
          workingDirectory: { kind: 'projectRoot' },
          environment: []
        }
      ],
      ['bash']
    )
    const missingCatalog = await m4Cli(cliBinary, sessionFile, ['action', 'list', '--limit', '64'])
    expect(missingCatalog.definitions.map(({ actionId }) => actionId)).not.toContain(
      'project.m4.missing'
    )
    checks.missingApprovedExecutable = 'pass'

    await replaceTrustedManifest(profileDirectory, [
      {
        id: 'project.m4.escape',
        title: 'Escaping executable',
        executable: { kind: 'projectRelativePath', path: '../outside' },
        args: [],
        workingDirectory: { kind: 'projectRoot' },
        environment: []
      }
    ])
    const escapeCatalog = await m4Cli(cliBinary, sessionFile, ['action', 'list', '--limit', '64'])
    expect(escapeCatalog.definitions.map(({ actionId }) => actionId)).not.toContain(
      'project.m4.escape'
    )
    checks.lexicalPathEscape = 'pass'

    await application.evaluate(() => {
      globalThis.__agentWorkspaceM4DelayNextAcknowledgement = true
      globalThis.__agentWorkspaceM4DelayedAcknowledgement = undefined
    })
    const providerLossKey = randomUUID()
    const providerLossCorrelation = randomUUID()
    const pendingProviderLoss = m4CliProcess(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'desktop.window.focus',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch,
      '--idempotency-key',
      providerLossKey,
      '--correlation-id',
      providerLossCorrelation,
      '--target-window-id',
      targetWindow.windowId,
      '--target-window-generation',
      String(targetGeneration)
    ])
    await expect
      .poll(
        () =>
          application.evaluate(
            () => globalThis.__agentWorkspaceM4DelayedAcknowledgement?.params.invocationId
          ),
        { timeout: 20_000 }
      )
      .toBe(invocationId(catalog.idempotencyEpoch, providerLossKey, 'desktop.window.focus'))
    const heartbeat = await waitForMainRequest(application, 'desktopProvider.heartbeat')
    const unregistered = await m4RawCommand(sessionFile, 'desktopProvider.unregister', {
      identity: {
        providerId: heartbeat.params.providerId,
        providerEpoch: heartbeat.params.providerEpoch,
        leaseId: heartbeat.params.leaseId
      }
    })
    expect(unregistered).toMatchObject({ ok: true })
    await pendingProviderLoss.catch(() => undefined)
    const interrupted = await m4CliFailure(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'desktop.window.focus',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch,
      '--idempotency-key',
      providerLossKey,
      '--correlation-id',
      providerLossCorrelation,
      '--target-window-id',
      targetWindow.windowId,
      '--target-window-generation',
      String(targetGeneration)
    ])
    expect(JSON.stringify(interrupted)).toContain('execution_failed')
    const unavailable = await m4CliFailure(cliBinary, sessionFile, [
      'action',
      'invoke',
      '--action-id',
      'desktop.window.focus',
      '--action-version',
      '1',
      '--idempotency-epoch',
      catalog.idempotencyEpoch,
      '--target-window-id',
      targetWindow.windowId,
      '--target-window-generation',
      String(targetGeneration)
    ])
    expect(JSON.stringify(unavailable)).toContain('provider_ineligible')
    checks.inflightUnregisterInterruptedReplay = 'pass'
    checks.unregisterAndNoProvider = 'pass'

    const dialogEntries = (await readFile(dialogTrace, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(dialogEntries.every(({ title }) => title === 'Confirm project action')).toBe(true)
    expect(dialogEntries.every(({ detailLines }) => detailLines === 3)).toBe(true)
    expect(dialogEntries.map(({ response }) => response)).toEqual([0, 1, 0, 0, 0, 0, 0])
    checks.contentFreeNativeConfirmation = 'pass'

    const evidence = {
      schemaVersion: 1,
      acceptance: {
        'M4-AC-01': 'pass',
        'M4-AC-02': 'pass',
        'M4-AC-03': 'pass',
        'M4-AC-04': 'pass'
      },
      checks,
      dialogDecisions: dialogEntries.map(({ response }) => response),
      actionCount: actionIds.length
    }
    const evidenceJson = JSON.stringify(evidence, null, 2)
    expect(evidenceJson).not.toContain(profileDirectory)
    expect(evidenceJson).not.toContain('M4_PRIVATE_MARKER')
    await writeFile(evidencePath, `${evidenceJson}\n`)
  } finally {
    await closeElectronApplication(application).catch(() => undefined)
    await rm(profileDirectory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function waitForMainRequest(application, command) {
  return expect
    .poll(
      () =>
        application.evaluate(
          (_, requestedCommand) =>
            globalThis.__agentWorkspaceM4ControlRequests
              ?.filter(({ command: candidate }) => candidate === requestedCommand)
              .at(-1),
          command
        ),
      { timeout: 20_000 }
    )
    .not.toBeUndefined()
    .then(() =>
      application.evaluate(
        (_, requestedCommand) =>
          globalThis.__agentWorkspaceM4ControlRequests
            .filter(({ command: candidate }) => candidate === requestedCommand)
            .at(-1),
        command
      )
    )
}

function invocationId(epoch, key, actionId) {
  const uuidBytes = (value) => Buffer.from(value.replaceAll('-', ''), 'hex')
  const digest = createHash('sha256')
    .update('actions-v1')
    .update(uuidBytes(epoch))
    .update(uuidBytes(key))
    .update(actionId)
    .digest()
    .subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function waitForConfirmationResponse(application, invocationId) {
  await expect
    .poll(
      () =>
        application.evaluate(
          (_, expectedInvocationId) =>
            globalThis.__agentWorkspaceM4ControlRequests?.some(
              ({ command, params }) =>
                command === 'projectAction.confirmationRespond' &&
                params.invocationId === expectedInvocationId &&
                params.decision === 'confirmed'
            ),
          invocationId
        ),
      { timeout: 20_000 }
    )
    .toBe(true)
}

async function expectMissing(path) {
  await expect(
    access(path).then(
      () => true,
      () => false
    )
  ).resolves.toBe(false)
}

async function replaceTrustedManifest(profileDirectory, actions, approvedExecutables = []) {
  const manifestPath = join(profileDirectory, '.cmux/actions.json')
  const configurationPath = join(profileDirectory, 'configuration/desktop.json')
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, actions }))
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8'))
  configuration.actions.approvedExecutables = approvedExecutables
  configuration.actions.trustedProjects[0].manifestSha256 = createHash('sha256')
    .update(manifestBytes)
    .digest('hex')
  configuration.revision += 1
  await writeFile(manifestPath, manifestBytes)
  await writeFile(configurationPath, `${JSON.stringify(configuration)}\n`)
}
