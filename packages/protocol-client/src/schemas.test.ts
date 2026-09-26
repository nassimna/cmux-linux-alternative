import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

import {
  actionDefinitionSchema,
  actionInvokeParamsSchema,
  actionInvocationSnapshotSchema,
  actionListParamsSchema,
  actionListResultSchema,
  actionRegistryChangedEventSchema,
  projectActionConfirmationChallengeSchema,
  projectActionConfirmationPollResultSchema,
  projectActionConfirmationRespondParamsSchema,
  attentionAcknowledgementParamsSchema,
  attentionAcknowledgementResultSchema,
  identifyResultSchema,
  applicationSnapshotSchema,
  domainEventSchema,
  mutationResultSchema,
  mutationResponseEnvelopeSchema,
  attentionSummarySchema,
  notificationClearParamsSchema,
  notificationListParamsSchema,
  notificationListResultSchema,
  notificationPublishParamsSchema,
  notificationSnapshotSchema,
  paneMoveTabParamsSchema,
  paneSplitParamsSchema,
  pullRequestCardSlotSchema,
  browserBackParamsSchema,
  browserChangedEventSchema,
  browserNavigateParamsSchema,
  browserObserveParamsSchema,
  browserPlaceholderMetadataSchema,
  browserSessionStateSchema,
  responseEnvelopeSchema,
  searchQueryParamsSchema,
  settingsGetResultSchema,
  settingsUpdateParamsSchema,
  serviceEventSchema,
  serviceReadyRecordSchema,
  serviceRecoveryRequiredRecordSchema,
  startupRecordSchema,
  configurationSnapshotSchema,
  configurationUpdateParamsSchema,
  windowStateSnapshotSchema,
  diagnosticBundlePreviewSchema,
  recoveryExportResultSchema,
  tabMoveParamsSchema,
  tabOpenBrowserParamsSchema,
  tabOpenTerminalParamsSchema,
  tabUpdateParamsSchema,
  terminalAttachResultSchema,
  terminalCheckpointSchema,
  terminalLaunchMetadataSchema,
  terminalLaunchRequestSchema,
  terminalRuntimeMetadataResultSchema,
  terminalEventSchema,
  workspaceCreateParamsSchema,
  workspaceCardSlotsChangedEventSchema,
  workspaceCardSlotsReplaceParamsSchema,
  workspaceCardSlotsSnapshotSchema,
  workspaceCardSlotV2ChangedEventSchema,
  workspaceCardSlotV2ReplaceParamsSchema,
  workspaceCardSlotV2SnapshotSchema,
  workspaceMoveParamsSchema,
  workspaceAttentionChangedEventSchema,
  workspaceAttentionSnapshotSchema,
  workspaceSnapshotSchema,
  workspaceUpdateParamsSchema,
  layoutExportEnvelopeSchema,
  layoutPaneTemplateSchema,
  layoutTabContentTemplateSchema,
  layoutListResultSchema,
  savedLayoutSnapshotSchema,
  savedLayoutSummarySchema,
  workspaceOrganizationChangedEventSchema,
  workspaceSelectionReplaceParamsSchema,
  legacyOverLimitSnapshotSchema,
  desktopProviderRequestSchema,
  desktopActionAcknowledgeParamsSchema,
  desktopActionExecutionRequestSchema,
  desktopActionPollResultSchema,
  desktopActionStartClaimResultSchema,
  multiWindowProtocolEventSchema,
  protocolEventSchema
} from './schemas'

const milestone2Fixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/milestone2-projection.json', import.meta.url), 'utf8')
)

const milestone2SettingsFixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/milestone2-settings.json', import.meta.url), 'utf8')
)

type ProjectionOperation =
  { op: 'set'; path: string; value: unknown } | { op: 'copy'; from: string; path: string }

const invalidProjectionFixture = JSON.parse(
  readFileSync(new URL('../fixtures/milestone2-invalid-projections.json', import.meta.url), 'utf8')
) as {
  cases: Array<{
    name: string
    boundary: 'application' | 'workspace'
    operations: ProjectionOperation[]
  }>
}

const boundaryFixture = JSON.parse(
  readFileSync(new URL('../fixtures/boundary-parity.json', import.meta.url), 'utf8')
) as {
  uint32: { minimum: number; maximum: number; aboveMaximum: number }
  safeInteger: { maximum: number; aboveMaximum: number }
  unicode: {
    astralScalar: string
    nameMaximumScalars: number
    titleMaximumScalars: number
    descriptionMaximumScalars: number
    colorMaximumScalars: number
    reasonMaximumScalars: number
    ecmaScriptTrimWhitespace: string[]
    nonTrimWhitespace: string[]
  }
}

const attentionContractFixture = JSON.parse(
  readFileSync(new URL('../fixtures/attention-contract-parity.json', import.meta.url), 'utf8')
) as { cases: Array<{ name: string; valid: boolean; value: unknown }> }

const MAX_TERMINAL_CHECKPOINT_DATA_LENGTH = 512 * 1024

const legacyV1DensityFixtureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  density: z.enum(['compact', 'comfortable'])
})

it('accepts optional bounded search source scope for Node clients', () => {
  const request = { query: 'needle', limit: 1, cancellationId: randomUUID() }
  expect(searchQueryParamsSchema.safeParse(request).success).toBe(true)
  expect(
    searchQueryParamsSchema.safeParse({
      ...request,
      sourceAuthorizationIds: [randomUUID()]
    }).success
  ).toBe(true)
  expect(
    searchQueryParamsSchema.safeParse({
      ...request,
      sourceAuthorizationIds: Array.from({ length: 641 }, randomUUID)
    }).success
  ).toBe(false)
})

