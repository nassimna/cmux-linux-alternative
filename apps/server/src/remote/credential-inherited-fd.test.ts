import { spawnSync } from 'node:child_process'
import { closeSync, constants, openSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'linux')('consumes only a safe read-only inherited fd 3 once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'credential-fd-'))
  try {
    const modulePath = join(root, 'reader.mjs')
    const runnerPath = join(root, 'runner.mjs')
    await build({
      entryPoints: [fileURLToPath(new URL('./credential-inherited-fd.ts', import.meta.url))],
      outfile: modulePath, bundle: true, platform: 'node', format: 'esm',
      external: ['ssh2'], logLevel: 'silent'
    })
    await writeFile(runnerPath, `import { fstatSync } from 'node:fs';
import { readInheritedCredentialFd } from './reader.mjs';
let first, second, closed;
try { const bytes = readInheritedCredentialFd(3); first = bytes.equals(Buffer.from('fixture')); bytes.fill(0) }
catch (error) { first = error.code }
try { readInheritedCredentialFd(3); second = 'accepted' }
catch (error) { second = error.code }
try { fstatSync(3); closed = false } catch { closed = true }
process.stdout.write(JSON.stringify({ first, second, closed }));`)
    const run = (path: string, flags: number) => {
      const fd = openSync(path, flags)
      try {
        const child = spawnSync(process.execPath, [runnerPath], {
          stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 10_000,
          env: { PATH: process.env.PATH }
        })
        expect(child.status).toBe(0)
        return JSON.parse(child.stdout.toString()) as {
          first: boolean | string; second: string; closed: boolean
        }
      } finally {
        closeSync(fd)
      }
    }
    const safe = join(root, 'safe.key')
    await writeFile(safe, 'fixture', { mode: 0o600 })
    expect(run(safe, constants.O_RDONLY)).toEqual({ first: true, second: 'credential_revoked', closed: true })
    expect(run(safe, constants.O_RDWR)).toEqual({
      first: 'credential_revoked', second: 'credential_revoked', closed: true
    })
    await chmod(safe, 0o644)
    expect(run(safe, constants.O_RDONLY).first).toBe('credential_revoked')
    await chmod(safe, 0o600)
    await writeFile(safe, Buffer.alloc(64 * 1024 + 1), { mode: 0o600 })
    expect(run(safe, constants.O_RDONLY).first).toBe('credential_revoked')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
