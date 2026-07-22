import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, hostname, release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import type { TerminalEventMessage } from '@agent-workspace/protocol-client'

import type { ControlClient } from './control-client'
import { SERVICE_BINARY_NAME } from './identity'
import { ServiceSupervisor } from './service-supervisor'

const WARMUP_ITERATIONS = 10
const MEASURED_ITERATIONS = 40
const DISPATCH_P95_TARGET_MS = 10
const PERCEIVED_ECHO_P95_TARGET_MS = 50
const OUTPUT_TIMEOUT_MS = 2_000

describe('desktop to service terminal responsiveness', () => {
  it('keeps warmed PTY dispatch acknowledgements and perceived echo within Milestone 1 gates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-performance-'))
    const endpoint =
      process.platform === 'win32'
        ? `agent-workspace-performance-${process.pid}`
        : join(directory, 'control.sock')
    const executable =
      process.platform === 'win32' ? `${SERVICE_BINARY_NAME}.exe` : SERVICE_BINARY_NAME
    const servicePath = resolve(process.cwd(), '..', '..', 'target', 'release', executable)
    const token = '13579bdf2468ace013579bdf2468ace013579bdf2468ace0'
    const supervisor = new ServiceSupervisor(
      endpoint,
      token,
      servicePath,
      join(directory, 'state', 'workspace.sqlite'),
      directory
    )
    let client: ControlClient | undefined
    let terminalId: string | undefined
    let tabId: string | undefined
    let workspaceId: string | undefined

    try {
      client = await supervisor.start()
      const bootstrapProof = supervisor.getDesktopBootstrapProof()
      if (!bootstrapProof) throw new Error('The desktop-provider bootstrap proof is missing')
      const topology = await client.listWindows()
      const placement = topology.windows.find(
        ({ windowId }) => windowId === topology.focusedWindowId
      )
      if (!placement) throw new Error('The focused window placement is missing')
      const claim = { windowId: placement.windowId, generation: 1 }
      const registration = await client.registerDesktopProvider({
        bootstrapProof,
        instanceId: '14000000-0000-4000-8000-000000000001',
        capabilities: ['window-host-v1', 'tab-transfer-v1', 'browser-transfer-v1'],
        windows: [claim]
      })
      await client.bindWindow({
        identity: {
          providerId: registration.providerId,
          providerEpoch: registration.providerEpoch,
          leaseId: registration.leaseId
        },
        window: claim
      })
      const initial = (await client.listWorkspaces()).snapshot
      const workspace = initial.workspaces.find(({ id }) => id === initial.selectedWorkspaceId)
      if (!workspace) throw new Error('The selected workspace is missing')
      const result = await client.openTerminalTab({
        workspaceId: workspace.id,
        paneId: workspace.selectedPaneId,
        launch: {
          cwd: directory,
          rows: 24,
          cols: 80,
          command:
            process.platform === 'win32'
              ? ['cmd.exe', '/D', '/Q']
              : ['/bin/sh', '-c', 'stty -echo; exec /bin/cat']
        }
      })
      const updated = result.snapshot.workspaces.find(({ id }) => id === workspace.id)
      const pane = updated?.panes.find(({ id }) => id === workspace.selectedPaneId)
      const tab = updated?.tabs.find(({ id }) => id === pane?.selectedTabId)
      terminalId = tab?.content.kind === 'terminal' ? tab.content.runtimeSessionId : undefined
      if (!tab || !terminalId) throw new Error('The managed terminal was not created')
      workspaceId = workspace.id
      tabId = tab.id
      await client.attachTerminal(terminalId)

      for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) {
        await measureInput(client, terminalId, markerFor('warmup', iteration))
        await measureResize(client, terminalId, iteration)
      }

      const inputAcknowledgements: number[] = []
      const perceivedEchoes: number[] = []
      const resizeAcknowledgements: number[] = []
      for (let iteration = 0; iteration < MEASURED_ITERATIONS; iteration += 1) {
        const input = await measureInput(client, terminalId, markerFor('measured', iteration))
        inputAcknowledgements.push(input.acknowledgementMs)
        perceivedEchoes.push(input.echoMs)
        resizeAcknowledgements.push(await measureResize(client, terminalId, iteration))
      }

      const inputSummary = summarize(inputAcknowledgements)
      const echoSummary = summarize(perceivedEchoes)
      const resizeSummary = summarize(resizeAcknowledgements)
      console.info(
        `[terminal-performance] build=release environment=${process.env.CI ? 'ci' : 'local'} ` +
          `platform=${process.platform}-${process.arch} cpus=${String(availableParallelism())} ` +
          `node=${process.version} samples=${String(MEASURED_ITERATIONS)} ` +
          `input-ack=${formatSummary(inputSummary)} ` +
          `input-to-output=${formatSummary(echoSummary)} ` +
          `resize-ack=${formatSummary(resizeSummary)}`
      )

      if (process.env.AGENT_WORKSPACE_PTY_RESULT) {
        await writeFile(
          process.env.AGENT_WORKSPACE_PTY_RESULT,
          `${JSON.stringify(
            {
              metrics: [
                resultMetric('pty.dispatch', inputAcknowledgements, DISPATCH_P95_TARGET_MS),
                resultMetric('pty.perceived_echo', perceivedEchoes, PERCEIVED_ECHO_P95_TARGET_MS),
                resultMetric('pty.resize_dispatch', resizeAcknowledgements, DISPATCH_P95_TARGET_MS)
              ],
              scenarios: [
                'rapid typing through a release service PTY',
                'repeated PTY resize dispatch'
              ]
            },
            null,
            2
          )}\n`
        )
      }

      // These acknowledgements cover ControlClient serialization, the authenticated local
      // socket, service dispatch, and completion of the PTY write/OS resize operation.
      expect(inputSummary.p95).toBeLessThanOrEqual(DISPATCH_P95_TARGET_MS)
      expect(resizeSummary.p95).toBeLessThanOrEqual(DISPATCH_P95_TARGET_MS)
      // Unix disables the terminal driver's local echo, so this measures input through the
      // child process and terminal.output delivery. On Windows, cmd.exe /Q output is the
      // closest available cross-platform integration path and can include console echo.
      expect(echoSummary.p95).toBeLessThanOrEqual(PERCEIVED_ECHO_P95_TARGET_MS)
    } finally {
      if (client && workspaceId && tabId) {
        await client.closeTab({ workspaceId, tabId }).catch(() => undefined)
      }
      await supervisor.stop()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)
})

