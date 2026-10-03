import { EventEmitter } from 'node:events'

import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { BrowserAutomationDevtools } from './browser-automation-devtools'

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }))
const encoder = vi.hoisted(() => ({
  initialize: vi.fn(() => Promise.resolve()),
  frame: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve(Buffer.from('webm'))),
  dispose: vi.fn()
}))
vi.mock('./browser-automation-recording', () => ({
  BrowserAutomationRecording: class {
    public readonly initialize = encoder.initialize
    public readonly frame = encoder.frame
    public readonly stop = encoder.stop
    public readonly dispose = encoder.dispose
    public constructor(
      public readonly width: number,
      public readonly height: number
    ) {}
  }
}))

function fixture(attached = false) {
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
    }),
    sendCommand: vi.fn((method: string, params?: Record<string, unknown>) => {
      void method
      void params
      return Promise.resolve<unknown>({})
    })
  })
  const contents = {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => 'https://example.test',
    getTitle: () => 'Example'
  } as unknown as WebContents
  const devtools = new BrowserAutomationDevtools(contents)
  const event = (method: string, params: unknown) => debuggerApi.emit('message', {}, method, params)
  return { debuggerApi, devtools, event }
}

describe('BrowserAutomationDevtools', () => {
  it('stops screencasting after encoder failure and ignores stale frame failures after detach', async () => {
    const own = fixture()
    await own.devtools.initialize()
    await own.devtools.run({ kind: 'recordingStart', width: 800, height: 600 })
    encoder.frame.mockRejectedValueOnce(new Error('Encoder failed'))
    own.event('Page.screencastFrame', { data: 'jpeg', sessionId: 1 })
    await vi.waitFor(() =>
      expect(own.debuggerApi.sendCommand).toHaveBeenCalledWith('Page.stopScreencast', undefined)
    )
    await expect(own.devtools.stopRecording()).rejects.toThrow('Encoder failed')
    expect(encoder.dispose).toHaveBeenCalledOnce()
    own.devtools.dispose()

    const detached = fixture()
    await detached.devtools.initialize()
    await detached.devtools.run({ kind: 'recordingStart', width: 800, height: 600 })
    let rejectFrame: ((error: Error) => void) | undefined
    encoder.frame.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFrame = reject
        })
    )
    detached.event('Page.screencastFrame', { data: 'jpeg', sessionId: 2 })
    detached.debuggerApi.emit('detach', {}, 'replaced_with_devtools')
    rejectFrame!(new Error('Destroyed encoder'))
    await new Promise((resolve) => setImmediate(resolve))
    await expect(detached.devtools.stopRecording()).rejects.toMatchObject({
      code: 'capability_unavailable'
    })
    expect(detached.debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      'Page.stopScreencast',
      undefined
    )
    detached.devtools.dispose()
  })
  it('captures request redirects, timing, failures, cursor updates, and bounded response bodies', async () => {
    const { devtools, debuggerApi, event } = fixture()
    await devtools.initialize()
    await devtools.run({ kind: 'networkStart' })
    event('Network.requestWillBeSent', {
      requestId: 'r1',
      timestamp: 1,
      wallTime: 10,
      request: {
        url: 'https://example.test/old',
        method: 'GET',
        headers: { Accept: 'application/json' }
      }
    })
    event('Network.requestWillBeSent', {
      requestId: 'r1',
      timestamp: 2,
      wallTime: 11,
      redirectResponse: { url: 'https://example.test/old', status: 302 },
      request: { url: 'https://example.test/api', method: 'GET', headers: {} }
    })
    event('Network.responseReceived', {
      requestId: 'r1',
      timestamp: 2.1,
      response: {
        url: 'https://example.test/api',
        status: 200,
        mimeType: 'application/json',
        headers: { 'content-type': 'application/json' }
      }
    })
    event('Network.loadingFinished', { requestId: 'r1', timestamp: 2.25, encodedDataLength: 123 })
    expect(await devtools.run({ kind: 'networkGet', requestId: 'r1' })).toMatchObject({
      status: 200,
      durationMs: 250,
      complete: true,
      redirects: [{ status: 302 }]
    })
    const list = (await devtools.run({ kind: 'networkList', after: 3 })) as {
      requests: unknown[]
      cursor: number
    }
    expect(list.requests).toHaveLength(1)
    expect(list.cursor).toBe(4)
    debuggerApi.sendCommand.mockResolvedValueOnce({
      body: 'a'.repeat(100_000),
      base64Encoded: false
    })
    const body = (await devtools.run({ kind: 'networkBody', requestId: 'r1' })) as {
      body: string
      truncated: boolean
      byteLength: number
    }
    expect(body).toMatchObject({ truncated: true, byteLength: 100_000 })
    expect(Buffer.from(body.body, 'base64')).toHaveLength(45 * 1024)
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(64 * 1024)
    event('Network.requestWillBeSent', {
      requestId: 'r2',
      timestamp: 3,
      request: { url: 'https://example.test/fail', method: 'GET', headers: {} }
    })
    event('Network.loadingFailed', {
      requestId: 'r2',
      timestamp: 4,
      errorText: 'net::ERR_CONNECTION_REFUSED'
    })
    expect(await devtools.run({ kind: 'networkGet', requestId: 'r2' })).toMatchObject({
      failure: 'net::ERR_CONNECTION_REFUSED',
      durationMs: 1000
    })
    await expect(devtools.run({ kind: 'networkBody', requestId: 'r2' })).rejects.toThrow(
      'unavailable'
    )
    await devtools.run({ kind: 'networkStop' })
    devtools.dispose()
    expect(debuggerApi.detach).toHaveBeenCalledOnce()
  })

  it('retains structured diagnostics with stacks, bounds, filters, cursors, and clearing', async () => {
    const { devtools, event } = fixture()
    await devtools.initialize()
    for (let index = 0; index < 105; index++) {
      event('Runtime.consoleAPICalled', {
        type: 'log',
        args: [
          { type: 'string', value: `message ${index}` },
          { type: 'number', value: index }
        ],
        timestamp: index,
        stackTrace: {
          callFrames: [
            {
              functionName: 'log',
              url: 'https://example.test/app.js',
              lineNumber: 2,
              columnNumber: 1
            }
          ]
        }
      })
    }
    const diagnostics = devtools.diagnostics('console', false, 103, 'info')
    expect(diagnostics.entries).toHaveLength(2)
    expect(devtools.diagnostics('console', false).dropped).toBe(5)
    expect(diagnostics).toMatchObject({ cursor: 105, dropped: 0 })
    expect(diagnostics.entries[0]).toMatchObject({
      line: 3,
      args: [{ value: 'message 103' }, { value: 103 }],
      stack: 'at log (https://example.test/app.js:3:2)'
    })
    event('Runtime.exceptionThrown', {
      timestamp: 200,
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 3,
        exception: { type: 'object', description: 'Error: failed' },
        stackTrace: {
          callFrames: [
            {
              functionName: 'run',
              url: 'https://example.test/app.js',
              lineNumber: 3,
              columnNumber: 0
            }
          ]
        }
      }
    })
    expect(devtools.diagnostics('errors', true).entries[0]).toMatchObject({
      message: 'Error: failed',
      source: 'https://example.test/app.js',
      line: 4
    })
    expect(devtools.diagnostics('errors', false).entries).toEqual([])
    devtools.dispose()
  })

  it('exposes semantic backend nodes and emulates appearance', async () => {
    const { devtools, debuggerApi } = fixture()
    await devtools.initialize()
    debuggerApi.sendCommand.mockResolvedValueOnce({
      nodes: [
        { nodeId: '1', ignored: true },
        {
          nodeId: '2',
          parentId: '1',
          ignored: false,
          role: { value: 'button' },
          name: { value: 'Submit' },
          backendDOMNodeId: 42,
          properties: [{ name: 'disabled', value: { value: false } }]
        }
      ]
    })
    expect(await devtools.run({ kind: 'snapshot' })).toMatchObject({
      nodes: [{ role: 'button', name: 'Submit', backendDOMNodeId: 42 }],
      truncated: false
    })
    await devtools.run({ kind: 'appearance', colorScheme: 'dark' })
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }]
    })
    await devtools.run({ kind: 'appearance', colorScheme: 'system' })
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: []
    })
    devtools.dispose()
  })

  it('does not steal debugger ownership and reports capability loss after detachment', async () => {
    const busy = fixture(true)
    await expect(busy.devtools.initialize()).rejects.toThrow('already owned')
    busy.devtools.dispose()
    expect(busy.debuggerApi.detach).not.toHaveBeenCalled()
    const own = fixture()
    await own.devtools.initialize()
    own.debuggerApi.emit('detach', {}, 'replaced_with_devtools')
    await expect(own.devtools.command('Network.enable')).rejects.toMatchObject({
      code: 'capability_unavailable'
    })
    expect(() => own.devtools.diagnostics('console', false)).toThrow('unavailable')
    own.devtools.dispose()
    expect(own.debuggerApi.detach).not.toHaveBeenCalled()
  })
})
