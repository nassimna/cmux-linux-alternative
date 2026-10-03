import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { chromium, expect, test } from '@playwright/test'

import {
  FULL_SOAK_MS,
  SOAK_SAMPLE_COUNT,
  SOAK_SAMPLE_INTERVAL_MS,
  aggregateProcessTreeMemory,
  measureProcessTreeCpu,
  metric,
  validateFragment
} from '../scripts/performance/result.mjs'
import { createBrowserTestServer } from './helpers/browser-test-server.mjs'

const execFileAsync = promisify(execFile)
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const packagedExecutable = join(repositoryDirectory, 'release', 'linux-unpacked', 'agent-workspace')
const packagedCli = join(
  repositoryDirectory,
  'release',
  'linux-unpacked',
  'resources',
  'node-linux',
  'bin',
  'agent-workspace-node.mjs'
)
const mode = process.env.AGENT_WORKSPACE_PERFORMANCE_MODE ?? 'smoke'
const IDLE_SETTLE_MS = 5 * 60_000
const IDLE_SAMPLE_MS = 5 * 60_000
const HIGH_OUTPUT_TIMEOUT_MS = 2 * 60_000

test.beforeAll(() => {
  if (process.platform !== 'linux') throw new Error('The procfs performance suite is Linux-only.')
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('The release performance suite requires an X11 or Wayland display.')
  }
  if (!['smoke', 'soak'].includes(mode)) throw new Error(`Unknown performance mode: ${mode}`)
})

