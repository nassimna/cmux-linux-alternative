import { randomUUID } from 'node:crypto'

import {
  actionDefinitionSchema,
  actionListParamsSchema,
  actionListResultSchema
} from '@agent-workspace/contracts'

const CURSOR_CAP = 1_024
const CURSOR_TTL_MS = 5 * 60 * 1_000
const REGISTRY_REVISION = 1

const service = (actionId: string, localizedTitleKey: string) =>
  actionDefinitionSchema.parse({
    actionId,
    actionVersion: 1,
    localizedTitleKey,
    category: 'organization',
    owner: 'service',
    parameterSchemaVersion: 1,
    resultSchemaVersion: 1,
    authorizationClass: 'owner',
    interactionClass: 'headless',
    limits: { maxParameterBytes: 4 * 1024, maxResultBytes: 1024, timeoutMs: 30_000 }
  })

/** The closed Tier A definitions from Rust production_definitions(). */
const DEFINITIONS = [
  actionDefinitionSchema.parse({
    actionId: 'desktop.window.focus',
    actionVersion: 1,
    localizedTitleKey: 'actions.desktop_window_focus',
    category: 'window',
    owner: 'desktop',
    parameterSchemaVersion: 1,
    resultSchemaVersion: 1,
    authorizationClass: 'owner',
    interactionClass: 'desktopInteraction',
    requiredDesktopCapability: 'desktop-window-focus-v1',
    limits: { maxParameterBytes: 2, maxResultBytes: 2, timeoutMs: 30_000 }
  }),
  service('workspace.card.pin', 'actions.workspace_card_pin'),
  service('workspace.group.collapse', 'actions.workspace_group_collapse'),
  service('workspace.group.rename', 'actions.workspace_group_rename')
].sort((left, right) =>
  left.actionId < right.actionId
    ? -1
    : left.actionId > right.actionId
      ? 1
      : left.actionVersion - right.actionVersion
)

type CursorEntry = {
  revision: number
  epoch: string
  offset: number
  expiresAt: number
}

export class ActionRegistryError extends Error {
  public constructor(public readonly code: 'cursor_invalid' | 'cursor_expired') {
    super('The action request could not be completed')
    this.name = 'ActionRegistryError'
  }
}

/** Process-local, one-use discovery cursors bound to this registry and writer epoch. */
export class ActionRegistry {
  private readonly cursors = new Map<string, CursorEntry>()

  public constructor(private readonly now: () => number = () => performance.now()) {}

  public list(input: unknown, epoch: string) {
    const params = actionListParamsSchema.parse(input)
    const now = this.now()
    if (params.cursor) {
      const requested = this.cursors.get(params.cursor)
      if (requested && requested.expiresAt <= now) {
        this.cursors.delete(params.cursor)
        throw new ActionRegistryError('cursor_expired')
      }
    }
    for (const [token, entry] of this.cursors) {
      if (entry.expiresAt > now) break
      this.cursors.delete(token)
    }
    let offset = 0
    if (params.cursor) {
      const cursor = this.cursors.get(params.cursor)
      this.cursors.delete(params.cursor)
      if (
        !cursor ||
        cursor.revision !== REGISTRY_REVISION ||
        cursor.epoch !== epoch ||
        cursor.offset > DEFINITIONS.length
      ) {
        throw new ActionRegistryError('cursor_invalid')
      }
      offset = cursor.offset
    }
    const end = Math.min(offset + params.limit, DEFINITIONS.length)
    const definitions = DEFINITIONS.slice(offset, end)
    let nextCursor: string | undefined
    if (end < DEFINITIONS.length) {
      nextCursor = randomUUID().replaceAll('-', '')
      this.cursors.set(nextCursor, {
        revision: REGISTRY_REVISION,
        epoch,
        offset: end,
        expiresAt: now + CURSOR_TTL_MS
      })
      while (this.cursors.size > CURSOR_CAP) {
        this.cursors.delete(this.cursors.keys().next().value!)
      }
    }
    return actionListResultSchema.parse({
      registryRevision: REGISTRY_REVISION,
      idempotencyEpoch: epoch,
      definitions,
      ...(nextCursor ? { nextCursor } : {})
    })
  }
}
