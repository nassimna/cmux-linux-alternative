import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analyzeSoakReport, normalizeCliArguments } from './analyze-soak.mjs'
import { FULL_SOAK_MS, SOAK_SAMPLE_COUNT, SOAK_SAMPLE_INTERVAL_MS, metric } from './result.mjs'

const HOUR_MS = 60 * 60 * 1_000

test('soak analysis accepts the conventional pnpm argument separator', () => {
  assert.deepEqual(normalizeCliArguments(['--', '/tmp/report.json']), ['/tmp/report.json'])
  assert.deepEqual(normalizeCliArguments(['/tmp/report.json']), ['/tmp/report.json'])
})

test('soak analysis reports deterministic flat descriptive trends without a verdict', () => {
  const report = soakFixture(() => 200)
  const first = analyzeSoakReport(report)
  const second = analyzeSoakReport(report)
  assert.deepEqual(first, second)
  assert.equal(first.sampleCount, SOAK_SAMPLE_COUNT)
  assert.equal(first.elapsedHours, 8)
  assert.deepEqual(first.memory.applicationPss, {
    unit: 'MiB',
    first: 200,
    last: 200,
    delta: 0,
    min: 200,
    max: 200,
    wholeRunSlopeMiBPerHour: 0,
    lateTwoHourSlopeMiBPerHour: 0,
    firstHourMean: 200,
    finalHourMean: 200,
    firstToFinalHourMeanDelta: 0
  })
  assert.equal(first.interpretation.automatedPassFail, false)
  assert.equal(first.interpretation.manualReviewRequired, true)
})

test('soak analysis computes transparent whole-run and late-window linear trends', () => {
  const report = soakFixture((elapsed) => 100 + (elapsed / HOUR_MS) * 2)
  const analysis = analyzeSoakReport(report)
  assert.deepEqual(analysis.memory.applicationPss, {
    unit: 'MiB',
    first: 100,
    last: 116,
    delta: 16,
    min: 100,
    max: 116,
    wholeRunSlopeMiBPerHour: 2,
    lateTwoHourSlopeMiBPerHour: 2,
    firstHourMean: 101,
    finalHourMean: 115,
    firstToFinalHourMeanDelta: 14
  })
})

test('soak analysis rejects a structurally valid smoke report', () => {
  const smoke = {
    ...baseReport(),
    mode: 'smoke',
    fullSoak: false,
    completedAt: '2026-01-01T00:00:01.000Z',
    metrics: [
      metric({
        id: 'smoke.example',
        unit: 'ms',
        samples: [1],
        threshold: null,
        gate: 'informational'
      })
    ],
    scenarios: ['8-hour output soak: not run in smoke mode']
  }
  assert.throws(() => analyzeSoakReport(smoke), /requires a validated soak report/u)
})

function soakFixture(pssValue) {
  const elapsed = Array.from(
    { length: SOAK_SAMPLE_COUNT },
    (_, index) => index * SOAK_SAMPLE_INTERVAL_MS
  )
  const pss = elapsed.map(pssValue)
  return {
    ...baseReport(),
    metrics: [
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
        samples: pss,
        threshold: null,
        gate: 'manual'
      }),
      metric({
        id: 'soak.aggregate_rss',
        unit: 'MiB',
        samples: pss.map((sample) => sample + 100),
        threshold: null,
        gate: 'informational'
      }),
      metric({
        id: 'soak.private_memory',
        unit: 'MiB',
        samples: pss.map((sample) => sample - 50),
        threshold: null,
        gate: 'informational'
      })
    ],
    scenarios: ['full 8-hour continuous output soak']
  }
}

function baseReport() {
  return {
    schemaVersion: 1,
    suite: 'agent-workspace-performance',
    mode: 'soak',
    fullSoak: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + FULL_SOAK_MS).toISOString(),
    environment: {
      platform: 'linux',
      arch: 'x64',
      kernel: 'test',
      hostname: 'test',
      cpuCount: 1,
      node: 'v1',
      ci: false,
      releaseBuild: true
    }
  }
}
