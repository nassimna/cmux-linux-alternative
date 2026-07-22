import { readdir, readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

export const SCHEMA_VERSION = 1
export const REGRESSION_LIMIT_PERCENT = 15
export const FULL_SOAK_MS = 8 * 60 * 60 * 1_000
export const SOAK_SAMPLE_INTERVAL_MS = 60_000
export const SOAK_SAMPLE_COUNT = FULL_SOAK_MS / SOAK_SAMPLE_INTERVAL_MS + 1

const FULL_SOAK_SCENARIO = 'full 8-hour continuous output soak'
const OMITTED_SOAK_SCENARIO = '8-hour output soak: not run in smoke mode'
const SOAK_METRICS = {
  elapsed: 'soak.sample_elapsed',
  pss: 'soak.application_pss',
  rss: 'soak.aggregate_rss',
  privateMemory: 'soak.private_memory'
}

const metricKeys = ['gate', 'id', 'notes', 'passed', 'samples', 'summary', 'threshold', 'unit']

export function percentile(samples, fraction) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('samples must be non-empty')
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error('percentile fraction must be in (0, 1]')
  }
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)]
}

export function summarize(samples) {
  if (!samples.every((sample) => Number.isFinite(sample) && sample >= 0)) {
    throw new Error('metric samples must be finite non-negative numbers')
  }
  return {
    min: Math.min(...samples),
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: Math.max(...samples)
  }
}

export function metric({ id, unit, samples, threshold, gate, notes = [] }) {
  const summary = summarize(samples)
  const passed = threshold ? compareThreshold(summary[threshold.statistic], threshold) : null
  return { id, unit, samples, summary, threshold: threshold ?? null, gate, passed, notes }
}

export function compareThreshold(value, threshold) {
  if (threshold.operator === '<') return value < threshold.value
  if (threshold.operator === '<=') return value <= threshold.value
  if (threshold.operator === '>') return value > threshold.value
  if (threshold.operator === '>=') return value >= threshold.value
  throw new Error(`Unsupported threshold operator: ${String(threshold.operator)}`)
}

export function compareAgainstBaseline(report, baseline) {
  validateReport(report)
  validateReport(baseline)
  const baselineMetrics = new Map(baseline.metrics.map((entry) => [entry.id, entry]))
  return report.metrics.flatMap((current) => {
    const previous = baselineMetrics.get(current.id)
    if (!previous || current.unit !== previous.unit) return []
    const currentValue = current.summary.p95
    const baselineValue = previous.summary.p95
    if (baselineValue === 0) return []
    const direction = ['>', '>='].includes(current.threshold?.operator) ? -1 : 1
    const changePercent = ((currentValue - baselineValue) / baselineValue) * 100 * direction
    return [
      {
        metricId: current.id,
        baselineP95: baselineValue,
        currentP95: currentValue,
        changePercent,
        investigate: changePercent > REGRESSION_LIMIT_PERCENT
      }
    ]
  })
}

export async function readBaseline(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  validateReport(parsed)
  return parsed
}

export function validateReport(value) {
  record(value, 'report')
  exactKeys(value, [
    'completedAt',
    'environment',
    'fullSoak',
    'metrics',
    'mode',
    'scenarios',
    'schemaVersion',
    'startedAt',
    'suite'
  ])
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported schemaVersion')
  if (value.suite !== 'agent-workspace-performance') throw new Error('invalid suite')
  if (!['smoke', 'soak'].includes(value.mode)) throw new Error('invalid mode')
  if (value.fullSoak !== (value.mode === 'soak')) throw new Error('fullSoak must match mode')
  iso(value.startedAt, 'startedAt')
  iso(value.completedAt, 'completedAt')
  record(value.environment, 'environment')
  exactKeys(value.environment, [
    'arch',
    'ci',
    'cpuCount',
    'hostname',
    'kernel',
    'node',
    'platform',
    'releaseBuild'
  ])
  if (value.environment.releaseBuild !== true) throw new Error('releaseBuild must be true')
  if (!Array.isArray(value.metrics)) throw new Error('metrics must be an array')
  for (const entry of value.metrics) validateMetric(entry)
  uniqueMetricIds(value.metrics)
  if (
    !Array.isArray(value.scenarios) ||
    !value.scenarios.every((item) => typeof item === 'string')
  ) {
    throw new Error('scenarios must be strings')
  }
  const startedAt = Date.parse(value.startedAt)
  const completedAt = Date.parse(value.completedAt)
  if (completedAt < startedAt) throw new Error('completedAt must not precede startedAt')
  validateSoakEvidence(value, completedAt - startedAt)
  return value
}

