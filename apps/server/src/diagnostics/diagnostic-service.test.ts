import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { DiagnosticService, createSafeConfigurationSummary } from './diagnostic-service'
import { redact } from './redact'
import { RotatingDiagnosticLog } from './rotating-log'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): { directory: string; service: DiagnosticService } {
  const directory = mkdtempSync(join(tmpdir(), 'node-diagnostics-test-'))
  chmodSync(directory, 0o700)
  dirs.push(directory)
  const service = new DiagnosticService({
    logDirectory: directory,
    application: 'agent-workspace',
    version: '1.0.0',
    platform: 'linux',
    recovery: 'healthy',
    configurationSummary: createSafeConfigurationSummary({
      schemaVersion: 2,
      terminal: { shellPath: '/private/shell', fontSize: 13 },
      browser: { privacy: 'standard', profileName: 'private' },
      token: 'never-export'
    })
  })
  return { directory, service }
}

it('redacts nested secrets, URL credentials, assignments, and bounds recursive values', () => {
  const report = redact({
    nested: { access_key: 'hidden', text: 'Bearer private-token password=another' },
    url: 'https://user:pass@example.test/path?token=secret#fragment'
  })
  const serialized = JSON.stringify(report.value)
  expect(serialized).not.toContain('hidden')
  expect(serialized).not.toContain('private-token')
  expect(serialized).not.toContain('another')
  expect(serialized).not.toContain('user:pass')
  expect(serialized).not.toContain('token=secret')
  expect(report.redactions).toBeGreaterThan(1)
})

it('previews an allowlisted bundle and exports the exact approved content once', () => {
  const { directory, service } = fixture()
  const writer = new RotatingDiagnosticLog(directory)
  writer.writeLine('Authorization: hidden password=also-hidden')
  writer.close()

  const preview = service.preview()
  expect(preview.entries.map((entry) => entry.name)).toEqual([
    'configuration-summary.json',
    'logs/service.json',
    'metadata.json',
    'recovery.json'
  ])
  expect(preview.totalBytes).toBe(preview.entries.reduce((sum, entry) => sum + entry.bytes, 0))
  expect(preview.redactionCount).toBeGreaterThan(0)
  const destination = join(directory, 'bundle.json')
  const result = service.export(destination, preview)
  const bytes = readFileSync(destination)
  expect(result).toEqual({ path: destination, bytes: bytes.length })
  expect(lstatSync(destination).mode & 0o077).toBe(0)
  const bundle = JSON.parse(bytes.toString()) as {
    format: string
    manifest: { totalTruncations: number }
    entries: Record<string, Record<string, unknown>>
  }
  expect(bundle.format).toBe('agent-workspace-diagnostic-bundle-v1')
  expect(bundle.manifest.totalTruncations).toBe(0)
  const config = bundle.entries['configuration-summary.json']
  expect(config).toBeDefined()
  expect(config?.terminal).not.toHaveProperty('shellPath')
  expect(config?.browser).not.toHaveProperty('profileName')
  expect(config).not.toHaveProperty('token')
  expect(bytes.toString()).not.toContain('hidden')
  expect(() => service.export(join(directory, 'other.json'), preview)).toThrow('must be approved')
})

it('consumes mismatched approval, exports the approved snapshot, and rejects existing destinations', () => {
  const { directory, service } = fixture()
  const preview = service.preview()
  const destination = join(directory, 'bundle.json')
  expect(() =>
    service.export(destination, { ...preview, createdAt: preview.createdAt + 1 })
  ).toThrow('does not match')
  expect(() => service.export(destination, preview)).toThrow('must be approved')

  const writer = new RotatingDiagnosticLog(directory)
  const fresh = service.preview()
  writer.writeLine('New event')
  writer.close()
  expect(service.export(destination, fresh).bytes).toBeGreaterThan(0)
  expect(readFileSync(destination, 'utf8')).not.toContain('New event')

  const current = service.preview()
  expect(() => service.export(destination, current)).toThrow('already exists')
  expect(readFileSync(destination, 'utf8')).not.toContain('New event')
})

it('rejects a symlinked log and unsafe private file mode', () => {
  const { directory, service } = fixture()
  const target = join(directory, 'target')
  writeFileSync(target, 'secret')
  symlinkSync(target, join(directory, 'diagnostics.jsonl'))
  expect(() => service.preview()).toThrow('Unsafe diagnostics file')
})

it('bounds records and rotates private log files before the active file exceeds its limit', () => {
  const { directory } = fixture()
  const writer = new RotatingDiagnosticLog(directory)
  for (let i = 0; i < 1100; i++) writer.writeLine('x'.repeat(5000))
  writer.close()
  const names = readdirSync(directory)
  expect(names).toContain('diagnostics.000001.jsonl')
  for (const name of names.filter((candidate) => candidate.endsWith('.jsonl'))) {
    const path = join(directory, name)
    expect(lstatSync(path).size).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(lstatSync(path).mode & 0o077).toBe(0)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    for (const line of lines) {
      const record = JSON.parse(line) as { message: string }
      expect(record.message.length).toBeLessThanOrEqual(4096)
    }
  }
})
