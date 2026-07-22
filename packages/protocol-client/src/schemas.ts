import { z } from 'zod'
import type { AgentAttentionTarget } from './generated/AgentAttentionTarget'
import type { AgentHibernationPreflightResult } from './generated/AgentHibernationPreflightResult'
import type { AgentSessionSnapshot } from './generated/AgentSessionSnapshot'
import type { AgentTeamMemberSnapshot } from './generated/AgentTeamMemberSnapshot'

const uuidSchema = z.string().uuid()
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const uint32Schema = z.number().int().min(0).max(0xffff_ffff)
const ratioSchema = z.number().finite().min(0.05).max(0.95)
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    )
  })
const hasAsciiControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('/') && !value.includes('\0'), {
    message: 'path must be an absolute UTF-8 path'
  })
const normalizedString = (max: number, allowEmpty = false) =>
  z
    .string()
    .refine(
      (value) =>
        value === value.trim() && (allowEmpty || value.length > 0) && [...value].length <= max,
      {
        message: 'text must be normalized and within its bound'
      }
    )
const titleSchema = normalizedString(256)
const commandArgumentSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'))

const remoteTextSchema = (maximum: number) =>
  z
    .string()
    .min(1)
    .refine((value) => [...value].length <= maximum && !hasControlCharacter(value))
const remoteHostSchema = remoteTextSchema(253).refine(
  (value) =>
    value === value.toLowerCase() &&
    !value.startsWith('-') &&
    !/\s/u.test(value) &&
    /^[a-z0-9.-]+$/u.test(value),
  { message: 'host must be canonical lowercase IDNA or IPv4; IPv6 is not supported in v1' }
)
const remoteUserSchema = remoteTextSchema(64).refine(
  (value) => !value.startsWith('-') && !/\s/u.test(value),
  { message: 'invalid SSH user' }
)
const requestHashSchema = z.string().regex(/^[0-9a-f]{64}$/u)
const positiveRevisionSchema = revisionSchema.positive()
const tmuxNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/u)

export const remoteSessionStateSchema = z.enum([
  'created',
  'trustRequired',
  'credentialRequired',
  'connecting',
  'connected',
  'reconnecting',
  'detached',
  'failed',
  'closed'
])
export const remoteObservationStateSchema = z.enum(['unknown', 'lastVerified', 'lost'])
export const remoteMutationIdentitySchema = z.strictObject({
  idempotencyKey: uuidSchema,
  requestHash: requestHashSchema,
  expectedRevision: revisionSchema
})
export const remoteReconnectPolicySchema = z
  .strictObject({
    maxAttempts: z.number().int().min(0).max(10),
    initialDelayMs: z.number().int().min(100).max(60_000),
    maxDelayMs: z.number().int().min(100).max(300_000)
  })
  .refine(({ initialDelayMs, maxDelayMs }) => maxDelayMs >= initialDelayMs)
export const remoteTmuxIdentitySchema = z.strictObject({
  mode: z.enum(['attach', 'create']),
  sessionName: tmuxNameSchema
})
export const remoteTargetCreateParamsSchema = z.strictObject({
  remoteTargetId: uuidSchema,
  label: remoteTextSchema(128),
  host: remoteHostSchema,
  port: z.number().int().min(1).max(65_535),
  user: remoteUserSchema,
  mutation: remoteMutationIdentitySchema
})
export const remoteTargetSnapshotSchema = z.strictObject({
  remoteTargetId: uuidSchema,
  label: remoteTextSchema(128),
  host: remoteHostSchema,
  port: z.number().int().min(1).max(65_535),
  user: remoteUserSchema,
  authentication: z.literal('publicKey'),
  hostKeyState: z.enum(['untrusted', 'trusted', 'changed', 'revoked']),
  knownHostsVersion: positiveRevisionSchema,
  revision: positiveRevisionSchema
})
export const remoteSessionConnectParamsSchema = z.strictObject({
  remoteSessionId: uuidSchema,
  remoteTargetId: uuidSchema,
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  tabId: uuidSchema,
  tmux: remoteTmuxIdentitySchema.optional(),
  reconnect: remoteReconnectPolicySchema,
  mutation: remoteMutationIdentitySchema
})
export const remoteSessionMutationParamsSchema = z.strictObject({
  remoteSessionId: uuidSchema,
  mutation: remoteMutationIdentitySchema
})
export const remoteSessionDetachParamsSchema = remoteSessionMutationParamsSchema
export const remoteSessionReconnectParamsSchema = remoteSessionMutationParamsSchema
export const remoteSessionCloseParamsSchema = remoteSessionMutationParamsSchema
export const remoteTmuxDiscoverParamsSchema = remoteSessionMutationParamsSchema
export const remoteSessionIdParamsSchema = z.strictObject({ remoteSessionId: uuidSchema })
export const remoteTargetIdParamsSchema = z.strictObject({ remoteTargetId: uuidSchema })
export const remoteTargetDeleteParamsSchema = z.strictObject({
  remoteTargetId: uuidSchema,
  mutation: remoteMutationIdentitySchema
})
export const remoteListParamsSchema = z.strictObject({
  limit: z.number().int().min(1).max(128),
  cursor: uuidSchema.nullish()
})
const hostKeyFingerprintSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^SHA256:\S+$/u)
export const remoteHostKeyChallengeSchema = z.strictObject({
  remoteSessionId: uuidSchema,
  promptId: uuidSchema,
  attemptGeneration: positiveRevisionSchema,
  canonicalHost: remoteHostSchema,
  port: z.number().int().min(1).max(65_535),
  algorithm: z.literal('ssh-ed25519'),
  publicKey: z
    .string()
    .min(1)
    .max(16 * 1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  presentedFingerprint: hostKeyFingerprintSchema,
  targetRevision: positiveRevisionSchema,
  expiresAtMs: positiveRevisionSchema
})
export const remoteHostKeyScanParamsSchema = remoteSessionMutationParamsSchema
export const remoteHostKeyTrustParamsSchema = z.strictObject({
  remoteSessionId: uuidSchema,
  promptId: uuidSchema,
  attemptGeneration: positiveRevisionSchema,
  presentedFingerprint: hostKeyFingerprintSchema,
  decision: z.enum(['reject', 'trust']),
  mutation: remoteMutationIdentitySchema
})
export const remoteTmuxDiscoveryResultSchema = z.strictObject({
  sessions: z.array(tmuxNameSchema).max(128)
})
export const remoteSessionSnapshotSchema = z.strictObject({
  remoteSessionId: uuidSchema,
  remoteTargetId: uuidSchema,
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  tabId: uuidSchema,
  tmux: remoteTmuxIdentitySchema.optional(),
  state: remoteSessionStateSchema,
  observation: remoteObservationStateSchema,
  attemptGeneration: positiveRevisionSchema,
  revision: positiveRevisionSchema,
  reconnect: remoteReconnectPolicySchema
})
export const remoteTargetListResultSchema = z.strictObject({
  targets: z.array(remoteTargetSnapshotSchema).max(128),
  nextCursor: uuidSchema.optional()
})
export const remoteSessionListResultSchema = z.strictObject({
  sessions: z.array(remoteSessionSnapshotSchema).max(128),
  nextCursor: uuidSchema.optional()
})
export const remoteTargetResultSchema = z.strictObject({ target: remoteTargetSnapshotSchema })
export const remoteSessionResultSchema = z.strictObject({ session: remoteSessionSnapshotSchema })

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function isCanonicalBase64(value: string, maximumDecodedBytes: number): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const payload = value.slice(0, value.length - padding)
  if (!/^[A-Za-z0-9+/]+$/u.test(payload)) return false
  const decodedBytes = (value.length / 4) * 3 - padding
  if (decodedBytes <= 0 || decodedBytes > maximumDecodedBytes) return false
  const lastSextet = base64Alphabet.indexOf(payload.at(-1) ?? '')
  if (lastSextet < 0) return false
  return padding === 2
    ? (lastSextet & 0x0f) === 0
    : padding === 1
      ? (lastSextet & 0x03) === 0
      : true
}

const cardSlotLabelSchema = normalizedString(120).refine((value) => !hasControlCharacter(value), {
  message: 'card-slot label must not contain control characters'
})

export const attentionStateSchema = z.enum([
  'none',
  'informational',
  'completed',
  'waiting',
  'urgent'
])
export const attentionReasonSchema = z.enum([
  'none',
  'notificationInfo',
  'notificationWarning',
  'notificationError',
  'agentRunning',
  'agentWaiting',
  'agentCompleted',
  'agentFailed'
])

export const workspaceAttentionSnapshotSchema = z
  .strictObject({
    workspaceId: uuidSchema,
    revision: revisionSchema,
    state: attentionStateSchema,
    reason: attentionReasonSchema,
    unreadCount: uint32Schema,
    notificationId: uuidSchema.optional(),
    paneId: uuidSchema.optional(),
    tabId: uuidSchema.optional()
  })
  .superRefine((snapshot, context) => {
    const notificationReason = snapshot.reason.startsWith('notification')
    const validPair =
      (snapshot.state === 'none' && snapshot.reason === 'none') ||
      (snapshot.state === 'informational' &&
        ['notificationInfo', 'notificationWarning', 'agentRunning'].includes(snapshot.reason)) ||
      (snapshot.state === 'completed' && snapshot.reason === 'agentCompleted') ||
      (snapshot.state === 'waiting' && snapshot.reason === 'agentWaiting') ||
      (snapshot.state === 'urgent' &&
        ['notificationError', 'agentFailed'].includes(snapshot.reason))
    if (
      !validPair ||
      notificationReason !== (snapshot.notificationId !== undefined) ||
      (snapshot.state === 'none' && snapshot.unreadCount !== 0) ||
      (snapshot.reason === 'agentRunning' && snapshot.unreadCount !== 0) ||
      (notificationReason && snapshot.unreadCount === 0) ||
      (snapshot.tabId !== undefined && snapshot.paneId === undefined) ||
      (!notificationReason && (snapshot.paneId !== undefined || snapshot.tabId !== undefined))
    ) {
      context.addIssue({ code: 'custom', message: 'attention source and target are inconsistent' })
    }
  })

export const workspaceAttentionSnapshotParamsSchema = z.strictObject({ workspaceId: uuidSchema })

export const attentionAcknowledgementParamsSchema = z.strictObject({
  notificationId: uuidSchema,
  expectedRevision: revisionSchema,
  idempotencyKey: uuidSchema,
  mode: z.enum(['focused', 'explicit'])
})

export const attentionAcknowledgementResultSchema = z
  .strictObject({
    revision: revisionSchema,
    attention: workspaceAttentionSnapshotSchema
  })
  .refine(({ revision, attention }) => revision === attention.revision, {
    message: 'acknowledgement and attention revisions must match'
  })

export const workspaceAttentionChangedDataSchema = z.strictObject({
  workspaceId: uuidSchema,
  attentionRevision: revisionSchema,
  reason: z.enum(['sourcesChanged', 'resyncRequired'])
})

export const workspaceAttentionChangedEventSchema = z.strictObject({
  event: z.literal('workspace.attentionChanged'),
  data: workspaceAttentionChangedDataSchema
})

export const agentStatusCardSlotSchema = z.strictObject({
  status: z.enum(['idle', 'running', 'waiting', 'completed', 'failed']),
  label: cardSlotLabelSchema.nullable()
})

export const progressCardSlotSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('determinate'),
    value: z.number().int().min(0).max(100),
    label: cardSlotLabelSchema.nullable()
  }),
  z.strictObject({
    mode: z.literal('indeterminate'),
    label: cardSlotLabelSchema
  })
])

export const workspaceCardSlotsSnapshotSchema = z.strictObject({
  workspaceId: uuidSchema,
  revision: revisionSchema,
  agentStatus: agentStatusCardSlotSchema.nullable(),
  progress: progressCardSlotSchema.nullable()
})

export const workspaceCardSlotsSnapshotParamsSchema = z.strictObject({ workspaceId: uuidSchema })

export const workspaceCardSlotsReplaceParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  expectedRevision: revisionSchema,
  agentStatus: agentStatusCardSlotSchema.nullable(),
  progress: progressCardSlotSchema.nullable()
})

export const workspaceCardSlotsChangedDataSchema = z.strictObject({
  workspaceId: uuidSchema,
  slotRevision: revisionSchema,
  reason: z.literal('slotsReplaced')
})

export const workspaceCardSlotsChangedEventSchema = z.strictObject({
  event: z.literal('workspace.cardSlotsChanged'),
  data: workspaceCardSlotsChangedDataSchema
})

const cardSlotV2TextSchema = (max: number) =>
  normalizedString(max).refine((value) => !hasControlCharacter(value), {
    message: 'card-slot text must not contain control characters'
  })

export const workspaceCardSlotV2KindSchema = z.enum([
  'agentStatus',
  'progress',
  'pullRequest',
  'metadata',
  'markdown',
  'logTail',
  'task',
  'ssh',
  'media'
])

export const pullRequestCardSlotSchema = z.strictObject({
  provider: cardSlotV2TextSchema(40),
  number: revisionSchema.positive(),
  title: cardSlotV2TextSchema(160),
  lifecycle: z.enum(['draft', 'open', 'merged', 'closed']),
  checks: z.enum(['unknown', 'pending', 'passing', 'failing']),
  url: cardSlotV2TextSchema(2048)
    .refine((value) => value.startsWith('https://') && isSafeExternalUrl(value), {
      message: 'pull-request URL must be a canonical credential-free HTTPS URL'
    })
    .nullable()
})

export const metadataCardSlotSchema = z
  .strictObject({
    rows: z
      .array(
        z.strictObject({
          key: cardSlotV2TextSchema(40),
          value: cardSlotV2TextSchema(120)
        })
      )
      .max(6)
  })
  .superRefine(({ rows }, context) => {
    const keys = new Set<string>()
    for (const row of rows) {
      const key = row.key.toLocaleLowerCase('und')
      if (keys.has(key)) {
        context.addIssue({ code: 'custom', message: 'duplicate normalized metadata key' })
        return
      }
      keys.add(key)
    }
  })

export const markdownCardSlotSchema = z.strictObject({
  source: normalizedString(4096).refine(
    (value) =>
      [...value].every((character) => character === '\n' || !hasControlCharacter(character)),
    { message: 'Markdown source must not contain control characters other than newlines' }
  )
})

export const logTailCardSlotSchema = z.strictObject({
  lines: z.array(cardSlotV2TextSchema(240)).max(20),
  truncated: z.boolean()
})

export const taskCardSlotSchema = z
  .strictObject({
    title: cardSlotV2TextSchema(120),
    items: z
      .array(
        z.strictObject({
          id: uuidSchema,
          label: cardSlotV2TextSchema(160),
          state: z.enum(['pending', 'inProgress', 'completed', 'failed', 'skipped'])
        })
      )
      .max(12)
  })
  .refine(({ items }) => new Set(items.map(({ id }) => id)).size === items.length, {
    message: 'task item IDs must be unique'
  })

export const sshCardSlotSchema = z.strictObject({
  label: cardSlotV2TextSchema(120),
  state: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'detached', 'failed'])
})

export const mediaCardSlotSchema = z.strictObject({
  mediaKind: z.enum(['audio', 'video']),
  state: z.enum(['idle', 'playing', 'paused', 'buffering', 'completed', 'failed']),
  label: cardSlotV2TextSchema(160)
})

export const workspaceCardSlotV2PayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agentStatus'), value: agentStatusCardSlotSchema }),
  z.strictObject({ kind: z.literal('progress'), value: progressCardSlotSchema }),
  z.strictObject({ kind: z.literal('pullRequest'), value: pullRequestCardSlotSchema }),
  z.strictObject({ kind: z.literal('metadata'), value: metadataCardSlotSchema }),
  z.strictObject({ kind: z.literal('markdown'), value: markdownCardSlotSchema }),
  z.strictObject({ kind: z.literal('logTail'), value: logTailCardSlotSchema }),
  z.strictObject({ kind: z.literal('task'), value: taskCardSlotSchema }),
  z.strictObject({ kind: z.literal('ssh'), value: sshCardSlotSchema }),
  z.strictObject({ kind: z.literal('media'), value: mediaCardSlotSchema })
])

const matchingCardSlotV2Payload = <T extends { kind: string; payload: { kind: string } | null }>(
  value: T
) => value.payload === null || value.payload.kind === value.kind

export const workspaceCardSlotV2SnapshotSchema = z
  .strictObject({
    workspaceId: uuidSchema,
    kind: workspaceCardSlotV2KindSchema,
    slotRevision: revisionSchema,
    payload: workspaceCardSlotV2PayloadSchema.nullable()
  })
  .refine(matchingCardSlotV2Payload, { message: 'payload kind must match slot kind' })

export const workspaceCardSlotV2GetParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  kind: workspaceCardSlotV2KindSchema
})

export const workspaceCardSlotV2ReplaceParamsSchema = z
  .strictObject({
    workspaceId: uuidSchema,
    kind: workspaceCardSlotV2KindSchema,
    expectedRevision: revisionSchema,
    payload: workspaceCardSlotV2PayloadSchema.nullable()
  })
  .refine(matchingCardSlotV2Payload, { message: 'payload kind must match slot kind' })

