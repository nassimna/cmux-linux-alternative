import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseBrowserFetch, runBrowserFetch } from './browser-fetch'

void test('fetch requires the explicit engine and validates URL, format, and deadline', () => {
  const parse = (tail: string[]) => parseBrowserFetch(['browser', 'fetch', ...tail], '/unused')
  const args = ['--engine', 'lightpanda', '--url', 'https://example.com']
  assert.equal(parseBrowserFetch(['browser', 'open'], '/unused'), undefined)
  assert.throws(() => parse(['--url', 'https://example.com']), /--engine is required/)
  assert.throws(() => parse(['--engine', 'chromium', '--url', 'https://example.com']), /engine/)
  for (const url of ['file:///private', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    assert.throws(() => parse(['--engine', 'lightpanda', '--url', url]), /HTTP\(S\)/)
  }
  assert.throws(() => parse([...args, '--format', 'png']), /format/)
  assert.throws(() => parse([...args, '--timeout-ms', '0']), /timeout-ms/)
  assert.throws(() => parse([...args, '--timeout-ms', '120001']), /timeout-ms/)
  assert.equal(parse(args)?.format, 'markdown')
  assert.equal(parse(args)?.timeoutMs, 30000)
})

void test(
  'fetch passes literal arguments, disables telemetry, and returns the engine JSON',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(homedir(), 'ternline-fetch-test-'))
    try {
      const executable = join(directory, 'lightpanda')
      await writeFile(
        executable,
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),telemetry:process.env.LIGHTPANDA_DISABLE_TELEMETRY,coreDump:process.env.LIGHTPANDA_DISABLE_CORE_DUMP}))`,
        { mode: 0o700 }
      )
      const url = 'https://example.com/?q=$(echo%20secret)'
      const parsed = parseBrowserFetch(
        [
          'browser',
          'fetch',
          '--engine',
          'lightpanda',
          '--url',
          url,
          '--executable',
          executable,
          '--format',
          'html',
          '--wait-selector',
          '#ready'
        ],
        '/unused'
      )!
      assert.deepEqual(await runBrowserFetch(parsed), {
        engine: 'lightpanda',
        format: 'html',
        result: {
          args: [
            'fetch',
            '--dump',
            'html',
            '--json',
            '--fail-on-http-error',
            '--http-max-response-size',
            '8388608',
            '--log-level',
            'error',
            '--wait-selector',
            '#ready',
            url
          ],
          telemetry: 'true',
          coreDump: '1'
        }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

void test(
  'fetch fails on engine errors, output overflow, and timeout rather than returning page content',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(homedir(), 'ternline-fetch-test-'))
    try {
      const executable = join(directory, 'lightpanda')
      const parsed = parseBrowserFetch(
        [
          'browser',
          'fetch',
          '--engine',
          'lightpanda',
          '--url',
          'https://example.com',
          '--executable',
          executable
        ],
        '/unused'
      )!
      await assert.rejects(runBrowserFetch(parsed), /executable not found/)
      await writeFile(executable, `#!${process.execPath}\nprocess.exit(22)`, { mode: 0o700 })
      await assert.rejects(runBrowserFetch(parsed), /fetch failed/)
      await writeFile(
        executable,
        `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2*1024*1024))`
      )
      await assert.rejects(runBrowserFetch(parsed), /1 MiB limit/)
      await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{},1000)`)
      await assert.rejects(runBrowserFetch({ ...parsed, timeoutMs: 100 }), /timeout-ms/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
