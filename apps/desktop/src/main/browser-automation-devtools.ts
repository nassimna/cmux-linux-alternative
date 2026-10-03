import type { BrowserAutomationOperation } from '@agent-workspace/protocol-client'
import type { Event, WebContents } from 'electron'

import { BrowserAutomationRecording } from './browser-automation-recording'

const MAX_ITEMS = 100
const MAX_BUFFER_BYTES = 48 * 1024
const MAX_BODY_BYTES = 45 * 1024

type RemoteArgument = {
  type: string
  value?: unknown
  description?: string
  unserializableValue?: string
  preview?: unknown
}
type StackTrace = {
  callFrames?: Array<{
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
  }>
}
type Diagnostic = {
  sequence: number
  level: string
  message: string
  source: string
  line: number
  timestampMs: number
  args?: RemoteArgument[]
  stack?: string
}
type NetworkRequest = {
  requestId: string
  sequence: number
  url: string
  method: string
  requestHeaders: Record<string, string>
  responseHeaders?: Record<string, string>
  status?: number
  mimeType?: string
  timestampMs: number
  durationMs?: number
  encodedDataLength?: number
  failure?: string
  redirects: Array<{ url: string; status: number }>
  complete: boolean
}
type NetworkEvent = {
  requestId: string
  timestamp: number
  wallTime?: number
  request?: { url: string; method: string; headers: Record<string, string> }
  response?: {
    url: string
    status: number
    mimeType: string
    headers: Record<string, string>
  }
  redirectResponse?: { url: string; status: number }
  encodedDataLength?: number
  errorText?: string
  headers?: Record<string, string>
  statusCode?: number
}
type AccessibilityNode = {
  nodeId: string
  parentId?: string
  ignored: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string | number }
  backendDOMNodeId?: number
  properties?: Array<{ name: string; value: { value?: unknown } }>
}

export class BrowserAutomationDevtoolsFailure extends Error {
  public readonly code = 'capability_unavailable'
}

export class BrowserAutomationDevtools {
  readonly #contents: WebContents
  readonly #console: Diagnostic[] = []
  readonly #errors: Diagnostic[] = []
  readonly #requests = new Map<string, NetworkRequest>()
  readonly #requestTimes = new Map<string, number>()
  readonly #pendingHeaders = new Map<string, Record<string, string>>()
  #consoleSequence = 0
  #errorsSequence = 0
  #networkSequence = 0
  #consoleDropped = 0
  #errorsDropped = 0
  #networkDropped = 0
  #owned = false
  #available = false
  #disposed = false
  #capturing = false
  #recording: BrowserAutomationRecording | undefined
  #recordingResult: Promise<{ bytes: Buffer; width: number; height: number }> | undefined
  #recordingTimer?: ReturnType<typeof setTimeout>

  public constructor(contents: WebContents) {
    this.#contents = contents
  }

