import type { AgentWorkspaceClient } from '@agent-workspace/client-runtime'
import {
  boundedListParamsSchema,
  recentlyClosedReopenParamsSchema,
  remoteListParamsSchema,
  remoteTargetIdParamsSchema,
  remoteSessionIdParamsSchema,
  remoteTargetCreateParamsSchema,
  remoteTargetDeleteParamsSchema,
  remoteSessionConnectParamsSchema,
  remoteSessionReconnectParamsSchema,
  remoteSessionDetachParamsSchema,
  remoteSessionCloseParamsSchema,
  remoteHostKeyTrustParamsSchema,
  remoteTmuxDiscoverParamsSchema
} from '@agent-workspace/contracts'

import { jsonParams } from './options'
import { runJsonMutation, supportsJsonMutation } from './json-mutations'

const agentCapabilities: Record<string, string> = {
  'catalog-register': 'agent.catalog.register',
  'restore-assess': 'agent.restore.assess',
  restore: 'agent.session.restore',
  fork: 'agent.session.fork',
  'hibernate-preflight': 'agent.hibernate.preflight',
  'hibernate-confirm': 'agent.hibernate.confirm',
  'hibernate-cancel': 'agent.hibernate.cancel',
  'team-create': 'agent.team.create',
  'team-update': 'agent.team.update',
  'team-delete': 'agent.team.delete',
  'member-create': 'agent.team.member.create',
  'member-update': 'agent.team.member.update',
  'member-move': 'agent.team.member.move',
  'member-delete': 'agent.team.member.delete',
  'attention-set': 'agent.attention.set'
}

const remoteCapabilities: Record<string, string> = {
  'target-list': 'remote.target.list',
  'target-get': 'remote.target.get',
  'target-create': 'remote.target.create',
  'target-delete': 'remote.target.delete',
  'session-list': 'remote.session.list',
  'session-get': 'remote.session.get',
  'session-connect': 'remote.session.prepare',
  'session-detach': 'remote.session.detach',
  'session-reconnect': 'remote.session.activate',
  'session-close': 'remote.session.close',
  'host-key-decide': 'remote.hostKey.decide',
  'tmux-discover': 'remote.tmux.discover'
}

const sidebarCapabilities: Record<string, string> = {
  'recently-closed-list': 'recentlyClosed.list',
  'recently-closed-reopen': 'recentlyClosed.reopen'
}

export interface RustNamedCommand {
  sessionFile: string
  command: 'rust.named'
  capability: string
  params: unknown
}

/** Keep the Rust CLI's JSON DTO command names available during the Node cutover. */
export function parseRustNamedCommand(
  args: string[],
  sessionFile: string
): RustNamedCommand | undefined {
  const family = args[0]
  const operation = args[1]
  if (!operation) return undefined
  const capabilities =
    family === 'agent'
      ? agentCapabilities
      : family === 'remote'
        ? remoteCapabilities
        : family === 'sidebar'
          ? sidebarCapabilities
          : undefined
  if (!capabilities || !Object.hasOwn(capabilities, operation)) return undefined
  return {
    sessionFile,
    command: 'rust.named',
    capability: capabilities[operation]!,
    params: jsonParams(args.slice(2))
  }
}

export function rustNamedNeedsWindowCapability(capability: string): boolean {
  return capability.startsWith('recentlyClosed.')
}

export function runRustNamedCommand(
  client: AgentWorkspaceClient,
  parsed: RustNamedCommand,
  windowCapability?: string
): Promise<unknown> {
  const { capability, params } = parsed
  if (supportsJsonMutation(capability)) return runJsonMutation(client, capability, params)
  switch (capability) {
    case 'remote.target.list': {
      const { limit, cursor } = remoteListParamsSchema.parse(params)
      return client.listRemoteTargets({ limit, ...(cursor === undefined ? {} : { cursor }) })
    }
    case 'remote.target.get':
      return client.getRemoteTarget(remoteTargetIdParamsSchema.parse(params).remoteTargetId)
    case 'remote.target.create':
      return client.createRemoteTarget(remoteTargetCreateParamsSchema.parse(params))
    case 'remote.target.delete':
      return client.deleteRemoteTarget(remoteTargetDeleteParamsSchema.parse(params))
    case 'remote.session.list': {
      const { limit, cursor } = remoteListParamsSchema.parse(params)
      return client.listRemoteSessions({ limit, ...(cursor === undefined ? {} : { cursor }) })
    }
    case 'remote.session.get':
      return client.getRemoteSession(remoteSessionIdParamsSchema.parse(params).remoteSessionId)
    case 'remote.session.prepare':
      return client.prepareRemoteSession(remoteSessionConnectParamsSchema.parse(params))
    case 'remote.session.activate':
      return client.activateRemoteSession(remoteSessionReconnectParamsSchema.parse(params))
    case 'remote.session.detach':
      return client.detachRemoteSession(remoteSessionDetachParamsSchema.parse(params))
    case 'remote.session.close':
      return client.closeRemoteSession(remoteSessionCloseParamsSchema.parse(params))
    case 'remote.hostKey.decide':
      return client.decideRemoteHostKey(remoteHostKeyTrustParamsSchema.parse(params))
    case 'remote.tmux.discover':
      return client.discoverRemoteTmux(remoteTmuxDiscoverParamsSchema.parse(params))
    case 'recentlyClosed.list':
      if (!windowCapability) throw new Error('Window capability is required')
      return client.listRecentlyClosedSidebarBound(
        boundedListParamsSchema.parse(params),
        windowCapability
      )
    case 'recentlyClosed.reopen':
      if (!windowCapability) throw new Error('Window capability is required')
      return client.reopenRecentlyClosedSidebarBound(
        recentlyClosedReopenParamsSchema.parse(params),
        windowCapability
      )
    default:
      throw new Error(`Unsupported named command: ${capability}`)
  }
}
