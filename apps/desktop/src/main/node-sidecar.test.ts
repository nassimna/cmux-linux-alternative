import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it, vi } from 'vitest'

import { DESKTOP_IPC } from '@agent-workspace/contracts/desktop/desktop-bridge'
import { ServerError } from '@agent-workspace/client-runtime'
import { browserSessionStateSchema } from '@agent-workspace/protocol-client'
import projection from '../../../../packages/protocol-client/fixtures/milestone2-projection.json'
import settings from '../../../../packages/protocol-client/fixtures/milestone2-settings.json'
import { NodeSidecar } from './node-sidecar'

const targetId = '00000000-0000-4000-8000-0000000000f3'
const repository = fileURLToPath(new URL('../../../../', import.meta.url))

it("binds a live backup proof to the sidecar's exact requested paths", async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const proof = {
    liveStatePath: '/tmp/state.sqlite',
    backupStatePath: '/tmp/backup.sqlite',
    liveStateIdentity: '1:2',
    backupStateIdentity: '1:3',
    backupSha256: 'a'.repeat(64)
  }
  const liveBackupProof = vi.fn().mockResolvedValue(proof)
  Object.assign(sidecar, {
    stopped: false,
    options: { liveDatabasePath: proof.liveStatePath, backupPath: proof.backupStatePath },
    ownerChannel: { liveBackupProof }
  })
  await expect(sidecar.liveBackupProof()).resolves.toEqual(proof)
  Object.assign(sidecar, {
    options: { liveDatabasePath: '/tmp/other.sqlite', backupPath: proof.backupStatePath }
  })
  await expect(sidecar.liveBackupProof()).rejects.toThrow('does not match')
  Object.assign(sidecar, { stopped: true })
  await expect(sidecar.liveBackupProof()).rejects.toThrow('stopped')
})

it.skipIf(process.platform !== 'linux')(
  'hands a reserved live replacement to the fd-only v5 helper after both owner fences release',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-live-handoff-'))
    const state = join(directory, 'state.sqlite3')
    const backup = join(directory, 'backup.sqlite3')
    const keyPath = join(directory, 'test-key')
    const serverPath = join(directory, 'bin.mjs')
    const request = {
      remoteTargetId: targetId,
      enrollmentId: randomUUID(),
      expectedRevision: 2
    }
    const proof = {
      liveStatePath: state,
      backupStatePath: backup,
      liveStateIdentity: '1:2',
      backupStateIdentity: '1:3',
      backupSha256: 'a'.repeat(64)
    }
    const options = {
      serverPath,
      liveDatabasePath: state,
      backupPath: backup,
      rustDesktopConfigPath: join(directory, 'desktop.json'),
      sessionFilePath: join(directory, 'session.json'),
      remoteTransport: true,
      disposablePreview: true
    }
    const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
    const resumed = Object.create(NodeSidecar.prototype) as NodeSidecar
    const getRemoteTarget = vi.fn().mockResolvedValue({
      target: {
        remoteTargetId: targetId,
        label: 'Test',
        host: 'example.com',
        port: 22,
        user: 'alice',
        authentication: 'publicKey',
        hostKeyState: 'untrusted',
        knownHostsVersion: 1,
        revision: 2
      }
    })
    const startLive = vi.spyOn(NodeSidecar, 'startLive').mockResolvedValue(resumed)
    try {
      await chmod(directory, 0o700)
      for (const path of [state, backup, keyPath, serverPath]) {
        await writeFile(path, 'fixture', { mode: 0o600 })
      }
      for (const suffix of ['.writer-transfer.lock', '.live-owner.lock']) {
        await writeFile(`${state}${suffix}`, '', { mode: 0o600 })
      }
      await writeFile(
        join(directory, 'credential-enroll.mjs'),
        `import { fstatSync, readFileSync } from 'node:fs'
const request = JSON.parse(readFileSync(process.argv[3], 'utf8'))
if (process.argv[2] !== '--request-file' || request.version !== 5 ||
    request.liveStatePath !== ${JSON.stringify(state)} ||
    request.backupStatePath !== ${JSON.stringify(backup)} ||
    request.liveStateIdentity !== '1:2' || request.backupStateIdentity !== '1:3' ||
    request.backupSha256 !== '${'a'.repeat(64)}' ||
    request.targetId !== ${JSON.stringify(targetId)} ||
    request.enrollmentId !== ${JSON.stringify(request.enrollmentId)} ||
    request.expectedRevision !== 2 || !fstatSync(3).isFile()) process.exit(2)
process.stdout.write(JSON.stringify({ status: 'stored', targetId: request.targetId,
  enrollmentId: request.enrollmentId }))
`,
        { mode: 0o600 }
      )
      Object.assign(resumed, {
        child: { pid: 123 },
        ownerChannel: { close: vi.fn() },
        client: { getRemoteTarget },
        baseUrl: 'http://127.0.0.1:1234/',
        taskListEnabled: true,
        taskActionsEnabled: true,
        remoteReplacementEnabled: true,
        stop: vi.fn()
      })
      Object.assign(sidecar, {
        options,
        stopped: false,
        stop: vi.fn(() => {
          sidecar['stopped'] = true
          return Promise.resolve()
        })
      })
      const key = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await sidecar['replaceLiveRemoteCredential'](request, proof, key.fd)
      } finally {
        await key.close()
      }
      expect(startLive).toHaveBeenCalledWith(options, proof, request)
      expect(getRemoteTarget).toHaveBeenCalledWith(targetId)
      expect(sidecar.baseUrl).toBe('http://127.0.0.1:1234/')
      expect(sidecar['stopped']).toBe(false)
      expect((await readdir(directory)).some((entry) => entry.startsWith('.node-enroll-'))).toBe(
        false
      )
      startLive.mockRejectedValueOnce(new Error('ambiguous restart'))
      const retryKey = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await expect(
          sidecar['replaceLiveRemoteCredential'](request, proof, retryKey.fd)
        ).rejects.toThrow('ambiguous restart')
      } finally {
        await retryKey.close()
      }
      expect(sidecar['stopped']).toBe(true)
      sidecar['stopped'] = false
      await chmod(`${state}.live-owner.lock`, 0o644)
      const unsafeKey = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await expect(
          sidecar['replaceLiveRemoteCredential'](request, proof, unsafeKey.fd)
        ).rejects.toThrow('owner fence is unsafe')
      } finally {
        await unsafeKey.close()
      }
      expect(sidecar['stopped']).toBe(true)
      expect(startLive).toHaveBeenCalledTimes(2)
    } finally {
      startLive.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'linux')(
  'passes only explicit live ownership paths and fails closed when the child cannot start',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'node-sidecar-live-'))
    const stateDirectory = join(directory, 'state')
    const configDirectory = join(directory, 'configuration')
    const liveDatabasePath = join(stateDirectory, 'workspace.sqlite')
    const backupPath = join(directory, 'backup.sqlite')
    const rustDesktopConfigPath = join(configDirectory, 'desktop.json')
    const sessionFilePath = join(directory, 'session.json')
    const auditPath = join(directory, 'child-audit.json')
    const serverPath = join(directory, 'server.mjs')
    try {
      await mkdir(stateDirectory, { mode: 0o700 })
      await mkdir(configDirectory, { mode: 0o700 })
      await writeFile(liveDatabasePath, 'disposable fixture', { mode: 0o600 })
      await writeFile(rustDesktopConfigPath, '{}', { mode: 0o600 })
      await writeFile(
        serverPath,
        `import { writeFileSync } from 'node:fs'\n` +
          `const keys = ['AGENT_WORKSPACE_STATE_LIVE', 'AGENT_WORKSPACE_STATE_BACKUP', ` +
          `'AGENT_WORKSPACE_RUST_DESKTOP_CONFIG', 'AGENT_WORKSPACE_NODE_SESSION_FILE', ` +
          `'AGENT_WORKSPACE_STATE_SOURCE', 'AGENT_WORKSPACE_STATE_WORKING', ` +
          `'AGENT_WORKSPACE_STATE_RESUME', 'AGENT_WORKSPACE_LIVE_PREVIEW', ` +
          `'AGENT_WORKSPACE_WINDOW_OWNER_CHANNEL', 'AGENT_WORKSPACE_STATE_LIVE_RESUME', ` +
          `'AGENT_WORKSPACE_LIVE_STATE_IDENTITY', 'AGENT_WORKSPACE_LIVE_BACKUP_IDENTITY', ` +
          `'AGENT_WORKSPACE_LIVE_BACKUP_SHA256', 'AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID', ` +
          `'AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID', ` +
          `'AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION', ` +
          `'AGENT_WORKSPACE_LIVE_NEW_TARGET_ID', 'AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID']\n` +
          `writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]))))\n`,
        { mode: 0o600 }
      )
      const options = {
        serverPath,
        liveDatabasePath,
        backupPath,
        rustDesktopConfigPath,
        sessionFilePath
      }
      await expect(NodeSidecar.startLive({ ...options, disposablePreview: true })).rejects.toThrow(
        'disposable temporary profile'
      )
      await expect(NodeSidecar.startLive(options)).rejects.toThrow(
        'Node sidecar exited before readiness'
      )
      expect(JSON.parse(await readFile(auditPath, 'utf8'))).toEqual({
        AGENT_WORKSPACE_STATE_LIVE: liveDatabasePath,
        AGENT_WORKSPACE_STATE_BACKUP: backupPath,
        AGENT_WORKSPACE_RUST_DESKTOP_CONFIG: rustDesktopConfigPath,
        AGENT_WORKSPACE_NODE_SESSION_FILE: sessionFilePath,
        AGENT_WORKSPACE_STATE_SOURCE: null,
        AGENT_WORKSPACE_STATE_WORKING: null,
        AGENT_WORKSPACE_STATE_RESUME: null,
        AGENT_WORKSPACE_LIVE_PREVIEW: null,
        AGENT_WORKSPACE_WINDOW_OWNER_CHANNEL: '1',
        AGENT_WORKSPACE_STATE_LIVE_RESUME: null,
        AGENT_WORKSPACE_LIVE_STATE_IDENTITY: null,
        AGENT_WORKSPACE_LIVE_BACKUP_IDENTITY: null,
        AGENT_WORKSPACE_LIVE_BACKUP_SHA256: null,
        AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID: null,
        AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID: null,
        AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION: null,
        AGENT_WORKSPACE_LIVE_NEW_TARGET_ID: null,
        AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID: null
      })
      await expect(lstat(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(sessionFilePath)).rejects.toMatchObject({ code: 'ENOENT' })

      await writeFile(backupPath, 'existing', { mode: 0o600 })
      await expect(NodeSidecar.startLive(options)).rejects.toThrow('must not exist')
      const state = await lstat(liveDatabasePath)
      const backup = await lstat(backupPath)
      const proof = {
        liveStatePath: liveDatabasePath,
        backupStatePath: backupPath,
        liveStateIdentity: `${state.dev}:${state.ino}`,
        backupStateIdentity: `${backup.dev}:${backup.ino}`,
        backupSha256: createHash('sha256')
          .update(await readFile(backupPath))
          .digest('hex')
      }
      const replacement = {
        remoteTargetId: targetId,
        enrollmentId: randomUUID(),
        expectedRevision: 2
      }
      await expect(NodeSidecar.startLive(options, proof, replacement)).rejects.toThrow(
        'Node sidecar exited before readiness'
      )
      expect(JSON.parse(await readFile(auditPath, 'utf8'))).toMatchObject({
        AGENT_WORKSPACE_STATE_LIVE_RESUME: '1',
        AGENT_WORKSPACE_LIVE_STATE_IDENTITY: proof.liveStateIdentity,
        AGENT_WORKSPACE_LIVE_BACKUP_IDENTITY: proof.backupStateIdentity,
        AGENT_WORKSPACE_LIVE_BACKUP_SHA256: proof.backupSha256,
        AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID: targetId,
        AGENT_WORKSPACE_LIVE_REPLACEMENT_ENROLLMENT_ID: replacement.enrollmentId,
        AGENT_WORKSPACE_LIVE_REPLACEMENT_EXPECTED_REVISION: '2'
      })
      const newIntent = { targetId: randomUUID(), enrollmentId: randomUUID() }
      await expect(NodeSidecar.startLive(options, proof, undefined, newIntent)).rejects.toThrow(
        'Node sidecar exited before readiness'
      )
      expect(JSON.parse(await readFile(auditPath, 'utf8'))).toMatchObject({
        AGENT_WORKSPACE_STATE_LIVE_RESUME: '1',
        AGENT_WORKSPACE_LIVE_NEW_TARGET_ID: newIntent.targetId,
        AGENT_WORKSPACE_LIVE_NEW_ENROLLMENT_ID: newIntent.enrollmentId,
        AGENT_WORKSPACE_LIVE_REPLACEMENT_TARGET_ID: null
      })
      await rm(backupPath)
      await symlink(liveDatabasePath, join(stateDirectory, 'alias.sqlite'))
      await expect(
        NodeSidecar.startLive({
          ...options,
          liveDatabasePath: join(stateDirectory, 'alias.sqlite')
        })
      ).rejects.toThrow('private and owned')
      await chmod(stateDirectory, 0o755)
      await expect(NodeSidecar.startLive(options)).rejects.toThrow('private and owned')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'linux' || process.env.RUN_NODE_SIDECAR_LIVE !== '1')(
  'starts the built Node server on a disposable Rust-v15 live profile through the private owner channel',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-live-sidecar-'))
    const profile = join(directory, 'profile')
    const configuration = join(directory, 'rust-configuration')
    const backupDirectory = join(directory, 'backup')
    const state = join(profile, 'state.sqlite3')
    const backup = join(backupDirectory, 'state.sqlite3')
    const rustConfig = join(configuration, 'desktop.json')
    const session = join(directory, 'node-session.json')
    let sidecar: NodeSidecar | undefined
    try {
      for (const path of [profile, configuration, backupDirectory]) {
        await mkdir(path, { mode: 0o700 })
      }
      execFileSync(
        'cargo',
        [
          'run',
          '--quiet',
          '-p',
          'agent-workspace-storage',
          '--example',
          'create_schema_v15_fixture',
          '--',
          state,
          'remote-catalog-only'
        ],
        { cwd: repository, timeout: 300_000, stdio: 'pipe' }
      )
      await chmod(state, 0o600)
      const snapshot = JSON.parse(
        execFileSync(
          'sqlite3',
          [state, 'SELECT json_payload FROM application_snapshot WHERE singleton = 1'],
          { encoding: 'utf8', timeout: 10_000 }
        )
      )
      const configBytes = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          revision: 0,
          notifications: snapshot.notificationSettings,
          keyboardShortcuts: { overrides: snapshot.shortcutOverrides }
        })
      )
      await writeFile(rustConfig, configBytes, { mode: 0o600 })
      sidecar = await NodeSidecar.startLive({
        serverPath: join(repository, 'apps/server/dist/bin.mjs'),
        liveDatabasePath: state,
        backupPath: backup,
        rustDesktopConfigPath: rustConfig,
        sessionFilePath: session,
        disposablePreview: true
      })
      const proof = await sidecar.liveBackupProof()
      expect(proof.liveStatePath).toBe(state)
      expect(proof.backupStatePath).toBe(backup)
      expect(proof.liveStateIdentity).not.toBe(proof.backupStateIdentity)
      expect(proof.backupSha256).toBe(
        createHash('sha256')
          .update(await readFile(backup))
          .digest('hex')
      )
      expect((await sidecar.client.stateSnapshot()).snapshot.workspaces.length).toBeGreaterThan(0)
      expect((await sidecar.client.getConfiguration()).config).toMatchObject({
        revision: 0,
        notifications: snapshot.notificationSettings
      })
      expect(await readFile(join(profile, 'config.json'))).toEqual(configBytes)
      const stopped = sidecar
      await stopped.stop()
      sidecar = undefined
      await expect(stopped.client.identify()).rejects.toThrow()
      execFileSync('flock', ['-n', `${state}.live-owner.lock`, '-c', 'true'], { timeout: 5_000 })
      sidecar = await NodeSidecar.startLive(
        {
          serverPath: join(repository, 'apps/server/dist/bin.mjs'),
          liveDatabasePath: state,
          backupPath: backup,
          rustDesktopConfigPath: rustConfig,
          sessionFilePath: session,
          disposablePreview: true
        },
        proof
      )
      expect((await sidecar.liveBackupProof()).backupSha256).toBe(proof.backupSha256)
      expect((await sidecar.client.getConfiguration()).config.revision).toBe(0)
    } finally {
      await sidecar?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000
)