describe('actions-v1 strict contracts', () => {
  const ids = {
    invocation: '10000000-0000-4000-8000-000000000001',
    correlation: '20000000-0000-4000-8000-000000000002',
    epoch: '30000000-0000-4000-8000-000000000003',
    key: '40000000-0000-4000-8000-000000000004',
    provider: '50000000-0000-4000-8000-000000000005',
    lease: '60000000-0000-4000-8000-000000000006',
    window: '70000000-0000-4000-8000-000000000007'
  }
  const identity = { providerId: ids.provider, providerEpoch: 4, leaseId: ids.lease }
  const target = { windowId: ids.window, windowGeneration: 7 }
  const definition = {
    actionId: 'workspace.tab.close',
    actionVersion: 1,
    localizedTitleKey: 'actions.workspace.tab_close',
    category: 'workspace',
    owner: 'service' as const,
    parameterSchemaVersion: 1,
    resultSchemaVersion: 1,
    authorizationClass: 'owner' as const,
    interactionClass: 'headless' as const,
    limits: { maxParameterBytes: 64 * 1024, maxResultBytes: 64 * 1024, timeoutMs: 30_000 }
  }

  it('validates bounded definitions and discovery pages without null ambiguity', () => {
    expect(actionDefinitionSchema.safeParse(definition).success).toBe(true)
    expect(
      actionDefinitionSchema.safeParse({
        ...definition,
        displayTitle: 'Build project',
        defaultShortcut: 'Primary+Shift+B'
      }).success
    ).toBe(true)
    expect(
      actionDefinitionSchema.safeParse({ ...definition, defaultShortcut: 'Shift+Primary+B' })
        .success
    ).toBe(false)
    expect(actionDefinitionSchema.safeParse({ ...definition, displayTitle: null }).success).toBe(
      false
    )
    expect(
      actionDefinitionSchema.safeParse({
        ...definition,
        owner: 'desktop',
        interactionClass: 'desktopInteraction',
        requiredDesktopCapability: 'native-window-v1'
      }).success
    ).toBe(true)
    expect(
      actionDefinitionSchema.safeParse({ ...definition, requiredDesktopCapability: 'native-v1' })
        .success
    ).toBe(false)
    expect(actionDefinitionSchema.safeParse({ ...definition, command: '/bin/sh' }).success).toBe(
      false
    )
    expect(actionListParamsSchema.safeParse({ limit: 64 }).success).toBe(true)
    expect(actionListParamsSchema.safeParse({ limit: 65 }).success).toBe(false)
    expect(actionListParamsSchema.safeParse({ limit: 1, cursor: null }).success).toBe(false)

    const page = {
      registryRevision: 3,
      idempotencyEpoch: ids.epoch,
      definitions: [definition],
      nextCursor: 'opaque.cursor_1'
    }
    expect(actionListResultSchema.safeParse(page).success).toBe(true)
    expect(
      actionListResultSchema.safeParse({ ...page, definitions: [definition, definition] }).success
    ).toBe(false)
    expect(actionListResultSchema.safeParse({ ...page, definitions: [] }).success).toBe(false)
    expect(
      actionRegistryChangedEventSchema.safeParse({
        event: 'action.registryChanged',
        registryRevision: 4,
        reason: 'definitionsChanged'
      }).success
    ).toBe(true)
    expect(
      actionRegistryChangedEventSchema.safeParse({
        event: 'action.registryInvalidated',
        registryRevision: 4,
        reason: 'definitionsChanged'
      }).success
    ).toBe(false)
  })

  it('keeps project confirmation provider-bound, content-free, and null-free', () => {
    const challenge = {
      invocationId: ids.invocation,
      nonce: ids.correlation,
      challenge: 'a'.repeat(64),
      identity: { providerId: ids.provider, providerEpoch: 3, leaseId: ids.lease },
      target,
      confirmationDefinitionSha256: 'b'.repeat(64),
      actionId: 'project.example.build',
      displayTitle: 'Build project',
      executableClass: 'projectRelative',
      argumentCount: 2,
      projectLabel: 'Example',
      expiresAtMs: 99
    }
    expect(projectActionConfirmationChallengeSchema.safeParse(challenge).success).toBe(true)
    expect(
      projectActionConfirmationChallengeSchema.safeParse({
        ...challenge,
        command: '/bin/sh -c secret'
      }).success
    ).toBe(false)
    expect(projectActionConfirmationPollResultSchema.safeParse({ challenge: null }).success).toBe(
      false
    )
    expect(
      projectActionConfirmationRespondParamsSchema.safeParse({
        identity: challenge.identity,
        invocationId: challenge.invocationId,
        nonce: challenge.nonce,
        challenge: challenge.challenge,
        target,
        confirmationDefinitionSha256: challenge.confirmationDefinitionSha256,
        decision: 'confirmed'
      }).success
    ).toBe(true)
  })

  it('rejects malformed, non-object, null, and oversized invocation payloads', () => {
    const invocation = {
      actionId: definition.actionId,
      actionVersion: 1,
      parameters: { tabId: ids.invocation },
      target,
      idempotency: { epoch: ids.epoch, key: ids.key },
      correlationId: ids.correlation
    }
    expect(actionInvokeParamsSchema.safeParse(invocation).success).toBe(true)
    for (const parameters of [null, [], 'unsafe']) {
      expect(actionInvokeParamsSchema.safeParse({ ...invocation, parameters }).success).toBe(false)
    }
    expect(
      actionInvokeParamsSchema.safeParse({
        ...invocation,
        parameters: { value: 'x'.repeat(64 * 1024) }
      }).success
    ).toBe(false)
    expect(actionInvokeParamsSchema.safeParse({ ...invocation, target: null }).success).toBe(false)
  })

  it('enforces terminal snapshot, start grant, acknowledgement, and poll correlation', () => {
    const succeeded = {
      invocationId: ids.invocation,
      correlationId: ids.correlation,
      state: 'acknowledged' as const,
      terminalCode: 'succeeded' as const,
      result: {},
      updatedAtMs: 10
    }
    expect(actionInvocationSnapshotSchema.safeParse(succeeded).success).toBe(true)
    expect(
      actionInvocationSnapshotSchema.safeParse({ ...succeeded, result: undefined }).success
    ).toBe(false)

    const request = {
      identity,
      invocationId: ids.invocation,
      correlationId: ids.correlation,
      attemptEpoch: 8,
      actionId: definition.actionId,
      actionVersion: 1,
      target,
      parameters: {},
      expiresAtMs: 1000
    }
    expect(desktopActionExecutionRequestSchema.safeParse(request).success).toBe(true)
    expect(
      desktopActionExecutionRequestSchema.safeParse({ ...request, attemptEpoch: 0 }).success
    ).toBe(false)
    expect(
      desktopActionExecutionRequestSchema.safeParse({
        ...request,
        identity: { ...identity, providerEpoch: 0 }
      }).success
    ).toBe(false)
    expect(
      desktopActionExecutionRequestSchema.safeParse({
        ...request,
        target: { ...target, windowGeneration: 0 }
      }).success
    ).toBe(false)
    expect(desktopActionPollResultSchema.safeParse({ request }).success).toBe(true)
    expect(desktopActionPollResultSchema.safeParse({ request: null }).success).toBe(false)

    expect(
      desktopActionStartClaimResultSchema.safeParse({
        invocationId: ids.invocation,
        correlationId: ids.correlation,
        attemptEpoch: 8,
        decision: 'granted',
        grantedAtMs: 12
      }).success
    ).toBe(true)
    expect(
      desktopActionStartClaimResultSchema.safeParse({
        invocationId: ids.invocation,
        correlationId: ids.correlation,
        attemptEpoch: 8,
        decision: 'granted'
      }).success
    ).toBe(false)

    const acknowledgement = {
      identity,
      invocationId: ids.invocation,
      correlationId: ids.correlation,
      attemptEpoch: 8,
      actionId: definition.actionId,
      actionVersion: 1,
      target,
      status: 'succeeded' as const,
      result: {}
    }
    expect(desktopActionAcknowledgeParamsSchema.safeParse(acknowledgement).success).toBe(true)
    expect(
      desktopActionAcknowledgeParamsSchema.safeParse({
        ...acknowledgement,
        status: 'failed',
        errorCode: 'execution_failed'
      }).success
    ).toBe(false)
    expect(
      desktopActionAcknowledgeParamsSchema.safeParse({ ...acknowledgement, result: null }).success
    ).toBe(false)
  })
})

const milestone5Configuration = {
  schemaVersion: 1,
  revision: 4,
  appearance: { theme: 'system', density: 'comfortable', fontFamily: 'system-ui' },
  terminal: {
    shellPath: '/bin/sh',
    fontFamily: 'monospace',
    fontSize: 13,
    scrollback: 10_000,
    multilinePasteProtection: true
  },
  browser: { profileName: 'Default', partition: 'default', privacy: 'standard' },
  notifications: { systemEnabled: true, includeBody: false },
  keyboardShortcuts: { overrides: { 'terminal.new': 'Primary+Shift+T', 'tab.close': null } },
  agentIntegration: { enabled: true, notificationsEnabled: true, browserEnabled: true },
  updates: { channel: 'stable' },
  logging: { level: 'info' }
}

const terminalDescriptor = {
  id: '3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30',
  command: ['/bin/sh'],
  cwd: '/tmp',
  rows: 24,
  cols: 80,
  exited: false
}

const terminalCheckpoint = {
  sequence: 1,
  rows: 24,
  cols: 80,
  activeBuffer: 'normal' as const,
  data: ''
}

const pointerParts = (pointer: string) =>
  pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))

const getProjectionValue = (root: unknown, pointer: string): unknown => {
  let current = root
  for (const part of pointerParts(pointer)) {
    if (Array.isArray(current)) current = current[Number(part)]
    else if (typeof current === 'object' && current !== null)
      current = (current as Record<string, unknown>)[part]
    else throw new Error(`invalid projection fixture source: ${pointer}`)
  }
  if (current === undefined) throw new Error(`missing projection fixture source: ${pointer}`)
  return current
}

const setProjectionValue = (root: unknown, pointer: string, value: unknown): void => {
  const parts = pointerParts(pointer)
  const property = parts.pop()
  if (property === undefined) throw new Error(`invalid projection fixture target: ${pointer}`)
  let parent = root
  for (const part of parts) parent = getProjectionValue(parent, `/${part}`)
  if (Array.isArray(parent)) {
    if (property === '-') parent.push(value)
    else parent[Number(property)] = value
  } else if (typeof parent === 'object' && parent !== null) {
    ;(parent as Record<string, unknown>)[property] = value
  } else {
    throw new Error(`invalid projection fixture target: ${pointer}`)
  }
}