function validateSoakEvidence(report, reportDurationMs) {
  const metrics = new Map(report.metrics.map((entry) => [entry.id, entry]))
  const soakMetrics = report.metrics.filter(({ id }) => id.startsWith('soak.'))
  const hasFullScenario = report.scenarios.includes(FULL_SOAK_SCENARIO)
  const hasOmittedScenario = report.scenarios.includes(OMITTED_SOAK_SCENARIO)
  const unexpectedSoakScenarios = report.scenarios.filter(
    (scenario) =>
      /soak/iu.test(scenario) &&
      scenario !== FULL_SOAK_SCENARIO &&
      scenario !== OMITTED_SOAK_SCENARIO
  )
  if (unexpectedSoakScenarios.length > 0) {
    throw new Error('report contains an unrecognized soak claim')
  }

  if (report.mode === 'smoke') {
    if (soakMetrics.length > 0) throw new Error('smoke report must not contain soak metrics')
    if (hasFullScenario) throw new Error('smoke report must not claim the full soak scenario')
    if (!hasOmittedScenario) throw new Error('smoke report must record that the soak was not run')
    return
  }

  if (!hasFullScenario || hasOmittedScenario) {
    throw new Error('soak report must contain only the completed full-soak scenario')
  }
  if (reportDurationMs < FULL_SOAK_MS) {
    throw new Error('soak report timestamps cover less than eight hours')
  }
  for (const metricId of Object.values(SOAK_METRICS)) {
    if (!metrics.has(metricId)) throw new Error(`soak report is missing ${metricId}`)
  }

  const elapsed = metrics.get(SOAK_METRICS.elapsed)
  const pss = metrics.get(SOAK_METRICS.pss)
  const rss = metrics.get(SOAK_METRICS.rss)
  const privateMemory = metrics.get(SOAK_METRICS.privateMemory)
  requireSoakMetric(elapsed, 'ms', 'informational')
  requireSoakMetric(pss, 'MiB', 'manual')
  requireSoakMetric(rss, 'MiB', 'informational')
  requireSoakMetric(privateMemory, 'MiB', 'informational')

  const sampleCount = elapsed.samples.length
  if (sampleCount !== SOAK_SAMPLE_COUNT) {
    throw new Error(`soak report requires exactly ${SOAK_SAMPLE_COUNT} aligned samples`)
  }
  for (const metric of [pss, rss, privateMemory]) {
    if (metric.samples.length !== sampleCount) {
      throw new Error('soak memory series must align with elapsed samples')
    }
  }

  const first = elapsed.samples[0]
  const last = elapsed.samples.at(-1)
  if (first >= SOAK_SAMPLE_INTERVAL_MS) {
    throw new Error('soak first sample must occur within the first minute')
  }
  if (last < FULL_SOAK_MS || last > FULL_SOAK_MS + SOAK_SAMPLE_INTERVAL_MS) {
    throw new Error('soak final sample must prove the exact eight-hour boundary')
  }
  for (let index = 1; index < elapsed.samples.length; index += 1) {
    const gap = elapsed.samples[index] - elapsed.samples[index - 1]
    if (gap <= 0) throw new Error('soak elapsed samples must be strictly chronological')
    if (gap < SOAK_SAMPLE_INTERVAL_MS * 0.5 || gap > SOAK_SAMPLE_INTERVAL_MS * 1.5) {
      throw new Error('soak elapsed samples must retain the one-minute cadence')
    }
  }
}

function requireSoakMetric(metric, unit, gate) {
  if (metric.unit !== unit || metric.gate !== gate || metric.threshold !== null) {
    throw new Error(`invalid soak metric contract: ${metric.id}`)
  }
}

export function validateFragment(value) {
  record(value, 'fragment')
  exactKeys(value, ['metrics', 'scenarios'])
  if (!Array.isArray(value.metrics)) throw new Error('fragment metrics must be an array')
  value.metrics.forEach(validateMetric)
  uniqueMetricIds(value.metrics)
  if (
    !Array.isArray(value.scenarios) ||
    !value.scenarios.every((item) => typeof item === 'string')
  ) {
    throw new Error('fragment scenarios must be strings')
  }
  return value
}