it('keeps the Node child alive until an active terminal attach completes during shutdown', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const terminalId = randomUUID()
  let finishAttach!: (value: unknown) => void
  const attach = vi.fn(() => new Promise<unknown>((resolve) => (finishAttach = resolve)))
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null
    signalCode: string | null
    kill: ReturnType<typeof vi.fn>
  }
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn(() => {
    child.emit('exit')
    return true
  })
  const close = vi.fn()
  Object.assign(sidecar, {
    client: { attach },
    child,
    ownerChannel: { close },
    remoteTerminals: new Map([[terminalId, { terminalId, windowId }]]),
    terminalSockets: new Map(),
    subscribeTerminal: vi.fn().mockResolvedValue(undefined)
  })

  const pending = sidecar.invokeDesktopCore(
    windowId,
    DESKTOP_IPC.terminalAttach,
    [terminalId],
    vi.fn()
  )
  await vi.waitFor(() => expect(attach).toHaveBeenCalledWith(terminalId))
  const stopping = sidecar.stop()
  await Promise.resolve()
  expect(child.kill).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()

  finishAttach({
    terminal: {
      id: terminalId,
      command: ['/bin/sh'],
      cwd: '/',
      rows: 24,
      cols: 80,
      processId: 1,
      exited: false
    },
    output: [],
    lastSequence: 0,
    reconstructionComplete: true
  })
  await expect(pending).resolves.toMatchObject({ handled: true })
  await stopping
  expect(close).toHaveBeenCalledOnce()
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
})

it('fences a remote terminal during transfer and rebinds its projected identity', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const source = randomUUID()
  const target = randomUUID()
  const projectedId = randomUUID()
  const actualId = randomUUID()
  const close = vi.fn()
  const send = vi.fn().mockResolvedValue(undefined)
  const resync = vi.fn()
  const remoteTerminals = new Map([
    [projectedId, { remoteSessionId: randomUUID(), terminalId: actualId, windowId: source }]
  ])
  const terminalSockets = new Map([
    [projectedId, { windowId: source, suspended: false, socket: { close }, resync }]
  ])
  Object.assign(sidecar, {
    client: { send },
    remoteTerminals,
    terminalSockets
  })
  const staged = sidecar.suspendRemoteTerminalEvents(source, projectedId)
  expect(terminalSockets.get(projectedId)?.suspended).toBe(true)
  await expect(
    sidecar.invokeDesktopCore(source, DESKTOP_IPC.terminalSend, [projectedId, 'blocked'], vi.fn())
  ).rejects.toThrow('unavailable in this window')
  staged.rollback()
  expect(resync).toHaveBeenCalledOnce()
  const committed = sidecar.suspendRemoteTerminalEvents(source, projectedId)
  committed.finalize(target)
  expect(close).toHaveBeenCalledOnce()
  expect(terminalSockets.has(projectedId)).toBe(false)
  expect(remoteTerminals.get(projectedId)?.windowId).toBe(target)
  await expect(
    sidecar.invokeDesktopCore(source, DESKTOP_IPC.terminalSend, [projectedId, 'blocked'], vi.fn())
  ).rejects.toThrow('unavailable in this window')
  await sidecar.invokeDesktopCore(target, DESKTOP_IPC.terminalSend, [projectedId, 'ready'], vi.fn())
  expect(send).toHaveBeenCalledWith(actualId, Buffer.from('ready'))
})

it('does not let an earlier remote binding lookup overwrite a transferred owner', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const source = randomUUID()
  const target = randomUUID()
  const projectedId = randomUUID()
  const remoteSessionId = randomUUID()
  let finishLookup!: (value: { terminalId: string }) => void
  const getRemoteTerminal = vi.fn(
    () => new Promise<{ terminalId: string }>((resolve) => (finishLookup = resolve))
  )
  const remoteTerminals = new Map<string, unknown>()
  Object.assign(sidecar, {
    client: { getRemoteTerminal },
    projectedTerminalId: vi.fn().mockResolvedValue(projectedId),
    remoteTerminals,
    terminalSockets: new Map()
  })
  const binding = (
    sidecar as unknown as {
      bindRemoteTerminal(
        windowId: string,
        session: { remoteSessionId: string; workspaceId: string; paneId: string; tabId: string },
        emit: (event: unknown) => void
      ): Promise<void>
    }
  ).bindRemoteTerminal(
    source,
    {
      remoteSessionId,
      workspaceId: randomUUID(),
      paneId: randomUUID(),
      tabId: randomUUID()
    },
    vi.fn()
  )
  await vi.waitFor(() => expect(getRemoteTerminal).toHaveBeenCalledOnce())
  sidecar.suspendRemoteTerminalEvents(source, projectedId).finalize(target)
  finishLookup({ terminalId: randomUUID() })
  await expect(binding).rejects.toThrow('binding changed during transfer')
  expect(remoteTerminals.get(projectedId)).toMatchObject({ windowId: target })
})

it('gates agent mutations on provider capabilities and fences their exact placements', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const binding = {
    workspaceId: randomUUID(),
    paneId: randomUUID(),
    tabId: randomUUID(),
    agentSessionId: randomUUID()
  }
  const destination = {
    workspaceId: randomUUID(),
    paneId: randomUUID(),
    tabId: randomUUID()
  }
  const session = {
    catalogVersion: 1,
    binding,
    adapterId: 'codex',
    adapterVersion: '0.142.4',
    title: 'agent',
    lifecycle: 'running',
    restore: { level: 'toolResume', assessedAtMs: 1, evidenceEpoch: 1 },
    revision: 7,
    attemptEpoch: 3,
    lastVerifiedAtMs: 1
  }
  const registerAgentSession = vi.fn().mockResolvedValue({ session })
  const restoreAgentSession = vi.fn().mockResolvedValue({ outcome: 'resumed', session })
  const forkAgentSession = vi.fn().mockResolvedValue({ session })
  const assertRemotePlacementOwner = vi.fn().mockResolvedValue(undefined)
  const replacedRestoreTerminalId = randomUUID()
  const replacedForkTerminalId = randomUUID()
  const projectedTerminalId = vi
    .fn()
    .mockResolvedValueOnce(replacedRestoreTerminalId)
    .mockResolvedValueOnce(replacedForkTerminalId)
  const detachTerminal = vi.fn()
  const checkpoint = vi.fn()
  const resize = vi.fn()
  Object.assign(sidecar, {
    stopped: false,
    agentRegistrationEnabled: false,
    agentForkEnabled: false,
    assertRemotePlacementOwner,
    projectedTerminalId,
    detachTerminal,
    client: {
      getAgentSession: vi.fn().mockResolvedValue({ session }),
      registerAgentSession,
      restoreAgentSession,
      forkAgentSession,
      checkpoint,
      resize
    }
  })
  const invoke = (channel: string, request: unknown) =>
    sidecar.invokeDesktopCore(windowId, channel, [request], vi.fn())
  const register = { ...binding, title: 'agent' }
  const action = { agentSessionId: binding.agentSessionId, expectedRevision: 7 }
  const fork = { ...action, ...destination, destinationKind: 'existingTerminal', title: 'fork' }

  await expect(invoke(DESKTOP_IPC.agentCatalogRegister, register)).rejects.toThrow(
    'isolated Codex profile'
  )
  await expect(invoke(DESKTOP_IPC.agentSessionRestore, action)).rejects.toThrow(
    'isolated Codex profile'
  )
  await expect(invoke(DESKTOP_IPC.agentSessionFork, fork)).rejects.toThrow('isolated Codex profile')
  expect(registerAgentSession).not.toHaveBeenCalled()
  expect(restoreAgentSession).not.toHaveBeenCalled()
  expect(forkAgentSession).not.toHaveBeenCalled()

  Object.assign(sidecar, {
    agentRegistrationEnabled: true,
    agentAdapterVersion: '0.156.1',
    agentForkEnabled: true
  })
  assertRemotePlacementOwner.mockRejectedValueOnce(
    new Error('The workspace is unavailable in this window')
  )
  await expect(invoke(DESKTOP_IPC.agentCatalogRegister, register)).rejects.toThrow(
    'The workspace is unavailable in this window'
  )
  expect(registerAgentSession).not.toHaveBeenCalled()
  await expect(
    invoke(DESKTOP_IPC.agentSessionRestore, { ...action, expectedRevision: 6 })
  ).rejects.toThrow('The agent session revision is stale')
  expect(restoreAgentSession).not.toHaveBeenCalled()
  await expect(invoke(DESKTOP_IPC.agentCatalogRegister, register)).resolves.toMatchObject({
    handled: true,
    value: { session }
  })
  await expect(invoke(DESKTOP_IPC.agentSessionRestore, action)).resolves.toMatchObject({
    handled: true,
    value: { outcome: 'resumed', session }
  })
  await expect(invoke(DESKTOP_IPC.agentSessionFork, fork)).resolves.toMatchObject({
    handled: true,
    value: { session }
  })
  expect(detachTerminal).toHaveBeenCalledWith(replacedRestoreTerminalId)
  expect(detachTerminal).toHaveBeenCalledWith(replacedForkTerminalId)
  const saved = { sequence: 0, rows: 24, cols: 80, activeBuffer: 'normal', data: '' }
  for (const id of [replacedRestoreTerminalId, replacedForkTerminalId]) {
    await expect(
      sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.terminalCheckpoint, [id, saved], vi.fn())
    ).resolves.toEqual({ handled: true })
    await expect(
      sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.terminalResize, [id, 24, 80], vi.fn())
    ).resolves.toEqual({ handled: true })
  }
  expect(checkpoint).not.toHaveBeenCalled()
  expect(resize).not.toHaveBeenCalled()
  expect(assertRemotePlacementOwner).toHaveBeenCalledWith(
    windowId,
    expect.objectContaining(binding)
  )
  expect(assertRemotePlacementOwner).toHaveBeenCalledWith(
    windowId,
    expect.objectContaining(destination)
  )
  expect(registerAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({ binding, adapterId: 'codex', adapterVersion: '0.156.1' })
  )
  expect(restoreAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: expect.objectContaining({ sessionRevision: 7, attemptEpoch: 3 })
    })
  )
  expect(forkAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({
      destination,
      operation: expect.objectContaining({ sessionRevision: 7, attemptEpoch: 3 })
    })
  )
})

it('fences Node hibernation mutations to the session workspace in the hosted window', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const workspaceId = randomUUID()
  const agentSessionId = randomUUID()
  const getAgentSession = vi.fn().mockResolvedValue({
    session: {
      catalogVersion: 1,
      binding: { workspaceId, paneId: randomUUID(), tabId: randomUUID(), agentSessionId },
      adapterId: 'codex',
      adapterVersion: '0.142.4',
      title: 'agent',
      lifecycle: 'running',
      restore: { level: 'toolResume', assessedAtMs: 1, evidenceEpoch: 1 },
      revision: 1,
      attemptEpoch: 1,
      lastVerifiedAtMs: 1
    }
  })
  const stateSnapshot = vi.fn().mockResolvedValue({
    snapshot: { windowPlacements: [{ id: windowId, workspaceIds: [] }] }
  })
  const preflightAgentHibernation = vi.fn()
  const confirmAgentHibernation = vi.fn()
  const cancelAgentHibernation = vi.fn().mockResolvedValue({ state: 'canceled' })
  Object.assign(sidecar, {
    stopped: false,
    agentHibernationEnabled: true,
    client: {
      getAgentSession,
      stateSnapshot,
      preflightAgentHibernation,
      confirmAgentHibernation,
      cancelAgentHibernation
    }
  })
  const client = sidecar.agentHibernationClientForTrustedOwner(windowId)
  const request = { agentSessionId } as Parameters<typeof client.preflightAgentHibernation>[0]
  await expect(client.preflightAgentHibernation(request)).rejects.toThrow(
    'The workspace is unavailable in this window'
  )
  await expect(
    client.confirmAgentHibernation(
      request as unknown as Parameters<typeof client.confirmAgentHibernation>[0]
    )
  ).rejects.toThrow('The workspace is unavailable in this window')
  expect(preflightAgentHibernation).not.toHaveBeenCalled()
  expect(confirmAgentHibernation).not.toHaveBeenCalled()
  await expect(client.cancelAgentHibernation(request)).resolves.toEqual({ state: 'canceled' })
  expect(cancelAgentHibernation).toHaveBeenCalledOnce()
})

it('returns empty runtime metadata only for a current sender during sidecar shutdown', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const workspaceId = randomUUID()
  const request = { workspaceId }
  let rejectRead!: (error: Error) => void
  Object.assign(sidecar, {
    stopped: false,
    listWorkspacesForTrustedOwner: vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRead = reject
        })
    )
  })
  const browser = { senderCurrent: () => true, shuttingDown: () => true } as never
  const pending = sidecar.invokeDesktopCore(
    randomUUID(),
    DESKTOP_IPC.workspaceRuntimeMetadata,
    [request],
    vi.fn(),
    browser
  )
  Object.assign(sidecar, { stopped: true })
  rejectRead(new Error('Node sidecar is stopped'))
  await expect(pending).resolves.toEqual({
    handled: true,
    value: { gitBranch: null, gitStatus: null, listeningPorts: [] }
  })
  await expect(
    sidecar.invokeDesktopCore(
      randomUUID(),
      DESKTOP_IPC.workspaceRuntimeMetadata,
      [request],
      vi.fn(),
      browser
    )
  ).resolves.toEqual({
    handled: true,
    value: { gitBranch: null, gitStatus: null, listeningPorts: [] }
  })
  await expect(
    sidecar.invokeDesktopCore(
      randomUUID(),
      DESKTOP_IPC.workspaceSnapshot,
      [request],
      vi.fn(),
      browser
    )
  ).rejects.toThrow('Node sidecar is stopped')
  await expect(
    sidecar.invokeDesktopCore(
      randomUUID(),
      DESKTOP_IPC.workspaceRuntimeMetadata,
      [request],
      vi.fn(),
      { senderCurrent: () => true, shuttingDown: () => false } as never
    )
  ).rejects.toThrow('Node sidecar is stopped')
  await expect(
    sidecar.invokeDesktopCore(
      randomUUID(),
      DESKTOP_IPC.workspaceRuntimeMetadata,
      [{}],
      vi.fn(),
      browser
    )
  ).rejects.toThrow()
  await expect(
    sidecar.invokeDesktopCore(
      randomUUID(),
      DESKTOP_IPC.workspaceRuntimeMetadata,
      [request],
      vi.fn(),
      {
        senderCurrent: () => false,
        shuttingDown: () => true
      } as never
    )
  ).rejects.toThrow('Node sidecar is stopped')
})

it('closes only an owned browser tab and destroys its native session after the Node commit', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const tabId = randomUUID()
  const browserSessionId = randomUUID()
  const closedItemId = randomUUID()
  const epoch = randomUUID()
  const params = {
    mutation: { expectedRevision: 9, idempotencyEpoch: epoch, idempotencyKey: randomUUID() },
    source: { windowId, workspaceId, paneId, tabId, expectedWindowRevision: 3 }
  }
  const topology = {
    revision: 9,
    idempotencyEpoch: epoch,
    windows: [{ windowId, revision: 3, workspaceIds: [workspaceId] }]
  }
  const snapshot = {
    workspaces: [
      {
        id: workspaceId,
        tabs: [
          {
            id: tabId,
            paneId,
            content: { kind: 'browser', state: { browserSessionId } }
          }
        ]
      }
    ]
  }
  const closeTab = vi.fn().mockResolvedValue({
    revision: 10,
    closedItemId,
    replayed: false
  })
  const destroySession = vi.fn()
  const browserDetached = vi.fn()
  Object.assign(sidecar, {
    listWindowsForTrustedOwner: vi.fn().mockResolvedValue(topology),
    listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({ snapshot })
  })
  sidecar.client = { closeTab } as unknown as NodeSidecar['client']

  await expect(
    sidecar.closeTabForTrustedOwner(
      windowId,
      params,
      { destroySession } as never,
      browserDetached,
      vi.fn()
    )
  ).resolves.toEqual({
    revision: 10,
    idempotencyEpoch: epoch,
    closedTabId: tabId,
    closedItemId,
    replayed: false
  })
  expect(closeTab).toHaveBeenCalledWith({ workspaceId, tabId, ...params.mutation })
  expect(destroySession).toHaveBeenCalledWith({ browserSessionId })
  expect(browserDetached).toHaveBeenCalledWith(browserSessionId)

  await expect(
    sidecar.closeTabForTrustedOwner(
      randomUUID(),
      params,
      { destroySession } as never,
      browserDetached,
      vi.fn()
    )
  ).rejects.toThrow('source window changed')
  expect(closeTab).toHaveBeenCalledOnce()
})