export const workspaceCardSlotV2ChangedDataSchema = z.strictObject({
  workspaceId: uuidSchema,
  kind: workspaceCardSlotV2KindSchema,
  slotRevision: revisionSchema,
  reason: z.enum(['slotReplaced', 'resyncRequired'])
})

export const workspaceCardSlotV2ChangedEventSchema = z.strictObject({
  event: z.literal('workspace.cardSlots.v2Changed'),
  data: workspaceCardSlotV2ChangedDataSchema
})

export const serviceReadyRecordSchema = z.strictObject({
  event: z.literal('service.ready'),
  application: z.literal('agent-workspace'),
  version: z.string().min(1),
  protocolVersion: uint32Schema
})

const serviceRecoveryRequiredSafeRecordShape = {
  event: z.literal('service.recoveryRequired'),
  application: z.literal('agent-workspace'),
  version: normalizedString(128).refine((value) => !hasControlCharacter(value)),
  protocolVersion: uint32Schema,
  category: z.enum([
    'futureSchema',
    'corruptDatabase',
    'corruptSchema',
    'invalidSnapshot',
    'migrationFailed',
    'permissions',
    'unknown'
  ]),
  message: normalizedString(512).refine((value) => !hasControlCharacter(value)),
  migrationBackupAvailable: z.boolean()
} as const

export const serviceRecoveryRequiredSafeRecordSchema = z.strictObject(
  serviceRecoveryRequiredSafeRecordShape
)

export const serviceRecoveryRequiredRecordSchema = z
  .strictObject({
    ...serviceRecoveryRequiredSafeRecordShape,
    migrationBackupPath: absolutePathSchema
      .max(4096)
      .refine((value) => value === value.trim() && !hasControlCharacter(value))
      .optional()
  })
  .refine(
    (record) => record.migrationBackupAvailable === (record.migrationBackupPath !== undefined),
    { message: 'migration backup availability must match the retained backup path' }
  )

export const startupRecordSchema = z.discriminatedUnion('event', [
  serviceReadyRecordSchema,
  serviceRecoveryRequiredRecordSchema
])

export const COMMAND_CATALOG = [
  ['workspace.new', 'Primary+O'],
  ['terminal.new', 'Primary+T'],
  ['tab.close', 'Primary+W'],
  ['pane.splitRight', 'Primary+D'],
  ['pane.splitDown', 'Primary+Shift+D'],
  ['sidebar.toggle', 'Primary+B'],
  ['commandPalette.toggle', 'Primary+Shift+P'],
  ['terminal.search', 'Primary+F'],
  ['browser.openSplit', 'Primary+Shift+L'],
  ['notifications.toggle', 'Primary+I'],
  ['notifications.latestUnread', 'Primary+Shift+U'],
  ['settings.open', 'Primary+Comma']
] as const

const commandIdSchema = z.enum(
  COMMAND_CATALOG.map(([commandId]) => commandId) as [string, ...string[]]
)

const SHORTCUT_KEYS = new Set([
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Minus',
  'Equal',
  'Backquote'
])
const shortcutSchema = normalizedString(128).refine(
  (value) => {
    const parts = value.split('+')
    if (parts.length < 2) return false
    const order = ['Primary', 'Secondary', 'Control', 'Shift']
    const modifiers = parts.slice(0, -1)
    if (
      modifiers.some((modifier) => !order.includes(modifier)) ||
      new Set(modifiers).size !== modifiers.length ||
      modifiers.some(
        (modifier, index) => order.indexOf(modifier) <= order.indexOf(modifiers[index - 1] ?? '')
      )
    )
      return false
    const key = parts.at(-1) ?? ''
    return /^[A-Z0-9]$/u.test(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key) || SHORTCUT_KEYS.has(key)
  },
  { message: 'invalid canonical logical shortcut' }
)

const configurationTextSchema = (max: number) =>
  normalizedString(max).refine((value) => !hasControlCharacter(value), {
    message: 'configuration text contains a control character'
  })
const normalizedAbsolutePathSchema = (max: number) =>
  absolutePathSchema
    .max(max)
    .refine((value) => value === value.trim() && !hasControlCharacter(value), {
      message: 'path must be normalized and control-free'
    })

export const appearanceConfigurationSchema = z.strictObject({
  theme: z.enum(['system', 'dark', 'light']),
  density: z.enum(['compact', 'comfortable', 'expanded']),
  fontFamily: configurationTextSchema(256)
})

export const terminalConfigurationSchema = z.strictObject({
  shellPath: normalizedAbsolutePathSchema(1024).nullable(),
  fontFamily: configurationTextSchema(256),
  fontSize: z.number().finite().min(6).max(72),
  scrollback: z.number().int().min(100).max(1_000_000),
  multilinePasteProtection: z.boolean()
})

export const browserConfigurationSchema = z.strictObject({
  profileName: configurationTextSchema(128),
  partition: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/u),
  privacy: z.enum(['standard', 'strict'])
})

export const notificationConfigurationSchema = z.strictObject({
  systemEnabled: z.boolean(),
  includeBody: z.boolean()
})

export const keyboardShortcutConfigurationSchema = z.strictObject({
  overrides: z.partialRecord(commandIdSchema, shortcutSchema.nullable())
})

export const agentIntegrationConfigurationSchema = z.strictObject({
  enabled: z.boolean(),
  notificationsEnabled: z.boolean(),
  browserEnabled: z.boolean()
})

export const updateConfigurationSchema = z.strictObject({
  channel: z.enum(['stable', 'beta'])
})

export const loggingConfigurationSchema = z.strictObject({
  level: z.enum(['error', 'warn', 'info', 'debug', 'trace'])
})

const configurationSections = {
  appearance: appearanceConfigurationSchema,
  terminal: terminalConfigurationSchema,
  browser: browserConfigurationSchema,
  notifications: notificationConfigurationSchema,
  keyboardShortcuts: keyboardShortcutConfigurationSchema,
  agentIntegration: agentIntegrationConfigurationSchema,
  updates: updateConfigurationSchema,
  logging: loggingConfigurationSchema
}

export const configurationSnapshotSchema = z
  .strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    revision: revisionSchema,
    ...configurationSections
  })
  .refine(
    ({ appearance, schemaVersion }) => schemaVersion === 2 || appearance.density !== 'expanded',
    { message: 'expanded density requires configuration schemaVersion 2' }
  )

export const configurationGetResultSchema = z.strictObject({
  config: configurationSnapshotSchema
})

export const configurationUpdateSchema = z
  .strictObject({
    appearance: appearanceConfigurationSchema.optional(),
    terminal: terminalConfigurationSchema.optional(),
    browser: browserConfigurationSchema.optional(),
    notifications: notificationConfigurationSchema.optional(),
    keyboardShortcuts: keyboardShortcutConfigurationSchema.optional(),
    agentIntegration: agentIntegrationConfigurationSchema.optional(),
    updates: updateConfigurationSchema.optional(),
    logging: loggingConfigurationSchema.optional()
  })
  .refine((update) => Object.values(update).some((section) => section !== undefined), {
    message: 'configuration update must not be empty'
  })

export const configurationUpdateParamsSchema = z.strictObject({
  expectedRevision: revisionSchema,
  update: configurationUpdateSchema
})

export const windowStateSnapshotSchema = z.strictObject({
  revision: revisionSchema,
  x: z.number().finite().int().min(-1_000_000).max(1_000_000),
  y: z.number().finite().int().min(-1_000_000).max(1_000_000),
  width: z.number().int().min(200).max(32_768),
  height: z.number().int().min(200).max(32_768),
  maximized: z.boolean(),
  fullscreen: z.boolean(),
  displayId: configurationTextSchema(256).optional()
})

export const windowStateGetResultSchema = z.strictObject({
  state: windowStateSnapshotSchema.optional()
})

export const windowStateUpdateParamsSchema = z.strictObject({
  state: windowStateSnapshotSchema
})

export const diagnosticBundleEntrySchema = z.strictObject({
  name: configurationTextSchema(256),
  bytes: revisionSchema.max(256 * 1024 * 1024)
})

export const diagnosticBundlePreviewSchema = z
  .strictObject({
    entries: z.array(diagnosticBundleEntrySchema).max(64),
    totalBytes: revisionSchema.max(1024 * 1024 * 1024),
    redactionCount: revisionSchema.max(1_000_000),
    createdAt: revisionSchema
  })
  .refine(
    ({ entries, totalBytes }) =>
      entries.reduce((total, entry) => total + entry.bytes, 0) === totalBytes,
    { message: 'diagnostic total must match entry sizes' }
  )

export const recoveryExportResultSchema = z.strictObject({
  path: normalizedAbsolutePathSchema(4096),
  bytes: revisionSchema
})

export const isSafeExternalUrl = (value: string): boolean => {
  if (
    value.length === 0 ||
    [...value].length > 8192 ||
    /\s/u.test(value) ||
    hasControlCharacter(value) ||
    value.includes('\\')
  ) {
    return false
  }
  const separator = value.indexOf('://')
  if (separator < 0) return false
  const scheme = value.slice(0, separator)
  if (scheme !== 'http' && scheme !== 'https') return false
  const authority = value.slice(separator + 3).split(/[/?#]/u, 1)[0] ?? ''
  if (authority.length === 0 || /[@%]/u.test(authority)) return false

  let host: string
  let port: string | undefined
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close < 0) return false
    host = authority.slice(1, close)
    const suffix = authority.slice(close + 1)
    if (suffix.length > 0 && !suffix.startsWith(':')) return false
    port = suffix.length > 0 ? suffix.slice(1) : undefined
    if (host.length === 0 || !/^[0-9A-Fa-f:.]+$/u.test(host)) return false
  } else {
    const colon = authority.lastIndexOf(':')
    host = colon < 0 ? authority : authority.slice(0, colon)
    port = colon < 0 ? undefined : authority.slice(colon + 1)
    if (
      host.length === 0 ||
      host.split('.').some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label))
    ) {
      return false
    }
  }
  if (port !== undefined) {
    if (!/^\d+$/u.test(port)) return false
    const parsed = Number(port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return false
  }
  return true
}

const isSafePortableLayoutUrl = (value: string): boolean => {
  if (!isSafeExternalUrl(value)) return false
  try {
    const parsed = new URL(value)
    return (
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.toString() === value
    )
  } catch {
    return false
  }
}

const browserPartitionSchema = z
  .string()
  .min('persist:'.length + 1)
  .max(128)
  .regex(/^persist:[A-Za-z0-9._-]+$/u)
const browserCorrelationSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:._-]+$/u)
const browserNavigationTitleSchema = normalizedString(256, true).refine(
  (value) => !hasControlCharacter(value),
  { message: 'browser navigation title contains a control character' }
)

export const protocolErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  details: z.unknown()
})

export const responseEnvelopeSchema = z.strictObject({
  id: z.string(),
  ok: z.boolean(),
  revision: revisionSchema.optional(),
  result: z.unknown().optional(),
  error: protocolErrorSchema.optional()
})

export const identifyResultSchema = z.strictObject({
  application: z.literal('agent-workspace'),
  version: z.string().min(1),
  protocolVersion: uint32Schema.pipe(z.literal(1)),
  capabilities: z.array(z.string())
})

const terminalDescriptorSchema = z.strictObject({
  id: z.string().uuid(),
  processId: uint32Schema.optional(),
  command: z.array(commandArgumentSchema).min(1),
  cwd: absolutePathSchema,
  rows: z.number().int().min(1).max(1000),
  cols: z.number().int().min(1).max(1000),
  exited: z.boolean(),
  exitCode: uint32Schema.optional()
})

const terminalOutputChunkSchema = z.strictObject({
  sequence: revisionSchema,
  data: z.string(),
  byteLength: uint32Schema.max(64 * 1024)
})

export const terminalCheckpointSchema = z
  .strictObject({
    sequence: revisionSchema,
    rows: z.number().int().min(1).max(1000),
    cols: z.number().int().min(1).max(1000),
    activeBuffer: z.enum(['normal', 'alternate']),
    data: z.string()
  })
  .refine(
    (checkpoint) => new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength <= 512 * 1024,
    {
      message: 'serialized checkpoint exceeds the wire byte cap'
    }
  )

export const terminalCreateParamsSchema = z.strictObject({
  rows: z.number().int().min(1).max(1000),
  cols: z.number().int().min(1).max(1000),
  cwd: absolutePathSchema.optional(),
  command: z.array(commandArgumentSchema).min(1).optional()
})

export const terminalCreateResultSchema = z.strictObject({
  terminal: terminalDescriptorSchema
})

export const terminalAttachResultSchema = z.strictObject({
  terminal: terminalDescriptorSchema,
  checkpoint: terminalCheckpointSchema.optional(),
  output: z.array(terminalOutputChunkSchema),
  lastSequence: revisionSchema,
  reconstructionComplete: z.boolean()
})

export const terminalRuntimeMetadataResultSchema = z.strictObject({
  terminalId: uuidSchema,
  listeningPorts: z
    .array(z.number().int().min(1).max(0xffff))
    .max(16)
    .refine((ports) => ports.every((port, index) => index === 0 || ports[index - 1]! < port), {
      message: 'listening ports must be sorted and unique'
    })
})

const terminalOutputEventSchema = z.strictObject({
  event: z.literal('terminal.output'),
  data: z.strictObject({
    terminalId: z.string().uuid(),
    chunk: terminalOutputChunkSchema
  })
})

const terminalResizedEventSchema = z.strictObject({
  event: z.literal('terminal.resized'),
  data: z.strictObject({
    terminalId: z.string().uuid(),
    rows: z.number().int().min(1).max(1000),
    cols: z.number().int().min(1).max(1000)
  })
})

const terminalCheckpointRequestedEventSchema = z.strictObject({
  event: z.literal('terminal.checkpointRequested'),
  data: z.strictObject({
    terminalId: z.string().uuid(),
    sequence: revisionSchema
  })
})

const terminalExitedEventSchema = z.strictObject({
  event: z.literal('terminal.exited'),
  data: z.strictObject({
    terminalId: z.string().uuid(),
    exitCode: uint32Schema,
    signal: z.string().nullable()
  })
})

const terminalResyncRequiredEventSchema = z.strictObject({
  event: z.literal('terminal.resyncRequired'),
  data: z.strictObject({
    terminalId: z.string().uuid().optional()
  })
})

export const terminalEventSchema = z.discriminatedUnion('event', [
  terminalOutputEventSchema,
  terminalResizedEventSchema,
  terminalCheckpointRequestedEventSchema,
  terminalExitedEventSchema,
  terminalResyncRequiredEventSchema
])

export type TerminalEventMessage = z.infer<typeof terminalEventSchema>

export type PaneTreeNodeWire =
  | { kind: 'leaf'; paneId: string }
  | {
      kind: 'split'
      splitId: string
      axis: 'horizontal' | 'vertical'
      ratio: number
      first: PaneTreeNodeWire
      second: PaneTreeNodeWire
    }

export const paneTreeNodeSchema: z.ZodType<PaneTreeNodeWire> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('leaf'), paneId: uuidSchema }),
    z.strictObject({
      kind: z.literal('split'),
      splitId: uuidSchema,
      axis: z.enum(['horizontal', 'vertical']),
      ratio: ratioSchema,
      first: paneTreeNodeSchema,
      second: paneTreeNodeSchema
    })
  ])
)

export const terminalLaunchMetadataSchema = z.strictObject({
  cwd: absolutePathSchema,
  rows: z.number().int().min(1).max(1000),
  cols: z.number().int().min(1).max(1000)
})

export const terminalLaunchRequestSchema = z.strictObject({
  cwd: absolutePathSchema,
  command: z.array(commandArgumentSchema).min(1).optional(),
  rows: z.number().int().min(1).max(1000),
  cols: z.number().int().min(1).max(1000)
})

export const browserPlaceholderMetadataSchema = z.strictObject({
  url: z.string().refine(isSafeExternalUrl, { message: 'unsafe or non-canonical browser URL' })
})

export const browserSessionStateSchema = z.strictObject({
  browserSessionId: uuidSchema,
  url: z.string().refine(isSafeExternalUrl, { message: 'unsafe or non-canonical browser URL' }),
  navigationTitle: browserNavigationTitleSchema,
  canBack: z.boolean(),
  canForward: z.boolean(),
  loading: z.boolean(),
  devToolsOpen: z.boolean(),
  profilePartition: browserPartitionSchema,
  stateRevision: revisionSchema,
  correlationId: browserCorrelationSchema.nullable()
})

export const tabContentSnapshotSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('terminal'),
    launch: terminalLaunchMetadataSchema,
    runtimeSessionId: uuidSchema.optional()
  }),
  z.strictObject({
    kind: z.literal('browser'),
    state: browserSessionStateSchema
  })
])

export const notificationSourceSchema = z.enum(['cli', 'osc', 'agentHook', 'internal'])
export const notificationLevelSchema = z.enum(['info', 'warning', 'error'])
const notificationTextSchema = (max: number) =>
  normalizedString(max).refine((value) => !hasControlCharacter(value), {
    message: 'notification text must not contain control characters'
  })
const notificationTitleSchema = notificationTextSchema(256)
const notificationBodySchema = notificationTextSchema(4096)