async function measureInput(
  client: ControlClient,
  terminalId: string,
  marker: string
): Promise<{ acknowledgementMs: number; echoMs: number }> {
  const startedAt = performance.now()
  const outputAt = waitForTerminalOutput(client, terminalId, marker)
  const data = process.platform === 'win32' ? `echo ${marker}\r\n` : `${marker}\n`
  await client.sendTerminalInput(terminalId, data)
  const acknowledgedAt = performance.now()

  return {
    acknowledgementMs: acknowledgedAt - startedAt,
    echoMs: (await outputAt) - startedAt
  }
}

async function measureResize(
  client: ControlClient,
  terminalId: string,
  iteration: number
): Promise<number> {
  const startedAt = performance.now()
  await client.resizeTerminal(terminalId, 24 + (iteration % 2), 80 + (iteration % 3))
  return performance.now() - startedAt
}

function waitForTerminalOutput(
  client: ControlClient,
  terminalId: string,
  expected: string
): Promise<number> {
  return new Promise((resolveOutput, rejectOutput) => {
    let text = ''
    let removeListener = (): void => undefined
    const timeout = setTimeout(() => {
      removeListener()
      rejectOutput(new Error(`Timed out waiting for terminal output: ${expected}`))
    }, OUTPUT_TIMEOUT_MS)
    removeListener = client.onTerminalEvent((event: TerminalEventMessage) => {
      if (event.event !== 'terminal.output' || event.data.terminalId !== terminalId) {
        return
      }
      text += Buffer.from(event.data.chunk.data, 'base64').toString('utf8')
      if (text.includes(expected)) {
        clearTimeout(timeout)
        removeListener()
        resolveOutput(performance.now())
      }
    })
  })
}

function markerFor(phase: string, iteration: number): string {
  return `__agent_workspace_${phase}_${String(iteration).padStart(2, '0')}__`
}

function summarize(samples: readonly number[]): { p50: number; p95: number } {
  const ordered = [...samples].sort((left, right) => left - right)
  return {
    p50: percentile(ordered, 0.5),
    p95: percentile(ordered, 0.95)
  }
}

function percentile(orderedSamples: readonly number[], percentileValue: number): number {
  const index = Math.ceil(percentileValue * orderedSamples.length) - 1
  return orderedSamples[Math.max(0, index)] ?? Number.NaN
}

function formatSummary(summary: { p50: number; p95: number }): string {
  return `p50:${summary.p50.toFixed(2)}ms,p95:${summary.p95.toFixed(2)}ms`
}

function resultMetric(id: string, samples: readonly number[], target: number): object {
  const summary = summarize(samples)
  return {
    id,
    unit: 'ms',
    samples,
    summary: {
      min: Math.min(...samples),
      p50: summary.p50,
      p95: summary.p95,
      max: Math.max(...samples)
    },
    threshold: { operator: '<=', statistic: 'p95', value: target },
    gate: 'required',
    passed: summary.p95 <= target,
    notes: [
      `release service on ${process.platform}-${process.arch}`,
      `kernel ${release()}; host ${hostname()}`
    ]
  }
}