it('fences stale Node tab closes and retires the exact terminal attachment after commit', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const workspaceId = randomUUID()
  const paneId = randomUUID()
  const tabId = randomUUID()
  const terminalId = randomUUID()
  const epoch = randomUUID()
  const params = {
    mutation: { expectedRevision: 4, idempotencyEpoch: epoch, idempotencyKey: randomUUID() },
    source: { windowId, workspaceId, paneId, tabId, expectedWindowRevision: 2 }
  }
  const listWindowsForTrustedOwner = vi.fn().mockResolvedValue({
    revision: 5,
    idempotencyEpoch: epoch,
    windows: [{ windowId, revision: 2, workspaceIds: [workspaceId] }]
  })
  const listWorkspacesForTrustedOwner = vi.fn().mockResolvedValue({
    snapshot: {
      workspaces: [
        {
          id: workspaceId,
          tabs: [
            {
              id: tabId,
              paneId,
              content: { kind: 'terminal', runtimeSessionId: terminalId }
            }
          ]
        }
      ]
    }
  })
  const detachTerminal = vi.fn()
  const closeTab = vi.fn().mockResolvedValue({
    revision: 5,
    closedItemId: randomUUID(),
    replayed: false
  })
  Object.assign(sidecar, {
    listWindowsForTrustedOwner,
    listWorkspacesForTrustedOwner,
    detachTerminal
  })
  sidecar.client = { closeTab } as unknown as NodeSidecar['client']
  const terminalDetached = vi.fn()
  await expect(
    sidecar.closeTabForTrustedOwner(
      windowId,
      params,
      { destroySession: vi.fn() } as never,
      vi.fn(),
      terminalDetached
    )
  ).rejects.toThrow('topology changed')
  expect(closeTab).not.toHaveBeenCalled()

  listWindowsForTrustedOwner.mockResolvedValueOnce({
    revision: 4,
    idempotencyEpoch: epoch,
    windows: [{ windowId, revision: 2, workspaceIds: [workspaceId] }]
  })
  await sidecar.closeTabForTrustedOwner(
    windowId,
    params,
    { destroySession: vi.fn() } as never,
    vi.fn(),
    terminalDetached
  )
  expect(detachTerminal).toHaveBeenCalledWith(terminalId)
  expect(terminalDetached).toHaveBeenCalledWith(terminalId)
})

it('returns only the sender-bound projection after a Node mutation', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const workspace = projection.workspaces[0]!
  const tab = workspace.tabs[0]!
  const bound = { ...projection, revision: 2 }
  const listWorkspacesForTrustedOwner = vi.fn().mockResolvedValue({ snapshot: bound })
  Object.assign(sidecar, { listWorkspacesForTrustedOwner })
  const listWorkspaces = vi.fn().mockResolvedValue({
    snapshot: { ...bound, workspaces: [workspace, { ...workspace, id: randomUUID() }] }
  })
  sidecar.client = {
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
    listWorkspaces,
    selectTab: vi.fn().mockResolvedValue({ revision: 2 })
  } as unknown as NodeSidecar['client']

  const result = await sidecar.invokeDesktopCore(
    windowId,
    DESKTOP_IPC.tabSelect,
    [
      {
        workspaceId: workspace.id,
        tabId: tab.id
      }
    ],
    vi.fn()
  )
  expect(result).toMatchObject({
    handled: true,
    value: {
      snapshot: { workspaces: [{ id: workspace.id }] }
    }
  })
  expect(
    (result.value as { snapshot: { workspaces: unknown[] } }).snapshot.workspaces
  ).toHaveLength(1)
  expect(listWorkspacesForTrustedOwner).toHaveBeenCalledWith(windowId)
  expect(listWorkspaces).toHaveBeenCalledOnce()
})

it.each(['terminal', 'browser'] as const)(
  'updates an owned %s tab title without disturbing its native resource',
  async (kind) => {
    const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
    const windowId = randomUUID()
    const workspace = projection.workspaces[0]!
    const tab = workspace.tabs.find((item) => item.content.kind === kind)!
    const before = { ...projection, revision: 9 }
    const after = {
      ...before,
      revision: 10,
      workspaces: [
        {
          ...workspace,
          tabs: workspace.tabs.map((item) =>
            item.id === tab.id ? { ...item, title: 'Renamed', customTitle: 'Pinned' } : item
          )
        }
      ]
    }
    const updateTab = vi.fn().mockResolvedValue({ revision: 10 })
    const detachTerminal = vi.fn()
    const destroySession = vi.fn()
    const terminalDetached = vi.fn()
    const browserDetached = vi.fn()
    Object.assign(sidecar, {
      listWorkspacesForTrustedOwner: vi
        .fn()
        .mockResolvedValueOnce({ snapshot: before })
        .mockResolvedValueOnce({ snapshot: after }),
      detachTerminal
    })
    sidecar.client = {
      identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
      listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
      updateTab
    } as unknown as NodeSidecar['client']
    const browser = {
      views: () => ({ destroySession }),
      terminalDetached,
      browserDetached
    } as never
    const request = {
      workspaceId: workspace.id,
      tabId: tab.id,
      title: 'Renamed',
      customTitle: { value: 'Pinned' }
    }
    const result = await sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.tabUpdate,
      [request],
      vi.fn(),
      browser
    )
    expect(result).toMatchObject({
      handled: true,
      value: {
        snapshot: {
          revision: 10,
          workspaces: [
            {
              tabs: expect.arrayContaining([
                expect.objectContaining({ id: tab.id, title: 'Renamed', customTitle: 'Pinned' })
              ])
            }
          ]
        }
      }
    })
    expect(updateTab).toHaveBeenCalledWith(expect.objectContaining(request))
    expect(detachTerminal).not.toHaveBeenCalled()
    expect(destroySession).not.toHaveBeenCalled()
    expect(terminalDetached).not.toHaveBeenCalled()
    expect(browserDetached).not.toHaveBeenCalled()
  }
)

it('rejects a Node tab update outside the sender-bound workspace', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const updateTab = vi.fn()
  Object.assign(sidecar, {
    listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({
      snapshot: {
        ...projection,
        workspaces: []
      }
    })
  })
  sidecar.client = { updateTab } as unknown as NodeSidecar['client']
  await expect(
    sidecar.invokeDesktopCore(
      randomUUID(),
      DESKTOP_IPC.tabUpdate,
      [
        {
          workspaceId: projection.workspaces[0]!.id,
          tabId: projection.workspaces[0]!.tabs[0]!.id,
          customTitle: { value: 'Private' }
        }
      ],
      vi.fn()
    )
  ).rejects.toThrow('tab is unavailable in this window')
  expect(updateTab).not.toHaveBeenCalled()
})

it('splits an owned pane and reconciles the committed browser projection', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const workspace = projection.workspaces[0]!
  const before = { ...projection, revision: 9 }
  const after = { ...before, revision: 10 }
  const splitPane = vi.fn().mockResolvedValue({ revision: 10 })
  const reconcileAuthoritativeSnapshot = vi.fn()
  Object.assign(sidecar, {
    assertWorkspaceOwner: vi.fn().mockResolvedValue(undefined),
    listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({ snapshot: after })
  })
  sidecar.client = {
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
    splitPane
  } as unknown as NodeSidecar['client']
  const request = {
    workspaceId: workspace.id,
    targetPaneId: workspace.panes[0]!.id,
    axis: 'horizontal' as const,
    ratio: 0.5,
    placement: 'after' as const,
    content: { kind: 'existingTab' as const, tabId: workspace.tabs[0]!.id }
  }
  const result = await sidecar.invokeDesktopCore(
    windowId,
    DESKTOP_IPC.paneSplit,
    [request],
    vi.fn(),
    { views: () => ({ reconcileAuthoritativeSnapshot }) as never } as never
  )
  expect(result).toMatchObject({ handled: true, value: { snapshot: { revision: 10 } } })
  expect(splitPane).toHaveBeenCalledWith(expect.objectContaining(request))
  expect(reconcileAuthoritativeSnapshot).toHaveBeenCalledWith(after, false)
})

it('moves only a workspace owned by the calling Node window', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const workspaceId = projection.workspaces[0]!.id
  const before = { ...projection, revision: 9 }
  const after = { ...before, revision: 10 }
  const moveWorkspace = vi.fn().mockResolvedValue({ revision: 10 })
  const assertWorkspaceOwner = vi
    .fn()
    .mockRejectedValueOnce(new Error('unowned'))
    .mockResolvedValueOnce(undefined)
  const reconcileAuthoritativeSnapshot = vi.fn()
  Object.assign(sidecar, {
    assertWorkspaceOwner,
    listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({ snapshot: after })
  })
  sidecar.client = {
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
    moveWorkspace
  } as unknown as NodeSidecar['client']
  const request = { workspaceId, destinationIndex: 0 }
  const browser = { views: () => ({ reconcileAuthoritativeSnapshot }) } as never
  await expect(
    sidecar.invokeDesktopCore(
      'other-window',
      DESKTOP_IPC.workspaceMove,
      [request],
      vi.fn(),
      browser
    )
  ).rejects.toThrow('unowned')
  expect(moveWorkspace).not.toHaveBeenCalled()
  await expect(
    sidecar.invokeDesktopCore(
      'owned-window',
      DESKTOP_IPC.workspaceMove,
      [request],
      vi.fn(),
      browser
    )
  ).resolves.toMatchObject({ handled: true, value: { snapshot: { revision: 10 } } })
  expect(moveWorkspace).toHaveBeenCalledWith(expect.objectContaining(request))
  expect(reconcileAuthoritativeSnapshot).toHaveBeenCalledWith(after, false)
})

it('retires a closed Node workspace’s native resources only after commit', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const workspace = projection.workspaces[0]!
  const windowId = randomUUID()
  const before = { ...projection, revision: 9 }
  const after = { ...before, revision: 10 }
  const closeWorkspace = vi
    .fn()
    .mockRejectedValueOnce(new Error('commit failed'))
    .mockResolvedValueOnce({ revision: 10 })
  const detachTerminal = vi.fn()
  const rememberClosedTerminal = vi.fn()
  const destroySession = vi.fn()
  const terminalDetached = vi.fn()
  const browserDetached = vi.fn()
  const reconcileAuthoritativeSnapshot = vi.fn()
  Object.assign(sidecar, {
    assertWorkspaceOwner: vi.fn().mockResolvedValue(undefined),
    listWorkspacesForTrustedOwner: vi
      .fn()
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: after }),
    detachTerminal,
    rememberClosedTerminal
  })
  sidecar.client = {
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
    closeWorkspace
  } as unknown as NodeSidecar['client']
  const browser = {
    views: () => ({ destroySession, reconcileAuthoritativeSnapshot }),
    terminalDetached,
    browserDetached
  } as never
  const request = { workspaceId: workspace.id }
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.workspaceClose, [request], vi.fn(), browser)
  ).rejects.toThrow('commit failed')
  expect(detachTerminal).not.toHaveBeenCalled()
  expect(destroySession).not.toHaveBeenCalled()
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.workspaceClose, [request], vi.fn(), browser)
  ).resolves.toMatchObject({ handled: true, value: { snapshot: { revision: 10 } } })
  expect(closeWorkspace).toHaveBeenCalledWith(expect.objectContaining(request))
  const liveTerminalCount = workspace.tabs.filter(
    (tab) => tab.content.kind === 'terminal' && tab.content.runtimeSessionId
  ).length
  expect(detachTerminal).toHaveBeenCalledTimes(liveTerminalCount)
  expect(rememberClosedTerminal).toHaveBeenCalledTimes(liveTerminalCount)
  expect(destroySession).toHaveBeenCalledOnce()
  expect(terminalDetached).toHaveBeenCalledTimes(liveTerminalCount)
  expect(browserDetached).toHaveBeenCalledOnce()
  expect(reconcileAuthoritativeSnapshot).toHaveBeenCalledWith(after, false)
})

it('retires resources removed by a committed pane close, and leaves them on failure', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const workspace = projection.workspaces[0]!
  const pane = workspace.panes[0]!
  const before = { ...projection, revision: 4 }
  const after = {
    ...before,
    revision: 5,
    workspaces: [
      {
        ...workspace,
        panes: workspace.panes.filter((item) => item.id !== pane.id),
        tabs: workspace.tabs.filter((tab) => !pane.tabIds.includes(tab.id)),
        selectedPaneId: workspace.panes[1]!.id,
        layout: { kind: 'leaf', paneId: workspace.panes[1]!.id }
      }
    ]
  }
  const closePane = vi
    .fn()
    .mockRejectedValueOnce(new Error('commit failed'))
    .mockResolvedValueOnce({ revision: 5 })
  const detachTerminal = vi.fn()
  const destroySession = vi.fn()
  const terminalDetached = vi.fn()
  const browserDetached = vi.fn()
  const reconcileAuthoritativeSnapshot = vi.fn()
  const assertTerminalOwner = vi.fn().mockRejectedValue(new Error('not owned'))
  const checkpoint = vi.fn()
  Object.assign(sidecar, {
    listWorkspacesForTrustedOwner: vi
      .fn()
      .mockResolvedValue({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: after }),
    detachTerminal,
    assertTerminalOwner
  })
  sidecar.client = {
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
    closePane,
    checkpoint
  } as unknown as NodeSidecar['client']
  const browser = {
    views: () => ({ destroySession, reconcileAuthoritativeSnapshot }),
    terminalDetached,
    browserDetached
  } as never
  const request = { workspaceId: workspace.id, paneId: pane.id }
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.paneClose, [request], vi.fn(), browser)
  ).rejects.toThrow('commit failed')
  expect(detachTerminal).not.toHaveBeenCalled()
  expect(destroySession).not.toHaveBeenCalled()

  await sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.paneClose, [request], vi.fn(), browser)
  for (const tab of workspace.tabs.filter((item) => pane.tabIds.includes(item.id))) {
    if (tab.content.kind === 'terminal' && tab.content.runtimeSessionId) {
      expect(detachTerminal).toHaveBeenCalledWith(tab.content.runtimeSessionId)
      expect(terminalDetached).toHaveBeenCalledWith(tab.content.runtimeSessionId)
    } else if (tab.content.kind === 'browser') {
      expect(destroySession).toHaveBeenCalledWith({
        browserSessionId: tab.content.state!.browserSessionId
      })
      expect(browserDetached).toHaveBeenCalledWith(tab.content.state!.browserSessionId)
    }
  }
  expect(reconcileAuthoritativeSnapshot).toHaveBeenCalledWith(after, false)
  const closedTerminal = workspace.tabs.find(
    (tab) => pane.tabIds.includes(tab.id) && tab.content.kind === 'terminal'
  )
  if (closedTerminal?.content.kind !== 'terminal' || !closedTerminal.content.runtimeSessionId) {
    throw new Error('Pane fixture has no terminal')
  }
  const terminalId = closedTerminal.content.runtimeSessionId
  const saved = { sequence: 0, rows: 24, cols: 80, activeBuffer: 'normal', data: '' }
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.terminalCheckpoint,
      [terminalId, saved],
      vi.fn()
    )
  ).resolves.toEqual({ handled: true })
  await expect(
    sidecar.invokeDesktopCore(
      randomUUID(),
      DESKTOP_IPC.terminalCheckpoint,
      [terminalId, saved],
      vi.fn()
    )
  ).rejects.toThrow('not owned')
  expect(checkpoint).not.toHaveBeenCalled()
})

it('destroys the closed pane browser view only after the Node commit', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const workspace = projection.workspaces[0]!
  const pane = workspace.panes[1]!
  const browserTab = workspace.tabs.find((tab) => pane.tabIds.includes(tab.id))!
  if (browserTab.content.kind !== 'browser' || !browserTab.content.state) {
    throw new Error('Browser fixture is missing')
  }
  const before = { ...projection, revision: 4 }
  const after = {
    ...before,
    revision: 5,
    workspaces: [
      {
        ...workspace,
        panes: workspace.panes.filter((item) => item.id !== pane.id),
        tabs: workspace.tabs.filter((tab) => !pane.tabIds.includes(tab.id)),
        selectedPaneId: workspace.panes[0]!.id,
        layout: { kind: 'leaf', paneId: workspace.panes[0]!.id }
      }
    ]
  }
  const destroySession = vi.fn()
  const browserDetached = vi.fn()
  Object.assign(sidecar, {
    listWorkspacesForTrustedOwner: vi
      .fn()
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: after })
  })
  sidecar.client = {
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
    closePane: vi.fn().mockResolvedValue({ revision: 5 })
  } as unknown as NodeSidecar['client']
  await sidecar.invokeDesktopCore(
    'owned-window',
    DESKTOP_IPC.paneClose,
    [{ workspaceId: workspace.id, paneId: pane.id }],
    vi.fn(),
    {
      views: () => ({ destroySession, reconcileAuthoritativeSnapshot: vi.fn() }),
      browserDetached
    } as never
  )
  expect(destroySession).toHaveBeenCalledWith({
    browserSessionId: browserTab.content.state.browserSessionId
  })
  expect(browserDetached).toHaveBeenCalledWith(browserTab.content.state.browserSessionId)
})

