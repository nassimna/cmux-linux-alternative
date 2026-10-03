import { describe, expect, it } from 'vitest'

import {
  desktopAgentTeamMemberMoveRequestSchema,
  desktopAgentTeamMemberUpdateRequestSchema,
  parseDesktopLifecycleState,
  parseDesktopUpdateState,
  parseWorkspaceRuntimeMetadata
} from './desktop-bridge'

describe('agent team preload contract', () => {
  const exact = {
    teamId: '10000000-0000-4000-8000-000000000001',
    memberId: '10000000-0000-4000-8000-000000000002',
    expectedCatalogRevision: 3,
    expectedTeamRevision: 2,
    expectedMemberRevision: 1
  }

  it('validates exact member update and move requests without session epochs', () => {
    expect(
      desktopAgentTeamMemberUpdateRequestSchema.parse({ ...exact, role: 'reviewer' })
    ).toMatchObject({ role: 'reviewer' })
    expect(
      desktopAgentTeamMemberMoveRequestSchema.parse({
        ...exact,
        agentSessionId: '10000000-0000-4000-8000-000000000003'
      })
    ).toMatchObject({ expectedMemberRevision: 1 })
    expect(() =>
      desktopAgentTeamMemberMoveRequestSchema.parse({ ...exact, attemptEpoch: 1 })
    ).toThrow()
  })
})

const recovery = {
  event: 'service.recoveryRequired',
  application: 'agent-workspace',
  version: '0.1.0',
  protocolVersion: 1,
  category: 'migrationFailed',
  message: 'The database migration could not be completed.',
  migrationBackupAvailable: true
} as const

describe('desktop lifecycle parser', () => {
  it('accepts every bounded lifecycle variant', () => {
    expect(parseDesktopLifecycleState({ status: 'starting' })).toEqual({ status: 'starting' })
    expect(parseDesktopLifecycleState({ status: 'ready' })).toEqual({ status: 'ready' })
    expect(
      parseDesktopLifecycleState({
        status: 'recovering',
        attempt: 2,
        maxAttempts: 4,
        message: 'Restarting the local service.'
      })
    ).toMatchObject({ status: 'recovering', attempt: 2, maxAttempts: 4 })
    expect(parseDesktopLifecycleState({ status: 'recoveryRequired', recovery })).toMatchObject({
      status: 'recoveryRequired',
      recovery: { category: 'migrationFailed' }
    })
    expect(parseDesktopLifecycleState({ status: 'failed', message: 'Restart failed.' })).toEqual({
      status: 'failed',
      message: 'Restart failed.'
    })
    expect(
      parseDesktopLifecycleState({
        status: 'failed',
        message: 'The database could not open.',
        availableActions: { recoveryExport: true, diagnostics: false }
      })
    ).toMatchObject({
      availableActions: { recoveryExport: true, diagnostics: false }
    })
  })

  it.each([
    { status: 'ready', extra: true },
    { status: 'recovering', attempt: 0, maxAttempts: 2, message: 'Retrying.' },
    { status: 'recovering', attempt: 3, maxAttempts: 2, message: 'Retrying.' },
    { status: 'recovering', attempt: 1.5, maxAttempts: 2, message: 'Retrying.' },
    { status: 'recovering', attempt: 1, maxAttempts: 11, message: 'Retrying.' },
    { status: 'failed', message: '' },
    { status: 'failed', message: ' unsafe' },
    { status: 'failed', message: 'unsafe\nmessage' },
    { status: 'failed', message: 'x'.repeat(513) },
    { status: 'failed', message: 'Failed.', availableActions: { recoveryExport: true } },
    {
      status: 'failed',
      message: 'Failed.',
      availableActions: { recoveryExport: true, diagnostics: false, unsafe: true }
    },
    {
      status: 'recoveryRequired',
      recovery: { ...recovery, migrationBackupPath: '/private/recovery/database.backup' }
    },
    { status: 'recoveryRequired', recovery: { ...recovery, unexpected: true } }
  ])('rejects malformed or unsafe lifecycle state %#', (value) => {
    expect(() => parseDesktopLifecycleState(value)).toThrow()
  })
})

