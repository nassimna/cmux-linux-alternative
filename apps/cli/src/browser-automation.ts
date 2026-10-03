import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { flags, jsonParams, required } from './options'

type BrowserAutomationAction =
  'create' | 'get' | 'execute' | 'cancel' | 'read' | 'release' | 'destroy'

export type BrowserAutomationCommand =
  | { sessionFile: string; command: 'browser-automation.list' }
  | {
      sessionFile: string
      command: 'browser.run'
      sessionId?: string
      operation: Record<string, unknown>
      output?: string
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
    const actionFlags: Record<string, string[]> = {
      open: ['--url'],
      click: ['--selector'],
      type: ['--selector', '--text'],
      screenshot: ['--width', '--height', '--output'],
      eval: ['--expression'],
      query: ['--selector', '--limit'],
      console: ['--clear'],
      errors: ['--clear']
    }
    if (!action || !Object.hasOwn(actionFlags, action)) return undefined
    const { values } = flags(args.slice(2), ['--session-id', ...actionFlags[action]!])
    const number = (flag: string, fallback: number, maximum: number) => {
      const value = values.get(flag) ?? String(fallback)
      if (!/^[1-9][0-9]*$/u.test(value) || Number(value) > maximum) {
        throw new Error(`${flag} must be an integer from 1 to ${maximum}`)
      }
      return Number(value)
    }
    let operation: Record<string, unknown>
    switch (action) {
      case 'open':
        operation = { kind: 'navigate', url: required(values, '--url') }
        break
      case 'type':
        operation = {
          kind: 'typeText',
          selector: required(values, '--selector'),
          text: values.get('--text') ?? required(values, '--text')
        }
        break
      case 'eval':
        operation = { kind: 'evaluate', expression: required(values, '--expression') }
        break
      case 'query':
        operation = {
          kind: 'query',
          selector: required(values, '--selector'),
          limit: number('--limit', 20, 100)
        }
        break
      case 'screenshot':
        operation = {
          kind: 'screenshot',
          width: number('--width', 1280, 4096),
          height: number('--height', 720, 4096)
        }
        break
      case 'console':
      case 'errors': {
        const clear = values.get('--clear')
        if (clear !== undefined && clear !== 'true' && clear !== 'false') {
          throw new Error('--clear must be true or false')
        }
        operation = { kind: action, ...(clear === undefined ? {} : { clear: clear === 'true' }) }
        break
      }
      default:
        operation = { kind: 'click', selector: required(values, '--selector') }
    }
    const sessionId =
      action === 'open' ? values.get('--session-id') : required(values, '--session-id')
    return {
      sessionFile,
      command: 'browser.run',
      operation,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(values.has('--output') ? { output: required(values, '--output') } : {})
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
          timeoutMs: 30_000,
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
      if (parsed.output !== undefined && result.operation.result?.kind === 'screenshot') {
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
              throw new Error('Screenshot chunk does not match its handle')
            }
            chunks.push(Buffer.from(chunk.dataBase64, 'base64'))
          }
          const png = Buffer.concat(chunks)
          if (
            png.byteLength !== handle.byteLength ||
            createHash('sha256').update(png).digest('hex') !== handle.sha256
          ) {
            throw new Error('Screenshot content does not match its handle')
          }
          await writeFile(parsed.output, png)
        } finally {
          await client.releaseBrowserAutomationScreenshot(request)
        }
      }
      return {
        session: { ...session, navigationEpoch: result.operation.navigationEpoch },
        ...result,
        ...(parsed.output === undefined ? {} : { output: parsed.output })
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