it.each([DESKTOP_IPC.paneMoveTab, DESKTOP_IPC.tabMove])(
  'moves an owned tab through %s and rejects an unowned workspace',
  async (channel) => {
    const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
    const workspace = projection.workspaces[0]!
    const before = { ...projection, revision: 7 }
    const after = { ...before, revision: 8 }
    const moveTab = vi.fn().mockResolvedValue({ revision: 8 })
    const assertWorkspaceOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error('unowned'))
      .mockResolvedValueOnce(undefined)
    const reconcileAuthoritativeSnapshot = vi.fn()
    Object.assign(sidecar, {
      assertWorkspaceOwner,
      listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({ snapshot: after })
    })
    sidecar.client = {
      identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
      listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
      moveTab
    } as unknown as NodeSidecar['client']
    const request = {
      workspaceId: workspace.id,
      tabId: workspace.tabs[0]!.id,
      destinationPaneId: workspace.panes[0]!.id,
      destinationIndex: 0
    }
    const browser = { views: () => ({ reconcileAuthoritativeSnapshot }) } as never
    await expect(
      sidecar.invokeDesktopCore('other-window', channel, [request], vi.fn(), browser)
    ).rejects.toThrow('unowned')
    expect(moveTab).not.toHaveBeenCalled()
    await sidecar.invokeDesktopCore('owned-window', channel, [request], vi.fn(), browser)
    expect(moveTab).toHaveBeenCalledWith(expect.objectContaining(request))
    expect(reconcileAuthoritativeSnapshot).toHaveBeenCalledWith(after, false)
  }
)

it('routes saved-layout reads and mutations through the sole hosted Node window', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const workspace = projection.workspaces[0]!
  const layoutId = randomUUID()
  const epoch = randomUUID()
  const snapshot = { ...projection, revision: 9 }
  const paneId = randomUUID()
  const tabId = randomUUID()
  const layout = {
    id: layoutId,
    name: 'Focused',
    formatVersion: 1,
    createdAt: 1,
    updatedAt: 2,
    template: {
      workspaces: [
        {
          id: workspace.id,
          name: workspace.name,
          description: workspace.description,
          color: workspace.color,
          workingDirectory: workspace.workingDirectory,
          layout: { kind: 'leaf', paneId },
          selectedPaneId: paneId,
          panes: { [paneId]: { id: paneId, tabs: [tabId], selectedTabId: tabId, title: null } },
          tabs: {
            [tabId]: {
              id: tabId,
              paneId,
              title: 'Shell',
              customTitle: null,
              content: {
                kind: 'terminal',
                launch: { cwd: workspace.workingDirectory, rows: 24, cols: 80 }
              },
              createdAt: 1
            }
          },
          createdAt: 1,
          updatedAt: 2
        }
      ]
    }
  }
  const saveLayout = vi.fn().mockResolvedValue({ revision: 10, replayed: false })
  const deleteLayout = vi.fn().mockResolvedValue({ revision: 11, replayed: false })
  const listWindowsForTrustedOwner = vi.fn().mockResolvedValue({
    windows: [{ windowId, workspaceIds: [workspace.id] }]
  })
  Object.assign(sidecar, {
    listWindowsForTrustedOwner,
    listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({ snapshot })
  })
  sidecar.client = {
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: epoch }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot }),
    listLayouts: vi.fn().mockResolvedValue({ revision: 9, layouts: [] }),
    getLayout: vi.fn().mockResolvedValue({ revision: 9, layout }),
    saveLayout,
    deleteLayout
  } as unknown as NodeSidecar['client']

  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutList, [], vi.fn())
  ).resolves.toEqual({ handled: true, value: { revision: 9, layouts: [] } })
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutGet, [{ layoutId }], vi.fn())
  ).resolves.toMatchObject({
    handled: true,
    value: { layout: { id: layoutId, name: 'Focused' } }
  })
  const save = {
    layoutId,
    name: 'Focused',
    workspaceIds: [workspace.id],
    expectedRevision: 9,
    idempotencyKey: randomUUID()
  }
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutSave, [save], vi.fn())
  ).resolves.toEqual({ handled: true, value: { revision: 10 } })
  expect(saveLayout).toHaveBeenCalledWith({ ...save, idempotencyEpoch: epoch })
  const remove = { layoutId, expectedRevision: 10, idempotencyKey: randomUUID() }
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutDelete, [remove], vi.fn())
  ).resolves.toEqual({ handled: true, value: { revision: 11 } })
  expect(deleteLayout).toHaveBeenCalledWith({ ...remove, idempotencyEpoch: epoch })

  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.layoutSave,
      [{ ...save, workspaceIds: [randomUUID()] }],
      vi.fn()
    )
  ).rejects.toThrow('workspace unavailable in this window')
  expect(saveLayout).toHaveBeenCalledOnce()
  listWindowsForTrustedOwner.mockResolvedValue({
    windows: [{ windowId }, { windowId: randomUUID() }]
  })
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutDelete, [remove], vi.fn())
  ).rejects.toThrow('sole hosted window')
  expect(deleteLayout).toHaveBeenCalledOnce()
})

it('reads and saves sidebar placement for the bound window with the Rust width clamp', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const order = [
    'textBox',
    'vault',
    'taskManager',
    'files',
    'markdown',
    'diff',
    'search',
    'recentlyClosed'
  ] as const
  const current = {
    windowId,
    revision: 2,
    side: 'left',
    width: 320,
    enabled: [...order],
    order: [...order],
    selected: 'textBox'
  }
  const getSidebarPlacement = vi.fn().mockResolvedValue(current)
  const saveSidebarPlacement = vi.fn().mockImplementation(async ({ placement }) => placement)
  Object.assign(sidecar, {
    listWindowsForTrustedOwner: vi.fn().mockResolvedValue({ windows: [{ windowId }] })
  })
  sidecar.client = { getSidebarPlacement, saveSidebarPlacement } as unknown as NodeSidecar['client']
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.sidebarPlacementGet, [], vi.fn())
  ).resolves.toEqual({ handled: true, value: current })

  const result = await sidecar.invokeDesktopCore(
    windowId,
    DESKTOP_IPC.sidebarPlacementSave,
    [{ selected: 'files', width: 720, expectedRevision: 2 }],
    vi.fn(),
    { contentWidth: () => 800 } as never
  )
  expect(result).toMatchObject({
    handled: true,
    value: {
      windowId,
      revision: 3,
      side: 'right',
      width: 360,
      selected: 'files'
    }
  })
  expect(saveSidebarPlacement).toHaveBeenCalledWith({
    placement: expect.objectContaining({ windowId, revision: 3, width: 360 }),
    mutation: expect.objectContaining({ expectedRevision: 2, requestHash: expect.any(String) })
  })
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.sidebarPlacementSave,
      [{ selected: 'files', width: 400, expectedRevision: 1 }],
      vi.fn(),
      { contentWidth: () => 800 } as never
    )
  ).rejects.toThrow('changed; reload')
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.sidebarPlacementSave,
      [{ selected: 'files', width: 400, expectedRevision: 2 }],
      vi.fn()
    )
  ).rejects.toThrow('window bounds are unavailable')
  expect(saveSidebarPlacement).toHaveBeenCalledOnce()
})

it('lists Recently Closed through the sender capability and reopens into the exact pane', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const epoch = randomUUID()
  const workspace = projection.workspaces[0]!
  const pane = workspace.panes[0]!
  const closedId = randomUUID()
  const descriptorId = randomUUID()
  const reopenedTabId = randomUUID()
  const reopenedTerminalId = randomUUID()
  const record = {
    recentlyClosedId: closedId,
    authorizedDescriptorId: descriptorId,
    action: 'reopenTerminal' as const,
    label: 'Recovered shell',
    closedAtMs: 1000,
    revision: 9
  }
  const before = { ...projection, revision: 9 }
  const after = {
    ...projection,
    revision: 10,
    workspaces: [
      {
        ...workspace,
        panes: workspace.panes.map((entry) =>
          entry.id === pane.id
            ? { ...entry, tabIds: [...entry.tabIds, reopenedTabId], selectedTabId: reopenedTabId }
            : entry
        ),
        tabs: [
          ...workspace.tabs,
          {
            ...workspace.tabs[0]!,
            id: reopenedTabId,
            title: 'Recovered shell',
            content: {
              ...workspace.tabs[0]!.content,
              kind: 'terminal' as const,
              runtimeSessionId: reopenedTerminalId
            }
          }
        ]
      }
    ]
  }
  const listRecentlyClosedSidebarBound = vi.fn().mockResolvedValue({
    records: [record],
    nextCursor: null
  })
  const reopenRecentlyClosedSidebarBound = vi.fn().mockResolvedValue({
    revision: 10,
    idempotencyEpoch: epoch,
    tabId: reopenedTabId,
    ownershipKind: 'terminal',
    placement: {
      windowId,
      workspaceId: workspace.id,
      paneId: pane.id,
      index: pane.tabIds.length,
      windowRevision: 4
    },
    transferEpoch: 10,
    replayed: false
  })
  const emitDomainEvent = vi.fn()
  const reconcileAuthoritativeSnapshot = vi.fn()
  const reconcileRendererOwnership = vi.fn()
  Object.assign(sidecar, {
    withWindowCapability: vi.fn((_: string, read: (capability: string) => Promise<unknown>) =>
      read('a'.repeat(43))
    ),
    listWindowsForTrustedOwner: vi.fn().mockResolvedValue({
      revision: 9,
      idempotencyEpoch: epoch,
      windows: [{ windowId, revision: 3, workspaceIds: [workspace.id] }]
    }),
    listWorkspacesForTrustedOwner: vi
      .fn()
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: after })
  })
  sidecar.client = {
    listRecentlyClosedSidebarBound,
    reopenRecentlyClosedSidebarBound
  } as unknown as NodeSidecar['client']
  const browser = {
    isCurrent: () => true,
    views: () => ({ reconcileAuthoritativeSnapshot }),
    reconcileRendererOwnership,
    emitDomainEvent
  } as never

  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.recentlyClosedList, [], vi.fn(), browser)
  ).resolves.toEqual({ handled: true, value: { records: [record], nextCursor: null } })
  expect(listRecentlyClosedSidebarBound).toHaveBeenCalledWith({ limit: 100 }, 'a'.repeat(43))
  const request = {
    record: {
      recentlyClosedId: closedId,
      authorizedDescriptorId: descriptorId,
      action: 'reopenTerminal',
      expectedRevision: 9
    },
    workspaceId: workspace.id,
    paneId: pane.id
  }
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.recentlyClosedReopen,
      [request],
      vi.fn(),
      browser
    )
  ).resolves.toMatchObject({ handled: true, value: { tabId: reopenedTabId, revision: 10 } })
  expect(reopenRecentlyClosedSidebarBound).toHaveBeenCalledWith(
    {
      recentlyClosedId: closedId,
      authorizedDescriptorId: descriptorId,
      action: 'reopenTerminal',
      expectedRevision: 9,
      idempotencyEpoch: epoch,
      target: {
        windowId,
        workspaceId: workspace.id,
        paneId: pane.id,
        destinationIndex: pane.tabIds.length,
        expectedWindowRevision: 3
      },
      mutation: expect.objectContaining({ expectedRevision: 9, requestHash: expect.any(String) })
    },
    'a'.repeat(43)
  )
  expect(reconcileAuthoritativeSnapshot).toHaveBeenCalledWith(after, false)
  expect(reconcileRendererOwnership).toHaveBeenCalledOnce()
  expect(reconcileRendererOwnership.mock.calls[0]![0]).toContain(reopenedTerminalId)
  expect(emitDomainEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'workspace.changed',
      revision: 10,
      data: expect.objectContaining({ reason: 'recentlyClosed.reopen' })
    })
  )
})

it('retries a lost Recently Closed response with the original mutation', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const epoch = randomUUID()
  const workspace = projection.workspaces[0]!
  const pane = workspace.panes[0]!
  const reopenedTabId = randomUUID()
  const terminalId = randomUUID()
  const request = {
    record: {
      recentlyClosedId: randomUUID(),
      authorizedDescriptorId: randomUUID(),
      action: 'reopenTerminal' as const,
      expectedRevision: 9
    },
    workspaceId: workspace.id,
    paneId: pane.id
  }
  const after = {
    ...projection,
    revision: 10,
    workspaces: [
      {
        ...workspace,
        panes: workspace.panes.map((entry) =>
          entry.id === pane.id ? { ...entry, tabIds: [...entry.tabIds, reopenedTabId] } : entry
        ),
        tabs: [
          ...workspace.tabs,
          {
            ...workspace.tabs[0]!,
            id: reopenedTabId,
            content: {
              ...workspace.tabs[0]!.content,
              kind: 'terminal' as const,
              runtimeSessionId: terminalId
            }
          }
        ]
      }
    ]
  }
  const reopenRecentlyClosedSidebarBound = vi
    .fn()
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce({
      revision: 10,
      idempotencyEpoch: epoch,
      tabId: reopenedTabId,
      ownershipKind: 'terminal',
      placement: {
        windowId,
        workspaceId: workspace.id,
        paneId: pane.id,
        index: pane.tabIds.length,
        windowRevision: 4
      },
      transferEpoch: 10,
      replayed: true
    })
  const listWindowsForTrustedOwner = vi.fn().mockResolvedValue({
    revision: 9,
    idempotencyEpoch: epoch,
    windows: [{ windowId, revision: 3, workspaceIds: [workspace.id] }]
  })
  Object.assign(sidecar, {
    withWindowCapability: vi.fn((_: string, read: (capability: string) => Promise<unknown>) =>
      read('a'.repeat(43))
    ),
    listWindowsForTrustedOwner,
    listWorkspacesForTrustedOwner: vi
      .fn()
      .mockResolvedValueOnce({ snapshot: { ...projection, revision: 9 } })
      .mockResolvedValueOnce({ snapshot: after })
      .mockResolvedValueOnce({ snapshot: after })
  })
  sidecar.client = { reopenRecentlyClosedSidebarBound } as unknown as NodeSidecar['client']
  const browser = {
    isCurrent: () => true,
    views: () => ({ reconcileAuthoritativeSnapshot: vi.fn() }),
    reconcileRendererOwnership: vi.fn(),
    emitDomainEvent: vi.fn()
  } as never
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.recentlyClosedReopen,
      [request],
      vi.fn(),
      browser
    )
  ).rejects.toThrow('response lost')
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.recentlyClosedReopen,
      [{ ...request, paneId: workspace.panes[1]!.id }],
      vi.fn(),
      browser
    )
  ).rejects.toThrow('destination is no longer available')
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.recentlyClosedReopen,
      [request],
      vi.fn(),
      browser
    )
  ).resolves.toMatchObject({ handled: true, value: { replayed: true, tabId: reopenedTabId } })
  expect(reopenRecentlyClosedSidebarBound).toHaveBeenCalledTimes(2)
  expect(reopenRecentlyClosedSidebarBound.mock.calls[1]![0]).toEqual(
    reopenRecentlyClosedSidebarBound.mock.calls[0]![0]
  )
  expect(listWindowsForTrustedOwner).toHaveBeenCalledTimes(2)
})

it('creates the Rust default sidebar in the Node copy and rejects a stale sender', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const saveSidebarPlacement = vi.fn().mockImplementation(async ({ placement }) => placement)
  const listWindowsForTrustedOwner = vi.fn().mockResolvedValue({ windows: [{ windowId }] })
  Object.assign(sidecar, { listWindowsForTrustedOwner })
  sidecar.client = {
    getSidebarPlacement: vi
      .fn()
      .mockRejectedValue(new ServerError(404, 'not_found', 'Sidebar placement not found')),
    saveSidebarPlacement
  } as unknown as NodeSidecar['client']
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.sidebarPlacementGet, [], vi.fn())
  ).resolves.toMatchObject({
    handled: true,
    value: {
      windowId,
      revision: 1,
      side: 'right',
      width: 320,
      selected: 'textBox'
    }
  })
  expect(saveSidebarPlacement).toHaveBeenCalledWith({
    placement: expect.objectContaining({ windowId, revision: 1 }),
    mutation: expect.objectContaining({ expectedRevision: 0 })
  })

  listWindowsForTrustedOwner.mockRejectedValueOnce(new Error('binding changed'))
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.sidebarPlacementSave,
      [{ selected: 'files', width: 300, expectedRevision: 1 }],
      vi.fn(),
      { contentWidth: () => 800 } as never
    )
  ).rejects.toThrow('binding changed')
  expect(saveSidebarPlacement).toHaveBeenCalledOnce()
})