describe('desktop update parser', () => {
  it('accepts bounded states without exposing provider data', () => {
    expect(parseDesktopUpdateState({ status: 'unconfigured', channel: 'stable' })).toEqual({
      status: 'unconfigured',
      channel: 'stable'
    })
    expect(
      parseDesktopUpdateState({
        status: 'downloading',
        channel: 'beta',
        packageType: 'appimage',
        version: '1.2.3-beta.1',
        progress: 42.5
      })
    ).toMatchObject({ status: 'downloading', channel: 'beta', progress: 42.5 })
    expect(
      parseDesktopUpdateState({
        status: 'error',
        channel: 'stable',
        packageType: 'deb',
        message: 'The update operation failed.'
      })
    ).toMatchObject({ status: 'error', packageType: 'deb' })
    expect(
      parseDesktopUpdateState({ status: 'idle', channel: 'stable', packageType: 'mac' })
    ).toMatchObject({ status: 'idle', packageType: 'mac' })
    expect(
      parseDesktopUpdateState({ status: 'idle', channel: 'beta', packageType: 'nsis' })
    ).toMatchObject({ status: 'idle', packageType: 'nsis' })
  })

  it.each([
    { status: 'unconfigured', channel: 'stable', url: 'https://private.invalid/' },
    { status: 'idle', channel: 'nightly', packageType: 'appimage' },
    { status: 'downloaded', channel: 'beta', packageType: 'zip', version: '1.0.0' },
    {
      status: 'downloading',
      channel: 'stable',
      packageType: 'rpm',
      version: '1.0.0',
      progress: 101
    },
    {
      status: 'error',
      channel: 'stable',
      packageType: 'deb',
      message: 'token\nsecret'
    }
  ])('rejects malformed update state %#', (state) => {
    expect(() => parseDesktopUpdateState(state)).toThrow()
  })
})

describe('workspace runtime metadata parser', () => {
  const clean = {
    clean: true,
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
    ahead: 0,
    behind: 0
  }

  it('accepts only bounded branch, status, and port metadata', () => {
    expect(
      parseWorkspaceRuntimeMetadata({ gitBranch: null, gitStatus: null, listeningPorts: [] })
    ).toEqual({
      gitBranch: null,
      gitStatus: null,
      listeningPorts: []
    })
    expect(
      parseWorkspaceRuntimeMetadata({
        gitBranch: 'feature/sidebar',
        gitStatus: clean,
        listeningPorts: [3000, 5173]
      })
    ).toEqual({
      gitBranch: 'feature/sidebar',
      gitStatus: clean,
      listeningPorts: [3000, 5173]
    })
  })

  it.each([
    {},
    { gitBranch: null },
    { gitBranch: null, gitStatus: null, listeningPorts: [], path: '/private/repo' },
    { gitBranch: '', gitStatus: null, listeningPorts: [] },
    { gitBranch: ' unsafe', gitStatus: null, listeningPorts: [] },
    { gitBranch: 'unsafe\nbranch', gitStatus: null, listeningPorts: [] },
    { gitBranch: 'unsafe\u200bbranch', gitStatus: null, listeningPorts: [] },
    { gitBranch: 'x'.repeat(257), gitStatus: null, listeningPorts: [] },
    { gitBranch: null, gitStatus: clean, listeningPorts: [0] },
    { gitBranch: null, gitStatus: clean, listeningPorts: [5173, 3000] },
    { gitBranch: null, gitStatus: clean, listeningPorts: [3000, 3000] },
    {
      gitBranch: null,
      gitStatus: clean,
      listeningPorts: Array.from({ length: 17 }, (_, index) => index + 1)
    },
    {
      gitBranch: 'main',
      gitStatus: { ...clean, clean: true, staged: true },
      listeningPorts: []
    },
    { gitBranch: 'main', gitStatus: { ...clean, ahead: -1 }, listeningPorts: [] },
    { gitBranch: 'main', gitStatus: { ...clean, extra: true }, listeningPorts: [] }
  ])('rejects malformed or content-bearing metadata %#', (value) => {
    expect(() => parseWorkspaceRuntimeMetadata(value)).toThrow()
  })
})
