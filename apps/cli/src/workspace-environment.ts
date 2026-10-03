import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export function workspaceEnvironment(args: string[]) {
  const remaining: string[] = []
  const entries: string[] = []
  let file: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--command') {
      remaining.push(...args.slice(index))
      break
    }
    if (arg !== '--env' && arg !== '--env-file') {
      remaining.push(arg)
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--env') entries.push(value)
    else {
      if (file !== undefined) throw new Error('Unknown or repeated option: --env-file')
      file = value
    }
    index += 1
  }
  const environment = (file === undefined ? {} : parseEnv(readFileSync(file, 'utf8'))) as Record<
    string,
    string
  >
  for (const entry of entries) {
    const equal = entry.indexOf('=')
    if (equal < 1) throw new Error('--env requires KEY=VALUE')
    Object.defineProperty(environment, entry.slice(0, equal), {
      value: entry.slice(equal + 1),
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes('\0')) {
      throw new Error('Workspace environment requires valid variable names and NUL-free values')
    }
  }
  return { args: remaining, ...(file !== undefined || entries.length > 0 ? { environment } : {}) }
}
