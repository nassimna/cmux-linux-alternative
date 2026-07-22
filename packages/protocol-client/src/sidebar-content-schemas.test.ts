import { describe, expect, it } from 'vitest'
import {
  contentPreviewSchema,
  contentSaveParamsSchema,
  contentDocumentIssueParamsSchema,
  recentlyClosedReopenParamsSchema,
  safeMarkdownDocumentSchema,
  searchExportConfirmationIssueResultSchema,
  searchExportResultSchema,
  searchRebuildParamsSchema,
  sidebarPlacementSchema,
  taskActionParamsSchema,
  taskSummarySchema,
  workspaceDirectoryListParamsSchema,
  workspaceRootListResultSchema
} from './schemas'

const id = '00000000-0000-4000-8000-000000000001'
const mutation = { idempotencyKey: id, requestHash: 'a'.repeat(64), expectedRevision: 1 }
const target = { sessionId: id, generation: 1, revision: 1 }
const confirmation = {
  invocationId: id,
  action: 'terminate',
  kind: 'agent',
  target,
  providerId: id,
  providerEpoch: 1,
  providerLeaseId: id,
  windowId: id,
  windowGeneration: 1,
  requestHash: 'a'.repeat(64),
  nonce: id,
  expiresAtMs: 1
}

describe('sidebar and content schemas', () => {
  it('requires the exact eight-surface registry and a selected enabled surface', () => {
    const placement = {
      windowId: id,
      revision: 1,
      side: 'left',
      width: 320,
      enabled: ['textBox'],
      order: [
        'textBox',
        'vault',
        'taskManager',
        'files',
        'markdown',
        'diff',
        'search',
        'recentlyClosed'
      ],
      selected: 'textBox'
    }
    expect(sidebarPlacementSchema.safeParse(placement).success).toBe(true)
    expect(
      sidebarPlacementSchema.safeParse({ ...placement, order: placement.order.slice(0, 7) }).success
    ).toBe(false)
    expect(sidebarPlacementSchema.safeParse({ ...placement, selected: 'vault' }).success).toBe(
      false
    )
  })

  it('bounds saves by UTF-8 bytes and rejects unknown authority-bearing fields', () => {
    const save = {
      document: { documentId: id, identityVersion: 1 },
      expectedRevision: 1,
      text: 'x'.repeat(256 * 1024),
      mutation
    }
    expect(contentSaveParamsSchema.safeParse(save).success).toBe(true)
    expect(contentSaveParamsSchema.safeParse({ ...save, text: `${save.text}x` }).success).toBe(
      false
    )
    expect(
      contentSaveParamsSchema.safeParse({ ...save, filesystemPath: '/tmp/secret' }).success
    ).toBe(false)
  })

  it('keeps workspace file access opaque, generated, and cancellable', () => {
    const root = {
      rootId: id,
      directoryDescriptorId: id,
      workspaceId: id,
      label: 'workspace',
      generation: 1
    }
    expect(
      workspaceRootListResultSchema.safeParse({ roots: [root], nextCursor: null }).success
    ).toBe(true)
    expect(workspaceRootListResultSchema.safeParse({ roots: [root] }).success).toBe(false)
    expect(
      workspaceRootListResultSchema.safeParse({ roots: [{ ...root, path: '/secret' }] }).success
    ).toBe(false)
    expect(
      workspaceDirectoryListParamsSchema.safeParse({
        directoryDescriptorId: id,
        generation: 1,
        limit: 10,
        cancellationId: id
      }).success
    ).toBe(true)
    expect(
      contentDocumentIssueParamsSchema.safeParse({
        authorizedDescriptorId: id,
        descriptorGeneration: 1,
        expectedKind: 'plainText'
      }).success
    ).toBe(true)
    expect(
      searchRebuildParamsSchema.safeParse({
        sourceAuthorizationId: id,
        cancellationId: id,
        mutation
      }).success
    ).toBe(true)
    expect(
      searchRebuildParamsSchema.safeParse({ sourceAuthorizationId: id, mutation }).success
    ).toBe(false)
  })

  it('requires exact placement and epoch for recently-closed reopen', () => {
    const reopen = {
      recentlyClosedId: id,
      authorizedDescriptorId: id,
      action: 'reopenTerminal',
      expectedRevision: 1,
      idempotencyEpoch: id,
      target: {
        windowId: id,
        workspaceId: id,
        paneId: id,
        destinationIndex: 0,
        expectedWindowRevision: 1
      },
      mutation
    }
    expect(recentlyClosedReopenParamsSchema.safeParse(reopen).success).toBe(true)
    const implicit = { ...reopen }
    Reflect.deleteProperty(implicit, 'target')
    expect(recentlyClosedReopenParamsSchema.safeParse(implicit).success).toBe(false)
  })

  it('keeps markdown links safe and trees bounded', () => {
    const base = { document: { documentId: id, identityVersion: 1 }, contentRevision: 1 }
    expect(
      safeMarkdownDocumentSchema.safeParse({
        ...base,
        nodes: [{ kind: 'link', label: 'ok', href: 'https://example.com' }]
      }).success
    ).toBe(true)
    expect(
      safeMarkdownDocumentSchema.safeParse({
        ...base,
        nodes: [{ kind: 'link', label: 'bad', href: 'javascript:alert(1)' }]
      }).success
    ).toBe(false)
    let node: unknown = { kind: 'text', text: 'x' }
    for (let i = 0; i < 17; i += 1) node = { kind: 'paragraph', children: [node] }
    expect(safeMarkdownDocumentSchema.safeParse({ ...base, nodes: [node] }).success).toBe(false)
    expect(
      safeMarkdownDocumentSchema.safeParse({
        ...base,
        nodes: [{ kind: 'codeBlock', language: null, text: 'echo safe' }]
      }).success
    ).toBe(true)
    expect(
      safeMarkdownDocumentSchema.safeParse({
        ...base,
        nodes: [{ kind: 'codeBlock', text: 'echo ambiguous' }]
      }).success
    ).toBe(false)
  })

  it('matches the canonical content preview field casing', () => {
    const unavailable = {
      kind: 'unavailable',
      document: { documentId: id, identityVersion: 1 },
      reason: 'oversized',
      displayName: 'Unavailable document'
    }
    expect(contentPreviewSchema.safeParse(unavailable).success).toBe(true)
    const withoutDisplayName = { ...unavailable }
    Reflect.deleteProperty(withoutDisplayName, 'displayName')
    expect(
      contentPreviewSchema.safeParse({ ...withoutDisplayName, display_name: 'legacy' }).success
    ).toBe(false)
  })

  it('binds a bounded opaque export artifact to a service confirmation', () => {
    const confirmation = {
      confirmationId: id,
      sourceAuthorizationId: id,
      expiresAtMs: 10
    }
    expect(searchExportConfirmationIssueResultSchema.safeParse({ confirmation }).success).toBe(true)
    const artifact = {
      document: { documentId: id, identityVersion: 1 },
      offset: 0,
      text: '{"schemaVersion":1}',
      eof: true,
      contentRevision: 1,
      displayName: 'search-index-summary.json'
    }
    expect(
      searchExportResultSchema.safeParse({ sourceAuthorizationId: id, artifact }).success
    ).toBe(true)
    expect(
      searchExportResultSchema.safeParse({ sourceAuthorizationId: id, artifact, path: '/tmp/x' })
        .success
    ).toBe(false)
  })

  it('requires confirmation for destructive task actions and exposes no PID', () => {
    expect(
      taskActionParamsSchema.safeParse({ action: 'terminate', target, confirmation, mutation })
        .success
    ).toBe(true)
    expect(
      taskActionParamsSchema.safeParse({ action: 'terminate', target, mutation }).success
    ).toBe(false)
    const task = {
      target,
      kind: 'terminal',
      label: 'build',
      lifecycle: 'running',
      observation: 'lastVerified',
      ownerLabel: 'local',
      resourceSummary: null
    }
    expect(taskSummarySchema.safeParse(task).success).toBe(true)
    const missingResourceSummary = { ...task }
    Reflect.deleteProperty(missingResourceSummary, 'resourceSummary')
    expect(taskSummarySchema.safeParse(missingResourceSummary).success).toBe(false)
    expect(taskSummarySchema.safeParse({ ...task, pid: 42 }).success).toBe(false)
  })
})