const applyProjectionOperations = (root: unknown, operations: ProjectionOperation[]): void => {
  for (const operation of operations) {
    const value =
      operation.op === 'set' ? operation.value : getProjectionValue(root, operation.from)
    setProjectionValue(root, operation.path, structuredClone(value))
  }
}

describe('protocol schemas', () => {
  it('keeps organization invalidations bounded and revision-consistent', () => {
    const event = {
      event: 'workspace.organizationChanged',
      revision: 7,
      data: { revision: 7, reason: 'organizationChanged' }
    }
    expect(workspaceOrganizationChangedEventSchema.safeParse(event).success).toBe(true)
    expect(
      workspaceOrganizationChangedEventSchema.safeParse({
        ...event,
        data: { ...event.data, workspaceIds: Array(129).fill(terminalDescriptor.id) }
      }).success
    ).toBe(false)
    expect(
      workspaceOrganizationChangedEventSchema.safeParse({ ...event, revision: 8 }).success
    ).toBe(false)
  })

  it('requires exact legacy over-limit counts and exceeded dimensions', () => {
    const legacy = {
      workspaceCount: 129,
      maximumPanesInWorkspace: 65,
      maximumTabsInWorkspace: 128,
      totalPaneCount: 1025,
      totalTabCount: 2048,
      exceededDimensions: ['workspaces', 'panesPerWorkspace', 'totalPanes']
    }
    expect(legacyOverLimitSnapshotSchema.safeParse(legacy).success).toBe(true)
    expect(
      legacyOverLimitSnapshotSchema.safeParse({
        ...legacy,
        exceededDimensions: ['workspaces']
      }).success
    ).toBe(false)
    expect(
      legacyOverLimitSnapshotSchema.safeParse({
        ...legacy,
        workspaceCount: Number.MAX_SAFE_INTEGER + 1
      }).success
    ).toBe(false)
  })

  it('rejects count-valid saved-layout templates above 256 KiB on import and get', () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const paneId = '20000000-0000-4000-8000-000000000002'
    const tabs = Array.from(
      { length: 256 },
      (_, index) => `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
    )
    const tabMap = Object.fromEntries(
      tabs.map((id) => [
        id,
        {
          id,
          paneId,
          title: 'browser',
          customTitle: null,
          content: { kind: 'browser', url: `https://example.test/${'a'.repeat(7000)}` },
          createdAt: 1
        }
      ])
    )
    const template = {
      workspaces: [
        {
          id: workspaceId,
          name: 'workspace',
          description: null,
          color: null,
          workingDirectory: '/tmp',
          layout: { kind: 'leaf', paneId },
          selectedPaneId: paneId,
          panes: { [paneId]: { id: paneId, tabs, selectedTabId: tabs[0], title: null } },
          tabs: tabMap,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
    const envelope = { formatVersion: 1, name: 'oversized', template }
    expect(layoutExportEnvelopeSchema.safeParse(envelope).success).toBe(false)
    expect(
      savedLayoutSnapshotSchema.safeParse({
        id: '40000000-0000-4000-8000-000000000004',
        name: 'oversized',
        formatVersion: 1,
        createdAt: 1,
        updatedAt: 1,
        template
      }).success
    ).toBe(false)
  })

  it('rejects a portable layout that exceeds Rust workspace tab capacity', () => {
    const paneId = '20000000-0000-4000-8000-000000000002'
    const tabs = Array.from(
      { length: 129 },
      (_, index) => `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
    )
    const tabMap = Object.fromEntries(
      tabs.map((id) => [
        id,
        {
          id,
          paneId,
          title: 'shell',
          customTitle: null,
          content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } },
          createdAt: 1
        }
      ])
    )
    const envelope = {
      formatVersion: 1,
      name: 'too many tabs',
      template: {
        workspaces: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            name: 'workspace',
            description: null,
            color: null,
            workingDirectory: '/tmp',
            layout: { kind: 'leaf', paneId },
            selectedPaneId: paneId,
            panes: { [paneId]: { id: paneId, tabs, selectedTabId: tabs[0], title: null } },
            tabs: tabMap,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    }
    expect(JSON.stringify(envelope).length).toBeLessThan(256 * 1024)
    expect(layoutExportEnvelopeSchema.safeParse(envelope).success).toBe(false)
    const atLimit = structuredClone(envelope)
    const workspace = atLimit.template.workspaces[0]!
    workspace.panes[paneId].tabs.pop()
    delete workspace.tabs[tabs.at(-1)!]
    expect(layoutExportEnvelopeSchema.safeParse(atLimit).success).toBe(true)
  })

  it('rejects malformed and duplicate saved-layout summaries', () => {
    const summary = {
      id: '40000000-0000-4000-8000-000000000004',
      name: 'layout',
      formatVersion: 1,
      workspaceCount: 1,
      createdAt: 1,
      updatedAt: 1
    }

    expect(savedLayoutSummarySchema.safeParse(summary).success).toBe(true)
    expect(savedLayoutSummarySchema.safeParse({ ...summary, id: 'not-a-uuid' }).success).toBe(false)
    expect(savedLayoutSummarySchema.safeParse({ ...summary, formatVersion: 2 }).success).toBe(false)
    expect(
      savedLayoutSummarySchema.safeParse({
        ...summary,
        updatedAt: Number.MAX_SAFE_INTEGER + 1
      }).success
    ).toBe(false)
    expect(
      layoutListResultSchema.safeParse({ revision: 1, layouts: [summary, summary] }).success
    ).toBe(false)
    expect(
      layoutListResultSchema.safeParse({
        revision: 1,
        layouts: Array.from({ length: 65 }, (_, index) => ({
          ...summary,
          id: `40000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
        }))
      }).success
    ).toBe(false)
  })

  it('keeps workspace selection replacement strict and focus-consistent', () => {
    const first = '10000000-0000-4000-8000-000000000001'
    const valid = {
      selection: [first],
      focusedWorkspaceId: first,
      expectedRevision: 1,
      idempotencyKey: '20000000-0000-4000-8000-000000000002'
    }
    expect(workspaceSelectionReplaceParamsSchema.safeParse(valid).success).toBe(true)
    expect(
      workspaceSelectionReplaceParamsSchema.safeParse({ ...valid, selection: [] }).success
    ).toBe(false)
    expect(
      workspaceSelectionReplaceParamsSchema.safeParse({
        ...valid,
        focusedWorkspaceId: '10000000-0000-4000-8000-000000000099'
      }).success
    ).toBe(false)
    expect(
      workspaceSelectionReplaceParamsSchema.safeParse({ ...valid, selection: [first, first] })
        .success
    ).toBe(false)
  })

  it('accepts up to 256 pane tabs independently of the workspace count bound', () => {
    const paneId = '20000000-0000-4000-8000-000000000001'
    const tabs = Array.from(
      { length: 33 },
      (_, index) => `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
    )
    const pane = { id: paneId, tabs, selectedTabId: tabs[0], title: null }
    expect(layoutPaneTemplateSchema.safeParse(pane).success).toBe(true)
    expect(layoutPaneTemplateSchema.safeParse({ ...pane, tabs: [] }).success).toBe(false)
    const oversizedTabs = Array.from(
      { length: 257 },
      (_, index) => `30000000-0000-4000-8001-${index.toString(16).padStart(12, '0')}`
    )
    expect(
      layoutPaneTemplateSchema.safeParse({
        ...pane,
        tabs: oversizedTabs,
        selectedTabId: oversizedTabs[0]
      }).success
    ).toBe(false)
  })

  it.each([
    ['https://example.test/private/path', true],
    ['https://localhost/private/path', true],
    ['https://127.0.0.1/private/path', true],
    ['https://[::1]/private/path', true],
    ['https://user:password@example.test/private/path', false],
    ['https://example.test/private/path?access_token=secret', false],
    ['https://example.test/private/path#secret', false],
    ['HTTPS://EXAMPLE.TEST/private/path', false],
    ['https://example.test:443/private/path', false],
    ['https://example.test/private/../path', false],
    ['https://foo_bar/private/path', false],
    ['https://-foo/private/path', false],
    ['https://foo-/private/path', false],
    ['https://foo..bar/private/path', false],
    ['https://example.test:0/private/path', false]
  ])('enforces portable saved-layout URL policy for %s', (url, expected) => {
    expect(layoutTabContentTemplateSchema.safeParse({ kind: 'browser', url }).success).toBe(
      expected
    )
  })

  it('parses strict milestone 5 configuration snapshots and complete-section updates', () => {
    expect(
      legacyV1DensityFixtureSchema.safeParse({ schemaVersion: 1, density: 'comfortable' }).success
    ).toBe(true)
    expect(
      legacyV1DensityFixtureSchema.safeParse({ schemaVersion: 2, density: 'expanded' }).success
    ).toBe(false)
    expect(
      legacyV1DensityFixtureSchema.safeParse({ schemaVersion: 1, density: 'expanded' }).success
    ).toBe(false)
    expect(configurationSnapshotSchema.safeParse(milestone5Configuration).success).toBe(true)
    expect(
      configurationSnapshotSchema.safeParse({
        ...milestone5Configuration,
        schemaVersion: 2,
        appearance: { ...milestone5Configuration.appearance, density: 'expanded' }
      }).success
    ).toBe(true)
    expect(
      configurationSnapshotSchema.safeParse({
        ...milestone5Configuration,
        appearance: { ...milestone5Configuration.appearance, density: 'expanded' }
      }).success
    ).toBe(false)
    expect(
      configurationSnapshotSchema.safeParse({
        ...milestone5Configuration,
        appearance: { ...milestone5Configuration.appearance, density: 'spacious' }
      }).success
    ).toBe(false)
    expect(
      configurationSnapshotSchema.safeParse({ ...milestone5Configuration, schemaVersion: 2 })
        .success
    ).toBe(true)
    expect(
      configurationSnapshotSchema.safeParse({ ...milestone5Configuration, schemaVersion: 3 })
        .success
    ).toBe(false)
    expect(
      configurationUpdateParamsSchema.safeParse({ expectedRevision: 4, update: {} }).success
    ).toBe(false)
    expect(
      configurationUpdateParamsSchema.safeParse({
        expectedRevision: 4,
        update: { updates: { channel: 'beta' } }
      }).success
    ).toBe(true)
    expect(
      configurationUpdateParamsSchema.safeParse({
        expectedRevision: 4,
        update: { appearance: { theme: 'dark' } }
      }).success
    ).toBe(false)
    expect(
      configurationUpdateParamsSchema.safeParse({
        expectedRevision: 4,
        update: { keyboardShortcuts: { overrides: { unknown: null } } }
      }).success
    ).toBe(false)
  })

  it('keeps window, recovery, and diagnostic contracts bounded and strict', () => {
    const state = {
      revision: 1,
      x: -1_000_000,
      y: 1_000_000,
      width: 200,
      height: 32_768,
      maximized: false,
      fullscreen: false,
      displayId: 'display-1'
    }
    expect(windowStateSnapshotSchema.safeParse(state).success).toBe(true)
    expect(windowStateSnapshotSchema.safeParse({ ...state, width: 199 }).success).toBe(false)
    const recovery = {
      event: 'service.recoveryRequired',
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      category: 'migrationFailed',
      message: 'Recovery required',
      migrationBackupAvailable: true,
      migrationBackupPath: '/tmp/backup.db'
    }
    expect(serviceRecoveryRequiredRecordSchema.safeParse(recovery).success).toBe(true)
    expect(startupRecordSchema.safeParse(recovery).success).toBe(true)
    expect(
      serviceRecoveryRequiredRecordSchema.safeParse({
        ...recovery,
        migrationBackupPath: undefined
      }).success
    ).toBe(false)
    expect(
      serviceRecoveryRequiredRecordSchema.safeParse({
        ...recovery,
        migrationBackupAvailable: false
      }).success
    ).toBe(false)
    expect(
      serviceRecoveryRequiredRecordSchema.safeParse({
        ...recovery,
        migrationBackupAvailable: false,
        migrationBackupPath: undefined
      }).success
    ).toBe(true)
    expect(
      diagnosticBundlePreviewSchema.safeParse({
        entries: [{ name: 'service.log', bytes: 42 }],
        totalBytes: 42,
        redactionCount: 2,
        createdAt: 5
      }).success
    ).toBe(true)
    expect(
      diagnosticBundlePreviewSchema.safeParse({
        entries: [{ name: 'service.log', bytes: 42 }],
        totalBytes: 41,
        redactionCount: 2,
        createdAt: 5
      }).success
    ).toBe(false)
    expect(
      recoveryExportResultSchema.safeParse({ path: '/tmp/export.db', bytes: 42 }).success
    ).toBe(true)
  })
  it('matches Rust uint32 boundaries for every u32 wire field', () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const paneId = '30000000-0000-4000-8000-000000000001'
    const tabId = '40000000-0000-4000-8000-000000000001'
    const terminalId = terminalDescriptor.id
    const launch = { cwd: '/tmp', rows: 24, cols: 80 }
    const numericSchemas = [
      (value: number) =>
        serviceReadyRecordSchema.safeParse({
          event: 'service.ready',
          application: 'agent-workspace',
          version: '0.1.0',
          protocolVersion: value
        }).success,
      (value: number) =>
        terminalAttachResultSchema.safeParse({
          terminal: { ...terminalDescriptor, processId: value },
          output: [],
          lastSequence: 0,
          reconstructionComplete: true
        }).success,
      (value: number) =>
        terminalAttachResultSchema.safeParse({
          terminal: { ...terminalDescriptor, exitCode: value },
          output: [],
          lastSequence: 0,
          reconstructionComplete: true
        }).success,
      (value: number) =>
        terminalEventSchema.safeParse({
          event: 'terminal.exited',
          data: { terminalId, exitCode: value, signal: null }
        }).success,
      (value: number) =>
        workspaceMoveParamsSchema.safeParse({ workspaceId, destinationIndex: value }).success,
      (value: number) =>
        paneMoveTabParamsSchema.safeParse({
          workspaceId,
          tabId,
          destinationPaneId: paneId,
          destinationIndex: value
        }).success,
      (value: number) =>
        tabOpenTerminalParamsSchema.safeParse({
          workspaceId,
          paneId,
          destinationIndex: value,
          launch
        }).success,
      (value: number) =>
        tabOpenBrowserParamsSchema.safeParse({
          workspaceId,
          paneId,
          destinationIndex: value,
          metadata: { url: 'https://example.test' }
        }).success,
      (value: number) =>
        tabMoveParamsSchema.safeParse({
          workspaceId,
          tabId,
          destinationPaneId: paneId,
          destinationIndex: value
        }).success
    ]

    for (const value of [boundaryFixture.uint32.minimum, boundaryFixture.uint32.maximum]) {
      expect(numericSchemas.map((parse) => parse(value))).toEqual(numericSchemas.map(() => true))
    }
    for (const value of [
      boundaryFixture.uint32.aboveMaximum,
      boundaryFixture.safeInteger.maximum
    ]) {
      expect(numericSchemas.map((parse) => parse(value))).toEqual(numericSchemas.map(() => false))
    }
    for (const value of [
      boundaryFixture.uint32.maximum,
      boundaryFixture.uint32.aboveMaximum,
      boundaryFixture.safeInteger.maximum
    ]) {
      expect(
        terminalEventSchema.safeParse({
          event: 'terminal.output',
          data: { terminalId, chunk: { sequence: 0, data: '', byteLength: value } }
        }).success
      ).toBe(false)
    }
  })

  it('retains JavaScript-safe u64 boundaries for revisions and sequences', () => {
    const accepted = [
      boundaryFixture.uint32.minimum,
      boundaryFixture.uint32.maximum,
      boundaryFixture.uint32.aboveMaximum,
      boundaryFixture.safeInteger.maximum
    ]
    for (const value of accepted) {
      expect(
        responseEnvelopeSchema.safeParse({ id: 'request-1', ok: true, revision: value }).success
      ).toBe(true)
      expect(
        terminalCheckpointSchema.safeParse({ ...terminalCheckpoint, sequence: value }).success
      ).toBe(true)
    }
    expect(
      responseEnvelopeSchema.safeParse({
        id: 'request-1',
        ok: true,
        revision: boundaryFixture.safeInteger.aboveMaximum
      }).success
    ).toBe(false)
    expect(
      terminalCheckpointSchema.safeParse({
        ...terminalCheckpoint,
        sequence: boundaryFixture.safeInteger.aboveMaximum
      }).success
    ).toBe(false)
  })

  it('counts normalized string limits in Unicode scalar values like Rust', () => {
    const {
      astralScalar,
      nameMaximumScalars,
      titleMaximumScalars,
      descriptionMaximumScalars,
      colorMaximumScalars,
      reasonMaximumScalars
    } = boundaryFixture.unicode
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const tabId = '40000000-0000-4000-8000-000000000001'
    const create = {
      name: astralScalar.repeat(nameMaximumScalars),
      description: astralScalar.repeat(descriptionMaximumScalars),
      color: astralScalar.repeat(colorMaximumScalars),
      workingDirectory: '/tmp',
      initialTerminal: { cwd: '/tmp', command: [astralScalar], rows: 24, cols: 80 }
    }
    expect(workspaceCreateParamsSchema.safeParse(create).success).toBe(true)
    expect(
      workspaceCreateParamsSchema.safeParse({
        ...create,
        name: astralScalar.repeat(nameMaximumScalars + 1)
      }).success
    ).toBe(false)
    expect(
      workspaceCreateParamsSchema.safeParse({
        ...create,
        description: astralScalar.repeat(descriptionMaximumScalars + 1)
      }).success
    ).toBe(false)
    expect(
      workspaceCreateParamsSchema.safeParse({
        ...create,
        color: astralScalar.repeat(colorMaximumScalars + 1)
      }).success
    ).toBe(false)

    const titleIdentity = { workspaceId, tabId }
    expect(
      tabUpdateParamsSchema.safeParse({
        ...titleIdentity,
        title: astralScalar.repeat(titleMaximumScalars)
      }).success
    ).toBe(true)
    expect(
      tabUpdateParamsSchema.safeParse({
        ...titleIdentity,
        title: astralScalar.repeat(titleMaximumScalars + 1)
      }).success
    ).toBe(false)

    const domainEvent = (reason: string) => ({
      event: 'workspace.changed' as const,
      revision: 0,
      data: { revision: 0, workspaceIds: [], paneIds: [], tabIds: [], commandIds: [], reason }
    })
    expect(
      domainEventSchema.safeParse(domainEvent(astralScalar.repeat(reasonMaximumScalars))).success
    ).toBe(true)
    expect(
      domainEventSchema.safeParse(domainEvent(astralScalar.repeat(reasonMaximumScalars + 1)))
        .success
    ).toBe(false)
    expect(domainEventSchema.safeParse(domainEvent('')).success).toBe(false)
    expect(domainEventSchema.safeParse(domainEvent(` ${astralScalar}`)).success).toBe(false)
    expect(
      workspaceCreateParamsSchema.safeParse({ ...create, name: ` ${astralScalar}` }).success
    ).toBe(false)
  })

  it('matches the shared ECMAScript trim boundary exactly', () => {
    const base = {
      name: 'workspace',
      workingDirectory: '/tmp',
      initialTerminal: { cwd: '/tmp', rows: 24, cols: 80 }
    }

    for (const character of boundaryFixture.unicode.ecmaScriptTrimWhitespace) {
      expect(
        workspaceCreateParamsSchema.safeParse({
          ...base,
          name: `${character}workspace${character}`
        }).success
      ).toBe(false)
      expect(workspaceCreateParamsSchema.safeParse({ ...base, name: character }).success).toBe(
        false
      )
    }

    for (const character of boundaryFixture.unicode.nonTrimWhitespace) {
      expect(
        workspaceCreateParamsSchema.safeParse({
          ...base,
          name: `${character}workspace${character}`
        }).success
      ).toBe(true)
    }
  })

  it('parses stable service lifecycle records', () => {
    expect(
      serviceReadyRecordSchema.parse({
        event: 'service.ready',
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1
      }).event
    ).toBe('service.ready')
    expect(
      serviceEventSchema.parse({
        event: 'service.shuttingDown',
        data: { reason: 'service_shutdown' }
      }).data.reason
    ).toBe('service_shutdown')
  })
  it('accepts the negotiated Milestone 0 identity', () => {
    expect(
      identifyResultSchema.parse({
        application: 'agent-workspace',
        version: '0.1.0',
        protocolVersion: 1,
        capabilities: ['system.identify']
      })
    ).toEqual({
      application: 'agent-workspace',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: ['system.identify']
    })
  })

  it('rejects an unexpected application identity', () => {
    const response = identifyResultSchema.safeParse({
      application: 'unexpected-application',
      version: '0.1.0',
      protocolVersion: 1,
      capabilities: []
    })

    expect(response.success).toBe(false)
  })

  it('accepts a success envelope', () => {
    expect(
      responseEnvelopeSchema.parse({
        id: 'request-1',
        ok: true,
        result: {}
      })
    ).toMatchObject({ id: 'request-1', ok: true })
  })

  it('validates an ordered terminal attachment', () => {
    expect(
      terminalAttachResultSchema.parse({
        terminal: {
          ...terminalDescriptor,
          processId: 42
        },
        output: [{ sequence: 1, data: 'aGVsbG8=', byteLength: 5 }],
        lastSequence: 1,
        reconstructionComplete: true
      }).lastSequence
    ).toBe(1)
  })

  it('rejects oversized terminal output events', () => {
    const parsed = terminalEventSchema.safeParse({
      event: 'terminal.output',
      data: {
        terminalId: '3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30',
        chunk: { sequence: 1, data: '', byteLength: 64 * 1024 + 1 }
      }
    })

    expect(parsed.success).toBe(false)
  })

  it('accepts checkpoint data below the serialized wire boundary', () => {
    const parsed = terminalCheckpointSchema.safeParse({
      ...terminalCheckpoint,
      data: 'x'.repeat(MAX_TERMINAL_CHECKPOINT_DATA_LENGTH - 128)
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects checkpoint data beyond the serialized wire boundary', () => {
    const parsed = terminalCheckpointSchema.safeParse({
      ...terminalCheckpoint,
      data: 'x'.repeat(MAX_TERMINAL_CHECKPOINT_DATA_LENGTH + 1)
    })

    expect(parsed.success).toBe(false)
  })

  it.each([
    ['escape-heavy', '\\"'.repeat(MAX_TERMINAL_CHECKPOINT_DATA_LENGTH / 2)],
    ['multibyte', '界'.repeat(MAX_TERMINAL_CHECKPOINT_DATA_LENGTH)]
  ])('rejects %s data when serialized UTF-8 exceeds the wire cap', (_, data) => {
    const checkpoint = { ...terminalCheckpoint, data }

    expect(data.length).toBe(MAX_TERMINAL_CHECKPOINT_DATA_LENGTH)
    expect(terminalCheckpointSchema.safeParse(checkpoint).success).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8')).toBeGreaterThan(
      MAX_TERMINAL_CHECKPOINT_DATA_LENGTH
    )
  })

  it('keeps command argv request-only and rejects it in persisted launch metadata', () => {
    const persisted = { cwd: '/tmp', rows: 24, cols: 80 }
    expect(terminalLaunchMetadataSchema.safeParse(persisted).success).toBe(true)
    expect(
      terminalLaunchMetadataSchema.safeParse({ ...persisted, command: ['cargo', 'test'] }).success
    ).toBe(false)
    expect(
      terminalLaunchRequestSchema.safeParse({ ...persisted, command: ['cargo', 'test'] }).success
    ).toBe(true)
    expect(terminalLaunchRequestSchema.safeParse({ ...persisted, command: null }).success).toBe(
      false
    )
  })

  it.each([
    ['https://example.test/reference', true],
    ['http://localhost:8080/path', true],
    ['HTTPS://example.test', false],
    ['https://user@example.test', false],
    ['https://example.test?q=1', true],
    ['https://example.test/#fragment', true],
    ['https://example.test\\ambiguous', false],
    [' https://example.test', false]
  ])('applies safe canonical browser URL policy to %s', (url, expected) => {
    expect(browserPlaceholderMetadataSchema.safeParse({ url }).success).toBe(expected)
  })

  it('validates authoritative browser state, commands, observations, and changed events', () => {
    const state = {
      browserSessionId: '50000000-0000-4000-8000-000000000001',
      url: 'https://example.test/search?q=rust#results',
      navigationTitle: 'Search results',
      canBack: true,
      canForward: false,
      loading: false,
      devToolsOpen: true,
      profilePartition: 'persist:workspace-1',
      stateRevision: 7,
      correlationId: 'navigate:7'
    }
    expect(browserSessionStateSchema.parse(state)).toEqual(state)
    expect(browserSessionStateSchema.safeParse({ ...state, correlationId: null }).success).toBe(
      true
    )
    expect(
      browserObserveParamsSchema.safeParse({
        workspaceId: '10000000-0000-4000-8000-000000000001',
        tabId: '40000000-0000-4000-8000-000000000001',
        state
      }).success
    ).toBe(true)
    expect(
      browserNavigateParamsSchema.safeParse({
        browserSessionId: state.browserSessionId,
        url: 'https://example.test/next?q=1#details',
        expectedStateRevision: 7,
        correlationId: 'navigate:8'
      }).success
    ).toBe(true)
    expect(
      browserBackParamsSchema.safeParse({
        browserSessionId: state.browserSessionId,
        expectedStateRevision: 7,
        correlationId: 'back:8'
      }).success
    ).toBe(true)
    expect(browserChangedEventSchema.safeParse({ state }).success).toBe(true)
    expect(
      domainEventSchema.safeParse({ event: 'browser.changed', revision: 8, data: { state } })
        .success
    ).toBe(true)

    for (const invalid of [
      { ...state, browserSessionId: 'invalid' },
      { ...state, url: 'file:///tmp/private' },
      { ...state, navigationTitle: 'bad\ntitle' },
      { ...state, profilePartition: 'persist:../escape' },
      { ...state, stateRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...state, correlationId: 'navigate/7' }
    ]) {
      expect(browserSessionStateSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('accepts atomic newBrowser split content and rejects unsafe partitions', () => {
    const base = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      targetPaneId: '30000000-0000-4000-8000-000000000001',
      axis: 'horizontal',
      ratio: 0.5,
      placement: 'after',
      content: {
        kind: 'newBrowser',
        url: 'https://example.test/docs?q=split#browser',
        profilePartition: 'persist:workspace-1'
      }
    }
    expect(paneSplitParamsSchema.safeParse(base).success).toBe(true)
    expect(
      paneSplitParamsSchema.safeParse({
        ...base,
        content: { ...base.content, profilePartition: 'persist:../escape' }
      }).success
    ).toBe(false)
  })

  it('accepts omitted optional terminal attachment fields', () => {
    const parsed = terminalAttachResultSchema.safeParse({
      terminal: terminalDescriptor,
      output: [],
      lastSequence: 0,
      reconstructionComplete: true
    })

    expect(parsed.success).toBe(true)
  })

  it.each([
    ['processId', { terminal: { ...terminalDescriptor, processId: null } }],
    ['exitCode', { terminal: { ...terminalDescriptor, exitCode: null } }],
    ['checkpoint', { terminal: terminalDescriptor, checkpoint: null }]
  ])('rejects null for the optional terminal attachment %s field', (_, fields) => {
    const parsed = terminalAttachResultSchema.safeParse({
      output: [],
      lastSequence: 0,
      reconstructionComplete: true,
      ...fields
    })

    expect(parsed.success).toBe(false)
  })

  it('accepts an omitted resync terminal id and rejects null', () => {
    expect(
      terminalEventSchema.safeParse({ event: 'terminal.resyncRequired', data: {} }).success
    ).toBe(true)
    expect(
      terminalEventSchema.safeParse({
        event: 'terminal.resyncRequired',
        data: { terminalId: null }
      }).success
    ).toBe(false)
  })

  it('accepts only strict sorted bounded terminal listening-port metadata', () => {
    const terminalId = '3d813cbb-47fb-4fd5-9a6b-a0091f4d2a30'
    expect(
      terminalRuntimeMetadataResultSchema.safeParse({
        terminalId,
        listeningPorts: [3000, 5173]
      }).success
    ).toBe(true)
    for (const listeningPorts of [
      [0],
      [5173, 3000],
      [3000, 3000],
      Array.from({ length: 17 }, (_, index) => index + 1)
    ]) {
      expect(
        terminalRuntimeMetadataResultSchema.safeParse({ terminalId, listeningPorts }).success
      ).toBe(false)
    }
  })

  it('parses the shared recursive Milestone 2 fixture with stable order and explicit clears', () => {
    const snapshot = applicationSnapshotSchema.parse(milestone2Fixture)

    expect(snapshot.workspaces[0]?.panes.map(({ id }) => id)).toEqual([
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002'
    ])
    expect(snapshot.workspaces[0]?.tabs).toHaveLength(3)
    expect(snapshot.shortcutOverrides[1]).toEqual({
      commandId: 'tab.close',
      shortcut: null
    })
  })

  it('rejects every shared invalid projection vector at the Zod graph boundaries', () => {
    for (const testCase of invalidProjectionFixture.cases) {
      const invalid = structuredClone(milestone2Fixture)
      applyProjectionOperations(invalid, testCase.operations)
      expect(
        applicationSnapshotSchema.safeParse(invalid).success,
        `application boundary accepted invalid projection: ${testCase.name}`
      ).toBe(false)
      if (testCase.boundary === 'workspace') {
        const workspace = getProjectionValue(invalid, '/workspaces/0')
        expect(
          workspaceSnapshotSchema.safeParse(workspace).success,
          `workspace boundary accepted invalid projection: ${testCase.name}`
        ).toBe(false)
      }
    }
  })

  it('rejects malformed UUIDs, invalid split ratios, and incomplete recursive nodes', () => {
    const fixture = structuredClone(applicationSnapshotSchema.parse(milestone2Fixture))
    fixture.selectedWorkspaceId = 'not-a-uuid'
    expect(applicationSnapshotSchema.safeParse(fixture).success).toBe(false)

    const invalidRatio = structuredClone(applicationSnapshotSchema.parse(milestone2Fixture))
    const workspace = invalidRatio.workspaces[0]
    if (!workspace || workspace.layout.kind !== 'split') throw new Error('fixture must be split')
    workspace.layout.ratio = 0.99
    expect(applicationSnapshotSchema.safeParse(invalidRatio).success).toBe(false)

    expect(
      paneSplitParamsSchema.safeParse({
        workspaceId: '10000000-0000-4000-8000-000000000001',
        targetPaneId: '30000000-0000-4000-8000-000000000001',
        axis: 'horizontal',
        ratio: 0.5,
        placement: 'after',
        content: { kind: 'existingTab' }
      }).success
    ).toBe(false)
  })

  it('rejects duplicate panes and structurally inconsistent tab ownership', () => {
    const duplicatePane = structuredClone(applicationSnapshotSchema.parse(milestone2Fixture))
    const duplicateWorkspace = duplicatePane.workspaces[0]
    const pane = duplicateWorkspace?.panes[0]
    if (!duplicateWorkspace || !pane) throw new Error('fixture must contain a pane')
    duplicateWorkspace.panes.push(pane)
    expect(applicationSnapshotSchema.safeParse(duplicatePane).success).toBe(false)

    const wrongOwner = structuredClone(applicationSnapshotSchema.parse(milestone2Fixture))
    const tab = wrongOwner.workspaces[0]?.tabs[0]
    if (!tab) throw new Error('fixture must contain a tab')
    tab.paneId = '30000000-0000-4000-8000-000000000002'
    expect(applicationSnapshotSchema.safeParse(wrongOwner).success).toBe(false)

    const duplicateRuntime = structuredClone(applicationSnapshotSchema.parse(milestone2Fixture))
    const firstContent = duplicateRuntime.workspaces[0]?.tabs[0]?.content
    const secondContent = duplicateRuntime.workspaces[0]?.tabs[1]?.content
    if (
      firstContent?.kind !== 'terminal' ||
      !firstContent.runtimeSessionId ||
      secondContent?.kind !== 'terminal'
    ) {
      throw new Error('fixture must contain two terminal tabs')
    }
    secondContent.runtimeSessionId = firstContent.runtimeSessionId
    expect(applicationSnapshotSchema.safeParse(duplicateRuntime).success).toBe(false)
  })

  it('distinguishes omitted, set, and explicit-clear update values', () => {
    const identity = { workspaceId: '10000000-0000-4000-8000-000000000001' }
    expect(workspaceUpdateParamsSchema.parse(identity)).toEqual(identity)
    expect(
      workspaceUpdateParamsSchema.parse({ ...identity, description: { value: null } }).description
    ).toEqual({ value: null })
    expect(
      tabUpdateParamsSchema.safeParse({
        ...identity,
        tabId: '40000000-0000-4000-8000-000000000001',
        customTitle: null
      }).success
    ).toBe(false)
  })

  it('parses shared default, override, effective, and explicit-clear shortcut settings', () => {
    const settings = settingsGetResultSchema.parse(milestone2SettingsFixture)

    expect(settings.shortcuts.slice(0, 3).map(({ overrideState }) => overrideState.kind)).toEqual([
      'default',
      'set',
      'cleared'
    ])
    expect(settings.shortcuts).toHaveLength(12)
    expect(settings.shortcuts[2]?.effectiveShortcut).toBeNull()
  })

  it('rejects inconsistent effective shortcuts and duplicate command catalog entries', () => {
    const inconsistent = structuredClone(settingsGetResultSchema.parse(milestone2SettingsFixture))
    const cleared = inconsistent.shortcuts[2]
    if (!cleared) throw new Error('fixture must contain a cleared shortcut')
    cleared.effectiveShortcut = cleared.defaultShortcut
    expect(settingsGetResultSchema.safeParse(inconsistent).success).toBe(false)

    const duplicate = structuredClone(settingsGetResultSchema.parse(milestone2SettingsFixture))
    const first = duplicate.shortcuts[0]
    if (!first) throw new Error('fixture must contain a shortcut')
    duplicate.shortcuts.push(first)
    expect(settingsGetResultSchema.safeParse(duplicate).success).toBe(false)
  })

  it('requires revisions on mutation results and domain invalidations', () => {
    expect(mutationResultSchema.parse({ revision: 42, snapshot: milestone2Fixture }).revision).toBe(
      42
    )
    expect(mutationResultSchema.safeParse({ snapshot: milestone2Fixture }).success).toBe(false)
    expect(
      mutationResponseEnvelopeSchema.safeParse({
        id: 'request-2',
        ok: true,
        result: { revision: 42, snapshot: milestone2Fixture }
      }).success
    ).toBe(false)
    expect(
      domainEventSchema.safeParse({
        event: 'pane.layoutChanged',
        revision: 43,
        data: {
          revision: 43,
          workspaceIds: ['10000000-0000-4000-8000-000000000001'],
          paneIds: ['30000000-0000-4000-8000-000000000002'],
          tabIds: [],
          commandIds: [],
          reason: 'pane.split'
        }
      }).success
    ).toBe(true)
    expect(
      domainEventSchema.safeParse({
        event: 'pane.layoutChanged',
        revision: 44,
        data: {
          revision: 43,
          workspaceIds: [],
          paneIds: [],
          tabIds: [],
          commandIds: [],
          reason: 'pane.split'
        }
      }).success
    ).toBe(false)
  })

  it('validates notification targets, text, timestamps, and list ordering', () => {
    const notification = {
      id: '60000000-0000-4000-8000-000000000001',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      tabId: '40000000-0000-4000-8000-000000000001',
      source: 'agentHook' as const,
      level: 'warning' as const,
      title: 'Needs attention',
      body: 'Review the output',
      createdAt: 100
    }
    expect(notificationSnapshotSchema.safeParse(notification).success).toBe(true)
    expect(notificationSnapshotSchema.safeParse({ ...notification, readAt: 99 }).success).toBe(
      false
    )
    expect(
      notificationPublishParamsSchema.safeParse({
        target: { workspaceId: notification.workspaceId, tabId: notification.tabId },
        source: 'cli',
        level: 'error',
        title: 'x'.repeat(256)
      }).success
    ).toBe(true)
    expect(
      notificationPublishParamsSchema.safeParse({
        target: { workspaceId: notification.workspaceId },
        source: 'cli',
        level: 'error',
        title: 'x'.repeat(257)
      }).success
    ).toBe(false)
    expect(
      notificationListResultSchema.safeParse({
        revision: 1,
        notifications: [
          notification,
          { ...notification, id: '60000000-0000-4000-8000-000000000002', createdAt: 101 }
        ],
        total: 2,
        unreadCount: 2
      }).success
    ).toBe(false)
    const createdEvent = {
      event: 'notification.created',
      revision: 2,
      data: { notification }
    }
    expect(domainEventSchema.safeParse(createdEvent).success).toBe(true)
    expect(terminalEventSchema.safeParse(createdEvent).success).toBe(false)
  })

  it('defaults and bounds notification pagination and keeps clear scopes strict', () => {
    expect(notificationListParamsSchema.parse({})).toEqual({
      unreadOnly: false,
      offset: 0,
      limit: 50
    })
    expect(notificationListParamsSchema.safeParse({ limit: 1 }).success).toBe(true)
    expect(notificationListParamsSchema.safeParse({ limit: 200 }).success).toBe(true)
    expect(notificationListParamsSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(notificationListParamsSchema.safeParse({ limit: 201 }).success).toBe(false)
    expect(notificationClearParamsSchema.safeParse({ scope: { kind: 'all' } }).success).toBe(true)
    expect(
      notificationClearParamsSchema.safeParse({
        scope: { kind: 'all', notificationId: '60000000-0000-4000-8000-000000000001' }
      }).success
    ).toBe(false)
  })

  it('rejects structurally invalid attention and empty settings updates', () => {
    expect(
      attentionSummarySchema.safeParse({
        unreadCount: 0,
        highestLevel: null,
        latestUnread: null
      }).success
    ).toBe(true)
    expect(
      attentionSummarySchema.safeParse({
        unreadCount: 1,
        highestLevel: null,
        latestUnread: null
      }).success
    ).toBe(false)
    expect(settingsUpdateParamsSchema.safeParse({}).success).toBe(false)
    expect(
      settingsUpdateParamsSchema.safeParse({
        notifications: { systemEnabled: false, includeBody: true }
      }).success
    ).toBe(true)
    expect(
      settingsUpdateParamsSchema.safeParse({
        notifications: { systemEnabled: true, includeBody: false },
        extra: true
      }).success
    ).toBe(false)
  })

  it('validates fixed workspace card slots and their targeted invalidation', () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const replacement = {
      workspaceId,
      expectedRevision: 0,
      agentStatus: { status: 'running', label: 'Reviewing changes' },
      progress: { mode: 'determinate', value: 42, label: 'Tests' }
    }
    expect(workspaceCardSlotsReplaceParamsSchema.safeParse(replacement).success).toBe(true)
    expect(
      workspaceCardSlotsSnapshotSchema.safeParse({
        workspaceId,
        revision: 1,
        agentStatus: replacement.agentStatus,
        progress: replacement.progress
      }).success
    ).toBe(true)
    expect(
      workspaceCardSlotsChangedEventSchema.safeParse({
        event: 'workspace.cardSlotsChanged',
        data: { workspaceId, slotRevision: 1, reason: 'slotsReplaced' }
      }).success
    ).toBe(true)
    expect(
      workspaceCardSlotsReplaceParamsSchema.safeParse({
        ...replacement,
        progress: { mode: 'determinate', value: 101, label: null }
      }).success
    ).toBe(false)
    expect(
      workspaceCardSlotsReplaceParamsSchema.safeParse({
        ...replacement,
        progress: { mode: 'indeterminate', label: '' }
      }).success
    ).toBe(false)
    expect(
      workspaceCardSlotsReplaceParamsSchema.safeParse({
        ...replacement,
        agentStatus: { status: 'paused', label: null }
      }).success
    ).toBe(false)
    expect(
      workspaceCardSlotsReplaceParamsSchema.safeParse({
        ...replacement,
        agentStatus: { status: 'running', label: 'x'.repeat(121) }
      }).success
    ).toBe(false)
    expect(
      workspaceCardSlotsReplaceParamsSchema.safeParse({ ...replacement, custom: {} }).success
    ).toBe(false)
  })

  it('validates bounded card-slot v2 unions, semantic matching, and hostile inputs', () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const replacement = {
      workspaceId,
      kind: 'metadata',
      expectedRevision: 0,
      payload: {
        kind: 'metadata',
        value: { rows: [{ key: 'Branch', value: 'main' }] }
      }
    }
    expect(workspaceCardSlotV2ReplaceParamsSchema.safeParse(replacement).success).toBe(true)
    expect(
      workspaceCardSlotV2SnapshotSchema.safeParse({
        workspaceId,
        kind: 'markdown',
        slotRevision: 3,
        payload: { kind: 'markdown', value: { source: '# Safe\n\n`code`' } }
      }).success
    ).toBe(true)
    expect(
      workspaceCardSlotV2ChangedEventSchema.safeParse({
        event: 'workspace.cardSlots.v2Changed',
        data: { workspaceId, kind: 'logTail', slotRevision: 4, reason: 'resyncRequired' }
      }).success
    ).toBe(true)
    expect(
      workspaceCardSlotV2ReplaceParamsSchema.safeParse({
        ...replacement,
        kind: 'ssh'
      }).success
    ).toBe(false)
    expect(
      workspaceCardSlotV2ReplaceParamsSchema.safeParse({
        ...replacement,
        payload: {
          kind: 'metadata',
          value: {
            rows: [
              { key: 'Branch', value: 'main' },
              { key: 'branch', value: 'other' }
            ]
          }
        }
      }).success
    ).toBe(false)
    for (const value of [
      {
        kind: 'logTail',
        payload: { kind: 'logTail', value: { lines: ['\u001b[31mred'], truncated: false } }
      },
      {
        kind: 'pullRequest',
        payload: {
          kind: 'pullRequest',
          value: {
            provider: 'GitHub',
            number: 1,
            title: 'Unsafe',
            lifecycle: 'open',
            checks: 'pending',
            url: 'http://example.com'
          }
        }
      },
      {
        kind: 'media',
        payload: {
          kind: 'media',
          value: {
            mediaKind: 'video',
            state: 'playing',
            label: 'Demo',
            url: 'https://evil.invalid'
          }
        }
      }
    ]) {
      expect(
        workspaceCardSlotV2ReplaceParamsSchema.safeParse({
          workspaceId,
          expectedRevision: 0,
          ...value
        }).success
      ).toBe(false)
    }
  })

  it.each([
    'https://user:secret@example.test/pr/1',
    'HTTPS://example.test/pr/1',
    ' https://example.test/pr/1',
    'https://example.test/pr/1\n',
    'https://example.test\\pr\\1',
    'http://example.test/pr/1',
    'file:///tmp/pr/1',
    'javascript:alert(1)'
  ])('rejects unsafe or noncanonical pull-request URL %s', (url) => {
    expect(
      pullRequestCardSlotSchema.safeParse({
        provider: 'GitHub',
        number: 1,
        title: 'Unsafe',
        lifecycle: 'open',
        checks: 'pending',
        url
      }).success
    ).toBe(false)
  })

  it('validates strict authoritative attention snapshots, invalidations, and acknowledgements', () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001'
    const notificationId = '20000000-0000-4000-8000-000000000002'
    const snapshot = {
      workspaceId,
      revision: 4,
      state: 'urgent',
      reason: 'notificationError',
      unreadCount: 1,
      notificationId,
      paneId: '30000000-0000-4000-8000-000000000003',
      tabId: '40000000-0000-4000-8000-000000000004'
    }
    expect(workspaceAttentionSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(
      workspaceAttentionSnapshotSchema.safeParse({ ...snapshot, notificationId: null }).success
    ).toBe(false)
    expect(
      workspaceAttentionSnapshotSchema.safeParse({
        ...snapshot,
        state: 'waiting',
        reason: 'agentFailed',
        notificationId: undefined,
        paneId: undefined,
        tabId: undefined
      }).success
    ).toBe(false)
    expect(
      workspaceAttentionSnapshotSchema.safeParse({
        ...snapshot,
        state: 'waiting',
        reason: 'agentWaiting',
        notificationId: undefined,
        paneId: snapshot.paneId
      }).success
    ).toBe(false)
    expect(
      workspaceAttentionChangedEventSchema.safeParse({
        event: 'workspace.attentionChanged',
        data: { workspaceId, attentionRevision: 4, reason: 'resyncRequired' }
      }).success
    ).toBe(true)
    const acknowledgement = {
      notificationId,
      expectedRevision: 4,
      idempotencyKey: '50000000-0000-4000-8000-000000000005',
      mode: 'focused'
    }
    expect(attentionAcknowledgementParamsSchema.safeParse(acknowledgement).success).toBe(true)
    expect(
      attentionAcknowledgementResultSchema.safeParse({ revision: 4, attention: snapshot }).success
    ).toBe(true)
    expect(
      attentionAcknowledgementResultSchema.safeParse({ revision: 5, attention: snapshot }).success
    ).toBe(false)
  })

  it('matches the canonical Rust attention contract fixtures', () => {
    for (const fixture of attentionContractFixture.cases) {
      expect(workspaceAttentionSnapshotSchema.safeParse(fixture.value).success, fixture.name).toBe(
        fixture.valid
      )
    }
  })

  it('accepts only revision-matched enveloped multi-window wire events', () => {
    const topology = {
      event: 'window.topologyChanged' as const,
      revision: 8,
      data: {
        event: 'window.topologyChanged' as const,
        revision: 8,
        idempotencyEpoch: '10000000-0000-4000-8000-000000000001',
        windowIds: ['20000000-0000-4000-8000-000000000001'],
        reason: 'windowCreated' as const
      }
    }
    const placement = (windowId: string) => ({
      windowId,
      workspaceId: '30000000-0000-4000-8000-000000000001',
      paneId: '40000000-0000-4000-8000-000000000001',
      index: 0,
      windowRevision: 4
    })
    const ownership = {
      event: 'tab.ownershipTransferred' as const,
      revision: 9,
      data: {
        event: 'tab.ownershipTransferred' as const,
        revision: 9,
        transferEpoch: 9,
        tabId: '50000000-0000-4000-8000-000000000001',
        runtimeSessionId: '60000000-0000-4000-8000-000000000001',
        ownershipKind: 'terminal' as const,
        source: placement('70000000-0000-4000-8000-000000000001'),
        target: placement('70000000-0000-4000-8000-000000000002'),
        reason: 'tabMoved' as const
      }
    }

    expect(multiWindowProtocolEventSchema.safeParse(topology).success).toBe(true)
    expect(protocolEventSchema.safeParse(ownership).success).toBe(true)
    expect(multiWindowProtocolEventSchema.safeParse({ ...topology, revision: 7 }).success).toBe(
      false
    )
    expect(protocolEventSchema.safeParse(topology.data).success).toBe(false)
  })

  it('requires an exact former owner only for provider recovery adoption', () => {
    const source = {
      windowId: '70000000-0000-4000-8000-000000000001',
      generation: 7
    }
    const target = {
      windowId: '70000000-0000-4000-8000-000000000002',
      generation: 9
    }
    const recovery = {
      requestId: '10000000-0000-4000-8000-000000000001',
      correlationId: '20000000-0000-4000-8000-000000000001',
      attemptEpoch: 3,
      operation: 'recoverOwnership' as const,
      source,
      target,
      tabId: '30000000-0000-4000-8000-000000000001',
      runtimeSessionId: '40000000-0000-4000-8000-000000000001',
      transferEpoch: 11,
      workspaceId: '50000000-0000-4000-8000-000000000001',
      paneId: '60000000-0000-4000-8000-000000000001',
      ownershipKind: 'terminal' as const
    }

    expect(desktopProviderRequestSchema.safeParse(recovery).success).toBe(true)
    expect(desktopProviderRequestSchema.safeParse({ ...recovery, source: undefined }).success).toBe(
      false
    )
    expect(desktopProviderRequestSchema.safeParse({ ...recovery, source: target }).success).toBe(
      false
    )
    expect(
      desktopProviderRequestSchema.safeParse({ ...recovery, operation: 'attachOwnership' }).success
    ).toBe(false)
  })
})
