import {
  browserBackParamsSchema,
  browserForwardParamsSchema,
  browserNavigateParamsSchema,
  browserObserveParamsSchema,
  browserOpenDevToolsParamsSchema,
  browserReloadParamsSchema,
  browserSessionStateSchema,
  browserStopParamsSchema
} from '@agent-workspace/protocol-client'
import {
  durableApplicationStateSchema,
  type DurableApplicationState
} from '@agent-workspace/contracts'
import type { z } from 'zod'

type BrowserMetadata = Extract<
  DurableApplicationState['workspaces'][number]['tabs'][string]['content'],
  { kind: 'browser' }
>['metadata']

export class BrowserMutationError extends Error {
  constructor(
    public readonly code:
      | 'browser_session_not_found'
      | 'browser_session_ambiguous'
      | 'browser_observation_mismatch'
      | 'browser_state_stale'
      | 'browser_action_unavailable'
      | 'revision_overflow'
      | 'invalid_timestamp',
    message: string
  ) {
    super(message)
    this.name = 'BrowserMutationError'
  }
}

function mutateBrowser(
  state: DurableApplicationState,
  browserSessionId: string,
  updatedAt: number,
  change: (metadata: BrowserMetadata) => void,
  target?: { workspaceId: string; tabId: string; profilePartition: string }
): DurableApplicationState {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new BrowserMutationError('invalid_timestamp', 'Browser timestamp is invalid')
  }
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    throw new BrowserMutationError('revision_overflow', 'Application revision cannot advance')
  }
  const next = structuredClone(state)
  const matches = next.workspaces.flatMap((workspace) =>
    Object.values(workspace.tabs)
      .filter(
        (tab) =>
          tab.content.kind === 'browser' &&
          tab.content.metadata.browserSessionId === browserSessionId
      )
      .map((tab) => ({ workspace, tab }))
  )
  if (matches.length !== 1) {
    throw new BrowserMutationError(
      matches.length ? 'browser_session_ambiguous' : 'browser_session_not_found',
      'Browser session was not found uniquely'
    )
  }
  const { workspace, tab } = matches[0]!
  if (tab.content.kind !== 'browser') throw new Error('Browser lookup lost its content kind')
  const metadata = tab.content.metadata
  if (
    target &&
    (workspace.id !== target.workspaceId ||
      tab.id !== target.tabId ||
      (metadata.profilePartition ?? 'persist:agent-workspace-default') !== target.profilePartition)
  ) {
    throw new BrowserMutationError(
      'browser_observation_mismatch',
      'Browser observation does not match the tab session'
    )
  }
  change(metadata)
  browserSessionStateSchema.parse({
    browserSessionId,
    url: metadata.url,
    navigationTitle: metadata.navigationTitle ?? '',
    canBack: metadata.canBack ?? false,
    canForward: metadata.canForward ?? false,
    loading: metadata.loading ?? false,
    devToolsOpen: metadata.devToolsOpen ?? false,
    profilePartition: metadata.profilePartition ?? 'persist:agent-workspace-default',
    stateRevision: metadata.stateRevision ?? 0,
    correlationId: metadata.correlationId ?? null
  })
  workspace.updatedAt = updatedAt
  next.revision += 1
  return durableApplicationStateSchema.parse(next)
}

function requireStateRevision(metadata: BrowserMetadata, expected: number): void {
  if ((metadata.stateRevision ?? 0) !== expected) {
    throw new BrowserMutationError('browser_state_stale', 'Browser state revision is stale')
  }
  if (expected >= Number.MAX_SAFE_INTEGER) {
    throw new BrowserMutationError('revision_overflow', 'Browser state revision cannot advance')
  }
}

export function navigateBrowser(
  state: DurableApplicationState,
  input: z.input<typeof browserNavigateParamsSchema>,
  updatedAt: number
): DurableApplicationState {
  const request = browserNavigateParamsSchema.parse(input)
  return mutateBrowser(state, request.browserSessionId, updatedAt, (metadata) => {
    requireStateRevision(metadata, request.expectedStateRevision)
    metadata.url = request.url
    metadata.loading = true
    metadata.stateRevision = request.expectedStateRevision + 1
    metadata.correlationId = request.correlationId
  })
}

export type BrowserAction = 'back' | 'forward' | 'reload' | 'stop' | 'openDevTools'

export function requestBrowserAction(
  state: DurableApplicationState,
  action: BrowserAction,
  input: z.input<typeof browserBackParamsSchema>,
  updatedAt: number
): DurableApplicationState {
  const schema = {
    back: browserBackParamsSchema,
    forward: browserForwardParamsSchema,
    reload: browserReloadParamsSchema,
    stop: browserStopParamsSchema,
    openDevTools: browserOpenDevToolsParamsSchema
  }[action]
  const request = schema.parse(input)
  return mutateBrowser(state, request.browserSessionId, updatedAt, (metadata) => {
    requireStateRevision(metadata, request.expectedStateRevision)
    if (action === 'back' && !metadata.canBack) {
      throw new BrowserMutationError('browser_action_unavailable', 'Browser cannot navigate back')
    }
    if (action === 'forward' && !metadata.canForward) {
      throw new BrowserMutationError(
        'browser_action_unavailable',
        'Browser cannot navigate forward'
      )
    }
    if (action === 'stop') metadata.loading = false
    else if (action === 'openDevTools') metadata.devToolsOpen = true
    else metadata.loading = true
    metadata.stateRevision = request.expectedStateRevision + 1
    metadata.correlationId = request.correlationId
  })
}

export function observeBrowser(
  state: DurableApplicationState,
  input: z.input<typeof browserObserveParamsSchema>,
  updatedAt: number
): DurableApplicationState {
  const request = browserObserveParamsSchema.parse(input)
  return mutateBrowser(
    state,
    request.state.browserSessionId,
    updatedAt,
    (metadata) => {
      if (request.state.stateRevision <= (metadata.stateRevision ?? 0)) {
        throw new BrowserMutationError(
          'browser_state_stale',
          'Browser observation revision is stale'
        )
      }
      Object.assign(metadata, {
        url: request.state.url,
        navigationTitle: request.state.navigationTitle,
        canBack: request.state.canBack,
        canForward: request.state.canForward,
        loading: request.state.loading,
        devToolsOpen: request.state.devToolsOpen,
        profilePartition: request.state.profilePartition,
        stateRevision: request.state.stateRevision,
        correlationId: request.state.correlationId
      })
    },
    {
      workspaceId: request.workspaceId,
      tabId: request.tabId,
      profilePartition: request.state.profilePartition
    }
  )
}
