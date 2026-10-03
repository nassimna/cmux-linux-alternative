import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { CodexAdapter, CodexAdapterError } from '../agents/codex-adapter'
import type { FilesService } from './files-service'
import {
  EncryptedIndexError,
  type EncryptedIndex,
  type IndexDocument,
  type IndexResult
} from './encrypted-index'
import { VaultSearchError } from './vault-search'

const MAX_DEPTH = 16
const MAX_ENTRIES = 8192
const MAX_FILES = 1024
const MAX_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024
const MAX_SCAN_MS = 2000
const MAX_QUERY_CANDIDATES = 1000
const QUERY_PAGE_SIZE = 100
const indexableName = (name: string): boolean =>
  !name.startsWith('.') &&
  name !== 'node_modules' &&
  name !== 'target' &&
  name !== 'vendor' &&
  [...name].length <= 256 &&
  !/\p{Cc}/u.test(name)
const fail = (code: VaultSearchError['code'], message: string): never => {
  throw new VaultSearchError(code, message)
}

type Root = ReturnType<FilesService['listRoots']>['roots'][number]

/** Search commands backed by Rust-compatible encrypted SQLite and consent. */
export class EncryptedVaultSearch {
  private readonly operations = new Map<string, AbortController>()
  private readonly confirmations = new Map<string, { source: string; expiresAtMs: number }>()
  constructor(
    private readonly index: EncryptedIndex,
    private readonly files: FilesService,
    private readonly state: ApplicationStateStore
  ) {
    try {
      this.index.clearRuntimeBoundDocuments()
    } catch (error) {
      this.index.close()
      throw error
    }
  }
  close(): void {
    for (const operation of this.operations.values()) operation.abort()
    this.operations.clear()
    this.confirmations.clear()
    this.index.close()
  }
  private root(id: string): Root | undefined {
    return this.files.listRoots({ limit: 64 }).roots.find((root) => root.rootId === id)
  }
  private agent(id: string) {
    try {
      const session = this.state.getAgentSession(id).session
      if (session.adapterId !== 'codex' || session.adapterVersion !== '0.142.4') return undefined
      return session
    } catch {
      return undefined
    }
  }
  private sourceKind(id: string): 'workspaceFile' | 'agentTranscript' | undefined {
    const root = this.root(id)
    const agent = this.agent(id)
    if (root && agent) return undefined
    if (root) return 'workspaceFile'
    if (agent) return 'agentTranscript'
    return undefined
  }
  private control(
    id: string,
    state: 'enabled' | 'excluded' | 'forgotten' | 'pausedLimit',
    expectedRevision: number
  ) {
    return { sourceAuthorizationId: id, state, revision: expectedRevision + 1 }
  }
  private begin(id: string): AbortController {
    if (this.operations.has(id) || this.operations.size >= 16)
      fail('resource_limit', 'Search operation capacity reached')
    const operation = new AbortController()
    this.operations.set(id, operation)
    return operation
  }
  private end(id: string): void {
    this.operations.delete(id)
  }
  cancel(params: { cancellationId: string }) {
    const operation = this.operations.get(params.cancellationId)
    operation?.abort()
    return { cancelled: Boolean(operation) }
  }
  policy(params: {
    sourceAuthorizationId: string
    sourceKind: 'workspaceFile' | 'agentTranscript'
    retentionDays: number
    exclusionIds: string[]
    mutation: { expectedRevision: number }
  }) {
    if (params.mutation.expectedRevision <= 0)
      fail('stale_revision', 'Search policy revision changed')
    if (this.sourceKind(params.sourceAuthorizationId) !== params.sourceKind)
      fail('unauthorized', 'Search source is unavailable')
    try {
      this.index.authorizeSource(params.sourceAuthorizationId)
      this.index.setSourcePolicy(
        params.sourceAuthorizationId,
        params.retentionDays,
        params.exclusionIds
      )
    } catch (error) {
      this.mapIndex(error)
    }
    return this.control(params.sourceAuthorizationId, 'enabled', params.mutation.expectedRevision)
  }
  exclude(params: { sourceAuthorizationId: string; mutation: { expectedRevision: number } }) {
    try {
      this.index.excludeSource(params.sourceAuthorizationId)
    } catch (error) {
      this.mapIndex(error)
    }
    return this.control(params.sourceAuthorizationId, 'excluded', params.mutation.expectedRevision)
  }
  forget(params: { sourceAuthorizationId: string; mutation: { expectedRevision: number } }) {
    try {
      this.index.forgetSource(params.sourceAuthorizationId)
    } catch (error) {
      this.mapIndex(error)
    }
    return this.control(params.sourceAuthorizationId, 'forgotten', params.mutation.expectedRevision)
  }
  private mapIndex(error: unknown): never {
    if (error instanceof EncryptedIndexError) {
      if (error.code === 'unauthorized') fail('unauthorized', 'Search source is unauthorized')
      if (error.code === 'resource_limit')
        fail('resource_limit', 'Encrypted index capacity reached')
    }
    return fail('runtime_unavailable', 'Encrypted index operation failed')
  }
  private async workspaceDocuments(
    root: Root,
    signal: AbortSignal,
    cancellationId: string
  ): Promise<{ documents: Array<{ document: IndexDocument; text: string }>; partial: boolean }> {
    const queue = [{ id: root.directoryDescriptorId, generation: root.generation, depth: 0 }]
    const documents: Array<{ document: IndexDocument; text: string }> = []
    let entries = 0,
      bytes = 0,
      partial = false
    const deadline = Date.now() + MAX_SCAN_MS
    while (queue.length) {
      if (signal.aborted) fail('cancelled', 'Search rebuild was cancelled')
      if (Date.now() >= deadline) {
        partial = true
        break
      }
      const directory = queue.shift()!
      let cursor: string | undefined
      do {
        const page = this.files.listDirectory({
          directoryDescriptorId: directory.id,
          generation: directory.generation,
          limit: 100,
          cancellationId,
          ...(cursor ? { cursor } : {})
        })
        for (const entry of page.entries) {
          if (signal.aborted) fail('cancelled', 'Search rebuild was cancelled')
          if (++entries > MAX_ENTRIES || Date.now() >= deadline) {
            partial = true
            break
          }
          if (!indexableName(entry.label)) continue
          if (entry.kind === 'directory') {
            if (directory.depth >= MAX_DEPTH || queue.length >= 2048) {
              partial = true
              continue
            }
            queue.push({
              id: entry.entryDescriptorId,
              generation: entry.generation,
              depth: directory.depth + 1
            })
            continue
          }
          if (documents.length >= MAX_FILES || bytes >= MAX_BYTES) {
            partial = true
            break
          }
          let issued: ReturnType<FilesService['issueDocument']>
          try {
            issued = this.files.issueDocument({
              authorizedDescriptorId: entry.entryDescriptorId,
              descriptorGeneration: entry.generation,
              expectedKind: 'plainText'
            })
          } catch {
            continue
          }
          let preview: ReturnType<FilesService['read']>
          try {
            preview = this.files.read({
              document: issued.document,
              offset: 0,
              maxBytes: MAX_FILE_BYTES
            })
          } catch {
            continue
          }
          if (preview.kind !== 'text' || !preview.chunk.eof) continue
          const size = Buffer.byteLength(preview.chunk.text)
          if (bytes + size > MAX_BYTES) {
            partial = true
            break
          }
          bytes += size
          documents.push({ document: issued.document, text: preview.chunk.text })
        }
        if (partial) break
        cursor = page.nextCursor ?? undefined
        await yieldToLoop()
      } while (cursor)
      if (partial) break
    }
    return { documents, partial }
  }
  private async transcriptDocuments(
    id: string,
    signal: AbortSignal
  ): Promise<{ documents: Array<{ document: IndexDocument; text: string }>; partial: boolean }> {
    const session = this.agent(id)
    if (!session) return fail('unauthorized', 'Audited Codex transcript source is unavailable')
    let adapter: CodexAdapter
    try {
      adapter = await CodexAdapter.fromExecutable()
    } catch {
      return fail('runtime_unavailable', 'Audited transcript provider is unavailable')
    }
    try {
      const transcript = await adapter.readTranscript(id, signal)
      const text = transcript.messages.map((item) => item.text).join('\n')
      return {
        documents: text
          ? [{ document: { documentId: id, identityVersion: session.revision }, text }]
          : [],
        partial: transcript.skippedItems !== 0
      }
    } catch (error) {
      if (error instanceof CodexAdapterError && error.code === 'interrupted' && signal.aborted)
        return fail('cancelled', 'Search rebuild was cancelled')
      if (error instanceof CodexAdapterError && error.code === 'resource_limit')
        return fail('resource_limit', 'Transcript exceeds search bounds')
      return fail('runtime_unavailable', 'Audited transcript provider is unavailable')
    } finally {
      adapter.close()
    }
  }
  async rebuild(params: {
    sourceAuthorizationId: string
    cancellationId: string
    mutation: { expectedRevision: number }
  }) {
    const id = params.sourceAuthorizationId
    const operation = this.begin(params.cancellationId)
    try {
      try {
        this.index.authorizeSourceRead(id)
      } catch (error) {
        this.mapIndex(error)
      }
      const kind = this.sourceKind(id)
      if (!kind) return fail('unauthorized', 'Search source is unavailable or ambiguous')
      const root = kind === 'workspaceFile' ? this.root(id) : undefined
      const collected =
        kind === 'workspaceFile'
          ? await this.workspaceDocuments(root!, operation.signal, params.cancellationId)
          : await this.transcriptDocuments(id, operation.signal)
      if (operation.signal.aborted) fail('cancelled', 'Search rebuild was cancelled')
      if (this.sourceKind(id) !== kind) fail('unauthorized', 'Search source changed during rebuild')
      this.index.rebuildSource(id)
      let partial = collected.partial
      const deadlineMs = Date.now() + MAX_SCAN_MS
      for (const { document, text } of collected.documents) {
        if (operation.signal.aborted) {
          this.index.rebuildSource(id)
          fail('cancelled', 'Search rebuild was cancelled')
        }
        try {
          this.index.indexText(id, document, kind, text, {
            maxBytes: kind === 'workspaceFile' ? MAX_FILE_BYTES : MAX_BYTES,
            deadlineMs
          })
        } catch (error) {
          if (error instanceof EncryptedIndexError && error.code === 'resource_limit') {
            partial = true
            break
          }
          this.index.rebuildSource(id)
          this.mapIndex(error)
        }
      }
      if (operation.signal.aborted) {
        this.index.rebuildSource(id)
        fail('cancelled', 'Search rebuild was cancelled')
      }
      return this.control(id, partial ? 'pausedLimit' : 'enabled', params.mutation.expectedRevision)
    } finally {
      this.end(params.cancellationId)
    }
  }
  async query(params: { query: string; limit: number; cancellationId: string; sourceAuthorizationIds?: string[] | undefined }) {
    const operation = this.begin(params.cancellationId)
    try {
      if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)
        fail('resource_limit', 'Search result limit is invalid')
      const valid: IndexResult[] = []
      let cursor: { indexedAtMs: number; rowId: number } | undefined
      let examined = 0
      for (;;) {
        if (operation.signal.aborted) fail('cancelled', 'Search query was cancelled')
        let page: ReturnType<EncryptedIndex['searchPage']>
        try {
          page = this.index.searchPage(
            params.query,
            Math.min(QUERY_PAGE_SIZE, MAX_QUERY_CANDIDATES - examined),
            params.sourceAuthorizationIds,
            cursor
          )
        } catch (error) {
          this.mapIndex(error)
        }
        await yieldToLoop()
        if (operation.signal.aborted) fail('cancelled', 'Search query was cancelled')
        for (const result of page.results) {
          if (operation.signal.aborted) fail('cancelled', 'Search query was cancelled')
          examined++
          let accessible: boolean
          if (result.sourceKind === 'workspaceFile') {
            try {
              accessible = this.files.read({ document: result.document, offset: 0, maxBytes: 1 }).kind === 'text'
            } catch {
              accessible = false
            }
          } else {
            const session = this.agent(result.document.documentId)
            accessible = Boolean(session && session.revision === result.document.identityVersion)
          }
          if (accessible) valid.push(result)
          if (valid.length > params.limit) return { results: valid.slice(0, params.limit), truncated: true }
        }
        if (!page.nextCursor) return { results: valid, truncated: false }
        if (examined >= MAX_QUERY_CANDIDATES) return { results: valid, truncated: true }
        cursor = page.nextCursor
      }
    } finally {
      this.end(params.cancellationId)
    }
  }
  issueExport(params: { sourceAuthorizationId: string }) {
    try {
      this.index.authorizeSourceRead(params.sourceAuthorizationId)
    } catch (error) {
      this.mapIndex(error)
    }
    const now = Date.now()
    for (const [id, item] of this.confirmations)
      if (item.expiresAtMs <= now) this.confirmations.delete(id)
    if (this.confirmations.size >= 16)
      fail('resource_limit', 'Export confirmation capacity reached')
    const confirmationId = randomUUID(),
      expiresAtMs = now + 60_000
    this.confirmations.set(confirmationId, { source: params.sourceAuthorizationId, expiresAtMs })
    return {
      confirmation: {
        confirmationId,
        sourceAuthorizationId: params.sourceAuthorizationId,
        expiresAtMs
      }
    }
  }
  export(params: { sourceAuthorizationId: string; confirmationId: string }) {
    try {
      this.index.authorizeSourceRead(params.sourceAuthorizationId)
    } catch (error) {
      this.mapIndex(error)
    }
    const confirmation = this.confirmations.get(params.confirmationId)
    this.confirmations.delete(params.confirmationId)
    if (
      !confirmation ||
      confirmation.source !== params.sourceAuthorizationId ||
      confirmation.expiresAtMs < Date.now()
    )
      fail('unauthorized', 'Export confirmation is unavailable')
    const summary = this.index.exportSourceSummary(params.sourceAuthorizationId)
    return {
      sourceAuthorizationId: params.sourceAuthorizationId,
      artifact: {
        document: { documentId: randomUUID(), identityVersion: 1 },
        offset: 0,
        text: JSON.stringify({
          ...summary,
          sourceAuthorizationId: params.sourceAuthorizationId,
          generatedAtMs: Date.now()
        }),
        eof: true,
        contentRevision: 1,
        displayName: 'search-index-summary.json'
      }
    }
  }
}