function validateMetric(value) {
  record(value, 'metric')
  exactKeys(value, metricKeys)
  if (typeof value.id !== 'string' || value.id.length === 0) throw new Error('invalid metric id')
  if (typeof value.unit !== 'string' || value.unit.length === 0) throw new Error('invalid unit')
  if (!['required', 'informational', 'manual'].includes(value.gate)) throw new Error('invalid gate')
  if (!Array.isArray(value.samples) || value.samples.length === 0)
    throw new Error('invalid samples')
  value.samples.forEach((sample) => finite(sample, 'sample'))
  record(value.summary, 'summary')
  exactKeys(value.summary, ['max', 'min', 'p50', 'p95'])
  Object.values(value.summary).forEach((sample) => finite(sample, 'summary'))
  const expectedSummary = summarize(value.samples)
  for (const [name, expected] of Object.entries(expectedSummary)) {
    if (value.summary[name] !== expected) throw new Error(`metric summary mismatch: ${value.id}`)
  }
  if (value.threshold !== null) {
    record(value.threshold, 'threshold')
    exactKeys(value.threshold, ['operator', 'statistic', 'value'])
    if (!['<', '<=', '>', '>='].includes(value.threshold.operator))
      throw new Error('invalid operator')
    if (!['min', 'p50', 'p95', 'max'].includes(value.threshold.statistic))
      throw new Error('invalid statistic')
    finite(value.threshold.value, 'threshold value')
  }
  if (value.passed !== null && typeof value.passed !== 'boolean') throw new Error('invalid passed')
  const expectedPassed = value.threshold
    ? compareThreshold(value.summary[value.threshold.statistic], value.threshold)
    : null
  if (value.passed !== expectedPassed) throw new Error(`metric pass result mismatch: ${value.id}`)
  if (!Array.isArray(value.notes) || !value.notes.every((note) => typeof note === 'string')) {
    throw new Error('invalid notes')
  }
}

export function parseProcStatus(text) {
  if (typeof text !== 'string') throw new Error('proc status must be text')
  const fields = parseUniqueProcFields(text, ['Pid', 'PPid', 'VmRSS'], 'status')
  const pid = parseInteger(fields.get('Pid'), 'Pid')
  const parentPid = parseInteger(fields.get('PPid'), 'PPid')
  const rssKiB = parseKiB(fields.get('VmRSS'), 'VmRSS')
  return { pid, parentPid, rssKiB }
}

export function parseProcSmapsRollup(text) {
  if (typeof text !== 'string') throw new Error('proc smaps_rollup must be text')
  const fields = parseUniqueProcFields(
    text,
    ['Pss', 'Private_Clean', 'Private_Dirty'],
    'smaps_rollup'
  )
  const pssKiB = parseKiB(fields.get('Pss'), 'Pss')
  const privateCleanKiB = parseKiB(fields.get('Private_Clean'), 'Private_Clean')
  const privateDirtyKiB = parseKiB(fields.get('Private_Dirty'), 'Private_Dirty')
  const privateKiB = privateCleanKiB + privateDirtyKiB
  if (!Number.isSafeInteger(privateKiB)) throw new Error('private memory is out of range')
  return { pssKiB, privateCleanKiB, privateDirtyKiB, privateKiB }
}

export function parseProcProcessStat(text) {
  if (typeof text !== 'string') throw new Error('proc process stat must be text')
  const prefix = /^(\d+) \(/u.exec(text)
  const commandEnd = text.lastIndexOf(') ')
  if (!prefix || commandEnd < prefix[0].length) throw new Error('invalid proc process stat')
  const fields = text
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u)
  if (fields.length < 20 || !/^\S$/u.test(fields[0] ?? '')) {
    throw new Error('invalid proc process stat fields')
  }
  const pid = parseInteger(prefix[1], 'process stat pid')
  const parentPid = parseInteger(fields[1], 'process stat ppid')
  const userJiffies = parseInteger(fields[11], 'process stat utime')
  const systemJiffies = parseInteger(fields[12], 'process stat stime')
  const startTime = parseInteger(fields[19], 'process stat starttime')
  return {
    pid,
    parentPid,
    startTime,
    cpuJiffies: safeSum(userJiffies, systemJiffies, 'process CPU jiffies')
  }
}

export function parseProcSystemStat(text) {
  if (typeof text !== 'string') throw new Error('proc system stat must be text')
  const aggregateLines = text.split('\n').filter((line) => /^cpu\s/u.test(line))
  if (aggregateLines.length !== 1) throw new Error('proc system stat requires one aggregate CPU')
  const fields = aggregateLines[0].trim().split(/\s+/u).slice(1)
  if (fields.length < 8) throw new Error('proc system stat has too few CPU fields')
  const totalJiffies = fields
    .slice(0, 8)
    .map((field, index) => parseInteger(field, `system CPU field ${index}`))
    .reduce((total, value) => safeSum(total, value, 'system CPU jiffies'), 0)
  const cpuCount = text.split('\n').filter((line) => /^cpu\d+\s/u.test(line)).length
  if (cpuCount < 1) throw new Error('proc system stat has no online CPUs')
  return { cpuCount, totalJiffies }
}