export const attentionExcerptSchema = z.strictObject({
  notificationId: uuidSchema,
  title: notificationTitleSchema,
  bodyExcerpt: notificationBodySchema.nullable(),
  source: notificationSourceSchema,
  createdAt: revisionSchema
})

export const attentionSummarySchema = z
  .strictObject({
    unreadCount: uint32Schema,
    highestLevel: notificationLevelSchema.nullable(),
    latestUnread: attentionExcerptSchema.nullable()
  })
  .refine(
    ({ unreadCount, highestLevel, latestUnread }) =>
      unreadCount === 0
        ? highestLevel === null && latestUnread === null
        : highestLevel !== null && latestUnread !== null,
    { message: 'empty attention must have null level and latest unread' }
  )

export const notificationSnapshotSchema = z
  .strictObject({
    id: uuidSchema,
    workspaceId: uuidSchema,
    paneId: uuidSchema.optional(),
    tabId: uuidSchema.optional(),
    source: notificationSourceSchema,
    level: notificationLevelSchema,
    title: notificationTitleSchema,
    body: notificationBodySchema.optional(),
    createdAt: revisionSchema,
    readAt: revisionSchema.optional()
  })
  .refine(({ createdAt, readAt }) => readAt === undefined || readAt >= createdAt, {
    message: 'readAt must not precede createdAt'
  })

export const notificationTargetSchema = z.strictObject({
  workspaceId: uuidSchema,
  paneId: uuidSchema.optional(),
  tabId: uuidSchema.optional()
})

export const notificationListParamsSchema = z.strictObject({
  workspaceId: uuidSchema.optional(),
  unreadOnly: z.boolean().default(false),
  offset: revisionSchema.default(0),
  limit: z.number().int().min(1).max(200).default(50)
})

export const notificationListResultSchema = z
  .strictObject({
    revision: revisionSchema,
    notifications: z.array(notificationSnapshotSchema),
    total: revisionSchema,
    unreadCount: revisionSchema
  })
  .superRefine(({ notifications, total, unreadCount }, context) => {
    if (total < notifications.length || unreadCount > total) {
      context.addIssue({ code: 'custom', message: 'invalid notification list counts' })
    }
    if (
      notifications.some(
        (item, index) => index > 0 && notifications[index - 1]!.createdAt < item.createdAt
      )
    ) {
      context.addIssue({ code: 'custom', message: 'notifications must be newest first' })
    }
  })

export const notificationPublishParamsSchema = z.strictObject({
  target: notificationTargetSchema,
  source: notificationSourceSchema,
  level: notificationLevelSchema,
  title: notificationTitleSchema,
  body: notificationBodySchema.optional()
})

export const notificationIdParamsSchema = z.strictObject({ notificationId: uuidSchema })
export const notificationMarkReadParamsSchema = notificationIdParamsSchema
export const notificationMarkUnreadParamsSchema = notificationIdParamsSchema
export const notificationClearScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('notification'), notificationId: uuidSchema }),
  z.strictObject({ kind: z.literal('read') }),
  z.strictObject({ kind: z.literal('all') })
])
export const notificationClearParamsSchema = z.strictObject({
  scope: notificationClearScopeSchema
})

export const notificationSettingsSchema = z.strictObject({
  systemEnabled: z.boolean(),
  includeBody: z.boolean()
})

export const tabSnapshotSchema = z.strictObject({
  id: uuidSchema,
  paneId: uuidSchema,
  title: titleSchema,
  customTitle: titleSchema.nullable(),
  content: tabContentSnapshotSchema,
  attention: attentionSummarySchema,
  createdAt: revisionSchema
})

export const paneSnapshotSchema = z.strictObject({
  id: uuidSchema,
  tabIds: z.array(uuidSchema).min(1),
  selectedTabId: uuidSchema,
  title: titleSchema.nullable(),
  attention: attentionSummarySchema
})

export const shortcutOverrideSchema = z.strictObject({
  commandId: commandIdSchema,
  shortcut: shortcutSchema.nullable()
})

export const workspaceSnapshotSchema = z
  .strictObject({
    id: uuidSchema,
    name: normalizedString(128),
    description: normalizedString(4096, true).nullable(),
    color: normalizedString(64).nullable(),
    workingDirectory: absolutePathSchema,
    layout: paneTreeNodeSchema,
    selectedPaneId: uuidSchema,
    panes: z.array(paneSnapshotSchema).min(1),
    tabs: z.array(tabSnapshotSchema).min(1),
    attention: attentionSummarySchema,
    createdAt: revisionSchema,
    updatedAt: revisionSchema
  })
  .superRefine((workspace, context) => {
    const paneIds = new Set<string>()
    const tabIds = new Set<string>()
    const splitIds = new Set<string>()
    const leafIds: string[] = []
    const duplicate = (kind: string, id: string) =>
      context.addIssue({ code: 'custom', message: `duplicate ${kind} id: ${id}` })

    for (const pane of workspace.panes) {
      if (paneIds.has(pane.id)) duplicate('pane', pane.id)
      paneIds.add(pane.id)
      if (!pane.tabIds.includes(pane.selectedTabId)) {
        context.addIssue({
          code: 'custom',
          message: `selected tab is missing from pane ${pane.id}`
        })
      }
      if (new Set(pane.tabIds).size !== pane.tabIds.length) duplicate('pane tab', pane.id)
    }
    for (const tab of workspace.tabs) {
      if (tabIds.has(tab.id)) duplicate('tab', tab.id)
      tabIds.add(tab.id)
    }
    const walk = (node: PaneTreeNodeWire): void => {
      if (node.kind === 'leaf') {
        leafIds.push(node.paneId)
        return
      }
      if (splitIds.has(node.splitId)) duplicate('split', node.splitId)
      splitIds.add(node.splitId)
      walk(node.first)
      walk(node.second)
    }
    walk(workspace.layout)
    if (new Set(leafIds).size !== leafIds.length) duplicate('layout pane', workspace.id)
    if (
      leafIds.length !== paneIds.size ||
      leafIds.some((id) => !paneIds.has(id)) ||
      !paneIds.has(workspace.selectedPaneId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'layout leaves or selected pane do not match panes'
      })
    }
    const ownedTabs = workspace.panes.flatMap((pane) => pane.tabIds)
    if (
      new Set(ownedTabs).size !== ownedTabs.length ||
      ownedTabs.length !== tabIds.size ||
      ownedTabs.some((id) => !tabIds.has(id))
    ) {
      context.addIssue({ code: 'custom', message: 'pane tab order does not match tabs' })
    }
    for (const tab of workspace.tabs) {
      const owner = workspace.panes.find((pane) => pane.id === tab.paneId)
      if (!owner?.tabIds.includes(tab.id)) {
        context.addIssue({ code: 'custom', message: `tab ${tab.id} has an invalid pane owner` })
      }
    }
  })

export const applicationSnapshotSchema = z
  .strictObject({
    revision: revisionSchema,
    workspaces: z.array(workspaceSnapshotSchema).min(1),
    selectedWorkspaceId: uuidSchema,
    shortcutOverrides: z.array(shortcutOverrideSchema),
    attention: attentionSummarySchema
  })
  .superRefine((snapshot, context) => {
    const workspaceIds = snapshot.workspaces.map(({ id }) => id)
    if (new Set(workspaceIds).size !== workspaceIds.length) {
      context.addIssue({ code: 'custom', message: 'workspace ids must be unique' })
    }
    if (!workspaceIds.includes(snapshot.selectedWorkspaceId)) {
      context.addIssue({ code: 'custom', message: 'selected workspace does not exist' })
    }
    const collectUnique = (kind: string, ids: string[]) => {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', message: `${kind} ids must be globally unique` })
      }
    }
    const paneIds = snapshot.workspaces.flatMap(({ panes }) => panes.map(({ id }) => id))
    const tabIds = snapshot.workspaces.flatMap(({ tabs }) => tabs.map(({ id }) => id))
    const splitIds: string[] = []
    const collectSplits = (node: PaneTreeNodeWire): void => {
      if (node.kind === 'leaf') return
      splitIds.push(node.splitId)
      collectSplits(node.first)
      collectSplits(node.second)
    }
    snapshot.workspaces.forEach(({ layout }) => collectSplits(layout))
    const runtimeSessionIds = snapshot.workspaces.flatMap(({ tabs }) =>
      tabs.flatMap(({ content }) =>
        content.kind === 'terminal' && content.runtimeSessionId ? [content.runtimeSessionId] : []
      )
    )
    collectUnique('pane', paneIds)
    collectUnique('split', splitIds)
    collectUnique('tab', tabIds)
    collectUnique('runtime session', runtimeSessionIds)
    collectUnique('application identity', [
      ...workspaceIds,
      ...paneIds,
      ...splitIds,
      ...tabIds,
      ...runtimeSessionIds
    ])
    const commandIds = snapshot.shortcutOverrides.map(({ commandId }) => commandId)
    if (new Set(commandIds).size !== commandIds.length) {
      context.addIssue({ code: 'custom', message: 'shortcut override command ids must be unique' })
    }
  })

export const nullableStringUpdateSchema = z.strictObject({ value: z.string().nullable() })
const nullableDescriptionUpdateSchema = z.strictObject({
  value: normalizedString(4096, true).nullable()
})
const nullableColorUpdateSchema = z.strictObject({ value: normalizedString(64).nullable() })
const nullableTitleUpdateSchema = z.strictObject({ value: titleSchema.nullable() })

export const emptyParamsSchema = z.strictObject({})

export const workspaceListResultSchema = z.strictObject({ snapshot: applicationSnapshotSchema })

export const workspaceSnapshotParamsSchema = z.strictObject({ workspaceId: uuidSchema })

export const workspaceSnapshotResultSchema = z.strictObject({
  revision: revisionSchema,
  workspace: workspaceSnapshotSchema
})

export const workspaceCreateParamsSchema = z.strictObject({
  name: normalizedString(128),
  description: normalizedString(4096, true).optional(),
  color: normalizedString(64).optional(),
  workingDirectory: absolutePathSchema,
  initialTerminal: terminalLaunchRequestSchema
})

const organizationNameSchema = normalizedString(80)
const idempotentRevisionShape = {
  expectedRevision: revisionSchema,
  idempotencyKey: uuidSchema
} as const

export const workspaceGroupSnapshotSchema = z.strictObject({
  id: uuidSchema,
  name: organizationNameSchema,
  collapsed: z.boolean(),
  order: uint32Schema
})

export const workspaceGroupAssignmentSchema = z.strictObject({
  workspaceId: uuidSchema,
  groupId: uuidSchema
})

export const legacyLimitDimensionSchema = z.enum([
  'workspaces',
  'panesPerWorkspace',
  'tabsPerWorkspace',
  'totalPanes',
  'totalTabs'
])
export const legacyOverLimitSnapshotSchema = z
  .strictObject({
    workspaceCount: revisionSchema,
    maximumPanesInWorkspace: revisionSchema,
    maximumTabsInWorkspace: revisionSchema,
    totalPaneCount: revisionSchema,
    totalTabCount: revisionSchema,
    exceededDimensions: z.array(legacyLimitDimensionSchema).min(1).max(5)
  })
  .refine(
    (legacy) => {
      const expected = [
        legacy.workspaceCount > 128 && 'workspaces',
        legacy.maximumPanesInWorkspace > 64 && 'panesPerWorkspace',
        legacy.maximumTabsInWorkspace > 128 && 'tabsPerWorkspace',
        legacy.totalPaneCount > 1024 && 'totalPanes',
        legacy.totalTabCount > 2048 && 'totalTabs'
      ].filter(Boolean)
      return JSON.stringify(legacy.exceededDimensions) === JSON.stringify(expected)
    },
    { message: 'legacy over-limit dimensions must exactly match the reported counts' }
  )

export const workspaceOrganizationSnapshotSchema = z
  .strictObject({
    revision: revisionSchema,
    selection: z.array(uuidSchema).min(1).max(128),
    focusedWorkspaceId: uuidSchema,
    pins: z.array(uuidSchema).max(128),
    groups: z.array(workspaceGroupSnapshotSchema).max(128),
    assignments: z.array(workspaceGroupAssignmentSchema).max(128),
    legacyOverLimit: legacyOverLimitSnapshotSchema.optional()
  })
  .superRefine((organization, context) => {
    const selection = new Set(organization.selection)
    const pins = new Set(organization.pins)
    const groupIds = new Set(organization.groups.map(({ id }) => id))
    const groupOrders = new Set(organization.groups.map(({ order }) => order))
    const assignedWorkspaces = new Set(
      organization.assignments.map(({ workspaceId }) => workspaceId)
    )
    if (
      selection.size !== organization.selection.length ||
      !selection.has(organization.focusedWorkspaceId) ||
      pins.size !== organization.pins.length ||
      groupIds.size !== organization.groups.length ||
      groupOrders.size !== organization.groups.length ||
      assignedWorkspaces.size !== organization.assignments.length ||
      organization.assignments.some(({ groupId }) => !groupIds.has(groupId))
    ) {
      context.addIssue({ code: 'custom', message: 'workspace organization graph is invalid' })
    }
  })

export const workspaceOrganizationGetResultSchema = z.strictObject({
  organization: workspaceOrganizationSnapshotSchema
})

export const workspaceSelectionReplaceParamsSchema = z
  .strictObject({
    selection: z.array(uuidSchema).min(1).max(128),
    focusedWorkspaceId: uuidSchema,
    ...idempotentRevisionShape
  })
  .refine(
    ({ selection, focusedWorkspaceId }) =>
      new Set(selection).size === selection.length && selection.includes(focusedWorkspaceId),
    { message: 'workspace selection must be unique and include the focused workspace' }
  )

export const workspacePinParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  pinned: z.boolean(),
  ...idempotentRevisionShape
})

export const workspaceBatchCloseParamsSchema = z.strictObject({
  replacement: workspaceCreateParamsSchema.optional(),
  ...idempotentRevisionShape
})

export const workspaceCanonicalMoveParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  destinationIndex: uint32Schema,
  ...idempotentRevisionShape
})

export const groupCreateParamsSchema = z.strictObject({
  groupId: uuidSchema,
  name: organizationNameSchema,
  ...idempotentRevisionShape
})

export const groupRenameParamsSchema = z.strictObject({
  groupId: uuidSchema,
  name: organizationNameSchema,
  ...idempotentRevisionShape
})

export const groupDeleteParamsSchema = z.strictObject({
  groupId: uuidSchema,
  ...idempotentRevisionShape
})

export const groupMoveParamsSchema = z.strictObject({
  groupId: uuidSchema,
  destinationIndex: uint32Schema,
  ...idempotentRevisionShape
})

export const groupAssignParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  groupId: uuidSchema.optional(),
  ...idempotentRevisionShape
})

export const groupCollapseParamsSchema = z.strictObject({
  groupId: uuidSchema,
  collapsed: z.boolean(),
  ...idempotentRevisionShape
})

export const workspaceOrganizationChangedDataSchema = z.strictObject({
  revision: revisionSchema,
  reason: z.literal('organizationChanged')
})

export const workspaceOrganizationChangedEventSchema = z
  .strictObject({
    event: z.literal('workspace.organizationChanged'),
    revision: revisionSchema,
    data: workspaceOrganizationChangedDataSchema
  })
  .refine(({ revision, data }) => revision === data.revision, {
    message: 'organization event envelope and data revisions must match'
  })

export const layoutPaneTemplateSchema = z
  .strictObject({
    id: uuidSchema,
    tabs: z.array(uuidSchema).min(1).max(256),
    selectedTabId: uuidSchema,
    title: titleSchema.nullable()
  })
  .refine(
    ({ tabs, selectedTabId }) => new Set(tabs).size === tabs.length && tabs.includes(selectedTabId),
    { message: 'layout pane tabs must be unique and contain the selected tab' }
  )

export const layoutTabContentTemplateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('terminal'), launch: terminalLaunchMetadataSchema }),
  z.strictObject({
    kind: z.literal('browser'),
    url: z.string().max(8192).refine(isSafePortableLayoutUrl, {
      message: 'saved-layout browser URL must be canonical, credential-free HTTP(S)'
    })
  })
])

export const layoutTabTemplateSchema = z.strictObject({
  id: uuidSchema,
  paneId: uuidSchema,
  title: titleSchema,
  customTitle: titleSchema.nullable(),
  content: layoutTabContentTemplateSchema,
  createdAt: revisionSchema
})

const layoutPaneMapSchema = z.record(uuidSchema, layoutPaneTemplateSchema)
const layoutTabMapSchema = z.record(uuidSchema, layoutTabTemplateSchema)

