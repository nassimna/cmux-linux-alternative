import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { FilesService } from './files-service'

type Document = { documentId: string; identityVersion: number }
type Indexed = { document: Document; text: string; snippet: string; indexedAtMs: number }
type Source = {
  rootGeneration: number
  revision: number
  retentionDays: number
  excludedIds: Set<string>
  excluded: boolean
  documents: Indexed[]
  partial: boolean
}

const MAX_DEPTH = 16
const MAX_ENTRIES = 8192
const MAX_FILES = 1024
const MAX_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024
const MAX_SCAN_MS = 2000

export class VaultSearchError extends Error {
  constructor(
    public readonly code: 'unauthorized' | 'stale_revision' | 'resource_limit' | 'cancelled' | 'runtime_unavailable',
    message: string
  ) {
    super(message)
    this.name = 'VaultSearchError'
  }
}
const fail = (code: VaultSearchError['code'], message: string): never => {
  throw new VaultSearchError(code, message)
}
const indexableName = (name: string): boolean =>
  !name.startsWith('.') && name !== 'node_modules' && name !== 'target' && name !== 'vendor' &&
  [...name].length <= 256 && !/\p{Cc}/u.test(name)

/** Consent and index live only in this process. No plaintext or key is written to disk. */
export class VaultSearch {
  private readonly sources = new Map<string, Source>()
  private readonly operations = new Map<string, { cancelled: boolean }>()
  private readonly confirmations = new Map<string, { source: string; expiresAtMs: number }>()

  constructor(private readonly files: FilesService) {}

  close(): void {
    this.sources.clear()
    this.operations.clear()
    this.confirmations.clear()
  }

  private source(id: string): Source {
    const source = this.sources.get(id)
    if (!source || source.excluded) throw new VaultSearchError('unauthorized', 'Search source has no active consent')
    if (this.rootGeneration(id) !== source.rootGeneration) {
      this.sources.delete(id)
      throw new VaultSearchError('unauthorized', 'Search root changed since consent')
    }
    return source
  }

  private checkRevision(source: Source | undefined, expectedRevision: number): void {
    if (expectedRevision !== (source?.revision ?? 1))
      fail('stale_revision', 'Search source revision changed')
  }

  private rootGeneration(id: string): number | undefined {
    return this.files.listRoots({ limit: 64 }).roots.find((root) => root.rootId === id)?.generation
  }

  policy(params: {
    sourceAuthorizationId: string
    sourceKind: 'workspaceFile' | 'agentTranscript'
    retentionDays: number
    exclusionIds: string[]
    mutation: { expectedRevision: number }
  }) {
    const rootGeneration = this.rootGeneration(params.sourceAuthorizationId)
    if (params.sourceKind !== 'workspaceFile' || rootGeneration === undefined)
      throw new VaultSearchError('unauthorized', 'Workspace source is unavailable or unsupported')
    const prior = this.sources.get(params.sourceAuthorizationId)
    if (prior && prior.rootGeneration !== rootGeneration) {
      this.sources.delete(params.sourceAuthorizationId)
      fail('unauthorized', 'Search root changed since consent')
    }
    this.checkRevision(prior, params.mutation.expectedRevision)
    const excludedIds = new Set(params.exclusionIds)
    const revision = (prior?.revision ?? 1) + 1
    this.sources.set(params.sourceAuthorizationId, {
      rootGeneration,
      revision, retentionDays: params.retentionDays, excludedIds, excluded: false,
      documents: prior?.documents.filter((item) => !excludedIds.has(item.document.documentId)) ?? [],
      partial: prior?.partial ?? false
    })
    return { sourceAuthorizationId: params.sourceAuthorizationId, state: 'enabled' as const, revision }
  }

  exclude(params: { sourceAuthorizationId: string; mutation: { expectedRevision: number } }) {
    const source = this.source(params.sourceAuthorizationId)
    this.checkRevision(source, params.mutation.expectedRevision)
    source.documents = []
    source.excluded = true
    source.revision++
    return { sourceAuthorizationId: params.sourceAuthorizationId, state: 'excluded' as const, revision: source.revision }
  }

