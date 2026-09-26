import { z } from 'zod'

// The Rust SQLite snapshot stores keyed pane and tab records. This is distinct
// from the array-based application snapshot sent to renderers.
const id = z.string().uuid()
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const normalizedText = (maximum: number, allowEmpty = false) =>
  z
    .string()
    .refine((value) => value === value.trim() && (allowEmpty || value.length > 0))
    .refine((value) => [...value].length <= maximum)

const terminalContent = z.strictObject({
  kind: z.literal('terminal'),
  launch: z.strictObject({
    cwd: z.string().startsWith('/'),
    rows: z.number().int().min(1).max(1_000),
    cols: z.number().int().min(1).max(1_000)
  })
})

const browserContent = z.strictObject({
  kind: z.literal('browser'),
  metadata: z.object({
    browserSessionId: id.optional(),
    url: z.string(),
    navigationTitle: z.string().optional(),
    canBack: z.boolean().optional(),
    canForward: z.boolean().optional(),
    loading: z.boolean().optional(),
    devToolsOpen: z.boolean().optional(),
    profilePartition: z.string().optional(),
    stateRevision: safeInteger.optional(),
    correlationId: z.string().nullable().optional()
  })
})

const tab = z.strictObject({
  id,
  paneId: id,
  title: normalizedText(256),
  customTitle: normalizedText(256).nullable(),
  content: z.discriminatedUnion('kind', [terminalContent, browserContent]),
  createdAt: safeInteger
})

const pane = z.strictObject({
  id,
  tabs: z.array(id).min(1),
  selectedTabId: id,
  title: normalizedText(256).nullable()
})

const workspace = z.strictObject({
  id,
  name: normalizedText(128),
  description: normalizedText(4_096, true).nullable(),
  color: normalizedText(64).nullable(),
  workingDirectory: z.string().startsWith('/'),
  layout: z.unknown(),
  selectedPaneId: id,
  panes: z.record(id, pane),
  tabs: z.record(id, tab),
  createdAt: safeInteger,
  updatedAt: safeInteger
})

const windowPlacement = z.strictObject({
  id,
  label: normalizedText(128),
  workspaceIds: z.array(id).min(1),
  focusedWorkspaceId: id,
  hostingState: z.enum(['hosted', 'unhosted', 'closing']),
  revision: safeInteger
})

const focusTarget = z.strictObject({
  windowId: id,
  workspaceId: id,
  paneId: id,
  tabId: id
})

export const durableWorkspaceStructureSchema = z.looseObject({
  revision: safeInteger,
  workspaces: z.array(workspace).min(1),
  selectedWorkspaceId: id,
  workspaceSelection: z.array(id).optional(),
  workspacePins: z.array(id).optional(),
  windowPlacements: z.array(windowPlacement).min(1).max(16),
  focusedWindowId: id,
  focusHistory: z.strictObject({
    entries: z.array(focusTarget).max(128),
    cursor: safeInteger
  })
})

type DurableWorkspaceStructure = z.infer<typeof durableWorkspaceStructureSchema>
type DurableWorkspace = DurableWorkspaceStructure['workspaces'][number]

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function validLayout(layout: unknown, paneIds: Set<string>, globalSplitIds: Set<string>): boolean {
  const leaves: string[] = []
  const nodes: unknown[] = [layout]
  while (nodes.length > 0) {
    const node = nodes.pop()
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
    const value = node as Record<string, unknown>
    if (value.kind === 'leaf') {
      const paneId = value.paneId ?? value.pane_id
      if (Object.keys(value).length !== 2 || !id.safeParse(paneId).success) return false
      leaves.push(paneId as string)
    } else if (value.kind === 'split') {
      const splitId = value.splitId ?? value.split_id
      if (
        Object.keys(value).length !== 6 ||
        !id.safeParse(splitId).success ||
        globalSplitIds.has(splitId as string) ||
        (value.axis !== 'horizontal' && value.axis !== 'vertical') ||
        typeof value.ratio !== 'number' ||
        value.ratio < 0.05 ||
        value.ratio > 0.95 ||
        Math.round(value.ratio * 1_000_000) / 1_000_000 !== value.ratio
      )
        return false
      globalSplitIds.add(splitId as string)
      nodes.push(value.first, value.second)
    } else return false
  }
  return (
    leaves.length === paneIds.size && unique(leaves) && leaves.every((value) => paneIds.has(value))
  )
}