export const layoutWorkspaceTemplateSchema = z
  .strictObject({
    id: uuidSchema,
    name: normalizedString(128),
    description: normalizedString(4096, true).nullable(),
    color: normalizedString(64).nullable(),
    workingDirectory: absolutePathSchema,
    layout: paneTreeNodeSchema,
    selectedPaneId: uuidSchema,
    panes: layoutPaneMapSchema,
    tabs: layoutTabMapSchema,
    createdAt: revisionSchema,
    updatedAt: revisionSchema
  })
  .superRefine((workspace, context) => {
    const paneEntries = Object.entries(workspace.panes)
    const tabEntries = Object.entries(workspace.tabs)
    if (
      paneEntries.length === 0 ||
      paneEntries.length > 128 ||
      tabEntries.length === 0 ||
      tabEntries.length > 256 ||
      workspace.panes[workspace.selectedPaneId] === undefined
    ) {
      context.addIssue({ code: 'custom', message: 'saved-layout workspace content is invalid' })
      return
    }
    const leaves: string[] = []
    const splits = new Set<string>()
    const visit = (node: PaneTreeNodeWire): boolean => {
      if (node.kind === 'leaf') {
        leaves.push(node.paneId)
        return true
      }
      if (splits.has(node.splitId)) return false
      splits.add(node.splitId)
      return visit(node.first) && visit(node.second)
    }
    const referencedTabs = new Set<string>()
    const graphValid =
      visit(workspace.layout) &&
      leaves.length === paneEntries.length &&
      new Set(leaves).size === leaves.length &&
      leaves.every((id) => workspace.panes[id] !== undefined) &&
      paneEntries.every(
        ([id, pane]) =>
          id === pane.id &&
          pane.tabs.every((tabId) => !referencedTabs.has(tabId) && !!referencedTabs.add(tabId))
      ) &&
      referencedTabs.size === tabEntries.length &&
      tabEntries.every(
        ([id, tab]) =>
          id === tab.id &&
          referencedTabs.has(id) &&
          workspace.panes[tab.paneId]?.tabs.includes(id) === true
      )
    if (!graphValid) {
      context.addIssue({ code: 'custom', message: 'saved-layout workspace graph is invalid' })
    }
  })

export const layoutTemplateSnapshotSchema = z
  .strictObject({ workspaces: z.array(layoutWorkspaceTemplateSchema).min(1).max(32) })
  .superRefine(({ workspaces }, context) => {
    const workspaceIds = new Set(workspaces.map(({ id }) => id))
    const paneIds = new Set<string>()
    const tabIds = new Set<string>()
    let duplicate = workspaceIds.size !== workspaces.length
    for (const workspace of workspaces) {
      for (const id of Object.keys(workspace.panes)) {
        if (paneIds.has(id)) duplicate = true
        paneIds.add(id)
      }
      for (const id of Object.keys(workspace.tabs)) {
        if (tabIds.has(id)) duplicate = true
        tabIds.add(id)
      }
    }
    if (duplicate || paneIds.size > 128 || tabIds.size > 256) {
      context.addIssue({
        code: 'custom',
        message: 'saved-layout global identity or count is invalid'
      })
    }
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024, {
    message: 'saved-layout template exceeds its 256 KiB serialized bound'
  })

export const layoutExportEnvelopeSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    name: normalizedString(80),
    template: layoutTemplateSnapshotSchema
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024, {
    message: 'saved-layout document exceeds its 256 KiB wire bound'
  })

export const savedLayoutSnapshotSchema = z
  .strictObject({
    id: uuidSchema,
    name: normalizedString(80),
    formatVersion: z.literal(1),
    createdAt: revisionSchema,
    updatedAt: revisionSchema,
    template: layoutTemplateSnapshotSchema
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024, {
    message: 'saved-layout snapshot exceeds its 256 KiB serialized bound'
  })

export const savedLayoutSummarySchema = z.strictObject({
  id: uuidSchema,
  name: normalizedString(80),
  formatVersion: z.literal(1),
  createdAt: revisionSchema,
  updatedAt: revisionSchema,
  workspaceCount: uint32Schema.max(32)
})

export const layoutListResultSchema = z
  .strictObject({
    revision: revisionSchema,
    layouts: z.array(savedLayoutSummarySchema).max(64)
  })
  .refine(({ layouts }) => new Set(layouts.map(({ id }) => id)).size === layouts.length, {
    message: 'saved-layout summary IDs must be unique'
  })
export const layoutGetParamsSchema = z.strictObject({ layoutId: uuidSchema })
export const layoutGetResultSchema = z.strictObject({
  revision: revisionSchema,
  layout: savedLayoutSnapshotSchema
})
export const layoutSaveParamsSchema = z
  .strictObject({
    layoutId: uuidSchema,
    name: normalizedString(80),
    workspaceIds: z.array(uuidSchema).min(1).max(32),
    ...idempotentRevisionShape
  })
  .refine(({ workspaceIds }) => new Set(workspaceIds).size === workspaceIds.length, {
    message: 'saved-layout workspace IDs must be unique'
  })
export const layoutDeleteParamsSchema = z.strictObject({
  layoutId: uuidSchema,
  ...idempotentRevisionShape
})
export const layoutApplyParamsSchema = z.strictObject({
  layoutId: uuidSchema,
  ...idempotentRevisionShape
})
export const layoutExportParamsSchema = layoutGetParamsSchema
export const layoutExportResultSchema = z.strictObject({ envelope: layoutExportEnvelopeSchema })
export const layoutImportParamsSchema = z.strictObject({
  layoutId: uuidSchema,
  envelope: layoutExportEnvelopeSchema,
  ...idempotentRevisionShape
})
export const layoutMutationResultSchema = z.strictObject({ revision: revisionSchema })
export const savedLayoutsChangedDataSchema = z.strictObject({
  revision: revisionSchema,
  reason: z.literal('layoutsChanged')
})
export const savedLayoutsChangedEventSchema = z
  .strictObject({
    event: z.literal('layout.changed'),
    revision: revisionSchema,
    data: savedLayoutsChangedDataSchema
  })
  .refine(({ revision, data }) => revision === data.revision, {
    message: 'saved-layout event envelope and data revisions must match'
  })

export const workspaceUpdateParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  name: normalizedString(128).optional(),
  description: nullableDescriptionUpdateSchema.optional(),
  color: nullableColorUpdateSchema.optional(),
  workingDirectory: absolutePathSchema.optional()
})

export const tabUpdateParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  tabId: uuidSchema,
  title: titleSchema.optional(),
  customTitle: nullableTitleUpdateSchema.optional()
})

export const paneSplitParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  targetPaneId: uuidSchema,
  axis: z.enum(['horizontal', 'vertical']),
  ratio: ratioSchema,
  placement: z.enum(['before', 'after']),
  content: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('newTerminal'), launch: terminalLaunchRequestSchema }),
    z.strictObject({
      kind: z.literal('newBrowser'),
      url: z.string().refine(isSafeExternalUrl, {
        message: 'unsafe or non-canonical browser URL'
      }),
      profilePartition: browserPartitionSchema.optional()
    }),
    z.strictObject({ kind: z.literal('existingTab'), tabId: uuidSchema })
  ])
})

export const workspaceSelectParamsSchema = z.strictObject({ workspaceId: uuidSchema })
export const workspaceMoveParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  destinationIndex: uint32Schema
})
export const workspaceCloseParamsSchema = workspaceSelectParamsSchema

export const paneFocusParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  paneId: uuidSchema
})
export const paneResizeParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  splitId: uuidSchema,
  ratio: ratioSchema
})
export const paneCloseParamsSchema = paneFocusParamsSchema
export const paneMoveTabParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  tabId: uuidSchema,
  destinationPaneId: uuidSchema,
  destinationIndex: uint32Schema
})

export const tabOpenTerminalParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  destinationIndex: uint32Schema.optional(),
  launch: terminalLaunchRequestSchema
})
export const tabOpenBrowserParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  destinationIndex: uint32Schema.optional(),
  metadata: browserPlaceholderMetadataSchema,
  profilePartition: browserPartitionSchema.optional()
})
export const browserNavigateParamsSchema = z.strictObject({
  browserSessionId: uuidSchema,
  url: z.string().refine(isSafeExternalUrl, { message: 'unsafe or non-canonical browser URL' }),
  expectedStateRevision: revisionSchema,
  correlationId: browserCorrelationSchema
})
const browserActionParamsSchema = z.strictObject({
  browserSessionId: uuidSchema,
  expectedStateRevision: revisionSchema,
  correlationId: browserCorrelationSchema
})
export const browserBackParamsSchema = browserActionParamsSchema
export const browserForwardParamsSchema = browserActionParamsSchema
export const browserReloadParamsSchema = browserActionParamsSchema
export const browserStopParamsSchema = browserActionParamsSchema
export const browserOpenDevToolsParamsSchema = browserActionParamsSchema
export const browserObserveParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  tabId: uuidSchema,
  state: browserSessionStateSchema
})
export const tabSelectParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  tabId: uuidSchema
})
export const tabMoveParamsSchema = z.strictObject({
  workspaceId: uuidSchema,
  tabId: uuidSchema,
  destinationPaneId: uuidSchema,
  destinationIndex: uint32Schema
})
export const tabCloseParamsSchema = tabSelectParamsSchema

export const terminalRestartParamsSchema = tabSelectParamsSchema

export const shortcutOverrideStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('default') }),
  z.strictObject({ kind: z.literal('set'), shortcut: shortcutSchema }),
  z.strictObject({ kind: z.literal('cleared') })
])
export const shortcutSettingSchema = z
  .strictObject({
    commandId: commandIdSchema,
    defaultShortcut: shortcutSchema,
    overrideState: shortcutOverrideStateSchema,
    effectiveShortcut: shortcutSchema.nullable()
  })
  .superRefine((setting, context) => {
    const expected =
      setting.overrideState.kind === 'default'
        ? setting.defaultShortcut
        : setting.overrideState.kind === 'set'
          ? setting.overrideState.shortcut
          : null
    if (setting.effectiveShortcut !== expected) {
      context.addIssue({
        code: 'custom',
        message: 'effective shortcut does not match its default or override state'
      })
    }
  })
export const settingsGetResultSchema = z
  .strictObject({
    revision: revisionSchema,
    shortcuts: z.array(shortcutSettingSchema),
    notifications: notificationSettingsSchema
  })
  .superRefine((settings, context) => {
    if (settings.shortcuts.length !== COMMAND_CATALOG.length) {
      context.addIssue({
        code: 'custom',
        message: 'settings must contain the complete command catalog'
      })
      return
    }
    for (const [index, [commandId, defaultShortcut]] of COMMAND_CATALOG.entries()) {
      const setting = settings.shortcuts[index]
      if (setting?.commandId !== commandId || setting.defaultShortcut !== defaultShortcut) {
        context.addIssue({
          code: 'custom',
          message: 'settings command catalog is incomplete, altered, or out of order'
        })
        return
      }
    }
  })
export const settingsUpdateParamsSchema = z
  .strictObject({
    shortcutOverrides: z.array(shortcutOverrideSchema).optional(),
    notifications: notificationSettingsSchema.optional()
  })
  .superRefine(({ shortcutOverrides, notifications }, context) => {
    if (shortcutOverrides === undefined && notifications === undefined) {
      context.addIssue({ code: 'custom', message: 'settings update must not be empty' })
    }
    if (shortcutOverrides === undefined) return
    const ids = shortcutOverrides.map(({ commandId }) => commandId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'shortcut override command ids must be unique' })
    }
  })
export const settingsResetKeyParamsSchema = z.strictObject({ commandId: commandIdSchema })

export const mutationResultSchema = z
  .strictObject({
    revision: revisionSchema,
    snapshot: applicationSnapshotSchema
  })
  .refine(({ revision, snapshot }) => revision === snapshot.revision, {
    message: 'mutation result and snapshot revisions must match'
  })

export const mutationResponseEnvelopeSchema = z
  .strictObject({
    id: z.string(),
    ok: z.literal(true),
    revision: revisionSchema,
    result: mutationResultSchema
  })
  .refine(({ revision, result }) => revision === result.revision, {
    message: 'mutation envelope and result revisions must match'
  })

const revisionEventDataSchema = z.strictObject({
  revision: revisionSchema,
  workspaceIds: z.array(uuidSchema),
  paneIds: z.array(uuidSchema),
  tabIds: z.array(uuidSchema),
  commandIds: z.array(commandIdSchema),
  reason: normalizedString(256)
})

export const notificationCreatedEventSchema = z.strictObject({
  notification: notificationSnapshotSchema
})

export const notificationChangedEventSchema = z.strictObject({
  revision: revisionSchema,
  notificationIds: z.array(uuidSchema).refine((ids) => new Set(ids).size === ids.length),
  workspaceIds: z.array(uuidSchema).refine((ids) => new Set(ids).size === ids.length),
  reason: notificationTextSchema(256)
})

export const browserChangedEventSchema = z.strictObject({
  state: browserSessionStateSchema
})

const windowLabelSchema = normalizedString(128, true).refine(
  (value) => !hasControlCharacter(value),
  { message: 'window label must not contain control characters' }
)
const multiWindowMutationTokenSchema = z.strictObject({
  expectedRevision: revisionSchema,
  idempotencyEpoch: uuidSchema,
  idempotencyKey: uuidSchema
})
const windowRevisionPreconditionSchema = z.strictObject({
  windowId: uuidSchema,
  expectedRevision: revisionSchema
})

export const windowHostingStateSchema = z.enum(['hosted', 'unhosted', 'closing'])
export const windowClosePolicySchema = z.enum(['rehome', 'closeWorkspaces'])
export const multiWindowErrorCodeSchema = z.enum([
  'capability_unavailable',
  'stale_revision',
  'stale_window_revision',
  'idempotency_conflict',
  'idempotency_expired',
  'source_not_found',
  'target_not_found',
  'placement_required',
  'provider_unavailable',
  'provider_ineligible',
  'provider_backpressure',
  'provider_lease_expired',
  'provider_epoch_mismatch',
  'window_unhosted',
  'transfer_conflict',
  'transfer_canceled',
  'cancellation_not_guaranteed',
  'policy_denied',
  'resource_limit'
])
export const multiWindowChangeReasonSchema = z.enum([
  'windowCreated',
  'windowClosed',
  'windowFocused',
  'windowRehomed',
  'hostingChanged',
  'tabDuplicated',
  'tabMoved',
  'tabDetached',
  'tabClosed',
  'tabReopened',
  'focusHistoryNavigated',
  'providerChanged',
  'resyncRequired'
])

export const windowDefaultTabDestinationSchema = z.strictObject({
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  destinationIndex: uint32Schema.max(1024)
})
export const windowPlacementSnapshotSchema = z
  .strictObject({
    windowId: uuidSchema,
    label: windowLabelSchema,
    workspaceIds: z.array(uuidSchema).min(1).max(128),
    focusedWorkspaceId: uuidSchema,
    hostingState: windowHostingStateSchema,
    defaultTabDestination: windowDefaultTabDestinationSchema,
    revision: revisionSchema
  })
  .refine(
    ({ workspaceIds, focusedWorkspaceId, defaultTabDestination }) =>
      new Set(workspaceIds).size === workspaceIds.length &&
      workspaceIds.includes(focusedWorkspaceId) &&
      defaultTabDestination.workspaceId === focusedWorkspaceId,
    { message: 'window workspace ownership or focus is invalid' }
  )

export const windowListResultSchema = z
  .strictObject({
    revision: revisionSchema,
    idempotencyEpoch: uuidSchema,
    windows: z.array(windowPlacementSnapshotSchema).min(1).max(16),
    focusedWindowId: uuidSchema
  })
  .superRefine(({ windows, focusedWindowId }, context) => {
    const windowIds = windows.map(({ windowId }) => windowId)
    const workspaceIds = windows.flatMap(({ workspaceIds }) => workspaceIds)
    if (
      new Set(windowIds).size !== windowIds.length ||
      new Set(workspaceIds).size !== workspaceIds.length ||
      !windowIds.includes(focusedWindowId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'window topology has duplicate ownership or focus'
      })
    }
  })

export const windowCreateParamsSchema = z.strictObject({
  mutation: multiWindowMutationTokenSchema,
  label: windowLabelSchema,
  workspaceId: uuidSchema,
  sourceWindow: windowRevisionPreconditionSchema
})
export const windowCloseParamsSchema = z
  .strictObject({
    mutation: multiWindowMutationTokenSchema,
    window: windowRevisionPreconditionSchema,
    policy: windowClosePolicySchema,
    rehomeTarget: windowRevisionPreconditionSchema.optional()
  })
  .refine(({ policy, rehomeTarget }) => (policy === 'rehome') === (rehomeTarget !== undefined), {
    message: 'rehome target must be present exactly for rehome policy'
  })
  .refine(({ window, rehomeTarget }) => rehomeTarget?.windowId !== window.windowId, {
    message: 'window cannot rehome to itself'
  })
export const windowFocusParamsSchema = z.strictObject({
  mutation: multiWindowMutationTokenSchema,
  window: windowRevisionPreconditionSchema
})
export const windowMutationResultSchema = z.strictObject({
  revision: revisionSchema,
  idempotencyEpoch: uuidSchema,
  window: windowPlacementSnapshotSchema,
  replayed: z.boolean()
})
export const windowCloseResultSchema = z.strictObject({
  revision: revisionSchema,
  idempotencyEpoch: uuidSchema,
  closedWindowId: uuidSchema,
  rehomeTarget: windowPlacementSnapshotSchema.optional(),
  replayed: z.boolean()
})
export const windowStateGetForParamsSchema = z.strictObject({ windowId: uuidSchema })
export const windowStateGetForResultSchema = z.strictObject({
  windowId: uuidSchema,
  state: windowStateSnapshotSchema.optional()
})
export const windowStateUpdateForParamsSchema = z.strictObject({
  windowId: uuidSchema,
  state: windowStateSnapshotSchema
})

