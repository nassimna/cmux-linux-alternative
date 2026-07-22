import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FULL_SOAK_MS,
  SOAK_SAMPLE_COUNT,
  SOAK_SAMPLE_INTERVAL_MS,
  aggregateProcessTreeMemory,
  calculateProcessTreeCpuInterval,
  compareAgainstBaseline,
  measureProcessTreeCpu,
  metric,
  parseProcProcessStat,
  parseProcSmapsRollup,
  parseProcStatus,
  parseProcSystemStat,
  percentile,
  readProcessTreeCpuSnapshot,
  validateReport
} from './result.mjs'

test('nearest-rank percentile is deterministic for unsorted samples', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20)
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40)
})

test('strict report validation rejects unknown fields, inconsistent summaries, and false smoke evidence', () => {
  const report = fixture()
  assert.equal(validateReport(report), report)
  assert.throws(() => validateReport({ ...report, surprise: true }), /unexpected keys/u)
  assert.throws(() => validateReport({ ...report, mode: 'smoke', fullSoak: true }), /fullSoak/u)
  assert.throws(
    () => validateReport({ ...report, metrics: [report.metrics[0], report.metrics[0]] }),
    /duplicate metric id/u
  )
  assert.throws(
    () =>
      validateReport({
        ...report,
        metrics: [{ ...report.metrics[0], summary: { ...report.metrics[0].summary, p95: 9 } }]
      }),
    /summary mismatch/u
  )
  assert.throws(
    () =>
      validateReport({
        ...report,
        metrics: [{ ...report.metrics[0], passed: !report.metrics[0].passed }]
      }),
    /pass result mismatch/u
  )
  assert.throws(
    () => validateReport({ ...report, scenarios: ['full 8-hour continuous output soak'] }),
    /must not claim/u
  )
  assert.throws(
    () => validateReport({ ...report, scenarios: ['test'] }),
    /record that the soak was not run/u
  )
  assert.throws(
    () =>
      validateReport({
        ...report,
        scenarios: [
          '8-hour output soak: not run in smoke mode',
          'alternate eight-hour soak completed'
        ]
      }),
    /unrecognized soak claim/u
  )
})

test('strict soak validation proves the exact duration, cadence, and aligned memory series', () => {
  const report = soakFixture()
  assert.equal(validateReport(report), report)

  assert.throws(
    () =>
      validateReport({
        ...report,
        completedAt: new Date(Date.parse(report.startedAt) + FULL_SOAK_MS - 1).toISOString()
      }),
    /less than eight hours/u
  )

  const withoutPrivateMemory = {
    ...report,
    metrics: report.metrics.filter(({ id }) => id !== 'soak.private_memory')
  }
  assert.throws(() => validateReport(withoutPrivateMemory), /missing soak\.private_memory/u)

  const shortTimeline = Array.from(
    { length: SOAK_SAMPLE_COUNT - 1 },
    (_, index) => index * SOAK_SAMPLE_INTERVAL_MS
  )
  assert.throws(
    () => validateReport(withMetricSamples(report, 'soak.sample_elapsed', shortTimeline)),
    /exactly 481 aligned samples/u
  )

  assert.throws(
    () =>
      validateReport(
        withMetricSamples(
          report,
          'soak.application_pss',
          report.metrics.find(({ id }) => id === 'soak.application_pss').samples.slice(1)
        )
      ),
    /memory series must align/u
  )

  const nonChronological = report.metrics
    .find(({ id }) => id === 'soak.sample_elapsed')
    .samples.slice()
  nonChronological[20] = nonChronological[19]
  assert.throws(
    () => validateReport(withMetricSamples(report, 'soak.sample_elapsed', nonChronological)),
    /strictly chronological/u
  )

  const brokenCadence = report.metrics
    .find(({ id }) => id === 'soak.sample_elapsed')
    .samples.slice()
  brokenCadence[20] += SOAK_SAMPLE_INTERVAL_MS
  assert.throws(
    () => validateReport(withMetricSamples(report, 'soak.sample_elapsed', brokenCadence)),
    /one-minute cadence/u
  )

  assert.throws(
    () =>
      validateReport({
        ...report,
        scenarios: ['8-hour output soak: not run in smoke mode']
      }),
    /completed full-soak scenario/u
  )
})

