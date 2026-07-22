import { createHash, randomUUID } from 'node:crypto'

import type {
  BrowserAutomationElementSummary,
  BrowserAutomationErrorCode,
  BrowserAutomationExecutionRequest,
  BrowserAutomationKey,
  BrowserAutomationOperation,
  BrowserAutomationOperationResultData,
  BrowserAutomationOperationSnapshot,
  BrowserAutomationScreenshotReadResult,
  BrowserAutomationSessionProvision,
  BrowserAutomationSessionSnapshot,
  BrowserAutomationTargetBinding
} from '@agent-workspace/protocol-client'
import type { Event, NativeImage, WebContents } from 'electron'

const CONTENT_TTL_MS = 60_000
const SESSION_IDLE_TTL_MS = 30 * 60_000
const MAX_SESSION_HANDLES = 2
const MAX_SESSION_BYTES = 32 * 1024 * 1024
const MAX_PROVIDER_HANDLES = 8
const MAX_PROVIDER_BYTES = 64 * 1024 * 1024
const MAX_PROFILE_HANDLES = 16
const MAX_PROFILE_BYTES = 128 * 1024 * 1024
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
const SCREENSHOT_CHUNK_BYTES = 512 * 1024
const MAX_QUERY_BYTES = 16 * 1024
const MAX_NAVIGATIONS = 100
const INITIAL_NAVIGATION_EPOCH = 1

export type BrowserAutomationClosedScript = 'selectorState' | 'query' | 'focus' | 'click'

export interface BrowserAutomationPage {
  readonly opaquePageToken: object
  readonly owned: boolean
  readonly target: BrowserAutomationTargetBinding
  /** Main-owned validation against the current native view/window identity. */
  revalidate(target: BrowserAutomationTargetBinding): boolean
  navigate(url: string): Promise<void>
  waitForLifecycle(
    lifecycle: 'domContentLoaded' | 'load' | 'networkIdle',
    signal: AbortSignal
  ): Promise<void>
  executeClosedScript(
    script: BrowserAutomationClosedScript,
    input: Readonly<{ selector: string; limit?: number }>
  ): Promise<unknown>
  insertText(text: string): Promise<void>
  sendKey(key: BrowserAutomationKey): void
  capture(width: number, height: number): Promise<Buffer>
  onTopLevelNavigation(listener: () => void): () => void
  destroy(): Promise<void>
}

export interface BrowserAutomationManagerDependencies {
  acquireAttachedPage(
    target: BrowserAutomationTargetBinding,
    profileKey: string,
    signal: AbortSignal
  ): Promise<BrowserAutomationPage | undefined>
  createEphemeralPage(
    session: BrowserAutomationSessionSnapshot,
    signal: AbortSignal
  ): Promise<BrowserAutomationPage>
  confirmAttachment(target: BrowserAutomationTargetBinding, signal: AbortSignal): Promise<boolean>
  now(): number
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  cancelSchedule(handle: ReturnType<typeof setTimeout>): void
}

interface LocalSession {
  readonly id: string
  readonly generation: number
  readonly profileKey: string
  readonly mode: BrowserAutomationSessionSnapshot['mode']
  readonly target: BrowserAutomationTargetBinding
  readonly page: BrowserAutomationPage
  readonly abort: AbortController
  removeNavigationListener: () => void
  navigationEpoch: number
  navigationCount: number
  lastUsedAtMs: number
  serverExpiresAtMs: number
  expiryTimer?: ReturnType<typeof setTimeout>
  pending?: { operationId: string; allowsNavigation: boolean; abort: AbortController }
  destroyed: boolean
}

interface ScreenshotRecord {
  readonly sessionId: string
  readonly generation: number
  readonly profileKey: string
  readonly handleId: string
  readonly bytes: Buffer
  readonly chunks: readonly Buffer[]
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly expiresAtMs: number
}

export class BrowserAutomationFailure extends Error {
  public constructor(public readonly code: BrowserAutomationErrorCode) {
    super(code)
  }
}

/**
 * Main-only executor for the closed M5 operation set. It intentionally accepts no
 * renderer sender, raw webContents ID, caller script, CDP command, or partition.
 */
