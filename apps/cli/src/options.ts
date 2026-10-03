export function flags(
  args: string[],
  allowed: readonly string[],
  commandTail = false,
  tailFlag = '--command'
) {
  const values = new Map<string, string>()
  let command: string[] | undefined
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (commandTail && flag === tailFlag) {
      command = args.slice(index + 1)
      if (command.length === 0) throw new Error(`${tailFlag} requires a program`)
      break
    }
    if (!allowed.includes(flag) || values.has(flag)) {
      throw new Error(`Unknown or repeated option: ${flag}`)
    }
    const value = args[index + 1]
    if (value === undefined || allowed.includes(value)) {
      throw new Error(`${flag} requires a value`)
    }
    values.set(flag, value)
    index += 1
  }
  return { values, command }
}

export function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)
  if (!value) throw new Error(`${flag} is required`)
  return value
}

export function jsonParams(args: string[]): unknown {
  const { values } = flags(args, ['--params-json'])
  const raw = required(values, '--params-json')
  if (Buffer.byteLength(raw) > 64 * 1024) {
    throw new Error('JSON request is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error('Request must be a JSON object')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request must be a JSON object')
  }
  return parsed
}
