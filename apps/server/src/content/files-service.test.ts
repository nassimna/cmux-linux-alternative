import { randomUUID } from 'node:crypto'
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FilesService, FilesServiceError } from './files-service'
import type { ApplicationStateStore } from '../persistence/application-state-store'

describe('Files service capabilities', () => {
  it('atomically saves a revision and rejects stale, replaced, and hard-linked targets', () => {
    const parent = mkdtempSync(join(tmpdir(), 'node-files-save-'))
    const root = join(parent, 'root')
    mkdirSync(root)
    writeFileSync(join(root, 'note.txt'), 'old')
    const workspace = { id: randomUUID(), name: 'Fixture', workingDirectory: root }
    const store = {
      readSnapshot: () => ({ workspaces: [workspace] })
    } as unknown as ApplicationStateStore
    const files = new FilesService(store)
    try {
      const descriptor = files.listRoots({ limit: 64 }).roots[0]!
      const entry = files.listDirectory({
        directoryDescriptorId: descriptor.directoryDescriptorId,
        generation: descriptor.generation,
        limit: 100,
        cancellationId: randomUUID()
      }).entries[0]!
      const document = files.issueDocument({
        authorizedDescriptorId: entry.entryDescriptorId,
        descriptorGeneration: entry.generation,
        expectedKind: 'plainText'
      }).document
      const params = {
        document,
        expectedRevision: 1,
        text: 'new 🌍',
        mutation: { expectedRevision: 1 }
      }
      const result = files.save(params)
      expect(result).toEqual({ document: { ...document, identityVersion: 2 }, contentRevision: 2 })
      expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('new 🌍')
      expect(readdirSync(root)).toEqual(['note.txt'])
      expect(() => files.save(params)).toThrowError(
        expect.objectContaining({ code: 'stale_revision' })
      )
      expect(() =>
        files.save({
          ...params,
          document: result.document,
          expectedRevision: 2,
          mutation: { expectedRevision: 1 }
        })
      ).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
      renameSync(join(root, 'note.txt'), join(root, 'old.txt'))
      writeFileSync(join(root, 'note.txt'), 'attacker')
      expect(() =>
        files.save({
          ...params,
          document: result.document,
          expectedRevision: 2,
          mutation: { expectedRevision: 2 }
        })
      ).toThrowError(expect.objectContaining({ code: 'stale_revision' }))
      expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('attacker')
      linkSync(join(root, 'note.txt'), join(root, 'hardlink.txt'))
      expect(
        files
          .listDirectory({
            directoryDescriptorId: descriptor.directoryDescriptorId,
            generation: descriptor.generation,
            limit: 100,
            cancellationId: randomUUID()
          })
          .entries.map((item) => item.label)
      ).toEqual(['old.txt'])
    } finally {
      files.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })
  it('reads only current, descriptor-authorized regular files and revokes changed roots', () => {
    const parent = mkdtempSync(join(tmpdir(), 'node-files-capability-'))
    const root = join(parent, 'root')
    mkdirSync(root)
    writeFileSync(join(root, 'hello.txt'), 'hello 🌍')
    symlinkSync('/etc/passwd', join(root, 'outside.txt'))
    const workspace = { id: randomUUID(), name: 'Fixture', workingDirectory: root }
    const store = {
      readSnapshot: () => ({ workspaces: [workspace] })
    } as unknown as ApplicationStateStore
    const files = new FilesService(store)
    try {
      const first = files.listRoots({ limit: 100 }).roots[0]!
      const page = files.listDirectory({
        directoryDescriptorId: first.directoryDescriptorId,
        generation: first.generation,
        limit: 100,
        cancellationId: randomUUID()
      })
      expect(page.entries.map((entry) => entry.label)).toEqual(['hello.txt'])
      const issued = files.issueDocument({
        authorizedDescriptorId: page.entries[0]!.entryDescriptorId,
        descriptorGeneration: first.generation,
        expectedKind: 'plainText'
      })
      expect(files.read({ document: issued.document, offset: 0, maxBytes: 6 })).toMatchObject({
        kind: 'text',
        chunk: { text: 'hello ', eof: false }
      })
      writeFileSync(join(root, 'hello.txt'), 'changed')
      expect(() => files.read({ document: issued.document, offset: 0, maxBytes: 64 })).toThrow(
        FilesServiceError
      )
      workspace.name = 'Renamed'
      const second = files.listRoots({ limit: 100 }).roots[0]!
      expect(second.directoryDescriptorId).not.toBe(first.directoryDescriptorId)
      expect(() =>
        files.listDirectory({
          directoryDescriptorId: first.directoryDescriptorId,
          generation: first.generation,
          limit: 100,
          cancellationId: randomUUID()
        })
      ).toThrow(FilesServiceError)
    } finally {
      files.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('keeps descriptor identities stable across paginated directory scans', () => {
    const parent = mkdtempSync(join(tmpdir(), 'node-files-pages-'))
    const root = join(parent, 'root')
    mkdirSync(root)
    for (let index = 0; index < 125; index++) {
      writeFileSync(join(root, `file-${String(index).padStart(3, '0')}.txt`), 'text')
    }
    const workspace = { id: randomUUID(), name: 'Fixture', workingDirectory: root }
    const store = {
      readSnapshot: () => ({ workspaces: [workspace] })
    } as unknown as ApplicationStateStore
    const files = new FilesService(store)
    try {
      const descriptor = files.listRoots({ limit: 64 }).roots[0]!
      const readPage = (cursor?: string) =>
        files.listDirectory({
          directoryDescriptorId: descriptor.directoryDescriptorId,
          generation: descriptor.generation,
          limit: 100,
          cancellationId: randomUUID(),
          ...(cursor ? { cursor } : {})
        })
      const first = readPage()
      const second = readPage(first.nextCursor!)
      expect(first.entries).toHaveLength(100)
      expect(second.entries).toHaveLength(25)
      expect(second.nextCursor).toBeNull()
      expect(readPage().entries).toEqual(first.entries)
      expect(readPage(first.nextCursor!).entries).toEqual(second.entries)
    } finally {
      files.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('renders bounded safe markdown and compares authorized document snapshots', () => {
    const parent = mkdtempSync(join(tmpdir(), 'node-files-preview-'))
    const root = join(parent, 'root')
    mkdirSync(root)
    writeFileSync(join(root, 'before.txt'), 'same\nold\n')
    writeFileSync(
      join(root, 'after.md'),
      '# Heading\n- [link](https://example.com)\n```ts\ncode\n```\nsame\nnew\n'
    )
    writeFileSync(join(root, 'large.md'), 'a'.repeat(64 * 1024 + 1))
    const workspace = { id: randomUUID(), name: 'Fixture', workingDirectory: root }
    const store = {
      readSnapshot: () => ({ workspaces: [workspace] })
    } as unknown as ApplicationStateStore
    const files = new FilesService(store)
    try {
      const descriptor = files.listRoots({ limit: 64 }).roots[0]!
      const entries = files.listDirectory({
        directoryDescriptorId: descriptor.directoryDescriptorId,
        generation: descriptor.generation,
        limit: 100,
        cancellationId: randomUUID()
      }).entries
      const issue = (name: string, expectedKind: 'plainText' | 'markdown') =>
        files.issueDocument({
          authorizedDescriptorId: entries.find((entry) => entry.label === name)!.entryDescriptorId,
          descriptorGeneration: descriptor.generation,
          expectedKind
        }).document
      const before = issue('before.txt', 'plainText')
      const after = issue('after.md', 'markdown')
      expect(files.markdown({ document: after }).nodes).toEqual([
        { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'Heading' }] },
        {
          kind: 'list',
          ordered: false,
          items: [
            {
              kind: 'listItem',
              children: [{ kind: 'link', label: 'link', href: 'https://example.com' }]
            }
          ]
        },
        { kind: 'codeBlock', language: 'ts', text: 'code' },
        { kind: 'paragraph', children: [{ kind: 'text', text: 'same' }] },
        { kind: 'paragraph', children: [{ kind: 'text', text: 'new' }] }
      ])
      expect(files.diff({ before, after, maxBytes: 64 * 1024 })).toEqual({
        lines: [
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: '# Heading' },
          { kind: 'added', text: '- [link](https://example.com)' },
          { kind: 'added', text: '```ts' },
          { kind: 'added', text: 'code' },
          { kind: 'added', text: '```' },
          { kind: 'context', text: 'same' },
          { kind: 'added', text: 'new' }
        ],
        truncated: false
      })
      expect(() => files.markdown({ document: issue('large.md', 'markdown') })).toThrowError(
        expect.objectContaining({ code: 'resource_limit' })
      )
      expect(() => files.diff({ before, after, maxBytes: 4 })).toThrowError(
        expect.objectContaining({ code: 'resource_limit' })
      )
      writeFileSync(join(root, 'after.md'), 'changed')
      expect(() => files.markdown({ document: after })).toThrowError(
        expect.objectContaining({ code: 'stale_revision' })
      )
    } finally {
      files.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