export class BrowserAutomationManager {
  readonly #dependencies: BrowserAutomationManagerDependencies
  readonly #sessions = new Map<string, LocalSession>()
  readonly #screenshots = new Map<string, ScreenshotRecord>()
  #disposed = false

  public constructor(dependencies: BrowserAutomationManagerDependencies) {
    this.#dependencies = dependencies
  }

  public async execute(
    request: BrowserAutomationExecutionRequest
  ): Promise<BrowserAutomationOperationSnapshot> {
    this.assertActive()
    this.purgeExpiredContent()
    const session = await this.ensureSession(request.session)
    this.guard(request, session)
    if (session.pending) throw new BrowserAutomationFailure('automation_backpressure')
    session.lastUsedAtMs = this.#dependencies.now()
    this.scheduleSessionExpiry(session)

    const controller = new AbortController()
    session.pending = {
      operationId: request.operation.operationId,
      allowsNavigation: request.operation.operation.kind === 'navigate',
      abort: controller
    }
    const timeout = this.#dependencies.schedule(
      () => controller.abort(new BrowserAutomationFailure('timeout')),
      request.operation.timeoutMs
    )
    try {
      const result = await this.runOperation(request, session, controller.signal)
      this.guard(request, session, request.operation.operation.kind === 'navigate')
      return this.snapshot(request, session, 'succeeded', result)
    } catch (error) {
      const code = failureCode(error, controller.signal)
      return this.snapshot(request, session, terminalState(code), undefined, code)
    } finally {
      this.#dependencies.cancelSchedule(timeout)
      if (session.pending?.operationId === request.operation.operationId) delete session.pending
    }
  }

  public async createProvision(
    provision: BrowserAutomationSessionProvision,
    window: BrowserAutomationTargetBinding['window']
  ): Promise<BrowserAutomationSessionSnapshot> {
    const target =
      provision.mode === 'attach'
        ? provision.requestedTarget
        : {
            workspaceId: randomUUID(),
            paneId: randomUUID(),
            tabId: randomUUID(),
            browserSessionId: randomUUID(),
            browserLifecycleId: randomUUID(),
            window
          }
    if (!target) throw new BrowserAutomationFailure('target_required')
    if (
      target.window.windowId !== window.windowId ||
      target.window.windowGeneration !== window.windowGeneration
    ) {
      throw new BrowserAutomationFailure('target_stale')
    }
    const now = this.#dependencies.now()
    const snapshot: BrowserAutomationSessionSnapshot = {
      automationSessionId: provision.automationSessionId,
      generation: provision.generation,
      // The service reserves epoch 1 for a newly provisioned durable session. Epoch 0 remains a
      // valid imported snapshot, but a provider-created binding must match its reservation.
      navigationEpoch: INITIAL_NAVIGATION_EPOCH,
      mode: provision.mode,
      state: 'ready',
      profileKey: provision.profileKey,
      target,
      createdAtMs: provision.createdAtMs,
      updatedAtMs: now,
      expiresAtMs: provision.expiresAtMs
    }
    await this.ensureSession(snapshot)
    return snapshot
  }

  public async createSession(snapshot: BrowserAutomationSessionSnapshot): Promise<void> {
    await this.ensureSession(snapshot)
  }

  public canAcknowledgeSession(snapshot: BrowserAutomationSessionSnapshot): boolean {
    const session = this.#sessions.get(snapshot.automationSessionId)
    return Boolean(
      session &&
      session.generation === snapshot.generation &&
      sameTarget(session.target, snapshot.target) &&
      session.page.revalidate(session.target)
    )
  }

  public canAcknowledge(request: BrowserAutomationExecutionRequest): boolean {
    const session = this.#sessions.get(request.session.automationSessionId)
    if (!session) return false
    try {
      this.guardTargetOnly(request, session)
      return true
    } catch {
      return false
    }
  }

  public cancel(sessionId: string, generation: number, operationId: string): boolean {
    const session = this.#sessions.get(sessionId)
    if (!session || session.generation !== generation) return false
    if (session.pending?.operationId !== operationId) return false
    session.pending.abort.abort(new BrowserAutomationFailure('canceled'))
    return true
  }

  public async destroySession(sessionId: string, generation?: number): Promise<void> {
    const session = this.#sessions.get(sessionId)
    if (!session || (generation !== undefined && generation !== session.generation)) return
    this.#sessions.delete(sessionId)
    session.destroyed = true
    if (session.expiryTimer !== undefined) {
      this.#dependencies.cancelSchedule(session.expiryTimer)
      delete session.expiryTimer
    }
    session.pending?.abort.abort(new BrowserAutomationFailure('interrupted'))
    session.abort.abort(new BrowserAutomationFailure('interrupted'))
    session.removeNavigationListener()
    this.releaseSessionScreenshots(session.id)
    if (session.page.owned) await session.page.destroy().catch(() => undefined)
  }

  public async destroyTarget(windowId: string, windowGeneration: number): Promise<void> {
    const matching = [...this.#sessions.values()].filter(
      ({ target }) =>
        target.window.windowId === windowId && target.window.windowGeneration === windowGeneration
    )
    await Promise.all(matching.map(({ id }) => this.destroySession(id)))
  }

  public readScreenshot(
    sessionId: string,
    generation: number,
    handleId: string,
    chunkIndex: number
  ): BrowserAutomationScreenshotReadResult {
    this.assertActive()
    this.purgeExpiredContent()
    const session = this.#sessions.get(sessionId)
    const record = this.#screenshots.get(handleId)
    if (!session || session.generation !== generation || !record) {
      throw new BrowserAutomationFailure('result_expired')
    }
    if (
      record.sessionId !== sessionId ||
      record.generation !== generation ||
      !session.page.revalidate(session.target)
    ) {
      throw new BrowserAutomationFailure('target_stale')
    }
    const chunk = record.chunks[chunkIndex]
    if (!chunk) throw new BrowserAutomationFailure('invalid_operation')
    return {
      handleId,
      chunkIndex,
      chunkCount: record.chunks.length,
      dataBase64: chunk.toString('base64'),
      sha256: record.sha256,
      expiresAtMs: record.expiresAtMs
    }
  }

  public releaseScreenshot(sessionId: string, generation: number, handleId: string): boolean {
    const session = this.#sessions.get(sessionId)
    if (!session || session.generation !== generation) return false
    if (!session.page.revalidate(session.target)) {
      throw new BrowserAutomationFailure('target_stale')
    }
    const record = this.#screenshots.get(handleId)
    if (!record || record.sessionId !== sessionId || record.generation !== generation) return false
    record.bytes.fill(0)
    this.#screenshots.delete(handleId)
    return true
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await Promise.all([...this.#sessions.keys()].map((sessionId) => this.destroySession(sessionId)))
    for (const record of this.#screenshots.values()) record.bytes.fill(0)
    this.#screenshots.clear()
  }

  public get diagnosticCounts(): Readonly<{
    sessions: number
    pending: number
    screenshots: number
  }> {
    return {
      sessions: this.#sessions.size,
      pending: [...this.#sessions.values()].filter(({ pending }) => pending !== undefined).length,
      screenshots: this.#screenshots.size
    }
  }

  private async ensureSession(snapshot: BrowserAutomationSessionSnapshot): Promise<LocalSession> {
    const current = this.#sessions.get(snapshot.automationSessionId)
    if (current) {
      if (current.generation !== snapshot.generation) {
        throw new BrowserAutomationFailure('session_generation_mismatch')
      }
      if (!sameTarget(current.target, snapshot.target) || current.mode !== snapshot.mode) {
        throw new BrowserAutomationFailure('target_stale')
      }
      current.serverExpiresAtMs = snapshot.expiresAtMs
      this.scheduleSessionExpiry(current)
      return current
    }
    if (this.#sessions.size >= 8) throw new BrowserAutomationFailure('session_limit')
    if (snapshot.state !== 'ready' || snapshot.expiresAtMs <= this.#dependencies.now()) {
      throw new BrowserAutomationFailure('session_expired')
    }

    const abort = new AbortController()
    let page: BrowserAutomationPage | undefined
    if (snapshot.mode === 'attach') {
      if (!(await this.#dependencies.confirmAttachment(snapshot.target, abort.signal))) {
        throw new BrowserAutomationFailure('policy_denied')
      }
      page = await this.#dependencies.acquireAttachedPage(
        snapshot.target,
        snapshot.profileKey,
        abort.signal
      )
      if (!page || page.owned) throw new BrowserAutomationFailure('target_not_found')
    } else {
      page = await this.#dependencies.createEphemeralPage(snapshot, abort.signal)
      if (!page.owned) throw new BrowserAutomationFailure('policy_denied')
    }
    if (!sameTarget(page.target, snapshot.target) || !page.revalidate(snapshot.target)) {
      if (page.owned) await page.destroy().catch(() => undefined)
      throw new BrowserAutomationFailure('target_stale')
    }

    const session: LocalSession = {
      id: snapshot.automationSessionId,
      generation: snapshot.generation,
      profileKey: snapshot.profileKey,
      mode: snapshot.mode,
      target: snapshot.target,
      page,
      abort,
      navigationEpoch: snapshot.navigationEpoch,
      navigationCount: 0,
      lastUsedAtMs: this.#dependencies.now(),
      serverExpiresAtMs: snapshot.expiresAtMs,
      destroyed: false,
      removeNavigationListener: () => undefined
    }
    session.removeNavigationListener = page.onTopLevelNavigation(() => {
      session.navigationEpoch += 1
      session.navigationCount += 1
      if (session.pending && !session.pending.allowsNavigation) {
        session.pending.abort.abort(
          new BrowserAutomationFailure(
            session.navigationCount > MAX_NAVIGATIONS ? 'resource_limit' : 'stale_navigation'
          )
        )
      }
    })
    this.#sessions.set(session.id, session)
    this.scheduleSessionExpiry(session)
    return session
  }

  private async runOperation(
    request: BrowserAutomationExecutionRequest,
    session: LocalSession,
    signal: AbortSignal
  ): Promise<BrowserAutomationOperationResultData> {
    const operation = request.operation.operation
    switch (operation.kind) {
      case 'navigate': {
        if (session.navigationCount >= MAX_NAVIGATIONS) {
          throw new BrowserAutomationFailure('resource_limit')
        }
        this.guard(request, session)
        await abortable(session.page.navigate(operation.url), signal)
        this.guardTargetOnly(request, session)
        // The page callback is authoritative when Electron emitted it; fakes and
        // loadURL failures that never emit still advance exactly once here.
        if (session.navigationEpoch === request.operation.navigationEpoch) {
          session.navigationEpoch += 1
          session.navigationCount += 1
        }
        return { kind: 'navigation', navigationEpoch: session.navigationEpoch }
      }
      case 'wait':
        await this.waitForCondition(request, session, operation, signal)
        return { kind: 'empty' }
      case 'query': {
        this.guard(request, session)
        const raw = await abortable(
          session.page.executeClosedScript('query', {
            selector: operation.selector,
            limit: operation.limit
          }),
          signal
        )
        this.guard(request, session)
        const matches = parseElementSummaries(raw, operation.limit)
        if (Buffer.byteLength(JSON.stringify(matches), 'utf8') > MAX_QUERY_BYTES) {
          throw new BrowserAutomationFailure('resource_limit')
        }
        return { kind: 'query', matches }
      }
      case 'focus':
      case 'click':
        this.guard(request, session)
        await abortable(
          session.page.executeClosedScript(operation.kind, { selector: operation.selector }),
          signal
        )
        this.guard(request, session)
        return { kind: 'empty' }
      case 'typeText':
        await this.focusSelector(request, session, operation.selector, signal)
        this.guard(request, session)
        await abortable(session.page.insertText(operation.text), signal)
        this.guard(request, session)
        return { kind: 'empty' }
      case 'key':
        this.guard(request, session)
        session.page.sendKey(operation.key)
        this.guard(request, session)
        return { kind: 'empty' }
      case 'keyAt':
        await this.focusSelector(request, session, operation.selector, signal)
        this.guard(request, session)
        session.page.sendKey(operation.key)
        this.guard(request, session)
        return { kind: 'empty' }
      case 'screenshot': {
        this.guard(request, session)
        const bytes = await abortable(
          session.page.capture(operation.width, operation.height),
          signal
        )
        this.guard(request, session)
        return this.retainScreenshot(session, operation.width, operation.height, bytes)
      }
    }
  }

  private async focusSelector(
    request: BrowserAutomationExecutionRequest,
    session: LocalSession,
    selector: string,
    signal: AbortSignal
  ): Promise<void> {
    this.guard(request, session)
    await abortable(session.page.executeClosedScript('focus', { selector }), signal)
    this.guard(request, session)
  }

  private async waitForCondition(
    request: BrowserAutomationExecutionRequest,
    session: LocalSession,
    operation: Extract<BrowserAutomationOperation, { kind: 'wait' }>,
    signal: AbortSignal
  ): Promise<void> {
    if (operation.condition.kind === 'lifecycle') {
      await abortable(session.page.waitForLifecycle(operation.condition.lifecycle, signal), signal)
      if (operation.condition.lifecycle === 'networkIdle') {
        await abortable(delay(this.#dependencies, 500), signal)
      }
      this.guard(request, session)
      return
    }
    while (!signal.aborted) {
      this.guard(request, session)
      const raw = await abortable(
        session.page.executeClosedScript('selectorState', {
          selector: operation.condition.selector
        }),
        signal
      )
      this.guard(request, session)
      const state = parseSelectorState(raw)
      if (selectorConditionMatches(state, operation.condition.condition)) return
      await abortable(delay(this.#dependencies, 50), signal)
    }
    throw signal.reason
  }

  private retainScreenshot(
    session: LocalSession,
    width: number,
    height: number,
    bytes: Buffer
  ): BrowserAutomationOperationResultData {
    if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) {
      bytes.fill(0)
      throw new BrowserAutomationFailure('resource_limit')
    }
    const records = [...this.#screenshots.values()]
    const sessionRecords = records.filter(({ sessionId }) => sessionId === session.id)
    const profileRecords = records.filter(({ profileKey }) => profileKey === session.profileKey)
    const providerBytes = records.reduce((sum, record) => sum + record.bytes.length, 0)
    const sessionBytes = sessionRecords.reduce((sum, record) => sum + record.bytes.length, 0)
    const profileBytes = profileRecords.reduce((sum, record) => sum + record.bytes.length, 0)
    if (
      sessionRecords.length >= MAX_SESSION_HANDLES ||
      sessionBytes + bytes.length > MAX_SESSION_BYTES ||
      records.length >= MAX_PROVIDER_HANDLES ||
      providerBytes + bytes.length > MAX_PROVIDER_BYTES ||
      profileRecords.length >= MAX_PROFILE_HANDLES ||
      profileBytes + bytes.length > MAX_PROFILE_BYTES
    ) {
      bytes.fill(0)
      throw new BrowserAutomationFailure('resource_limit')
    }
    const handleId = randomUUID()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const chunks: Buffer[] = []
    for (let offset = 0; offset < bytes.length; offset += SCREENSHOT_CHUNK_BYTES) {
      chunks.push(bytes.subarray(offset, Math.min(offset + SCREENSHOT_CHUNK_BYTES, bytes.length)))
    }
    if (chunks.length > 32) {
      bytes.fill(0)
      throw new BrowserAutomationFailure('resource_limit')
    }
    const expiresAtMs = this.#dependencies.now() + CONTENT_TTL_MS
    this.#screenshots.set(handleId, {
      sessionId: session.id,
      generation: session.generation,
      profileKey: session.profileKey,
      handleId,
      bytes,
      chunks,
      sha256,
      width,
      height,
      expiresAtMs
    })
    return {
      kind: 'screenshot',
      handle: {
        handleId,
        width,
        height,
        byteLength: bytes.length,
        mediaType: 'image/png',
        sha256,
        chunkCount: chunks.length,
        expiresAtMs
      }
    }
  }

  private guard(
    request: BrowserAutomationExecutionRequest,
    session: LocalSession,
    allowAdvancedNavigation = false
  ): void {
    this.guardTargetOnly(request, session)
    if (
      !allowAdvancedNavigation &&
      (request.operation.navigationEpoch !== session.navigationEpoch ||
        request.session.navigationEpoch !== session.navigationEpoch)
    ) {
      throw new BrowserAutomationFailure('stale_navigation')
    }
  }

  private guardTargetOnly(request: BrowserAutomationExecutionRequest, session: LocalSession): void {
    this.assertActive()
    if (
      session.destroyed ||
      this.#sessions.get(session.id) !== session ||
      request.operation.sessionGeneration !== session.generation ||
      request.session.generation !== session.generation ||
      request.operation.automationSessionId !== session.id ||
      request.target.windowId !== session.target.window.windowId ||
      request.target.windowGeneration !== session.target.window.windowGeneration ||
      !sameTarget(request.session.target, session.target) ||
      !session.page.revalidate(session.target)
    ) {
      throw new BrowserAutomationFailure('target_stale')
    }
    if (session.navigationCount > MAX_NAVIGATIONS) {
      throw new BrowserAutomationFailure('resource_limit')
    }
    if (
      session.serverExpiresAtMs <= this.#dependencies.now() ||
      this.#dependencies.now() - session.lastUsedAtMs > SESSION_IDLE_TTL_MS
    ) {
      throw new BrowserAutomationFailure('session_expired')
    }
  }

  private snapshot(
    request: BrowserAutomationExecutionRequest,
    session: LocalSession,
    state: BrowserAutomationOperationSnapshot['state'],
    result?: BrowserAutomationOperationResultData,
    errorCode?: BrowserAutomationErrorCode
  ): BrowserAutomationOperationSnapshot {
    return {
      automationSessionId: session.id,
      sessionGeneration: session.generation,
      operationId: request.operation.operationId,
      correlationId: request.operation.correlationId,
      attemptEpoch: request.operation.attemptEpoch,
      navigationEpoch: session.navigationEpoch,
      state,
      ...(result === undefined ? {} : { result }),
      ...(errorCode === undefined ? {} : { errorCode }),
      updatedAtMs: this.#dependencies.now()
    }
  }

  private releaseSessionScreenshots(sessionId: string): void {
    for (const [handleId, record] of this.#screenshots) {
      if (record.sessionId !== sessionId) continue
      record.bytes.fill(0)
      this.#screenshots.delete(handleId)
    }
  }

  private purgeExpiredContent(): void {
    const now = this.#dependencies.now()
    for (const [handleId, record] of this.#screenshots) {
      if (record.expiresAtMs > now) continue
      record.bytes.fill(0)
      this.#screenshots.delete(handleId)
    }
    for (const session of this.#sessions.values()) {
      if (now - session.lastUsedAtMs <= SESSION_IDLE_TTL_MS) continue
      void this.destroySession(session.id)
    }
  }

  private scheduleSessionExpiry(session: LocalSession): void {
    if (session.destroyed || this.#sessions.get(session.id) !== session) return
    if (session.expiryTimer !== undefined) this.#dependencies.cancelSchedule(session.expiryTimer)
    const now = this.#dependencies.now()
    const expiresAtMs = Math.min(
      session.serverExpiresAtMs,
      session.lastUsedAtMs + SESSION_IDLE_TTL_MS
    )
    session.expiryTimer = this.#dependencies.schedule(
      () => {
        delete session.expiryTimer
        const current = this.#sessions.get(session.id)
        if (!current || current !== session || current.destroyed) return
        const observedAt = this.#dependencies.now()
        if (
          current.serverExpiresAtMs <= observedAt ||
          observedAt - current.lastUsedAtMs >= SESSION_IDLE_TTL_MS
        ) {
          void this.destroySession(current.id, current.generation)
          return
        }
        this.scheduleSessionExpiry(current)
      },
      Math.max(0, expiresAtMs - now)
    )
  }

  private assertActive(): void {
    if (this.#disposed) throw new BrowserAutomationFailure('provider_unavailable')
  }
}

const CLOSED_SCRIPTS: Readonly<Record<BrowserAutomationClosedScript, string>> = {
  selectorState: `(input => {
    const element = document.querySelector(input.selector)
    if (!element) return { attached: false, visible: false, enabled: false }
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      attached: element.isConnected,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      enabled: !('disabled' in element) || element.disabled !== true
    }
  })`,
  query: `(input => Array.from(document.querySelectorAll(input.selector)).slice(0, input.limit).map((element, index) => {
    const name = element.tagName.toLowerCase()
    const tag = name === 'a' ? 'link' : name === 'img' ? 'image' :
      ['button','input','textarea','select','form','dialog'].includes(name) ? name : 'generic'
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      index,
      tag,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      enabled: !('disabled' in element) || element.disabled !== true,
      focused: document.activeElement === element,
      editable: name === 'input' || name === 'textarea' || element.isContentEditable === true
    }
  }))`,
  focus: `(input => {
    const element = document.querySelector(input.selector)
    if (!(element instanceof HTMLElement)) throw new Error('selector did not match a focusable element')
    element.focus({ preventScroll: true })
    return true
  })`,
  click: `(input => {
    const element = document.querySelector(input.selector)
    if (!(element instanceof HTMLElement)) throw new Error('selector did not match a clickable element')
    element.click()
    return true
  })`
}

const KEY_CODES: Readonly<Record<BrowserAutomationKey, string>> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  arrowUp: 'Up',
  arrowDown: 'Down',
  arrowLeft: 'Left',
  arrowRight: 'Right',
  home: 'Home',
  end: 'End',
  pageUp: 'PageUp',
  pageDown: 'PageDown',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space'
}

/** Builds the only WebContents adapter accepted by BrowserAutomationManager. */
export function createElectronAutomationPage(options: {
  contents: WebContents
  owned: boolean
  target: BrowserAutomationTargetBinding
  revalidate: () => boolean
  destroyOwned?: () => Promise<void>
  prepareCapture?: (width: number, height: number) => void
}): BrowserAutomationPage {
  const token = {}
  return {
    opaquePageToken: token,
    owned: options.owned,
    target: options.target,
    revalidate: (target) => sameTarget(target, options.target) && options.revalidate(),
    navigate: async (url) => {
      let redirects = 0
      let exceeded = false
      const redirect = (event: Event): void => {
        redirects += 1
        if (redirects <= 20) return
        exceeded = true
        event.preventDefault()
        options.contents.stop()
      }
      options.contents.on('will-redirect', redirect)
      try {
        await options.contents.loadURL(url)
        if (exceeded) throw new BrowserAutomationFailure('resource_limit')
      } finally {
        options.contents.removeListener('will-redirect', redirect)
      }
    },
    waitForLifecycle: async (lifecycle, signal) => {
      if (!options.contents.isLoadingMainFrame()) return
      const event =
        lifecycle === 'domContentLoaded'
          ? 'dom-ready'
          : lifecycle === 'load'
            ? 'did-finish-load'
            : 'did-stop-loading'
      await waitForContentsEvent(options.contents, event, signal)
    },
    executeClosedScript: async (script, input) => {
      // `script` is a closed local enum and input is JSON encoded as data. No caller
      // bytes are ever concatenated into executable source.
      const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64')
      const source = `${CLOSED_SCRIPTS[script]}((encoded => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)))))('${encoded}'))`
      const result: unknown = await options.contents.executeJavaScript(source, true)
      return result
    },
    insertText: async (text) => options.contents.insertText(text),
    sendKey: (key) => {
      const code = KEY_CODES[key]
      options.contents.sendInputEvent({ type: 'keyDown', keyCode: code })
      options.contents.sendInputEvent({ type: 'keyUp', keyCode: code })
    },
    capture: async (width, height) => {
      options.prepareCapture?.(width, height)
      const image: NativeImage = await options.contents.capturePage({ x: 0, y: 0, width, height })
      const captured = image.getSize()
      if (captured.width !== width || captured.height !== height) {
        throw new BrowserAutomationFailure('resource_limit')
      }
      return image.toPNG()
    },
    onTopLevelNavigation: (listener) => {
      const handler = (event: Event): void => {
        if ('isMainFrame' in event && event.isMainFrame === false) return
        listener()
      }
      options.contents.on('did-start-navigation', handler)
      options.contents.on('render-process-gone', listener)
      options.contents.once('destroyed', listener)
      return () => {
        options.contents.removeListener('did-start-navigation', handler)
        options.contents.removeListener('render-process-gone', listener)
        options.contents.removeListener('destroyed', listener)
      }
    },
    destroy: async () => {
      if (!options.owned) return
      await options.destroyOwned?.()
    }
  }
}

function parseElementSummaries(value: unknown, limit: number): BrowserAutomationElementSummary[] {
  if (!Array.isArray(value) || value.length > limit || value.length > 100) {
    throw new BrowserAutomationFailure('resource_limit')
  }
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new BrowserAutomationFailure('invalid_operation')
    const tag = candidate.tag
    if (
      ![
        'button',
        'input',
        'textarea',
        'select',
        'link',
        'form',
        'image',
        'dialog',
        'generic'
      ].includes(String(tag)) ||
      typeof candidate.visible !== 'boolean' ||
      typeof candidate.enabled !== 'boolean' ||
      typeof candidate.focused !== 'boolean' ||
      typeof candidate.editable !== 'boolean'
    ) {
      throw new BrowserAutomationFailure('invalid_operation')
    }
    return {
      index,
      tag: tag as BrowserAutomationElementSummary['tag'],
      visible: candidate.visible,
      enabled: candidate.enabled,
      focused: candidate.focused,
      editable: candidate.editable
    }
  })
}

function parseSelectorState(value: unknown): {
  attached: boolean
  visible: boolean
  enabled: boolean
} {
  if (
    !isRecord(value) ||
    typeof value.attached !== 'boolean' ||
    typeof value.visible !== 'boolean' ||
    typeof value.enabled !== 'boolean'
  ) {
    throw new BrowserAutomationFailure('invalid_operation')
  }
  return value as { attached: boolean; visible: boolean; enabled: boolean }
}

function selectorConditionMatches(
  state: { attached: boolean; visible: boolean; enabled: boolean },
  condition: 'attached' | 'visible' | 'hidden' | 'enabled'
): boolean {
  switch (condition) {
    case 'attached':
      return state.attached
    case 'visible':
      return state.visible
    case 'hidden':
      return !state.visible
    case 'enabled':
      return state.enabled
  }
}

function terminalState(
  code: BrowserAutomationErrorCode
): BrowserAutomationOperationSnapshot['state'] {
  if (code === 'canceled') return 'canceled'
  if (code === 'timeout') return 'expired'
  if (code === 'interrupted' || code === 'provider_unavailable') return 'interrupted'
  if (code === 'result_expired') return 'resultExpired'
  return 'failed'
}

function failureCode(error: unknown, signal: AbortSignal): BrowserAutomationErrorCode {
  const reason: unknown = signal.aborted ? (signal.reason as unknown) : error
  return reason instanceof BrowserAutomationFailure ? reason.code : 'invalid_operation'
}

function sameTarget(
  left: BrowserAutomationTargetBinding,
  right: BrowserAutomationTargetBinding
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.paneId === right.paneId &&
    left.tabId === right.tabId &&
    left.browserSessionId === right.browserSessionId &&
    left.browserLifecycleId === right.browserLifecycleId &&
    left.window.windowId === right.window.windowId &&
    left.window.windowGeneration === right.window.windowGeneration
  )
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const canceled = (): void => reject(abortError(signal))
    signal.addEventListener('abort', canceled, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', canceled))
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new BrowserAutomationFailure('canceled')
}

function waitForContentsEvent(
  contents: WebContents,
  event: 'dom-ready' | 'did-finish-load' | 'did-stop-loading',
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      removeLifecycleListener(contents, event, completed)
      contents.removeListener('destroyed', destroyed)
      signal.removeEventListener('abort', canceled)
    }
    const completed = (): void => {
      cleanup()
      resolve()
    }
    const destroyed = (): void => {
      cleanup()
      reject(new BrowserAutomationFailure('interrupted'))
    }
    const canceled = (): void => {
      cleanup()
      reject(abortError(signal))
    }
    addLifecycleListener(contents, event, completed)
    contents.once('destroyed', destroyed)
    signal.addEventListener('abort', canceled, { once: true })
  })
}

function addLifecycleListener(
  contents: WebContents,
  event: 'dom-ready' | 'did-finish-load' | 'did-stop-loading',
  listener: () => void
): void {
  if (event === 'dom-ready') contents.once('dom-ready', listener)
  else if (event === 'did-finish-load') contents.once('did-finish-load', listener)
  else contents.once('did-stop-loading', listener)
}

function removeLifecycleListener(
  contents: WebContents,
  event: 'dom-ready' | 'did-finish-load' | 'did-stop-loading',
  listener: () => void
): void {
  if (event === 'dom-ready') contents.removeListener('dom-ready', listener)
  else if (event === 'did-finish-load') contents.removeListener('did-finish-load', listener)
  else contents.removeListener('did-stop-loading', listener)
}

function delay(dependencies: BrowserAutomationManagerDependencies, delayMs: number): Promise<void> {
  return new Promise((resolve) => dependencies.schedule(resolve, delayMs))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