export const exactTabPlacementSchema = z.strictObject({
  windowId: uuidSchema,
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  destinationIndex: uint32Schema.max(1024),
  expectedWindowRevision: revisionSchema
})
export const tabPlacementSnapshotSchema = z.strictObject({
  windowId: uuidSchema,
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  index: uint32Schema.max(1024),
  windowRevision: revisionSchema
})
export const tabSourceSchema = z.strictObject({
  windowId: uuidSchema,
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  tabId: uuidSchema,
  expectedWindowRevision: revisionSchema
})
const tabTransferMutationShape = {
  mutation: multiWindowMutationTokenSchema,
  source: tabSourceSchema,
  target: exactTabPlacementSchema
} as const
export const tabDuplicateParamsSchema = z.strictObject(tabTransferMutationShape)
export const tabMoveExactParamsSchema = z.strictObject(tabTransferMutationShape)
export const tabDetachParamsSchema = z.strictObject({
  mutation: multiWindowMutationTokenSchema,
  source: tabSourceSchema,
  windowLabel: windowLabelSchema
})
export const tabCloseAdvancedParamsSchema = z.strictObject({
  mutation: multiWindowMutationTokenSchema,
  source: tabSourceSchema
})
export const tabReopenParamsSchema = z.strictObject({
  mutation: multiWindowMutationTokenSchema,
  closedItemId: uuidSchema,
  target: exactTabPlacementSchema
})
export const runtimeOwnershipKindSchema = z.enum(['terminal', 'browser'])
export const advancedTabMutationResultSchema = z.strictObject({
  revision: revisionSchema,
  idempotencyEpoch: uuidSchema,
  tabId: uuidSchema,
  runtimeSessionId: uuidSchema.optional(),
  ownershipKind: runtimeOwnershipKindSchema,
  placement: tabPlacementSnapshotSchema,
  closedItemId: uuidSchema.optional(),
  transferEpoch: revisionSchema,
  replayed: z.boolean()
})
export const advancedTabCloseResultSchema = z.strictObject({
  revision: revisionSchema,
  idempotencyEpoch: uuidSchema,
  closedTabId: uuidSchema,
  closedItemId: uuidSchema,
  replayed: z.boolean()
})

export const closedItemKindSchema = z.enum(['tab', 'workspace'])
export const closedContentKindSchema = z.enum(['terminal', 'browser'])
export const closedItemSnapshotSchema = z.strictObject({
  closedItemId: uuidSchema,
  itemKind: closedItemKindSchema,
  priorItemId: uuidSchema,
  contentKind: closedContentKindSchema,
  title: normalizedString(160),
  closedAtMs: revisionSchema,
  restored: z.boolean()
})
export const closedItemListResultSchema = z
  .strictObject({
    revision: revisionSchema,
    items: z.array(closedItemSnapshotSchema).max(100)
  })
  .refine(
    ({ items }) => new Set(items.map(({ closedItemId }) => closedItemId)).size === items.length,
    {
      message: 'recently-closed IDs must be unique'
    }
  )
export const closedItemGetParamsSchema = z.strictObject({ closedItemId: uuidSchema })
export const closedItemGetResultSchema = z.strictObject({
  revision: revisionSchema,
  item: closedItemSnapshotSchema
})

export const focusNavigationDirectionSchema = z.enum(['back', 'forward'])
export const focusHistoryNavigateParamsSchema = z.strictObject({
  mutation: multiWindowMutationTokenSchema,
  direction: focusNavigationDirectionSchema
})
export const focusTargetSnapshotSchema = z.strictObject({
  windowId: uuidSchema,
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  tabId: uuidSchema
})
export const focusHistoryNavigateResultSchema = z.strictObject({
  revision: revisionSchema,
  idempotencyEpoch: uuidSchema,
  target: focusTargetSnapshotSchema,
  replayed: z.boolean()
})

export const multiWindowChangedEventSchema = z.strictObject({
  event: z.literal('window.topologyChanged'),
  revision: revisionSchema,
  idempotencyEpoch: uuidSchema,
  windowIds: z
    .array(uuidSchema)
    .max(16)
    .refine((ids) => new Set(ids).size === ids.length),
  reason: multiWindowChangeReasonSchema
})
export const tabOwnershipTransferredEventSchema = z.strictObject({
  event: z.literal('tab.ownershipTransferred'),
  revision: revisionSchema,
  transferEpoch: revisionSchema,
  tabId: uuidSchema,
  runtimeSessionId: uuidSchema,
  ownershipKind: runtimeOwnershipKindSchema,
  source: tabPlacementSnapshotSchema,
  target: tabPlacementSnapshotSchema,
  reason: multiWindowChangeReasonSchema
})
export const multiWindowEventSchema = z.discriminatedUnion('event', [
  multiWindowChangedEventSchema,
  tabOwnershipTransferredEventSchema
])

/** Service wire events use the common revision envelope; renderer IPC uses the flat payload. */
export const multiWindowProtocolEventSchema = z
  .discriminatedUnion('event', [
    z.strictObject({
      event: z.literal('window.topologyChanged'),
      revision: revisionSchema,
      data: multiWindowChangedEventSchema
    }),
    z.strictObject({
      event: z.literal('tab.ownershipTransferred'),
      revision: revisionSchema,
      data: tabOwnershipTransferredEventSchema
    })
  ])
  .refine(({ event, revision, data }) => event === data.event && revision === data.revision, {
    message: 'multi-window event envelope and data must match'
  })

export const desktopProviderWindowClaimSchema = z.strictObject({
  windowId: uuidSchema,
  generation: revisionSchema
})
const desktopProviderIdentitySchema = z.strictObject({
  providerId: uuidSchema,
  providerEpoch: revisionSchema,
  leaseId: uuidSchema
})
const desktopProviderWindowClaimsSchema = z
  .array(desktopProviderWindowClaimSchema)
  .max(16)
  .refine((claims) => new Set(claims.map(({ windowId }) => windowId)).size === claims.length)
const providerCapabilitySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9.-]+$/)
export const desktopProviderRegisterParamsSchema = z.strictObject({
  bootstrapProof: z
    .string()
    .min(32)
    .max(256)
    .refine((value) => !/\s/u.test(value)),
  instanceId: uuidSchema,
  capabilities: z
    .array(providerCapabilitySchema)
    .min(1)
    .max(16)
    .refine((items) => new Set(items).size === items.length),
  windows: desktopProviderWindowClaimsSchema
})
export const desktopProviderRegistrationSchema = z.strictObject({
  providerId: uuidSchema,
  providerEpoch: revisionSchema,
  leaseId: uuidSchema,
  leaseExpiresAtMs: revisionSchema,
  registrationSequence: revisionSchema,
  heartbeatIntervalMs: z.number().int().min(100).max(5_000)
})
export const desktopProviderHeartbeatParamsSchema = z.strictObject({
  providerId: uuidSchema,
  providerEpoch: revisionSchema,
  leaseId: uuidSchema,
  windows: desktopProviderWindowClaimsSchema
})
export const desktopProviderHeartbeatResultSchema = z.strictObject({
  leaseExpiresAtMs: revisionSchema
})
export const desktopProviderUnregisterParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema
})
export const windowBindParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema,
  window: desktopProviderWindowClaimSchema
})
export const windowBindResultSchema = z.strictObject({
  window: windowPlacementSnapshotSchema
})
export const cliWindowBindParamsSchema = z.strictObject({ windowId: uuidSchema })
export const desktopProviderOperationKindSchema = z.enum([
  'createWindow',
  'closeWindow',
  'focusWindow',
  'attachOwnership',
  'detachOwnership',
  'recoverOwnership'
])
export const browserOwnershipTransferDescriptorSchema = z.strictObject({
  browserSessionId: uuidSchema,
  url: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => {
      try {
        const parsed = new URL(value)
        return (
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.username === '' &&
          parsed.password === ''
        )
      } catch {
        return false
      }
    }),
  title: normalizedString(256),
  profilePartition: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  stateRevision: revisionSchema,
  lifecycleId: uuidSchema
})
export const desktopProviderRequestSchema = z
  .strictObject({
    requestId: uuidSchema,
    correlationId: uuidSchema,
    attemptEpoch: revisionSchema,
    operation: desktopProviderOperationKindSchema,
    target: desktopProviderWindowClaimSchema,
    source: desktopProviderWindowClaimSchema.optional(),
    tabId: uuidSchema.optional(),
    runtimeSessionId: uuidSchema.optional(),
    transferEpoch: revisionSchema.optional(),
    workspaceId: uuidSchema.optional(),
    paneId: uuidSchema.optional(),
    ownershipKind: runtimeOwnershipKindSchema.optional(),
    browser: browserOwnershipTransferDescriptorSchema.optional()
  })
  .superRefine(
    (
      {
        operation,
        target,
        source,
        tabId,
        runtimeSessionId,
        transferEpoch,
        workspaceId,
        paneId,
        ownershipKind,
        browser
      },
      context
    ) => {
      const resourceCount = [
        tabId,
        runtimeSessionId,
        transferEpoch,
        workspaceId,
        paneId,
        ownershipKind
      ].filter((value) => value !== undefined).length
      const ordinaryResourceOperation =
        operation === 'attachOwnership' || operation === 'detachOwnership'
      const recoveryOperation = operation === 'recoverOwnership'
      const consistent = ordinaryResourceOperation
        ? resourceCount === 6 && source === undefined
        : recoveryOperation
          ? resourceCount === 6 && source !== undefined && source.windowId !== target.windowId
          : resourceCount === 0 && !browser && source === undefined
      const ownershipConsistent =
        ownershipKind === 'terminal'
          ? !browser
          : ownershipKind === 'browser'
            ? browser !== undefined && browser.browserSessionId === runtimeSessionId
            : !browser
      if (!consistent || !ownershipConsistent) {
        context.addIssue({
          code: 'custom',
          message: 'provider operation resource correlation is incomplete or irrelevant'
        })
      }
    }
  )
export const desktopProviderPollParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema,
  timeoutMs: z.number().int().min(0).max(5_000)
})
export const desktopProviderPollResultSchema = z.strictObject({
  request: desktopProviderRequestSchema.optional()
})
export const desktopProviderCompletionStatusSchema = z.enum(['succeeded', 'failed', 'canceled'])
const providerErrorCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/)
export const desktopProviderAcknowledgeParamsSchema = z
  .strictObject({
    identity: desktopProviderIdentitySchema,
    requestId: uuidSchema,
    correlationId: uuidSchema,
    attemptEpoch: revisionSchema,
    status: desktopProviderCompletionStatusSchema,
    errorCode: providerErrorCodeSchema.optional()
  })
  .refine(({ status, errorCode }) => (status === 'failed') === (errorCode !== undefined), {
    message: 'failed acknowledgement requires an error code; other statuses forbid one'
  })
export const desktopProviderCancelParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema,
  requestId: uuidSchema,
  correlationId: uuidSchema,
  attemptEpoch: revisionSchema
})

const namespacedActionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/u)
const localizedActionTitleKeySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/u)
const actionCategorySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/u)
const actionCapabilitySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9.-]+$/u)
const actionVersionSchema = z.number().int().min(1).max(0xffff_ffff)
const actionJsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.string(),
    z.number().finite(),
    z.array(actionJsonValueSchema),
    z.record(z.string(), actionJsonValueSchema)
  ])
)
const serializedJsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength
const boundedActionObject = (maximum: number) =>
  z
    .record(z.string(), actionJsonValueSchema)
    .refine((value) => serializedJsonBytes(value) <= maximum, {
      message: `serialized action payload exceeds ${maximum} bytes`
    })
const actionParametersSchema = boundedActionObject(64 * 1024)
const actionResultSchema = boundedActionObject(64 * 1024)

export const actionOwnerSchema = z.enum(['service', 'desktop'])
export const actionAuthorizationClassSchema = z.literal('owner')
export const actionInteractionClassSchema = z.enum([
  'headless',
  'desktopInteraction',
  'confirmationRequired'
])
export const actionErrorCodeSchema = z.enum([
  'capability_unavailable',
  'action_not_found',
  'action_version_mismatch',
  'cursor_invalid',
  'cursor_expired',
  'invalid_parameters',
  'invalid_result',
  'unauthorized',
  'policy_denied',
  'target_required',
  'target_not_found',
  'target_stale',
  'provider_unavailable',
  'provider_ineligible',
  'provider_backpressure',
  'provider_lease_expired',
  'provider_epoch_mismatch',
  'idempotency_conflict',
  'idempotency_expired',
  'resource_limit',
  'confirmation_required',
  'cancellation_not_guaranteed',
  'canceled',
  'expired',
  'execution_failed',
  'correlation_mismatch',
  'invalid_state'
])
export const actionInvocationStateSchema = z.enum([
  'accepted',
  'leased',
  'dispatched',
  'startClaimed',
  'startGranted',
  'acknowledged',
  'failed',
  'canceled',
  'expired'
])
export const actionTerminalCodeSchema = z.enum([
  'succeeded',
  'failed',
  'canceled',
  'expired',
  'interrupted'
])
export const desktopActionCompletionStatusSchema = z.enum(['succeeded', 'failed', 'canceled'])
export const desktopActionStartDecisionSchema = z.enum(['granted', 'canceled', 'expired'])

export const actionLimitsSchema = z.strictObject({
  maxParameterBytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024),
  maxResultBytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(5 * 60 * 1000)
})
export const actionDefinitionSchema = z
  .strictObject({
    actionId: namespacedActionIdSchema,
    actionVersion: actionVersionSchema,
    localizedTitleKey: localizedActionTitleKeySchema,
    displayTitle: configurationTextSchema(120).optional(),
    defaultShortcut: shortcutSchema.optional(),
    category: actionCategorySchema,
    owner: actionOwnerSchema,
    parameterSchemaVersion: actionVersionSchema,
    resultSchemaVersion: actionVersionSchema,
    authorizationClass: actionAuthorizationClassSchema,
    interactionClass: actionInteractionClassSchema,
    requiredDesktopCapability: actionCapabilitySchema.optional(),
    limits: actionLimitsSchema
  })
  .superRefine((definition, context) => {
    if ((definition.owner === 'desktop') !== (definition.requiredDesktopCapability !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'desktop actions require a capability and service actions forbid one'
      })
    }
    if (serializedJsonBytes(definition) > 8 * 1024) {
      context.addIssue({
        code: 'custom',
        message: 'serialized action definition exceeds 8192 bytes'
      })
    }
  })
const actionCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+$/u)
export const actionListParamsSchema = z.strictObject({
  cursor: actionCursorSchema.optional(),
  limit: z.number().int().min(1).max(64)
})
export const actionListResultSchema = z
  .strictObject({
    registryRevision: revisionSchema,
    idempotencyEpoch: uuidSchema,
    definitions: z.array(actionDefinitionSchema).max(64),
    nextCursor: actionCursorSchema.optional()
  })
  .superRefine(({ definitions, nextCursor }, context) => {
    const identities = definitions.map(
      ({ actionId, actionVersion }) => `${actionId}@${actionVersion}`
    )
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: 'custom', message: 'duplicate action definitions' })
    }
    if (nextCursor !== undefined && definitions.length === 0) {
      context.addIssue({ code: 'custom', message: 'cursor requires a non-empty action page' })
    }
  })
export const actionInvocationTargetSchema = z.strictObject({
  windowId: uuidSchema,
  windowGeneration: revisionSchema.min(1)
})
export const actionIdempotencySchema = z.strictObject({
  epoch: uuidSchema,
  key: uuidSchema
})
export const actionInvokeParamsSchema = z.strictObject({
  actionId: namespacedActionIdSchema,
  actionVersion: actionVersionSchema,
  parameters: actionParametersSchema,
  target: actionInvocationTargetSchema.optional(),
  idempotency: actionIdempotencySchema,
  correlationId: uuidSchema
})
export const actionInvocationSnapshotSchema = z
  .strictObject({
    invocationId: uuidSchema,
    correlationId: uuidSchema,
    state: actionInvocationStateSchema,
    terminalCode: actionTerminalCodeSchema.optional(),
    result: actionResultSchema.optional(),
    errorCode: actionErrorCodeSchema.optional(),
    updatedAtMs: revisionSchema
  })
  .superRefine(({ state, terminalCode, result, errorCode }, context) => {
    const consistent =
      state === 'acknowledged'
        ? terminalCode === 'succeeded' && result !== undefined && errorCode === undefined
        : state === 'failed'
          ? (terminalCode === 'failed' || terminalCode === 'interrupted') &&
            result === undefined &&
            errorCode !== undefined
          : state === 'canceled'
            ? terminalCode === 'canceled' && result === undefined && errorCode === undefined
            : state === 'expired'
              ? terminalCode === 'expired' && result === undefined && errorCode === undefined
              : terminalCode === undefined && result === undefined && errorCode === undefined
    if (!consistent) {
      context.addIssue({
        code: 'custom',
        message: 'inconsistent action invocation terminal fields'
      })
    }
  })
