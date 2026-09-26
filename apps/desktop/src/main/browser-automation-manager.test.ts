import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type {
  BrowserAutomationExecutionRequest,
  BrowserAutomationOperation,
  BrowserAutomationSessionSnapshot,
  BrowserAutomationTargetBinding
} from '@agent-workspace/protocol-client'

import {
  BrowserAutomationManager,
  createElectronAutomationPage,
  type BrowserAutomationPage
} from './browser-automation-manager'

const SESSION = '10000000-0000-4000-8000-000000000001'
const OPERATION = '10000000-0000-4000-8000-000000000002'
const CORRELATION = '10000000-0000-4000-8000-000000000003'
const WINDOW = '10000000-0000-4000-8000-000000000004'
const WORKSPACE = '10000000-0000-4000-8000-000000000005'
const PANE = '10000000-0000-4000-8000-000000000006'
const TAB = '10000000-0000-4000-8000-000000000007'
const BROWSER = '10000000-0000-4000-8000-000000000008'
const LIFECYCLE = '10000000-0000-4000-8000-000000000009'

class FakePage implements BrowserAutomationPage {
  public readonly opaquePageToken = {}
  public readonly navigate = vi.fn(() => Promise.resolve())
  public readonly waitForLifecycle = vi.fn(() => Promise.resolve())
  public readonly insertText = vi.fn(() => Promise.resolve())
  public readonly sendKey = vi.fn()
  public readonly capture = vi.fn(() => Promise.resolve(Buffer.from('png bytes')))
  public readonly destroy = vi.fn(() => Promise.resolve())
  public readonly executeClosedScript = vi.fn(() => Promise.resolve<unknown>(true))
  public valid = true
  private readonly navigationListeners = new Set<() => void>()

  public constructor(
    public readonly owned = true,
    public readonly target = targetBinding()
  ) {}

  public revalidate(target: BrowserAutomationTargetBinding): boolean {
    return this.valid && target.browserSessionId === this.target.browserSessionId
  }

  public onTopLevelNavigation(listener: () => void): () => void {
    this.navigationListeners.add(listener)
    return () => this.navigationListeners.delete(listener)
  }

  public navigateTopLevel(): void {
    for (const listener of this.navigationListeners) listener()
  }
}

function targetBinding(): BrowserAutomationTargetBinding {
  return {
    workspaceId: WORKSPACE,
    paneId: PANE,
    tabId: TAB,
    browserSessionId: BROWSER,
    browserLifecycleId: LIFECYCLE,
    window: { windowId: WINDOW, windowGeneration: 1 }
  }
}

function session(mode: 'ephemeral' | 'attach' = 'ephemeral'): BrowserAutomationSessionSnapshot {
  return {
    automationSessionId: SESSION,
    generation: 1,
    navigationEpoch: 0,
    mode,
    state: 'ready',
    profileKey: 'private',
    target: targetBinding(),
    createdAtMs: 1,
    updatedAtMs: 1,
    expiresAtMs: Date.now() + 60_000
  }
}

function request(operation: BrowserAutomationOperation): BrowserAutomationExecutionRequest {
  return {
    identity: {
      providerId: '10000000-0000-4000-8000-000000000010',
      providerEpoch: 1,
      leaseId: '10000000-0000-4000-8000-000000000011'
    },
    target: targetBinding().window,
    session: session(),
    operation: {
      automationSessionId: SESSION,
      sessionGeneration: 1,
      navigationEpoch: 0,
      operationId: OPERATION,
      attemptEpoch: 1,
      timeoutMs: 5_000,
      operation,
      idempotency: {
        epoch: '10000000-0000-4000-8000-000000000012',
        key: '10000000-0000-4000-8000-000000000013'
      },
      correlationId: CORRELATION
    }
  }
}

function harness(page = new FakePage()): BrowserAutomationManager {
  return new BrowserAutomationManager({
    acquireAttachedPage: () => Promise.resolve(page),
    createEphemeralPage: () => Promise.resolve(page),
    confirmAttachment: () => Promise.resolve(true),
    now: Date.now,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle)
  })
}

