#!/usr/bin/env node

import { inspectCutoverPreflight } from './persistence/cutover-preflight'

async function main(): Promise<void> {
  const [source, backup, working] = process.argv.slice(2)
  if (!source || !backup || !working || process.argv.length !== 5) {
    throw new Error('Usage: cutover-preflight SOURCE BACKUP WORKING')
  }
  const report = await inspectCutoverPreflight({ source, backup, working })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.blockers.length > 0) process.exitCode = 2
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Preflight failed'}\n`)
  process.exitCode = 1
})
