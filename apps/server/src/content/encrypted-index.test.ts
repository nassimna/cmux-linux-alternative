import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { decryptIndexValue, encryptIndexValue, keyedIndexHash } from './encrypted-index-crypto'
import { EncryptedIndex } from './encrypted-index'
import {
  loadExistingIndexKey,
  loadOrCreateIndexKey,
  type IndexSecretStore
} from './encrypted-index-key'

const profile = () => {
  const path = mkdtempSync(join(tmpdir(), 'node-content-index-'))
  chmodSync(path, 0o700)
  return path
}
const key = Buffer.alloc(32, 7)

it('applies source exclusion and source scope before the result limit', () => {
  const path = profile()
  const eligible = randomUUID(),
    excluded = randomUUID(),
    otherWindow = randomUUID()
  const document = () => ({ documentId: randomUUID(), identityVersion: 1 })
  try {
    const index = EncryptedIndex.open(path, key)
    for (const id of [eligible, excluded, otherWindow]) {
      index.authorizeSource(id, 0)
      index.setSourcePolicy(id, 30, [])
      index.indexText(id, document(), 'workspaceFile', 'needle', {
        maxBytes: 1024,
        deadlineMs: Date.now() + 2000
      })
    }
    // Keep the indexed row to model a stale excluded source at query time.
    const db = new Database(join(path, 'index/v1/search.sqlite3'))
    db.prepare('UPDATE source_authorizations SET excluded=1 WHERE authorization_id=?').run(excluded)
    db.close()
    expect(index.search('needle', 1, [eligible, excluded])).toMatchObject([
      { sourceAuthorizationId: eligible }
    ])
    expect(index.search('needle', 1, [eligible])).toMatchObject([
      { sourceAuthorizationId: eligible }
    ])
    expect(index.search('needle', 1, [])).toEqual([])
    index.close()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
})

it('writes Rust schema-v1 encrypted data and reopens consent while clearing process-bound documents', () => {
  const path = profile()
  const source = randomUUID(),
    doc = randomUUID()
  try {
    const index = EncryptedIndex.open(path, key)
    index.authorizeSource(source, 0)
    index.setSourcePolicy(source, 30, [])
    index.indexText(
      source,
      { documentId: doc, identityVersion: 2 },
      'workspaceFile',
      'Needle super-secret-value',
      { maxBytes: 1024, deadlineMs: Date.now() + 2000 }
    )
    expect(index.search('needle', 10)[0]).toMatchObject({
      document: { documentId: doc, identityVersion: 2 },
      snippet: 'Needle super-secret-value'
    })
    expect(index.exportSourceSummary(source)).toMatchObject({ documentCount: 1, tokenCount: 4 })
    index.close()
    const databasePath = join(path, 'index/v1/search.sqlite3')
    const bytes = readFileSync(databasePath).toString('latin1')
    expect(bytes).not.toContain('super-secret-value')
    const db = new Database(databasePath, { readonly: true })
    const document = db
      .prepare('SELECT identity_hash,document_nonce,document_ciphertext FROM documents')
      .get() as { identity_hash: Buffer; document_nonce: Buffer; document_ciphertext: Buffer }
    expect(document.identity_hash.equals(keyedIndexHash(key, doc))).toBe(true)
    expect(
      decryptIndexValue(key, document.document_nonce, document.document_ciphertext).toString()
    ).toBe(doc)
    db.close()
    const reopened = EncryptedIndex.open(path, key)
    expect(reopened.search('needle', 10)).toHaveLength(1)
    reopened.clearRuntimeBoundDocuments()
    expect(reopened.search('needle', 10)).toHaveLength(0)
    reopened.authorizeSourceRead(source)
    reopened.close()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
})

it('fails closed on unsafe artifacts, wrong keys, and schema drift; preserves corrupt artifacts explicitly', async () => {
  const path = profile()
  try {
    const index = EncryptedIndex.open(path, key)
    index.close()
    expect(() => EncryptedIndex.open(path, Buffer.alloc(32, 8))).toThrow()
    const databasePath = join(path, 'index/v1/search.sqlite3')
    const db = new Database(databasePath)
    db.exec('CREATE TABLE extra (id INTEGER)')
    db.close()
    expect(() => EncryptedIndex.open(path, key)).toThrow()
    const rebuilt = EncryptedIndex.preserveCorruptAndRebuild(path, key)
    rebuilt.close()
    expect(existsSync(databasePath)).toBe(true)
    expect(statSync(join(path, 'index/v1')).isDirectory()).toBe(true)
    expect(readFileSync(databasePath).length).toBeGreaterThan(0)
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
  const unsafe = profile()
  try {
    symlinkSync('/etc/passwd', join(unsafe, 'content-index-key-id'))
    const store: IndexSecretStore = {
      findExact: () => Promise.resolve({ unlocked: [], locked: 0 }),
      createExact: () => Promise.resolve()
    }
    await expect(loadOrCreateIndexKey(unsafe, store)).rejects.toMatchObject({
      code: 'unsafe_storage'
    })
  } finally {
    rmSync(unsafe, { recursive: true, force: true })
  }
})

it('uses a stable owner-only locator and denies locked, duplicate, malformed secrets', async () => {
  const path = profile()
  const secrets = new Map<string, Buffer[]>()
  let locked = 0
  const store: IndexSecretStore = {
    findExact: (id) =>
      Promise.resolve({
        unlocked: (secrets.get(id) ?? []).map((value) => Buffer.from(value)),
        locked
      }),
    createExact: (id, secret) => {
      secrets.set(id, [Buffer.from(secret)])
      return Promise.resolve()
    }
  }
  try {
    const first = await loadOrCreateIndexKey(path, store)
    const second = await loadOrCreateIndexKey(path, store)
    expect(first.equals(second)).toBe(true)
    const id = readFileSync(join(path, 'content-index-key-id'), 'utf8').trim()
    expect(statSync(join(path, 'content-index-key-id')).mode & 0o777).toBe(0o600)
    locked = 1
    await expect(loadOrCreateIndexKey(path, store)).rejects.toMatchObject({ code: 'ambiguous' })
    locked = 0
    secrets.set(id, [Buffer.alloc(31)])
    await expect(loadOrCreateIndexKey(path, store)).rejects.toMatchObject({
      code: 'invalid_secret'
    })
    secrets.set(id, [Buffer.alloc(32), Buffer.alloc(32)])
    await expect(loadOrCreateIndexKey(path, store)).rejects.toMatchObject({ code: 'ambiguous' })
    first.fill(0)
    second.fill(0)
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
})

it('opens transferred search artifacts without creating a locator, wallet item, or index', async () => {
  const path = profile()
  const secrets = new Map<string, Buffer>()
  let created = 0
  const store: IndexSecretStore = {
    findExact: (id) =>
      Promise.resolve({
        unlocked: secrets.has(id) ? [Buffer.from(secrets.get(id)!)] : [],
        locked: 0
      }),
    createExact: (id, secret) => {
      created += 1
      secrets.set(id, Buffer.from(secret))
      return Promise.resolve()
    }
  }
  try {
    await expect(loadExistingIndexKey(path, store)).rejects.toMatchObject({ code: 'unavailable' })
    expect(existsSync(join(path, 'content-index-key-id'))).toBe(false)
    expect(() => EncryptedIndex.openExisting(path, key)).toThrow()
    expect(existsSync(join(path, 'index'))).toBe(false)
    const seeded = await loadOrCreateIndexKey(path, store)
    const id = readFileSync(join(path, 'content-index-key-id'), 'utf8').trim()
    const existing = await loadExistingIndexKey(path, store)
    expect(existing.equals(seeded)).toBe(true)
    expect(created).toBe(1)
    secrets.delete(id)
    await expect(loadExistingIndexKey(path, store)).rejects.toMatchObject({ code: 'unavailable' })
    expect(created).toBe(1)
    const index = EncryptedIndex.open(path, seeded)
    index.close()
    const reopened = EncryptedIndex.openExisting(path, seeded)
    reopened.close()
    seeded.fill(0)
    existing.fill(0)
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
})

it('XChaCha values round-trip and reject tampering', () => {
  const encrypted = encryptIndexValue(key, Buffer.from('secret'))
  expect(encrypted.nonce).toHaveLength(24)
  expect(encrypted.ciphertext).toHaveLength(22)
  expect(decryptIndexValue(key, encrypted.nonce, encrypted.ciphertext).toString()).toBe('secret')
  encrypted.ciphertext[0] = encrypted.ciphertext[0]! ^ 1
  expect(() => decryptIndexValue(key, encrypted.nonce, encrypted.ciphertext)).toThrow()
})

it.skipIf(!process.env.RUST_INDEX_FIXTURE)(
  'opens and queries a Rust-created schema-v1 index including Unicode tokens',
  () => {
    const path = process.env.RUST_INDEX_FIXTURE!
    const index = EncryptedIndex.open(path, key)
    try {
      expect(index.search('café Æther', 10)[0]).toMatchObject({
        document: { documentId: '22222222-2222-4222-8222-222222222222', identityVersion: 3 },
        snippet: 'café Æther 東京 alpha ΟΣ'
      })
      expect(index.search('東京', 10)).toHaveLength(1)
      expect(index.search('ος', 10)).toHaveLength(1)
    } finally {
      index.close()
    }
  }
)

it.skipIf(process.env.RUN_RUST_INDEX_CONTRACT !== '1')(
  'lets Rust reopen and query a Node-created Unicode index',
  () => {
    const path = profile()
    try {
      const index = EncryptedIndex.open(path, key)
      index.authorizeSource('11111111-1111-4111-8111-111111111111', 0)
      index.indexText(
        '11111111-1111-4111-8111-111111111111',
        { documentId: '22222222-2222-4222-8222-222222222222', identityVersion: 3 },
        'workspaceFile',
        'café Æther 東京 alpha ΟΣ',
        { maxBytes: 1024, deadlineMs: Date.now() + 2000 }
      )
      index.close()
      const output = execFileSync(
        'cargo',
        [
          'run',
          '--quiet',
          '-p',
          'agent-workspace-content-index',
          '--example',
          'node_interop_fixture',
          '--',
          path,
          'read',
          'ος'
        ],
        {
          cwd: new URL('../../../../', import.meta.url).pathname,
          timeout: 300_000,
          stdio: ['ignore', 'pipe', 'ignore']
        }
      ).toString()
      expect(JSON.parse(output)).toMatchObject([{ snippet: 'café Æther 東京 alpha ΟΣ' }])
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  },
  300_000
)
