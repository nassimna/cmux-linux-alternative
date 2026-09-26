import { describe, expect, it } from 'vitest'
import type { WorkspaceSnapshot } from '@agent-workspace/protocol-client'

import projection from '../../../../packages/protocol-client/fixtures/milestone2-projection.json'

import {
  workspaceBatchCloseReplacement,
  workspacePresentationSections,
  workspaceCardSelectionState,
  workspaceSelectionReplacement,
  type WorkspaceOrganizationProjection
} from './organization'

function workspace(id: string, workingDirectory: string, rows = 24, cols = 80): WorkspaceSnapshot {
  const value = structuredClone(projection.workspaces[0]!) as WorkspaceSnapshot
  value.id = id
  value.name = id
  value.workingDirectory = workingDirectory
  const terminal = value.tabs.find(({ content }) => content.kind === 'terminal')
  if (terminal?.content.kind === 'terminal') {
    terminal.content.launch = { cwd: '/must-not-copy', rows, cols }
    terminal.content.runtimeSessionId = `runtime-${id}`
  }
  return value
}

const organization: WorkspaceOrganizationProjection = {
  revision: 7,
  selection: ['bravo'],
  focusedWorkspaceId: 'bravo',
  pins: ['delta', 'bravo'],
  groups: [
    { id: 'later', name: 'Later', collapsed: true, order: 2 },
    { id: 'active', name: 'Active', collapsed: false, order: 1 }
  ],
  assignments: [
    { workspaceId: 'bravo', groupId: 'active' },
    { workspaceId: 'charlie', groupId: 'active' },
    { workspaceId: 'delta', groupId: 'later' },
    { workspaceId: 'echo', groupId: 'later' }
  ]
}

describe('workspace organization presentation', () => {
  it('emits pins first, then durable group order, then ungrouped exactly once', () => {
    const sections = workspacePresentationSections(
      ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
      organization
    )

    expect(sections).toEqual([
      {
        id: 'pinned',
        kind: 'pinned',
        name: null,
        collapsed: false,
        workspaceIds: ['bravo', 'delta']
      },
      {
        id: 'active',
        kind: 'group',
        name: 'Active',
        collapsed: false,
        workspaceIds: ['charlie']
      },
      {
        id: 'later',
        kind: 'group',
        name: 'Later',
        collapsed: true,
        workspaceIds: []
      },
      {
        id: 'ungrouped',
        kind: 'ungrouped',
        name: null,
        collapsed: false,
        workspaceIds: ['alpha']
      }
    ])
  })
})

describe('workspace multi-selection replacement', () => {
  const canonical = ['alpha', 'bravo', 'charlie', 'delta', 'echo']

  it('replaces selection for an unmodified pointer or keyboard activation', () => {
    expect(
      workspaceSelectionReplacement(canonical, organization, 'delta', {
        additive: false,
        range: false
      })
    ).toEqual({ selection: ['delta'], focusedWorkspaceId: 'delta' })
  })

  it('uses focused workspace as range anchor and preserves canonical order', () => {
    expect(
      workspaceSelectionReplacement(canonical, organization, 'echo', {
        additive: false,
        range: true
      })
    ).toEqual({
      selection: ['bravo', 'charlie', 'delta', 'echo'],
      focusedWorkspaceId: 'echo'
    })
  })

  it('supports additive range and toggle while keeping a non-empty selection', () => {
    const current = { selection: ['alpha', 'charlie'], focusedWorkspaceId: 'charlie' }
    expect(
      workspaceSelectionReplacement(canonical, current, 'echo', {
        additive: true,
        range: true
      })
    ).toEqual({
      selection: ['alpha', 'charlie', 'delta', 'echo'],
      focusedWorkspaceId: 'echo'
    })
    expect(
      workspaceSelectionReplacement(canonical, current, 'alpha', {
        additive: true,
        range: false
      })
    ).toEqual({ selection: ['charlie'], focusedWorkspaceId: 'charlie' })
    expect(
      workspaceSelectionReplacement(canonical, organization, 'bravo', {
        additive: true,
        range: false
      })
    ).toEqual({ selection: ['bravo'], focusedWorkspaceId: 'bravo' })
  })

  it('always includes the focused workspace in the complete selection', () => {
    const payload = workspaceSelectionReplacement(
      canonical,
      { selection: ['bravo', 'delta'], focusedWorkspaceId: 'bravo' },
      'bravo',
      { additive: true, range: false }
    )
    expect(payload).toEqual({ selection: ['delta'], focusedWorkspaceId: 'delta' })
    expect(payload?.selection).toContain(payload?.focusedWorkspaceId)
  })

  it('distinguishes multi-selection membership from the one focused workspace', () => {
    const multi = { selection: ['alpha', 'charlie'], focusedWorkspaceId: 'charlie' }
    expect(workspaceCardSelectionState('alpha', multi)).toEqual({ selected: true, focused: false })
    expect(workspaceCardSelectionState('charlie', multi)).toEqual({ selected: true, focused: true })
    expect(workspaceCardSelectionState('delta', multi)).toEqual({ selected: false, focused: false })
  })
})

describe('workspace batch-close replacement', () => {
  it('builds a blank legacy-compatible replacement for a singleton selection', () => {
    const only = workspace('alpha', '/work/alpha', 31, 111)
    const replacement = workspaceBatchCloseReplacement([only], {
      selection: ['alpha'],
      focusedWorkspaceId: 'alpha'
    })

    expect(replacement).toEqual({
      name: 'Workspace 1',
      workingDirectory: '/work/alpha',
      initialTerminal: { cwd: '/work/alpha', rows: 31, cols: 111 }
    })
    expect(replacement?.initialTerminal).not.toHaveProperty('command')
    expect(JSON.stringify(replacement)).not.toContain('runtime-alpha')
    expect(JSON.stringify(replacement)).not.toContain('/must-not-copy')
  })

  it('omits a replacement for an ordinary multi-selection that leaves a workspace', () => {
    const workspaces = [
      workspace('alpha', '/work/alpha'),
      workspace('bravo', '/work/bravo'),
      workspace('charlie', '/work/charlie')
    ]

    expect(
      workspaceBatchCloseReplacement(workspaces, {
        selection: ['alpha', 'bravo'],
        focusedWorkspaceId: 'bravo'
      })
    ).toBeUndefined()
  })

  it('uses the focused workspace cwd and terminal dimensions when all workspaces are selected', () => {
    const workspaces = [
      workspace('alpha', '/work/alpha', 24, 80),
      workspace('bravo', '/work/bravo', 42, 132)
    ]

    expect(
      workspaceBatchCloseReplacement(workspaces, {
        selection: ['alpha', 'bravo'],
        focusedWorkspaceId: 'bravo'
      })
    ).toEqual({
      name: 'Workspace 1',
      workingDirectory: '/work/bravo',
      initialTerminal: { cwd: '/work/bravo', rows: 42, cols: 132 }
    })
  })
})
