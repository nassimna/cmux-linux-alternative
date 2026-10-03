import { expect, it, vi } from 'vitest'

import { AgentRegistrationService } from './agent-registration-service'
import { CodexAdapter } from './codex-adapter'
import type { PrivateCodexProfile } from './private-codex-profile'

vi.mock('./sealed-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sealed-executable')>()),
  sealedLaunchAvailable: () => true,
  withSealedExecutable: async (
    _plan: unknown,
    launch: (command: readonly string[]) => Promise<unknown>
  ) => launch(['/sealed/codex', 'resume'])
}))

it('does not claim a shell is a live Codex thread after registration preflight', async () => {
  const binding = {
    workspaceId: '10000000-0000-4000-8000-000000000001',
    paneId: '10000000-0000-4000-8000-000000000002',
    tabId: '10000000-0000-4000-8000-000000000003',
    agentSessionId: '10000000-0000-4000-8000-000000000004'
  }
  let terminalId = 'shell-terminal'
  const replaceAgentTerminal = vi.fn(async () => {
    terminalId = 'codex-terminal'
  })
  const snapshot = {
    workspaces: [
      {
        id: binding.workspaceId,
        panes: { [binding.paneId]: { tabs: [binding.tabId] } },
        tabs: {
          [binding.tabId]: {
            paneId: binding.paneId,
            content: { kind: 'terminal', launch: { cwd: '/tmp', rows: 24, cols: 80 } }
          }
        }
      }
    ]
  }
  const adapter = {
    descriptor: { version: '0.156.1' },
    prepareResume: vi.fn().mockResolvedValue({ command: ['/usr/bin/codex', 'resume'] }),
    close: vi.fn()
  }
  const fromExecutable = vi
    .spyOn(CodexAdapter, 'fromExecutable')
    .mockResolvedValue(adapter as unknown as CodexAdapter)
  const registration = Object.create(AgentRegistrationService.prototype) as AgentRegistrationService
  Object.assign(registration, {
    options: { isolatedCopy: false },
    state: { readSnapshot: () => snapshot },
    runtime: { sessionForTab: () => terminalId, replaceAgentTerminal },
    terminals: {
      attach: (id: string) => ({
        terminal: {
          id,
          command: id === 'codex-terminal' ? ['/sealed/codex', 'resume'] : ['/bin/zsh'],
          exited: false
        }
      })
    },
    verifiedTerminals: new Map<string, string>()
  })
  vi.spyOn(registration, 'providerProfileQualified').mockReturnValue(true)
  const privateOperations = registration as unknown as {
    prepare(params: Parameters<typeof registration.register>[0]): Promise<void>
    liveBinding(binding: {
      agent_session_id: string
      workspace_id: string
      pane_id: string
      tab_id: string
    }): boolean
    canResume(session: {
      agent_session_id: string
      adapter_id: string
      adapter_version: string
    }): Promise<boolean>
    resume(session: {
      agent_session_id: string
      workspace_id: string
      pane_id: string
      tab_id: string
      adapter_id: string
      adapter_version: string
    }): Promise<void>
  }
  const session = {
    agent_session_id: binding.agentSessionId,
    workspace_id: binding.workspaceId,
    pane_id: binding.paneId,
    tab_id: binding.tabId,
    adapter_id: 'codex',
    adapter_version: '0.156.1'
  }
  try {
    await privateOperations.prepare({
      catalogVersion: 1,
      binding,
      adapterId: 'codex',
      adapterVersion: '0.156.1',
      title: 'Existing thread',
      operation: {
        idempotencyKey: '10000000-0000-4000-8000-000000000005',
        requestHash: 'a'.repeat(64),
        sessionRevision: 1,
        attemptEpoch: 1
      }
    })
    expect(adapter.prepareResume).toHaveBeenCalledWith(binding.agentSessionId)
    expect(privateOperations.liveBinding(session)).toBe(false)
    await expect(privateOperations.canResume(session)).resolves.toBe(true)

    await privateOperations.resume(session)
    expect(replaceAgentTerminal).toHaveBeenCalledOnce()
    expect(privateOperations.liveBinding(session)).toBe(true)
    terminalId = 'another-terminal'
    expect(privateOperations.liveBinding(session)).toBe(false)
  } finally {
    fromExecutable.mockRestore()
  }
})