test('baseline comparison flags only regressions greater than fifteen percent', () => {
  const baseline = fixture([metricFixture('dispatch', 10), metricFixture('fps', 50, '>=')])
  const current = fixture([metricFixture('dispatch', 11.5), metricFixture('fps', 42.5, '>=')])
  const comparisons = compareAgainstBaseline(current, baseline)
  assert.equal(comparisons[0].investigate, false)
  assert.equal(comparisons[1].investigate, false)
  current.metrics[0] = metricFixture('dispatch', 11.51)
  current.metrics[1] = metricFixture('fps', 42.49, '>=')
  assert.equal(compareAgainstBaseline(current, baseline)[0].investigate, true)
  assert.equal(compareAgainstBaseline(current, baseline)[1].investigate, true)
})

test('strict threshold operators preserve the exact idle CPU boundary', () => {
  const passing = metric({
    id: 'idle',
    unit: '%',
    samples: [0.999],
    threshold: { operator: '<', statistic: 'p95', value: 1 },
    gate: 'required'
  })
  assert.equal(passing.passed, true)
  assert.equal(metric({ ...passing, samples: [1] }).passed, false)
})

test('Linux proc status parsing is strict', () => {
  assert.deepEqual(parseProcStatus('Name:\tapp\nPid:\t123\nPPid:\t7\nVmRSS:\t2048 kB\n'), {
    pid: 123,
    parentPid: 7,
    rssKiB: 2048
  })
  assert.throws(() => parseProcStatus('Pid:\t1\nPPid:\t0\nVmRSS:\t2 MB\n'), /VmRSS/u)
  assert.throws(
    () => parseProcStatus('Pid:\t1\nPid:\t2\nPPid:\t0\nVmRSS:\t2 kB\n'),
    /duplicate Pid/u
  )
})

test('Linux smaps_rollup parsing reports strict PSS and private memory', () => {
  assert.deepEqual(
    parseProcSmapsRollup(
      '00400000-00401000 ---p 00000000 00:00 0 [rollup]\n' +
        'Rss: 400 kB\nPss: 250 kB\nPrivate_Clean: 40 kB\nPrivate_Dirty: 60 kB\n'
    ),
    { pssKiB: 250, privateCleanKiB: 40, privateDirtyKiB: 60, privateKiB: 100 }
  )
  assert.throws(
    () => parseProcSmapsRollup('Pss: 1 MB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 3 kB\n'),
    /Pss/u
  )
  assert.throws(
    () => parseProcSmapsRollup('Pss: 1 kB\nPss: 2 kB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 3 kB\n'),
    /duplicate Pss/u
  )
  assert.throws(() => parseProcSmapsRollup('Pss: 1 kB\nPrivate_Clean: 2 kB\n'), /Private_Dirty/u)
  assert.throws(
    () =>
      parseProcSmapsRollup(
        `Pss: ${Number.MAX_SAFE_INTEGER + 1} kB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 3 kB\n`
      ),
    /out of range/u
  )
})

test('Linux process and system CPU stat parsing is strict', () => {
  assert.deepEqual(parseProcProcessStat(processStat(12, 'electron helper) worker', 10, 7, 5, 99)), {
    pid: 12,
    parentPid: 10,
    startTime: 99,
    cpuJiffies: 12
  })
  assert.deepEqual(
    parseProcSystemStat('cpu 10 2 3 40 5 6 7 8 100 200\ncpu0 1 0 0 2\ncpu1 1 0 0 2\n'),
    { cpuCount: 2, totalJiffies: 81 }
  )
  assert.throws(() => parseProcProcessStat('12 malformed'), /process stat/u)
  assert.throws(() => parseProcSystemStat('cpu 1 2 3\n'), /too few/u)
  assert.throws(() => parseProcSystemStat('cpu 1 2 3 4 5 6 7 8\n'), /online CPUs/u)
})

test('CPU snapshots include only the root process tree', async () => {
  const files = new Map([
    ['/proc/stat', systemStat(1_000, 2)],
    ['/proc/10/stat', processStat(10, 'root', 1, 10, 5, 100)],
    ['/proc/11/stat', processStat(11, 'child', 10, 2, 1, 110)],
    ['/proc/12/stat', processStat(12, 'unrelated', 99, 900, 0, 120)]
  ])
  const snapshot = await readProcessTreeCpuSnapshot(
    10,
    fakeProc(['10', '11', '12', 'not-a-pid'], files)
  )
  assert.equal(snapshot.rootIdentity, '10:100')
  assert.deepEqual(
    snapshot.processes.map(({ pid }) => pid),
    [10, 11]
  )
  assert.equal(snapshot.totalJiffies, 1_000)
  assert.equal(snapshot.cpuCount, 2)
})

