import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import { jsonParams } from './options'

type BrowserAutomationAction =
  | 'create'
  | 'get'
  | 'execute'
  | 'cancel'
  | 'read'
  | 'release'
  | 'destroy'

export type BrowserAutomationCommand =
  | { sessionFile: string; command: 'browser-automation.list' }
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
    case 'browser-automation.create':
      return client.createBrowserAutomationSession(parsed.params)
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
