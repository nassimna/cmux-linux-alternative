import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { flags, required } from './options'

const execute = promisify(execFile)

export interface BrowserFetchCommand {
  command: 'browser.fetch'
  sessionFile: string
  url: string
  executable: string
  format: 'markdown' | 'html'
  timeoutMs: number
  waitSelector?: string
}

export function parseBrowserFetch(
  args: string[],
  sessionFile: string
): BrowserFetchCommand | undefined {
  if (args[0] !== 'browser' || args[1] !== 'fetch') return undefined
  const { values } = flags(args.slice(2), [
    '--engine',
    '--url',
    '--executable',
    '--format',
    '--timeout-ms',
    '--wait-selector'
  ])
  if (required(values, '--engine') !== 'lightpanda') {
    throw new Error('--engine must be lightpanda')
  }
  const url = required(values, '--url')
  const parsed = new URL(url)
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    url.length > 2048
  ) {
    throw new Error('--url must be an HTTP(S) URL without credentials, at most 2048 characters')
  }
  const format = values.get('--format') ?? 'markdown'
  if (format !== 'markdown' && format !== 'html') {
    throw new Error('--format must be markdown or html')
  }
  const timeoutMs = Number(values.get('--timeout-ms') ?? '30000')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error('--timeout-ms must be an integer from 1 to 120000')
  }
  return {
    command: 'browser.fetch',
    sessionFile,
    url,
    executable: values.get('--executable') ?? process.env.LIGHTPANDA_EXECUTABLE ?? 'lightpanda',
    format,
    timeoutMs,
    ...(values.has('--wait-selector') ? { waitSelector: values.get('--wait-selector')! } : {})
  }
}

export async function runBrowserFetch(parsed: BrowserFetchCommand): Promise<unknown> {
  const args = [
    'fetch',
    '--dump',
    parsed.format,
    '--json',
    '--fail-on-http-error',
    '--http-max-response-size',
    '8388608',
    '--log-level',
    'error',
    ...(parsed.waitSelector ? ['--wait-selector', parsed.waitSelector] : []),
    parsed.url
  ]
  let stdout: string
  try {
    const output = await execute(parsed.executable, args, {
      encoding: 'utf8',
      timeout: parsed.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        LIGHTPANDA_DISABLE_TELEMETRY: 'true',
        LIGHTPANDA_DISABLE_CORE_DUMP: '1'
      }
    })
    stdout = output.stdout
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean }
    if (failure.code === 'ENOENT') {
      throw new Error(
        'Lightpanda executable not found; set --executable or LIGHTPANDA_EXECUTABLE',
        {
          cause: error
        }
      )
    }
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error('Lightpanda output exceeded the 1 MiB limit', { cause: error })
    }
    if (failure.killed) {
      throw new Error('Lightpanda fetch exceeded --timeout-ms', { cause: error })
    }
    throw new Error('Lightpanda fetch failed; check the URL, HTTP status, and executable version', {
      cause: error
    })
  }
  return { engine: 'lightpanda', format: parsed.format, result: JSON.parse(stdout) as unknown }
}
