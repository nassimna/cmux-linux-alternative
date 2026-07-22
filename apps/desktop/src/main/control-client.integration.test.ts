import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { TerminalEventMessage } from '@agent-workspace/protocol-client'

import { ControlClient } from './control-client'
import { APPLICATION_ID, SERVICE_BINARY_NAME } from './identity'
import { ServiceSupervisor } from './service-supervisor'

const supervisors: ServiceSupervisor[] = []

afterEach(async () => {
  for (const supervisor of supervisors) {
    await supervisor.stop()
  }
  supervisors.length = 0
})

describe('desktop to service protocol', () => {
  it('authenticates and identifies the real Rust service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-protocol-'))
    const endpoint =
      process.platform === 'win32'
        ? `agent-workspace-test-${process.pid}`
        : join(directory, 'control.sock')
    const executable =
      process.platform === 'win32' ? `${SERVICE_BINARY_NAME}.exe` : SERVICE_BINARY_NAME
    const servicePath = resolve(process.cwd(), '..', '..', 'target', 'debug', executable)
    const token = '0123456789abcdef0123456789abcdef0123456789abcdef'
    const supervisor = new ServiceSupervisor(
      endpoint,
      token,
      servicePath,
      join(directory, 'state', 'workspace.sqlite'),
      directory
    )
    supervisors.push(supervisor)

    try {
      const client = await supervisor.start()
      const identity = await client.identify()

      expect(identity.application).toBe(APPLICATION_ID)
      expect(identity.protocolVersion).toBe(1)
      expect(identity.capabilities).toEqual(
        expect.arrayContaining([
          'system.identify',
          'terminal.attach',
          'terminal.events',
          'terminal.runtimeMetadata',
          'tab.openTerminal'
        ])
      )
      expect(identity.capabilities).not.toContain('terminal.create')
      expect(identity.capabilities).not.toContain('terminal.terminate')
    } finally {
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)

  it('reattaches to a live PTY and reconstructs checkpointed output without new output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-terminal-'))
    const endpoint =
      process.platform === 'win32'
        ? `agent-workspace-terminal-${process.pid}`
        : join(directory, 'control.sock')
    const executable =
      process.platform === 'win32' ? `${SERVICE_BINARY_NAME}.exe` : SERVICE_BINARY_NAME
    const servicePath = resolve(process.cwd(), '..', '..', 'target', 'debug', executable)
    const token = 'abcdef0123456789abcdef0123456789abcdef0123456789'
    const supervisor = new ServiceSupervisor(
      endpoint,
      token,
      servicePath,
      join(directory, 'state', 'workspace.sqlite'),
      directory
    )
    supervisors.push(supervisor)
    let reloadedClient: ControlClient | undefined

    try {
      const client = await supervisor.start()
      const bootstrapProof = supervisor.getDesktopBootstrapProof()
      if (!bootstrapProof) throw new Error('The desktop-provider bootstrap proof is missing')
      const windows = await client.listWindows()
      const window = windows.windows.find(({ windowId }) => windowId === windows.focusedWindowId)
      if (!window) throw new Error('The focused window placement is missing')
      const claim = { windowId: window.windowId, generation: 1 }
      const registration = await client.registerDesktopProvider({
        bootstrapProof,
        instanceId: '10000000-0000-4000-8000-000000000001',
        capabilities: ['window-host-v1', 'tab-transfer-v1', 'browser-transfer-v1'],
        windows: [claim]
      })
      const identity = {
        providerId: registration.providerId,
        providerEpoch: registration.providerEpoch,
        leaseId: registration.leaseId
      }
      await client.bindWindow({ identity, window: claim })
      const { terminalId, tabId, workspaceId } = await openManagedTestTerminal(client, directory)
      await client.attachTerminal(terminalId)

      const firstOutput = waitForTerminalOutput(client, terminalId, 'before-reload')
      await client.sendTerminalInput(
        terminalId,
        process.platform === 'win32' ? 'echo before-reload\r\n' : 'before-reload\n'
      )
      const first = await firstOutput
      await client.checkpointTerminal(terminalId, {
        sequence: first.sequence,
        rows: 24,
        cols: 80,
        activeBuffer: 'normal',
        data: 'serialized-before-reload'
      })

      reloadedClient = new ControlClient(endpoint, token)
      await reloadedClient.connect()
      await reloadedClient.bindWindow({ identity, window: claim })
      let receivedWhileDetached = false
      const removeDetachedListener = reloadedClient.onTerminalEvent((event) => {
        if (event.event === 'terminal.output' && event.data.terminalId === terminalId) {
          receivedWhileDetached = true
        }
      })
      const journalOutput = waitForTerminalOutput(client, terminalId, 'journal-before-attach')
      await client.sendTerminalInput(
        terminalId,
        process.platform === 'win32' ? 'echo journal-before-attach\r\n' : 'journal-before-attach\n'
      )
      await journalOutput
      await delay(50)
      expect(receivedWhileDetached).toBe(false)
      removeDetachedListener()

      const snapshot = await reloadedClient.attachTerminal(terminalId)
      await expect(reloadedClient.getTerminalRuntimeMetadata(terminalId)).resolves.toEqual({
        terminalId,
        listeningPorts: []
      })
      const replayed = snapshot.output
        .map((chunk) => Buffer.from(chunk.data, 'base64').toString('utf8'))
        .join('')

      expect(snapshot.terminal.id).toBe(terminalId)
      expect(snapshot.terminal.exited).toBe(false)
      expect(snapshot.checkpoint?.data).toBe('serialized-before-reload')
      expect(replayed).toContain('journal-before-attach')

      const attachedOutput = waitForTerminalOutput(
        reloadedClient,
        terminalId,
        'visible-after-attach'
      )
      await client.sendTerminalInput(
        terminalId,
        process.platform === 'win32' ? 'echo visible-after-attach\r\n' : 'visible-after-attach\n'
      )
      await attachedOutput

      await reloadedClient.detachTerminal(terminalId)
      let receivedAfterDetach = false
      const removeAfterDetachListener = reloadedClient.onTerminalEvent((event) => {
        if (event.event === 'terminal.output' && event.data.terminalId === terminalId) {
          receivedAfterDetach = true
        }
      })
      const originalOutput = waitForTerminalOutput(client, terminalId, 'hidden-after-detach')
      await client.sendTerminalInput(
        terminalId,
        process.platform === 'win32' ? 'echo hidden-after-detach\r\n' : 'hidden-after-detach\n'
      )
      await originalOutput
      await delay(50)
      removeAfterDetachListener()
      expect(receivedAfterDetach).toBe(false)
      await reloadedClient.closeTab({ workspaceId, tabId })
    } finally {
      reloadedClient?.close()
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)

  it('reports a native TCP listener owned by a managed terminal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-listener-'))
    const endpoint =
      process.platform === 'win32'
        ? `agent-workspace-listener-${process.pid}`
        : join(directory, 'control.sock')
    const executable =
      process.platform === 'win32' ? `${SERVICE_BINARY_NAME}.exe` : SERVICE_BINARY_NAME
    const servicePath = resolve(process.cwd(), '..', '..', 'target', 'debug', executable)
    const supervisor = new ServiceSupervisor(
      endpoint,
      'fedcba9876543210fedcba9876543210fedcba9876543210',
      servicePath,
      join(directory, 'state', 'workspace.sqlite'),
      directory
    )
    supervisors.push(supervisor)

    try {
      const client = await supervisor.start()
      const listenerProgram = [
        "const net = require('node:net')",
        'const server = net.createServer()',
        "server.listen(0, '127.0.0.1')"
      ].join(';')
      const { terminalId, tabId, workspaceId } = await openManagedTestTerminal(client, directory, [
        process.execPath,
        '-e',
        listenerProgram
      ])

      const metadata = await waitForListeningPorts(client, terminalId)
      expect(metadata.terminalId).toBe(terminalId)
      expect(metadata.listeningPorts).toHaveLength(1)
      expect(metadata.listeningPorts[0]).toBeGreaterThan(0)
      await client.closeTab({ workspaceId, tabId })
    } finally {
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)
})