// Playwright requires an object destructuring pattern even without a browser fixture.
// eslint-disable-next-line no-empty-pattern
test('qualifies the packaged release under representative desktop load', async ({}) => {
  test.setTimeout(mode === 'soak' ? FULL_SOAK_MS + 30 * 60_000 : 20 * 60_000)
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-performance-e2e-'))
  const coldSamples = []
  const warmSamples = []
  const metrics = []
  const scenarios = []
  const browserServer = await createBrowserTestServer()
  let application
  let page

  try {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const profile = join(root, `cold-${iteration}`)
      const launched = await launch(profile)
      coldSamples.push(launched.interactiveMs)
      await launched.application.close()
    }
    metrics.push(
      metric({
        id: 'launch.cold_interactive',
        unit: 'ms',
        samples: coldSamples,
        threshold: { operator: '<=', statistic: 'p95', value: 2_500 },
        gate: 'informational',
        notes: [
          'Packaged executable to visible terminal; three samples are too few for a release gate.'
        ]
      })
    )
    scenarios.push('cold packaged release launch')

    const warmProfile = join(root, 'warm-restored')
    const seeded = await launch(warmProfile)
    await seeded.application.close()
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const launched = await launch(warmProfile)
      warmSamples.push(launched.interactiveMs)
      if (iteration < 2) await launched.application.close()
      else ({ application, page } = launched)
    }
    metrics.push(
      metric({
        id: 'launch.warm_restored_visible',
        unit: 'ms',
        samples: warmSamples,
        threshold: { operator: '<=', statistic: 'p95', value: 1_500 },
        gate: 'informational',
        notes: [
          'Same persisted profile; packaged process fully stopped between samples.',
          'Informational because compositor and shared-runner noise dominate short launch samples.'
        ]
      })
    )
    scenarios.push('warm restored packaged release launch')

    const rootPid = application.process().pid
    await page.waitForTimeout(IDLE_SETTLE_MS)
    const idleStartedAt = new Date().toISOString()
    const idleCpu = await measureProcessTreeCpu(rootPid, {
      durationMs: IDLE_SAMPLE_MS,
      sampleIntervalMs: 1_000,
      maxInvalidatedAttempts: 1
    })
    const idleCompletedAt = new Date().toISOString()
    metrics.push(
      metric({
        id: 'idle.process_tree_cpu_average',
        unit: '%',
        samples: [idleCpu.averageCpuPercent],
        threshold: { operator: '<', statistic: 'p95', value: 1 },
        gate: 'required',
        notes: [
          'Five-minute quiet settle followed by a five-minute measured idle window.',
          'Application jiffies are divided by aggregate /proc/stat jiffies and multiplied by the online CPU count; no CLK_TCK assumption.',
          `started=${idleStartedAt} completed=${idleCompletedAt} online CPUs=${idleCpu.cpuCount}`,
          `application jiffies=${idleCpu.applicationJiffies} system jiffies=${idleCpu.systemJiffies}`,
          `process counts=${idleCpu.processCounts.join(',')} new process counts=${idleCpu.newProcessCounts.join(',')}`,
          `invalidated complete windows=${idleCpu.invalidatedAttempts}`
        ]
      })
    )
    metrics.push(
      metric({
        id: 'idle.process_tree_cpu_intervals',
        unit: '%',
        samples: idleCpu.intervalCpuPercent,
        threshold: null,
        gate: 'informational',
        notes: [
          'Chronological approximately one-second process-tree CPU samples for auditing the required whole-window average.',
          'A disappearing process identity or PID reuse invalidates the measurement instead of silently undercounting.'
        ]
      })
    )
    scenarios.push('five-minute settled packaged idle CPU qualification')

    const oneTerminalMemory = await settledMemoryObservations(rootPid)
    addMemoryMetrics(metrics, 'memory.one_terminal', oneTerminalMemory, 350)
    scenarios.push('one-terminal settled application-memory qualification')

    const addedForTen = await createTerminalTabs(page, 9, warmProfile)
    await page.waitForTimeout(1_000)
    const tenTerminalMemory = await settledMemoryObservations(rootPid)
    addMemoryMetrics(metrics, 'memory.ten_terminals', tenTerminalMemory, 700)
    scenarios.push('ten-terminal settled application-memory qualification')

    const addedForThirty = await createTerminalTabs(page, 20, warmProfile)
    await page.waitForTimeout(1_000)
    const thirtyTerminalMemory = await settledMemoryObservations(rootPid)
    addMemoryMetrics(metrics, 'memory.thirty_terminals', thirtyTerminalMemory, null)

    const highOutputResult = await highOutput(page)
    metrics.push(
      metric({
        id: 'terminal.high_output_completion',
        unit: 'ms',
        samples: [highOutputResult.durationMs],
        threshold: null,
        gate: 'informational',
        notes: [
          '20,000 numbered lines followed by an observed service output marker.',
          `An unmeasured shell-ready round trip runs first; liveness timeout=${HIGH_OUTPUT_TIMEOUT_MS} ms.`,
          `authoritative resync recoveries=${highOutputResult.resyncCount}`
        ]
      })
    )
    scenarios.push('high terminal output')

    const slotStorm = await richCardSlotStorm(page)
    metrics.push(
      metric({
        id: 'card_slots_v2.storm_1000_replace',
        unit: 'ms',
        samples: [slotStorm.stormDurationMs],
        threshold: null,
        gate: 'informational',
        notes: [
          '1,000 bounded log-tail replacements through the packaged preload and authenticated control service.',
          `final slot revision=${slotStorm.finalRevision}`
        ]
      })
    )
    metrics.push(
      metric({
        id: 'card_slots_v2.storm_terminal_liveness',
        unit: 'ms',
        samples: [slotStorm.terminalDurationMs],
        threshold: { operator: '<=', statistic: 'p95', value: 5_000 },
        gate: 'required',
        notes: [
          'A terminal output marker is requested concurrently with the 1,000-slot replacement storm.',
          `authoritative terminal resync recoveries=${slotStorm.resyncCount}`
        ]
      })
    )
    scenarios.push('bounded v2 rich-card slot storm with concurrent PTY liveness')

    const closeStarted = performance.now()
    await closeTabs(page, [...addedForThirty, ...addedForTen])
    const teardownMs = performance.now() - closeStarted
    const afterTeardown = await aggregateProcessTreeMemory(rootPid)
    metrics.push(
      metric({
        id: 'terminal.thirty_teardown',
        unit: 'ms',
        samples: [teardownMs],
        threshold: null,
        gate: 'informational',
        notes: [
          `post-teardown PSS ${(afterTeardown.pssKiB / 1024).toFixed(2)} MiB`,
          `post-teardown aggregate RSS ${(afterTeardown.rssKiB / 1024).toFixed(2)} MiB`,
          `post-teardown private memory ${(afterTeardown.privateKiB / 1024).toFixed(2)} MiB`
        ]
      })
    )
    scenarios.push('30-terminal create and teardown')

    const resizeFps = await repeatedSplitResize(page, warmProfile)
    metrics.push(
      metric({
        id: 'split.resize_fps',
        unit: 'fps',
        samples: [resizeFps],
        threshold: { operator: '>=', statistic: 'p95', value: 50 },
        gate: 'informational',
        notes: ['60 authenticated pane resize mutations with requestAnimationFrame pacing.']
      })
    )
    scenarios.push('repeated split resize')

    const browserDurations = await browserViewLoop(page, browserServer.origin)
    metrics.push(
      metric({
        id: 'browser.view_cycle',
        unit: 'ms',
        samples: browserDurations,
        threshold: null,
        gate: 'informational',
        notes: ['Five native browser view create/visible/teardown cycles.']
      })
    )
    scenarios.push('browser view loop')

    const notificationDuration = await notificationStorm(warmProfile)
    metrics.push(
      metric({
        id: 'notifications.storm_100',
        unit: 'ms',
        samples: [notificationDuration],
        threshold: null,
        gate: 'informational',
        notes: ['100 notifications submitted through the packaged release CLI.']
      })
    )
    scenarios.push('notification storm')

    if (mode === 'soak') {
      const soak = await runFullSoak(page, rootPid)
      metrics.push(
        metric({
          id: 'soak.sample_elapsed',
          unit: 'ms',
          samples: soak.elapsedMs,
          threshold: null,
          gate: 'informational',
          notes: [
            'Monotonic elapsed time aligned by index with every soak memory observation.',
            `target duration=${FULL_SOAK_MS} sample interval=${SOAK_SAMPLE_INTERVAL_MS}`
          ]
        })
      )
      metrics.push(
        metric({
          id: 'soak.application_pss',
          unit: 'MiB',
          samples: soak.pssMiB,
          threshold: null,
          gate: 'manual',
          notes: [
            'Exactly eight hours; one chronological sample per minute plus final sample.',
            `first=${soak.pssMiB[0].toFixed(2)} MiB final=${soak.pssMiB.at(-1).toFixed(2)} MiB`,
            `timestamps=${soak.timestamps.join(',')}`
          ]
        })
      )
      metrics.push(
        metric({
          id: 'soak.aggregate_rss',
          unit: 'MiB',
          samples: soak.rssMiB,
          threshold: null,
          gate: 'informational',
          notes: ['Chronological summed VmRSS diagnostic aligned with soak PSS timestamps.']
        })
      )
      metrics.push(
        metric({
          id: 'soak.private_memory',
          unit: 'MiB',
          samples: soak.privateMiB,
          threshold: null,
          gate: 'informational',
          notes: [
            'Chronological Private_Clean + Private_Dirty diagnostic aligned with soak PSS timestamps.'
          ]
        })
      )
      scenarios.push('full 8-hour continuous output soak')
    } else {
      scenarios.push('8-hour output soak: not run in smoke mode')
    }

    const fragment = validateFragment({ metrics, scenarios })
    if (!process.env.AGENT_WORKSPACE_E2E_RESULT) {
      throw new Error(
        'AGENT_WORKSPACE_E2E_RESULT is required for durable machine-readable evidence.'
      )
    }
    await writeFile(
      process.env.AGENT_WORKSPACE_E2E_RESULT,
      `${JSON.stringify(fragment, null, 2)}\n`
    )
  } finally {
    await application?.close().catch(() => undefined)
    await browserServer.close().catch(() => undefined)
    await rm(root, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function launch(profile) {
  const runtime = join(profile, 'runtime')
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  await writeFile(join(profile, '.zshrc'), '# Isolated release performance shell.\n')
  const port = await reserveLoopbackPort()
  const started = performance.now()
  const child = spawn(
    packagedExecutable,
    [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--in-process-gpu'
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: profile,
        TMPDIR: runtime,
        XDG_RUNTIME_DIR: runtime,
        ZDOTDIR: profile,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    }
  )
  const output = []
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))
  await waitForCdp(port, child, output)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  await expect
    .poll(
      () =>
        context
          .pages()
          .find((candidate) => candidate.url() === 'agent-workspace://renderer/index.html'),
      { timeout: 20_000 }
    )
    .not.toBeUndefined()
  const page = context
    .pages()
    .find((candidate) => candidate.url() === 'agent-workspace://renderer/index.html')
  if (!page) throw new Error('Packaged renderer page missing')
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-process-id', /^\d+$/, {
    timeout: 20_000
  })
  const application = {
    process: () => child,
    close: async () => {
      await browser.close().catch(() => undefined)
      await stopProcessTree(child)
    }
  }
  return { application, page, interactiveMs: performance.now() - started }
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve CDP port')
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise()))
  )
  return address.port
}