export const actionInvokeResultSchema = z.strictObject({
  invocation: actionInvocationSnapshotSchema
})
export const actionCancelParamsSchema = z.strictObject({
  invocationId: uuidSchema,
  correlationId: uuidSchema
})
export const actionCancelResultSchema = z.strictObject({
  invocation: actionInvocationSnapshotSchema
})
export const actionInvocationChangedEventSchema = z.strictObject({
  event: z.literal('action.invocationChanged'),
  invocationId: uuidSchema,
  correlationId: uuidSchema,
  state: actionInvocationStateSchema,
  updatedAtMs: revisionSchema
})
export const actionRegistryChangeReasonSchema = z.enum(['definitionsChanged', 'resyncRequired'])
export const actionRegistryChangedEventSchema = z.strictObject({
  event: z.literal('action.registryChanged'),
  registryRevision: revisionSchema,
  reason: actionRegistryChangeReasonSchema
})
export const desktopActionExecutionRequestSchema = z.strictObject({
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  invocationId: uuidSchema,
  correlationId: uuidSchema,
  attemptEpoch: revisionSchema.min(1),
  actionId: namespacedActionIdSchema,
  actionVersion: actionVersionSchema,
  target: actionInvocationTargetSchema,
  parameters: actionParametersSchema,
  expiresAtMs: revisionSchema
})
export const desktopActionPollParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  timeoutMs: z.number().int().min(0).max(5_000)
})
export const desktopActionPollResultSchema = z.strictObject({
  request: desktopActionExecutionRequestSchema.optional()
})
const lowercaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
export const projectActionExecutableClassSchema = z.enum(['projectRelative', 'approvedName'])
export const projectActionConfirmationChallengeSchema = z.strictObject({
  invocationId: uuidSchema,
  nonce: uuidSchema,
  challenge: lowercaseSha256Schema,
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  target: actionInvocationTargetSchema,
  confirmationDefinitionSha256: lowercaseSha256Schema,
  actionId: namespacedActionIdSchema,
  displayTitle: configurationTextSchema(120),
  executableClass: projectActionExecutableClassSchema,
  argumentCount: z.number().int().min(0).max(64),
  projectLabel: configurationTextSchema(80),
  expiresAtMs: revisionSchema
})
export const projectActionConfirmationPollParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  timeoutMs: z.number().int().min(0).max(5_000)
})
export const projectActionConfirmationPollResultSchema = z.strictObject({
  challenge: projectActionConfirmationChallengeSchema.optional()
})
export const projectActionConfirmationDecisionSchema = z.enum(['confirmed', 'denied'])
export const projectActionConfirmationRespondParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  invocationId: uuidSchema,
  nonce: uuidSchema,
  challenge: lowercaseSha256Schema,
  target: actionInvocationTargetSchema,
  confirmationDefinitionSha256: lowercaseSha256Schema,
  decision: projectActionConfirmationDecisionSchema
})
export const projectActionConfirmationRespondResultSchema = z.strictObject({
  invocationId: uuidSchema,
  decision: projectActionConfirmationDecisionSchema,
  acceptedAtMs: revisionSchema
})
export const desktopActionStartClaimParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  invocationId: uuidSchema,
  correlationId: uuidSchema,
  attemptEpoch: revisionSchema.min(1),
  actionId: namespacedActionIdSchema,
  actionVersion: actionVersionSchema,
  target: actionInvocationTargetSchema
})
export const desktopActionStartClaimResultSchema = z
  .strictObject({
    invocationId: uuidSchema,
    correlationId: uuidSchema,
    attemptEpoch: revisionSchema.min(1),
    decision: desktopActionStartDecisionSchema,
    terminalCode: actionTerminalCodeSchema.optional(),
    grantedAtMs: revisionSchema.optional()
  })
  .refine(
    ({ decision, terminalCode, grantedAtMs }) =>
      decision === 'granted'
        ? terminalCode === undefined && grantedAtMs !== undefined
        : decision === 'canceled'
          ? terminalCode === 'canceled' && grantedAtMs === undefined
          : terminalCode === 'expired' && grantedAtMs === undefined,
    { message: 'inconsistent desktop action start decision fields' }
  )
export const desktopActionAcknowledgeParamsSchema = z
  .strictObject({
    identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
    invocationId: uuidSchema,
    correlationId: uuidSchema,
    attemptEpoch: revisionSchema.min(1),
    actionId: namespacedActionIdSchema,
    actionVersion: actionVersionSchema,
    target: actionInvocationTargetSchema,
    status: desktopActionCompletionStatusSchema,
    result: actionResultSchema.optional(),
    errorCode: actionErrorCodeSchema.optional()
  })
  .refine(
    ({ status, result, errorCode }) =>
      status === 'succeeded'
        ? result !== undefined && errorCode === undefined
        : status === 'failed'
          ? result === undefined && errorCode !== undefined
          : result === undefined && errorCode === undefined,
    { message: 'inconsistent desktop action acknowledgement fields' }
  )
export const desktopActionAcknowledgeResultSchema = z.strictObject({
  invocation: actionInvocationSnapshotSchema
})

const automationEpochSchema = revisionSchema
const automationPositiveEpochSchema = revisionSchema.min(1)
const automationSelectorSchema = z
  .string()
  .min(1)
  .refine((value) => [...value].length <= 1_024 && !hasControlCharacter(value), {
    message: 'invalid automation selector'
  })
const automationProfileKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const automationSafeUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if ([...value].length > 2_048 || hasControlCharacter(value)) return false
    try {
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname !== '' &&
        url.username === '' &&
        url.password === ''
      )
    } catch {
      return false
    }
  }, 'automation URL must be credential-free HTTP or HTTPS')

export const browserAutomationSessionModeSchema = z.enum(['ephemeral', 'attach'])
export const browserAutomationSessionStateSchema = z.enum([
  'creating',
  'ready',
  'destroying',
  'destroyed',
  'failed',
  'expired'
])
export const browserAutomationOperationStateSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'expired',
  'interrupted',
  'resultExpired'
])
export const browserAutomationErrorCodeSchema = z.enum([
  'capability_unavailable',
  'session_not_found',
  'session_limit',
  'session_expired',
  'session_generation_mismatch',
  'stale_navigation',
  'target_required',
  'target_not_found',
  'target_stale',
  'provider_unavailable',
  'provider_ineligible',
  'provider_lease_expired',
  'provider_epoch_mismatch',
  'automation_backpressure',
  'invalid_operation',
  'invalid_selector',
  'unsafe_url',
  'policy_denied',
  'resource_limit',
  'timeout',
  'canceled',
  'interrupted',
  'result_expired',
  'idempotency_conflict',
  'idempotency_expired'
])
export const browserAutomationTargetBindingSchema = z.strictObject({
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  tabId: uuidSchema,
  browserSessionId: uuidSchema,
  browserLifecycleId: uuidSchema,
  window: actionInvocationTargetSchema
})
export const browserAutomationSessionCreateParamsSchema = z
  .strictObject({
    mode: browserAutomationSessionModeSchema,
    profileKey: automationProfileKeySchema,
    target: browserAutomationTargetBindingSchema.optional(),
    idempotency: actionIdempotencySchema,
    correlationId: uuidSchema
  })
  .refine(({ mode, target }) => (mode === 'attach') === (target !== undefined), {
    message: 'attach requires one exact target and ephemeral forbids one'
  })
export const browserAutomationSessionSnapshotSchema = z.strictObject({
  automationSessionId: uuidSchema,
  generation: automationPositiveEpochSchema,
  navigationEpoch: automationEpochSchema,
  mode: browserAutomationSessionModeSchema,
  state: browserAutomationSessionStateSchema,
  profileKey: automationProfileKeySchema,
  target: browserAutomationTargetBindingSchema,
  createdAtMs: revisionSchema,
  updatedAtMs: revisionSchema,
  expiresAtMs: revisionSchema
})
export const browserAutomationSessionCreateResultSchema = z.strictObject({
  session: browserAutomationSessionSnapshotSchema
})
export const browserAutomationSessionProvisionSchema = z
  .strictObject({
    automationSessionId: uuidSchema,
    generation: automationPositiveEpochSchema,
    mode: browserAutomationSessionModeSchema,
    profileKey: automationProfileKeySchema,
    requestedTarget: browserAutomationTargetBindingSchema.optional(),
    createdAtMs: revisionSchema,
    expiresAtMs: revisionSchema
  })
  .refine(
    ({ mode, requestedTarget, createdAtMs, expiresAtMs }) =>
      (mode === 'attach') === (requestedTarget !== undefined) && expiresAtMs > createdAtMs,
    { message: 'invalid automation session provision' }
  )
export const browserAutomationSessionResultSchema = z.strictObject({
  session: browserAutomationSessionSnapshotSchema
})
export const browserAutomationSessionListResultSchema = z.strictObject({
  sessions: z.array(browserAutomationSessionSnapshotSchema).max(128)
})
export const browserAutomationSessionParamsSchema = z.strictObject({
  automationSessionId: uuidSchema,
  generation: automationPositiveEpochSchema
})
export const browserAutomationWaitLifecycleSchema = z.enum([
  'domContentLoaded',
  'load',
  'networkIdle'
])
export const browserAutomationSelectorConditionSchema = z.enum([
  'attached',
  'visible',
  'hidden',
  'enabled'
])
export const browserAutomationWaitConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('lifecycle'), lifecycle: browserAutomationWaitLifecycleSchema }),
  z.strictObject({
    kind: z.literal('selector'),
    selector: automationSelectorSchema,
    condition: browserAutomationSelectorConditionSchema
  })
])
export const browserAutomationKeySchema = z.enum([
  'enter',
  'escape',
  'tab',
  'arrowUp',
  'arrowDown',
  'arrowLeft',
  'arrowRight',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'backspace',
  'delete',
  'space'
])
export const browserAutomationOperationSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('navigate'), url: automationSafeUrlSchema }),
    z.strictObject({ kind: z.literal('wait'), condition: browserAutomationWaitConditionSchema }),
    z.strictObject({
      kind: z.literal('query'),
      selector: automationSelectorSchema,
      limit: z.number().int().min(1).max(100)
    }),
    z.strictObject({ kind: z.literal('focus'), selector: automationSelectorSchema }),
    z.strictObject({ kind: z.literal('click'), selector: automationSelectorSchema }),
    z.strictObject({
      kind: z.literal('typeText'),
      selector: automationSelectorSchema,
      text: z
        .string()
        .refine(
          (value) => !value.includes('\0') && new TextEncoder().encode(value).length <= 48 * 1_024
        )
    }),
    z.strictObject({ kind: z.literal('key'), key: browserAutomationKeySchema }),
    z.strictObject({
      kind: z.literal('keyAt'),
      selector: automationSelectorSchema,
      key: browserAutomationKeySchema
    }),
    z
      .strictObject({
        kind: z.literal('screenshot'),
        width: z.number().int().min(1).max(4_096),
        height: z.number().int().min(1).max(4_096)
      })
      .refine(({ width, height }) => width * height <= 16_000_000, {
        message: 'screenshot pixel count exceeds its bound'
      })
  ])
  .refine((operation) => serializedJsonBytes(operation) <= 64 * 1_024, {
    message: 'automation operation exceeds its wire bound'
  })
export const browserAutomationOperationInvokeParamsSchema = z.strictObject({
  automationSessionId: uuidSchema,
  sessionGeneration: automationPositiveEpochSchema,
  navigationEpoch: automationEpochSchema,
  operationId: uuidSchema,
  attemptEpoch: automationPositiveEpochSchema,
  timeoutMs: z.number().int().min(1).max(120_000),
  operation: browserAutomationOperationSchema,
  idempotency: actionIdempotencySchema,
  correlationId: uuidSchema
})
export const browserAutomationElementTagSchema = z.enum([
  'button',
  'input',
  'textarea',
  'select',
  'link',
  'form',
  'image',
  'dialog',
  'generic'
])
export const browserAutomationElementSummarySchema = z.strictObject({
  index: z.number().int().min(0).max(99),
  tag: browserAutomationElementTagSchema,
  visible: z.boolean(),
  enabled: z.boolean(),
  focused: z.boolean(),
  editable: z.boolean()
})
export const browserAutomationScreenshotHandleSchema = z.strictObject({
  handleId: uuidSchema,
  width: z.number().int().min(1).max(4_096),
  height: z.number().int().min(1).max(4_096),
  byteLength: revisionSchema.min(1).max(16 * 1_024 * 1_024),
  mediaType: z.literal('image/png'),
  sha256: lowercaseSha256Schema,
  chunkCount: z.number().int().min(1).max(32),
  expiresAtMs: revisionSchema
})
export const browserAutomationOperationResultDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('empty') }),
  z.strictObject({ kind: z.literal('navigation'), navigationEpoch: automationEpochSchema }),
  z
    .strictObject({
      kind: z.literal('query'),
      matches: z.array(browserAutomationElementSummarySchema).max(100)
    })
    .refine(({ matches }) => serializedJsonBytes(matches) <= 16 * 1_024, {
      message: 'query result exceeds its wire bound'
    }),
  z.strictObject({ kind: z.literal('screenshot'), handle: browserAutomationScreenshotHandleSchema })
])
export const browserAutomationOperationSnapshotSchema = z
  .strictObject({
    automationSessionId: uuidSchema,
    sessionGeneration: automationPositiveEpochSchema,
    operationId: uuidSchema,
    correlationId: uuidSchema,
    attemptEpoch: automationPositiveEpochSchema,
    navigationEpoch: automationEpochSchema,
    state: browserAutomationOperationStateSchema,
    result: browserAutomationOperationResultDataSchema.optional(),
    errorCode: browserAutomationErrorCodeSchema.optional(),
    updatedAtMs: revisionSchema
  })
  .refine(
    ({ state, result, errorCode }) =>
      state === 'succeeded'
        ? result !== undefined && errorCode === undefined
        : ['failed', 'interrupted', 'resultExpired', 'canceled', 'expired'].includes(state)
          ? result === undefined && errorCode !== undefined
          : result === undefined && errorCode === undefined,
    { message: 'inconsistent automation operation terminal fields' }
  )
export const browserAutomationOperationInvokeResultSchema = z.strictObject({
  operation: browserAutomationOperationSnapshotSchema
})
export const browserAutomationOperationCancelParamsSchema = z.strictObject({
  automationSessionId: uuidSchema,
  sessionGeneration: automationPositiveEpochSchema,
  operationId: uuidSchema,
  correlationId: uuidSchema
})
export const browserAutomationScreenshotReadParamsSchema = z.strictObject({
  automationSessionId: uuidSchema,
  sessionGeneration: automationPositiveEpochSchema,
  handleId: uuidSchema,
  chunkIndex: z.number().int().min(0).max(31)
})
export const browserAutomationScreenshotReadResultSchema = z.strictObject({
  handleId: uuidSchema,
  chunkIndex: z.number().int().min(0).max(31),
  chunkCount: z.number().int().min(1).max(32),
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil((512 * 1_024) / 3) * 4)
    .refine((value) => isCanonicalBase64(value, 512 * 1_024), {
      message: 'screenshot chunk must be canonical bounded base64'
    }),
  sha256: lowercaseSha256Schema,
  expiresAtMs: revisionSchema
})
export const browserAutomationScreenshotReleaseParamsSchema = z.strictObject({
  automationSessionId: uuidSchema,
  sessionGeneration: automationPositiveEpochSchema,
  handleId: uuidSchema
})
export const browserAutomationScreenshotReleaseResultSchema = z.strictObject({
  released: z.boolean()
})
export const browserAutomationProviderPollParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  timeoutMs: z.number().int().min(0).max(30_000)
})
export const browserAutomationExecutionRequestSchema = z.strictObject({
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  target: actionInvocationTargetSchema,
  session: browserAutomationSessionSnapshotSchema,
  operation: browserAutomationOperationInvokeParamsSchema
})
export const browserAutomationProviderRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
    target: actionInvocationTargetSchema,
    provision: browserAutomationSessionProvisionSchema,
    operationId: uuidSchema,
    correlationId: uuidSchema,
    attemptEpoch: automationPositiveEpochSchema
  }),
  z.strictObject({
    kind: z.literal('destroy'),
    identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
    target: actionInvocationTargetSchema,
    session: browserAutomationSessionSnapshotSchema,
    operationId: uuidSchema,
    correlationId: uuidSchema,
    attemptEpoch: automationPositiveEpochSchema
  }),
  z.strictObject({ kind: z.literal('execute'), request: browserAutomationExecutionRequestSchema }),
  z.strictObject({
    kind: z.literal('cancel'),
    identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
    target: actionInvocationTargetSchema,
    automationSessionId: uuidSchema,
    sessionGeneration: automationPositiveEpochSchema,
    operationId: uuidSchema,
    correlationId: uuidSchema
  }),
  z.strictObject({
    kind: z.literal('screenshotRead'),
    identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
    target: actionInvocationTargetSchema,
    requestId: uuidSchema,
    correlationId: uuidSchema,
    params: browserAutomationScreenshotReadParamsSchema
  }),
  z.strictObject({
    kind: z.literal('screenshotRelease'),
    identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
    target: actionInvocationTargetSchema,
    requestId: uuidSchema,
    correlationId: uuidSchema,
    params: browserAutomationScreenshotReleaseParamsSchema
  })
])
export const browserAutomationProviderPollResultSchema = z.strictObject({
  request: browserAutomationProviderRequestSchema.optional()
})
export const browserAutomationProviderAcknowledgeParamsSchema = z
  .strictObject({
    identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
    target: actionInvocationTargetSchema,
    automationSessionId: uuidSchema,
    sessionGeneration: automationPositiveEpochSchema,
    operationId: uuidSchema,
    correlationId: uuidSchema,
    attemptEpoch: automationPositiveEpochSchema,
    state: z.enum(['succeeded', 'failed', 'canceled', 'expired', 'interrupted', 'resultExpired']),
    session: browserAutomationSessionSnapshotSchema.optional(),
    result: browserAutomationOperationResultDataSchema.optional(),
    errorCode: browserAutomationErrorCodeSchema.optional()
  })
  .superRefine((value, context) => {
    const success = value.state === 'succeeded'
    if (
      (success &&
        (value.errorCode !== undefined ||
          (value.session !== undefined && value.result !== undefined))) ||
      (!success &&
        (value.session !== undefined ||
          value.result !== undefined ||
          value.errorCode === undefined))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'inconsistent automation acknowledgement fields'
      })
    }
    if (
      value.session &&
      (value.session.state !== 'ready' ||
        value.session.automationSessionId !== value.automationSessionId ||
        value.session.generation !== value.sessionGeneration ||
        value.session.target.window.windowId !== value.target.windowId ||
        value.session.target.window.windowGeneration !== value.target.windowGeneration)
    ) {
      context.addIssue({ code: 'custom', message: 'returned automation session binding mismatch' })
    }
  })