  public async initialize(): Promise<void> {
    if (this.#available) return
    if (this.#disposed || this.#contents.isDestroyed() || this.#contents.debugger.isAttached()) {
      throw new BrowserAutomationDevtoolsFailure('Debugger already owned or unavailable')
    }
    try {
      this.#contents.debugger.attach('1.3')
      this.#owned = true
      this.#available = true
      this.#contents.debugger.on('message', this.onMessage)
      this.#contents.debugger.on('detach', this.onDetach)
      await this.command('Runtime.enable')
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  public async command<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (!this.#available || this.#disposed || this.#contents.isDestroyed()) {
      throw new BrowserAutomationDevtoolsFailure('Browser instrumentation is unavailable')
    }
    try {
      return (await this.#contents.debugger.sendCommand(method, params)) as T
    } catch (error) {
      if (!this.#available)
        throw new BrowserAutomationDevtoolsFailure('Browser instrumentation detached')
      throw error
    }
  }

  public async run(operation: BrowserAutomationOperation): Promise<unknown> {
    switch (operation.kind) {
      case 'snapshot': {
        const tree = await this.command<{ nodes: AccessibilityNode[] }>(
          'Accessibility.getFullAXTree'
        )
        const nodes = tree.nodes
          .filter((node) => !node.ignored)
          .map((node) => ({
            nodeId: node.nodeId,
            parentId: node.parentId,
            role: node.role?.value ?? '',
            name: (node.name?.value ?? '').slice(0, 2048),
            value:
              typeof node.value?.value === 'string'
                ? node.value.value.slice(0, 2048)
                : node.value?.value,
            backendDOMNodeId: node.backendDOMNodeId,
            properties: node.properties?.filter((property) =>
              [
                'checked',
                'disabled',
                'expanded',
                'focused',
                'selected',
                'required',
                'level'
              ].includes(property.name)
            )
          }))
        const before = nodes.length
        while (nodes.length > 200 || Buffer.byteLength(JSON.stringify(nodes)) > MAX_BUFFER_BYTES)
          nodes.pop()
        return {
          url: this.#contents.getURL().slice(0, 4096),
          title: this.#contents.getTitle().slice(0, 4096),
          nodes,
          truncated: nodes.length !== before
        }
      }
      case 'appearance':
        await this.command('Emulation.setEmulatedMedia', {
          features:
            operation.colorScheme === 'system'
              ? []
              : [{ name: 'prefers-color-scheme', value: operation.colorScheme }]
        })
        return { colorScheme: operation.colorScheme }
      case 'networkStart':
        await this.command('Network.enable', {
          maxTotalBufferSize: 8 * 1024 * 1024,
          maxResourceBufferSize: 1024 * 1024
        })
        this.#capturing = true
        return { capturing: true }
      case 'networkStop':
        await this.command('Network.disable')
        this.#capturing = false
        return { capturing: false }
      case 'networkList':
        await this.command('Runtime.evaluate', { expression: 'void 0' })
        return {
          requests: Array.from(this.#requests.values()).filter(
            (request) => request.sequence > (operation.after ?? 0)
          ),
          cursor: this.#networkSequence,
          dropped: this.#networkDropped,
          capturing: this.#capturing
        }
      case 'networkGet': {
        await this.command('Runtime.evaluate', { expression: 'void 0' })
        const request = this.#requests.get(operation.requestId)
        if (!request) throw new Error('Network request is not retained')
        return request
      }
      case 'networkBody': {
        const request = this.#requests.get(operation.requestId)
        if (!request?.complete || request.failure)
          throw new Error('Network response body is unavailable')
        const result = await this.command<{ body: string; base64Encoded: boolean }>(
          'Network.getResponseBody',
          { requestId: operation.requestId }
        )
        const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8')
        const retained = bytes.subarray(0, MAX_BODY_BYTES)
        return {
          body: retained.toString('base64'),
          base64Encoded: true,
          truncated: bytes.length > MAX_BODY_BYTES,
          byteLength: bytes.length
        }
      }
      case 'recordingStart':
        if (this.#recording || this.#recordingResult) throw new Error('Recording already started')
        this.#recording = new BrowserAutomationRecording(operation.width, operation.height)
        try {
          await this.#recording.initialize()
          await this.command('Page.startScreencast', {
            format: 'jpeg',
            quality: 80,
            maxWidth: operation.width,
            maxHeight: operation.height,
            everyNthFrame: 1
          })
          this.#recordingTimer = setTimeout(() => {
            this.#recordingResult = this.finishRecording()
            void this.#recordingResult.catch(() => undefined)
          }, 120_000)
          this.#recordingTimer.unref()
        } catch (error) {
          this.#recording.dispose()
          this.#recording = undefined
          throw error
        }
        return {
          recording: true,
          width: operation.width,
          height: operation.height,
          maxDurationMs: 120_000
        }
      default:
        throw new Error(`Unsupported inspection operation: ${operation.kind}`)
    }
  }

  public diagnostics(
    kind: 'console' | 'errors',
    clear: boolean,
    after = 0,
    level?: string
  ): { entries: Diagnostic[]; cursor: number; dropped: number } {
    if (!this.#available)
      throw new BrowserAutomationDevtoolsFailure('Browser instrumentation is unavailable')
    const buffer = kind === 'console' ? this.#console : this.#errors
    const result = {
      entries: buffer.filter(
        (entry) => entry.sequence > after && (!level || entry.level === level)
      ),
      cursor: kind === 'console' ? this.#consoleSequence : this.#errorsSequence,
      dropped: Math.max(
        0,
        (kind === 'console' ? this.#consoleDropped : this.#errorsDropped) - after
      )
    }
    if (clear) buffer.length = 0
    return result
  }

  public async stopRecording(): Promise<{ bytes: Buffer; width: number; height: number }> {
    if (!this.#available)
      throw new BrowserAutomationDevtoolsFailure('Browser instrumentation is unavailable')
    if (!this.#recording && !this.#recordingResult) throw new Error('Recording is not active')
    const result = this.#recordingResult ?? this.finishRecording()
    try {
      return await result
    } finally {
      this.#recordingResult = undefined
    }
  }

  private async finishRecording(): Promise<{ bytes: Buffer; width: number; height: number }> {
    const recording = this.#recording
    if (!recording) throw new BrowserAutomationDevtoolsFailure('Recording is unavailable')
    this.#recording = undefined
    clearTimeout(this.#recordingTimer)
    try {
      await this.command('Page.stopScreencast')
      const bytes = await recording.stop()
      return { bytes, width: recording.width, height: recording.height }
    } finally {
      recording.dispose()
    }
  }

  public dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const owned = this.#owned
    this.onDetach()
    this.#contents.debugger.removeListener('message', this.onMessage)
    this.#contents.debugger.removeListener('detach', this.onDetach)
    if (owned && this.#contents.debugger.isAttached()) this.#contents.debugger.detach()
    this.#owned = false
  }

  private readonly onDetach = (): void => {
    this.#available = false
    this.#capturing = false
    this.#owned = false
    clearTimeout(this.#recordingTimer)
    this.#recording?.dispose()
    this.#recording = undefined
    this.#recordingResult = undefined
  }

  private readonly onMessage = (_event: Event, method: string, params: unknown): void => {
    if (method === 'Runtime.consoleAPICalled') {
      const event = params as {
        type: string
        args: RemoteArgument[]
        timestamp: number
        stackTrace?: StackTrace
      }
      const frame = event.stackTrace?.callFrames?.[0]
      const args = event.args.slice(0, 20).map((argument) => boundedArgument(argument))
      this.appendDiagnostic('console', {
        sequence: ++this.#consoleSequence,
        level:
          event.type === 'warning'
            ? 'warning'
            : event.type === 'error' || event.type === 'assert'
              ? 'error'
              : event.type === 'debug'
                ? 'debug'
                : 'info',
        message: args
          .map((argument) =>
            argument.value === undefined
              ? (argument.description ?? argument.unserializableValue ?? argument.type)
              : typeof argument.value === 'string'
                ? argument.value
                : JSON.stringify(argument.value)
          )
          .join(' ')
          .slice(0, 4096),
        source: (frame?.url ?? '').slice(0, 2048),
        line: (frame?.lineNumber ?? -1) + 1,
        timestampMs: Math.floor(event.timestamp),
        args,
        ...(event.stackTrace ? { stack: boundedStack(event.stackTrace) } : {})
      })
    } else if (method === 'Runtime.exceptionThrown') {
      const event = params as {
        timestamp: number
        exceptionDetails: {
          text: string
          url?: string
          lineNumber: number
          exception?: RemoteArgument
          stackTrace?: StackTrace
        }
      }
      const details = event.exceptionDetails
      this.appendDiagnostic('errors', {
        sequence: ++this.#errorsSequence,
        level: 'error',
        message: (details.exception?.description ?? details.text).slice(0, 4096),
        source: (details.url ?? details.stackTrace?.callFrames?.[0]?.url ?? '').slice(0, 2048),
        line: details.lineNumber + 1,
        timestampMs: Math.floor(event.timestamp),
        ...(details.stackTrace ? { stack: boundedStack(details.stackTrace) } : {})
      })
    } else if (method === 'Page.screencastFrame') {
      const event = params as { data: string; sessionId: number }
      const recording = this.#recording
      void (async () => {
        try {
          await recording?.frame(event.data)
        } finally {
          if (this.#available)
            await this.command('Page.screencastFrameAck', { sessionId: event.sessionId })
        }
      })().catch(async (error: unknown) => {
        if (!recording || !this.#available || this.#recording !== recording) return
        await this.command('Page.stopScreencast').catch(() => undefined)
        if (!this.#available || this.#recording !== recording) return
        recording.dispose()
        this.#recording = undefined
        clearTimeout(this.#recordingTimer)
        this.#recordingResult = Promise.reject(
          error instanceof Error ? error : new Error(String(error))
        )
        void this.#recordingResult.catch(() => undefined)
      })
    } else if (method.startsWith('Network.') && this.#capturing) {
      this.networkEvent(method, params as NetworkEvent)
    }
  }

  private appendDiagnostic(kind: 'console' | 'errors', entry: Diagnostic): void {
    const buffer = kind === 'console' ? this.#console : this.#errors
    buffer.push(entry)
    while (
      buffer.length > MAX_ITEMS ||
      Buffer.byteLength(JSON.stringify(buffer)) > MAX_BUFFER_BYTES
    ) {
      const dropped = buffer.shift()!
      if (kind === 'console') this.#consoleDropped = dropped.sequence
      else this.#errorsDropped = dropped.sequence
    }
  }

  private networkEvent(method: string, event: NetworkEvent): void {
    if (
      ![
        'Network.requestWillBeSent',
        'Network.requestWillBeSentExtraInfo',
        'Network.responseReceived',
        'Network.responseReceivedExtraInfo',
        'Network.loadingFinished',
        'Network.loadingFailed'
      ].includes(method)
    )
      return
    let request = this.#requests.get(event.requestId)
    if (
      (method === 'Network.requestWillBeSentExtraInfo' ||
        method === 'Network.responseReceivedExtraInfo') &&
      event.headers
    ) {
      const side = method === 'Network.requestWillBeSentExtraInfo' ? 'request' : 'response'
      const headers = boundedHeaders(event.headers)
      if (request) {
        request.sequence = ++this.#networkSequence
        if (side === 'request') request.requestHeaders = headers
        else {
          request.responseHeaders = headers
          if (event.statusCode !== undefined) request.status = event.statusCode
        }
      } else {
        this.#pendingHeaders.set(`${event.requestId}:${side}`, headers)
        while (
          this.#pendingHeaders.size > MAX_ITEMS ||
          Buffer.byteLength(JSON.stringify(Array.from(this.#pendingHeaders.values()))) >
            MAX_BUFFER_BYTES
        ) {
          const oldest = this.#pendingHeaders.keys().next().value
          if (!oldest) break
          this.#pendingHeaders.delete(oldest)
        }
        return
      }
    } else if (method === 'Network.requestWillBeSent' && event.request) {
      const redirects = request?.redirects ?? []
      if (event.redirectResponse)
        redirects.push({
          url: event.redirectResponse.url.slice(0, 4096),
          status: event.redirectResponse.status
        })
      request = {
        requestId: event.requestId,
        sequence: ++this.#networkSequence,
        url: event.request.url.slice(0, 4096),
        method: event.request.method,
        requestHeaders:
          this.#pendingHeaders.get(`${event.requestId}:request`) ??
          boundedHeaders(event.request.headers),
        ...(this.#pendingHeaders.has(`${event.requestId}:response`)
          ? { responseHeaders: this.#pendingHeaders.get(`${event.requestId}:response`)! }
          : {}),
        timestampMs: (event.wallTime ?? event.timestamp) * 1000,
        redirects: redirects.slice(-10),
        complete: false
      }
      this.#requests.set(event.requestId, request)
      this.#requestTimes.set(event.requestId, event.timestamp)
      this.#pendingHeaders.delete(`${event.requestId}:request`)
      this.#pendingHeaders.delete(`${event.requestId}:response`)
    } else if (request) {
      request.sequence = ++this.#networkSequence
      if (method === 'Network.responseReceived' && event.response) {
        request.status = event.response.status
        request.mimeType = event.response.mimeType
        request.responseHeaders ??= boundedHeaders(event.response.headers)
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        request.complete = true
        request.durationMs =
          (event.timestamp - (this.#requestTimes.get(event.requestId) ?? event.timestamp)) * 1000
        if (event.encodedDataLength !== undefined)
          request.encodedDataLength = event.encodedDataLength
        if (event.errorText) request.failure = event.errorText.slice(0, 2048)
        this.#requestTimes.delete(event.requestId)
      } else return
    } else return
    while (
      this.#requests.size > MAX_ITEMS ||
      Buffer.byteLength(JSON.stringify(Array.from(this.#requests.values()))) > MAX_BUFFER_BYTES
    ) {
      const oldest = this.#requests.keys().next().value
      if (!oldest) break
      this.#requests.delete(oldest)
      this.#requestTimes.delete(oldest)
      this.#networkDropped++
    }
  }
}

function boundedHeaders(headers: Record<string, string>): Record<string, string> {
  const entries: Array<[string, string]> = Object.entries(headers)
    .slice(0, 50)
    .map(([key, value]) => [key.slice(0, 128), String(value).slice(0, 1024)])
  while (Buffer.byteLength(JSON.stringify(entries)) > 8192) entries.pop()
  return Object.fromEntries(entries)
}

function boundedArgument(argument: RemoteArgument): RemoteArgument {
  return {
    type: argument.type,
    ...(argument.description ? { description: argument.description.slice(0, 2048) } : {}),
    ...(argument.unserializableValue
      ? { unserializableValue: argument.unserializableValue.slice(0, 2048) }
      : {}),
    ...(argument.preview !== undefined
      ? {
          preview:
            Buffer.byteLength(JSON.stringify(argument.preview)) <= 2048
              ? argument.preview
              : JSON.stringify(argument.preview).slice(0, 2048)
        }
      : {}),
    ...(argument.value !== undefined
      ? {
          value:
            Buffer.byteLength(JSON.stringify(argument.value)) <= 2048
              ? argument.value
              : JSON.stringify(argument.value).slice(0, 2048)
        }
      : {})
  }
}

function boundedStack(stack: StackTrace): string {
  return (stack.callFrames ?? [])
    .slice(0, 10)
    .map(
      (frame) =>
        `at ${frame.functionName.slice(0, 256) || '<anonymous>'} (${frame.url.slice(0, 512)}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`
    )
    .join('\n')
    .slice(0, 8192)
}