it('applies a layout to the authenticated window and retires only replaced native resources', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const epoch = randomUUID()
  const old = projection.workspaces[0]!
  const oldTerminal = old.tabs.find(
    (tab) => tab.content.kind === 'terminal' && tab.content.runtimeSessionId
  )!
  const oldBrowser = old.tabs.find((tab) => tab.content.kind === 'browser')!
  if (
    oldTerminal.content.kind !== 'terminal' ||
    !oldTerminal.content.runtimeSessionId ||
    oldBrowser.content.kind !== 'browser'
  ) {
    throw new Error('Layout fixture lacks native resources')
  }
  const newTerminalId = randomUUID()
  const newBrowserId = randomUUID()
  const before = { ...projection, revision: 9 }
  const after = {
    ...before,
    revision: 10,
    workspaces: [
      {
        ...old,
        tabs: old.tabs.map((tab) =>
          tab.id === oldTerminal.id
            ? {
                ...tab,
                content: { ...tab.content, runtimeSessionId: newTerminalId }
              }
            : tab.id === oldBrowser.id && tab.content.kind === 'browser'
              ? {
                  ...tab,
                  content: {
                    ...tab.content,
                    state: {
                      ...tab.content.state,
                      browserSessionId: newBrowserId
                    }
                  }
                }
              : tab
        )
      }
    ]
  }
  const applyLayout = vi.fn().mockResolvedValue({ revision: 10, replayed: false })
  const detachTerminal = vi.fn()
  const rememberClosedTerminal = vi.fn()
  const destroySession = vi.fn()
  const reconcileAuthoritativeSnapshot = vi.fn()
  const browserDetached = vi.fn()
  const terminalDetached = vi.fn()
  const emitDomainEvent = vi.fn()
  const reconcileRendererOwnership = vi.fn()
  Object.assign(sidecar, {
    listWindowsForTrustedOwner: vi.fn().mockResolvedValue({
      windows: [{ windowId, revision: 3, hostingState: 'hosted', workspaceIds: [old.id] }]
    }),
    listWorkspacesForTrustedOwner: vi
      .fn()
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: after }),
    detachTerminal,
    rememberClosedTerminal
  })
  sidecar.client = {
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
    listRemoteSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    listAgentCatalog: vi.fn().mockResolvedValue({
      catalogVersion: 1,
      revision: 0,
      sessions: [],
      teams: [],
      attention: []
    }),
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: epoch }),
    applyLayout
  } as unknown as NodeSidecar['client']
  const request = { layoutId: randomUUID(), expectedRevision: 9, idempotencyKey: randomUUID() }
  const browser = {
    isCurrent: () => true,
    automationActive: () => false,
    attachedTerminalIds: () => [],
    views: () => ({ destroySession, reconcileAuthoritativeSnapshot }),
    emitDomainEvent,
    reconcileRendererOwnership,
    browserDetached,
    terminalDetached
  } as never
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).resolves.toEqual({ handled: true, value: { revision: 10 } })
  expect(applyLayout).toHaveBeenCalledWith({
    ...request,
    targetWindowId: windowId,
    expectedWindowRevision: 3,
    idempotencyEpoch: epoch
  })
  expect(detachTerminal).toHaveBeenCalledWith(oldTerminal.content.runtimeSessionId)
  expect(detachTerminal).toHaveBeenCalledTimes(1)
  expect(rememberClosedTerminal).toHaveBeenCalledWith(
    windowId,
    oldTerminal.content.runtimeSessionId
  )
  expect(terminalDetached).toHaveBeenCalledWith(oldTerminal.content.runtimeSessionId)
  expect(destroySession).toHaveBeenCalledWith({
    browserSessionId: oldBrowser.content.state!.browserSessionId
  })
  expect(destroySession).toHaveBeenCalledTimes(1)
  expect(browserDetached).toHaveBeenCalledWith(oldBrowser.content.state!.browserSessionId)
  expect(reconcileAuthoritativeSnapshot).toHaveBeenCalledWith(after, false)
  expect(reconcileRendererOwnership).toHaveBeenCalledWith(new Set([newTerminalId, newBrowserId]))
  expect(emitDomainEvent).toHaveBeenCalledWith({
    event: 'workspace.changed',
    revision: 10,
    data: {
      revision: 10,
      workspaceIds: after.workspaces.map(({ id }) => id),
      paneIds: after.workspaces.flatMap(({ panes }) => panes.map(({ id }) => id)),
      tabIds: after.workspaces.flatMap(({ tabs }) => tabs.map(({ id }) => id)),
      commandIds: [],
      reason: 'layout.apply'
    }
  })
  expect(reconcileAuthoritativeSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
    emitDomainEvent.mock.invocationCallOrder[0]!
  )

  vi.mocked(sidecar.listWorkspacesForTrustedOwner)
    .mockResolvedValueOnce({ snapshot: before } as never)
    .mockResolvedValueOnce({ snapshot: { ...after, revision: 11 } } as never)
  detachTerminal.mockClear()
  destroySession.mockClear()
  reconcileAuthoritativeSnapshot.mockClear()
  reconcileRendererOwnership.mockClear()
  emitDomainEvent.mockClear()
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).rejects.toThrow('projection revision changed')
  expect(detachTerminal).not.toHaveBeenCalled()
  expect(destroySession).not.toHaveBeenCalled()
  expect(reconcileAuthoritativeSnapshot).not.toHaveBeenCalled()
  expect(reconcileRendererOwnership).not.toHaveBeenCalled()
  expect(emitDomainEvent).not.toHaveBeenCalled()
})

it('recovers committed layout cleanup on replay despite newly active resources', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const before = { ...projection, revision: 9 }
  const applyLayout = vi
    .fn()
    .mockResolvedValueOnce({ revision: 10, replayed: false })
    .mockResolvedValue({ revision: 10, replayed: true })
  const staleTerminalId = randomUUID()
  const sockets = new Map<string, { windowId: string }>([[staleTerminalId, { windowId }]])
  const attachments = new Set<string>([staleTerminalId])
  const detachTerminal = vi.fn((id: string) => {
    sockets.delete(id)
  })
  const rememberClosedTerminal = vi.fn()
  const reconcileAuthoritativeSnapshot = vi.fn()
  const reconcileRendererOwnership = vi.fn()
  const listRemoteSessions = vi
    .fn()
    .mockResolvedValueOnce({
      sessions: [],
      nextCursor: randomUUID()
    })
    .mockResolvedValueOnce({ sessions: [] })
    .mockRejectedValue(new Error('live remote sessions must not be probed on replay'))
  Object.assign(sidecar, {
    listWindowsForTrustedOwner: vi.fn().mockImplementation(() =>
      Promise.resolve({
        windows: [
          {
            windowId,
            revision: applyLayout.mock.calls.length === 0 ? 3 : 4,
            hostingState: 'hosted',
            workspaceIds: before.workspaces.map(({ id }) => id)
          }
        ]
      })
    ),
    listWorkspacesForTrustedOwner: vi
      .fn()
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: before })
      .mockRejectedValueOnce(new Error('postcommit projection unavailable'))
      .mockResolvedValue({ snapshot: { ...before, revision: 10 } }),
    detachTerminal,
    rememberClosedTerminal,
    terminalSockets: sockets
  })
  sidecar.client = {
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: before }),
    listRemoteSessions,
    listAgentCatalog: vi.fn().mockResolvedValue({
      catalogVersion: 1,
      revision: 0,
      sessions: [],
      teams: [],
      attention: []
    }),
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
    applyLayout
  } as unknown as NodeSidecar['client']
  const request = { layoutId: randomUUID(), expectedRevision: 9, idempotencyKey: randomUUID() }
  let automationActive = false
  const emitDomainEvent = vi.fn()
  const browser = {
    isCurrent: () => true,
    automationActive: () => automationActive,
    attachedTerminalIds: () => [...attachments],
    views: () => ({ destroySession: vi.fn(), reconcileAuthoritativeSnapshot }),
    emitDomainEvent,
    reconcileRendererOwnership,
    browserDetached: vi.fn(),
    terminalDetached: (id: string) => {
      attachments.delete(id)
    }
  } as never
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).rejects.toThrow('closed remote sessions')
  expect(applyLayout).not.toHaveBeenCalled()
  automationActive = true
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).rejects.toThrow('requires browser automation to stop')
  expect(applyLayout).not.toHaveBeenCalled()
  automationActive = false
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).rejects.toThrow('postcommit projection unavailable')
  expect(applyLayout).toHaveBeenCalledWith(
    expect.objectContaining({
      targetWindowId: windowId,
      expectedWindowRevision: 3
    })
  )
  automationActive = true
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).rejects.toThrow('requires browser automation to stop')
  expect(applyLayout).toHaveBeenCalledTimes(1)
  automationActive = false
  applyLayout.mockResolvedValueOnce({ revision: 10, replayed: false })
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).rejects.toThrow('replay was not confirmed')
  expect(detachTerminal).not.toHaveBeenCalled()
  expect(emitDomainEvent).not.toHaveBeenCalled()
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).resolves.toEqual({ handled: true, value: { revision: 10 } })
  expect(listRemoteSessions).toHaveBeenCalledTimes(2)
  expect(applyLayout).toHaveBeenLastCalledWith(
    expect.objectContaining({
      targetWindowId: windowId,
      expectedWindowRevision: 3
    })
  )
  expect(detachTerminal).toHaveBeenCalledExactlyOnceWith(staleTerminalId)
  expect(rememberClosedTerminal).toHaveBeenCalledWith(windowId, staleTerminalId)
  expect(reconcileAuthoritativeSnapshot).toHaveBeenCalledWith({ ...before, revision: 10 }, false)
  expect(reconcileRendererOwnership).toHaveBeenCalledOnce()
  expect(emitDomainEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'workspace.changed',
      revision: 10
    })
  )
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).resolves.toEqual({ handled: true, value: { revision: 10 } })
  expect(applyLayout).toHaveBeenCalledTimes(4)
  expect(detachTerminal).toHaveBeenCalledTimes(1)
  expect(emitDomainEvent).toHaveBeenCalledTimes(2)
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.layoutApply,
      [{ ...request, layoutId: randomUUID() }],
      vi.fn(),
      browser
    )
  ).rejects.toThrow('idempotency request changed')
  expect(applyLayout).toHaveBeenCalledTimes(4)

  const cache = Reflect.get(sidecar, 'layoutApplyRequests') as Map<
    string,
    { completedAtMs?: number; expiresAtMs: number }
  >
  const originalKey = `${windowId}:${request.idempotencyKey}`
  const completed = cache.get(originalKey)!
  expect(completed.completedAtMs).toBeTypeOf('number')
  const oldKey = 'old-completed'
  cache.set(oldKey, { completedAtMs: 1, expiresAtMs: Date.now() + 60_000 })
  for (let index = 0; index < 61; index++) {
    cache.set(`completed-${index}`, {
      completedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000
    })
  }
  const unresolvedKey = 'unresolved'
  cache.set(unresolvedKey, { expiresAtMs: Date.now() + 60_000 })
  expect(cache.size).toBe(64)
  listRemoteSessions.mockResolvedValueOnce({ sessions: [] })
  const nextRequest = {
    layoutId: randomUUID(),
    expectedRevision: 10,
    idempotencyKey: randomUUID()
  }
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [nextRequest], vi.fn(), browser)
  ).resolves.toEqual({ handled: true, value: { revision: 10 } })
  expect(cache.size).toBe(64)
  expect(cache.has(oldKey)).toBe(false)
  expect(cache.has(unresolvedKey)).toBe(true)

  completed.expiresAtMs = 0
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutApply, [request], vi.fn(), browser)
  ).rejects.toThrow('replay cannot be verified')
  expect(cache.has(originalKey)).toBe(false)
  cache.clear()
  for (let index = 0; index < 64; index++) {
    cache.set(`unresolved-${index}`, { expiresAtMs: Date.now() + 60_000 })
  }
  listRemoteSessions.mockResolvedValueOnce({ sessions: [] })
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.layoutApply,
      [{ ...nextRequest, idempotencyKey: randomUUID() }],
      vi.fn(),
      browser
    )
  ).rejects.toThrow('Too many pending saved layout apply requests')
  expect(cache.size).toBe(64)
})

it('exports and imports saved layouts only through native dialog choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-node-layout-file-'))
  try {
    const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
    const windowId = randomUUID()
    const workspace = projection.workspaces[0]!
    const paneId = randomUUID()
    const tabId = randomUUID()
    const envelope = {
      formatVersion: 1,
      name: 'Saved',
      template: {
        workspaces: [
          {
            id: workspace.id,
            name: workspace.name,
            description: workspace.description,
            color: workspace.color,
            workingDirectory: workspace.workingDirectory,
            layout: { kind: 'leaf', paneId },
            selectedPaneId: paneId,
            panes: { [paneId]: { id: paneId, tabs: [tabId], selectedTabId: tabId, title: null } },
            tabs: {
              [tabId]: {
                id: tabId,
                paneId,
                title: 'Shell',
                customTitle: null,
                content: {
                  kind: 'terminal',
                  launch: { cwd: workspace.workingDirectory, rows: 24, cols: 80 }
                },
                createdAt: 1
              }
            },
            createdAt: 1,
            updatedAt: 2
          }
        ]
      }
    }
    const path = join(directory, 'chosen.workspace-layout.json')
    const exportLayout = vi.fn().mockResolvedValue({ envelope })
    const importLayout = vi.fn().mockResolvedValue({ revision: 10, replayed: false })
    Object.assign(sidecar, {
      listWindowsForTrustedOwner: vi.fn().mockResolvedValue({ windows: [{ windowId }] }),
      listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({ snapshot: projection })
    })
    sidecar.client = {
      listWorkspaces: vi.fn().mockResolvedValue({ snapshot: projection }),
      identify: vi.fn().mockResolvedValue({ idempotencyEpoch: randomUUID() }),
      exportLayout,
      importLayout
    } as unknown as NodeSidecar['client']
    const browser = {
      isCurrent: () => true,
      chooseLayoutExportPath: vi.fn().mockResolvedValue(path),
      chooseLayoutImportPath: vi.fn().mockResolvedValue(path)
    } as never
    const layoutId = randomUUID()
    await expect(
      sidecar.invokeDesktopCore(
        windowId,
        DESKTOP_IPC.layoutExportFile,
        [{ layoutId }],
        vi.fn(),
        browser
      )
    ).resolves.toEqual({ handled: true, value: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(envelope)
    expect(exportLayout).toHaveBeenCalledWith(layoutId)
    const request = { layoutId: randomUUID(), expectedRevision: 9, idempotencyKey: randomUUID() }
    await expect(
      sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.layoutImportFile, [request], vi.fn(), browser)
    ).resolves.toEqual({ handled: true, value: { revision: 10 } })
    expect(importLayout).toHaveBeenCalledWith(expect.objectContaining({ ...request, envelope }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('lists Node windows only after the private owner capability resolves the requested placement', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const placement = { windowId, revision: 2 }
  const topology = { windows: [placement] }
  const issue = vi.fn().mockResolvedValue('private-capability')
  const revoke = vi.fn().mockResolvedValue(undefined)
  Object.assign(sidecar, {
    windowCapabilityReads: new Map(),
    issueWindowCapabilityForTrustedOwner: issue,
    revokeWindowCapability: revoke
  })
  const getBoundWindow = vi.fn().mockResolvedValue({ window: placement })
  const listWindows = vi.fn().mockResolvedValue(topology)
  sidecar.client = { getBoundWindow, listWindows } as unknown as NodeSidecar['client']

  await expect(sidecar.listWindowsForTrustedOwner(windowId)).resolves.toBe(topology)
  expect(issue).toHaveBeenCalledWith(windowId)
  expect(getBoundWindow).toHaveBeenCalledWith('private-capability')
  expect(revoke).toHaveBeenCalledWith('private-capability')

  getBoundWindow.mockResolvedValueOnce({ window: { ...placement, windowId: randomUUID() } })
  await expect(sidecar.listWindowsForTrustedOwner(windowId)).rejects.toThrow('binding changed')
  expect(listWindows).toHaveBeenCalledTimes(1)
  expect(revoke).toHaveBeenCalledTimes(2)

  listWindows.mockResolvedValueOnce({ windows: [{ ...placement, revision: 3 }] })
  await expect(sidecar.listWindowsForTrustedOwner(windowId)).rejects.toThrow('topology changed')
  expect(revoke).toHaveBeenCalledTimes(3)
})

it('serializes task and topology reads for one window before rotating its private capability', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const calls: string[] = []
  let releaseTask!: () => void
  const taskBlocked = new Promise<void>((resolve) => {
    releaseTask = resolve
  })
  const issue = vi
    .fn()
    .mockImplementationOnce(() => {
      calls.push('issue-task')
      return Promise.resolve('task-capability')
    })
    .mockImplementationOnce(() => {
      calls.push('issue-window')
      return Promise.resolve('window-capability')
    })
  const revoke = vi.fn((capability: string) => {
    calls.push(`revoke-${capability}`)
    return Promise.resolve()
  })
  Object.assign(sidecar, {
    windowCapabilityReads: new Map(),
    issueWindowCapabilityForTrustedOwner: issue,
    revokeWindowCapability: revoke
  })
  const listTasksBound = vi.fn(async (_request: unknown, capability: string) => {
    calls.push(`read-${capability}`)
    await taskBlocked
    return { tasks: [] }
  })
  const placement = { windowId, revision: 1 }
  const getBoundWindow = vi.fn().mockResolvedValue({ window: placement })
  const listWindows = vi.fn().mockResolvedValue({ windows: [placement] })
  sidecar.client = {
    listTasksBound,
    getBoundWindow,
    listWindows
  } as unknown as NodeSidecar['client']

  const task = sidecar.listTasksForTrustedOwner(
    windowId,
    {} as Parameters<NodeSidecar['listTasksForTrustedOwner']>[1]
  )
  await vi.waitFor(() => expect(listTasksBound).toHaveBeenCalledOnce())
  const windows = sidecar.listWindowsForTrustedOwner(windowId)
  await Promise.resolve()
  expect(issue).toHaveBeenCalledTimes(1)
  expect(getBoundWindow).not.toHaveBeenCalled()

  releaseTask()
  await Promise.all([task, windows])
  expect(calls).toEqual([
    'issue-task',
    'read-task-capability',
    'revoke-task-capability',
    'issue-window',
    'revoke-window-capability'
  ])
  expect(getBoundWindow).toHaveBeenCalledWith('window-capability')
  expect(listWindows).toHaveBeenCalledOnce()
})

it('detaches only an exact remote task found in the same bound Node copy', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const target = { sessionId: randomUUID(), generation: 2, revision: 3 }
  const request = {
    action: 'detach' as const,
    target,
    mutation: { idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64), expectedRevision: 3 }
  }
  const issue = vi.fn().mockResolvedValue('private-capability')
  const revoke = vi.fn().mockResolvedValue(undefined)
  const listTasksBound = vi.fn().mockResolvedValue({
    tasks: [{ kind: 'remoteSession', target }],
    nextCursor: null
  })
  const result = { outcome: 'accepted' }
  const taskActionBound = vi.fn().mockResolvedValue(result)
  Object.assign(sidecar, {
    stopped: false,
    taskActionsEnabled: true,
    windowCapabilityReads: new Map(),
    issueWindowCapabilityForTrustedOwner: issue,
    revokeWindowCapability: revoke,
    client: { listTasksBound, taskActionBound }
  })

  await expect(sidecar.detachRemoteTaskForTrustedOwner(windowId, request)).resolves.toBe(result)
  expect(issue).toHaveBeenCalledWith(windowId)
  expect(listTasksBound).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'remoteSession', limit: 100 }),
    'private-capability'
  )
  expect(taskActionBound).toHaveBeenCalledWith(request, 'private-capability')
  expect(revoke).toHaveBeenCalledWith('private-capability')

  listTasksBound.mockResolvedValueOnce({
    tasks: [{ kind: 'remoteSession', target: { ...target, revision: 4 } }],
    nextCursor: null
  })
  await expect(sidecar.detachRemoteTaskForTrustedOwner(windowId, request)).rejects.toThrow(
    'Remote task is unavailable in the Node copy'
  )
  expect(taskActionBound).toHaveBeenCalledOnce()
  expect(revoke).toHaveBeenCalledTimes(2)

  listTasksBound.mockResolvedValue({ tasks: [], nextCursor: 'repeated-cursor' })
  await expect(sidecar.detachRemoteTaskForTrustedOwner(windowId, request)).rejects.toThrow(
    'The Node task list cursor repeated'
  )
  expect(taskActionBound).toHaveBeenCalledOnce()

  sidecar.taskActionsEnabled = false
  await expect(sidecar.detachRemoteTaskForTrustedOwner(windowId, request)).rejects.toThrow(
    'Node task actions are unavailable'
  )
  expect(issue).toHaveBeenCalledTimes(3)
})