describe('BrowserAutomationManager', () => {
  it('reports attached sessions, including creation in progress, without counting an idle provider', async () => {
    let confirm!: (allowed: boolean) => void
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: (target) => Promise.resolve(new FakePage(false, target)),
      createEphemeralPage: (snapshot) => Promise.resolve(new FakePage(true, snapshot.target)),
      confirmAttachment: () =>
        new Promise((resolve) => {
          confirm = resolve
        }),
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })

    expect(manager.hasAttachedSessions()).toBe(false)
    const creating = manager.createSession(session('attach'))
    expect(manager.hasAttachedSessions()).toBe(true)
    confirm(true)
    await creating
    expect(manager.hasAttachedSessions()).toBe(true)
    await manager.destroySession(SESSION)
    expect(manager.hasAttachedSessions()).toBe(false)
    await manager.createSession(session())
    expect(manager.hasAttachedSessions()).toBe(false)
    await manager.dispose()
  })

  it('provisions new durable sessions at navigation epoch one', async () => {
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: () => Promise.reject(new Error('not used')),
      createEphemeralPage: (snapshot) => Promise.resolve(new FakePage(true, snapshot.target)),
      confirmAttachment: () => Promise.resolve(true),
      now: () => 2,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })

    const provisioned = await manager.createProvision(
      {
        automationSessionId: SESSION,
        generation: 1,
        mode: 'ephemeral',
        profileKey: 'private',
        createdAtMs: 1,
        expiresAtMs: 60_000
      },
      { windowId: WINDOW, windowGeneration: 1 }
    )

    expect(provisioned.navigationEpoch).toBe(1)
  })

  it('actively destroys expired automation sessions without waiting for another request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    try {
      const page = new FakePage()
      const manager = harness(page)
      await manager.createSession(session())

      await vi.advanceTimersByTimeAsync(60_001)

      expect(page.destroy).toHaveBeenCalledOnce()
      expect(manager.diagnosticCounts.sessions).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns only bounded text-free structural query summaries', async () => {
    const page = new FakePage()
    page.executeClosedScript.mockResolvedValue([
      {
        index: 99,
        tag: 'button',
        visible: true,
        enabled: true,
        focused: false,
        editable: false,
        text: 'hostile secret',
        html: '<button>hostile secret</button>'
      }
    ])
    const result = await harness(page).execute(
      request({ kind: 'query', selector: '#submit', limit: 1 })
    )
    expect(result.state).toBe('succeeded')
    expect(result.result).toEqual({
      kind: 'query',
      matches: [
        {
          index: 0,
          tag: 'button',
          visible: true,
          enabled: true,
          focused: false,
          editable: false
        }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('hostile secret')
  })

  it('runs the closed interaction set through the native page with bounded inputs', async () => {
    const page = new FakePage()
    const manager = harness(page)
    for (const operation of [
      { kind: 'focus' as const, selector: '#field' },
      { kind: 'click' as const, selector: '#submit' },
      { kind: 'typeText' as const, selector: '#field', text: 'private text' },
      { kind: 'key' as const, key: 'enter' as const },
      { kind: 'keyAt' as const, selector: '#field', key: 'tab' as const },
      {
        kind: 'wait' as const,
        condition: { kind: 'lifecycle' as const, lifecycle: 'load' as const }
      }
    ]) {
      expect((await manager.execute(request(operation))).state).toBe('succeeded')
    }
    expect(page.executeClosedScript).toHaveBeenCalledWith('focus', { selector: '#field' })
    expect(page.executeClosedScript).toHaveBeenCalledWith('click', { selector: '#submit' })
    expect(page.insertText).toHaveBeenCalledWith('private text')
    expect(page.sendKey).toHaveBeenCalledWith('enter')
    expect(page.sendKey).toHaveBeenCalledWith('tab')
    expect(page.waitForLifecycle).toHaveBeenCalledWith('load', expect.any(AbortSignal))
  })

  it('fences late callbacks after top-level navigation', async () => {
    let resolve!: (value: unknown) => void
    const page = new FakePage()
    page.executeClosedScript.mockReturnValue(new Promise((done) => (resolve = done)))
    const manager = harness(page)
    const running = manager.execute(request({ kind: 'focus', selector: '#target' }))
    await vi.waitFor(() => expect(page.executeClosedScript).toHaveBeenCalled())
    page.navigateTopLevel()
    resolve(true)
    const result = await running
    expect(result.state).toBe('failed')
    expect(result.errorCode).toBe('stale_navigation')
  })

  it('advances a normal navigation epoch exactly once when Electron emits its event', async () => {
    const page = new FakePage()
    page.navigate.mockImplementation(() => {
      page.navigateTopLevel()
      return Promise.resolve()
    })
    const result = await harness(page).execute(
      request({ kind: 'navigate', url: 'https://example.test/next' })
    )
    expect(result.state).toBe('succeeded')
    expect(result.navigationEpoch).toBe(1)
    expect(result.result).toEqual({ kind: 'navigation', navigationEpoch: 1 })
  })

  it('retains bounded screenshot chunks, digest, release, and zeroized expiry state', async () => {
    const page = new FakePage()
    page.capture.mockResolvedValue(Buffer.alloc(600_000, 7))
    const manager = harness(page)
    const result = await manager.execute(request({ kind: 'screenshot', width: 800, height: 600 }))
    expect(result.state).toBe('succeeded')
    if (result.result?.kind !== 'screenshot') throw new Error('missing screenshot')
    expect(result.result.handle.chunkCount).toBe(2)
    const handleId = result.result.handle.handleId
    const first = manager.readScreenshot(SESSION, 1, handleId, 0)
    expect(first.dataBase64.length).toBeGreaterThan(0)
    expect(manager.releaseScreenshot(SESSION, 1, handleId)).toBe(true)
    expect(() => manager.readScreenshot(SESSION, 1, handleId, 0)).toThrow('result_expired')
  })

  it('destroys owned views idempotently and returns live counts to baseline', async () => {
    const page = new FakePage()
    const manager = harness(page)
    await manager.createSession(session())
    expect(manager.diagnosticCounts.sessions).toBe(1)
    await manager.destroySession(SESSION, 1)
    await manager.destroySession(SESSION, 1)
    expect(page.destroy).toHaveBeenCalledTimes(1)
    expect(manager.diagnosticCounts).toEqual({ sessions: 0, pending: 0, screenshots: 0 })
  })

  it('destroys an owned page that finishes creation after provider disposal', async () => {
    let finishCreation!: (page: BrowserAutomationPage) => void
    const page = new FakePage()
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: () => Promise.resolve(undefined),
      createEphemeralPage: () =>
        new Promise((resolve) => {
          finishCreation = resolve
        }),
      confirmAttachment: () => Promise.resolve(false),
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    const creating = manager.createSession(session())
    await manager.dispose()
    finishCreation(page)

    await expect(creating).rejects.toThrow('interrupted')
    expect(page.destroy).toHaveBeenCalledOnce()
    expect(manager.diagnosticCounts.sessions).toBe(0)
  })

  it('cancels a pending page creation when its exact window is destroyed', async () => {
    let finishCreation!: (page: BrowserAutomationPage) => void
    const page = new FakePage()
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: () => Promise.resolve(undefined),
      createEphemeralPage: () =>
        new Promise((resolve) => {
          finishCreation = resolve
        }),
      confirmAttachment: () => Promise.resolve(false),
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    const creating = manager.createSession(session())
    await manager.destroyTarget(WINDOW, 1)
    finishCreation(page)

    await expect(creating).rejects.toThrow('interrupted')
    expect(page.destroy).toHaveBeenCalledOnce()
    expect(manager.diagnosticCounts.sessions).toBe(0)
  })

  it('requires trusted confirmation for exact attachment', async () => {
    const page = new FakePage(false)
    const manager = new BrowserAutomationManager({
      acquireAttachedPage: () => Promise.resolve(page),
      createEphemeralPage: () => Promise.resolve(page),
      confirmAttachment: () => Promise.resolve(false),
      now: Date.now,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelSchedule: (handle) => clearTimeout(handle)
    })
    await expect(manager.createSession(session('attach'))).rejects.toThrow('policy_denied')
  })
})