async function waitForCdp(port, child, output) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited: ${output.join('')}`)
    try {
      const version = await new Promise((resolvePromise, reject) => {
        const request = get(`http://127.0.0.1:${port}/json/version`, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            try {
              resolvePromise(JSON.parse(Buffer.concat(chunks).toString()))
            } catch (error) {
              reject(error)
            }
          })
        })
        request.once('error', reject)
        request.setTimeout(1_000, () => request.destroy(new Error('CDP discovery timed out')))
      })
      if (version.webSocketDebuggerUrl) return
    } catch {
      /* Expected until the remote-debugging endpoint starts. */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`CDP did not start: ${output.join('')}`)
}

async function stopProcessTree(child) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error.code === 'ESRCH') return
    throw error
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function createTerminalTabs(page, count, cwd) {
  return page.evaluate(
    async ({ count: requested, cwd: directory }) => {
      const initial = await globalThis.desktopBridge.listWorkspaces()
      const workspace = initial.snapshot.workspaces.find(
        (item) => item.id === initial.snapshot.selectedWorkspaceId
      )
      if (!workspace) throw new Error('Selected workspace missing')
      const ids = []
      for (let index = 0; index < requested; index += 1) {
        const result = await globalThis.desktopBridge.openTerminalTab({
          workspaceId: workspace.id,
          paneId: workspace.selectedPaneId,
          launch: { cwd: directory, rows: 24, cols: 80 }
        })
        const updated = result.snapshot.workspaces.find((item) => item.id === workspace.id)
        const pane = updated?.panes.find((item) => item.id === workspace.selectedPaneId)
        if (!pane?.selectedTabId) throw new Error('Created terminal tab missing')
        ids.push(pane.selectedTabId)
      }
      return ids
    },
    { count, cwd }
  )
}

