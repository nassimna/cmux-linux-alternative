import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { NodeCopyDiagnostics } from './node-copy-diagnostics'

it('exports the exact redacted isolated log snapshot once after the sidecar is down', () => {
  const root = mkdtempSync(join(tmpdir(), 'node-copy-diagnostics-'))
  const sourceRoot = join(root, 'source')
  const copyRoot = join(root, 'copy')
  const liveRoot = join(root, 'live')
  for (const path of [
    sourceRoot,
    copyRoot,
    liveRoot,
    join(copyRoot, 'logs'),
    join(liveRoot, 'logs')
  ]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const sourcePath = join(sourceRoot, 'state.sqlite')
  const backupPath = join(copyRoot, 'backup.sqlite')
  const workingPath = join(copyRoot, 'state.sqlite')
  const liveDatabasePath = join(liveRoot, 'state.sqlite')
  const liveLogDirectory = join(liveRoot, 'logs')
  const copyLog = join(copyRoot, 'logs', 'diagnostics.jsonl')
  try {
    for (const path of [sourcePath, backupPath, workingPath, liveDatabasePath]) {
      writeFileSync(path, 'isolated fixture', { mode: 0o600 })
    }
    const workingFile = lstatSync(workingPath)
    const backupFile = lstatSync(backupPath)
    writeFileSync(
      `${workingPath}.copy-manifest.json`,
      JSON.stringify({
        version: 1,
        source: sourcePath,
        backup: backupPath,
        working: workingPath,
        workingIdentity: `${workingFile.dev}:${workingFile.ino}`,
        backupIdentity: `${backupFile.dev}:${backupFile.ino}`,
        backupSha256: '0'.repeat(64)
      }),
      { mode: 0o600 }
    )
    writeFileSync(copyLog, '{"message":"token=private-copy-secret"}\n', { mode: 0o600 })
    writeFileSync(join(liveLogDirectory, 'diagnostics.jsonl'), 'live-rust-secret', { mode: 0o600 })
    const diagnostics = new NodeCopyDiagnostics({
      sourcePath,
      backupPath,
      workingPath,
      liveDatabasePath,
      liveLogDirectory
    })
    const preview = diagnostics.preview()
    expect(preview.entries.map(({ name }) => name)).toContain('logs/service.json')
    writeFileSync(copyLog, '{"message":"new-log"}\n', { mode: 0o600 })
    const destination = join(root, 'export.json')
    diagnostics.export(destination, preview)
    const exported = readFileSync(destination, 'utf8')
    expect(exported).not.toContain('private-copy-secret')
    expect(exported).not.toContain('live-rust-secret')
    expect(exported).not.toContain('new-log')
    expect(lstatSync(destination).mode & 0o077).toBe(0)
    expect(() => diagnostics.export(join(root, 'second.json'), preview)).toThrow('must be approved')

    diagnostics.preview()
    expect(() => diagnostics.export(join(root, 'stale.json'), preview)).toThrow('does not match')
    expect(() => diagnostics.export(join(root, 'again.json'), preview)).toThrow('must be approved')
  } finally {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects a symlinked copy log directory without reading its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'node-copy-diagnostics-link-'))
  const sourceRoot = join(root, 'source')
  const copyRoot = join(root, 'copy')
  const liveRoot = join(root, 'live')
  for (const path of [sourceRoot, copyRoot, liveRoot, join(liveRoot, 'logs')]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const sourcePath = join(sourceRoot, 'state.sqlite')
  const backupPath = join(copyRoot, 'backup.sqlite')
  const workingPath = join(copyRoot, 'state.sqlite')
  const liveDatabasePath = join(liveRoot, 'state.sqlite')
  const liveLogDirectory = join(liveRoot, 'logs')
  try {
    for (const path of [sourcePath, backupPath, workingPath, liveDatabasePath]) {
      writeFileSync(path, 'fixture', { mode: 0o600 })
    }
    symlinkSync(liveLogDirectory, join(copyRoot, 'logs'))
    const diagnostics = new NodeCopyDiagnostics({
      sourcePath,
      backupPath,
      workingPath,
      liveDatabasePath,
      liveLogDirectory
    })
    expect(() => diagnostics.preview()).toThrow('Unsafe diagnostics directory')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects an active log without the copy ownership record', () => {
  const root = mkdtempSync(join(tmpdir(), 'node-copy-diagnostics-unmarked-'))
  const sourceRoot = join(root, 'source')
  const copyRoot = join(root, 'copy')
  const liveRoot = join(root, 'live')
  for (const path of [
    sourceRoot,
    copyRoot,
    liveRoot,
    join(copyRoot, 'logs'),
    join(liveRoot, 'logs')
  ]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const sourcePath = join(sourceRoot, 'state.sqlite')
  const backupPath = join(copyRoot, 'backup.sqlite')
  const workingPath = join(copyRoot, 'state.sqlite')
  const liveDatabasePath = join(liveRoot, 'state.sqlite')
  try {
    for (const path of [sourcePath, backupPath, workingPath, liveDatabasePath]) {
      writeFileSync(path, 'fixture', { mode: 0o600 })
    }
    writeFileSync(join(copyRoot, 'logs', 'diagnostics.jsonl'), 'unqualified log', {
      mode: 0o600
    })
    const diagnostics = new NodeCopyDiagnostics({
      sourcePath,
      backupPath,
      workingPath,
      liveDatabasePath,
      liveLogDirectory: join(liveRoot, 'logs')
    })
    expect(() => diagnostics.preview()).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