describe('createElectronAutomationPage', () => {
  it('JSON-encodes selector data into the fixed closed script and exposes no bridge primitive', async () => {
    const contents = new EventEmitter() as EventEmitter & {
      loadURL: ReturnType<typeof vi.fn>
      executeJavaScript: ReturnType<typeof vi.fn>
      insertText: ReturnType<typeof vi.fn>
      sendInputEvent: ReturnType<typeof vi.fn>
      capturePage: ReturnType<typeof vi.fn>
    }
    contents.loadURL = vi.fn(() => Promise.resolve())
    contents.executeJavaScript = vi.fn(() => Promise.resolve(true))
    contents.insertText = vi.fn()
    contents.sendInputEvent = vi.fn()
    contents.capturePage = vi.fn()
    const page = createElectronAutomationPage({
      contents: contents as unknown as Electron.WebContents,
      owned: false,
      target: targetBinding(),
      revalidate: () => true
    })
    await page.executeClosedScript('focus', { selector: `#x');globalThis.pwned=true;//` })
    const source = contents.executeJavaScript.mock.calls[0]![0] as string
    expect(source).not.toContain(`#x');globalThis.pwned=true;//`)
    expect(source).toMatch(/\('[A-Za-z0-9+/]+=*'\)\)$/u)
    expect(source).not.toContain('electron')
    expect(source).not.toContain('preload')
    expect(source).not.toContain('ipcRenderer')
  })
})