async function closeTabs(page, tabIds) {
  await page.evaluate(async (ids) => {
    const current = await globalThis.desktopBridge.listWorkspaces()
    const workspaceId = current.snapshot.selectedWorkspaceId
    for (const tabId of ids.reverse())
      await globalThis.desktopBridge.closeTab({ workspaceId, tabId })
  }, tabIds)
}

async function highOutput(page) {
  const terminalId = await selectedTerminalId(page)
  const readyMarker = `PERFORMANCE_SHELL_READY_${Date.now()}`
  await runTerminalCommand(
    page,
    terminalId,
    `${shellMarkerCommand(readyMarker)}\n`,
    readyMarker,
    30_000
  )
  const marker = `PERFORMANCE_OUTPUT_DONE_${Date.now()}`
  const started = performance.now()
  const result = await runTerminalCommand(
    page,
    terminalId,
    `seq 1 20000; ${shellMarkerCommand(marker)}\n`,
    marker,
    HIGH_OUTPUT_TIMEOUT_MS
  )
  return { durationMs: performance.now() - started, resyncCount: result.resyncCount }
}

async function richCardSlotStorm(page) {
  const terminalId = await selectedTerminalId(page)
  const marker = `CARD_SLOT_STORM_ALIVE_${Date.now()}`
  const terminalStarted = performance.now()
  const terminalLiveness = runTerminalCommand(
    page,
    terminalId,
    `${shellMarkerCommand(marker)}\n`,
    marker,
    5_000
  ).then((result) => ({ ...result, durationMs: performance.now() - terminalStarted }))
  const stormStarted = performance.now()
  const finalRevision = await page.evaluate(async () => {
    const current = await globalThis.desktopBridge.listWorkspaces()
    const workspaceId = current.snapshot.selectedWorkspaceId
    let slot = await globalThis.desktopBridge.getWorkspaceCardSlotV2({
      workspaceId,
      kind: 'logTail'
    })
    for (let index = 0; index < 1_000; index += 1) {
      slot = await globalThis.desktopBridge.replaceWorkspaceCardSlotV2({
        workspaceId,
        kind: 'logTail',
        expectedRevision: slot.slotRevision,
        payload: {
          kind: 'logTail',
          value: { lines: [`bounded storm line ${index}`], truncated: index > 19 }
        }
      })
    }
    return slot.slotRevision
  })
  const stormDurationMs = performance.now() - stormStarted
  const terminal = await terminalLiveness
  return {
    finalRevision,
    stormDurationMs,
    terminalDurationMs: terminal.durationMs,
    resyncCount: terminal.resyncCount
  }
}

