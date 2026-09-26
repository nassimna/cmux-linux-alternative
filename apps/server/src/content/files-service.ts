import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  opendirSync,
  readSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import type { ApplicationStateStore } from '../persistence/application-state-store'
import { boundedDiff, parseSafeMarkdown } from './safe-preview'

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants
const MAX_ROOTS = 64
const MAX_ENTRIES = 8192
const MAX_DOCUMENTS = 4096
const MAX_SCAN = 4096
const MAX_FILE = 8 * 1024 * 1024
const MAX_SAVE = 256 * 1024
const MAX_SCAN_MS = 500

type Identity = string
type Root = {
  id: string
  path: string
  label: string
  fd: number
  identity: Identity
  generation: number
  descriptorId: string
}
type Entry = {
  id: string
  rootId: string
  parts: string[]
  label: string
  kind: 'directory' | 'file'
  identity: Identity
  generation: number
}
type Document = {
  id: string
  rootId: string
  parts: string[]
  label: string
  identity: Identity
  version: number
  revision: number
}

export class FilesServiceError extends Error {
  constructor(
    public readonly code:
      | 'unauthorized'
      | 'stale_revision'
      | 'resource_limit'
      | 'unsupported_encoding'
      | 'invalid_params',
    message: string
  ) {
    super(message)
    this.name = 'FilesServiceError'
  }
}
function fail(code: FilesServiceError['code']): never {
  const message =
    code === 'unauthorized'
      ? 'The opaque document is not authorized'
      : code === 'stale_revision'
        ? 'The opaque document identity changed'
        : code === 'resource_limit'
          ? 'The content exceeds its fixed bound'
          : code === 'unsupported_encoding'
            ? 'The content encoding is unsupported'
            : 'Invalid Files parameters'
  throw new FilesServiceError(code, message)
}
const identity = (fd: number, file = false): Identity => {
  const stat = fstatSync(fd, { bigint: true })
  if (file && (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE)))
    fail('unauthorized')
  if (!file && !stat.isDirectory()) fail('unauthorized')
  return file
    ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    : `${stat.dev}:${stat.ino}`
}
const sameFileAfterExchange = (actual: Identity, expected: Identity): boolean =>
  actual.split(':').slice(0, 4).join(':') === expected.split(':').slice(0, 4).join(':')

function fingerprint(fd: number): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let offset = 0
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, offset)
    if (count === 0) break
    offset += count
    if (offset > MAX_FILE) fail('resource_limit')
    hash.update(buffer.subarray(0, count))
  }
  return hash.digest('hex')
}

type Exchange = (oldDir: number, oldName: string, newDir: number, newName: string) => void
let exchange: Exchange | undefined
function exchangeAt(oldDir: number, oldName: string, newDir: number, newName: string): void {
  if (!exchange) {
    const require = createRequire(import.meta.url)
    const here = dirname(fileURLToPath(import.meta.url))
    const addon = here.endsWith('/content')
      ? join(here, '../../dist/rename-exchange.node')
      : join(here, 'rename-exchange.node')
    exchange = (require(addon) as { exchange: Exchange }).exchange
  }
  exchange(oldDir, oldName, newDir, newName)
}
const openPart = (parent: number, part: string, directory: boolean): number => {
  if (!part || part === '.' || part === '..' || part.includes(sep) || part.includes('\0'))
    fail('unauthorized')
  return openSync(
    `/proc/self/fd/${parent}/${part}`,
    O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (directory ? O_DIRECTORY : 0)
  )
}
function openAbsolute(path: string): number {
  if (!isAbsolute(path) || parse(path).root !== '/') fail('unauthorized')
  let fd = openSync('/', O_RDONLY | O_DIRECTORY)
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = openPart(fd, part, true)
      closeSync(fd)
      fd = next
    }
    if (fstatSync(fd).uid !== process.getuid?.()) fail('unauthorized')
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}
function openBeneath(rootFd: number, parts: string[], directory: boolean): number {
  if (parts.length === 0) return openSync(`/proc/self/fd/${rootFd}`, O_RDONLY | O_DIRECTORY)
  let fd: number | undefined
  try {
    for (let index = 0; index < parts.length; index++) {
      const next = openPart(fd ?? rootFd, parts[index]!, index < parts.length - 1 || directory)
      if (fd !== undefined) closeSync(fd)
      fd = next
    }
    return fd!
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    throw error
  }
}
function safeLabel(value: string): boolean {
  return (
    value.length > 0 &&
    [...value].length <= 256 &&
    ![...value].some((character) => {
      const point = character.codePointAt(0)!
      return point < 32 || (point >= 127 && point <= 159)
    })
  )
}