export const browserAutomationProviderAcknowledgeResultSchema = z.strictObject({
  operation: browserAutomationOperationSnapshotSchema
})
export const browserAutomationProviderTransferOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('screenshotRead'),
    result: browserAutomationScreenshotReadResultSchema
  }),
  z.strictObject({ kind: z.literal('screenshotRelease'), released: z.boolean() }),
  z.strictObject({ kind: z.literal('error'), errorCode: browserAutomationErrorCodeSchema })
])
export const browserAutomationProviderTransferRespondParamsSchema = z.strictObject({
  identity: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.min(1) }),
  target: actionInvocationTargetSchema,
  requestId: uuidSchema,
  correlationId: uuidSchema,
  outcome: browserAutomationProviderTransferOutcomeSchema
})

const agentTokenSchema = (max: number) =>
  normalizedString(max).refine(
    (value) => /^[A-Za-z0-9._-]+$/u.test(value) && !hasControlCharacter(value),
    { message: 'agent token has invalid characters' }
  )
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const agentCatalogVersionSchema = z.literal(1)

export const agentRestoreLevelSchema = z.enum([
  'liveReattach',
  'toolResume',
  'layoutRestart',
  'unavailable'
])
export const agentRestoreOutcomeSchema = z.enum([
  'liveReattached',
  'resumeAttempting',
  'resumed',
  'layoutRestarted',
  'unavailable'
])
export const agentSessionLifecycleSchema = z.enum([
  'created',
  'launching',
  'running',
  'waiting',
  'checkpointing',
  'hibernated',
  'completed',
  'failed',
  'unavailable'
])
export const agentHibernationStateSchema = z.enum([
  'requested',
  'preflight',
  'confirmationRequired',
  'checkpointing',
  'checkpointVerified',
  'processDispositionPending',
  'hibernated',
  'terminatedAfterWarning',
  'canceled',
  'failed',
  'interrupted'
])
export const agentAttentionStateSchema = z.enum(['informational', 'completed', 'waiting', 'urgent'])
export const agentDestructiveChoiceSchema = z.enum(['leaveRunning', 'terminateAfterWarning'])
export const agentOperationIdentitySchema = z.strictObject({
  idempotencyKey: uuidSchema,
  requestHash: sha256Schema,
  sessionRevision: revisionSchema.positive(),
  attemptEpoch: revisionSchema.positive()
})
export const agentCatalogMutationIdentitySchema = z.strictObject({
  idempotencyKey: uuidSchema,
  requestHash: sha256Schema,
  expectedCatalogRevision: revisionSchema
})
export const agentTeamMutationIdentitySchema = agentCatalogMutationIdentitySchema.extend({
  expectedTeamRevision: revisionSchema.positive()
})
export const agentTeamMemberMutationIdentitySchema = agentTeamMutationIdentitySchema.extend({
  expectedMemberRevision: revisionSchema.positive()
})
export const agentSessionBindingSchema = z.strictObject({
  workspaceId: uuidSchema,
  paneId: uuidSchema,
  tabId: uuidSchema,
  agentSessionId: uuidSchema
})
export const agentArtifactDescriptorSchema = z
  .strictObject({
    descriptorVersion: z.literal(1),
    kind: agentTokenSchema(64),
    digestSha256: sha256Schema,
    sizeBytes: revisionSchema.positive().max(16 * 1024 * 1024),
    createdAtMs: revisionSchema,
    expiresAtMs: revisionSchema
  })
  .refine(({ createdAtMs, expiresAtMs }) => expiresAtMs > createdAtMs, {
    message: 'agent artifact expiry must follow creation'
  })
export const agentProvenanceArtifactSchema = z.strictObject({
  version: z.literal(1),
  kind: agentTokenSchema(64),
  digestSha256: sha256Schema
})
export const agentForkProvenanceSchema = z.strictObject({
  provenanceVersion: z.literal(1),
  forkedFromAgentSessionId: uuidSchema,
  artifact: agentProvenanceArtifactSchema
})
export const agentRestoreAssessmentSchema = z.strictObject({
  level: agentRestoreLevelSchema,
  assessedAtMs: revisionSchema,
  evidenceEpoch: revisionSchema.positive()
})
export const agentSessionSnapshotSchema = z
  .strictObject({
    catalogVersion: agentCatalogVersionSchema,
    binding: agentSessionBindingSchema,
    adapterId: agentTokenSchema(64),
    adapterVersion: agentTokenSchema(64),
    title: normalizedString(160),
    lifecycle: agentSessionLifecycleSchema,
    hibernationState: agentHibernationStateSchema.optional(),
    restore: agentRestoreAssessmentSchema,
    lastRestoreOutcome: agentRestoreOutcomeSchema.optional(),
    revision: revisionSchema,
    attemptEpoch: revisionSchema.positive(),
    lastVerifiedAtMs: revisionSchema,
    teamId: uuidSchema.optional(),
    memberId: uuidSchema.optional(),
    forkedFrom: agentForkProvenanceSchema.optional()
  })
  .superRefine((value, context) => {
    if ((value.teamId === undefined) !== (value.memberId === undefined)) {
      context.addIssue({ code: 'custom', message: 'team and member identity must be paired' })
    }
    if (value.forkedFrom?.forkedFromAgentSessionId === value.binding.agentSessionId) {
      context.addIssue({ code: 'custom', message: 'session cannot fork from itself' })
    }
  }) as unknown as z.ZodType<AgentSessionSnapshot>
export const agentTeamMemberSnapshotSchema = z.strictObject({
  memberId: uuidSchema,
  role: normalizedString(80),
  target: agentSessionBindingSchema,
  parentMemberId: uuidSchema.optional(),
  revision: revisionSchema
}) as unknown as z.ZodType<AgentTeamMemberSnapshot>
export const agentTeamSnapshotSchema = z
  .strictObject({
    teamId: uuidSchema,
    title: normalizedString(160),
    revision: revisionSchema,
    members: z.array(agentTeamMemberSnapshotSchema).max(64)
  })
  .superRefine(({ members }, context) => {
    const byId = new Map(members.map((member) => [member.memberId, member]))
    if (byId.size !== members.length) {
      context.addIssue({ code: 'custom', message: 'member IDs must be unique' })
      return
    }
    if (new Set(members.map(({ target }) => target.agentSessionId)).size !== members.length) {
      context.addIssue({ code: 'custom', message: 'member session bindings must be unique' })
      return
    }
    for (const member of members) {
      let parent = member.parentMemberId
      const seen = new Set([member.memberId])
      while (parent !== undefined) {
        if (seen.has(parent)) {
          context.addIssue({ code: 'custom', message: 'member graph must be acyclic' })
          return
        }
        seen.add(parent)
        const parentMember = byId.get(parent)
        if (parentMember === undefined) {
          context.addIssue({ code: 'custom', message: 'member parent must belong to the team' })
          return
        }
        parent = parentMember.parentMemberId
      }
    }
  })
export const agentCatalogListParamsSchema = z.strictObject({
  catalogVersion: agentCatalogVersionSchema
})
export const agentAttentionTargetSchema = z
  .strictObject({
    target: agentSessionBindingSchema,
    teamId: uuidSchema.optional(),
    memberId: uuidSchema.optional()
  })
  .refine((value) => (value.teamId === undefined) === (value.memberId === undefined), {
    message: 'attention team and member identity must be paired'
  }) as unknown as z.ZodType<AgentAttentionTarget>
export const agentAttentionSetParamsSchema = z.strictObject({
  target: agentAttentionTargetSchema,
  state: agentAttentionStateSchema,
  expectedAttentionRevision: revisionSchema.nullable(),
  operation: agentOperationIdentitySchema
})
export const agentAttentionSetResultSchema = z.strictObject({
  target: agentAttentionTargetSchema,
  state: agentAttentionStateSchema,
  revision: revisionSchema
})
export const agentCatalogListResultSchema = z.strictObject({
  catalogVersion: agentCatalogVersionSchema,
  revision: revisionSchema,
  sessions: z.array(agentSessionSnapshotSchema).max(512),
  teams: z.array(agentTeamSnapshotSchema).max(64),
  attention: z.array(agentAttentionSetResultSchema).max(512)
})
export const agentCatalogGetParamsSchema = z.strictObject({ agentSessionId: uuidSchema })
export const agentCatalogGetResultSchema = z.strictObject({ session: agentSessionSnapshotSchema })
export const agentCatalogRegisterParamsSchema = z.strictObject({
  catalogVersion: agentCatalogVersionSchema,
  binding: agentSessionBindingSchema,
  adapterId: agentTokenSchema(64),
  adapterVersion: agentTokenSchema(64),
  title: normalizedString(160),
  operation: agentOperationIdentitySchema
})
export const agentCatalogRegisterResultSchema = z.strictObject({
  session: agentSessionSnapshotSchema
})
const agentSessionOperationParamsSchema = z.strictObject({
  agentSessionId: uuidSchema,
  operation: agentOperationIdentitySchema
})
export const agentRestoreAssessParamsSchema = agentSessionOperationParamsSchema
export const agentSessionRestoreParamsSchema = agentSessionOperationParamsSchema
export const agentRestoreAssessResultSchema = z.strictObject({
  assessment: agentRestoreAssessmentSchema
})
export const agentSessionRestoreResultSchema = z.strictObject({
  outcome: agentRestoreOutcomeSchema,
  session: agentSessionSnapshotSchema
})
export const agentSessionForkParamsSchema = z.strictObject({
  sourceAgentSessionId: uuidSchema,
  destination: z.strictObject({
    workspaceId: uuidSchema,
    paneId: uuidSchema,
    tabId: uuidSchema
  }),
  title: normalizedString(160),
  operation: agentOperationIdentitySchema
})
export const agentSessionForkResultSchema = z.strictObject({ session: agentSessionSnapshotSchema })
export const agentTeamCreateParamsSchema = z.strictObject({
  teamId: uuidSchema,
  title: normalizedString(160),
  mutation: agentCatalogMutationIdentitySchema
})
export const agentTeamUpdateParamsSchema = z.strictObject({
  teamId: uuidSchema,
  title: normalizedString(160),
  mutation: agentTeamMutationIdentitySchema
})
export const agentTeamDeleteParamsSchema = z.strictObject({
  teamId: uuidSchema,
  mutation: agentTeamMutationIdentitySchema
})
export const agentTeamMutationResultSchema = z.strictObject({ team: agentTeamSnapshotSchema })
const agentOptionalParentSchema = { parentMemberId: uuidSchema.optional() }
export const agentTeamMemberCreateParamsSchema = z.strictObject({
  teamId: uuidSchema,
  memberId: uuidSchema,
  role: normalizedString(80),
  target: agentSessionBindingSchema,
  ...agentOptionalParentSchema,
  mutation: agentTeamMutationIdentitySchema
})
export const agentTeamMemberUpdateParamsSchema = z.strictObject({
  teamId: uuidSchema,
  memberId: uuidSchema,
  role: normalizedString(80),
  ...agentOptionalParentSchema,
  mutation: agentTeamMemberMutationIdentitySchema
})
export const agentTeamMemberDeleteParamsSchema = z.strictObject({
  teamId: uuidSchema,
  memberId: uuidSchema,
  mutation: agentTeamMemberMutationIdentitySchema
})
export const agentTeamMemberMoveParamsSchema = z.strictObject({
  teamId: uuidSchema,
  memberId: uuidSchema,
  target: agentSessionBindingSchema,
  mutation: agentTeamMemberMutationIdentitySchema
})
export const agentTeamMemberMutationResultSchema = z.strictObject({
  member: agentTeamMemberSnapshotSchema
})
export const agentHibernationChallengeRequestSchema = z.strictObject({
  choice: z.literal('terminateAfterWarning'),
  provider: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.positive() }),
  window: actionInvocationTargetSchema
})
export const agentHibernationChallengeSchema = z.strictObject({
  confirmationId: uuidSchema,
  choice: z.literal('terminateAfterWarning'),
  provider: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.positive() }),
  window: actionInvocationTargetSchema,
  nonce: normalizedString(128),
  expiresAtMs: revisionSchema.positive()
})
export const agentHibernationPreflightParamsSchema = z.strictObject({
  agentSessionId: uuidSchema,
  challenge: agentHibernationChallengeRequestSchema,
  operation: agentOperationIdentitySchema
})
export const agentHibernationPreflightResultSchema = z
  .strictObject({
    state: agentHibernationStateSchema,
    confirmationId: uuidSchema.optional(),
    challenge: agentHibernationChallengeSchema.optional(),
    checkpoint: agentArtifactDescriptorSchema.optional()
  })
  .superRefine((value, context) => {
    if (
      (value.state === 'confirmationRequired') !==
      (value.confirmationId !== undefined && value.challenge !== undefined)
    ) {
      context.addIssue({ code: 'custom', message: 'confirmation ID does not match state' })
    }
    if (
      value.checkpoint !== undefined &&
      ![
        'confirmationRequired',
        'checkpointVerified',
        'processDispositionPending',
        'hibernated'
      ].includes(value.state)
    ) {
      context.addIssue({ code: 'custom', message: 'checkpoint does not match state' })
    }
  }) as unknown as z.ZodType<AgentHibernationPreflightResult>
export const agentHibernationConfirmParamsSchema = z.strictObject({
  agentSessionId: uuidSchema,
  confirmationId: uuidSchema,
  choice: agentDestructiveChoiceSchema,
  provider: desktopProviderIdentitySchema.extend({ providerEpoch: revisionSchema.positive() }),
  window: actionInvocationTargetSchema,
  nonce: normalizedString(128),
  expiresAtMs: revisionSchema,
  operation: agentOperationIdentitySchema
})
export const agentHibernationCancelParamsSchema = agentSessionOperationParamsSchema
export const agentHibernationMutationResultSchema = z.strictObject({
  state: agentHibernationStateSchema
})

export const domainEventSchema = z
  .discriminatedUnion('event', [
    z.strictObject({
      event: z.literal('workspace.changed'),
      revision: revisionSchema,
      data: revisionEventDataSchema
    }),
    z.strictObject({
      event: z.literal('workspace.selectionChanged'),
      revision: revisionSchema,
      data: revisionEventDataSchema
    }),
    workspaceOrganizationChangedEventSchema,
    savedLayoutsChangedEventSchema,
    z.strictObject({
      event: z.literal('pane.layoutChanged'),
      revision: revisionSchema,
      data: revisionEventDataSchema
    }),
    z.strictObject({
      event: z.literal('tab.changed'),
      revision: revisionSchema,
      data: revisionEventDataSchema
    }),
    z.strictObject({
      event: z.literal('browser.changed'),
      revision: revisionSchema,
      data: browserChangedEventSchema
    }),
    z.strictObject({
      event: z.literal('settings.changed'),
      revision: revisionSchema,
      data: revisionEventDataSchema
    }),
    z.strictObject({
      event: z.literal('notification.created'),
      revision: revisionSchema,
      data: notificationCreatedEventSchema
    }),
    z.strictObject({
      event: z.literal('notification.changed'),
      revision: revisionSchema,
      data: notificationChangedEventSchema
    })
  ])
  .refine(
    ({ event, revision, data }) =>
      event === 'notification.created' || event === 'browser.changed' || revision === data.revision,
    {
      message: 'event envelope and data revisions must match'
    }
  )

export const serviceEventSchema = z.strictObject({
  event: z.literal('service.shuttingDown'),
  data: z.strictObject({ reason: z.string().min(1) })
})

export const protocolEventSchema = z.union([
  terminalEventSchema,
  workspaceCardSlotsChangedEventSchema,
  workspaceCardSlotV2ChangedEventSchema,
  workspaceAttentionChangedEventSchema,
  multiWindowProtocolEventSchema,
  domainEventSchema,
  serviceEventSchema
])