export async function readProcessTreeCpuSnapshot(rootPid, dependencies = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('rootPid is out of range')
  const readDirectory = dependencies.readdir ?? readdir
  const readText = dependencies.readFile ?? readFile
  const [entries, systemStat] = await Promise.all([
    readDirectory('/proc'),
    readText('/proc/stat', 'utf8')
  ])
  const processes = []
  for (const name of entries.filter((entry) => /^\d+$/u.test(entry))) {
    try {
      processes.push(parseProcProcessStat(await readText(`/proc/${name}/stat`, 'utf8')))
    } catch (error) {
      if (!isProcScanRace(error)) throw error
    }
  }
  const descendants = processTree(rootPid, processes)
  const selected = processes
    .filter(({ pid }) => descendants.has(pid))
    .sort((left, right) => left.pid - right.pid)
  const root = selected.find(({ pid }) => pid === rootPid)
  if (!root) throw new Error(`root process ${rootPid} was unavailable during CPU collection`)
  return {
    ...parseProcSystemStat(systemStat),
    rootIdentity: processIdentity(root),
    processes: selected
  }
}

export function calculateProcessTreeCpuInterval(before, after) {
  if (before.cpuCount !== after.cpuCount) throw new Error('online CPU count changed during sample')
  if (before.rootIdentity !== after.rootIdentity) {
    throw new Error('root process identity changed during CPU sample')
  }
  const systemJiffies = after.totalJiffies - before.totalJiffies
  if (!Number.isSafeInteger(systemJiffies) || systemJiffies <= 0) {
    throw new Error('system CPU jiffies did not advance')
  }
  const previous = new Map(before.processes.map((process) => [processIdentity(process), process]))
  const current = new Map(after.processes.map((process) => [processIdentity(process), process]))
  const exited = [...previous.keys()].filter((identity) => !current.has(identity))
  if (exited.length > 0) {
    const error = new Error(`process identity disappeared during CPU sample: ${exited.join(',')}`)
    error.code = 'PROCESS_TREE_CHANGED'
    throw error
  }
  let applicationJiffies = 0
  let newProcessCount = 0
  for (const [identity, process] of current) {
    const prior = previous.get(identity)
    if (!prior) {
      newProcessCount += 1
      applicationJiffies = safeSum(
        applicationJiffies,
        process.cpuJiffies,
        'application CPU jiffies'
      )
      continue
    }
    const difference = process.cpuJiffies - prior.cpuJiffies
    if (!Number.isSafeInteger(difference) || difference < 0) {
      throw new Error(`process CPU jiffies moved backwards: ${identity}`)
    }
    applicationJiffies = safeSum(applicationJiffies, difference, 'application CPU jiffies')
  }
  const cpuPercent = (applicationJiffies / systemJiffies) * after.cpuCount * 100
  if (!Number.isFinite(cpuPercent) || cpuPercent < 0) throw new Error('invalid CPU percentage')
  return {
    applicationJiffies,
    systemJiffies,
    cpuPercent,
    processCount: after.processes.length,
    newProcessCount
  }
}

export async function measureProcessTreeCpu(rootPid, options = {}, dependencies = {}) {
  const durationMs = options.durationMs ?? 5 * 60_000
  const sampleIntervalMs = options.sampleIntervalMs ?? 1_000
  const maxInvalidatedAttempts = options.maxInvalidatedAttempts ?? 0
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('invalid CPU duration')
  if (
    !Number.isSafeInteger(sampleIntervalMs) ||
    sampleIntervalMs <= 0 ||
    sampleIntervalMs > durationMs
  ) {
    throw new Error('invalid CPU sample interval')
  }
  if (!Number.isSafeInteger(maxInvalidatedAttempts) || maxInvalidatedAttempts < 0) {
    throw new Error('invalid maximum CPU attempts')
  }
  const readSnapshot = dependencies.readSnapshot ?? readProcessTreeCpuSnapshot
  const wait = dependencies.delay ?? delay
  const now = dependencies.now ?? (() => performance.now())
  let invalidatedAttempts = 0
  while (true) {
    let previous = await readSnapshot(rootPid)
    const deadline = now() + durationMs
    let applicationJiffies = 0
    let systemJiffies = 0
    const intervalCpuPercent = []
    const processCounts = []
    const newProcessCounts = []
    try {
      while (now() < deadline) {
        await wait(Math.min(sampleIntervalMs, Math.max(1, Math.ceil(deadline - now()))))
        const current = await readSnapshot(rootPid)
        const interval = calculateProcessTreeCpuInterval(previous, current)
        applicationJiffies = safeSum(
          applicationJiffies,
          interval.applicationJiffies,
          'measured application CPU jiffies'
        )
        systemJiffies = safeSum(
          systemJiffies,
          interval.systemJiffies,
          'measured system CPU jiffies'
        )
        intervalCpuPercent.push(interval.cpuPercent)
        processCounts.push(interval.processCount)
        newProcessCounts.push(interval.newProcessCount)
        previous = current
      }
    } catch (error) {
      if (error?.code === 'PROCESS_TREE_CHANGED' && invalidatedAttempts < maxInvalidatedAttempts) {
        invalidatedAttempts += 1
        continue
      }
      throw error
    }
    if (intervalCpuPercent.length === 0 || systemJiffies === 0) {
      throw new Error('CPU measurement produced no samples')
    }
    return {
      averageCpuPercent: (applicationJiffies / systemJiffies) * previous.cpuCount * 100,
      intervalCpuPercent,
      applicationJiffies,
      systemJiffies,
      processCounts,
      newProcessCounts,
      cpuCount: previous.cpuCount,
      invalidatedAttempts
    }
  }
}

