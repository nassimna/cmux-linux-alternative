import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { flags, jsonParams, required } from './options'

type BrowserAutomationAction =
  'create' | 'get' | 'execute' | 'cancel' | 'read' | 'release' | 'destroy'

export type BrowserAutomationCommand =
  | { sessionFile: string; command: 'browser-automation.list' }
  | { sessionFile: string; command: 'browser.attach'; tabId: string }
  | {
      sessionFile: string
      command: 'browser.run'
      sessionId?: string
      operation: Record<string, unknown>
      output?: string
      timeoutMs?: number
      follow?: boolean
    }
  | {
      sessionFile: string
      command: `browser-automation.${BrowserAutomationAction}`
      params: unknown
    }

const actions: readonly string[] = [
  'create',
  'get',
  'execute',
  'cancel',
  'read',
  'release',
  'destroy'
]

export function parseBrowserAutomation(
  args: string[],
  sessionFile: string
): BrowserAutomationCommand | undefined {
  if (args[0] === 'browser') {
    const action = args[1]
    if (action === 'attach') {
      const { values } = flags(args.slice(2), ['--tab-id'])
      return { sessionFile, command: 'browser.attach', tabId: required(values, '--tab-id') }
    }
    const targets = ['--selector', '--role', '--name', '--text-target']
    const actionFlags: Record<string, string[]> = {
      open: ['--url'],
      click: targets,
      type: [...targets, '--text', '--clear'],
      press: [...targets, '--key', '--modifiers'],
      screenshot: ['--width', '--height', '--output'],
      snapshot: [],
      eval: ['--expression'],
      query: [...targets, '--limit'],
      console: ['--clear', '--follow', '--level', '--after'],
      errors: ['--clear', '--follow', '--level', '--after'],
      scroll: ['--delta-x', '--delta-y', '--selector'],
      wait: ['--text', '--url', '--selector', '--timeout-ms'],
      resize: ['--width', '--height'],
      appearance: ['--theme'],
      'network.start': [],
      'network.list': ['--after'],
      'network.get': ['--request-id'],
      'network.body': ['--request-id'],
      'network.stop': [],
      'recording.start': ['--width', '--height'],
      'recording.stop': ['--output']
    }
    const nested = action === 'network' || action === 'recording'
    const verb = nested ? `${action}.${args[2] ?? ''}` : action
    if (!verb || !Object.hasOwn(actionFlags, verb)) return undefined
    const tail = args.slice(nested ? 3 : 2)
    const normalized = tail.flatMap((value, index) =>
      ['--clear', '--follow'].includes(value) &&
      (tail[index + 1] === undefined || tail[index + 1]!.startsWith('--'))
        ? [value, 'true']
        : [value]
    )
    const { values } = flags(normalized, ['--session-id', ...actionFlags[verb]!])
    const number = (flag: string, fallback: number, maximum: number, minimum = 1) => {
      const value = values.get(flag) ?? String(fallback)
      if (
        !/^-?(0|[1-9][0-9]*)$/u.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < minimum ||
        Number(value) > maximum
      ) {
        throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`)
      }
      return Number(value)
    }
    const boolean = (flag: string) => {
      const value = values.get(flag)
      if (value !== undefined && value !== 'true' && value !== 'false') {
        throw new Error(`${flag} must be true or false`)
      }
      return value === undefined ? {} : { [flag.slice(2)]: value === 'true' }
    }
    const target = () => {
      const selector = values.get('--selector')
      const role = values.get('--role')
      const name = values.get('--name')
      const text = values.get('--text-target')
      if (selector !== undefined && [role, name, text].some((value) => value !== undefined)) {
        throw new Error('Choose --selector or a role/text locator')
      }
      if (selector !== undefined) return { selector: required(values, '--selector') }
      if (role === undefined && text === undefined)
        throw new Error('A --selector, --role or --text-target is required')
      if (role !== undefined && text !== undefined)
        throw new Error('Choose --role or --text-target')
      if (name !== undefined && role === undefined) throw new Error('--name requires --role')
      return {
        locator: {
          ...(role === undefined ? {} : { role }),
          ...(name === undefined ? {} : { name }),
          ...(text === undefined ? {} : { text })
        }
      }
    }
    let operation: Record<string, unknown>
    switch (verb) {
      case 'open':
        operation = { kind: 'navigate', url: required(values, '--url') }
        break
      case 'click':
        operation = { kind: 'click', ...target() }
        break
      case 'type':
        operation = {
          kind: 'typeText',
          ...target(),
          text: values.get('--text') ?? required(values, '--text'),
          ...boolean('--clear')
        }
        break
      case 'press': {
        const key = required(values, '--key')
        if (key.length > 32) throw new Error('--key must contain 1 to 32 characters')
        const modifiers = values.get('--modifiers')?.split(',')
        if (
          modifiers?.some((value) => !['alt', 'control', 'meta', 'shift'].includes(value)) ||
          (modifiers && new Set(modifiers).size !== modifiers.length)
        ) {
          throw new Error(
            '--modifiers must contain distinct alt, control, meta or shift values separated by commas'
          )
        }
        const targeted = targets.some((flag) => values.has(flag))
        operation = {
          kind: targeted ? 'keyAt' : 'key',
          ...(targeted ? target() : {}),
          key,
          ...(modifiers === undefined ? {} : { modifiers })
        }
        break
      }
      case 'eval':
        operation = { kind: 'evaluate', expression: required(values, '--expression') }
        break
      case 'query':
        operation = { kind: 'query', ...target(), limit: number('--limit', 20, 100) }
        break
      case 'screenshot':
      case 'resize':
      case 'recording.start':
        operation = {
          kind: verb === 'recording.start' ? 'recordingStart' : verb,
          width: number('--width', 1280, 4096),
          height: number('--height', 720, 4096)
        }
        break
      case 'console':
      case 'errors': {
        const level = values.get('--level')
        if (level !== undefined && !['debug', 'info', 'warning', 'error'].includes(level))
          throw new Error('--level must be debug, info, warning or error')
        boolean('--follow')
        operation = {
          kind: verb,
          ...boolean('--clear'),
          ...(level === undefined ? {} : { level }),
          ...(values.has('--after')
            ? { after: number('--after', 0, Number.MAX_SAFE_INTEGER, 0) }
            : {})
        }
        break
      }
      case 'scroll':
        operation = {
          kind: 'scroll',
          deltaX: number('--delta-x', 0, 100_000, -100_000),
          deltaY: number('--delta-y', 0, 100_000, -100_000),
          ...(values.has('--selector') ? { selector: required(values, '--selector') } : {})
        }
        break
      case 'wait': {
        const conditions = ['--text', '--url', '--selector'].filter((flag) => values.has(flag))
        if (conditions.length !== 1)
          throw new Error('wait requires exactly one of --text, --url or --selector')
        const condition =
          conditions[0] === '--text'
            ? { kind: 'text', text: required(values, '--text') }
            : conditions[0] === '--url'
              ? { kind: 'url', includes: required(values, '--url') }
              : { kind: 'selector', selector: required(values, '--selector'), condition: 'visible' }
        operation = { kind: 'wait', condition }
        break
      }
      case 'appearance': {
        const colorScheme = required(values, '--theme')
        if (!['light', 'dark', 'system'].includes(colorScheme))
          throw new Error('--theme must be light, dark or system')
        operation = { kind: 'appearance', colorScheme }
        break
      }
      case 'network.list':
        operation = {
          kind: 'networkList',
          ...(values.has('--after')
            ? { after: number('--after', 0, Number.MAX_SAFE_INTEGER, 0) }
            : {})
        }
        break
      case 'network.get':
      case 'network.body':
        operation = {
          kind: verb === 'network.get' ? 'networkGet' : 'networkBody',
          requestId: required(values, '--request-id')
        }
        break
      default:
        operation = {
          kind:
            verb === 'snapshot'
              ? 'snapshot'
              : verb === 'network.start'
                ? 'networkStart'
                : verb === 'network.stop'
                  ? 'networkStop'
                  : 'recordingStop'
        }
    }
    const sessionId =
      verb === 'open' ? values.get('--session-id') : required(values, '--session-id')
    if (verb === 'recording.stop') required(values, '--output')
    return {
      sessionFile,
      command: 'browser.run',
      operation,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(values.has('--output') ? { output: required(values, '--output') } : {}),
      ...(values.has('--timeout-ms') ? { timeoutMs: number('--timeout-ms', 30_000, 120_000) } : {}),
      ...(values.has('--follow') ? boolean('--follow') : {})
    }
  }
  if (args[0] !== 'browser-automation') return undefined
  if (args[1] === 'list' && args.length === 2) {
    return { sessionFile, command: 'browser-automation.list' }
  }
  if (!actions.includes(args[1] ?? '')) return undefined
  return {
    sessionFile,
    command: `browser-automation.${args[1] as BrowserAutomationAction}`,
    params: jsonParams(args.slice(2))
  }
}

export async function runBrowserAutomation(
  client: AgentWorkspaceClient,
  parsed: BrowserAutomationCommand
): Promise<unknown> {
  switch (parsed.command) {
    case 'browser.attach': {
      const identity = await client.identify()
      if (!identity.idempotencyEpoch)
        throw new Error('Browser automation is unavailable in this session')
      const { snapshot } = await client.stateSnapshot()
      const workspace = snapshot.workspaces.find((item) => Object.hasOwn(item.tabs, parsed.tabId))
      const tab = workspace?.tabs[parsed.tabId]
      const window = snapshot.windowPlacements.find((item) =>
        item.workspaceIds.includes(workspace?.id ?? '')
      )
      if (!workspace || tab?.content.kind !== 'browser' || !window)
        throw new Error('Browser tab was not found')
      return client.createBrowserAutomationSession({
        mode: 'attach',
        profileKey: 'default',
        attachTabId: parsed.tabId,
        attachWindowId: window.id,
        idempotency: { epoch: identity.idempotencyEpoch, key: randomUUID() },
        correlationId: randomUUID()
      })
    }
    case 'browser-automation.create': {
      const params = parsed.params as Record<string, unknown>
      const suppliedIdempotency = params.idempotency as Record<string, unknown> | undefined
      const epoch = suppliedIdempotency?.epoch ?? (await client.identify()).idempotencyEpoch
      return client.createBrowserAutomationSession({
        ...params,
        profileKey: params.profileKey ?? 'default',
        correlationId: params.correlationId ?? randomUUID(),
        idempotency: {
          ...suppliedIdempotency,
          epoch,
          key: suppliedIdempotency?.key ?? randomUUID()
        }
      })
    }
    case 'browser.run': {
      const identity = await client.identify()
      if (!identity.idempotencyEpoch)
        throw new Error('Browser automation is unavailable in this session')
      const session =
        parsed.sessionId === undefined
          ? (
              await client.createBrowserAutomationSession({
                mode: 'ephemeral',
                profileKey: 'default',
                idempotency: { epoch: identity.idempotencyEpoch, key: randomUUID() },
                correlationId: randomUUID()
              })
            ).session
          : (await client.listBrowserAutomationSessions()).sessions.find(
              (item) => item.automationSessionId === parsed.sessionId
            )
      if (!session) throw new Error('Browser automation session was not found')
      let result: Awaited<ReturnType<AgentWorkspaceClient['invokeBrowserAutomationUntilTerminal']>>
      try {
        result = await client.invokeBrowserAutomationUntilTerminal({
          automationSessionId: session.automationSessionId,
          sessionGeneration: session.generation,
          navigationEpoch: session.navigationEpoch,
          operationId: randomUUID(),
          attemptEpoch: 1,
          timeoutMs: parsed.timeoutMs ?? 30_000,
          operation: parsed.operation,
          idempotency: { epoch: identity.idempotencyEpoch, key: randomUUID() },
          correlationId: randomUUID()
        })
        if (result.operation.state !== 'succeeded') {
          throw new Error(
            `Browser operation ${result.operation.state}: ${result.operation.errorCode ?? 'unknown'}`
          )
        }
      } catch (error) {
        if (parsed.sessionId === undefined) {
          await client.destroyBrowserAutomationSession({
            automationSessionId: session.automationSessionId,
            generation: session.generation
          })
        }
        throw error
      }
      if (
        parsed.output !== undefined &&
        (result.operation.result?.kind === 'screenshot' ||
          result.operation.result?.kind === 'recording')
      ) {
        const handle = result.operation.result.handle
        const request = {
          automationSessionId: session.automationSessionId,
          sessionGeneration: session.generation,
          handleId: handle.handleId
        }
        try {
          const chunks: Buffer[] = []
          for (let chunkIndex = 0; chunkIndex < handle.chunkCount; chunkIndex += 1) {
            const chunk = await client.readBrowserAutomationScreenshot({ ...request, chunkIndex })
            if (
              chunk.handleId !== handle.handleId ||
              chunk.chunkIndex !== chunkIndex ||
              chunk.chunkCount !== handle.chunkCount ||
              chunk.sha256 !== handle.sha256
            ) {
              throw new Error('Browser artifact chunk does not match its handle')
            }
            chunks.push(Buffer.from(chunk.dataBase64, 'base64'))
          }
          const bytes = Buffer.concat(chunks)
          if (
            bytes.byteLength !== handle.byteLength ||
            createHash('sha256').update(bytes).digest('hex') !== handle.sha256
          ) {
            throw new Error('Browser artifact content does not match its handle')
          }
          await writeFile(resolve(parsed.output), bytes)
        } finally {
          await client.releaseBrowserAutomationScreenshot(request)
        }
      }
      return {
        session: {
          ...session,
          navigationEpoch:
            result.operation.result?.kind === 'navigation'
              ? result.operation.result.navigationEpoch
              : result.operation.navigationEpoch
        },
        ...result,
        ...(parsed.output === undefined ? {} : { output: resolve(parsed.output) })
      }
    }
    case 'browser-automation.list':
      return client.listBrowserAutomationSessions()
    case 'browser-automation.get':
      return client.getBrowserAutomationSession(parsed.params)
    case 'browser-automation.execute':
      return client.invokeBrowserAutomationUntilTerminal(parsed.params)
    case 'browser-automation.cancel':
      return client.cancelBrowserAutomationOperation(parsed.params)
    case 'browser-automation.read':
      return client.readBrowserAutomationScreenshot(parsed.params)
    case 'browser-automation.release':
      return client.releaseBrowserAutomationScreenshot(parsed.params)
    case 'browser-automation.destroy':
      return client.destroyBrowserAutomationSession(parsed.params)
  }
}

export async function followBrowserDiagnostics(
  client: AgentWorkspaceClient,
  parsed: Extract<BrowserAutomationCommand, { command: 'browser.run' }>,
  signal: AbortSignal,
  emit: (result: unknown) => void
): Promise<void> {
  let after = parsed.operation.after
  let clear = parsed.operation.clear
  while (!signal.aborted) {
    const result = (await runBrowserAutomation(client, {
      ...parsed,
      operation: {
        ...parsed.operation,
        ...(after === undefined ? {} : { after }),
        ...(clear === undefined ? {} : { clear })
      }
    })) as {
      operation: {
        result?: { kind: string; entries?: unknown[]; cursor?: number; dropped?: number }
      }
    }
    const diagnostics = result.operation.result
    if (diagnostics?.entries?.length || diagnostics?.dropped) emit(result)
    if (diagnostics?.cursor !== undefined) after = diagnostics.cursor
    clear = false
    try {
      await delay(500, undefined, { signal })
    } catch (error) {
      if (!signal.aborted) throw error
    }
  }
}