test('CPU intervals count new descendants conservatively and reject reuse or exit', () => {
  const before = cpuSnapshot(1_000, [cpuProcess(10, 1, 100, 10), cpuProcess(11, 10, 110, 3)])
  const after = cpuSnapshot(1_200, [
    cpuProcess(10, 1, 100, 12),
    cpuProcess(11, 10, 110, 4),
    cpuProcess(12, 10, 120, 1)
  ])
  assert.deepEqual(calculateProcessTreeCpuInterval(before, after), {
    applicationJiffies: 4,
    systemJiffies: 200,
    cpuPercent: 4,
    processCount: 3,
    newProcessCount: 1
  })
  assert.throws(
    () =>
      calculateProcessTreeCpuInterval(before, {
        ...after,
        processes: [cpuProcess(10, 1, 100, 12), cpuProcess(11, 10, 999, 1)]
      }),
    /identity disappeared/u
  )
  assert.throws(
    () =>
      calculateProcessTreeCpuInterval(before, {
        ...after,
        processes: [cpuProcess(10, 1, 100, 12)]
      }),
    /identity disappeared/u
  )
})

test('CPU measurement aggregates deterministic interval evidence', async () => {
  const snapshots = [
    cpuSnapshot(1_000, [cpuProcess(10, 1, 100, 10)]),
    cpuSnapshot(1_200, [cpuProcess(10, 1, 100, 11)]),
    cpuSnapshot(1_400, [cpuProcess(10, 1, 100, 12)])
  ]
  let elapsed = 0
  let snapshotCount = 0
  const result = await measureProcessTreeCpu(
    10,
    { durationMs: 2_000, sampleIntervalMs: 1_000 },
    {
      readSnapshot: async () => {
        if (snapshotCount === 0) elapsed += 500
        snapshotCount += 1
        return snapshots.shift()
      },
      delay: async (milliseconds) => {
        elapsed += milliseconds
      },
      now: () => elapsed
    }
  )
  assert.deepEqual(result, {
    averageCpuPercent: 1,
    intervalCpuPercent: [1, 1],
    applicationJiffies: 2,
    systemJiffies: 400,
    processCounts: [1, 1],
    newProcessCounts: [0, 0],
    cpuCount: 2,
    invalidatedAttempts: 0
  })
  assert.equal(elapsed, 2_500, 'the measured duration starts after the baseline procfs snapshot')
})

test('CPU measurement restarts the complete window after one allowed topology invalidation', async () => {
  const snapshots = [
    cpuSnapshot(1_000, [cpuProcess(10, 1, 100, 10), cpuProcess(11, 10, 110, 3)]),
    cpuSnapshot(1_200, [cpuProcess(10, 1, 100, 11)]),
    cpuSnapshot(1_200, [cpuProcess(10, 1, 100, 11)]),
    cpuSnapshot(1_400, [cpuProcess(10, 1, 100, 12)])
  ]
  let elapsed = 0
  const result = await measureProcessTreeCpu(
    10,
    { durationMs: 1_000, sampleIntervalMs: 1_000, maxInvalidatedAttempts: 1 },
    {
      readSnapshot: async () => snapshots.shift(),
      delay: async (milliseconds) => {
        elapsed += milliseconds
      },
      now: () => elapsed
    }
  )
  assert.equal(result.invalidatedAttempts, 1)
  assert.equal(result.averageCpuPercent, 1)
  assert.deepEqual(result.processCounts, [1])
  assert.deepEqual(result.newProcessCounts, [0])
  assert.equal(snapshots.length, 0)
})

test('process tree aggregation counts shared mappings proportionally without unrelated processes', async () => {
  const files = new Map([
    ['/proc/10/status', status(10, 1, 100)],
    ['/proc/11/status', status(11, 10, 100)],
    ['/proc/12/status', status(12, 99, 900)],
    ['/proc/10/smaps_rollup', rollup(60, 10, 10)],
    ['/proc/11/smaps_rollup', rollup(60, 10, 10)]
  ])
  const result = await aggregateProcessTreeMemory(10, fakeProc(['10', '11', '12'], files))
  assert.deepEqual(result, {
    rssKiB: 200,
    pssKiB: 120,
    privateKiB: 40,
    processCount: 2,
    measuredPids: [10, 11],
    exitedPids: []
  })
})