it('rejects remote enrollment before opening a key when the verified sidecar lacks the capability', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  Object.assign(sidecar, { options: { remoteDemo: true }, remoteEnrollmentEnabled: false })
  const pickCredential = vi.fn().mockResolvedValue(null)
  await expect(
    sidecar.invokeDesktopCore(
      'test-window',
      DESKTOP_IPC.remoteTargetEnroll,
      [{}],
      vi.fn(),
      undefined,
      { pickCredential, isCurrent: () => true, confirm: vi.fn() }
    )
  ).rejects.toThrow('Remote target enrollment is unavailable')
  expect(pickCredential).not.toHaveBeenCalled()
})

it('rejects remote replacement before opening a key when the verified sidecar lacks the capability', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  Object.assign(sidecar, { options: { remoteDemo: true }, remoteReplacementEnabled: false })
  const pickCredential = vi.fn().mockResolvedValue(null)
  await expect(
    sidecar.invokeDesktopCore(
      'test-window',
      DESKTOP_IPC.remoteCredentialReplace,
      [{ remoteTargetId: targetId }],
      vi.fn(),
      undefined,
      { pickCredential, isCurrent: () => true, confirm: vi.fn() }
    )
  ).rejects.toThrow('Remote credential replacement is unavailable')
  expect(pickCredential).not.toHaveBeenCalled()
})

it('publishes a live target only after reservation and the pinned credential handoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-live-new-'))
  const keyPath = join(directory, 'test-key')
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const proof = {
    liveStatePath: join(directory, 'state.sqlite3'),
    backupStatePath: join(directory, 'backup.sqlite3'),
    liveStateIdentity: '1:2',
    backupStateIdentity: '1:3',
    backupSha256: 'a'.repeat(64)
  }
  const draft = { label: 'Task target', host: 'example.com', port: 22, user: 'alice' }
  const order: string[] = []
  const begin = vi.fn(() => {
    order.push('reserve')
    return Promise.resolve()
  })
  const handoff = vi.fn(() => {
    order.push('handoff')
    return Promise.resolve()
  })
  const commit = vi.fn(({ target }: { target: { remoteTargetId: string } }) => {
    order.push('commit')
    return Promise.resolve({
      target: {
        ...draft,
        remoteTargetId: target.remoteTargetId,
        authentication: 'publicKey',
        hostKeyState: 'untrusted',
        knownHostsVersion: 1,
        revision: 1
      }
    })
  })
  try {
    await writeFile(keyPath, 'disposable test bytes', { mode: 0o600 })
    const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const credentialFd = handle.fd
    Object.assign(sidecar, {
      stopped: false,
      options: {
        remoteTransport: true,
        liveDatabasePath: proof.liveStatePath,
        backupPath: proof.backupStatePath
      },
      remoteEnrollmentEnabled: true,
      client: { beginRemoteTargetEnrollment: begin, commitRemoteTargetEnrollment: commit },
      ownerChannel: {
        liveBackupProof: () => {
          order.push('proof')
          return Promise.resolve(proof)
        }
      },
      enrollLiveRemoteTarget: handoff
    })
    const result = await sidecar.invokeDesktopCore(
      randomUUID(),
      DESKTOP_IPC.remoteTargetEnroll,
      [draft],
      vi.fn(),
      undefined,
      { pickCredential: () => Promise.resolve(handle), isCurrent: () => true, confirm: vi.fn() }
    )
    expect(result.handled).toBe(true)
    expect(order).toEqual(['reserve', 'proof', 'handoff', 'commit'])
    expect(handoff).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      proof,
      credentialFd
    )
    await expect(handle.stat()).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('reserves and commits a live replacement only after the pinned handoff and observed revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-live-replace-'))
  const keyPath = join(directory, 'test-key')
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const proof = {
    liveStatePath: join(directory, 'state.sqlite3'),
    backupStatePath: join(directory, 'backup.sqlite3'),
    liveStateIdentity: '1:2',
    backupStateIdentity: '1:3',
    backupSha256: 'a'.repeat(64)
  }
  const target = {
    remoteTargetId: targetId,
    label: 'Test',
    host: 'example.com',
    port: 22,
    user: 'alice',
    authentication: 'publicKey' as const,
    hostKeyState: 'untrusted' as const,
    knownHostsVersion: 1,
    revision: 2
  }
  const order: string[] = []
  const getRemoteTarget = vi
    .fn()
    .mockImplementationOnce(() => {
      order.push('read-before')
      return Promise.resolve({ target })
    })
    .mockImplementationOnce(() => {
      order.push('read-after')
      return Promise.resolve({ target: { ...target, revision: 3 } })
    })
  const beginRemoteCredentialReplacement = vi.fn(() => {
    order.push('reserve')
    return Promise.resolve()
  })
  const commitRemoteCredentialReplacement = vi.fn(() => {
    order.push('commit')
    return Promise.resolve({ target: { ...target, revision: 3 } })
  })
  const liveBackupProof = vi.fn(() => {
    order.push('proof')
    return Promise.resolve(proof)
  })
  const handoff = vi.fn(() => {
    order.push('handoff')
    return Promise.resolve()
  })
  try {
    await writeFile(keyPath, 'disposable test bytes', { mode: 0o600 })
    const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const credentialFd = handle.fd
    Object.assign(sidecar, {
      stopped: false,
      options: {
        remoteTransport: true,
        liveDatabasePath: proof.liveStatePath,
        backupPath: proof.backupStatePath
      },
      remoteReplacementEnabled: true,
      client: {
        getRemoteTarget,
        beginRemoteCredentialReplacement,
        commitRemoteCredentialReplacement
      },
      ownerChannel: { liveBackupProof },
      replaceLiveRemoteCredential: handoff
    })
    await expect(
      sidecar.invokeDesktopCore(
        randomUUID(),
        DESKTOP_IPC.remoteCredentialReplace,
        [{ remoteTargetId: targetId }],
        vi.fn(),
        undefined,
        { pickCredential: () => Promise.resolve(handle), isCurrent: () => true, confirm: vi.fn() }
      )
    ).resolves.toEqual({ handled: true, value: true })
    expect(order).toEqual(['read-before', 'reserve', 'proof', 'handoff', 'commit', 'read-after'])
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({ remoteTargetId: targetId, expectedRevision: 2 }),
      proof,
      credentialFd
    )
    await expect(handle.stat()).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('leaves a failed live restart stopped and does not send a stale rollback request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-live-restart-'))
  const keyPath = join(directory, 'test-key')
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const abortRemoteCredentialReplacement = vi.fn()
  const target = {
    remoteTargetId: targetId,
    label: 'Test',
    host: 'example.com',
    port: 22,
    user: 'alice',
    authentication: 'publicKey',
    hostKeyState: 'untrusted',
    knownHostsVersion: 1,
    revision: 2
  }
  try {
    await writeFile(keyPath, 'disposable test bytes', { mode: 0o600 })
    const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    Object.assign(sidecar, {
      stopped: false,
      options: { remoteTransport: true, liveDatabasePath: '/tmp/state', backupPath: '/tmp/backup' },
      remoteReplacementEnabled: true,
      client: {
        getRemoteTarget: vi.fn().mockResolvedValue({ target }),
        beginRemoteCredentialReplacement: vi.fn().mockResolvedValue(undefined),
        abortRemoteCredentialReplacement
      },
      ownerChannel: {
        liveBackupProof: vi.fn().mockResolvedValue({
          liveStatePath: '/tmp/state',
          backupStatePath: '/tmp/backup',
          liveStateIdentity: '1:2',
          backupStateIdentity: '1:3',
          backupSha256: 'a'.repeat(64)
        })
      },
      replaceLiveRemoteCredential: vi.fn(() => {
        sidecar['stopped'] = true
        return Promise.reject(new Error('restart failed'))
      })
    })
    await expect(
      sidecar.invokeDesktopCore(
        randomUUID(),
        DESKTOP_IPC.remoteCredentialReplace,
        [{ remoteTargetId: targetId }],
        vi.fn(),
        undefined,
        { pickCredential: () => Promise.resolve(handle), isCurrent: () => true, confirm: vi.fn() }
      )
    ).rejects.toThrow('pending recovery')
    expect(abortRemoteCredentialReplacement).not.toHaveBeenCalled()
    await expect(handle.stat()).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('reads the isolated agent catalog and rejects assessment outside the owning window', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  Object.assign(sidecar, { agentAssessmentEnabled: true })
  const catalog = { catalogVersion: 1, revision: 1, sessions: [], teams: [], attention: [] }
  const agentSessionId = randomUUID()
  const workspaceId = randomUUID()
  const assessAgentRestore = vi.fn()
  sidecar.client = {
    listAgentCatalog: vi.fn().mockResolvedValue(catalog),
    getAgentSession: vi.fn().mockResolvedValue({
      session: {
        catalogVersion: 1,
        binding: { workspaceId, paneId: randomUUID(), tabId: randomUUID(), agentSessionId },
        adapterId: 'codex',
        adapterVersion: '0.156.1',
        title: 'Owned session',
        lifecycle: 'running',
        restore: { level: 'unavailable', assessedAtMs: 1, evidenceEpoch: 1 },
        revision: 2,
        attemptEpoch: 1,
        lastVerifiedAtMs: 1
      }
    }),
    stateSnapshot: vi.fn().mockResolvedValue({ snapshot: { windowPlacements: [] } }),
    assessAgentRestore
  } as unknown as NodeSidecar['client']
  await expect(
    sidecar.invokeDesktopCore('window', DESKTOP_IPC.agentCatalogList, [], vi.fn())
  ).resolves.toMatchObject({ handled: true, value: catalog })
  await expect(
    sidecar.invokeDesktopCore(
      'window',
      DESKTOP_IPC.agentRestoreAssess,
      [{ agentSessionId, expectedRevision: 2 }],
      vi.fn()
    )
  ).rejects.toThrow('workspace is unavailable in this window')
  expect(assessAgentRestore).not.toHaveBeenCalled()
})

it('routes team and attention mutations through the owning Node window with revision fences', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const agentSessionId = randomUUID()
  const teamId = randomUUID()
  const memberId = randomUUID()
  const binding = {
    workspaceId: projection.workspaces[0]!.id,
    paneId: projection.workspaces[0]!.panes[0]!.id,
    tabId: projection.workspaces[0]!.tabs[0]!.id,
    agentSessionId
  }
  const member = { memberId, role: 'builder', target: binding, revision: 4 }
  const team = { teamId, title: 'Team', revision: 5, members: [member] }
  const session = {
    catalogVersion: 1,
    binding,
    adapterId: 'codex',
    adapterVersion: '0.156.1',
    title: 'Agent',
    lifecycle: 'running',
    restore: { level: 'unavailable', assessedAtMs: 1, evidenceEpoch: 1 },
    revision: 7,
    attemptEpoch: 3,
    lastVerifiedAtMs: 1,
    teamId,
    memberId
  }
  const catalog = {
    catalogVersion: 1,
    revision: 9,
    sessions: [session],
    teams: [team],
    attention: []
  }
  const client = {
    stateSnapshot: vi.fn().mockResolvedValue({
      snapshot: { windowPlacements: [{ id: windowId, workspaceIds: [binding.workspaceId] }] }
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: projection }),
    listAgentCatalog: vi.fn().mockResolvedValue(catalog),
    getAgentSession: vi.fn().mockResolvedValue({ session }),
    createAgentTeam: vi.fn().mockResolvedValue({ team }),
    deleteAgentTeam: vi.fn().mockResolvedValue({ ...catalog, teams: [] }),
    createAgentTeamMember: vi.fn().mockResolvedValue({ member }),
    updateAgentTeamMember: vi.fn().mockResolvedValue({ member }),
    moveAgentTeamMember: vi.fn().mockResolvedValue({ member }),
    deleteAgentTeamMember: vi.fn().mockResolvedValue({ team: { ...team, members: [] } }),
    setAgentAttention: vi.fn().mockResolvedValue({
      target: { target: binding, teamId, memberId },
      state: 'urgent',
      revision: 1
    })
  }
  sidecar.client = client as unknown as NodeSidecar['client']
  const invoke = (channel: string, request: unknown) =>
    sidecar.invokeDesktopCore(windowId, channel, [request], vi.fn())
  const teamRequest = { teamId, expectedCatalogRevision: 9, expectedTeamRevision: 5 }
  const memberRequest = { ...teamRequest, memberId, expectedMemberRevision: 4 }

  await expect(invoke(DESKTOP_IPC.agentTeamCreate, { title: 'Team' })).resolves.toMatchObject({
    value: { team }
  })
  await expect(
    invoke(DESKTOP_IPC.agentTeamMemberCreate, {
      ...teamRequest,
      agentSessionId,
      role: 'builder'
    })
  ).resolves.toMatchObject({ value: { member } })
  await expect(
    invoke(DESKTOP_IPC.agentTeamMemberUpdate, {
      ...memberRequest,
      role: 'reviewer'
    })
  ).resolves.toMatchObject({ value: { member } })
  await expect(
    invoke(DESKTOP_IPC.agentTeamMemberMove, {
      ...memberRequest,
      agentSessionId
    })
  ).resolves.toMatchObject({ value: { member } })
  await expect(invoke(DESKTOP_IPC.agentTeamMemberDelete, memberRequest)).resolves.toMatchObject({
    value: { member }
  })
  await expect(invoke(DESKTOP_IPC.agentTeamDelete, teamRequest)).resolves.toMatchObject({
    value: { team }
  })
  await expect(
    invoke(DESKTOP_IPC.agentAttentionSet, {
      agentSessionId,
      state: 'urgent',
      expectedAttentionRevision: null,
      expectedSessionRevision: 7
    })
  ).resolves.toMatchObject({ value: { state: 'urgent', revision: 1 } })

  expect(client.createAgentTeam).toHaveBeenCalledWith(
    expect.objectContaining({
      teamId: expect.any(String),
      mutation: expect.objectContaining({
        expectedCatalogRevision: 9,
        idempotencyKey: expect.any(String),
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    })
  )
  expect(client.updateAgentTeamMember).toHaveBeenCalledWith(
    expect.objectContaining({
      mutation: expect.objectContaining({
        expectedCatalogRevision: 9,
        expectedTeamRevision: 5,
        expectedMemberRevision: 4
      })
    })
  )
  expect(client.setAgentAttention).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { target: binding, teamId, memberId },
      operation: expect.objectContaining({ sessionRevision: 7, attemptEpoch: 3 })
    })
  )
})