async function runTerminalCommand(page, terminalId, command, marker, timeoutMs) {
  if (command.includes(marker)) {
    throw new Error('Terminal completion marker must not appear literally in echoed input')
  }
  return page.evaluate(
    ({ terminalId: id, command: input, marker: expected, timeoutMs: timeout }) =>
      new Promise((resolvePromise, reject) => {
        let output = ''
        let resyncCount = 0
        let removeListener = () => undefined
        let settled = false
        let recovery = null
        let recoveryRequested = false
        const finish = (error) => {
          if (settled) return
          settled = true
          globalThis.clearTimeout(timeoutHandle)
          removeListener()
          if (error) reject(error)
          else resolvePromise({ resyncCount })
        }
        const recoverFromSnapshot = () => {
          recoveryRequested = true
          recovery ??= (async () => {
            while (recoveryRequested) {
              recoveryRequested = false
              const snapshot = await globalThis.desktopBridge.attachTerminal(id)
              const recovered = [
                snapshot.checkpoint?.data ?? '',
                ...snapshot.output.map((chunk) => globalThis.atob(chunk.data))
              ].join('')
              if (recovered.includes(expected)) return true
            }
            return false
          })().finally(() => {
            recovery = null
          })
          return recovery
        }
        const timeoutHandle = globalThis.setTimeout(() => {
          void recoverFromSnapshot().then(
            (found) =>
              finish(
                found ? null : new Error(`Timed out waiting for terminal output: ${expected}`)
              ),
            (error) => finish(error)
          )
        }, timeout)
        removeListener = globalThis.desktopBridge.onTerminalEvent((event) => {
          if (
            event.event === 'terminal.resyncRequired' &&
            (!event.data.terminalId || event.data.terminalId === id)
          ) {
            resyncCount += 1
            void recoverFromSnapshot().then(
              (found) => {
                if (found) finish(null)
              },
              (error) => finish(error)
            )
            return
          }
          if (event.event === 'terminal.exited' && event.data.terminalId === id) {
            finish(new Error(`Terminal exited before output marker: ${expected}`))
            return
          }
          if (event.event !== 'terminal.output' || event.data.terminalId !== id) return
          output += globalThis.atob(event.data.chunk.data)
          if (!output.includes(expected)) return
          finish(null)
        })
        globalThis.desktopBridge.sendTerminalInput(id, input).catch((error) => {
          finish(error)
        })
      }),
    { terminalId, command, marker, timeoutMs }
  )
}