it('keeps provider operations closed for a copied state without a private Codex home', async () => {
  const registration = Object.create(AgentRegistrationService.prototype) as AgentRegistrationService
  const exclusive = vi.fn()
  Object.assign(registration, {
    options: { isolatedCopy: true },
    state: { exclusive },
    forkProviderReady: true
  })

  expect(registration.providerProfileQualified()).toBe(false)
  expect(registration.forkAvailable()).toBe(false)
  await expect(registration.initializeFork()).resolves.toBe(false)
  expect(() => registration.register({} as Parameters<typeof registration.register>[0])).toThrow(
    'Agent provider profile is not qualified'
  )
  expect(() => registration.restore({})).toThrow('Agent provider profile is not qualified')
  expect(() => registration.forkSession({})).toThrow('Agent provider profile is not qualified')
  expect(() => registration.recoverForkOrphans()).toThrow('Agent provider profile is not qualified')
  expect(exclusive).not.toHaveBeenCalled()
})

it('does not fork or archive an older catalog entry with another Codex binary version', async () => {
  const adapter = {
    descriptor: { version: '0.156.1' },
    forkThread: vi.fn(),
    archiveThread: vi.fn(),
    close: vi.fn()
  }
  const fromExecutable = vi
    .spyOn(CodexAdapter, 'fromExecutable')
    .mockResolvedValue(adapter as unknown as CodexAdapter)
  const registration = Object.create(AgentRegistrationService.prototype) as AgentRegistrationService
  Object.assign(registration, { options: { isolatedCopy: false } })
  const operations = registration as unknown as {
    prepareFork(
      source: string,
      version: string,
      destination: {
        workspaceId: string
        paneId: string
        tabId: string
      }
    ): Promise<unknown>
    archiveFork(destination: string, version: string): Promise<void>
  }
  try {
    await expect(
      operations.prepareFork('10000000-0000-4000-8000-000000000001', '0.142.4', {
        workspaceId: '10000000-0000-4000-8000-000000000002',
        paneId: '10000000-0000-4000-8000-000000000003',
        tabId: '10000000-0000-4000-8000-000000000004'
      })
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    await expect(
      operations.archiveFork('10000000-0000-4000-8000-000000000005', '0.142.4')
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(adapter.forkThread).not.toHaveBeenCalled()
    expect(adapter.archiveThread).not.toHaveBeenCalled()
    expect(adapter.close).toHaveBeenCalledTimes(2)
  } finally {
    fromExecutable.mockRestore()
  }
})

it('opens provider mutations only while the private thread evidence remains intact', async () => {
  const priorHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = '/tmp/private-codex-probe'
  const record = {
    threadId: '10000000-0000-4000-8000-000000000001',
    path: '/tmp/private-codex-probe/sessions/2026/09/25/rollout.jsonl',
    device: 1,
    inode: 2
  }
  const assertThreadRecord = vi.fn()
  const profile = {
    home: process.env.CODEX_HOME,
    findThreadRecord: vi.fn().mockReturnValue(record),
    assertThreadRecord
  } as unknown as PrivateCodexProfile
  const adapter = {
    descriptor: { version: '0.156.1' },
    privateLoginReady: vi.fn().mockResolvedValue(true),
    prepareResume: vi.fn().mockResolvedValue({}),
    close: vi.fn()
  }
  const fromExecutable = vi
    .spyOn(CodexAdapter, 'fromExecutable')
    .mockResolvedValue(adapter as unknown as CodexAdapter)
  const registration = Object.create(AgentRegistrationService.prototype) as AgentRegistrationService
  Object.assign(registration, {
    options: { isolatedCopy: true, privateProfile: profile },
    privateProviderEvidence: record
  })
  try {
    await expect(registration.inspectPrivateProvider(record.threadId)).resolves.toBe(true)
    expect(fromExecutable).toHaveBeenCalledWith('codex', profile.home)
    expect(adapter.prepareResume).toHaveBeenCalledWith(record.threadId)
    expect(registration.privateProviderEvidenceAvailable()).toBe(true)
    expect(registration.providerProfileQualified()).toBe(true)
    expect(registration.qualifiedProviderVersion()).toBe('0.156.1')
    assertThreadRecord.mockImplementationOnce(() => {
      throw new Error('record changed')
    })
    expect(registration.privateProviderEvidenceAvailable()).toBe(false)
    expect(registration.providerProfileQualified()).toBe(false)
    expect(registration.qualifiedProviderVersion()).toBeUndefined()
  } finally {
    fromExecutable.mockRestore()
    if (priorHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = priorHome
  }
})

it('rejects another thread outside the isolated profile and rechecks private login', async () => {
  const priorHome = process.env.CODEX_HOME
  const home = '/tmp/private-codex-operation'
  process.env.CODEX_HOME = home
  const threadId = '10000000-0000-4000-8000-000000000001'
  const record = { threadId, path: `${home}/sessions/thread.jsonl`, device: 1, inode: 2 }
  const profile = {
    home,
    findThreadRecord: vi
      .fn()
      .mockImplementation((id: string) => (id === threadId ? record : undefined)),
    assertThreadRecord: vi.fn()
  } as unknown as PrivateCodexProfile
  const registration = Object.create(AgentRegistrationService.prototype) as AgentRegistrationService
  Object.assign(registration, { options: { isolatedCopy: true, privateProfile: profile } })
  const checks = registration as unknown as {
    privateThreadRecord(id: string): typeof record
    requirePrivateLogin(adapter: CodexAdapter): Promise<void>
  }
  const adapter = { privateLoginReady: vi.fn().mockResolvedValue(false) } as unknown as CodexAdapter
  try {
    expect(checks.privateThreadRecord(threadId)).toEqual(record)
    expect(() => checks.privateThreadRecord('10000000-0000-4000-8000-000000000002')).toThrow(
      'Private Codex thread is unavailable'
    )
    await expect(checks.requirePrivateLogin(adapter)).rejects.toThrow(
      'Private Codex login is unavailable'
    )
    vi.mocked(adapter.privateLoginReady).mockResolvedValueOnce(true)
    await expect(checks.requirePrivateLogin(adapter)).resolves.toBeUndefined()
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = priorHome
  }
})

it('assesses copied-session resume only against an exact authenticated private record', async () => {
  const priorHome = process.env.CODEX_HOME
  const home = '/tmp/private-codex-assessment'
  process.env.CODEX_HOME = home
  const threadId = '10000000-0000-4000-8000-000000000001'
  const record = {
    threadId,
    path: `${home}/sessions/2026/09/25/rollout.jsonl`,
    device: 1,
    inode: 2
  }
  const findThreadRecord = vi.fn().mockReturnValue(record)
  const assertThreadRecord = vi.fn()
  const profile = {
    home,
    findThreadRecord,
    assertThreadRecord
  } as unknown as PrivateCodexProfile
  const adapter = {
    descriptor: { version: '0.156.1' },
    privateLoginReady: vi.fn().mockResolvedValue(true),
    prepareResume: vi.fn().mockResolvedValue({}),
    close: vi.fn()
  }
  const fromExecutable = vi
    .spyOn(CodexAdapter, 'fromExecutable')
    .mockResolvedValue(adapter as unknown as CodexAdapter)
  const registration = Object.create(AgentRegistrationService.prototype) as AgentRegistrationService
  Object.assign(registration, {
    options: { isolatedCopy: true, privateProfile: profile },
    privateProviderEvidence: record
  })
  const assess = (id: string) =>
    (
      registration as unknown as {
        canResume(session: {
          adapter_id: string
          adapter_version: string
          agent_session_id: string
        }): Promise<boolean>
      }
    ).canResume({ adapter_id: 'codex', adapter_version: '0.156.1', agent_session_id: id })
  try {
    await expect(assess(threadId)).resolves.toBe(true)
    expect(fromExecutable).toHaveBeenCalledWith('codex', home)
    expect(adapter.prepareResume).toHaveBeenCalledWith(threadId)
    expect(assertThreadRecord).toHaveBeenCalledWith(record)

    adapter.privateLoginReady.mockResolvedValueOnce(false)
    await expect(assess(threadId)).resolves.toBe(false)
    expect(adapter.prepareResume).toHaveBeenCalledTimes(1)

    findThreadRecord.mockReturnValueOnce(undefined)
    await expect(assess(threadId)).resolves.toBe(false)
    expect(fromExecutable).toHaveBeenCalledTimes(2)

    assertThreadRecord.mockImplementationOnce(() => {
      throw new Error('record changed')
    })
    await expect(assess(threadId)).resolves.toBe(false)
    expect(registration.providerProfileQualified()).toBe(false)
  } finally {
    fromExecutable.mockRestore()
    if (priorHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = priorHome
  }
})