it('rejects stale and foreign team or attention targets before Node mutation', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowId = randomUUID()
  const agentSessionId = randomUUID()
  const teamId = randomUUID()
  const memberId = randomUUID()
  const binding = {
    workspaceId: projection.workspaces[0]!.id,
    paneId: projection.workspaces[0]!.panes[0]!.id,
    tabId: projection.workspaces[0]!.tabs[0]!.id,
    agentSessionId
  }
  const member = { memberId, role: 'builder', target: binding, revision: 4 }
  const session = {
    catalogVersion: 1,
    binding,
    adapterId: 'codex',
    adapterVersion: '0.156.1',
    title: 'Agent',
    lifecycle: 'running',
    restore: { level: 'unavailable', assessedAtMs: 1, evidenceEpoch: 1 },
    revision: 7,
    attemptEpoch: 3,
    lastVerifiedAtMs: 1
  }
  const client = {
    stateSnapshot: vi.fn().mockResolvedValue({
      snapshot: {
        windowPlacements: [
          { id: windowId, workspaceIds: [] },
          { id: randomUUID(), workspaceIds: [binding.workspaceId] }
        ]
      }
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: projection }),
    listAgentCatalog: vi.fn().mockResolvedValue({
      catalogVersion: 1,
      revision: 9,
      sessions: [session],
      teams: [{ teamId, title: 'Team', revision: 5, members: [member] }],
      attention: []
    }),
    getAgentSession: vi.fn().mockResolvedValue({ session }),
    deleteAgentTeam: vi.fn(),
    updateAgentTeamMember: vi.fn(),
    setAgentAttention: vi.fn()
  }
  sidecar.client = client as unknown as NodeSidecar['client']
  const invoke = (channel: string, request: unknown) =>
    sidecar.invokeDesktopCore(windowId, channel, [request], vi.fn())
  await expect(
    invoke(DESKTOP_IPC.agentTeamDelete, {
      teamId,
      expectedCatalogRevision: 8,
      expectedTeamRevision: 5
    })
  ).rejects.toThrow('team revision is stale')
  await expect(
    invoke(DESKTOP_IPC.agentTeamMemberUpdate, {
      teamId,
      memberId,
      role: 'reviewer',
      expectedCatalogRevision: 9,
      expectedTeamRevision: 5,
      expectedMemberRevision: 3
    })
  ).rejects.toThrow('member revision is stale')
  await expect(
    invoke(DESKTOP_IPC.agentTeamDelete, {
      teamId,
      expectedCatalogRevision: 9,
      expectedTeamRevision: 5
    })
  ).rejects.toThrow('workspace is unavailable in this window')
  await expect(
    invoke(DESKTOP_IPC.agentAttentionSet, {
      agentSessionId,
      state: 'urgent',
      expectedAttentionRevision: null,
      expectedSessionRevision: 7
    })
  ).rejects.toThrow('workspace is unavailable in this window')
  expect(client.deleteAgentTeam).not.toHaveBeenCalled()
  expect(client.updateAgentTeamMember).not.toHaveBeenCalled()
  expect(client.setAgentAttention).not.toHaveBeenCalled()
})

it('routes an owned remote prepare and activation to the isolated client and binds its visible terminal', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  Object.assign(sidecar, {
    options: { remoteDemo: true },
    terminalSockets: new Map(),
    remoteTerminals: new Map(),
    remoteConfirmations: new Map()
  })
  const workspace = projection.workspaces[0]!
  const pane = workspace.panes[0]!
  const tab = workspace.tabs[0]!
  const windowId = '00000000-0000-4000-8000-000000000001'
  const targetId = '00000000-0000-4000-8000-0000000000f3'
  const request = {
    remoteTargetId: targetId,
    workspaceId: workspace.id,
    paneId: pane.id,
    tabId: tab.id,
    tmux: { mode: 'create' as const, sessionName: 'demo' },
    reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 }
  }
  const session = {
    remoteSessionId: '00000000-0000-4000-8000-0000000000f4',
    ...request,
    state: 'trustRequired' as const,
    observation: 'unknown' as const,
    attemptGeneration: 1,
    revision: 1
  }
  const prepareRemoteSession = vi.fn().mockImplementation(async ({ remoteSessionId }) => ({
    session: { ...session, remoteSessionId }
  }))
  const activateRemoteSession = vi.fn().mockResolvedValue({
    session: { ...session, state: 'connected', revision: 2 }
  })
  const send = vi.fn().mockResolvedValue(undefined)
  sidecar.client = {
    stateSnapshot: vi.fn().mockResolvedValue({
      snapshot: { windowPlacements: [{ id: windowId, workspaceIds: [workspace.id] }] }
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: projection }),
    getRemoteSession: vi.fn().mockResolvedValue({ session }),
    prepareRemoteSession,
    activateRemoteSession,
    getRemoteTerminal: vi.fn().mockResolvedValue({
      terminalId: '00000000-0000-4000-8000-0000000000f5'
    }),
    send
  } as unknown as NodeSidecar['client']
  const emit = vi.fn()

  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.remoteSessionConnect, [request], emit)
  ).resolves.toMatchObject({ handled: true, value: { session: { state: 'trustRequired' } } })
  expect(prepareRemoteSession).toHaveBeenCalledWith(
    expect.objectContaining({
      ...request,
      remoteSessionId: expect.any(String),
      mutation: expect.objectContaining({ expectedRevision: 0, requestHash: expect.any(String) })
    })
  )
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.remoteSessionReconnect,
      [{ remoteSessionId: session.remoteSessionId, expectedRevision: 1 }],
      emit
    )
  ).resolves.toMatchObject({ handled: true, value: { session: { state: 'connected' } } })
  expect(emit).toHaveBeenCalledWith({
    event: 'terminal.resyncRequired',
    data: { terminalId: tab.content.runtimeSessionId }
  })
  await sidecar.invokeDesktopCore(
    windowId,
    DESKTOP_IPC.terminalSend,
    [tab.content.runtimeSessionId, 'echo remote\n'],
    emit
  )
  expect(send).toHaveBeenCalledWith(
    '00000000-0000-4000-8000-0000000000f5',
    Buffer.from('echo remote\n')
  )
})

it('activates a trusted existing target during Connect', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  Object.assign(sidecar, {
    options: { remoteDemo: true },
    terminalSockets: new Map(),
    remoteTerminals: new Map()
  })
  const workspace = projection.workspaces[0]!
  const windowId = '00000000-0000-4000-8000-000000000001'
  const request = {
    remoteTargetId: targetId,
    workspaceId: workspace.id,
    paneId: workspace.panes[0]!.id,
    tabId: workspace.tabs[0]!.id,
    tmux: { mode: 'create' as const, sessionName: 'demo' },
    reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 }
  }
  const prepared = {
    remoteSessionId: '00000000-0000-4000-8000-0000000000f4',
    ...request,
    state: 'credentialRequired' as const,
    observation: 'unknown' as const,
    attemptGeneration: 1,
    revision: 1
  }
  const activateRemoteSession = vi.fn().mockImplementation(async ({ remoteSessionId }) => ({
    session: { ...prepared, remoteSessionId, state: 'connected', revision: 2 }
  }))
  sidecar.client = {
    stateSnapshot: vi.fn().mockResolvedValue({
      snapshot: { windowPlacements: [{ id: windowId, workspaceIds: [workspace.id] }] }
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: projection }),
    prepareRemoteSession: vi.fn().mockImplementation(async ({ remoteSessionId }) => ({
      session: { ...prepared, remoteSessionId }
    })),
    activateRemoteSession,
    getRemoteTerminal: vi.fn().mockResolvedValue({
      terminalId: '00000000-0000-4000-8000-0000000000f5'
    })
  } as unknown as NodeSidecar['client']
  const emit = vi.fn()

  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.remoteSessionConnect, [request], emit)
  ).resolves.toMatchObject({ handled: true, value: { session: { state: 'connected' } } })
  expect(activateRemoteSession).toHaveBeenCalledWith({
    remoteSessionId: expect.any(String),
    mutation: expect.objectContaining({ expectedRevision: prepared.revision })
  })
  expect(emit).toHaveBeenCalledWith({
    event: 'terminal.resyncRequired',
    data: { terminalId: workspace.tabs[0]!.content.runtimeSessionId }
  })
})

it('does not send input to the local pane when the active remote terminal binding is incomplete', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const projectedId = projection.workspaces[0]!.tabs[0]!.content.runtimeSessionId!
  const windowId = '00000000-0000-4000-8000-000000000001'
  Object.assign(sidecar, {
    options: { remoteDemo: true },
    remoteTerminals: new Map([
      [projectedId, { remoteSessionId: '00000000-0000-4000-8000-0000000000f4', windowId }]
    ])
  })
  const send = vi.fn()
  sidecar.client = { send } as unknown as NodeSidecar['client']

  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.terminalSend, [projectedId, 'input'], vi.fn())
  ).rejects.toThrow('active remote terminal binding is unavailable')
  expect(send).not.toHaveBeenCalled()
})

it('confirms an exact Node host-key challenge only while the window and revisions remain current', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  Object.assign(sidecar, { options: { remoteDemo: true }, remoteConfirmations: new Map() })
  const workspace = projection.workspaces[0]!
  const windowId = '00000000-0000-4000-8000-000000000001'
  const session = {
    remoteSessionId: '00000000-0000-4000-8000-0000000000f4',
    remoteTargetId: targetId,
    workspaceId: workspace.id,
    paneId: workspace.panes[0]!.id,
    tabId: workspace.tabs[0]!.id,
    tmux: { mode: 'create' as const, sessionName: 'demo' },
    reconnect: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 },
    state: 'trustRequired' as const,
    observation: 'unknown' as const,
    attemptGeneration: 1,
    revision: 1
  }
  const target = {
    remoteTargetId: targetId,
    label: 'Demo',
    host: 'example.test',
    port: 22,
    user: 'demo',
    authentication: 'publicKey' as const,
    hostKeyState: 'untrusted' as const,
    knownHostsVersion: 1,
    revision: 2
  }
  const challenge = {
    remoteSessionId: session.remoteSessionId,
    promptId: '00000000-0000-4000-8000-0000000000f6',
    attemptGeneration: 1,
    canonicalHost: target.host,
    port: 22,
    algorithm: 'ssh-ed25519' as const,
    publicKey: 'QUJD',
    presentedFingerprint: 'SHA256:example',
    targetRevision: 2,
    expiresAtMs: 1000
  }
  const decideRemoteHostKey = vi.fn().mockResolvedValue({
    session: { ...session, revision: 2, state: 'credentialRequired' }
  })
  sidecar.client = {
    stateSnapshot: vi.fn().mockResolvedValue({
      snapshot: { windowPlacements: [{ id: windowId, workspaceIds: [workspace.id] }] }
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ snapshot: projection }),
    getRemoteSession: vi.fn().mockResolvedValue({ session }),
    getRemoteTarget: vi.fn().mockResolvedValue({ target }),
    scanRemoteHostKey: vi.fn().mockResolvedValue(challenge),
    decideRemoteHostKey
  } as unknown as NodeSidecar['client']
  const confirm = vi.fn().mockResolvedValue(true)
  const confirmation = { confirm, isCurrent: vi.fn().mockReturnValue(true) }
  const action = { remoteSessionId: session.remoteSessionId, expectedRevision: 1 }

  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.remoteHostKeyConfirm,
      [action],
      vi.fn(),
      undefined,
      confirmation
    )
  ).resolves.toMatchObject({ handled: true, value: { session: { state: 'credentialRequired' } } })
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: expect.stringContaining('SHA256:example')
    })
  )
  expect(decideRemoteHostKey).toHaveBeenCalledWith(
    expect.objectContaining({
      promptId: challenge.promptId,
      presentedFingerprint: challenge.presentedFingerprint,
      decision: 'trust',
      mutation: expect.objectContaining({ expectedRevision: target.revision })
    })
  )

  confirmation.isCurrent.mockReturnValue(false)
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.remoteHostKeyConfirm,
      [action],
      vi.fn(),
      undefined,
      confirmation
    )
  ).rejects.toThrow('desktop authority is stale')
  expect(decideRemoteHostKey).toHaveBeenCalledOnce()
})

it('forwards a committed Node browser observation with the owning workspace', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const browserTab = projection.workspaces[0]!.tabs.find((tab) => tab.content.kind === 'browser')!
  if (browserTab.content.kind !== 'browser') throw new Error('Browser fixture is missing')
  const state = browserSessionStateSchema.parse({ ...browserTab.content.state, stateRevision: 3 })
  const after = {
    ...projection,
    revision: 42,
    workspaces: projection.workspaces.map((workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) =>
        tab.id === browserTab.id ? { ...tab, content: { kind: 'browser' as const, state } } : tab
      )
    }))
  }
  const sink = vi.fn().mockResolvedValue(undefined)
  sidecar.setBrowserEventSink(sink)
  Object.assign(sidecar, {
    listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({ snapshot: after })
  })
  sidecar.client = {
    identify: vi
      .fn()
      .mockResolvedValue({ idempotencyEpoch: '00000000-0000-4000-8000-000000000001' }),
    listWorkspaces: vi.fn().mockResolvedValueOnce({
      snapshot: {
        ...projection,
        workspaces: [...projection.workspaces, { ...projection.workspaces[0]!, id: randomUUID() }]
      }
    }),
    observeBrowser: vi.fn().mockResolvedValue({ revision: 42, replayed: false })
  } as unknown as NodeSidecar['client']

  const observed = await sidecar.createBrowserControl('test-window').observeBrowser({
    workspaceId: projection.workspaces[0]!.id,
    tabId: browserTab.id,
    state
  })
  expect(observed.snapshot.workspaces).toHaveLength(1)

  expect(sink).toHaveBeenCalledWith(projection.workspaces[0]!.id, {
    event: 'browser.changed',
    revision: 42,
    data: { state }
  })
})

it('serves Node workspace and card reads only to the owning window', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  Object.assign(sidecar, {
    windowCapabilityReads: new Map(),
    issueWindowCapabilityForTrustedOwner: vi.fn().mockResolvedValue('private-capability'),
    revokeWindowCapability: vi.fn().mockResolvedValue(undefined)
  })
  const listBoundWorkspaces = vi.fn().mockResolvedValue({ snapshot: projection })
  const workspaceId = projection.workspaces[0]!.id
  const getWorkspaceCardSlots = vi.fn().mockResolvedValue({
    workspaceId,
    revision: 0,
    agentStatus: null,
    progress: null
  })
  sidecar.client = {
    listBoundWorkspaces,
    getWorkspaceCardSlots,
    stateSnapshot: vi.fn().mockResolvedValue({
      snapshot: {
        windowPlacements: [
          { id: 'test-window', hostingState: 'hosted', workspaceIds: [workspaceId] }
        ],
        notifications: []
      }
    })
  } as unknown as NodeSidecar['client']
  const emit = vi.fn()

  await expect(
    sidecar.invokeDesktopCore('test-window', DESKTOP_IPC.workspaceList, [], emit)
  ).resolves.toMatchObject({
    handled: true,
    value: { snapshot: { revision: projection.revision } }
  })
  expect(listBoundWorkspaces).toHaveBeenCalledWith('private-capability')
  await expect(
    sidecar.invokeDesktopCore(
      'test-window',
      DESKTOP_IPC.workspaceCardSlotsGet,
      [{ workspaceId }],
      emit
    )
  ).resolves.toMatchObject({ handled: true, value: { workspaceId, revision: 0 } })
  await expect(
    sidecar.invokeDesktopCore(
      'different-window',
      DESKTOP_IPC.workspaceCardSlotsGet,
      [{ workspaceId }],
      emit
    )
  ).rejects.toThrow('workspace is unavailable in this window')
  expect(getWorkspaceCardSlots).toHaveBeenCalledOnce()
  expect(emit).not.toHaveBeenCalled()
})