  forget(params: { sourceAuthorizationId: string; mutation: { expectedRevision: number } }) {
    const source = this.sources.get(params.sourceAuthorizationId)
    if (!source) throw new VaultSearchError('unauthorized', 'Search source has no consent')
    this.checkRevision(source, params.mutation.expectedRevision)
    this.sources.delete(params.sourceAuthorizationId)
    return { sourceAuthorizationId: params.sourceAuthorizationId, state: 'forgotten' as const, revision: source.revision + 1 }
  }

  cancel(params: { cancellationId: string }) {
    const operation = this.operations.get(params.cancellationId)
    if (operation) operation.cancelled = true
    return { cancelled: Boolean(operation) }
  }

  private begin(id: string) {
    if (this.operations.has(id)) fail('resource_limit', 'Cancellation ID is already active')
    if (this.operations.size >= 16) fail('resource_limit', 'Too many search operations')
    const operation = { cancelled: false }
    this.operations.set(id, operation)
    return operation
  }

  async rebuild(params: {
    sourceAuthorizationId: string
    cancellationId: string
    mutation: { expectedRevision: number }
  }) {
    const source = this.source(params.sourceAuthorizationId)
    this.checkRevision(source, params.mutation.expectedRevision)
    if (this.rootGeneration(params.sourceAuthorizationId) !== source.rootGeneration)
      fail('unauthorized', 'Workspace source changed')
    const operation = this.begin(params.cancellationId)
    try {
      const root = this.files.listRoots({ limit: 64 }).roots.find((item) => item.rootId === params.sourceAuthorizationId)!
      const queue = [{ id: root.directoryDescriptorId, generation: root.generation, depth: 0 }]
      const documents: Indexed[] = []
      let entries = 0
      let bytes = 0
      let partial = false
      const deadline = Date.now() + MAX_SCAN_MS
      while (queue.length) {
        if (operation.cancelled) fail('cancelled', 'Search rebuild was cancelled')
        if (Date.now() >= deadline) { partial = true; break }
        const directory = queue.shift()!
        let cursor: string | undefined
        do {
          const page = this.files.listDirectory({
            directoryDescriptorId: directory.id, generation: directory.generation,
            limit: 100, ...(cursor ? { cursor } : {}), cancellationId: params.cancellationId
          })
          for (const entry of page.entries) {
            if (operation.cancelled) fail('cancelled', 'Search rebuild was cancelled')
            if (++entries > MAX_ENTRIES || Date.now() >= deadline) { partial = true; break }
            if (!indexableName(entry.label)) continue
            if (entry.kind === 'directory') {
              if (directory.depth >= MAX_DEPTH || queue.length >= 2048) { partial = true; continue }
              queue.push({ id: entry.entryDescriptorId, generation: entry.generation, depth: directory.depth + 1 })
              continue
            }
            if (documents.length >= MAX_FILES || bytes >= MAX_BYTES) { partial = true; break }
            let issued: ReturnType<FilesService['issueDocument']>
            try {
              issued = this.files.issueDocument({ authorizedDescriptorId: entry.entryDescriptorId,
                descriptorGeneration: entry.generation, expectedKind: 'plainText' })
            } catch { continue }
            if (source.excludedIds.has(issued.document.documentId)) continue
            let preview: ReturnType<FilesService['read']>
            try { preview = this.files.read({ document: issued.document, offset: 0, maxBytes: MAX_FILE_BYTES }) }
            catch { continue }
            if (preview.kind !== 'text' || !preview.chunk.eof) continue
            const size = Buffer.byteLength(preview.chunk.text)
            if (bytes + size > MAX_BYTES) { partial = true; break }
            bytes += size
            documents.push({ document: issued.document, text: preview.chunk.text,
              snippet: [...preview.chunk.text].filter((char) => !/\p{Cc}/u.test(char) || char === '\n' || char === '\t').slice(0, 512).join(''),
              indexedAtMs: Date.now() })
          }
          if (partial) break
          cursor = page.nextCursor ?? undefined
          await yieldToLoop()
        } while (cursor)
        if (partial) break
      }
      if (operation.cancelled) fail('cancelled', 'Search rebuild was cancelled')
      if (this.sources.get(params.sourceAuthorizationId) !== source || source.excluded)
        fail('unauthorized', 'Search consent changed during rebuild')
      source.documents = documents
      source.partial = partial
      source.revision++
      return { sourceAuthorizationId: params.sourceAuthorizationId,
        state: partial ? 'pausedLimit' as const : 'enabled' as const, revision: source.revision }
    } finally {
      this.operations.delete(params.cancellationId)
    }
  }

