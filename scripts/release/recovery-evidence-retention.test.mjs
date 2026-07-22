import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  persistRecoveryEvidence,
  recoveryEvidenceFileName
} from '../../apps/desktop/scripts/recovery-evidence.mjs'

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const desktopDirectory = join(repositoryDirectory, 'apps', 'desktop')
const execFileAsync = promisify(execFile)

test('passing recovery evidence survives failures-only Playwright output cleanup', async () => {
  const root = await mkdtemp(join(desktopDirectory, '.recovery-evidence-retention-'))
  const playwrightOutput = join(root, 'playwright-results')
  const evidenceDirectory = join(root, 'release-validation', 'recovery', 'evidence')
  try {
    const helperUrl = pathToFileURL(
      join(desktopDirectory, 'scripts', 'recovery-evidence.mjs')
    ).href
    const testPath = join(root, 'recovery-evidence.spec.mjs')
    const configPath = join(root, 'playwright.config.mjs')
    await writeFile(
      testPath,
      `import { writeFile } from 'node:fs/promises'
import { test } from '@playwright/test'
import { persistRecoveryEvidence } from '${helperUrl}'

test('retains stable evidence for a passing test', async ({}, testInfo) => {
  const screenshot = Buffer.from('${onePixelPng.toString('base64')}', 'base64')
  await writeFile(testInfo.outputPath('passing-test-output.png'), screenshot)
  await persistRecoveryEvidence(process.env.AGENT_WORKSPACE_EVIDENCE_DIR, screenshot)
})
`
    )
    await writeFile(
      configPath,
      `export default {
  outputDir: ${JSON.stringify(playwrightOutput)},
  preserveOutput: 'failures-only',
  reporter: 'line',
  testDir: ${JSON.stringify(root)}
}
`
    )
    await execFileAsync(
      'pnpm',
      [
        '--filter',
        '@agent-workspace/desktop',
        'exec',
        'playwright',
        'test',
        testPath,
        `--config=${configPath}`
      ],
      {
        cwd: repositoryDirectory,
        env: { ...process.env, AGENT_WORKSPACE_EVIDENCE_DIR: evidenceDirectory }
      }
    )

    const evidencePath = join(evidenceDirectory, recoveryEvidenceFileName)
    const remainingOutput = await readdir(playwrightOutput, { recursive: true })
    assert.ok(
      !remainingOutput.some((path) => path.endsWith('passing-test-output.png'))
    )
    assert.deepEqual(await readFile(evidencePath), onePixelPng)
    assert.ok((await stat(evidencePath)).size > 0)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('focused recovery test uses stable evidence alongside failures-only output retention', async () => {
  const [playwrightConfig, recoverySpec] = await Promise.all([
    readFile(
      new URL('../../apps/desktop/playwright.config.mjs', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../../apps/desktop/e2e/persistence-recovery.spec.mjs', import.meta.url),
      'utf8'
    )
  ])
  assert.match(playwrightConfig, /preserveOutput: 'failures-only'/u)
  assert.match(recoverySpec, /await persistRecoveryEvidence\(/u)
  assert.match(recoverySpec, /process\.env\.AGENT_WORKSPACE_EVIDENCE_DIR/u)
})

test('recovery evidence destination must be an absolute, non-empty safe path', async () => {
  await assert.rejects(persistRecoveryEvidence('', onePixelPng), /non-empty path/u)
  await assert.rejects(persistRecoveryEvidence('relative/evidence', onePixelPng), /absolute path/u)
  await assert.rejects(persistRecoveryEvidence('/tmp/unsafe\0path', onePixelPng), /NUL bytes/u)
  assert.equal(await persistRecoveryEvidence(undefined, onePixelPng), undefined)
})
