import {
  layoutTemplateSnapshotSchema,
  notificationSettingsSchema,
  shortcutOverrideSchema,
  workspaceGroupSnapshotSchema
} from '@agent-workspace/protocol-client'
import { z } from 'zod'

import {
  durableWorkspaceSnapshotSchema,
  durableWorkspaceStructureSchema
} from './durable-workspace'

const id = z.string().uuid()
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const normalizedText = (maximum: number, allowEmpty = false) =>
  z
    .string()
    .refine((value) => value === value.trim() && (allowEmpty || value.length > 0))
    .refine((value) => [...value].length <= maximum)
const safeNotificationText = (maximum: number) =>
  normalizedText(maximum).refine((value) =>
    [...value].every((character) => {
      const point = character.codePointAt(0)
      return point !== undefined && point > 0x1f && (point < 0x7f || point > 0x9f)
    })
  )

const notification = z
  .strictObject({
    id,
    workspaceId: id,
    paneId: id.nullable(),
    tabId: id.nullable(),
    source: z.enum(['cli', 'osc', 'agentHook', 'internal']),
    level: z.enum(['info', 'warning', 'error']),
    title: safeNotificationText(256),
    body: safeNotificationText(4_096).nullable(),
    createdAt: safeInteger,
    readAt: safeInteger.nullable()
  })
  .refine(({ createdAt, readAt }) => readAt === null || readAt >= createdAt)

const savedLayout = z.strictObject({
  id,
  name: normalizedText(80),
  formatVersion: z.literal(1),
  createdAt: safeInteger,
  updatedAt: safeInteger,
  template: layoutTemplateSnapshotSchema
})

const legacyOverLimit = z.strictObject({
  workspaceCount: safeInteger,
  maximumPanesInWorkspace: safeInteger,
  maximumTabsInWorkspace: safeInteger,
  totalPaneCount: safeInteger,
  totalTabCount: safeInteger
})

const closedRestore = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('terminal'),
    // Serde's enum-level rename_all changes the variant name, not these fields.
    authorized_root_id: id,
    root_relative_cwd: z
      .string()
      .refine(
        (value) =>
          !value.startsWith('/') && !value.split('/').some((part) => part === '.' || part === '..')
      ),
    rows: z.number().int().min(1).max(1_000),
    cols: z.number().int().min(1).max(1_000)
  }),
  z.strictObject({
    kind: z.literal('browser'),
    url: z.url().refine((value) => {
      const url = new URL(value)
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === '' &&
        url.href === value &&
        [...value].length <= 2_048
      )
    })
  })
])

const closedItem = z
  .strictObject({
    id,
    itemKind: z.enum(['tab', 'workspace']),
    priorWorkspaceId: id,
    priorTabId: id.nullable(),
    contentKind: z.enum(['terminal', 'browser']),
    title: normalizedText(160, true),
    closedAt: safeInteger,
    restore: closedRestore
  })
  .refine(
    ({ itemKind, priorTabId, contentKind, restore }) =>
      (itemKind !== 'tab' || priorTabId !== null) && contentKind === restore.kind
  )

const shortcut = shortcutOverrideSchema.shape.shortcut

const durableApplicationStructure = z.strictObject({
  ...durableWorkspaceStructureSchema.shape,
  workspaceSelection: z.array(id).min(1).max(128),
  workspacePins: z.array(id).max(128),
  workspaceGroups: z.array(workspaceGroupSnapshotSchema).max(128),
  workspaceGroupAssignments: z.record(id, id),
  savedLayouts: z.array(savedLayout).max(64),
  legacyOverLimit: legacyOverLimit.nullable(),
  shortcutOverrides: z.record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/u),
    shortcut
  ),
  notifications: z.array(notification).max(1_000),
  notificationSettings: notificationSettingsSchema,
  recentlyClosed: z.array(closedItem).max(100)
})

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length

/** Strict root shape plus cross-domain references for a Rust schema-v15 snapshot. */
export const durableApplicationStateSchema = durableApplicationStructure.superRefine(
  (value, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    if (!durableWorkspaceSnapshotSchema.safeParse(value).success) {
      issue('workspace graph or window ownership is invalid')
    }

    const workspaceIds = new Set(value.workspaces.map((workspace) => workspace.id))
    const groupIds = value.workspaceGroups.map((group) => group.id)
    if (!unique(groupIds) || !unique(value.workspaceGroups.map((group) => String(group.order)))) {
      issue('workspace groups have duplicate IDs or order values')
    }
    const assignments = Object.entries(value.workspaceGroupAssignments)
    if (
      assignments.length > 128 ||
      assignments.some(
        ([workspaceId, groupId]) => !workspaceIds.has(workspaceId) || !groupIds.includes(groupId)
      )
    ) {
      issue('workspace group assignments are dangling or exceed their limit')
    }
    if (!unique(value.savedLayouts.map((layout) => layout.id))) {
      issue('saved layout IDs are duplicated')
    }
    if (!unique(value.notifications.map((item) => item.id))) {
      issue('notification IDs are duplicated')
    }
    if (!unique(value.recentlyClosed.map((item) => item.id))) {
      issue('recently closed IDs are duplicated')
    }
    for (let index = 1; index < value.recentlyClosed.length; index += 1) {
      const previous = value.recentlyClosed[index - 1]!
      const current = value.recentlyClosed[index]!
      if (
        previous.closedAt > current.closedAt ||
        (previous.closedAt === current.closedAt && previous.id > current.id)
      ) {
        issue('recently closed records are not canonically ordered')
        break
      }
    }

    const counts = value.workspaces.reduce(
      (current, item) => {
        const panes = Object.keys(item.panes).length
        const tabs = Object.keys(item.tabs).length
        current.workspaceCount += 1
        current.maximumPanesInWorkspace = Math.max(current.maximumPanesInWorkspace, panes)
        current.maximumTabsInWorkspace = Math.max(current.maximumTabsInWorkspace, tabs)
        current.totalPaneCount += panes
        current.totalTabCount += tabs
        return current
      },
      {
        workspaceCount: 0,
        maximumPanesInWorkspace: 0,
        maximumTabsInWorkspace: 0,
        totalPaneCount: 0,
        totalTabCount: 0
      }
    )
    const limits = {
      workspaceCount: 128,
      maximumPanesInWorkspace: 64,
      maximumTabsInWorkspace: 128,
      totalPaneCount: 1_024,
      totalTabCount: 2_048
    }
    if (value.legacyOverLimit === null) {
      if (
        Object.keys(counts).some(
          (key) => counts[key as keyof typeof counts] > limits[key as keyof typeof limits]
        )
      ) {
        issue('workspace resource limits are exceeded without legacy reduction metadata')
      }
    } else if (
      !Object.keys(counts).every(
        (key) =>
          value.legacyOverLimit?.[key as keyof typeof counts] === counts[key as keyof typeof counts]
      ) ||
      !Object.keys(counts).some(
        (key) => counts[key as keyof typeof counts] > limits[key as keyof typeof limits]
      )
    ) {
      issue('legacy reduction metadata does not match the workspace counts')
    }
  }
)

export type DurableApplicationState = z.infer<typeof durableApplicationStateSchema>
