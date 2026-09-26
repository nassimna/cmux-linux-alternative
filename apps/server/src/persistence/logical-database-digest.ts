import { createHash, type Hash } from 'node:crypto'

import Database from 'better-sqlite3'

function field(hash: Hash, value: unknown): void {
  let tag: string
  let bytes: Buffer
  if (value === null) {
    tag = 'n'
    bytes = Buffer.alloc(0)
  } else if (Buffer.isBuffer(value)) {
    tag = 'b'
    bytes = value
  } else if (typeof value === 'string') {
    tag = 's'
    bytes = Buffer.from(value)
  } else if (typeof value === 'bigint') {
    tag = 'i'
    bytes = Buffer.from(value.toString())
  } else if (typeof value === 'number') {
    tag = 'f'
    bytes = Buffer.allocUnsafe(8)
    bytes.writeDoubleBE(value)
  } else {
    throw new Error('SQLite value cannot be fingerprinted')
  }
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(bytes.length))
  hash.update(tag).update(length).update(bytes)
}

/** Canonical enough for fail-closed equality: schema and every stored row, including row IDs. */
export function logicalDatabaseDigest(path: string): string {
  const database = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 })
  try {
    database.pragma('query_only = ON')
    database.defaultSafeIntegers()
    const hash = createHash('sha256').update('agent-workspace-sqlite-logical-v1\0')
    const schema = database
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name')
      .raw(true)
      .all() as unknown[][]
    for (const entry of schema) {
      hash.update('schema\0')
      for (const value of entry) field(hash, value)
    }
    const tables = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const tableKinds = new Map(
      (database.pragma('table_list') as Array<{ schema: string; name: string; wr: number }>)
        .filter((table) => table.schema === 'main')
        .map((table) => [table.name, table.wr])
    )
    for (const { name } of tables) {
      hash.update('table\0')
      field(hash, name)
      const quoted = `"${name.replaceAll('"', '""')}"`
      const withoutRowid = tableKinds.get(name)
      if (withoutRowid === undefined) throw new Error('SQLite table kind cannot be fingerprinted')
      const columns = new Set(
        (database.pragma(`table_xinfo(${quoted})`) as Array<{ name: string }>).map((column) =>
          column.name.toLowerCase()
        )
      )
      const rowid = ['rowid', '_rowid_', 'oid'].find((alias) => !columns.has(alias))
      if (withoutRowid === 0 && !rowid) {
        throw new Error('SQLite table hides every internal row ID alias')
      }
      const rows =
        withoutRowid === 1
          ? database.prepare(`SELECT * FROM ${quoted}`)
          : database.prepare(`SELECT "${rowid}", * FROM ${quoted} ORDER BY "${rowid}"`)
      for (const row of rows.raw(true).iterate() as Iterable<unknown[]>) {
        hash.update('row\0')
        for (const value of row) field(hash, value)
      }
    }
    return hash.digest('hex')
  } finally {
    database.close()
  }
}
