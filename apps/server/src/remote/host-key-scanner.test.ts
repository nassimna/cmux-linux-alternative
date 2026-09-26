import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { knownHostsLine, parseHostKeyScan, scanWithExecutable } from './host-key-scanner'

const PUBLIC_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAICW+rN56TZ4v2OBKfDzkZK+U+rLj4TvipEzv9bJH5qI3'
const FINGERPRINT = 'SHA256:XThvJbHFz3VH4DMT5GnG7CFFOGmG6MIeX3kjq1yizEc'
const record = (host: string, port: number) =>
  `${port === 22 ? host : `[${host}]:${port}`} ssh-ed25519 ${PUBLIC_KEY}\n`

afterEach(() => vi.unstubAllEnvs())

describe('first-contact host-key scanning', () => {
  it('parses one normalized Ed25519 record and matches the OpenSSH SHA256 fingerprint', () => {
    const descriptor = parseHostKeyScan(
      Buffer.from(`# ssh-keyscan comment\n${record('example.com', 2222)}`),
      'example.com',
      2222
    )
    expect(descriptor).toEqual({
      canonicalHost: 'example.com',
      port: 2222,
      algorithm: 'ssh-ed25519',
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT
    })
    expect(knownHostsLine(descriptor)).toBe(record('example.com', 2222))
  })

  it.each([
    ['extra key', `${record('example.com', 22)}${record('example.com', 22)}`],
    ['wrong host', record('other.example', 22)],
    ['wrong port', record('example.com', 2222)],
    ['wrong algorithm', `example.com ssh-rsa ${PUBLIC_KEY}\n`],
    ['extra field', `example.com ssh-ed25519 ${PUBLIC_KEY} comment\n`],
    ['non-ASCII separator', `example.com\u00a0ssh-ed25519 ${PUBLIC_KEY}\n`],
    ['noncanonical base64', `example.com ssh-ed25519 ${PUBLIC_KEY}=\n`],
    ['malformed wire key', `example.com ssh-ed25519 ${Buffer.alloc(51).toString('base64')}\n`],
    ['invalid UTF-8', Buffer.from([0xff])],
    ['oversized scan', Buffer.alloc(8193, 0x23)]
  ])('rejects %s', (_case, output) => {
    expect(() =>
      parseHostKeyScan(Buffer.isBuffer(output) ? output : Buffer.from(output), 'example.com', 22)
    ).toThrowError(expect.objectContaining({ code: 'host_key_mismatch' }))
  })

  it.each(['-host.example', 'EXAMPLE.COM', 'white space', 'example.com\nother'])(
    'rejects unsafe target %s before parsing',
    (host) => {
      expect(() => parseHostKeyScan(Buffer.from(record('example.com', 22)), host, 22)).toThrowError(
        expect.objectContaining({ code: 'invalid_target' })
      )
    }
  )

  it('runs a fixed bounded scanner invocation without inheriting the server environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-host-key-scan-'))
    try {
      const scanner = join(directory, 'ssh-keyscan-fixture')
      await writeFile(
        scanner,
        `#!/bin/sh
[ "$#" = 7 ] && [ "$1" = -T ] && [ "$2" = 5 ] && [ "$3" = -p ] && [ "$4" = 22 ] && [ "$5" = -t ] && [ "$6" = ed25519 ] && [ "$7" = example.com ] || exit 3
[ -z "\${AGENT_WORKSPACE_SCAN_TEST_MARKER+x}" ] || exit 4
/usr/bin/printf '%s\\n' 'example.com ssh-ed25519 ${PUBLIC_KEY}'
`,
        { mode: 0o700 }
      )
      vi.stubEnv('AGENT_WORKSPACE_SCAN_TEST_MARKER', 'must-not-reach-child')
      expect(await scanWithExecutable(scanner, 'example.com', 22)).toMatchObject({
        fingerprint: FINGERPRINT
      })
      await expect(scanWithExecutable(scanner, '-unsafe', 22)).rejects.toMatchObject({
        code: 'invalid_target'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