it('routes settings reads and mutations through the isolated Node client with sender identity', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const before = { ...projection, revision: 42 }
  const after = { ...projection, revision: 43 }
  Object.assign(sidecar, {
    listWorkspacesForTrustedOwner: vi.fn().mockResolvedValue({ snapshot: after })
  })
  const getSettings = vi.fn().mockResolvedValue(settings)
  const updateSettings = vi.fn().mockResolvedValue({ revision: 43, replayed: false })
  const resetShortcut = vi.fn().mockResolvedValue({ revision: 43, replayed: false })
  sidecar.client = {
    getSettings,
    identify: vi.fn().mockResolvedValue({ idempotencyEpoch: 'test-epoch' }),
    listWorkspaces: vi
      .fn()
      .mockResolvedValueOnce({ snapshot: before })
      .mockResolvedValueOnce({ snapshot: before }),
    updateSettings,
    resetShortcut
  } as unknown as NodeSidecar['client']
  const emit = vi.fn()
  const windowId = '00000000-0000-4000-8000-000000000001'

  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.settingsGet, [], emit)
  ).resolves.toEqual({
    handled: true,
    value: settings
  })
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.settingsUpdate,
      [{ notifications: settings.notifications }],
      emit
    )
  ).resolves.toMatchObject({ handled: true, value: { revision: 43, snapshot: { revision: 43 } } })
  expect(updateSettings).toHaveBeenCalledWith({
    windowId,
    update: { notifications: settings.notifications },
    mutation: expect.objectContaining({
      expectedRevision: 42,
      idempotencyEpoch: 'test-epoch',
      idempotencyKey: expect.any(String)
    })
  })
  await expect(
    sidecar.invokeDesktopCore(
      windowId,
      DESKTOP_IPC.settingsResetKey,
      [{ commandId: 'terminal.new' }],
      emit
    )
  ).resolves.toMatchObject({ handled: true, value: { revision: 43 } })
  expect(resetShortcut).toHaveBeenCalledWith({
    windowId,
    commandId: 'terminal.new',
    mutation: expect.objectContaining({
      expectedRevision: 42,
      idempotencyEpoch: 'test-epoch',
      idempotencyKey: expect.any(String)
    })
  })
  await expect(
    sidecar.invokeDesktopCore(windowId, DESKTOP_IPC.settingsUpdate, [{}], emit)
  ).rejects.toThrow()
  expect(updateSettings).toHaveBeenCalledOnce()
  expect(getSettings).toHaveBeenCalledOnce()
  expect(emit).not.toHaveBeenCalled()
})

it('keeps Files descriptors and documents within the sender window and current placement', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  Object.assign(sidecar, { terminalSockets: new Map(), remoteTerminals: new Map() })
  const windowA = '00000000-0000-4000-8000-000000000001'
  const windowB = '00000000-0000-4000-8000-000000000002'
  const workspaceA = '00000000-0000-4000-8000-000000000011'
  const workspaceB = '00000000-0000-4000-8000-000000000012'
  const directoryA = '00000000-0000-4000-8000-000000000021'
  const directoryB = '00000000-0000-4000-8000-000000000022'
  const fileA = '00000000-0000-4000-8000-000000000031'
  const document = { documentId: '00000000-0000-4000-8000-000000000041', identityVersion: 1 }
  const placements = [
    { id: windowA, workspaceIds: [workspaceA] },
    { id: windowB, workspaceIds: [workspaceB] }
  ]
  const listContentRoots = vi.fn().mockResolvedValue({
    roots: [
      {
        rootId: workspaceA,
        directoryDescriptorId: directoryA,
        workspaceId: workspaceA,
        label: 'A',
        generation: 1
      },
      {
        rootId: workspaceB,
        directoryDescriptorId: directoryB,
        workspaceId: workspaceB,
        label: 'B',
        generation: 1
      }
    ],
    nextCursor: null
  })
  const listContentDirectory = vi.fn().mockResolvedValue({
    entries: [{ entryDescriptorId: fileA, kind: 'file', label: 'notes.md', generation: 1 }],
    nextCursor: null
  })
  const issueContentDocument = vi.fn().mockResolvedValue({ document, displayName: 'notes.md' })
  const readContent = vi.fn().mockResolvedValue({
    kind: 'text',
    chunk: {
      document,
      offset: 0,
      text: '# Notes',
      eof: true,
      contentRevision: 1,
      displayName: 'notes.md'
    }
  })
  const renderMarkdown = vi.fn().mockResolvedValue({ document, nodes: [], contentRevision: 1 })
  const diffContent = vi.fn().mockResolvedValue({ lines: [], truncated: false })
  sidecar.client = {
    stateSnapshot: vi
      .fn()
      .mockImplementation(async () => ({ snapshot: { windowPlacements: placements } })),
    listContentRoots,
    listContentDirectory,
    issueContentDocument,
    readContent,
    renderMarkdown,
    diffContent
  } as unknown as NodeSidecar['client']
  const invoke = (windowId: string, channel: string, arg?: unknown) =>
    sidecar.invokeDesktopCore(windowId, channel, arg === undefined ? [] : [arg], vi.fn())

  await expect(invoke(windowA, DESKTOP_IPC.contentRootList)).resolves.toMatchObject({
    handled: true,
    value: { roots: [{ workspaceId: workspaceA }], nextCursor: null }
  })
  await expect(invoke(windowB, DESKTOP_IPC.contentRootList)).resolves.toMatchObject({
    value: { roots: [{ workspaceId: workspaceB }] }
  })
  expect(listContentRoots).toHaveBeenCalledWith({ limit: 64 })
  const directoryRequest = {
    directoryDescriptorId: directoryA,
    generation: 1,
    limit: 10,
    cancellationId: fileA
  }
  await expect(invoke(windowB, DESKTOP_IPC.contentDirectoryList, directoryRequest)).rejects.toThrow(
    'descriptor is unavailable in this window'
  )
  await expect(
    invoke(windowA, DESKTOP_IPC.contentDirectoryList, directoryRequest)
  ).resolves.toMatchObject({
    value: { entries: [{ entryDescriptorId: fileA }] }
  })
  const issueRequest = {
    authorizedDescriptorId: fileA,
    descriptorGeneration: 1,
    expectedKind: 'markdown'
  }
  await expect(
    invoke(windowA, DESKTOP_IPC.contentDocumentIssue, issueRequest)
  ).resolves.toMatchObject({
    value: { document }
  })
  const readRequest = { document, offset: 0, maxBytes: 1024 }
  await expect(invoke(windowB, DESKTOP_IPC.contentRead, readRequest)).rejects.toThrow(
    'document is unavailable in this window'
  )
  await expect(invoke(windowA, DESKTOP_IPC.contentRead, readRequest)).resolves.toMatchObject({
    value: { kind: 'text', chunk: { text: '# Notes' } }
  })
  await expect(invoke(windowA, DESKTOP_IPC.contentMarkdown, { document })).resolves.toMatchObject({
    value: { document, nodes: [] }
  })
  await expect(
    invoke(windowA, DESKTOP_IPC.contentDiff, { before: document, after: document, maxBytes: 1024 })
  ).resolves.toMatchObject({
    value: { lines: [] }
  })
  placements[0]!.workspaceIds = []
  await expect(invoke(windowA, DESKTOP_IPC.contentRead, readRequest)).rejects.toThrow(
    'workspace is unavailable in this window'
  )
  await expect(invoke(windowA, DESKTOP_IPC.contentDirectoryList, directoryRequest)).rejects.toThrow(
    'workspace is unavailable in this window'
  )
  expect(readContent).toHaveBeenCalledOnce()
  expect(listContentDirectory).toHaveBeenCalledOnce()
  expect(issueContentDocument).toHaveBeenCalledOnce()
  expect(renderMarkdown).toHaveBeenCalledOnce()
  expect(diffContent).toHaveBeenCalledOnce()
  placements[0]!.workspaceIds = [workspaceA]
  sidecar.releaseWindowResources(windowA)
  await expect(invoke(windowA, DESKTOP_IPC.contentRead, readRequest)).rejects.toThrow(
    'document is unavailable in this window'
  )
})

it('grants search previews only for workspace results owned by the requesting window', async () => {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const windowA = randomUUID(),
    windowB = randomUUID()
  const workspaceA = randomUUID(),
    workspaceB = randomUUID()
  const sessionA = randomUUID(),
    sessionB = randomUUID()
  const documentA = { documentId: randomUUID(), identityVersion: 1 }
  const documentB = { documentId: randomUUID(), identityVersion: 1 }
  const result = (document: typeof documentA, sourceAuthorizationId: string) => ({
    document,
    sourceAuthorizationId,
    sourceKind: 'workspaceFile' as const,
    snippet: 'violet',
    indexedAtMs: 1
  })
  const readContent = vi.fn().mockResolvedValue({
    kind: 'text',
    chunk: {
      document: documentA,
      text: 'violet',
      displayName: 'wanted.txt',
      offset: 0,
      eof: true,
      contentRevision: 1
    }
  })
  Object.assign(sidecar, { encryptedSearchEnabled: true })
  const searchContent = vi
    .fn()
    .mockImplementation(async (params: { limit: number; sourceAuthorizationIds?: string[] }) => ({
      results: [result(documentB, workspaceB), result(documentA, workspaceA)]
        .filter((item) => params.sourceAuthorizationIds?.includes(item.sourceAuthorizationId))
        .slice(0, params.limit),
      truncated: false
    }))
  sidecar.client = {
    searchContent,
    listAgentCatalog: vi.fn().mockResolvedValue({
      sessions: [
        { binding: { agentSessionId: sessionA, workspaceId: workspaceA } },
        { binding: { agentSessionId: sessionB, workspaceId: workspaceB } }
      ]
    }),
    stateSnapshot: vi.fn().mockResolvedValue({
      snapshot: {
        windowPlacements: [
          { id: windowA, workspaceIds: [workspaceA] },
          { id: windowB, workspaceIds: [workspaceB] }
        ]
      }
    }),
    readContent
  } as unknown as NodeSidecar['client']
  const invoke = (windowId: string, channel: string, arg: unknown) =>
    sidecar.invokeDesktopCore(windowId, channel, [arg], vi.fn())
  const query = {
    query: 'violet',
    limit: 1,
    cancellationId: randomUUID(),
    sourceAuthorizationIds: [workspaceB]
  }
  await expect(invoke(windowA, DESKTOP_IPC.searchQuery, query)).resolves.toMatchObject({
    value: { results: [{ document: documentA }] }
  })
  await expect(
    invoke(windowA, DESKTOP_IPC.contentRead, {
      document: documentA,
      offset: 0,
      maxBytes: 1024
    })
  ).resolves.toMatchObject({ value: { kind: 'text' } })
  await expect(
    invoke(windowA, DESKTOP_IPC.contentRead, {
      document: documentB,
      offset: 0,
      maxBytes: 1024
    })
  ).rejects.toThrow('document is unavailable in this window')
  await expect(invoke(windowB, DESKTOP_IPC.searchQuery, query)).resolves.toMatchObject({
    value: { results: [{ document: documentB }] }
  })
  expect(searchContent).toHaveBeenNthCalledWith(1, {
    ...query,
    sourceAuthorizationIds: [workspaceA, sessionA]
  })
  expect(searchContent).toHaveBeenNthCalledWith(2, {
    ...query,
    sourceAuthorizationIds: [workspaceB, sessionB]
  })
  expect(readContent).toHaveBeenCalledOnce()
})

it.skipIf(process.env.RUN_NODE_SIDECAR_HANDOFF !== '1')(
  'stops the isolated writer and fails closed after the real utility rejects a key',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'node-sidecar-handoff-'))
    const sourcePath = join(directory, 'source.sqlite3')
    const backupPath = join(directory, 'backup.sqlite3')
    const workingPath = join(directory, 'working.sqlite3')
    const keyPath = join(directory, 'invalid-key')
    let sidecar: NodeSidecar | undefined
    try {
      execFileSync(
        'cargo',
        [
          'run',
          '--quiet',
          '-p',
          'agent-workspace-storage',
          '--example',
          'create_schema_v15_fixture',
          '--',
          sourcePath,
          'rich-remote-catalog'
        ],
        { cwd: repository, timeout: 300_000, stdio: 'pipe' }
      )
      const key = await open(
        keyPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      )
      try {
        await key.writeFile('not an OpenSSH key\n')
      } finally {
        await key.close()
      }
      const serverPath = join(repository, 'apps/server/dist/bin.mjs')
      sidecar = await NodeSidecar.start({
        serverPath,
        executable: join(repository, 'target/node-linux/bin/node'),
        sourcePath,
        backupPath,
        workingPath,
        liveDatabasePath: join(directory, 'live.sqlite3')
      })
      expect((await sidecar.client.getRemoteTarget(targetId)).target.revision).toBe(2)
      const originalUrl = sidecar.baseUrl
      const descriptor = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await expect(
          sidecar.enrollExistingRemoteCredential(targetId, 2, descriptor.fd)
        ).rejects.toThrow('Node credential enrollment failed: cleanup_required')
      } finally {
        await descriptor.close()
      }
      expect(sidecar.baseUrl).toBe(originalUrl)
      await expect(sidecar.client.identify()).rejects.toThrow()
      expect((await readdir(directory)).some((entry) => entry.startsWith('.node-enroll-'))).toBe(
        false
      )
      await expect(lstat(`${workingPath}.owner.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      await sidecar.stop()
      sidecar = undefined
    } finally {
      await sidecar?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000
)

it.skipIf(process.env.RUN_NODE_SIDECAR_HANDOFF !== '1')(
  'resumes a changed isolated copy after a controlled offline utility handoff',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'node-sidecar-handoff-success-'))
    const serverDirectory = join(directory, 'server')
    const sourcePath = join(directory, 'source.sqlite3')
    const backupPath = join(directory, 'backup.sqlite3')
    const workingPath = join(directory, 'working.sqlite3')
    const keyPath = join(directory, 'test-key')
    let sidecar: NodeSidecar | undefined
    try {
      execFileSync(
        'cargo',
        [
          'run',
          '--quiet',
          '-p',
          'agent-workspace-storage',
          '--example',
          'create_schema_v15_fixture',
          '--',
          sourcePath,
          'rich-remote-catalog'
        ],
        { cwd: repository, timeout: 300_000, stdio: 'pipe' }
      )
      await mkdir(serverDirectory, { mode: 0o700 })
      await copyFile(join(repository, 'apps/server/dist/bin.mjs'), join(serverDirectory, 'bin.mjs'))
      await symlink(
        join(repository, 'apps/server/node_modules'),
        join(serverDirectory, 'node_modules')
      )
      await writeFile(
        join(serverDirectory, 'credential-enroll.mjs'),
        `
import { fstatSync, readFileSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
const request = JSON.parse(readFileSync(process.argv[3], 'utf8'))
const key = fstatSync(3)
const flags = /^flags:[ \\t]*([0-7]+)[ \\t]*$/m.exec(readFileSync('/proc/self/fdinfo/3', 'utf8'))
if (process.argv[2] !== '--request-file' || !key.isFile() || key.uid !== process.getuid() ||
    (key.mode & 0o077) !== 0 || !flags || (parseInt(flags[1], 8) & 3) !== 0) process.exit(2)
try { statSync(request.workingStatePath + '.owner.lock'); process.exit(3) } catch (error) {
  if (error.code !== 'ENOENT') process.exit(4)
}
const db = new Database(request.workingStatePath)
const changed = db.prepare('UPDATE remote_targets SET revision = revision + 1 WHERE remote_target_id = ? AND revision = ?')
  .run(request.targetId, request.expectedRevision)
db.close()
if (changed.changes !== 1) process.exit(5)
process.stdout.write(JSON.stringify({ status: 'stored', targetId: request.targetId,
  revision: request.expectedRevision + 1 }) + '\\n')
`
      )
      const key = await open(
        keyPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      )
      try {
        await key.writeFile('disposable test bytes\n')
      } finally {
        await key.close()
      }
      sidecar = await NodeSidecar.start({
        serverPath: join(serverDirectory, 'bin.mjs'),
        executable: join(repository, 'target/node-linux/bin/node'),
        sourcePath,
        backupPath,
        workingPath,
        liveDatabasePath: join(directory, 'live.sqlite3')
      })
      const descriptor = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        expect(await sidecar.enrollExistingRemoteCredential(targetId, 2, descriptor.fd)).toEqual({
          status: 'stored',
          targetId,
          revision: 3
        })
      } finally {
        await descriptor.close()
      }
      expect((await sidecar.client.getRemoteTarget(targetId)).target.revision).toBe(3)
      expect((await lstat(`${workingPath}.owner.lock`)).isFile()).toBe(true)
      expect((await readdir(directory)).some((entry) => entry.startsWith('.node-enroll-'))).toBe(
        false
      )
      await sidecar.stop()
      sidecar = undefined
      await expect(lstat(`${workingPath}.owner.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await sidecar?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000
)
