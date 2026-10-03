import { randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { tabUpdateRequestSchema } from '@agent-workspace/contracts'
import { flags, required } from './options'

export type TerminalCommand =
  | { sessionFile: string; command: 'terminal.read'; terminalId: string; lines?: number }
  | { sessionFile: string; command: 'tab.rename'; tabId: string; title: string }

export function parseTerminalCommand(
  args: string[],
  sessionFile: string
): TerminalCommand | undefined {
  if (args[0] === 'terminal' && args[1] === 'read') {
    const { values } = flags(args.slice(2), ['--terminal-id', '--lines'])
    const raw = values.get('--lines')
    if (raw !== undefined && (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw)))) {
      throw new Error('--lines must be a positive integer')
    }
    return {
      sessionFile,
      command: 'terminal.read',
      terminalId: required(values, '--terminal-id'),
      ...(raw === undefined ? {} : { lines: Number(raw) })
    }
  }
  if (args[0] === 'tab' && args[1] === 'rename') {
    const { values } = flags(args.slice(2), ['--tab-id', '--title'])
    return {
      sessionFile,
      command: 'tab.rename',
      tabId: required(values, '--tab-id'),
      title: required(values, '--title')
    }
  }
  return undefined
}

export async function readTerminalText(
  client: AgentWorkspaceClient,
  terminalId: string,
  lines?: number
) {
  const attached = await client.attach(terminalId)
  const replay = Buffer.concat(
    attached.output.map((chunk) => Buffer.from(chunk.data, 'base64'))
  ).toString('utf8')
  const text = stripVTControlCharacters((attached.checkpoint?.data ?? '') + replay).replace(
    /\r\n?/gu,
    '\n'
  )
  const retained = text.endsWith('\n') ? text.slice(0, -1) : text
  return {
    text:
      lines === undefined
        ? text
        : retained.split('\n').slice(-lines).join('\n') + (text.endsWith('\n') ? '\n' : ''),
    reconstructionComplete: attached.reconstructionComplete
  }
}

export async function renameTab(client: AgentWorkspaceClient, tabId: string, title: string) {
  const identity = await client.identify()
  if (!identity.capabilities.includes('tab.update') || !identity.idempotencyEpoch) {
    throw new Error('tab.update is unavailable in this Node session')
  }
  const { snapshot } = await client.stateSnapshot()
  const workspace = snapshot.workspaces.find((item) => Object.hasOwn(item.tabs, tabId))
  if (!workspace) throw new Error('Tab was not found')
  return client.updateTab(
    tabUpdateRequestSchema.parse({
      workspaceId: workspace.id,
      tabId,
      customTitle: { value: title },
      expectedRevision: snapshot.revision,
      idempotencyEpoch: identity.idempotencyEpoch,
      idempotencyKey: randomUUID()
    })
  )
}
