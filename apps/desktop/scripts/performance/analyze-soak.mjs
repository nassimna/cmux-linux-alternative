import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { SOAK_SAMPLE_COUNT, validateReport } from './result.mjs'

const HOUR_MS = 60 * 60 * 1_000
const METRICS = {
  elapsed: 'soak.sample_elapsed',
  pss: 'soak.application_pss',
  rss: 'soak.aggregate_rss',
  privateMemory: 'soak.private_memory'
}

export function analyzeSoakReport(value) {
  const report = validateReport(value)
  if (report.mode !== 'soak') throw new Error('soak analysis requires a validated soak report')

  const metrics = new Map(report.metrics.map((entry) => [entry.id, entry]))
  const elapsed = requiredSamples(metrics, METRICS.elapsed)
  const pss = requiredSamples(metrics, METRICS.pss)
  const rss = requiredSamples(metrics, METRICS.rss)
  const privateMemory = requiredSamples(metrics, METRICS.privateMemory)

  return {
    schemaVersion: 1,
    suite: 'agent-workspace-soak-analysis',
    source: {
      suite: report.suite,
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      platform: report.environment.platform,
      arch: report.environment.arch
    },
    sampleCount: elapsed.length,
    elapsedHours: rounded(elapsed.at(-1) / HOUR_MS),
    memory: {
      applicationPss: analyzeSeries(elapsed, pss),
      aggregateRss: analyzeSeries(elapsed, rss),
      privateMemory: analyzeSeries(elapsed, privateMemory)
    },
    interpretation: {
      automatedPassFail: false,
      manualReviewRequired: true,
      primarySeries: 'applicationPss',
      reviewQuestions: [
        'Is late-run PSS growth sustained rather than bounded allocator or workload variation?',
        'Do the time series or run logs show OOM kills, renderer restarts, or service restarts?',
        'Are the host, compositor, power profile, and unrelated workloads documented for comparison?'
      ]
    }
  }
}

export function normalizeCliArguments(args) {
  return args[0] === '--' ? args.slice(1) : args
}

function analyzeSeries(elapsed, samples) {
  if (elapsed.length !== SOAK_SAMPLE_COUNT || samples.length !== elapsed.length) {
    throw new Error('soak analysis requires aligned validated samples')
  }
  const firstHour = samples.filter((_, index) => elapsed[index] <= elapsed[0] + HOUR_MS)
  const finalHour = samples.filter((_, index) => elapsed[index] >= elapsed.at(-1) - HOUR_MS)
  const lateStart = elapsed.at(-1) - 2 * HOUR_MS
  const lateElapsed = []
  const lateSamples = []
  for (let index = 0; index < elapsed.length; index += 1) {
    if (elapsed[index] < lateStart) continue
    lateElapsed.push(elapsed[index])
    lateSamples.push(samples[index])
  }
  const first = samples[0]
  const last = samples.at(-1)
  const firstHourMean = mean(firstHour)
  const finalHourMean = mean(finalHour)
  return {
    unit: 'MiB',
    first: rounded(first),
    last: rounded(last),
    delta: rounded(last - first),
    min: rounded(Math.min(...samples)),
    max: rounded(Math.max(...samples)),
    wholeRunSlopeMiBPerHour: rounded(linearSlopePerHour(elapsed, samples)),
    lateTwoHourSlopeMiBPerHour: rounded(linearSlopePerHour(lateElapsed, lateSamples)),
    firstHourMean: rounded(firstHourMean),
    finalHourMean: rounded(finalHourMean),
    firstToFinalHourMeanDelta: rounded(finalHourMean - firstHourMean)
  }
}

function linearSlopePerHour(elapsed, samples) {
  const hours = elapsed.map((value) => value / HOUR_MS)
  const meanHours = mean(hours)
  const meanSamples = mean(samples)
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < hours.length; index += 1) {
    const centeredHour = hours[index] - meanHours
    numerator += centeredHour * (samples[index] - meanSamples)
    denominator += centeredHour * centeredHour
  }
  if (denominator === 0) throw new Error('soak analysis requires a nonzero time range')
  return numerator / denominator
}

function requiredSamples(metrics, id) {
  const entry = metrics.get(id)
  if (!entry) throw new Error(`validated report is missing ${id}`)
  return entry.samples
}

function mean(samples) {
  if (samples.length === 0) throw new Error('soak analysis window has no samples')
  return samples.reduce((total, sample) => total + sample, 0) / samples.length
}

function rounded(value) {
  return Number(value.toFixed(6))
}

async function main(args) {
  const normalizedArgs = normalizeCliArguments(args)
  if (normalizedArgs.length !== 1) {
    throw new Error('usage: analyze-soak.mjs <validated-soak-report.json>')
  }
  const report = JSON.parse(await readFile(resolve(normalizedArgs[0]), 'utf8'))
  process.stdout.write(`${JSON.stringify(analyzeSoakReport(report), null, 2)}\n`)
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedUrl === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