function validWorkspace(
  workspace: DurableWorkspace,
  paneIds: Set<string>,
  tabIds: Set<string>,
  splitIds: Set<string>
): boolean {
  const localPaneIds = new Set(Object.keys(workspace.panes))
  const localTabIds = new Set(Object.keys(workspace.tabs))
  if (
    !localPaneIds.has(workspace.selectedPaneId) ||
    !validLayout(workspace.layout, localPaneIds, splitIds)
  )
    return false
  const ownedTabs = new Set<string>()
  for (const [paneId, paneValue] of Object.entries(workspace.panes)) {
    if (
      paneId !== paneValue.id ||
      paneIds.has(paneId) ||
      !paneValue.tabs.includes(paneValue.selectedTabId)
    )
      return false
    paneIds.add(paneId)
    for (const tabId of paneValue.tabs) {
      if (ownedTabs.has(tabId) || workspace.tabs[tabId]?.paneId !== paneId) return false
      ownedTabs.add(tabId)
    }
  }
  if (ownedTabs.size !== localTabIds.size) return false
  for (const [tabId, tabValue] of Object.entries(workspace.tabs)) {
    if (tabId !== tabValue.id || !ownedTabs.has(tabId) || tabIds.has(tabId)) return false
    tabIds.add(tabId)
  }
  return true
}

function validFocusTarget(
  value: DurableWorkspaceStructure,
  target: z.infer<typeof focusTarget>
): boolean {
  const placement = value.windowPlacements.find((entry) => entry.id === target.windowId)
  const workspaceValue = value.workspaces.find((entry) => entry.id === target.workspaceId)
  return Boolean(
    placement?.workspaceIds.includes(target.workspaceId) &&
    workspaceValue?.panes[target.paneId]?.tabs.includes(target.tabId) &&
    workspaceValue.tabs[target.tabId]?.paneId === target.paneId
  )
}

/** Validates the durable workspace graph and window ownership before migration. */
export const durableWorkspaceSnapshotSchema = durableWorkspaceStructureSchema.refine((value) => {
  const workspaceIds = value.workspaces.map((entry) => entry.id)
  const workspaceSet = new Set(workspaceIds)
  if (!unique(workspaceIds) || !workspaceSet.has(value.selectedWorkspaceId)) return false
  const selection = value.workspaceSelection ?? [value.selectedWorkspaceId]
  if (
    !unique(selection) ||
    !selection.includes(value.selectedWorkspaceId) ||
    selection.some((item) => !workspaceSet.has(item))
  )
    return false
  if (
    value.workspacePins &&
    (!unique(value.workspacePins) || value.workspacePins.some((item) => !workspaceSet.has(item)))
  )
    return false

  const paneIds = new Set<string>()
  const tabIds = new Set<string>()
  const splitIds = new Set<string>()
  if (value.workspaces.some((item) => !validWorkspace(item, paneIds, tabIds, splitIds)))
    return false

  const windowIds = value.windowPlacements.map((entry) => entry.id)
  if (!unique(windowIds) || !windowIds.includes(value.focusedWindowId)) return false
  const ownedWorkspaces: string[] = []
  for (const placement of value.windowPlacements) {
    if (
      !unique(placement.workspaceIds) ||
      !placement.workspaceIds.includes(placement.focusedWorkspaceId)
    )
      return false
    ownedWorkspaces.push(...placement.workspaceIds)
  }
  if (
    !unique(ownedWorkspaces) ||
    ownedWorkspaces.length !== workspaceSet.size ||
    ownedWorkspaces.some((item) => !workspaceSet.has(item))
  )
    return false
  const { entries, cursor } = value.focusHistory
  if ((entries.length === 0 && cursor !== 0) || (entries.length > 0 && cursor >= entries.length))
    return false
  return entries.every((entry) => validFocusTarget(value, entry))
})

export type DurableWorkspaceSnapshot = z.infer<typeof durableWorkspaceSnapshotSchema>