function shellMarkerCommand(marker) {
  const midpoint = Math.floor(marker.length / 2)
  return `printf '%s%s\\n' '${marker.slice(0, midpoint)}' '${marker.slice(midpoint)}'`
}

async function repeatedSplitResize(page, cwd) {
  return page.evaluate(async (directory) => {
    let response = await globalThis.desktopBridge.listWorkspaces()
    let workspace = response.snapshot.workspaces.find(
      (item) => item.id === response.snapshot.selectedWorkspaceId
    )
    if (!workspace) throw new Error('Selected workspace missing')
    const split = await globalThis.desktopBridge.splitPane({
      workspaceId: workspace.id,
      targetPaneId: workspace.selectedPaneId,
      axis: 'horizontal',
      ratio: 0.5,
      placement: 'after',
      content: { kind: 'newTerminal', launch: { cwd: directory, rows: 24, cols: 80 } }
    })
    workspace = split.snapshot.workspaces.find((item) => item.id === workspace.id)
    if (!workspace) throw new Error('Split workspace missing')
    if (workspace.layout.kind !== 'split') throw new Error('Split layout missing')
    const splitId = workspace.layout.splitId
    const started = performance.now()
    for (let index = 0; index < 60; index += 1) {
      await new Promise((resolve) => globalThis.requestAnimationFrame(resolve))
      await globalThis.desktopBridge.resizePane({
        workspaceId: workspace.id,
        splitId,
        ratio: index % 2 === 0 ? 0.49 : 0.51
      })
    }
    return 60_000 / (performance.now() - started)
  }, cwd)
}

async function browserViewLoop(page, url) {
  const samples = []
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now()
    const tabId = await page.evaluate(async (targetUrl) => {
      const current = await globalThis.desktopBridge.listWorkspaces()
      const workspace = current.snapshot.workspaces.find(
        (item) => item.id === current.snapshot.selectedWorkspaceId
      )
      if (!workspace) throw new Error('Selected workspace missing')
      const result = await globalThis.desktopBridge.openBrowserTab({
        workspaceId: workspace.id,
        paneId: workspace.selectedPaneId,
        metadata: { url: targetUrl }
      })
      const updated = result.snapshot.workspaces.find((item) => item.id === workspace.id)
      const pane = updated?.panes.find((item) => item.id === workspace.selectedPaneId)
      if (!pane?.selectedTabId) throw new Error('Browser tab missing')
      return pane.selectedTabId
    }, url)
    await expect(page.locator('.browser-pane')).toBeVisible()
    await page.evaluate(async (id) => {
      const current = await globalThis.desktopBridge.listWorkspaces()
      await globalThis.desktopBridge.closeTab({
        workspaceId: current.snapshot.selectedWorkspaceId,
        tabId: id
      })
    }, tabId)
    await expect(page.locator('.browser-pane')).toHaveCount(0)
    samples.push(performance.now() - started)
  }
  return samples
}

async function notificationStorm(profile) {
  const sessionFile = join(profile, 'runtime', 'node-cli-session.json')
  const started = performance.now()
  for (let index = 0; index < 100; index += 1) {
    await execFileAsync(packagedCli, [
      '--session-file',
      sessionFile,
      'notify',
      '--title',
      `Performance notification ${index}`
    ])
  }
  return performance.now() - started
}