  async query(params: { query: string; limit: number; cancellationId: string }) {
    const operation = this.begin(params.cancellationId)
    try {
      const terms = [...new Set(params.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
      if (!terms.length) return { results: [], truncated: false }
      const results: Array<{ document: Document; snippet: string; sourceKind: 'workspaceFile'; indexedAtMs: number }> = []
      const cutoff = Date.now()
      for (const [id, source] of this.sources) {
        if (operation.cancelled) fail('cancelled', 'Search query was cancelled')
        if (source.excluded) continue
        if (this.rootGeneration(id) !== source.rootGeneration) {
          this.sources.delete(id)
          continue
        }
        for (const item of source.documents) {
          if (item.indexedAtMs < cutoff - source.retentionDays * 86_400_000) continue
          if (source.excludedIds.has(item.document.documentId)) continue
          if (!terms.every((term) => item.text.toLowerCase().includes(term))) continue
          try {
            const preview = this.files.read({ document: item.document, offset: 0, maxBytes: 1 })
            if (preview.kind !== 'text') continue
          } catch { continue }
          results.push({ document: item.document, snippet: item.snippet,
            sourceKind: 'workspaceFile', indexedAtMs: item.indexedAtMs })
          if (results.length >= params.limit) return { results, truncated: true }
        }
        await yieldToLoop()
      }
      return { results, truncated: false }
    } finally { this.operations.delete(params.cancellationId) }
  }

  issueExport(params: { sourceAuthorizationId: string }) {
    this.source(params.sourceAuthorizationId)
    const now = Date.now()
    for (const [id, record] of this.confirmations) if (record.expiresAtMs <= now) this.confirmations.delete(id)
    if (this.confirmations.size >= 16) fail('resource_limit', 'Too many export confirmations')
    const confirmationId = randomUUID()
    const expiresAtMs = now + 60_000
    this.confirmations.set(confirmationId, { source: params.sourceAuthorizationId, expiresAtMs })
    return { confirmation: { confirmationId, sourceAuthorizationId: params.sourceAuthorizationId, expiresAtMs } }
  }

  export(params: { sourceAuthorizationId: string; confirmationId: string }) {
    const source = this.source(params.sourceAuthorizationId)
    const confirmation = this.confirmations.get(params.confirmationId)
    this.confirmations.delete(params.confirmationId)
    if (!confirmation || confirmation.source !== params.sourceAuthorizationId || confirmation.expiresAtMs < Date.now())
      fail('unauthorized', 'Export confirmation expired or belongs to another source')
    const text = JSON.stringify({ schemaVersion: 1, sourceAuthorizationId: params.sourceAuthorizationId,
      documentCount: source.documents.length, tokenCount: source.documents.reduce((count, item) =>
        count + new Set(item.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).size, 0), generatedAtMs: Date.now() })
    return { sourceAuthorizationId: params.sourceAuthorizationId,
      artifact: { document: { documentId: randomUUID(), identityVersion: 1 }, offset: 0,
        text, eof: true, contentRevision: 1, displayName: 'search-index-summary.json' } }
  }
}