test('process tree aggregation tolerates an exited descendant but not inaccessible memory', async () => {
  const files = new Map([
    ['/proc/10/status', status(10, 1, 100)],
    ['/proc/11/status', status(11, 10, 50)],
    ['/proc/10/smaps_rollup', rollup(60, 10, 10)]
  ])
  const result = await aggregateProcessTreeMemory(10, fakeProc(['10', '11'], files))
  assert.deepEqual(result.exitedPids, [11])
  assert.equal(result.processCount, 1)

  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  files.set('/proc/11/smaps_rollup', denied)
  await assert.rejects(aggregateProcessTreeMemory(10, fakeProc(['10', '11'], files)), /denied/u)
})

function status(pid, parentPid, rssKiB) {
  return `Name:\tapp\nPid:\t${pid}\nPPid:\t${parentPid}\nVmRSS:\t${rssKiB} kB\n`
}

function processStat(pid, command, parentPid, userJiffies, systemJiffies, startTime) {
  const fields = Array.from({ length: 50 }, () => '0')
  fields[0] = 'S'
  fields[1] = String(parentPid)
  fields[11] = String(userJiffies)
  fields[12] = String(systemJiffies)
  fields[19] = String(startTime)
  return `${pid} (${command}) ${fields.join(' ')}\n`
}

function systemStat(totalJiffies, cpuCount) {
  return `cpu ${totalJiffies} 0 0 0 0 0 0 0\n${Array.from(
    { length: cpuCount },
    (_, index) => `cpu${index} 1 0 0 0`
  ).join('\n')}\n`
}

function cpuProcess(pid, parentPid, startTime, cpuJiffies) {
  return { pid, parentPid, startTime, cpuJiffies }
}

function cpuSnapshot(totalJiffies, processes) {
  return { cpuCount: 2, totalJiffies, rootIdentity: '10:100', processes }
}

function rollup(pssKiB, privateCleanKiB, privateDirtyKiB) {
  return `Pss: ${pssKiB} kB\nPrivate_Clean: ${privateCleanKiB} kB\nPrivate_Dirty: ${privateDirtyKiB} kB\n`
}

function fakeProc(entries, files) {
  return {
    readdir: async () => entries,
    readFile: async (path) => {
      const value = files.get(path)
      if (value instanceof Error) throw value
      if (value !== undefined) return value
      throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
    }
  }
}

function metricFixture(id, p95, operator = '<=') {
  return metric({
    id,
    unit: operator === '>=' ? 'fps' : 'ms',
    samples: [p95],
    threshold: { operator, statistic: 'p95', value: operator === '>=' ? 50 : 10 },
    gate: 'informational'
  })
}

function fixture(metrics = [metricFixture('dispatch', 10)]) {
  return {
    schemaVersion: 1,
    suite: 'agent-workspace-performance',
    mode: 'smoke',
    fullSoak: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    environment: {
      platform: 'linux',
      arch: 'x64',
      kernel: 'test',
      hostname: 'test',
      cpuCount: 1,
      node: 'v1',
      ci: false,
      releaseBuild: true
    },
    metrics,
    scenarios: ['8-hour output soak: not run in smoke mode']
  }
}

function soakFixture() {
  const elapsed = Array.from(
    { length: SOAK_SAMPLE_COUNT },
    (_, index) => index * SOAK_SAMPLE_INTERVAL_MS
  )
  const memory = elapsed.map((_, index) => 200 + index / 1_000)
  const report = fixture([
    metric({
      id: 'soak.sample_elapsed',
      unit: 'ms',
      samples: elapsed,
      threshold: null,
      gate: 'informational'
    }),
    metric({
      id: 'soak.application_pss',
      unit: 'MiB',
      samples: memory,
      threshold: null,
      gate: 'manual'
    }),
    metric({
      id: 'soak.aggregate_rss',
      unit: 'MiB',
      samples: memory.map((sample) => sample + 100),
      threshold: null,
      gate: 'informational'
    }),
    metric({
      id: 'soak.private_memory',
      unit: 'MiB',
      samples: memory.map((sample) => sample - 50),
      threshold: null,
      gate: 'informational'
    })
  ])
  return {
    ...report,
    mode: 'soak',
    fullSoak: true,
    completedAt: new Date(Date.parse(report.startedAt) + FULL_SOAK_MS).toISOString(),
    scenarios: ['full 8-hour continuous output soak']
  }
}

function withMetricSamples(report, id, samples) {
  return {
    ...report,
    metrics: report.metrics.map((entry) =>
      entry.id === id
        ? metric({
            id: entry.id,
            unit: entry.unit,
            samples,
            threshold: entry.threshold,
            gate: entry.gate,
            notes: entry.notes
          })
        : entry
    )
  }
}
