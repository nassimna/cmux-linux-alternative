import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, hostname, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  compareAgainstBaseline,
  readBaseline,
  validateFragment,
  validateReport
} from './result.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryDirectory = resolve(desktopDirectory, '../..')
const arguments_ = parseArguments(process.argv.slice(2))
const startedAt = new Date().toISOString()
const scratch = await mkdtemp(join(tmpdir(), 'agent-workspace-performance-run-'))
const ptyPath = join(scratch, 'pty.json')
const e2ePath = join(scratch, 'e2e.json')

try {
  await command('pnpm', ['package:linux:dir'], repositoryDirectory)
  await command(
    'pnpm',
    [
      '--filter',
      '@agent-workspace/desktop',
      'exec',
      'vitest',
      'run',
      'src/main/control-client.performance.test.ts'
    ],
    repositoryDirectory,
    { AGENT_WORKSPACE_PTY_RESULT: ptyPath }
  )
  await command(
    'pnpm',
    [
      '--filter',
      '@agent-workspace/desktop',
      'exec',
      'playwright',
      'test',
      'e2e/performance.spec.mjs',
      '--workers=1',
      '--timeout=36000000'
    ],
    repositoryDirectory,
    { AGENT_WORKSPACE_E2E_RESULT: e2ePath, AGENT_WORKSPACE_PERFORMANCE_MODE: arguments_.mode }
  )

  const fragments = await Promise.all(
    [ptyPath, e2ePath].map(async (path) =>
      validateFragment(JSON.parse(await readFile(path, 'utf8')))
    )
  )
  const report = validateReport({
    schemaVersion: 1,
    suite: 'agent-workspace-performance',
    mode: arguments_.mode,
    fullSoak: arguments_.mode === 'soak',
    startedAt,
    completedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      kernel: release(),
      hostname: hostname(),
      cpuCount: availableParallelism(),
      node: process.version,
      ci: Boolean(process.env.CI),
      releaseBuild: true
    },
    metrics: fragments.flatMap(({ metrics }) => metrics),
    scenarios: fragments.flatMap(({ scenarios }) => scenarios)
  })
  await writeFile(arguments_.output, `${JSON.stringify(report, null, 2)}\n`)
  if (arguments_.captureBaseline) await copyFile(arguments_.output, arguments_.captureBaseline)

  const requiredFailures = report.metrics.filter(
    ({ gate, passed }) => gate === 'required' && passed !== true
  )
  let regressions = []
  if (arguments_.baseline)
    regressions = compareAgainstBaseline(report, await readBaseline(arguments_.baseline)).filter(
      ({ investigate }) => investigate
    )
  process.stdout.write(
    `${JSON.stringify(
      {
        output: arguments_.output,
        mode: arguments_.mode,
        requiredFailures: requiredFailures.map(({ id }) => id),
        regressions
      },
      null,
      2
    )}\n`
  )
  if (requiredFailures.length > 0 || regressions.length > 0) process.exitCode = 1
} finally {
  await rm(scratch, { force: true, recursive: true })
}

function parseArguments(args) {
  const result = {
    mode: 'smoke',
    output: join(tmpdir(), 'agent-workspace-performance.json'),
    baseline: null,
    captureBaseline: null
  }
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--') continue
    if (name === '--mode') result.mode = requireValue(args, ++index, name)
    else if (name === '--output') result.output = resolve(requireValue(args, ++index, name))
    else if (name === '--baseline') result.baseline = resolve(requireValue(args, ++index, name))
    else if (name === '--capture-baseline')
      result.captureBaseline = resolve(requireValue(args, ++index, name))
    else throw new Error(`Unknown argument: ${name}`)
  }
  if (!['smoke', 'soak'].includes(result.mode)) throw new Error('--mode must be smoke or soak')
  return result
}

function requireValue(args, index, name) {
  if (!args[index]) throw new Error(`${name} requires a value`)
  return args[index]
}

async function command(executable, args, cwd, extraEnvironment = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnvironment }
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${executable} ${args.join(' ')} failed (${signal ?? code})`))
    })
  })
}