/** Ephemeral capabilities over the isolated writer's current workspace snapshot. Linux only. */
export class FilesService {
  private roots = new Map<string, Root>()
  private entries = new Map<string, Entry>()
  private documents = new Map<string, Document>()
  private generation = 0
  constructor(private readonly store: ApplicationStateStore) {
    if (process.platform !== 'linux')
      throw new Error('Files service requires Linux descriptor traversal')
  }
  close(): void {
    for (const root of this.roots.values()) closeSync(root.fd)
    this.roots.clear()
    this.entries.clear()
    this.documents.clear()
  }
  private revoke(id: string): void {
    const root = this.roots.get(id)
    if (root) closeSync(root.fd)
    this.roots.delete(id)
    for (const [key, entry] of this.entries) if (entry.rootId === id) this.entries.delete(key)
    for (const [key, document] of this.documents)
      if (document.rootId === id) this.documents.delete(key)
  }
  private sync(): void {
    const workspaces = this.store.readSnapshot().workspaces
    if (workspaces.length > MAX_ROOTS) {
      this.close()
      fail('resource_limit')
    }
    const desired = new Set(workspaces.map((workspace) => workspace.id))
    for (const id of this.roots.keys()) if (!desired.has(id)) this.revoke(id)
    for (const workspace of workspaces) {
      const existing = this.roots.get(workspace.id)
      if (
        existing &&
        (existing.path !== workspace.workingDirectory || existing.label !== workspace.name)
      )
        this.revoke(workspace.id)
      let fd: number
      try {
        fd = openAbsolute(workspace.workingDirectory)
      } catch (error) {
        this.revoke(workspace.id)
        throw error instanceof FilesServiceError
          ? error
          : new FilesServiceError('unauthorized', 'Workspace root is unavailable')
      }
      const currentIdentity = identity(fd)
      const retained = this.roots.get(workspace.id)
      if (retained?.identity === currentIdentity) {
        closeSync(fd)
        continue
      }
      if (retained) this.revoke(workspace.id)
      const generation = ++this.generation
      const descriptorId = randomUUID()
      this.roots.set(workspace.id, {
        id: workspace.id,
        path: workspace.workingDirectory,
        label: workspace.name,
        fd,
        identity: currentIdentity,
        generation,
        descriptorId
      })
      this.entries.set(descriptorId, {
        id: descriptorId,
        rootId: workspace.id,
        parts: [],
        label: workspace.name,
        kind: 'directory',
        identity: currentIdentity,
        generation
      })
    }
  }
  listRoots(params: { limit: number; cursor?: string | undefined }) {
    this.sync()
    const roots = [...this.roots.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((root) => !params.cursor || root.id > params.cursor)
    const page = roots.slice(0, params.limit)
    return {
      roots: page.map(({ id, descriptorId, label, generation }) => ({
        rootId: id,
        directoryDescriptorId: descriptorId,
        workspaceId: id,
        label,
        generation
      })),
      nextCursor: roots.length > params.limit ? page.at(-1)!.id : null
    }
  }
  listDirectory(params: {
    directoryDescriptorId: string
    generation: number
    limit: number
    cursor?: string | undefined
    cancellationId: string
  }) {
    this.sync()
    const descriptor = this.entries.get(params.directoryDescriptorId)
    if (!descriptor) fail('unauthorized')
    if (descriptor.generation !== params.generation || descriptor.kind !== 'directory')
      fail('stale_revision')
    const root = this.roots.get(descriptor.rootId)
    if (!root) fail('unauthorized')
    const fd = openBeneath(root.fd, descriptor.parts, true)
    try {
      if (identity(fd) !== descriptor.identity) fail('stale_revision')
      const started = Date.now()
      const names: string[] = []
      const directory = opendirSync(`/proc/self/fd/${fd}`)
      try {
        for (;;) {
          if (Date.now() - started >= MAX_SCAN_MS) fail('resource_limit')
          const next = directory.readSync()
          if (!next) break
          if (names.length >= MAX_SCAN) fail('resource_limit')
          names.push(next.name)
        }
      } finally {
        directory.closeSync()
      }
      const existingEntries = new Map<string, Entry>()
      for (const entry of this.entries.values()) {
        if (entry.rootId === root.id && entry.generation === root.generation) {
          existingEntries.set(`${entry.kind}\0${entry.identity}\0${entry.parts.join('\0')}`, entry)
        }
      }
      const candidates: Entry[] = []
      for (const label of names.sort()) {
        if (Date.now() - started >= MAX_SCAN_MS) fail('resource_limit')
        if (!safeLabel(label)) continue
        const parts = [...descriptor.parts, label]
        let child: number
        try {
          child = openBeneath(root.fd, parts, false)
        } catch {
          continue
        }
        try {
          const stat = fstatSync(child)
          const kind = stat.isDirectory()
            ? 'directory'
            : stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE
              ? 'file'
              : undefined
          if (!kind) continue
          const currentIdentity = identity(child, kind === 'file')
          const prior = existingEntries.get(`${kind}\0${currentIdentity}\0${parts.join('\0')}`)
          candidates.push(
            prior ?? {
              id: randomUUID(),
              rootId: root.id,
              parts,
              label,
              kind,
              identity: currentIdentity,
              generation: root.generation
            }
          )
        } finally {
          closeSync(child)
        }
      }
      if (
        this.entries.size + candidates.filter((entry) => !this.entries.has(entry.id)).length >
        MAX_ENTRIES
      )
        fail('resource_limit')
      for (const entry of candidates) this.entries.set(entry.id, entry)
      const position = params.cursor
        ? candidates.findIndex((entry) => entry.id === params.cursor)
        : -1
      if (params.cursor && position < 0) fail('stale_revision')
      const remaining = candidates.slice(position + 1)
      const page = remaining.slice(0, params.limit)
      return {
        entries: page.map(({ id, kind, label, generation }) => ({
          entryDescriptorId: id,
          kind,
          label,
          generation
        })),
        nextCursor: remaining.length > params.limit ? page.at(-1)!.id : null
      }
    } finally {
      closeSync(fd)
    }
  }
  issueDocument(params: {
    authorizedDescriptorId: string
    descriptorGeneration: number
    expectedKind: 'plainText' | 'markdown'
  }) {
    this.sync()
    const entry = this.entries.get(params.authorizedDescriptorId)
    if (!entry) fail('unauthorized')
    if (entry.generation !== params.descriptorGeneration || entry.kind !== 'file')
      fail('stale_revision')
    if (params.expectedKind === 'markdown' && !/\.(md|markdown)$/u.test(entry.label))
      fail('unauthorized')
    const root = this.roots.get(entry.rootId)
    if (!root) fail('unauthorized')
    const fd = openBeneath(root.fd, entry.parts, false)
    try {
      if (identity(fd, true) !== entry.identity) fail('stale_revision')
    } finally {
      closeSync(fd)
    }
    let document = [...this.documents.values()].find(
      (item) =>
        item.rootId === entry.rootId &&
        item.parts.join('\0') === entry.parts.join('\0') &&
        item.identity === entry.identity
    )
    if (!document) {
      if (this.documents.size >= MAX_DOCUMENTS) fail('resource_limit')
      document = {
        id: randomUUID(),
        rootId: entry.rootId,
        parts: entry.parts,
        label: entry.label,
        identity: entry.identity,
        version: 1,
        revision: 1
      }
      this.documents.set(document.id, document)
    }
    return {
      document: { documentId: document.id, identityVersion: document.version },
      displayName: document.label
    }
  }
  read(
    params: {
      document: { documentId: string; identityVersion: number }
      offset: number
      maxBytes: number
    },
    allowControls = false
  ) {
    this.sync()
    const document = this.documents.get(params.document.documentId)
    if (!document) fail('unauthorized')
    if (document.version !== params.document.identityVersion) fail('stale_revision')
    const root = this.roots.get(document.rootId)
    if (!root) fail('unauthorized')
    const fd = openBeneath(root.fd, document.parts, false)
    try {
      if (identity(fd, true) !== document.identity) fail('stale_revision')
      const stat = fstatSync(fd)
      if (stat.size > MAX_FILE)
        return {
          kind: 'unavailable' as const,
          document: params.document,
          reason: 'oversized' as const,
          displayName: document.label
        }
      const bytes = Buffer.allocUnsafe(stat.size)
      let read = 0
      while (read < bytes.length) {
        const count = readSync(fd, bytes, read, bytes.length - read, read)
        if (count === 0) fail('stale_revision')
        read += count
      }
      if (identity(fd, true) !== document.identity) fail('stale_revision')
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        return {
          kind: 'unavailable' as const,
          document: params.document,
          reason: 'unsupportedEncoding' as const,
          displayName: document.label
        }
      }
      if (
        params.offset > bytes.length ||
        (params.offset > 0 && (bytes[params.offset]! & 0xc0) === 0x80)
      )
        fail('invalid_params')
      let end = Math.min(bytes.length, params.offset + params.maxBytes)
      while (end > params.offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
      const chunk = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(params.offset, end)
      )
      if (
        !allowControls &&
        [...chunk].some((character) => {
          const point = character.codePointAt(0)!
          return (
            (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
            (point >= 127 && point <= 159)
          )
        })
      )
        return {
          kind: 'unavailable' as const,
          document: params.document,
          reason: 'binary' as const,
          displayName: document.label
        }
      return {
        kind: 'text' as const,
        chunk: {
          document: params.document,
          offset: params.offset,
          text: chunk,
          eof: end === bytes.length,
          contentRevision: document.revision,
          displayName: document.label
        }
      }
    } finally {
      closeSync(fd)
    }
  }

  save(params: {
    document: { documentId: string; identityVersion: number }
    expectedRevision: number
    text: string
    mutation: { expectedRevision: number }
  }) {
    if (Buffer.byteLength(params.text, 'utf8') > MAX_SAVE) fail('resource_limit')
    if (params.expectedRevision !== params.mutation.expectedRevision) fail('stale_revision')
    this.sync()
    const document = this.documents.get(params.document.documentId)
    if (!document) fail('unauthorized')
    if (
      document.version !== params.document.identityVersion ||
      document.revision !== params.expectedRevision
    )
      fail('stale_revision')
    if (document.version >= Number.MAX_SAFE_INTEGER || document.revision >= Number.MAX_SAFE_INTEGER)
      fail('stale_revision')
    const root = this.roots.get(document.rootId)
    if (!root) fail('unauthorized')
    const target = openBeneath(root.fd, document.parts, false)
    let original: Identity
    let originalHash: string
    try {
      original = identity(target, true)
      if (original !== document.identity) fail('stale_revision')
      originalHash = fingerprint(target)
      if (identity(target, true) !== original) fail('stale_revision')
    } finally {
      closeSync(target)
    }
    const name = document.parts.at(-1)
    if (!name) fail('unauthorized')
    const parentParts = document.parts.slice(0, -1)
    const parent = openBeneath(root.fd, parentParts, true)
    const temporary = `.agent-workspace-save-${randomUUID()}`
    const temporaryPath = `/proc/self/fd/${parent}/${temporary}`
    let temporaryExists = false
    let swapped = false
    try {
      const parentIdentity = identity(parent)
      const out = openSync(temporaryPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
      temporaryExists = true
      try {
        const bytes = Buffer.from(params.text, 'utf8')
        let written = 0
        while (written < bytes.length)
          written += writeSync(out, bytes, written, bytes.length - written)
        fsyncSync(out)
      } finally {
        closeSync(out)
      }
      const currentParent = openBeneath(root.fd, parentParts, true)
      try {
        if (identity(currentParent) !== parentIdentity) fail('stale_revision')
        exchangeAt(parent, temporary, currentParent, name)
        swapped = true
        let valid = false
        try {
          const displaced = openPart(parent, temporary, false)
          try {
            const displacedIdentity = identity(displaced, true)
            valid =
              sameFileAfterExchange(displacedIdentity, original) &&
              fingerprint(displaced) === originalHash &&
              sameFileAfterExchange(identity(displaced, true), original)
          } finally {
            closeSync(displaced)
          }
        } catch {
          valid = false
        }
        if (!valid) {
          exchangeAt(parent, temporary, currentParent, name)
          swapped = false
          fail('stale_revision')
        }
        unlinkSync(temporaryPath)
        temporaryExists = false
        fsyncSync(currentParent)
        const replacement = openPart(currentParent, name, false)
        try {
          document.identity = identity(replacement, true)
        } finally {
          closeSync(replacement)
        }
        document.version++
        document.revision++
        return {
          document: { documentId: document.id, identityVersion: document.version },
          contentRevision: document.revision
        }
      } finally {
        closeSync(currentParent)
      }
    } finally {
      if (temporaryExists && !swapped) {
        try {
          unlinkSync(temporaryPath)
        } catch {
          /* best effort after a failed save */
        }
      }
      closeSync(parent)
    }
  }

  private previewText(document: { documentId: string; identityVersion: number }, maxBytes: number) {
    const preview = this.read({ document, offset: 0, maxBytes }, true)
    if (preview.kind === 'unavailable') {
      fail(preview.reason === 'unsupportedEncoding' ? 'unsupported_encoding' : 'resource_limit')
    }
    if (!preview.chunk.eof) fail('resource_limit')
    return preview.chunk
  }
  markdown(params: { document: { documentId: string; identityVersion: number } }) {
    const chunk = this.previewText(params.document, 64 * 1024)
    return {
      document: chunk.document,
      nodes: parseSafeMarkdown(chunk.text),
      contentRevision: chunk.contentRevision
    }
  }
  diff(params: {
    before: { documentId: string; identityVersion: number }
    after: { documentId: string; identityVersion: number }
    maxBytes: number
  }) {
    const before = this.previewText(params.before, params.maxBytes)
    const after = this.previewText(params.after, params.maxBytes)
    return boundedDiff(before.text, after.text)
  }
}