async function runFullSoak(page, rootPid) {
  const started = performance.now()
  const elapsedMs = []
  const pssMiB = []
  const rssMiB = []
  const privateMiB = []
  const timestamps = []
  for (let iteration = 0; iteration < SOAK_SAMPLE_COUNT; iteration += 1) {
    const target = started + iteration * SOAK_SAMPLE_INTERVAL_MS
    await page.waitForTimeout(Math.max(0, target - performance.now()))
    const terminalId = await selectedTerminalId(page)
    await page.evaluate(
      async ({ id, iteration: current }) => {
        await globalThis.desktopBridge.sendTerminalInput(
          id,
          `seq 1 1000 >/dev/null; echo SOAK_HEARTBEAT_${current}\n`
        )
      },
      { id: terminalId, iteration }
    )
    recordMemoryObservation(
      { pssMiB, rssMiB, privateMiB, timestamps },
      await aggregateProcessTreeMemory(rootPid)
    )
    elapsedMs.push(performance.now() - started)
  }
  return { elapsedMs, pssMiB, rssMiB, privateMiB, timestamps }
}

async function selectedTerminalId(page) {
  const terminal = page.locator('.terminal-pane').last()
  await expect(terminal).toHaveAttribute('data-terminal-id', /\S+/u, { timeout: 20_000 })
  const terminalId = await terminal.getAttribute('data-terminal-id')
  if (!terminalId) throw new Error('Selected terminal ID missing after readiness')
  return terminalId
}

async function settledMemoryObservations(rootPid) {
  const observations = { pssMiB: [], rssMiB: [], privateMiB: [], timestamps: [], processCounts: [] }
  for (let index = 0; index < 3; index += 1) {
    if (index > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 750))
    const memory = await aggregateProcessTreeMemory(rootPid)
    recordMemoryObservation(observations, memory)
    observations.processCounts.push(memory.processCount)
  }
  return observations
}

function recordMemoryObservation(observations, memory) {
  observations.timestamps.push(new Date().toISOString())
  observations.pssMiB.push(memory.pssKiB / 1024)
  observations.rssMiB.push(memory.rssKiB / 1024)
  observations.privateMiB.push(memory.privateKiB / 1024)
}

function addMemoryMetrics(metrics, idPrefix, observations, pssThresholdMiB) {
  const commonNotes = [
    'Packaged Electron root and descendants identified only through strict /proc/<pid>/status PPid traversal.',
    `three settled observations at ${observations.timestamps.join(', ')}; process counts=${observations.processCounts.join(',')}`
  ]
  metrics.push(
    metric({
      id: `${idPrefix}.application_pss`,
      unit: 'MiB',
      samples: observations.pssMiB,
      threshold:
        pssThresholdMiB === null
          ? null
          : { operator: '<=', statistic: 'p95', value: pssThresholdMiB },
      gate: pssThresholdMiB === null ? 'informational' : 'required',
      notes: [
        ...commonNotes,
        'Primary application-memory measure: aggregate PSS from smaps_rollup proportionally accounts shared Electron mappings.'
      ]
    })
  )
  metrics.push(
    metric({
      id: `${idPrefix}.aggregate_rss`,
      unit: 'MiB',
      samples: observations.rssMiB,
      threshold: null,
      gate: 'informational',
      notes: [
        ...commonNotes,
        'Diagnostic sum of VmRSS; shared mappings may be counted once per Electron process.'
      ]
    })
  )
  metrics.push(
    metric({
      id: `${idPrefix}.private_memory`,
      unit: 'MiB',
      samples: observations.privateMiB,
      threshold: null,
      gate: 'informational',
      notes: [...commonNotes, 'Diagnostic sum of Private_Clean + Private_Dirty from smaps_rollup.']
    })
  )
}