// M8 sidebar/content/index/task contracts. All objects remain exact at the renderer boundary.
export const sidebarSurfaceSchema = z.enum([
  'textBox',
  'vault',
  'taskManager',
  'files',
  'markdown',
  'diff',
  'search',
  'recentlyClosed'
])
export const sidebarSideSchema = z.enum(['left', 'right'])
const completeSidebarOrderSchema = z
  .array(sidebarSurfaceSchema)
  .length(8)
  .refine((v) => new Set(v).size === 8)
export const sidebarPlacementSchema = z
  .strictObject({
    windowId: uuidSchema,
    revision: positiveRevisionSchema,
    side: sidebarSideSchema,
    width: z.number().int().min(240).max(720),
    enabled: z
      .array(sidebarSurfaceSchema)
      .max(8)
      .refine((v) => new Set(v).size === v.length),
    order: completeSidebarOrderSchema,
    selected: sidebarSurfaceSchema
  })
  .refine((v) => v.enabled.includes(v.selected))
export const sidebarGetParamsSchema = z.strictObject({ windowId: uuidSchema })
export const sidebarSaveParamsSchema = z.strictObject({
  placement: sidebarPlacementSchema,
  mutation: remoteMutationIdentitySchema
})
export const sidebarListResultSchema = z.strictObject({
  placements: z.array(sidebarPlacementSchema).max(16)
})
export const opaqueDocumentRefSchema = z.strictObject({
  documentId: uuidSchema,
  identityVersion: positiveRevisionSchema
})
const boundedDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((v) => !hasAsciiControlCharacter(v))
const utf8Bytes = (maximum: number) =>
  z.string().refine((v) => new TextEncoder().encode(v).byteLength <= maximum)
export const contentUnavailableReasonSchema = z.enum([
  'binary',
  'oversized',
  'unsupportedEncoding',
  'unauthorized',
  'changed'
])
export const contentChunkSchema = z.strictObject({
  document: opaqueDocumentRefSchema,
  offset: revisionSchema,
  text: utf8Bytes(64 * 1024),
  eof: z.boolean(),
  contentRevision: positiveRevisionSchema,
  displayName: boundedDisplayNameSchema
})
export const contentPreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), chunk: contentChunkSchema }),
  z.strictObject({
    kind: z.literal('unavailable'),
    document: opaqueDocumentRefSchema,
    reason: contentUnavailableReasonSchema,
    displayName: boundedDisplayNameSchema
  })
])
const safeHttpUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === ''
      )
    } catch {
      return false
    }
  })
const markdownTextSchema = z.string().max(65_536)
export type SafeMarkdownNode =
  | { kind: 'heading'; level: number; children: SafeMarkdownNode[] }
  | { kind: 'paragraph'; children: SafeMarkdownNode[] }
  | { kind: 'list'; ordered: boolean; items: SafeMarkdownNode[] }
  | { kind: 'listItem'; children: SafeMarkdownNode[] }
  | { kind: 'emphasis'; children: SafeMarkdownNode[] }
  | { kind: 'strong'; children: SafeMarkdownNode[] }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'code'; text: string }
  | { kind: 'codeBlock'; language: string | null; text: string }
  | { kind: 'text'; text: string }

export const safeMarkdownNodeSchema: z.ZodType<SafeMarkdownNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('heading'),
      level: z.number().int().min(1).max(6),
      children: z.array(safeMarkdownNodeSchema).max(1024)
    }),
    z.strictObject({
      kind: z.literal('paragraph'),
      children: z.array(safeMarkdownNodeSchema).max(1024)
    }),
    z.strictObject({
      kind: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(safeMarkdownNodeSchema).max(1024)
    }),
    z.strictObject({
      kind: z.literal('listItem'),
      children: z.array(safeMarkdownNodeSchema).max(1024)
    }),
    z.strictObject({
      kind: z.literal('emphasis'),
      children: z.array(safeMarkdownNodeSchema).max(1024)
    }),
    z.strictObject({
      kind: z.literal('strong'),
      children: z.array(safeMarkdownNodeSchema).max(1024)
    }),
    z.strictObject({
      kind: z.literal('link'),
      label: z.string().max(2048),
      href: safeHttpUrlSchema
    }),
    z.strictObject({ kind: z.literal('code'), text: z.string().max(16_384) }),
    z.strictObject({
      kind: z.literal('codeBlock'),
      language: z.string().max(32).nullable(),
      text: markdownTextSchema
    }),
    z.strictObject({ kind: z.literal('text'), text: z.string().max(16_384) })
  ])
)
function markdownTreeWithinBounds(nodes: SafeMarkdownNode[]): boolean {
  let count = 0
  const visit = (node: SafeMarkdownNode, depth: number): boolean => {
    if (depth > 16 || ++count > 4096) return false
    const children = 'children' in node ? node.children : 'items' in node ? node.items : undefined
    return children === undefined || children.every((child) => visit(child, depth + 1))
  }
  return nodes.every((node) => visit(node, 1))
}
export const safeMarkdownDocumentSchema = z.strictObject({
  document: opaqueDocumentRefSchema,
  nodes: z.array(safeMarkdownNodeSchema).max(4096).refine(markdownTreeWithinBounds),
  contentRevision: positiveRevisionSchema
})
export const contentReadParamsSchema = z.strictObject({
  document: opaqueDocumentRefSchema,
  offset: revisionSchema,
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024)
})
export const contentSaveParamsSchema = z.strictObject({
  document: opaqueDocumentRefSchema,
  expectedRevision: positiveRevisionSchema,
  text: utf8Bytes(256 * 1024),
  mutation: remoteMutationIdentitySchema
})
export const contentSaveResultSchema = z.strictObject({
  document: opaqueDocumentRefSchema,
  contentRevision: positiveRevisionSchema
})
export const authorizedDocumentKindSchema = z.enum(['plainText', 'markdown'])
export const workspaceEntryKindSchema = z.enum(['directory', 'file'])
export const workspaceRootDescriptorSchema = z.strictObject({
  rootId: uuidSchema,
  directoryDescriptorId: uuidSchema,
  workspaceId: uuidSchema,
  label: boundedDisplayNameSchema,
  generation: positiveRevisionSchema
})
export const workspaceRootListResultSchema = z.strictObject({
  roots: z.array(workspaceRootDescriptorSchema).max(64),
  nextCursor: uuidSchema.nullable()
})
export const workspaceDirectoryListParamsSchema = z.strictObject({
  directoryDescriptorId: uuidSchema,
  generation: positiveRevisionSchema,
  limit: z.number().int().min(1).max(100),
  cursor: uuidSchema.optional(),
  cancellationId: uuidSchema
})
export const workspaceDirectoryEntrySchema = z.strictObject({
  entryDescriptorId: uuidSchema,
  kind: workspaceEntryKindSchema,
  label: boundedDisplayNameSchema,
  generation: positiveRevisionSchema
})
export const workspaceDirectoryListResultSchema = z.strictObject({
  entries: z.array(workspaceDirectoryEntrySchema).max(100),
  nextCursor: uuidSchema.nullable()
})
export const contentDocumentIssueParamsSchema = z.strictObject({
  authorizedDescriptorId: uuidSchema,
  descriptorGeneration: positiveRevisionSchema,
  expectedKind: authorizedDocumentKindSchema
})
export const contentDocumentIssueResultSchema = z.strictObject({
  document: opaqueDocumentRefSchema,
  displayName: boundedDisplayNameSchema
})
export const contentMarkdownParamsSchema = z.strictObject({ document: opaqueDocumentRefSchema })
export const contentDiffParamsSchema = z.strictObject({
  before: opaqueDocumentRefSchema,
  after: opaqueDocumentRefSchema,
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024)
})
export const safeDiffLineSchema = z.strictObject({
  kind: z.enum(['context', 'added', 'removed']),
  text: z.string().max(16_384)
})
export const contentDiffResultSchema = z.strictObject({
  lines: z.array(safeDiffLineSchema).max(4096),
  truncated: z.boolean()
})
export const textBoxDocumentSchema = z
  .strictObject({
    textBoxDocumentId: uuidSchema,
    workspaceId: uuidSchema,
    windowId: uuidSchema,
    title: z.string().trim().min(1).max(120),
    text: utf8Bytes(256 * 1024),
    contentRevision: positiveRevisionSchema,
    createdAtMs: revisionSchema,
    updatedAtMs: revisionSchema
  })
  .refine((v) => v.updatedAtMs >= v.createdAtMs)
export const textBoxIdParamsSchema = z.strictObject({ textBoxDocumentId: uuidSchema })
export const textBoxCreateParamsSchema = z.strictObject({
  textBoxDocumentId: uuidSchema,
  workspaceId: uuidSchema,
  windowId: uuidSchema,
  title: z.string().trim().min(1).max(120),
  text: utf8Bytes(256 * 1024),
  mutation: remoteMutationIdentitySchema
})
export const textBoxSaveParamsSchema = z.strictObject({
  textBoxDocumentId: uuidSchema,
  expectedRevision: positiveRevisionSchema,
  title: z.string().trim().min(1).max(120),
  text: utf8Bytes(256 * 1024),
  mutation: remoteMutationIdentitySchema
})
export const boundedListParamsSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  cursor: uuidSchema.optional()
})
export const textBoxListResultSchema = z.strictObject({
  documents: z.array(textBoxDocumentSchema).max(64),
  nextCursor: uuidSchema.nullable()
})
export const textBoxDeleteParamsSchema = z.strictObject({
  textBoxDocumentId: uuidSchema,
  expectedRevision: positiveRevisionSchema,
  mutation: remoteMutationIdentitySchema
})
export const searchSourceKindSchema = z.enum(['workspaceFile', 'agentTranscript'])
export const searchQueryParamsSchema = z.strictObject({
  query: z.string().trim().min(1).max(512),
  limit: z.number().int().min(1).max(100),
  cancellationId: uuidSchema
})
export const searchResultSchema = z.strictObject({
  document: opaqueDocumentRefSchema,
  snippet: z.string().max(512),
  sourceKind: searchSourceKindSchema,
  indexedAtMs: revisionSchema
})
export const searchQueryResultSchema = z.strictObject({
  results: z.array(searchResultSchema).max(100),
  truncated: z.boolean()
})
export const searchCancelParamsSchema = z.strictObject({ cancellationId: uuidSchema })
export const searchCancelResultSchema = z.strictObject({ cancelled: z.boolean() })
export const searchSourcePolicyParamsSchema = z.strictObject({
  sourceAuthorizationId: uuidSchema,
  sourceKind: searchSourceKindSchema,
  retentionDays: z.number().int().min(1).max(365),
  exclusionIds: z
    .array(uuidSchema)
    .max(256)
    .refine((v) => new Set(v).size === v.length),
  mutation: remoteMutationIdentitySchema
})
export const searchSourceMutationParamsSchema = z.strictObject({
  sourceAuthorizationId: uuidSchema,
  mutation: remoteMutationIdentitySchema
})
export const searchRebuildParamsSchema = z.strictObject({
  sourceAuthorizationId: uuidSchema,
  cancellationId: uuidSchema,
  mutation: remoteMutationIdentitySchema
})
export const searchExportParamsSchema = z.strictObject({
  sourceAuthorizationId: uuidSchema,
  confirmationId: uuidSchema
})
export const searchExportConfirmationIssueParamsSchema = z.strictObject({
  sourceAuthorizationId: uuidSchema
})
export const searchExportConfirmationSchema = z.strictObject({
  confirmationId: uuidSchema,
  sourceAuthorizationId: uuidSchema,
  expiresAtMs: positiveRevisionSchema
})
export const searchExportConfirmationIssueResultSchema = z.strictObject({
  confirmation: searchExportConfirmationSchema
})
export const searchExportResultSchema = z.strictObject({
  sourceAuthorizationId: uuidSchema,
  artifact: contentChunkSchema
})
export const searchControlResultSchema = z.strictObject({
  sourceAuthorizationId: uuidSchema,
  state: z.enum(['enabled', 'excluded', 'forgotten', 'rebuilding', 'exportReady', 'pausedLimit']),
  revision: positiveRevisionSchema
})
export const taskKindSchema = z.enum([
  'terminal',
  'agent',
  'browserAutomation',
  'remoteSession',
  'customAction'
])
export const taskLifecycleSchema = z.enum([
  'created',
  'running',
  'detaching',
  'cancelling',
  'terminating',
  'forceTerminating',
  'detached',
  'succeeded',
  'failed',
  'cancelled',
  'terminated'
])
export const taskObservationSchema = z.enum(['unknown', 'lastVerified', 'lost'])
export const taskTargetSchema = z.strictObject({
  sessionId: uuidSchema,
  generation: positiveRevisionSchema,
  revision: positiveRevisionSchema
})
export const taskActionKindSchema = z.enum(['detach', 'cancel', 'terminate', 'forceTerminate'])
export const taskWindowTargetSchema = z.strictObject({
  windowId: uuidSchema,
  windowGeneration: positiveRevisionSchema
})
export const taskSummarySchema = z.strictObject({
  target: taskTargetSchema,
  kind: taskKindSchema,
  label: z.string().trim().min(1).max(256),
  lifecycle: taskLifecycleSchema,
  observation: taskObservationSchema,
  ownerLabel: z.string().trim().min(1).max(256),
  resourceSummary: z.string().max(512).nullable()
})
export const taskConfirmationSchema = z.strictObject({
  invocationId: uuidSchema,
  action: taskActionKindSchema,
  kind: taskKindSchema,
  target: taskTargetSchema,
  providerId: uuidSchema,
  providerEpoch: positiveRevisionSchema,
  providerLeaseId: uuidSchema,
  windowId: uuidSchema,
  windowGeneration: positiveRevisionSchema,
  requestHash: lowercaseSha256Schema,
  nonce: uuidSchema,
  expiresAtMs: positiveRevisionSchema
})
export const taskConfirmationIssueParamsSchema = z.strictObject({
  action: taskActionKindSchema,
  target: taskTargetSchema,
  window: taskWindowTargetSchema,
  requestHash: lowercaseSha256Schema
})
export const taskConfirmationIssueResultSchema = z.strictObject({
  confirmation: taskConfirmationSchema
})
export const taskActionParamsSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('detach'),
    target: taskTargetSchema,
    mutation: remoteMutationIdentitySchema
  }),
  z.strictObject({
    action: z.literal('cancel'),
    target: taskTargetSchema,
    confirmation: taskConfirmationSchema,
    mutation: remoteMutationIdentitySchema
  }),
  z.strictObject({
    action: z.literal('terminate'),
    target: taskTargetSchema,
    confirmation: taskConfirmationSchema,
    mutation: remoteMutationIdentitySchema
  }),
  z.strictObject({
    action: z.literal('forceTerminate'),
    target: taskTargetSchema,
    confirmation: taskConfirmationSchema,
    mutation: remoteMutationIdentitySchema
  })
])
export const taskListParamsSchema = z.strictObject({
  kind: taskKindSchema.optional(),
  lifecycle: taskLifecycleSchema.optional(),
  limit: z.number().int().min(1).max(100),
  cursor: uuidSchema.optional(),
  cancellationId: uuidSchema
})
export const taskListResultSchema = z.strictObject({
  tasks: z.array(taskSummarySchema).max(100),
  nextCursor: uuidSchema.nullable()
})
export const taskActionResultSchema = z.strictObject({
  target: taskTargetSchema,
  lifecycle: taskLifecycleSchema,
  observation: taskObservationSchema,
  outcome: z.enum([
    'accepted',
    'alreadyConverged',
    'staleTarget',
    'providerLost',
    'confirmationExpired'
  ]),
  revision: positiveRevisionSchema
})
export const reopenActionSchema = z.enum([
  'reopenTerminal',
  'reopenAgent',
  'reopenBrowser',
  'reconnectRemote',
  'reinvokeAction'
])
export const recentlyClosedRecordSchema = z.strictObject({
  recentlyClosedId: uuidSchema,
  authorizedDescriptorId: uuidSchema,
  action: reopenActionSchema,
  label: z.string().trim().min(1).max(256),
  closedAtMs: revisionSchema,
  revision: positiveRevisionSchema
})
export const recentlyClosedListResultSchema = z.strictObject({
  records: z.array(recentlyClosedRecordSchema).max(100),
  nextCursor: uuidSchema.nullable()
})
export const recentlyClosedReopenParamsSchema = z.strictObject({
  recentlyClosedId: uuidSchema,
  authorizedDescriptorId: uuidSchema,
  action: reopenActionSchema,
  expectedRevision: positiveRevisionSchema,
  idempotencyEpoch: uuidSchema,
  target: exactTabPlacementSchema,
  mutation: remoteMutationIdentitySchema
})

export type ApplicationSnapshotMessage = z.infer<typeof applicationSnapshotSchema>
export type DomainEventMessage = z.infer<typeof domainEventSchema>
export type WorkspaceCardSlotsEventMessage = z.infer<typeof workspaceCardSlotsChangedEventSchema>
export type WorkspaceCardSlotV2EventMessage = z.infer<typeof workspaceCardSlotV2ChangedEventSchema>
export type WorkspaceAttentionEventMessage = z.infer<typeof workspaceAttentionChangedEventSchema>
export type MultiWindowEventMessage = z.infer<typeof multiWindowEventSchema>
export type ProtocolEventMessage = z.infer<typeof protocolEventSchema>
export type ServiceEventMessage = z.infer<typeof serviceEventSchema>