export async function aggregateProcessTreeMemory(rootPid, dependencies = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('rootPid is out of range')
  const readDirectory = dependencies.readdir ?? readdir
  const readText = dependencies.readFile ?? readFile
  const processIds = (await readDirectory('/proc')).filter((name) => /^\d+$/u.test(name))
  const statuses = []
  for (const processId of processIds) {
    try {
      const text = await readText(`/proc/${processId}/status`, 'utf8')
      if (!/^VmRSS:/mu.test(text)) continue
      statuses.push(parseProcStatus(text))
    } catch (error) {
      if (!isProcScanRace(error)) throw error
    }
  }

  const descendants = processTree(rootPid, statuses)
  const selected = statuses.filter(({ pid }) => descendants.has(pid))
  if (!selected.some(({ pid }) => pid === rootPid)) {
    throw new Error(`root process ${rootPid} was unavailable during procfs collection`)
  }

  let rssKiB = 0
  let pssKiB = 0
  let privateKiB = 0
  const measuredPids = []
  const exitedPids = []
  for (const status of selected) {
    try {
      const rollup = parseProcSmapsRollup(
        await readText(`/proc/${status.pid}/smaps_rollup`, 'utf8')
      )
      rssKiB = safeSum(rssKiB, status.rssKiB, 'aggregate RSS')
      pssKiB = safeSum(pssKiB, rollup.pssKiB, 'aggregate PSS')
      privateKiB = safeSum(privateKiB, rollup.privateKiB, 'aggregate private memory')
      measuredPids.push(status.pid)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') exitedPids.push(status.pid)
      else throw error
    }
  }
  if (!measuredPids.includes(rootPid)) {
    throw new Error(`root process ${rootPid} exited during procfs collection`)
  }
  return { rssKiB, pssKiB, privateKiB, processCount: measuredPids.length, measuredPids, exitedPids }
}

function processTree(rootPid, processes) {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (descendants.has(process.parentPid) && !descendants.has(process.pid)) {
        descendants.add(process.pid)
        changed = true
      }
    }
  }
  return descendants
}

function processIdentity(process) {
  return `${process.pid}:${process.startTime}`
}

function parseUniqueProcFields(text, requested, source) {
  const requestedSet = new Set(requested)
  const fields = new Map()
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/u.exec(line)
    if (!match || !requestedSet.has(match[1])) continue
    if (fields.has(match[1])) throw new Error(`duplicate ${match[1]} in proc ${source}`)
    fields.set(match[1], match[2])
  }
  return fields
}

function parseKiB(value, name) {
  const match = /^(\d+) kB$/u.exec(value ?? '')
  if (!match) throw new Error(`${name} is missing or not expressed in kB`)
  return parseInteger(match[1], name)
}

function safeSum(left, right, name) {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new Error(`${name} is out of range`)
  return result
}

function isProcScanRace(error) {
  return error?.code === 'ENOENT' || error?.code === 'ESRCH' || error?.code === 'EACCES'
}

function uniqueMetricIds(metrics) {
  const ids = new Set()
  for (const entry of metrics) {
    if (ids.has(entry.id)) throw new Error(`duplicate metric id: ${entry.id}`)
    ids.add(entry.id)
  }
}

function parseInteger(value, name) {
  if (!/^\d+$/u.test(value ?? '')) throw new Error(`${name} is not an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is out of range`)
  return parsed
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and non-negative`)
  }
}

function record(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`unexpected keys: ${actual.join(',')}`)
  }
}

function iso(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new Error(`invalid ${name}`)
}