async function openManagedTestTerminal(
  client: ControlClient,
  workingDirectory: string,
  command?: string[]
): Promise<{ terminalId: string; tabId: string; workspaceId: string }> {
  const initial = (await client.listWorkspaces()).snapshot
  const workspace = initial.workspaces.find(({ id }) => id === initial.selectedWorkspaceId)
  if (!workspace) throw new Error('The selected workspace is missing')

  const result = await client.openTerminalTab({
    workspaceId: workspace.id,
    paneId: workspace.selectedPaneId,
    launch: {
      cwd: workingDirectory,
      rows: 24,
      cols: 80,
      command:
        command ??
        (process.platform === 'win32'
          ? ['cmd.exe', '/Q']
          : ['/bin/sh', '-c', 'stty -echo; exec /bin/cat'])
    }
  })
  const updated = result.snapshot.workspaces.find(({ id }) => id === workspace.id)
  const pane = updated?.panes.find(({ id }) => id === workspace.selectedPaneId)
  const tab = updated?.tabs.find(({ id }) => id === pane?.selectedTabId)
  const terminalId = tab?.content.kind === 'terminal' ? tab.content.runtimeSessionId : undefined
  if (!pane || !tab || !terminalId) throw new Error('The managed terminal was not created')

  return { terminalId, tabId: tab.id, workspaceId: workspace.id }
}

async function waitForListeningPorts(client: ControlClient, terminalId: string) {
  const deadline = Date.now() + 5_000
  do {
    const metadata = await client.getTerminalRuntimeMetadata(terminalId)
    if (metadata.listeningPorts.length > 0) return metadata
    await delay(50)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for terminal listening-port metadata')
}

function waitForTerminalOutput(
  client: ControlClient,
  terminalId: string,
  expected: string
): Promise<{ sequence: number; text: string }> {
  return new Promise((resolveOutput, rejectOutput) => {
    let text = ''
    let removeListener = (): void => undefined
    const timeout = setTimeout(() => {
      removeListener()
      rejectOutput(new Error(`Timed out waiting for terminal output: ${expected}`))
    }, 5_000)
    removeListener = client.onTerminalEvent((event: TerminalEventMessage) => {
      if (event.event !== 'terminal.output' || event.data.terminalId !== terminalId) {
        return
      }
      text += Buffer.from(event.data.chunk.data, 'base64').toString('utf8')
      if (text.includes(expected)) {
        clearTimeout(timeout)
        removeListener()
        resolveOutput({ sequence: event.data.chunk.sequence, text })
      }
    })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
